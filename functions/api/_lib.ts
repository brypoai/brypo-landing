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

import { z } from "zod";

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

export const FORMAT_TYPES: FormatType[] = [
  "investor",
  "sns",
  "hiring",
  "customer",
  "internal",
];

export function isFormatType(s: unknown): s is FormatType {
  return (
    s === "investor" ||
    s === "sns" ||
    s === "hiring" ||
    s === "customer" ||
    s === "internal"
  );
}

// ---- per-format Zod schemas (ported from apps/web/lib/format-types.ts) -----
// All fields optional / defensive: a missing or shape-shifted field should
// degrade rendering, never crash it. One deliberate widening vs the app:
// customer.next_steps accepts string OR string[] (the shipped prompt said
// "2-3 sentences" while the shipped schema said array; /try prompts ask for
// an array but we tolerate both).

const InvestorSectionSchema = z.object({
  heading: z.string().optional(),
  body: z.string().optional(),
});

const SnsPostSchema = z.union([
  z.string(),
  z.object({ text: z.string().optional() }),
]);

const HiringEntrySchema = z.union([
  z.string(),
  z.object({
    title: z.string().optional(),
    description: z.string().optional(),
  }),
]);

export const InvestorContentSchema = z.object({
  subject: z.string().optional(),
  greeting: z.string().optional(),
  sections: z.array(InvestorSectionSchema).optional(),
  closing: z.string().optional(),
});

export const SnsContentSchema = z.object({
  hook: z.string().optional(),
  thread: z.array(SnsPostSchema).optional(),
});

export const HiringContentSchema = z.object({
  headline: z.string().optional(),
  mission_summary: z.string().optional(),
  team_culture: z.string().optional(),
  recent_milestones: z.array(HiringEntrySchema).optional(),
  open_roles: z.array(HiringEntrySchema).optional(),
  application_link: z.string().optional(),
});

export const CustomerContentSchema = z.object({
  update_title: z.string().optional(),
  since_last_update: z.string().optional(),
  highlights: z.array(z.string()).optional(),
  improvements: z.array(z.string()).optional(),
  known_issues: z.array(z.string()).optional(),
  next_steps: z.union([z.string(), z.array(z.string())]).optional(),
  cta: z.string().optional(),
});

export const InternalContentSchema = z.object({
  period_summary: z.string().optional(),
  key_events: z.array(z.string()).optional(),
  decisions: z.array(z.string()).optional(),
  open_questions: z.array(z.string()).optional(),
  action_items: z.array(z.string()).optional(),
});

export const CONTENT_SCHEMAS: Record<FormatType, z.ZodTypeAny> = {
  investor: InvestorContentSchema,
  sns: SnsContentSchema,
  hiring: HiringContentSchema,
  customer: CustomerContentSchema,
  internal: InternalContentSchema,
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

/** usage:YYYY-MM — monthly spend accumulator (UTC month). */
export function monthlyUsageKey(now: Date): string {
  return `usage:${now.toISOString().slice(0, 7)}`;
}

/** ip:{hash16}:{yyyymmddhh} — hourly per-IP counter (UTC hour). */
export function hourlyRateKey(ipHash16: string, now: Date): string {
  const hh = now.toISOString().slice(0, 13).replace(/[-T]/g, "");
  return `ip:${ipHash16}:${hh}`;
}
