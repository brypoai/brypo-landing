// functions/api/_postnotify.ts
//
// Pure helpers for scripts/post-notify.mjs — the once-a-day phone
// notification (ntfy) that brings the /ops post draft to the owner; tapping
// it opens X's compose screen with the text filled in (docs/post-notify.md).
// No I/O, no env; unit-tested by scripts/test-postnotify.mjs.
//
// What this file decides:
//   - schedule: should this hourly tick send? (send hour from the config file)
//   - guard:    does the draft contain something that must never be posted
//               (prices / paid-plan talk / affiliate links / contact details,
//               plus owner-supplied words such as an employer name)? A hit
//               keeps the draft in the notification but removes the X link.
//   - notice:   title + text + tap target (the X compose link) + buttons.
//
// Nothing here posts to X. The link only opens X's compose screen with the
// text filled in; the owner reads it and taps "post" themselves.

import { X_MAX_WEIGHTED, fitToWeighted, weightedLength, xIntentUrl } from "./_xtext.ts";

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
}

export const DEFAULT_CONFIG: NotifyConfig = {
  send_hour_jst: 12,
  retry_hours: 3,
  base_url: "https://brypo.com",
  ops_url: "https://brypo.com/ops/",
  mode: "dry_run",
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

/** Has today's send time arrived? */
export function isDue(hour: number, cfg: NotifyConfig): boolean {
  return hour >= cfg.send_hour_jst;
}

/** Last tick of the day on which a failed draft fetch is still retried;
 *  past it, the day's notification goes out saying the draft could not be made. */
export function isLastChance(hour: number, cfg: NotifyConfig): boolean {
  return hour >= Math.min(23, cfg.send_hour_jst + cfg.retry_hours);
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
