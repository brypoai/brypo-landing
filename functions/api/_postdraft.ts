// functions/api/_postdraft.ts
//
// Pure helpers for GET /api/post-draft — the daily X post draft shown on
// /ops (L0-1「今日の実行」の「投稿した」を埋めるための文案)。No I/O and no env
// access, so scripts/test-postdraft.mjs can unit-test them under Node.
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

/** Cached draft TTL — must outlive the 2026-09-07 L0-1 gate. */
export const DRAFT_TTL_S = 60 * 24 * 3600;

/** How many previous angles to feed back in as "don't repeat these". */
export const RECENT_LIMIT = 7;

/** X counts CJK as 2 units, so a Japanese post is capped at 140 characters. */
export const POST_CHAR_LIMIT = 140;

/** L0-1 exit date (JST). */
export const L01_END = "2026-09-07";

// ---- KV keys ---------------------------------------------------------------

/** postdraft:YYYY-MM-DD — one cached draft per JST day. */
export function draftKey(jstDate: string): string {
  return `postdraft:${jstDate}`;
}

/** Rolling list of recent angles, so consecutive days don't repeat a theme. */
export const RECENT_KEY = "postdraft:recent";

// ---- date ------------------------------------------------------------------

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
  /** Days left until the L0-1 exit gate. */
  daysLeft: number;
  /** Lifetime unique /try users (an L0-1 exit metric). */
  uniqueTryUsers: number;
  /** Lifetime repeat /try users (an L0-1 exit metric). */
  repeatTryUsers: number;
  /** Angles used on recent days, newest first. */
  recentAngles: string[];
}

/**
 * System prompt. Authored in English with an explicit output-language
 * directive — the same technique _lib.ts uses for the /try formats, so we
 * maintain one prompt rather than a translated pair.
 */
export const DRAFT_SYSTEM_PROMPT = [
  "You draft one short X (Twitter) post per day for @kokibuilds, a solo founder building in public.",
  "",
  "The product is Brypo (brypo.com): founders paste their raw notes and evidence, and it produces",
  "stakeholder-specific write-ups (investor update, X thread, hiring post, customer note, internal memo),",
  "then cross-checks every claim against the pasted evidence and flags the ones nothing backs up.",
  "A free single-purpose version is live at brypo.com/try. The product's whole thesis is that a claim",
  "without evidence behind it is worth flagging.",
  "",
  "Because that is the thesis, the post must hold to it:",
  "- Use ONLY the facts given in the user message. Every number you write must be one of those numbers.",
  "- Never invent metrics, revenue, funding, customer names, testimonials, launches, or milestones.",
  "- If the given numbers are small, say them plainly or leave them out. Do not dress them up.",
  "- No growth-hack bait, no fake urgency, no thread-teasers, no hashtag stuffing (at most one hashtag).",
  "",
  "Write something a working founder would actually stop to read: a concrete thing built, learned,",
  "broken, or decided today — the specific over the general. Vary the shape day to day.",
  "",
  "OUTPUT LANGUAGE: Japanese. Write the post in natural Japanese as this founder would type it.",
  "",
  "Return a single JSON object and nothing else, in this exact shape:",
  '{"text": "<the post, Japanese, at most 140 characters>", "angle": "<one short Japanese line on what this post is going for>"}',
].join("\n");

/** User message — first-party values only (see the file header). */
export function buildDraftUserMessage(inputs: DraftInputs): string {
  const lines = [
    `Today (JST): ${inputs.date}`,
    `Days left until the 2026-09-07 checkpoint: ${inputs.daysLeft}`,
    "",
    "Facts you may use (these are the only numbers that exist):",
    `- Unique people who have used brypo.com/try so far: ${inputs.uniqueTryUsers}`,
    `- Of those, people who came back on a later day: ${inputs.repeatTryUsers}`,
    "- brypo.com/try is live and free; the full product is not open yet (waitlist on brypo.com).",
    "",
  ];
  if (inputs.recentAngles.length > 0) {
    lines.push("Angles already used on recent days — pick a different one today:");
    for (const angle of inputs.recentAngles) lines.push(`- ${angle}`);
  } else {
    lines.push("No posts drafted yet — this is the first one.");
  }
  lines.push("", "Return the JSON object.");
  return lines.join("\n");
}
