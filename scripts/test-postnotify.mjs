/**
 * scripts/test-postnotify.mjs
 *
 * Unit tests for the daily draft notification (docs/post-notify.md):
 *   - functions/api/_xtext.ts    X weighted length, 280 fitting, intent URL
 *   - functions/api/_postnotify.ts config, schedule, guard, notification builder
 *   - functions/api/_postlog.ts  run log + the pre-agreed judgment lines
 *   - scripts/post-notify.mjs    end-to-end dry run / stop switch / live
 *                                without secrets (fixture, no network)
 *
 *   node scripts/test-postnotify.mjs
 *
 * Requires Node >= 22.18 (type-stripped .ts imports). No deps, no network.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { X_INTENT_BASE, fitToWeighted, weightedLength, xIntentUrl } from "../functions/api/_xtext.ts";
import {
  DEFAULT_CONFIG,
  MAX_DELAY_MS,
  buildNotice,
  buildReminder,
  guardHits,
  MIN_DELAY_MS,
  deliveryDelay,
  isLastChance,
  jstHour,
  parseBlockWords,
  parseConfig,
  parseMode,
  planReminder,
  planSlots,
  readDraftResponse,
  remindDelay,
  sendInstant,
} from "../functions/api/_postnotify.ts";
import {
  addDays,
  alreadyRan,
  applyLogInput,
  defaultRecordWeek,
  emptyLog,
  judge,
  parseLog,
  parseLogInput,
  reminded,
  weekSunday,
  windowStart,
} from "../functions/api/_postlog.ts";

// ---- tiny runner (same shape as the other scripts/test-*.mjs) ---------------

let passed = 0;
let failed = 0;
function t(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function eq(actual, expected, label = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label} expected ${e}, got ${a}`);
}

const JA140 = "あ".repeat(140);

// ---- _xtext -----------------------------------------------------------------

console.log("_xtext");
t("ASCII weighs 1, Japanese weighs 2", () => {
  eq(weightedLength("abc"), 3);
  eq(weightedLength("あいう"), 6);
  eq(weightedLength("今日は3件"), 9);
});
t("140 Japanese characters = exactly 280", () => eq(weightedLength(JA140), 280));
t("light punctuation ranges weigh 1 (curly quotes, en dash)", () => eq(weightedLength("“–”"), 3));
t("an explicit URL counts 23 regardless of length", () => {
  eq(weightedLength("https://example.com/" + "x".repeat(80)), 23);
  eq(weightedLength("見て https://brypo.com/try"), 5 + 23);
});
t("a bare domain counts 23 and stops at Japanese text", () => {
  eq(weightedLength("brypo.com/try"), 23);
  eq(weightedLength("brypo.com/tryで試せます"), 23 + 10);
});
t("matches twitter-text 3.1.0 (measured values), errs high where it differs", () => {
  const cases = [
    ["ＡＢＣ（全角）", 14],
    ["ｱｲｳ半角カナ", 14],
    ["#個人開発 で作った。 @kokibuilds", 32],
    ["café naïve", 10],
    ["1/3 進捗 — 50%", 14],
    ["x.com と github.io と note.jp", 77],
    ["改行\nあり\n\n3行", 14],
    ["見て abc.tv", 28],
    ["foo.info", 23],
  ];
  for (const [s, n] of cases) eq(weightedLength(s), n, JSON.stringify(s));
  // twitter-text: 79 (it skips linking the bare domain here). We count 89 —
  // the safe direction for a one-tap post.
  eq(weightedLength("今日は /try の入力欄を直した。使った人は3人、うち1人が翌日も来た。brypo.com/try"), 89);
});
t("emoji count 2, ZWJ sequences included", () => {
  eq(weightedLength("👍"), 2);
  eq(weightedLength("👨‍👩‍👧"), 2);
  eq(weightedLength("🇯🇵"), 2);
});
t("fitToWeighted leaves fitting text alone", () => eq(fitToWeighted(JA140), { text: JA140, trimmed: false }));
t("fitToWeighted trims over-long text to ≤ 280 with an ellipsis", () => {
  const r = fitToWeighted("い".repeat(150));
  assert(r.trimmed, "should trim");
  assert(weightedLength(r.text) <= 280, `got ${weightedLength(r.text)}`);
  assert(r.text.endsWith("…"), "ellipsis");
  eq(r.text, "い".repeat(139) + "…");
});
t("intent URL = x.com/intent/tweet?text= + URL-encoded text (round-trips)", () => {
  const text = "作った & 直した #個人開発\n2行目 100%";
  const url = xIntentUrl(text);
  assert(url.startsWith("https://x.com/intent/tweet?text="), url);
  eq(X_INTENT_BASE, "https://x.com/intent/tweet?text=");
  const q = url.slice(X_INTENT_BASE.length);
  assert(!/[&#\s]/.test(q), `unencoded chars in ${q}`);
  eq(decodeURIComponent(q), text);
  eq(new URL(url).searchParams.get("text"), text);
});

// ---- _postnotify: config / mode / schedule ------------------------------------

console.log("_postnotify");
t("config: defaults are 12:00 JST and brypo.com", () => {
  eq(DEFAULT_CONFIG.send_hour_jst, 12);
  eq(parseConfig(null), DEFAULT_CONFIG);
});
t("config: the repo file parses cleanly", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = JSON.parse(readFileSync(join(here, "post-notify.config.json"), "utf8"));
  // Every field in the file is valid (mode is the owner's switch: either value).
  assert(file.mode === "live" || file.mode === "dry_run", `mode ${file.mode}`);
  eq(parseConfig(file), { ...DEFAULT_CONFIG, mode: file.mode });
});
t("config: mode is dry_run unless the file says exactly live", () => {
  eq(parseConfig({ mode: "live" }).mode, "live");
  eq(parseConfig({ mode: "LIVE" }).mode, "dry_run");
  eq(parseConfig({}).mode, "dry_run");
});
t("config: bad values fall back, good ones apply", () => {
  const c = parseConfig({ send_hour_jst: 24, retry_hours: -1, base_url: "http://x", ops_url: 5 });
  eq(c, DEFAULT_CONFIG);
  eq(parseConfig({ send_hour_jst: 7, base_url: "https://example.com/" }).send_hour_jst, 7);
  eq(parseConfig({ base_url: "https://example.com/" }).base_url, "https://example.com");
});
t("mode: Variable wins when set; unset → config mode; unknown words → dry_run", () => {
  eq(parseMode(undefined), "dry_run");
  eq(parseMode(""), "dry_run");
  eq(parseMode(undefined, "live"), "live", "config live");
  eq(parseMode("", "live"), "live", "empty Variable = unset");
  eq(parseMode("off", "live"), "off", "kill switch beats config");
  eq(parseMode("dry_run", "live"), "dry_run", "Variable can force dry run");
  eq(parseMode("true", "live"), "dry_run", "unknown word never sends");
  eq(parseMode("true"), "dry_run");
  eq(parseMode("LIVE"), "live");
  eq(parseMode(" off "), "off");
});
t("jstHour converts UTC to JST", () => {
  eq(jstHour(new Date("2026-10-11T03:17:00Z")), 12);
  eq(jstHour(new Date("2026-10-11T15:17:00Z")), 0);
});
const jst = (d, hm) => Date.parse(`${d}T${hm}:00+09:00`);
t("sendInstant is the send hour of that JST day", () => {
  eq(new Date(sendInstant("2026-10-13", DEFAULT_CONFIG)).toISOString(), "2026-10-13T03:00:00.000Z");
  eq(new Date(sendInstant("2026-10-13", { ...DEFAULT_CONFIG, send_hour_jst: 7 })).toISOString(), "2026-10-12T22:00:00.000Z");
});
t("planSlots: a tick books today's and tomorrow's noon, whichever is not booked", () => {
  const cfg = DEFAULT_CONFIG;
  const none = () => false;
  eq(planSlots(jst("2026-10-13", "05:30"), "2026-10-13", cfg, none), [
    { date: "2026-10-13", late: false },
    { date: "2026-10-14", late: false },
  ], "early tick, nothing booked → both, scheduled");
  eq(planSlots(jst("2026-10-13", "05:30"), "2026-10-13", cfg, (d) => d === "2026-10-13"), [
    { date: "2026-10-14", late: false },
  ], "today booked (e.g. yesterday) → tomorrow only");
  eq(planSlots(jst("2026-10-13", "20:00"), "2026-10-13", cfg, () => true), [], "both booked → nothing to do");
});
t("planSlots: today's noon already passed and not booked → a late send now", () => {
  const cfg = DEFAULT_CONFIG;
  eq(planSlots(jst("2026-10-13", "15:10"), "2026-10-13", cfg, () => false), [
    { date: "2026-10-13", late: true },
    { date: "2026-10-14", late: false },
  ]);
  eq(planSlots(sendInstant("2026-10-13", cfg) - (MIN_DELAY_MS - 1), "2026-10-13", cfg, () => false)[0].late, true, "too close to schedule");
});
t("isLastChance: retry a failed draft until send_hour + retry_hours (capped at 23:00)", () => {
  const cfg = DEFAULT_CONFIG;
  eq(["10:00", "12:00", "14:59", "15:00", "23:30"].map((t) => isLastChance(jst("2026-10-13", t), "2026-10-13", cfg)), [false, false, false, true, true]);
  eq(isLastChance(jst("2026-10-13", "23:00"), "2026-10-13", { ...cfg, send_hour_jst: 22 }), true, "capped at 23");
});
t("deliveryDelay schedules for the send hour, or delivers now", () => {
  const cfg = DEFAULT_CONFIG;
  const at = String(sendInstant("2026-10-13", cfg) / 1000);
  eq(deliveryDelay(jst("2026-10-13", "07:30"), "2026-10-13", cfg), at, "early tick → scheduled for 12:00");
  eq(deliveryDelay(jst("2026-10-13", "21:00"), "2026-10-14", cfg), String(sendInstant("2026-10-14", cfg) / 1000), "tomorrow's noon, booked the evening before");
  eq(deliveryDelay(jst("2026-10-13", "07:30"), "2026-10-13", cfg, true), null, "forced run → now");
  eq(deliveryDelay(jst("2026-10-13", "12:40"), "2026-10-13", cfg), null, "late tick → now");
  eq(deliveryDelay(sendInstant("2026-10-13", cfg) - (MIN_DELAY_MS - 1), "2026-10-13", cfg), null, "too close to bother");
  eq(deliveryDelay(sendInstant("2026-10-13", cfg) - MIN_DELAY_MS, "2026-10-13", cfg), at, "just far enough");
});
t("config: the Sunday reminder defaults to 20:00 JST; bad values fall back", () => {
  eq(DEFAULT_CONFIG.remind_hour_jst, 20);
  eq(parseConfig({ remind_hour_jst: 21 }).remind_hour_jst, 21);
  eq(parseConfig({ remind_hour_jst: 24 }).remind_hour_jst, 20);
  eq(parseConfig({ remind_hour_jst: "20" }).remind_hour_jst, 20);
});
t("planReminder: books Sunday 20:00 once it is within ntfy's 3-day limit", () => {
  const cfg = DEFAULT_CONFIG;
  const none = () => false;
  // Sunday 2026-10-18 20:00 JST; 3 days minus an hour before it = Thursday 21:00.
  eq(planReminder(jst("2026-10-12", "09:00"), "2026-10-12", cfg, none), null, "Monday: too far ahead for ntfy");
  eq(planReminder(jst("2026-10-15", "20:30"), "2026-10-15", cfg, none), null, "Thursday 20:30: still too far");
  eq(planReminder(jst("2026-10-15", "21:30"), "2026-10-15", cfg, none), { week: "2026-10-18", late: false }, "Thursday 21:30");
  eq(planReminder(jst("2026-10-18", "13:00"), "2026-10-18", cfg, none), { week: "2026-10-18", late: false }, "Sunday afternoon");
  eq(planReminder(jst("2026-10-18", "20:30"), "2026-10-18", cfg, none), { week: "2026-10-18", late: true }, "missed: send now");
  eq(planReminder(jst("2026-10-17", "10:00"), "2026-10-17", cfg, (w) => w === "2026-10-18"), null, "already booked");
  eq(planReminder(jst("2026-10-19", "08:00"), "2026-10-19", cfg, none), null, "Monday after: next Sunday is too far");
});
t("remindDelay: unix seconds of Sunday 20:00 JST, or now once it has passed", () => {
  const cfg = DEFAULT_CONFIG;
  eq(remindDelay(jst("2026-10-17", "10:00"), "2026-10-18", cfg), String(Date.parse("2026-10-18T11:00:00Z") / 1000));
  eq(remindDelay(jst("2026-10-18", "20:30"), "2026-10-18", cfg), null);
  assert(MAX_DELAY_MS < 3 * 86_400_000, "inside ntfy.sh's 3-day limit");
  // The farthest daily booking (a tick at 00:00 for tomorrow's noon, 36 h) is inside it too.
  assert(sendInstant("2026-10-14", cfg) - jst("2026-10-13", "00:00") < MAX_DELAY_MS, "daily bookings fit");
});

// ---- _postnotify: guard -------------------------------------------------------

t("guard: a plain build-in-public draft is clean", () => {
  eq(guardHits("今日は /try の入力欄を直した。使った人は3人、うち1人が翌日も来た。brypo.com/try"), []);
});
t("guard: prices and paid-plan talk are caught", () => {
  for (const s of ["月額980円で使えます", "$9/mo", "有料版を準備中", "プランを用意", "¥500"]) {
    assert(guardHits(s).includes("価格・料金の表現"), s);
  }
});
t("guard: affiliate links, emails and phone numbers are caught", () => {
  assert(guardHits("おすすめ https://amzn.to/abc").includes("アフィリエイト"));
  assert(guardHits("連絡は me@example.com まで").includes("メールアドレス"));
  assert(guardHits("電話 090-1234-5678").includes("電話番号"));
});
t("guard: owner block words match case-insensitively and report only a label", () => {
  const words = parseBlockWords("Acme, 社内コードネーム、 ");
  eq(words, ["Acme", "社内コードネーム"]);
  eq(guardHits("今日ACMEの件で", words), ["登録した除外語"]);
  eq(guardHits("無関係", words), []);
});

// ---- _postnotify: notification ---------------------------------------------

const DRAFT = { text: "今日は /try の入力欄を直した。使った人は3人。 brypo.com/try", angle: "小さな改善の報告" };
t("notice: tapping opens the X intent link; the button carries the same link", () => {
  const n = buildNotice({ date: "2026-10-12", draft: DRAFT, reason: null, cfg: DEFAULT_CONFIG });
  const url = xIntentUrl(DRAFT.text);
  eq(n.drafts, 1);
  eq(n.click, url);
  eq(n.actions[0], { action: "view", label: "X で投稿", url, clear: true });
  assert(n.message.startsWith(DRAFT.text), "draft first");
  assert(n.title.includes("10/12 月"), n.title);
  assert(n.actions.length <= 3, "ntfy allows at most 3 actions");
  assert(!/undefined|null/.test(n.message + n.title), "no undefined/null");
});
t("notice: over-long draft is trimmed to 280 for the link and says so", () => {
  const n = buildNotice({ date: "2026-10-12", draft: { text: "い".repeat(160), angle: "a" }, reason: null, cfg: DEFAULT_CONFIG });
  assert(n.meta.trimmed && n.meta.weighted <= 280, JSON.stringify(n.meta));
  assert(weightedLength(new URL(n.click).searchParams.get("text")) <= 280, "link text fits");
  assert(n.message.includes("末尾を切りました"), "notice");
});
t("notice: a guard hit keeps the draft but removes the link (counts 0 drafts)", () => {
  const n = buildNotice({ date: "2026-10-12", draft: { text: "月額980円で出します", angle: "a" }, reason: null, cfg: DEFAULT_CONFIG });
  eq(n.drafts, 0);
  eq(n.click, DEFAULT_CONFIG.ops_url, "tap goes to /ops, not X");
  assert(!JSON.stringify(n).includes("x.com/intent"), "no X link anywhere");
  assert(n.message.includes("リンクを外しています"), "notice");
});
t("notice: no draft → says why, no link", () => {
  const n = buildNotice({ date: "2026-10-12", draft: null, reason: "今日の予算上限に達しました", cfg: DEFAULT_CONFIG });
  eq(n.drafts, 0);
  assert(n.title.endsWith("作れませんでした"), n.title);
  assert(n.message.includes("今日の予算上限に達しました"));
  assert(!JSON.stringify(n).includes("x.com/intent"));
});
t("notice: Sunday adds the weekly-record button, weekdays do not", () => {
  const sun = buildNotice({ date: "2026-10-11", draft: DRAFT, reason: null, cfg: DEFAULT_CONFIG });
  const mon = buildNotice({ date: "2026-10-12", draft: DRAFT, reason: null, cfg: DEFAULT_CONFIG });
  assert(sun.actions.some((a) => a.url === "https://brypo.com/ops/#weekly"), "sunday button");
  assert(sun.message.includes("今週の投稿数"), "sunday text");
  assert(sun.actions.length <= 3, "still ≤ 3 actions");
  assert(!mon.actions.some((a) => a.url.endsWith("#weekly")), "monday");
});
t("reminder: taps to the weekly record on /ops, no X link, not a draft", () => {
  const r = buildReminder("2026-10-18", DEFAULT_CONFIG);
  eq(r.title, "今週の記録（10/12〜10/18）");
  eq(r.click, "https://brypo.com/ops/#weekly");
  eq(r.actions, [{ action: "view", label: "記録する（1分）", url: "https://brypo.com/ops/#weekly", clear: true }]);
  assert(!JSON.stringify(r).includes("x.com/intent"), "no X link");
  assert(!("drafts" in r), "never counted as a delivered draft");
  assert(r.message.includes("投稿0本"), "states the counting rule");
});
t("post-draft answer: the asked day's draft is used; another day's never is", () => {
  const ok = { date: "2026-10-13", text: DRAFT.text, angle: DRAFT.angle, cached: false };
  eq(readDraftResponse("2026-10-13", 200, ok), { draft: { text: DRAFT.text, angle: DRAFT.angle } });
  // A server that predates ?date= (tick between merge and deploy) answers for today.
  const stale = readDraftResponse("2026-10-13", 200, { ...ok, date: "2026-10-12", cached: true });
  assert("reason" in stale && stale.reason.includes("2026-10-12"), JSON.stringify(stale));
});
t("post-draft answer: no draft → the server's reason, else the HTTP status", () => {
  eq(readDraftResponse("2026-10-13", 200, { date: "2026-10-13", text: null, reason: "今日の予算上限に達しました" }), {
    reason: "今日の予算上限に達しました",
  });
  eq(readDraftResponse("2026-10-14", 400, { error: "date must be today or tomorrow", code: "bad_date" }), {
    reason: "date must be today or tomorrow",
  });
  eq(readDraftResponse("2026-10-13", 502, null), { reason: "HTTP 502" });
  eq(readDraftResponse("2026-10-13", 0, null), { reason: "接続できませんでした" });
});

// ---- _postlog ---------------------------------------------------------------

console.log("_postlog");
const NOW = "2026-10-11T03:20:00.000Z";
t("parseLog tolerates absent/corrupt input and drops bad rows", () => {
  eq(parseLog(null), emptyLog());
  eq(parseLog("{nope"), emptyLog());
  const log = parseLog(
    JSON.stringify({
      first_live: "2026-10-12",
      sends: { "2026-10-12": { drafts: 1, mode: "live" }, bad: { drafts: 1, mode: "live" }, "2026-10-13": { drafts: 1, mode: "x" } },
      weeks: { "2026-10-18": { posts: 3, mood: 4 }, "2026-10-17": { posts: 3, mood: 4 }, "2026-10-25": { posts: 3, mood: 9 } },
    }),
  );
  eq(Object.keys(log.sends), ["2026-10-12"]);
  eq(Object.keys(log.weeks), ["2026-10-18"], "only valid Sunday rows");
});
t("parseLogInput validates both kinds", () => {
  eq(parseLogInput({ kind: "send", date: "2026-10-12", drafts: 1, mode: "live" }).kind, "send");
  eq(parseLogInput({ kind: "weekly", week: "2026-10-18", posts: 4, mood: 5 }).kind, "weekly");
  assert(typeof parseLogInput({ kind: "weekly", week: "2026-10-17", posts: 4, mood: 5 }) === "string", "not a Sunday");
  assert(typeof parseLogInput({ kind: "weekly", week: "2026-10-18", posts: 4, mood: 6 }) === "string", "mood 6");
  assert(typeof parseLogInput({ kind: "weekly", week: "2026-10-18", posts: 1.5, mood: 3 }) === "string", "fractional");
  assert(typeof parseLogInput({ kind: "send", date: "2026-10-12", drafts: 1, mode: "auto" }) === "string", "mode");
  assert(typeof parseLogInput({ kind: "post" }) === "string", "kind");
  assert(typeof parseLogInput(null) === "string", "null");
});
t("a live send sets first_live; a later dry run never overwrites it", () => {
  let log = applyLogInput(emptyLog(), { kind: "send", date: "2026-10-12", drafts: 1, mode: "dry_run" }, NOW);
  eq(log.first_live, null);
  assert(alreadyRan(log, "2026-10-12", "dry_run") && !alreadyRan(log, "2026-10-12", "live"), "dry run then live same day");
  log = applyLogInput(log, { kind: "send", date: "2026-10-12", drafts: 1, mode: "live" }, NOW);
  eq(log.first_live, "2026-10-12");
  log = applyLogInput(log, { kind: "send", date: "2026-10-12", drafts: 0, mode: "dry_run" }, NOW);
  eq(log.sends["2026-10-12"].mode, "live");
  assert(alreadyRan(log, "2026-10-12", "dry_run"), "live covers dry_run");
});
t("reminders: one per Sunday, recorded apart from drafts", () => {
  eq(parseLogInput({ kind: "remind", week: "2026-10-18", mode: "live" }), { kind: "remind", week: "2026-10-18", mode: "live" });
  assert(typeof parseLogInput({ kind: "remind", week: "2026-10-17", mode: "live" }) === "string", "not a Sunday");
  assert(typeof parseLogInput({ kind: "remind", week: "2026-10-18", mode: "auto" }) === "string", "mode");
  let log = applyLogInput(emptyLog(), { kind: "remind", week: "2026-10-18", mode: "dry_run" }, NOW);
  assert(reminded(log, "2026-10-18", "dry_run") && !reminded(log, "2026-10-18", "live"), "a dry run does not cover live");
  log = applyLogInput(log, { kind: "remind", week: "2026-10-18", mode: "live" }, NOW);
  log = applyLogInput(log, { kind: "remind", week: "2026-10-18", mode: "dry_run" }, NOW);
  eq(log.reminds["2026-10-18"].mode, "live", "a dry run never overwrites a live booking");
  assert(reminded(log, "2026-10-18", "dry_run"), "live covers dry_run");
  eq(log.sends, {}, "not a draft");
  eq(log.first_live, null, "does not start the judgment window");
  const back = parseLog(JSON.stringify({ ...log, reminds: { ...log.reminds, "2026-10-17": { mode: "live" }, "2026-10-25": { mode: "x" } } }));
  eq(Object.keys(back.reminds), ["2026-10-18"], "survives a round trip; bad rows dropped");
});
t("week helpers: Mon–Sun weeks keyed by Sunday", () => {
  eq(weekSunday("2026-10-12"), "2026-10-18"); // Mon
  eq(weekSunday("2026-10-18"), "2026-10-18"); // Sun
  eq(defaultRecordWeek("2026-10-18"), "2026-10-18");
  eq(defaultRecordWeek("2026-10-19"), "2026-10-18"); // Monday records last week
  eq(windowStart("2026-10-12"), "2026-10-12"); // Monday → same day
  eq(windowStart("2026-10-14"), "2026-10-19"); // Wednesday → next Monday
  eq(windowStart("2026-10-18"), "2026-10-19"); // Sunday → next day
});

/** Log with first live notification on Mon 2026-10-12 and one live draft every day for n weeks. */
function liveLog(weeks) {
  let log = emptyLog();
  for (let d = 0; d < 7 * 12; d++) {
    log = applyLogInput(log, { kind: "send", date: addDays("2026-10-12", d), drafts: 1, mode: "live" }, NOW);
  }
  weeks.forEach(([posts, mood], i) => {
    if (posts === null) return;
    log = applyLogInput(log, { kind: "weekly", week: addDays("2026-10-18", i * 7), posts, mood }, NOW);
  });
  return log;
}
const AFTER1 = "2026-11-23"; // day after week 6 (Sun 11-22)
const AFTER2 = "2027-01-04"; // day after week 12 (Sun 01-03)

t("judge: not started before the first live notification", () => {
  eq(judge(emptyLog(), "2026-10-11").status, "not_started");
});
t("judge: mid-window reports progress, never an early verdict", () => {
  const j = judge(liveLog([[0, 1], [0, 1], [0, 1]]), "2026-11-02");
  eq(j.status, "running");
  eq(j.windows[0].verdict, null);
  eq([j.windows[0].from, j.windows[0].to], ["2026-10-12", "2026-11-22"]);
  eq(j.windows[0].deadWeeks, 3, "the 3 ended weeks count, the 3 future ones do not");
});
t("judge: continue = ≥4 weeks with ≥3 posts AND mood avg ≥ 4.0", () => {
  const j = judge(liveLog([[3, 4], [4, 4], [3, 5], [5, 4], [1, 4], [2, 3]]), AFTER1);
  eq(j.windows[0].goodWeeks, 4);
  eq(j.windows[0].moodAvg, 4);
  eq([j.status, j.windows[0].verdict], ["decided", "continue"]);
});
t("judge: good posting but mood 3.83 is not continue → neither → extension", () => {
  const j = judge(liveLog([[3, 4], [4, 4], [3, 4], [5, 4], [1, 3], [2, 4]]), AFTER1);
  eq(j.windows[0].verdict, "neither");
  eq(j.status, "running");
  eq(j.windows[1].from, "2026-11-23");
});
t("judge: stop = ≥3 weeks under 1 post (unrecorded weeks count as 0)", () => {
  const j = judge(liveLog([[3, 4], [0, 3], [null], [0, 3], [3, 4], [3, 4]]), AFTER1);
  eq(j.windows[0].deadWeeks, 3);
  eq(j.windows[0].unrecorded, 1);
  eq(j.windows[0].verdict, "stop");
});
t("judge: stop = mood avg ≤ 2.0 even with posts", () => {
  const j = judge(liveLog([[3, 2], [3, 2], [3, 2], [3, 2], [3, 2], [3, 2]]), AFTER1);
  eq(j.windows[0].verdict, "stop");
});
t("judge: one extension only — neither twice → owner_call", () => {
  const mid = [[2, 3], [2, 3], [2, 3], [2, 3], [2, 3], [2, 3]];
  const j = judge(liveLog([...mid, ...mid]), AFTER2);
  eq(j.windows.map((w) => w.verdict), ["neither", "neither"]);
  eq(j.status, "owner_call");
});
t("judge: reference post rate = posts / live drafts delivered", () => {
  const j = judge(liveLog([[7, 4], [7, 4], [0, 4], [0, 4], [7, 4], [0, 4]]), AFTER1);
  eq(j.windows[0].postRate, 0.5); // 21 posts / 42 drafts
});

// ---- runner (scripts/post-notify.mjs) — offline -------------------------------

console.log("post-notify.mjs");
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const tmp = mkdtempSync(join(tmpdir(), "postnotify-"));
const fixture = join(tmp, "draft.json");
writeFileSync(fixture, JSON.stringify(DRAFT));
const outFile = (d) => join(root, "out", "post-notify", `${d}.json`);
const remindFile = (w) => join(root, "out", "post-notify", `remind-${w}.json`);

function run(args, env = {}) {
  return spawnSync(process.execPath, [join(here, "post-notify.mjs"), ...args], {
    // Pin dry_run unless a test says otherwise, so the repo config's mode
    // (the owner's live switch) never makes a test try to send.
    env: { PATH: process.env.PATH, POST_NOTIFY_MODE: "dry_run", ...env },
    encoding: "utf8",
  });
}

t("dry run (no secrets): writes the notification with the X link, sends nothing", () => {
  const d = "2026-10-12";
  rmSync(outFile(d), { force: true });
  const r = run(["--fixture", fixture, "--now", "2026-10-12T03:30:00Z"]);
  eq(r.status, 0, r.stdout + r.stderr);
  assert(r.stdout.includes("mode=dry_run"), r.stdout);
  assert(r.stdout.includes("nothing sent"), r.stdout);
  const out = JSON.parse(readFileSync(outFile(d), "utf8"));
  eq(out.click, xIntentUrl(DRAFT.text));
  eq(out.topic, "(NTFY_TOPIC)", "placeholder topic only");
  assert(!("drafts" in out) && !("meta" in out), "only the ntfy payload is written");
});
t("an early tick (05:30 JST) books today's AND tomorrow's 12:00", () => {
  for (const d of ["2026-10-12", "2026-10-13"]) rmSync(outFile(d), { force: true });
  const r = run(["--fixture", fixture, "--now", "2026-10-11T20:30:00Z"]);
  eq(r.status, 0, r.stdout + r.stderr);
  eq(JSON.parse(readFileSync(outFile("2026-10-12"), "utf8")).delay, String(Date.parse("2026-10-12T03:00:00Z") / 1000), "today 12:00 JST");
  eq(JSON.parse(readFileSync(outFile("2026-10-13"), "utf8")).delay, String(Date.parse("2026-10-13T03:00:00Z") / 1000), "tomorrow 12:00 JST");
});
t("a late tick (12:30 JST) sends today's at once and books tomorrow's", () => {
  for (const d of ["2026-10-12", "2026-10-13"]) rmSync(outFile(d), { force: true });
  const r = run(["--fixture", fixture, "--now", "2026-10-12T03:30:00Z"]);
  eq(r.status, 0, r.stdout + r.stderr);
  assert(r.stdout.includes("2026-10-12: delivery: now"), r.stdout);
  assert(r.stdout.includes("2026-10-13: delivery scheduled for 12:00 JST"), r.stdout);
  assert(!("delay" in JSON.parse(readFileSync(outFile("2026-10-12"), "utf8"))), "today: no delay");
  eq(JSON.parse(readFileSync(outFile("2026-10-13"), "utf8")).delay, String(Date.parse("2026-10-13T03:00:00Z") / 1000));
});
t("a forced run (workflow_dispatch) delivers today's at once and books nothing else", () => {
  for (const d of ["2026-10-12", "2026-10-13"]) rmSync(outFile(d), { force: true });
  const r = run(["--fixture", fixture, "--force", "--now", "2026-10-12T00:30:00Z"]);
  eq(r.status, 0, r.stdout + r.stderr);
  assert(r.stdout.includes("2026-10-12: delivery: now"), r.stdout);
  assert(!existsSync(outFile("2026-10-13")), "tomorrow untouched");
});
t("a Saturday tick also books the Sunday 20:00 reminder", () => {
  const w = "2026-10-18";
  rmSync(remindFile(w), { force: true });
  const r = run(["--fixture", fixture, "--now", "2026-10-17T01:00:00Z"]); // Sat 10:00 JST
  eq(r.status, 0, r.stdout + r.stderr);
  assert(r.stdout.includes(`${w} reminder: scheduled for 20:00 JST`), r.stdout);
  const out = JSON.parse(readFileSync(remindFile(w), "utf8"));
  eq(out.delay, String(Date.parse("2026-10-18T11:00:00Z") / 1000), "Sunday 20:00 JST");
  eq(out.click, "https://brypo.com/ops/#weekly");
  eq(out.topic, "(NTFY_TOPIC)", "placeholder topic only");
});
t("Sunday after 20:00 with no booking: the reminder goes out at once", () => {
  const w = "2026-10-18";
  rmSync(remindFile(w), { force: true });
  const r = run(["--fixture", fixture, "--now", "2026-10-18T11:30:00Z"]); // Sun 20:30 JST
  eq(r.status, 0, r.stdout + r.stderr);
  assert(r.stdout.includes(`${w} reminder: now`), r.stdout);
  assert(!("delay" in JSON.parse(readFileSync(remindFile(w), "utf8"))), "no delay");
});
t("early in the week no reminder is booked (ntfy holds at most 3 days)", () => {
  rmSync(remindFile("2026-10-18"), { force: true });
  const r = run(["--fixture", fixture, "--now", "2026-10-12T03:30:00Z"]); // Mon 12:30 JST
  eq(r.status, 0, r.stdout + r.stderr);
  assert(!r.stdout.includes("reminder"), r.stdout);
  assert(!existsSync(remindFile("2026-10-18")), "nothing written");
});
t("stop switch POST_NOTIFY_MODE=off: stops before anything else", () => {
  const r = run(["--fixture", fixture, "--force"], { POST_NOTIFY_MODE: "off" });
  eq(r.status, 0);
  assert(r.stdout.includes("stopped"), r.stdout);
  assert(!r.stdout.includes("built"), "nothing built");
});
t("live without the topic: fails loudly, names the missing key, sends nothing", () => {
  const r = run(["--fixture", fixture, "--force"], { POST_NOTIFY_MODE: "live" });
  eq(r.status, 1);
  assert(r.stdout.includes("NTFY_TOPIC"), r.stdout);
  assert(r.stdout.includes("nothing sent"), r.stdout);
});
t("block words never reach the log", () => {
  const r = run(["--fixture", fixture, "--force"], { POST_NOTIFY_BLOCK_WORDS: "SecretCorp" });
  eq(r.status, 0);
  assert(!(r.stdout + r.stderr).includes("SecretCorp"), "block word leaked");
});
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
