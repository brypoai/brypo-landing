/**
 * scripts/test-postdraft.mjs
 *
 * Unit tests for the pure helpers in functions/api/_postdraft.ts — the daily
 * /ops post draft: KV keys, the JST countdown, draft validation (the only
 * thing standing between a malformed model response and a half-rendered
 * board), the recent-angle ring, Opus-rate cost accounting, and the prompt
 * builder's grounding contract.
 *
 *   node scripts/test-postdraft.mjs
 *
 * Requires Node >= 22.18 (type-stripped .ts imports). No deps, no network.
 */

import {
  DRAFT_MAX_TOKENS,
  DRAFT_SYSTEM_PROMPT,
  DRAFT_PROMPT_VERSION,
  DRAFT_TTL_S,
  LAST_LINK_KEY,
  LINK_GAP_DAYS,
  POST_CHAR_LIMIT,
  POST_DRAFT_MODEL,
  RECENT_KEY,
  RECENT_LIMIT,
  SNAPSHOT_KEY,
  buildDraftUserMessage,
  computeDraftCostUsd,
  daysUntil,
  draftKey,
  linkAllowed,
  mentionsLink,
  nextDate,
  nextRecent,
  parseRecent,
  parseSnapshot,
  statsDelta,
  targetDate,
  toPostDraft,
  weekdayJa,
} from "../functions/api/_postdraft.ts";
import { jstDateKey, parseJsonObject } from "../functions/api/_lib.ts";

// ---- tiny runner ------------------------------------------------------------

let passed = 0;
let failed = 0;
function t(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok    ${name}`);
    })
    .catch((err) => {
      failed += 1;
      console.error(`  FAIL  ${name}\n        ${err.message}`);
    });
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function eq(actual, expected, label = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label} expected ${e}, got ${a}`);
}

// ---- KV keys ----------------------------------------------------------------

console.log("unit: post-draft KV keys");
t("draft key is namespaced per JST day and prompt version", () => {
  eq(DRAFT_PROMPT_VERSION, 3);
  eq(draftKey("2026-08-10"), "postdraft:v3:2026-08-10");
  // 08-10 08:00 UTC is already 08-10 17:00 JST; 08-10 23:00 UTC is 08-11 JST.
  eq(draftKey(jstDateKey(new Date("2026-08-10T08:00:00Z"))), "postdraft:v3:2026-08-10");
  eq(draftKey(jstDateKey(new Date("2026-08-10T23:00:00Z"))), "postdraft:v3:2026-08-11");
});
t("a prompt change misses the old cache entry (regenerates once that day)", () => {
  assert(draftKey("2026-10-12") !== "postdraft:2026-10-12", "v1 key no longer served");
  assert(draftKey("2026-10-12") !== "postdraft:v2:2026-10-12", "v2 key no longer served");
});
t("state keys are single rolling entries", () => {
  eq(RECENT_KEY, "postdraft:recent");
  eq(SNAPSHOT_KEY, "postdraft:snapshot");
  eq(LAST_LINK_KEY, "postdraft:lastlink");
});

// ---- countdown --------------------------------------------------------------

console.log("unit: dates");
t("daysUntil counts whole days and floors at zero", () => {
  eq(daysUntil("2026-08-10", "2026-09-07"), 28);
  eq(daysUntil("2026-09-07", "2026-09-07"), 0);
  eq(daysUntil("2026-09-30", "2026-09-07"), 0, "past the date");
  eq(daysUntil("garbage", "2026-09-07"), 0, "unparseable input");
});
t("targetDate: ?date= may name today or tomorrow (post-notify books a day ahead)", () => {
  eq(nextDate("2026-10-12"), "2026-10-13");
  eq(nextDate("2026-10-31"), "2026-11-01", "month end");
  eq(targetDate(null, "2026-10-12"), "2026-10-12", "absent → today");
  eq(targetDate("", "2026-10-12"), "2026-10-12", "empty → today");
  eq(targetDate("2026-10-12", "2026-10-12"), "2026-10-12");
  eq(targetDate("2026-10-13", "2026-10-12"), "2026-10-13", "tomorrow");
  eq(targetDate("2026-10-14", "2026-10-12"), null, "two days ahead refused");
  eq(targetDate("2026-10-11", "2026-10-12"), null, "past refused");
  eq(targetDate("garbage", "2026-10-12"), null);
});
t("a draft made a day ahead still gets its own day's delta and weekday", () => {
  // Today's draft (10-12) left a snapshot; tomorrow's draft, made later today,
  // reports the change since then and is written for Tuesday.
  const prev = { date: "2026-10-12", unique: 1, repeat: 0 };
  eq(statsDelta(prev, 2, 0, "2026-10-13"), { since: "2026-10-12", newUsers: 1, newRepeat: 0 });
  eq(weekdayJa("2026-10-13"), "火");
});
t("weekdayJa names the JST weekday so the model never computes it", () => {
  eq(weekdayJa("2026-10-11"), "日");
  eq(weekdayJa("2026-10-12"), "月");
  eq(weekdayJa("2026-10-17"), "土");
  eq(weekdayJa("garbage"), "");
});

// ---- change since the last draft ----------------------------------------------

console.log("unit: change since the last draft");
t("parseSnapshot tolerates absent and corrupt values", () => {
  eq(parseSnapshot(null), null);
  eq(parseSnapshot("{"), null, "corrupt JSON");
  eq(parseSnapshot('{"date":"x","unique":1,"repeat":0}'), null, "bad date");
  eq(parseSnapshot('{"date":"2026-10-11","unique":-1,"repeat":0}'), null, "negative");
  eq(parseSnapshot('{"date":"2026-10-11","unique":1.5,"repeat":0}'), null, "fractional");
  eq(parseSnapshot('{"date":"2026-10-11","unique":12,"repeat":3}'), { date: "2026-10-11", unique: 12, repeat: 3 });
});
t("statsDelta reports growth since the previous draft", () => {
  const prev = { date: "2026-10-11", unique: 12, repeat: 3 };
  eq(statsDelta(prev, 13, 3, "2026-10-12"), { since: "2026-10-11", newUsers: 1, newRepeat: 0 });
  eq(statsDelta(prev, 12, 3, "2026-10-12"), { since: "2026-10-11", newUsers: 0, newRepeat: 0 }, "flat day");
});
t("statsDelta says nothing rather than tell a false story", () => {
  const prev = { date: "2026-10-11", unique: 12, repeat: 3 };
  eq(statsDelta(null, 12, 3, "2026-10-12"), null, "first run");
  eq(statsDelta(prev, 12, 3, "2026-10-11"), null, "same-day regeneration");
  eq(statsDelta(prev, 5, 3, "2026-10-12"), null, "counter reset (would read as -7 people)");
  eq(statsDelta(prev, 12, 1, "2026-10-12"), null, "repeat counter reset");
});
t("the link is allowed at most once per LINK_GAP_DAYS", () => {
  eq(LINK_GAP_DAYS, 3);
  eq(linkAllowed(null, "2026-10-12"), true, "never linked");
  eq(linkAllowed("garbage", "2026-10-12"), true, "corrupt value never blocks forever");
  eq(linkAllowed("2026-10-12", "2026-10-12"), false, "same day");
  eq(linkAllowed("2026-10-10", "2026-10-12"), false, "two days later");
  eq(linkAllowed("2026-10-09", "2026-10-12"), true, "three days later");
});
t("mentionsLink spots the product link in a draft", () => {
  assert(mentionsLink("よかったら brypo.com/try で触ってみてほしい"));
  assert(mentionsLink("https://Brypo.com/try"));
  assert(!mentionsLink("証拠と照らし合わせる道具を作ってる"));
});

// ---- draft validation -------------------------------------------------------

console.log("unit: draft validation");
t("accepts a well-formed draft and trims it", () => {
  const d = toPostDraft({ text: "  今日は cross-check の閾値を下げた。  ", angle: " 実装の一手 " });
  eq(d, { text: "今日は cross-check の閾値を下げた。", angle: "実装の一手" });
});
t("accepts a fenced JSON response through parseJsonObject", () => {
  const raw = '```json\n{"text":"今日の一歩","angle":"進捗"}\n```';
  eq(toPostDraft(parseJsonObject(raw)), { text: "今日の一歩", angle: "進捗" });
});
t("rejects malformed shapes rather than half-rendering", () => {
  eq(toPostDraft(null), null, "null input");
  eq(toPostDraft(parseJsonObject("not json")), null, "unparseable");
  eq(toPostDraft({ text: "本文だけ" }), null, "missing angle");
  eq(toPostDraft({ angle: "角度だけ" }), null, "missing text");
  eq(toPostDraft({ text: "", angle: "a" }), null, "empty text");
  eq(toPostDraft({ text: "   ", angle: "a" }), null, "whitespace-only text");
  eq(toPostDraft({ text: 42, angle: "a" }), null, "non-string text");
  eq(toPostDraft({ text: "a", angle: ["b"] }), null, "non-string angle");
  eq(toPostDraft({ text: "あ".repeat(401), angle: "a" }), null, "essay, not a post");
  eq(toPostDraft({ text: "a", angle: "あ".repeat(201) }), null, "essay, not an angle");
});
t("tolerates a slightly-over-limit post so it can be trimmed by hand", () => {
  const long = "あ".repeat(POST_CHAR_LIMIT + 10);
  const d = toPostDraft({ text: long, angle: "長め" });
  assert(d !== null, "not rejected");
  assert(d.text.length > POST_CHAR_LIMIT, "the UI is what flags the overage");
});

// ---- recent-angle ring ------------------------------------------------------

console.log("unit: recent-angle ring");
t("parseRecent tolerates absent and corrupt values", () => {
  eq(parseRecent(null), []);
  eq(parseRecent("{"), [], "corrupt JSON");
  eq(parseRecent('{"a":1}'), [], "not an array");
  eq(parseRecent('["a",2,null,"b",""]'), ["a", "b"], "drops non-strings and empties");
});
t("nextRecent prepends, de-duplicates, and caps", () => {
  eq(nextRecent([], "初日"), ["初日"]);
  eq(nextRecent(["b", "a"], "c"), ["c", "b", "a"]);
  eq(nextRecent(["b", "a"], "a"), ["a", "b"], "reused angle moves to the front, not duplicated");
  eq(nextRecent(["a"], "   "), ["a"], "blank angle does not enter the ring");
  const many = Array.from({ length: RECENT_LIMIT + 5 }, (_, i) => `angle-${i}`);
  eq(nextRecent(many, "new").length, RECENT_LIMIT, "capped");
  eq(nextRecent(many, "new")[0], "new", "newest first");
});

// ---- cost accounting --------------------------------------------------------

console.log("unit: cost accounting");
t("draft cost uses the drafting model's own rates, not /try's", () => {
  // Opus 5: $5/M in, $25/M out. 1M in + 1M out = $30.
  eq(computeDraftCostUsd(1_000_000, 1_000_000), 30);
  eq(computeDraftCostUsd(0, 0), 0);
  eq(computeDraftCostUsd(-5, Number.NaN), 0, "garbage usage counts as zero");
});
t("a realistic daily call stays far under the shared cap", () => {
  const cost = computeDraftCostUsd(1200, 400);
  assert(cost > 0 && cost < 0.05, `expected a sub-cent-ish call, got ${cost}`);
});

// ---- prompt grounding -------------------------------------------------------

console.log("unit: prompt grounding");
t("system prompt forbids invented facts and fixes the output shape", () => {
  assert(/only the numbers in the facts list/.test(DRAFT_SYSTEM_PROMPT), "numbers grounded");
  assert(/Do not say that something happened unless the facts say it/.test(DRAFT_SYSTEM_PROMPT), "no invented events");
  assert(/If the numbers did not change, don't imply they did/.test(DRAFT_SYSTEM_PROMPT), "no fake movement");
  assert(/OUTPUT LANGUAGE: Japanese/.test(DRAFT_SYSTEM_PROMPT), "output language fixed");
  assert(DRAFT_SYSTEM_PROMPT.includes('"text"') && DRAFT_SYSTEM_PROMPT.includes('"angle"'), "shape stated");
  assert(/140/.test(DRAFT_SYSTEM_PROMPT), "character budget stated");
});

console.log("unit: prompt voice (owner 2026-10-12: 「人の感情がなくビジネス文書的」)");
t("asks for a feeling in every post, casual plain form, no keigo", () => {
  assert(/It carries a feeling/.test(DRAFT_SYSTEM_PROMPT), "feeling required");
  assert(/A post with no feeling in it has failed/.test(DRAFT_SYSTEM_PROMPT), "flat post named as failure");
  assert(/casual plain Japanese/.test(DRAFT_SYSTEM_PROMPT) && /No です・ます/.test(DRAFT_SYSTEM_PROMPT), "常体");
  assert(/Feelings, opinions, doubts, hopes and questions are fine/.test(DRAFT_SYSTEM_PROMPT), "feelings allowed");
  assert(/small and plain beats dramatic/.test(DRAFT_SYSTEM_PROMPT), "no melodrama");
  assert(!/resolution/.test(DRAFT_SYSTEM_PROMPT), "no shape that invites invented plans");
});
t("bans the business / press-release register by name", () => {
  for (const w of ["本日", "いたしました", "となります", "を実現", "を提供", "ぜひ", "皆様", "ユーザー数", "リピート率", "チェックポイント", "いかがでしたか"]) {
    assert(DRAFT_SYSTEM_PROMPT.includes(w), `banned word listed: ${w}`);
  }
  assert(/No call to action and no engagement bait/.test(DRAFT_SYSTEM_PROMPT), "no CTA / bait");
});
console.log("unit: prompt voice v3 (owner sample: 「この位の感じでいいのでは」)");
const OWNER_SAMPLE = "触ってくれた人はまだ一人だけど、モチベ保たせてくれる唯一の人や。";
t("the owner's own post is the first, verbatim voice reference", () => {
  const at = DRAFT_SYSTEM_PROMPT.indexOf(OWNER_SAMPLE);
  assert(at > 0, "owner sample present verbatim");
  assert(at < DRAFT_SYSTEM_PROMPT.indexOf("More voice examples"), "it comes before the other examples");
  assert(/never reuse that count/.test(DRAFT_SYSTEM_PROMPT), "its count is marked as that day's, not a fact");
});
t("short like the owner's post: one or two sentences, 20–60 characters", () => {
  assert(/One or two sentences, usually 20–60 Japanese characters/.test(DRAFT_SYSTEM_PROMPT), "length target");
  assert(!/60–120/.test(DRAFT_SYSTEM_PROMPT), "old, longer target gone");
});
t("the owner's light Kansai や, never a caricature", () => {
  assert(/light Kansai flavour/.test(DRAFT_SYSTEM_PROMPT), "dialect named");
  assert(/never as a caricature/.test(DRAFT_SYSTEM_PROMPT), "kept light");
});
t("a link, when allowed, sits alone on the last line", () => {
  assert(/put it alone on the\s+last line, bare/.test(DRAFT_SYSTEM_PROMPT), "link format");
});
t("every voice example is short, casual, digit-free and link-free", () => {
  const start = DRAFT_SYSTEM_PROMPT.indexOf("The owner's own post");
  const end = DRAFT_SYSTEM_PROMPT.indexOf("OUTPUT LANGUAGE");
  assert(start > 0 && end > start, "examples present");
  const block = DRAFT_SYSTEM_PROMPT.slice(start, end);
  assert(/never reuse their facts/.test(block), "marked as tone-only");
  const examples = block.split("\n").filter((l) => l.startsWith("- "));
  assert(examples.length >= 4, `at least four examples, got ${examples.length}`);
  for (const ex of examples) {
    const text = ex.slice(2);
    assert(!/[0-9０-９]/.test(text), `no digits that could leak into a real post: ${ex}`);
    assert(!/です|ます/.test(text), `examples model the casual form too: ${ex}`);
    assert(!/brypo\.com/.test(text), `no link in examples: ${ex}`);
    assert([...text].length <= 50, `short like the owner's post (${[...text].length} chars): ${ex}`);
  }
});
t("the old L0-1 checkpoint is gone from the prompt", () => {
  const msg = buildDraftUserMessage({
    date: "2026-10-12",
    uniqueTryUsers: 12,
    repeatTryUsers: 3,
    delta: null,
    linkOk: true,
    recentAngles: [],
  });
  assert(!/checkpoint|Days left|2026-09-07/.test(DRAFT_SYSTEM_PROMPT + msg), "no stale countdown");
});

console.log("unit: user message");
const base = {
  date: "2026-10-12",
  uniqueTryUsers: 13,
  repeatTryUsers: 3,
  delta: { since: "2026-10-11", newUsers: 1, newRepeat: 0 },
  linkOk: false,
  recentAngles: ["昨日の角度", "一昨日の角度"],
};
t("carries only first-party values, with the weekday spelled out", () => {
  const msg = buildDraftUserMessage(base);
  assert(msg.includes("2026-10-12 (月)"), "date + weekday");
  assert(msg.includes("so far: 13"), "unique users");
  assert(msg.includes("later day: 3"), "repeat users");
  assert(msg.includes("昨日の角度"), "recent angles fed back");
  assert(msg.includes("choose a different feeling or shape today"), "dedup instruction");
});
t("states the change since the last draft — growth, or plainly none", () => {
  assert(buildDraftUserMessage(base).includes("Since the last draft (2026-10-11): 1 new person tried it; 0 more came back."));
  const two = buildDraftUserMessage({ ...base, delta: { since: "2026-10-11", newUsers: 2, newRepeat: 1 } });
  assert(two.includes("2 new people tried it; 1 more came back."), "plural");
  const flat = buildDraftUserMessage({ ...base, delta: { since: "2026-10-11", newUsers: 0, newRepeat: 0 } });
  assert(flat.includes("Since the last draft (2026-10-11): no change."), "flat day said plainly");
  const none = buildDraftUserMessage({ ...base, delta: null });
  assert(!none.includes("Since the last draft"), "no line when there is nothing honest to say");
});
t("tells the model whether a link is allowed today", () => {
  assert(buildDraftUserMessage(base).includes("Link today: no"), "not today");
  assert(buildDraftUserMessage({ ...base, linkOk: true }).includes("Link today: OK"), "allowed");
});
t("first run says so instead of listing an empty section", () => {
  const msg = buildDraftUserMessage({ ...base, delta: null, recentAngles: [] });
  assert(msg.includes("No posts drafted yet"), "first-run wording");
  assert(!msg.includes("choose a different feeling"), "no dangling dedup list");
});

// ---- constants sanity -------------------------------------------------------

console.log("unit: constants");
t("defaults are sane", () => {
  assert(POST_DRAFT_MODEL.startsWith("claude-"), "model id looks like a Claude model");
  assert(DRAFT_MAX_TOKENS >= 1000, "headroom for adaptive thinking + the JSON body");
  assert(DRAFT_TTL_S >= 30 * 24 * 3600, "state keys outlive a month of drafts");
  eq(POST_CHAR_LIMIT, 140);
});

// ---- summary ----------------------------------------------------------------

process.on("beforeExit", () => {
  console.log(`\nunit result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
});
