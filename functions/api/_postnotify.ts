// functions/api/_postnotify.ts
//
// Pure helpers for scripts/post-notify.mjs — the once-a-day phone
// notification (ntfy) that brings the /ops post draft to the owner; tapping
// it opens X's compose screen with the text filled in (docs/post-notify.md).
// No I/O, no env; unit-tested by scripts/test-postnotify.mjs.
//
// What this file decides:
//   - schedule: which of today's / tomorrow's send hours this tick books
//               (send hour from the config file), and when to book the
//               Sunday-evening reminder to record the week on /ops
//   - guard:    does the draft contain something that must never be posted
//               (prices / paid-plan talk / affiliate links / contact details,
//               plus owner-supplied words such as an employer name)? A hit
//               keeps the draft in the notification but removes the X link.
//   - notice:   title + text + tap target (the X compose link) + buttons.
//
// Nothing here posts to X. The link only opens X's compose screen with the
// text filled in; the owner reads it and taps "post" themselves.

import { X_MAX_WEIGHTED, fitToWeighted, weightedLength, xIntentUrl } from "./_xtext.ts";
import { addDays, weekSunday } from "./_postlog.ts";

// ---- config -----------------------------------------------------------------

export interface NotifyConfig {
  /** Hour (JST, 0–23) from which the day's notification goes out. */
  send_hour_jst: number;
  /** Hours after send_hour to keep retrying a failed draft fetch. */
  retry_hours: number;
  /** Where the runner fetches the draft / writes the log. */
  base_url: string;
  /** Board link (notification fallback tap target and the Sunday record link). */
  ops_url: string;
  /** Default mode when Variable POST_NOTIFY_MODE is unset: "dry_run" | "live". */
  mode: "dry_run" | "live";
  /** Hour (JST, 0–23) on Sundays of the reminder to record the week on /ops. */
  remind_hour_jst: number;
}

export const DEFAULT_CONFIG: NotifyConfig = {
  send_hour_jst: 12,
  retry_hours: 3,
  base_url: "https://brypo.com",
  ops_url: "https://brypo.com/ops/",
  mode: "dry_run",
  remind_hour_jst: 20,
};

/** Merge a parsed config file over the defaults, ignoring bad values. */
export function parseConfig(obj: any): NotifyConfig {
  const c = { ...DEFAULT_CONFIG };
  if (obj === null || typeof obj !== "object") return c;
  if (Number.isInteger(obj.send_hour_jst) && obj.send_hour_jst >= 0 && obj.send_hour_jst <= 23) {
    c.send_hour_jst = obj.send_hour_jst;
  }
  if (Number.isInteger(obj.retry_hours) && obj.retry_hours >= 0 && obj.retry_hours <= 12) {
    c.retry_hours = obj.retry_hours;
  }
  if (typeof obj.base_url === "string" && obj.base_url.startsWith("https://")) c.base_url = obj.base_url.replace(/\/+$/, "");
  if (typeof obj.ops_url === "string" && obj.ops_url.startsWith("https://")) c.ops_url = obj.ops_url;
  if (obj.mode === "live") c.mode = "live";
  if (Number.isInteger(obj.remind_hour_jst) && obj.remind_hour_jst >= 0 && obj.remind_hour_jst <= 23) {
    c.remind_hour_jst = obj.remind_hour_jst;
  }
  return c;
}

// ---- mode / schedule --------------------------------------------------------

export type RunMode = "dry_run" | "live" | "off";

/**
 * Effective mode. The Variable POST_NOTIFY_MODE, when set, wins (the owner's
 * override and kill switch: "off" stops everything). Unset → the config
 * file's `mode`. Any other word → dry_run (never sends by accident).
 */
export function parseMode(raw: string | undefined, configMode: "dry_run" | "live" = "dry_run"): RunMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return configMode;
  return v === "live" ? "live" : v === "off" ? "off" : "dry_run";
}

/** JST hour (0–23) of `now`. */
export function jstHour(now: Date): number {
  return new Date(now.getTime() + 9 * 3600_000).getUTCHours();
}

function jstInstant(date: string, hour: number): number {
  return Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00+09:00`);
}

/** Epoch ms of the send hour on `date` (JST YYYY-MM-DD). */
export function sendInstant(date: string, cfg: NotifyConfig): number {
  return jstInstant(date, cfg.send_hour_jst);
}

/** The day after `date` (YYYY-MM-DD). */
export function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** Last moment of the day on which a failed draft fetch is still retried;
 *  past it, the day's notification goes out saying the draft could not be made. */
export function isLastChance(nowMs: number, date: string, cfg: NotifyConfig): boolean {
  return nowMs >= jstInstant(date, Math.min(23, cfg.send_hour_jst + cfg.retry_hours));
}

/** Closer to the send hour than this, deliver now (ntfy's own floor is 10 s). */
export const MIN_DELAY_MS = 30_000;

/** One delivery a tick should take care of. */
export interface Slot {
  /** JST date the notification is for (and is recorded under). */
  date: string;
  /** Today's send hour has already passed: deliver now, not on the hour. */
  late: boolean;
}

/**
 * The deliveries this tick should book, oldest first, skipping any already
 * booked: today's (scheduled for the send hour, or — if that has passed — a
 * late send now) and tomorrow's (scheduled). Booking a day ahead is what
 * makes the arrival time independent of GitHub's cron, which runs hours late
 * or not at all on this repo: one tick at any time of day lands the next noon.
 */
export function planSlots(
  nowMs: number,
  today: string,
  cfg: NotifyConfig,
  isBooked: (date: string) => boolean,
): Slot[] {
  const slots: Slot[] = [];
  if (!isBooked(today)) slots.push({ date: today, late: sendInstant(today, cfg) - nowMs < MIN_DELAY_MS });
  const tomorrow = nextDate(today);
  if (!isBooked(tomorrow)) slots.push({ date: tomorrow, late: false });
  return slots;
}

/**
 * ntfy `delay` — unix seconds as a string — that lands the notification on
 * the send hour, or null to deliver right away: the send hour has passed (a
 * late run), it is less than MIN_DELAY_MS off, or the run was forced by hand.
 */
export function deliveryDelay(nowMs: number, date: string, cfg: NotifyConfig, force = false): string | null {
  return force ? null : delayUntil(sendInstant(date, cfg), nowMs);
}

function delayUntil(atMs: number, nowMs: number): string | null {
  return atMs - nowMs >= MIN_DELAY_MS ? String(Math.floor(atMs / 1000)) : null;
}

/** ntfy.sh holds a scheduled message for at most 3 days; stay an hour inside. */
export const MAX_DELAY_MS = 3 * 86_400_000 - 3_600_000;

/** Epoch ms of the reminder for `week` (its Sunday, JST). */
export function remindInstant(week: string, cfg: NotifyConfig): number {
  return jstInstant(week, cfg.remind_hour_jst);
}

/** The Sunday reminder a tick should take care of. */
export interface ReminderSlot {
  /** The Sunday (JST) closing the week to record — also its record key. */
  week: string;
  /** The reminder hour has passed (Sunday evening, not booked yet): send now. */
  late: boolean;
}

/**
 * The weekly "record your week on /ops" reminder, Sunday at remind_hour_jst.
 * Booked like the drafts, with ntfy's scheduled delivery, by the first tick
 * once the hour is within ntfy's 3-day limit (from Thursday evening) — so
 * GitHub's sparse cron only has to fire once in those days. Not booked by
 * Sunday's hour → send now (until midnight; the week can still be recorded
 * later on /ops).
 */
export function planReminder(
  nowMs: number,
  today: string,
  cfg: NotifyConfig,
  isReminded: (week: string) => boolean,
): ReminderSlot | null {
  const week = weekSunday(today);
  if (isReminded(week)) return null;
  const at = remindInstant(week, cfg);
  if (at - nowMs > MAX_DELAY_MS) return null; // too far ahead for ntfy to hold
  return { week, late: at - nowMs < MIN_DELAY_MS };
}

/** ntfy `delay` for the reminder, or null to send now (see deliveryDelay). */
export function remindDelay(nowMs: number, week: string, cfg: NotifyConfig): string | null {
  return delayUntil(remindInstant(week, cfg), nowMs);
}

// ---- guard ------------------------------------------------------------------

const GUARD_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ["価格・料金の表現", /\d[\d,]*\s*(?:円|ドル)|[¥￥$＄]\s?\d|月額|年額|料金|価格|値段|有料|課金|プラン|割引|セール|クーポン|無料期間|pricing|\/mo\b/i],
  ["アフィリエイト", /アフィリエイト|affiliate|amzn\.to|amazon\.co\.jp\/|a8\.net|moshimo|valuecommerce|[?&]tag=/i],
  ["メールアドレス", /[\w.+-]+@[\w-]+\.[\w.-]+/],
  ["電話番号", /0\d{1,4}-\d{1,4}-\d{3,4}|\+81[\s-]?\d/],
];

/** Owner-supplied block words (secret POST_NOTIFY_BLOCK_WORDS, comma-separated). */
export function parseBlockWords(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,、\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Names of the rules `text` trips (empty = clean). Owner words report only
 * as "登録した除外語" — the word itself never reaches a log or a notification.
 */
export function guardHits(text: string, blockWords: string[] = []): string[] {
  const hits = GUARD_RULES.filter(([, re]) => re.test(text)).map(([name]) => name);
  const lower = text.toLowerCase();
  if (blockWords.some((w) => lower.includes(w.toLowerCase()))) hits.push("登録した除外語");
  return hits;
}

// ---- notification ---------------------------------------------------------

export interface DraftIn {
  text: string;
  angle: string;
}

/**
 * What a GET /api/post-draft?date=<date> answer means for `date`: the draft,
 * or why there is none. A server that predates ?date= — e.g. a tick that runs
 * between a merge and its Cloudflare deploy — answers with today's draft
 * whatever was asked; that is not `date`'s draft, so it is never booked for it.
 */
export function readDraftResponse(
  date: string,
  status: number,
  data: { date?: unknown; text?: unknown; angle?: unknown; reason?: unknown; error?: unknown } | null,
): { draft: DraftIn } | { reason: string } {
  if (status === 200 && typeof data?.date === "string" && data.date !== date) {
    return { reason: `別の日（${data.date}）の文案が返りました（サーバーの更新待ち）` };
  }
  if (status === 200 && typeof data?.text === "string" && data.text) {
    return { draft: { text: data.text, angle: String(data.angle ?? "") } };
  }
  return { reason: String(data?.reason || data?.error || (status ? `HTTP ${status}` : "接続できませんでした")) };
}

/** One ntfy action button (https://docs.ntfy.sh/publish/#action-buttons). */
export interface NoticeAction {
  action: "view";
  label: string;
  url: string;
  clear?: boolean;
}

/**
 * What goes to ntfy (JSON publish, minus the topic, which is a secret and is
 * added by the runner). Tapping the notification opens `click`: the X compose
 * screen with the draft filled in — one tap from the lock screen.
 */
export interface Notice {
  title: string;
  message: string;
  click: string;
  actions: NoticeAction[];
  tags: string[];
  /** Drafts carried with a usable X link (0 or 1) — the machine record. */
  drafts: number;
  /** For the run log only — no draft text. */
  meta: { weighted: number | null; trimmed: boolean; guard: string[] };
}

export interface NoticeInput {
  date: string; // JST YYYY-MM-DD
  draft: DraftIn | null;
  /** Why there is no draft (shown when draft is null). */
  reason: string | null;
  cfg: NotifyConfig;
  blockWords?: string[];
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function dayLabel(date: string): { md: string; wd: string; sunday: boolean } {
  const d = new Date(`${date}T00:00:00Z`);
  return { md: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, wd: WEEKDAYS[d.getUTCDay()], sunday: d.getUTCDay() === 0 };
}

export function buildNotice(input: NoticeInput): Notice {
  const { date, draft, reason, cfg } = input;
  const { md, wd, sunday } = dayLabel(date);
  const weeklyUrl = `${cfg.ops_url}#weekly`;
  const actions: NoticeAction[] = [];
  let message: string;
  let click = cfg.ops_url;
  let drafts = 0;
  let meta: Notice["meta"] = { weighted: null, trimmed: false, guard: [] };
  let title = `今日の投稿文案（${md} ${wd}）`;

  if (draft === null) {
    title += " — 作れませんでした";
    message = `今日の文案は作れませんでした（${reason ?? "理由不明"}）。明日また届きます。`;
  } else {
    const fit = fitToWeighted(draft.text, X_MAX_WEIGHTED);
    const hits = guardHits(fit.text, input.blockWords ?? []);
    meta = { weighted: weightedLength(fit.text), trimmed: fit.trimmed, guard: hits };
    const lines = [fit.text];
    if (fit.trimmed) lines.push("", `※ 280字（X の数え方）を超えたため末尾を切りました（元 ${weightedLength(draft.text)}）。`);
    if (hits.length) {
      lines.push("", `※ 投稿しない内容に該当（${hits.join("・")}）。リンクを外しています。`);
    } else {
      const url = xIntentUrl(fit.text);
      click = url;
      drafts = 1;
      actions.push({ action: "view", label: "X で投稿", url, clear: true });
      lines.push("", "タップで X の投稿画面が本文入りで開きます（送信はご自身で）。");
    }
    message = lines.join("\n");
  }

  if (sunday) {
    actions.push({ action: "view", label: "今週の記録（1分）", url: weeklyUrl });
    message += "\n\n日曜なので、今週の投稿数と気持ち（5段階）の記録をお願いします。";
  }
  actions.push({ action: "view", label: "一覧", url: cfg.ops_url });

  return { title, message, click, actions: actions.slice(0, 3), tags: ["memo"], drafts, meta };
}

/** The Sunday-evening reminder: record this week's posts and mood on /ops.
 *  No draft and no X link — it is not counted as a delivered draft. */
export function buildReminder(week: string, cfg: NotifyConfig): Omit<Notice, "drafts" | "meta"> {
  const url = `${cfg.ops_url}#weekly`;
  return {
    title: `今週の記録（${dayLabel(addDays(week, -6)).md}〜${dayLabel(week).md}）`,
    message: "今週の投稿数と気持ち（5段階）の記録をお願いします（1分）。\n記録が無い週は投稿0本として数えます。",
    click: url,
    actions: [{ action: "view", label: "記録する（1分）", url, clear: true }],
    tags: ["pencil2"],
  };
}
