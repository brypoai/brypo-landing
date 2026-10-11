// functions/api/_postmail.ts
//
// Pure helpers for scripts/post-mail.mjs — the once-a-day mail that brings
// the /ops post draft to the owner's inbox with a one-tap "X で投稿" link
// (docs/post-mail.md). No I/O, no env; unit-tested by scripts/test-postmail.mjs.
//
// What this file decides:
//   - schedule: should this hourly tick send? (send hour from the config file)
//   - guard:    does the draft contain something that must never be posted
//               (prices / paid-plan talk / affiliate links / contact details,
//               plus owner-supplied words such as an employer name)? A hit
//               keeps the draft in the mail but removes the X link.
//   - mail:     subject + plain text + HTML, both carrying the same link.
//
// Nothing here posts to X. The link only opens X's compose screen with the
// text filled in; the owner reads it and taps "post" themselves.

import { X_MAX_WEIGHTED, fitToWeighted, weightedLength, xIntentUrl } from "./_xtext.ts";

// ---- config -----------------------------------------------------------------

export interface MailConfig {
  /** Hour (JST, 0–23) from which the day's mail goes out. */
  send_hour_jst: number;
  /** Hours after send_hour to keep retrying a failed draft fetch. */
  retry_hours: number;
  /** Where the runner fetches the draft / writes the log. */
  base_url: string;
  /** Board link in the mail footer and the Sunday record link. */
  ops_url: string;
}

export const DEFAULT_CONFIG: MailConfig = {
  send_hour_jst: 12,
  retry_hours: 3,
  base_url: "https://brypo.com",
  ops_url: "https://brypo.com/ops/",
};

/** Merge a parsed config file over the defaults, ignoring bad values. */
export function parseConfig(obj: any): MailConfig {
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
  return c;
}

// ---- mode / schedule --------------------------------------------------------

export type RunMode = "dry_run" | "live" | "off";

/** POST_MAIL_MODE → mode. Anything but the exact words means dry_run. */
export function parseMode(raw: string | undefined): RunMode {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "live" ? "live" : v === "off" ? "off" : "dry_run";
}

/** JST hour (0–23) of `now`. */
export function jstHour(now: Date): number {
  return new Date(now.getTime() + 9 * 3600_000).getUTCHours();
}

/** Has today's send time arrived? */
export function isDue(hour: number, cfg: MailConfig): boolean {
  return hour >= cfg.send_hour_jst;
}

/** Last tick of the day on which a failed draft fetch is still retried;
 *  past it, the day's mail goes out saying the draft could not be made. */
export function isLastChance(hour: number, cfg: MailConfig): boolean {
  return hour >= Math.min(23, cfg.send_hour_jst + cfg.retry_hours);
}

// ---- guard ------------------------------------------------------------------

const GUARD_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ["価格・料金の表現", /\d[\d,]*\s*(?:円|ドル)|[¥￥$＄]\s?\d|月額|年額|料金|価格|値段|有料|課金|プラン|割引|セール|クーポン|無料期間|pricing|\/mo\b/i],
  ["アフィリエイト", /アフィリエイト|affiliate|amzn\.to|amazon\.co\.jp\/|a8\.net|moshimo|valuecommerce|[?&]tag=/i],
  ["メールアドレス", /[\w.+-]+@[\w-]+\.[\w.-]+/],
  ["電話番号", /0\d{1,4}-\d{1,4}-\d{3,4}|\+81[\s-]?\d/],
];

/** Owner-supplied block words (secret POST_MAIL_BLOCK_WORDS, comma-separated). */
export function parseBlockWords(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,、\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Names of the rules `text` trips (empty = clean). Owner words report only
 * as "登録した除外語" — the word itself never reaches a log or a mail.
 */
export function guardHits(text: string, blockWords: string[] = []): string[] {
  const hits = GUARD_RULES.filter(([, re]) => re.test(text)).map(([name]) => name);
  const lower = text.toLowerCase();
  if (blockWords.some((w) => lower.includes(w.toLowerCase()))) hits.push("登録した除外語");
  return hits;
}

// ---- mail -------------------------------------------------------------------

export interface DraftIn {
  text: string;
  angle: string;
}

export interface MailParts {
  subject: string;
  text: string;
  html: string;
  /** Drafts carried by this mail with a usable X link (0 or 1). */
  drafts: number;
  /** For the run log only — no draft text, no addresses. */
  meta: { weighted: number | null; trimmed: boolean; guard: string[] };
}

export interface MailInput {
  date: string; // JST YYYY-MM-DD
  draft: DraftIn | null;
  /** Why there is no draft (shown in the mail when draft is null). */
  reason: string | null;
  cfg: MailConfig;
  blockWords?: string[];
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function dayLabel(date: string): { md: string; wd: string; sunday: boolean } {
  const d = new Date(`${date}T00:00:00Z`);
  return { md: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, wd: WEEKDAYS[d.getUTCDay()], sunday: d.getUTCDay() === 0 };
}

export function buildMail(input: MailInput): MailParts {
  const { date, draft, reason, cfg } = input;
  const { md, wd, sunday } = dayLabel(date);
  const weeklyUrl = `${cfg.ops_url}#weekly`;

  let body: { textLines: string[]; html: string };
  let drafts = 0;
  let meta: MailParts["meta"] = { weighted: null, trimmed: false, guard: [] };

  if (draft === null) {
    const why = reason ?? "理由不明";
    body = {
      textLines: [`今日の文案は作れませんでした（${why}）。`, "明日また届きます。"],
      html: `<p style="margin:0 0 8px">今日の文案は作れませんでした（${escapeHtml(why)}）。</p><p style="margin:0;color:#666">明日また届きます。</p>`,
    };
  } else {
    const fit = fitToWeighted(draft.text, X_MAX_WEIGHTED);
    const hits = guardHits(fit.text, input.blockWords ?? []);
    meta = { weighted: weightedLength(fit.text), trimmed: fit.trimmed, guard: hits };
    const notes: string[] = [];
    if (fit.trimmed) notes.push(`280字（X の数え方）を超えたため末尾を切りました（元 ${weightedLength(draft.text)}）。`);
    if (hits.length) notes.push(`投稿しない内容に該当（${hits.join("・")}）。リンクを外しています。`);
    const url = hits.length ? null : xIntentUrl(fit.text);
    if (url) drafts = 1;

    const textLines = [fit.text, "", `狙い: ${draft.angle}`, `長さ: ${meta.weighted} / 280`];
    for (const n of notes) textLines.push(`※ ${n}`);
    textLines.push("");
    if (url) textLines.push("▼ X で投稿（投稿画面が本文入りで開きます。送信はご自身で）", url);

    const button = url
      ? `<p style="margin:16px 0 4px"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;background:#111;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">X で投稿</a></p>` +
        `<p style="margin:0;color:#666;font-size:12px">投稿画面が本文入りで開きます。送信はご自身で。</p>`
      : "";
    const noteHtml = notes.map((n) => `<p style="margin:8px 0 0;color:#b4361f;font-size:13px">※ ${escapeHtml(n)}</p>`).join("");
    body = {
      textLines,
      html:
        `<div style="border:1px solid #ddd;border-radius:8px;padding:14px 16px;white-space:pre-wrap;font-size:16px;line-height:1.7">${escapeHtml(fit.text)}</div>` +
        `<p style="margin:8px 0 0;color:#666;font-size:12px">狙い: ${escapeHtml(draft.angle)} ・ 長さ ${meta.weighted} / 280</p>` +
        noteHtml +
        button,
    };
  }

  const weeklyText = sunday ? ["", "▼ 今週の記録（日曜・1分）: 投稿数と気持ち（5段階）", weeklyUrl] : [];
  const weeklyHtml = sunday
    ? `<p style="margin:20px 0 0;padding:12px 14px;background:#f4f4f0;border-radius:8px;font-size:14px">日曜なので今週の記録をお願いします（1分）。<br><a href="${escapeHtml(weeklyUrl)}">投稿数と気持ち（5段階）を記録する</a></p>`
    : "";

  const subject = draft === null ? `今日の投稿文案（${md} ${wd}）— 作れませんでした` : `今日の投稿文案（${md} ${wd}）`;
  const footerText = ["", "—", `一覧: ${cfg.ops_url}`, "配信の停止: GitHub の Variables で POST_MAIL_MODE=off"];
  const text = [...body.textLines, ...weeklyText, ...footerText].join("\n");
  const html =
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:16px;background:#fff;color:#111;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Noto Sans JP',sans-serif">` +
    `<div style="max-width:520px;margin:0 auto">` +
    body.html +
    weeklyHtml +
    `<p style="margin:24px 0 0;color:#999;font-size:11px">一覧: <a href="${escapeHtml(cfg.ops_url)}" style="color:#999">${escapeHtml(cfg.ops_url)}</a> ・ 配信の停止: GitHub の Variables で POST_MAIL_MODE=off</p>` +
    `</div></body></html>`;

  return { subject, text, html, drafts, meta };
}
