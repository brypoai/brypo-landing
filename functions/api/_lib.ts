/**
 * functions/api/_lib.ts
 *
 * Pure helpers for the /try mini-tool backend (no I/O, no env access).
 * Kept side-effect-free so scripts/test-crosscheck.mjs can unit-test them
 * directly under Node (type-stripped import) without a Workers runtime.
 *
 * Content shapes are ported from apps/web/lib/format-types.ts in the app
 * repo (the shipped per-format Zod schemas); the sanitize pipeline mirrors
 * runL2OcrCrossCheck in supabase/functions/format-render/index.ts.
 */

// ---- constants -------------------------------------------------------------

export const MODEL = "claude-haiku-4-5-20251001";
export const MAX_INPUT_CHARS = 12000;
export const HOURLY_IP_LIMIT = 60;
export const GENERATION_MAX_TOKENS = 4096;
export const CROSS_CHECK_MAX_TOKENS = 2048;

// Haiku 4.5 pricing: $1/M input tokens, $5/M output tokens.
export const INPUT_USD_PER_MTOK = 1;
export const OUTPUT_USD_PER_MTOK = 5;

// ---- format types (ported from apps/web/lib/format-types.ts) ---------------

export type FormatType = "investor" | "sns" | "hiring" | "customer" | "internal";

export function isFormatType(s: unknown): s is FormatType {
  return (
    s === "investor" ||
    s === "sns" ||
    s === "hiring" ||
    s === "customer" ||
    s === "internal"
  );
}

// ---- per-format validators (ported from apps/web/lib/format-types.ts) ------
// Dependency-free replacements for the shipped per-format Zod schemas. The
// static landing repo has no build step, so Cloudflare Pages bundles the
// Function without running `npm install` — a bare `import "zod"` cannot be
// resolved at deploy time. These validators reproduce the same semantics:
//
//   - every field is OPTIONAL: absent / undefined is fine and omitted from
//     the result (mirrors Zod `.optional()`)
//   - a PRESENT field with the wrong type (including null) fails the WHOLE
//     object, so malformed output falls through to the content_raw /
//     schema_fallback path exactly as before (Zod would `safeParse` false)
//   - unknown keys are stripped (Zod default strip mode), so wrapped /
//     misnamed output normalizes to {} and the caller's emptiness check
//     routes it to the raw fallback
//   - sub-element unions are preserved: SnsPost = string | { text? },
//     HiringEntry = string | { title?, description? }
//   - one deliberate widening vs the app: customer.next_steps accepts
//     string OR string[] (the shipped prompt said "2-3 sentences" while the
//     shipped schema said array; /try prompts ask for an array, we tolerate
//     both)

export type ContentResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false };

// Thrown internally when a present field has the wrong type; caught at the
// validator boundary and turned into { ok: false } (the Zod-fail equivalent).
class SchemaError extends Error {}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  throw new SchemaError();
}

function asPlainObject(v: unknown): Record<string, unknown> {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  throw new SchemaError();
}

// Optional string: undefined stays undefined; any other non-string throws.
function optString(v: unknown): string | undefined {
  return v === undefined ? undefined : asString(v);
}

// Optional array whose elements are validated by `item`; non-array throws.
function optArray<T>(v: unknown, item: (x: unknown) => T): T[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new SchemaError();
  return v.map(item);
}

// Assign a validated optional value onto the output only when present, so
// the result contains exactly the keys the input had (Zod strip parity).
function put(out: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) out[key] = value;
}

// SnsPost union: string | { text? }
function snsPost(v: unknown): string | { text?: string } {
  if (typeof v === "string") return v;
  const o = asPlainObject(v);
  const out: { text?: string } = {};
  put(out, "text", optString(o.text));
  return out;
}

// HiringEntry union: string | { title?, description? }
function hiringEntry(v: unknown): string | { title?: string; description?: string } {
  if (typeof v === "string") return v;
  const o = asPlainObject(v);
  const out: { title?: string; description?: string } = {};
  put(out, "title", optString(o.title));
  put(out, "description", optString(o.description));
  return out;
}

// InvestorSection: { heading?, body? } (must be an object, never a bare string)
function investorSection(v: unknown): { heading?: string; body?: string } {
  const o = asPlainObject(v);
  const out: { heading?: string; body?: string } = {};
  put(out, "heading", optString(o.heading));
  put(out, "body", optString(o.body));
  return out;
}

function validate(
  input: unknown,
  build: (o: Record<string, unknown>, out: Record<string, unknown>) => void,
): ContentResult {
  try {
    const o = asPlainObject(input);
    const out: Record<string, unknown> = {};
    build(o, out);
    return { ok: true, value: out };
  } catch (err) {
    if (err instanceof SchemaError) return { ok: false };
    throw err;
  }
}

export type ContentValidator = (input: unknown) => ContentResult;

export const CONTENT_VALIDATORS: Record<FormatType, ContentValidator> = {
  investor: (input) =>
    validate(input, (o, out) => {
      put(out, "subject", optString(o.subject));
      put(out, "greeting", optString(o.greeting));
      put(out, "sections", optArray(o.sections, investorSection));
      put(out, "closing", optString(o.closing));
    }),
  sns: (input) =>
    validate(input, (o, out) => {
      put(out, "hook", optString(o.hook));
      put(out, "thread", optArray(o.thread, snsPost));
    }),
  hiring: (input) =>
    validate(input, (o, out) => {
      put(out, "headline", optString(o.headline));
      put(out, "mission_summary", optString(o.mission_summary));
      put(out, "team_culture", optString(o.team_culture));
      put(out, "recent_milestones", optArray(o.recent_milestones, hiringEntry));
      put(out, "open_roles", optArray(o.open_roles, hiringEntry));
      put(out, "application_link", optString(o.application_link));
    }),
  customer: (input) =>
    validate(input, (o, out) => {
      put(out, "update_title", optString(o.update_title));
      put(out, "since_last_update", optString(o.since_last_update));
      put(out, "highlights", optArray(o.highlights, asString));
      put(out, "improvements", optArray(o.improvements, asString));
      put(out, "known_issues", optArray(o.known_issues, asString));
      // next_steps: string OR string[] (deliberate widening — see header).
      if (o.next_steps !== undefined) {
        out.next_steps =
          typeof o.next_steps === "string"
            ? o.next_steps
            : optArray(o.next_steps, asString);
      }
      put(out, "cta", optString(o.cta));
    }),
  internal: (input) =>
    validate(input, (o, out) => {
      put(out, "period_summary", optString(o.period_summary));
      put(out, "key_events", optArray(o.key_events, asString));
      put(out, "decisions", optArray(o.decisions, asString));
      put(out, "open_questions", optArray(o.open_questions, asString));
      put(out, "action_items", optArray(o.action_items, asString));
    }),
};

// ---- LLM output parsing (mirrors format-render/index.ts helpers) -----------

/** Strip a leading/trailing markdown code fence from LLM output. */
export function stripFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

/**
 * Fence-strip + JSON.parse + plain-object check. Returns null on any
 * failure (caller decides the degradation path — never throws).
 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

// ---- content flattening (adapted from extractTextParagraphs) ---------------

// Strings shorter than this are usually schema artefacts (labels, "USD")
// that add noise to the cross-check without adding signal.
const FLATTEN_MIN_CHARS = 8;
const FLATTEN_MAX_FIELDS = 60;

/**
 * Walk generated content collecting every non-empty string leaf, in
 * document order, joined into one newline-separated text. This is the
 * OUTPUT TEXT handed to the cross-check call, and the reference text
 * for the verbatim claim guard in sanitizeFlags.
 */
export function flattenContentStrings(content: unknown): string {
  const out: string[] = [];
  const visit = (node: unknown) => {
    if (out.length >= FLATTEN_MAX_FIELDS) return;
    if (typeof node === "string") {
      const trimmed = node.trim();
      if (trimmed.length >= FLATTEN_MIN_CHARS) out.push(trimmed);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === "_meta") continue;
        visit(v);
      }
    }
  };
  visit(content);
  return out.join("\n");
}

// ---- cross-check flag sanitizing (mirrors runL2OcrCrossCheck) --------------

export type FlagVerdict = "contradicted" | "unsupported";
export type FlagKind =
  | "number"
  | "name"
  | "date"
  | "metric"
  | "event"
  | "quote"
  | "other";
export type FlagConfidence = "high" | "medium" | "low";

export interface CrossCheckFlag {
  claim_text: string;
  verdict: FlagVerdict;
  kind: FlagKind;
  reason: string;
  confidence: FlagConfidence;
}

export interface SanitizedFlags {
  flags: CrossCheckFlag[];
  cross_check_skipped: boolean;
  skip_reason: string | null;
}

const VALID_VERDICTS = new Set(["contradicted", "unsupported"]);
const VALID_KINDS = new Set([
  "number",
  "name",
  "date",
  "metric",
  "event",
  "quote",
  "other",
]);
const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);
const MAX_FLAGS = 20;
const MAX_CLAIM_CHARS = 300;

/**
 * Sanitize the raw cross-check LLM output against the flattened OUTPUT
 * TEXT. Same posture as runL2OcrCrossCheck: the check must never block a
 * result — any malformed output degrades to "skipped", and each flag is
 * kept only if its claim_text appears VERBATIM in the flattened text
 * (hallucination guard; the L2 equivalent dropped unknown locations).
 */
export function sanitizeFlags(
  rawText: string,
  flattenedText: string,
): SanitizedFlags {
  const parsed = parseJsonObject(rawText);
  if (parsed === null) {
    return {
      flags: [],
      cross_check_skipped: true,
      skip_reason: "llm_output_not_json_object",
    };
  }
  const rawFlags = parsed.flags;
  if (!Array.isArray(rawFlags)) {
    return {
      flags: [],
      cross_check_skipped: true,
      skip_reason: "llm_output_missing_flags_array",
    };
  }

  const flags: CrossCheckFlag[] = [];
  for (const f of rawFlags) {
    if (flags.length >= MAX_FLAGS) break;
    if (typeof f !== "object" || f === null) continue;
    const o = f as Record<string, unknown>;

    const claim = typeof o.claim_text === "string" ? o.claim_text.trim() : "";
    if (claim.length === 0 || claim.length > MAX_CLAIM_CHARS) continue;
    // Verbatim guard: drop any flag whose claim does not appear exactly
    // in the generated text — the model echoing a paraphrase is the
    // cross-check hallucinating.
    if (!flattenedText.includes(claim)) continue;

    const verdict =
      typeof o.verdict === "string" && VALID_VERDICTS.has(o.verdict)
        ? (o.verdict as FlagVerdict)
        : null;
    if (verdict === null) continue;

    const kind =
      typeof o.kind === "string" && VALID_KINDS.has(o.kind)
        ? (o.kind as FlagKind)
        : "other";
    const confidence =
      typeof o.confidence === "string" && VALID_CONFIDENCE.has(o.confidence)
        ? (o.confidence as FlagConfidence)
        : "low";
    const reason = typeof o.reason === "string" && o.reason.length > 0
      ? o.reason.slice(0, 500)
      : "(no reason given)";

    flags.push({ claim_text: claim, verdict, kind, reason, confidence });
  }

  return { flags, cross_check_skipped: false, skip_reason: null };
}

/**
 * Build the cross-check user message. Lives here (not in the handler) so
 * the tuning harness (scripts/test-crosscheck.mjs) exercises the exact
 * shipped string — a drifted copy would silently stop testing production.
 */
export function buildCrossCheckUserMessage(
  sourceText: string,
  outputText: string,
): string {
  return (
    `SOURCE TEXT (ground truth — the founder's pasted notes):\n` +
    `<<<\n${sourceText}\n>>>\n\n` +
    `OUTPUT TEXT (generated document to check):\n` +
    `<<<\n${outputText}\n>>>\n\n` +
    `Return the flags JSON object.`
  );
}

// ---- cost ------------------------------------------------------------------

/** Estimated cost in USD for one Anthropic call's token usage. */
export function computeCostUsd(
  inputTokens: number,
  outputTokens: number,
): number {
  const inTok = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const outTok = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  return (
    (inTok * INPUT_USD_PER_MTOK) / 1_000_000 +
    (outTok * OUTPUT_USD_PER_MTOK) / 1_000_000
  );
}

// ---- KV key builders (UTC) --------------------------------------------------

/** usage:YYYY-MM-DD — daily spend accumulator (UTC day). */
export function dailyUsageKey(now: Date): string {
  return `usage:${now.toISOString().slice(0, 10)}`;
}

/** ip:{hash16}:{yyyymmddhh} — hourly per-IP counter (UTC hour). */
export function hourlyRateKey(ipHash16: string, now: Date): string {
  const hh = now.toISOString().slice(0, 13).replace(/[-T]/g, "");
  return `ip:${ipHash16}:${hh}`;
}
