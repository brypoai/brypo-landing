// functions/api/_postdraft.ts
//
// Pure helpers for GET /api/post-draft — the daily X post draft that the
// owner gets as a phone notification (docs/post-notify.md) and sees on /ops.
// No I/O and no env access, so scripts/test-postdraft.mjs can unit-test them
// under Node.
//
// Two deliberate constraints, both inherited from the product's own thesis
// (evidence-backed claims) and from the L0-1 decisions in PR #22/#23:
//
//   1. The prompt is built ONLY from first-party values we compute here —
//      the JST date, the KV counters, and our own previous drafts. No
//      third-party text (tweets, web pages, user input) ever reaches the
//      model, so this drafting path has no prompt-injection surface. That
//      is what makes it a different shape from the reply drafting removed
//      in #23, which read other people's posts.
//   2. Nothing here sends anything. The draft is displayed for the owner to
//      copy; the severed send path (#22) stays severed.
//
// Voice (2026-10-12, owner: 「人の感情がなくビジネス文書的」): the prompt asks
// for one honest moment with a feeling in it, in casual Japanese, and feeds
// the model the CHANGE since the last draft (a feeling needs something to
// react to; a running total read out every day is a report). Feelings and
// opinions are allowed; events the facts don't contain are not — the same
// line as brypo Studio's ANTI_FABRICATION / HUMAN_VOICE blocks.

// ---- constants -------------------------------------------------------------

/** Drafting model. Override per-deploy with POST_DRAFT_MODEL. */
export const POST_DRAFT_MODEL = "claude-opus-5";

// Claude Opus 5 pricing: $5/M input tokens, $25/M output tokens. Kept local
// rather than reusing _lib's INPUT/OUTPUT_USD_PER_MTOK — those are Haiku's,
// and charging Opus usage at Haiku rates would silently under-report against
// the shared DAILY_BUDGET_USD cap.
export const DRAFT_INPUT_USD_PER_MTOK = 5;
export const DRAFT_OUTPUT_USD_PER_MTOK = 25;

export const DRAFT_MAX_TOKENS = 1500;
export const DRAFT_TIMEOUT_MS = 45_000;

/** TTL for the cached draft and the small state keys below (60 days). */
export const DRAFT_TTL_S = 60 * 24 * 3600;

/** How many previous angles to feed back in as "don't repeat these". */
export const RECENT_LIMIT = 7;

/** X counts CJK as 2 units, so a Japanese post is capped at 140 characters. */
export const POST_CHAR_LIMIT = 140;

/**
 * Bump when the prompt changes: it is part of the cache key, so the day's
 * cached draft is regenerated once with the new prompt instead of serving
 * the old wording until midnight.
 */
export const DRAFT_PROMPT_VERSION = 2;

/** A post may carry the brypo.com/try link at most once per this many days. */
export const LINK_GAP_DAYS = 3;

// ---- KV keys ---------------------------------------------------------------

/** postdraft:v<N>:YYYY-MM-DD — one cached draft per JST day and prompt version. */
export function draftKey(jstDate: string): string {
  return `postdraft:v${DRAFT_PROMPT_VERSION}:${jstDate}`;
}

/** Rolling list of recent angles, so consecutive days don't repeat a theme. */
export const RECENT_KEY = "postdraft:recent";

/** The counters as of the last generated draft — the base for "since then". */
export const SNAPSHOT_KEY = "postdraft:snapshot";

/** JST date of the last draft that carried the brypo.com/try link. */
export const LAST_LINK_KEY = "postdraft:lastlink";

// ---- date ------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];

/** Japanese weekday of a YYYY-MM-DD date ("" when unparseable). Given to the
 *  model explicitly so it never has to work out the weekday itself. */
export function weekdayJa(date: string): string {
  if (!DATE_RE.test(date)) return "";
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? "" : WEEKDAYS_JA[d.getUTCDay()];
}

/** Whole days from `fromDate` to `toDate` (both YYYY-MM-DD), floored at 0. */
export function daysUntil(fromDate: string, toDate: string): number {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

// ---- cost ------------------------------------------------------------------

/** Estimated USD cost of one drafting call, at the drafting model's rates. */
export function computeDraftCostUsd(
  inputTokens: number,
  outputTokens: number,
): number {
  const inTok = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const outTok =
    Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  return (
    (inTok * DRAFT_INPUT_USD_PER_MTOK) / 1_000_000 +
    (outTok * DRAFT_OUTPUT_USD_PER_MTOK) / 1_000_000
  );
}

// ---- change since the last draft ---------------------------------------------

export interface StatsSnapshot {
  /** JST date of the draft the counters were read for. */
  date: string;
  unique: number;
  repeat: number;
}

export interface StatsDelta {
  /** JST date of the previous draft. */
  since: string;
  newUsers: number;
  newRepeat: number;
}

/** Parse the stored snapshot, tolerating absent/corrupt values. */
export function parseSnapshot(raw: string | null): StatsSnapshot | null {
  if (raw === null) return null;
  let o: any;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (o === null || typeof o !== "object" || !DATE_RE.test(o.date ?? "")) return null;
  const ok = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;
  if (!ok(o.unique) || !ok(o.repeat)) return null;
  return { date: o.date, unique: o.unique, repeat: o.repeat };
}

/**
 * Counters' change since the previous draft. null when there is nothing
 * honest to say: no previous snapshot, a snapshot from today (a same-day
 * regeneration), or counters that went DOWN (a reset — "-3 people" would
 * be a fabricated story).
 */
export function statsDelta(
  prev: StatsSnapshot | null,
  unique: number,
  repeat: number,
  today: string,
): StatsDelta | null {
  if (prev === null || prev.date >= today) return null;
  if (unique < prev.unique || repeat < prev.repeat) return null;
  return { since: prev.date, newUsers: unique - prev.unique, newRepeat: repeat - prev.repeat };
}

/** May today's post carry the brypo.com/try link? (once per LINK_GAP_DAYS) */
export function linkAllowed(lastLinkDate: string | null, today: string): boolean {
  if (lastLinkDate === null || !DATE_RE.test(lastLinkDate)) return true;
  return daysUntil(lastLinkDate, today) >= LINK_GAP_DAYS;
}

/** Does a draft carry the product link? Recorded so the next days skip it. */
export function mentionsLink(text: string): boolean {
  return /brypo\.com/i.test(text);
}

// ---- recent-angle ring -----------------------------------------------------

/** Parse the stored recent-angle list, tolerating absent/corrupt values. */
export function parseRecent(raw: string | null): string[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((s): s is string => typeof s === "string" && s.length > 0);
}

/** Newest-first list with `angle` prepended, de-duplicated, capped. */
export function nextRecent(
  recent: string[],
  angle: string,
  limit = RECENT_LIMIT,
): string[] {
  const head = angle.trim();
  const rest = recent.filter((a) => a.trim() !== head);
  return (head.length > 0 ? [head, ...rest] : rest).slice(0, limit);
}

// ---- draft shape -----------------------------------------------------------

export interface PostDraft {
  /** The post itself — Japanese, ready to paste into X. */
  text: string;
  /** One line on what this post is going for, shown under the draft. */
  angle: string;
}

/**
 * Validate a parsed model response into a PostDraft. Returns null on any
 * shape problem so the caller can surface a reason instead of rendering
 * half a draft. Length is checked generously (the UI shows the exact count
 * against POST_CHAR_LIMIT) — a slightly-long draft is still useful to trim
 * by hand, a 2000-character essay is not.
 */
export function toPostDraft(obj: Record<string, unknown> | null): PostDraft | null {
  if (obj === null) return null;
  const text = typeof obj.text === "string" ? obj.text.trim() : "";
  const angle = typeof obj.angle === "string" ? obj.angle.trim() : "";
  if (text.length === 0 || text.length > 400) return null;
  if (angle.length === 0 || angle.length > 200) return null;
  return { text, angle };
}

// ---- prompt ----------------------------------------------------------------

export interface DraftInputs {
  /** Today, JST (YYYY-MM-DD). */
  date: string;
  /** Lifetime unique /try users. */
  uniqueTryUsers: number;
  /** Lifetime repeat /try users. */
  repeatTryUsers: number;
  /** Change since the previous draft; null when there is none to report. */
  delta: StatsDelta | null;
  /** Whether today's post may carry the brypo.com/try link. */
  linkOk: boolean;
  /** Angles used on recent days, newest first. */
  recentAngles: string[];
}

/**
 * System prompt. Rules in English (one prompt to maintain, like _lib.ts);
 * the voice examples are Japanese because the voice is. The examples carry
 * no digits on purpose, so no example number can leak into a real post.
 */
export const DRAFT_SYSTEM_PROMPT = [
  "You draft one short X (Twitter) post a day for @kokibuilds, a solo developer in Japan who is building a product called Brypo in public.",
  "Each day the owner gets your draft on their phone, edits it if they want, and posts it themselves. Write it the way they would type it",
  "to fellow builders on their timeline — not the way a company announces things.",
  "",
  "Background on Brypo (most posts should not explain it): founders paste their raw notes and evidence, Brypo turns them into write-ups",
  "for different readers, and it flags any claim the evidence does not back. A free single-purpose version is live at brypo.com/try;",
  "the full product is not open yet.",
  "",
  "What makes a good post here:",
  "- One honest moment from someone building something alone: a small win, a worry, a doubt, something they noticed, a question to",
  "  other builders, or why they keep going.",
  "- It carries a feeling. Name it plainly (うれしい, ほっとした, 悔しい, こわい, 焦る, 迷ってる, 楽しい, 地味にうれしい …) or let it show",
  "  through the words. A post with no feeling in it has failed, however accurate it is. Keep the feeling at its real size:",
  "  small and plain beats dramatic.",
  "- Short: two to four short sentences, roughly 60–120 Japanese characters. Line breaks are fine; a thought can stay a little unfinished.",
  "- Change the shape from day to day: a reaction to the numbers, an inner voice, a question, a quiet hope, a one-liner.",
  "",
  "Honesty (Brypo's whole idea is \"don't claim what you can't back\", so its founder's posts must hold to it):",
  "- Numbers: only the numbers in the facts list, written the way a person says them (e.g. 〇人), never as metrics or rates.",
  "- Do not say that something happened unless the facts say it: no shipped features, fixed bugs, late nights, conversations with users,",
  "  or plans the facts don't mention. If the numbers did not change, don't imply they did.",
  "- Feelings, opinions, doubts, hopes and questions are fine. They are the owner's voice, and the owner reads every draft before posting.",
  "",
  "Japanese voice:",
  "- Casual plain form (〜した / 〜だ / 〜かも / 〜なのかな). No です・ます, no 敬語. Mostly leave out the first person; when one is needed, use 自分.",
  "- Never use business or press-release wording, e.g. 本日, 〜いたしました, 〜となります, 〜を実現, 〜を提供, 〜を目指します, ご活用, ぜひ,",
  "  皆様, ユーザー様, ユーザー数, 価値, ソリューション, サービス, 機能, KPI, 指標, リピート率, チェックポイント, 検証, 引き続き, いかがでしたか,",
  "  まとめると, or English buzzwords. Say 使ってくれた人, not ユーザー.",
  "- At most one 「！」, at most one emoji (usually none), and no hashtag unless it truly fits (never more than one).",
  "- No call to action and no engagement bait (フォローしてね, いいねで応援, 「〜な人いる？」 as a hook).",
  "- Include brypo.com/try only when the facts say a link is OK today and the post is about trying it. Otherwise, no link.",
  "",
  "Voice examples — for tone only. They are about other days: never reuse their facts or their wording.",
  "- 使ってくれた人が、また一人増えてた。知らない誰かが触ってくれたと思うと、素直にうれしい。",
  "- 今日は増えてなかった。わかってはいるけど、ちょっとだけ期待してた。",
  "- 盛った数字を書きたくなる気持ち、正直わかる。だから書いたことを証拠と照らし合わせる道具を作ってる。たぶん自分が一番ほしい。",
  "- 進捗を見せるとき、みんなどこまで正直に書いてるんだろう。自分はまだ、小さい数字を出すのがちょっとこわい。",
  "- まだ小さすぎて書くことがない気がする日。でも小さいころの記録って、あとで一番読み返しそう。",
  "",
  "OUTPUT LANGUAGE: Japanese.",
  "",
  "Return a single JSON object and nothing else, in this exact shape:",
  '{"text": "<the post, Japanese, at most 140 characters>", "angle": "<one short Japanese line on which feeling or shape this post is going for>"}',
].join("\n");

/** User message — first-party values only (see the file header). */
export function buildDraftUserMessage(inputs: DraftInputs): string {
  const wd = weekdayJa(inputs.date);
  const lines = [
    `Today (JST): ${inputs.date}${wd ? ` (${wd})` : ""}`,
    "",
    "Facts — the only numbers that exist:",
    `- People who have tried brypo.com/try so far: ${inputs.uniqueTryUsers}`,
    `- Of those, people who came back on a later day: ${inputs.repeatTryUsers}`,
  ];
  const d = inputs.delta;
  if (d !== null) {
    lines.push(
      d.newUsers === 0 && d.newRepeat === 0
        ? `- Since the last draft (${d.since}): no change.`
        : `- Since the last draft (${d.since}): ${d.newUsers} new ${d.newUsers === 1 ? "person" : "people"} tried it; ${d.newRepeat} more came back.`,
    );
  }
  lines.push(
    "- brypo.com/try is free to use; the full product is not open yet (waitlist on brypo.com).",
    inputs.linkOk
      ? `- Link today: OK (no link in the last ${LINK_GAP_DAYS} days).`
      : "- Link today: no — a recent post already had one, so keep this one link-free.",
    "",
  );
  if (inputs.recentAngles.length > 0) {
    lines.push("Angles used on recent days — choose a different feeling or shape today:");
    for (const angle of inputs.recentAngles) lines.push(`- ${angle}`);
  } else {
    lines.push("No posts drafted yet — this is the first one.");
  }
  lines.push("", "Return the JSON object.");
  return lines.join("\n");
}
