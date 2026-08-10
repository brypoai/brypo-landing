// functions/api/post-draft.ts
//
// GET /api/post-draft — owner-only daily X post draft for the /ops board.
// Gated by PUBLISH_TOKEN, exactly like /api/metrics and /api/x-reply/digest.
//
// One generation per JST day, cached in KV: the first /ops load of the day
// pays for the call, every later load that day reads the cache. The draft is
// DISPLAYED ONLY — there is no send path here (the /2/tweets path stays
// severed per PR #22), and nothing but our own first-party values reaches the
// model (see the _postdraft.ts header for why that matters).
//
// Expected-unavailable states (no API key, no KV, budget exhausted) return
// 200 with { text: null, reason } so /ops can print one honest line instead
// of an empty box. Real failures (bad token, upstream error) use status codes.

import { timingSafeEqual } from "./_publish";
import { jstDateKey, dailyUsageKey, parseJsonObject, TRY_USERS_REPEAT_KEY, TRY_USERS_TOTAL_KEY } from "./_lib";
import {
  DRAFT_MAX_TOKENS,
  DRAFT_SYSTEM_PROMPT,
  DRAFT_TIMEOUT_MS,
  DRAFT_TTL_S,
  L01_END,
  POST_DRAFT_MODEL,
  RECENT_KEY,
  buildDraftUserMessage,
  computeDraftCostUsd,
  daysUntil,
  draftKey,
  nextRecent,
  parseRecent,
  toPostDraft,
} from "./_postdraft";
import type { PostDraft } from "./_postdraft";

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface Env {
  PUBLISH_TOKEN?: string;
  // Shared with /try and /api/x-reply — same key, same $50/mo cap.
  ANTHROPIC_API_KEY_TRY?: string;
  // Optional per-deploy model override (mirrors X_REPLY_MODEL).
  POST_DRAFT_MODEL?: string;
  // Shared daily spend cap (UTC day), same value /try enforces.
  DAILY_BUDGET_USD?: string;
  TRY_KV?: KVNamespace;
}

interface PagesContext {
  request: Request;
  env: Env;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** An expected-unavailable answer: 200 so /ops renders the reason inline. */
function unavailable(date: string, reason: string): Response {
  return json({ date, text: null, angle: null, cached: false, reason }, 200);
}

async function readKvNumber(kv: KVNamespace, key: string): Promise<number> {
  const raw = await kv.get(key);
  const n = raw === null ? 0 : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Drafting call. Never throws — failures come back as a reason string. */
async function generateDraft(
  apiKey: string,
  model: string,
  system: string,
  userMessage: string,
): Promise<
  { ok: true; draft: PostDraft; inputTokens: number; outputTokens: number } | { ok: false; reason: string }
> {
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: DRAFT_MAX_TOKENS,
        // Adaptive thinking is on by default on this model and max_tokens caps
        // thinking + text together, hence the headroom above. Low effort keeps
        // a once-a-day one-paragraph task fast and cheap.
        output_config: { effort: "low" },
        system,
        messages: [{ role: "user", content: userMessage }],
      }),
      signal: AbortSignal.timeout(DRAFT_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "Anthropic API: network error or timeout" };
  }
  if (!res.ok) {
    return { ok: false, reason: `Anthropic API returned ${res.status}` };
  }
  let data: any;
  try {
    data = await res.json();
  } catch {
    return { ok: false, reason: "Anthropic API returned non-JSON" };
  }
  const textBlock = Array.isArray(data?.content)
    ? data.content.find((b: any) => b?.type === "text")
    : null;
  const raw = typeof textBlock?.text === "string" ? textBlock.text : "";
  const draft = toPostDraft(parseJsonObject(raw));
  if (draft === null) {
    return { ok: false, reason: "draft JSON was missing or malformed" };
  }
  return {
    ok: true,
    draft,
    inputTokens: typeof data?.usage?.input_tokens === "number" ? data.usage.input_tokens : 0,
    outputTokens: typeof data?.usage?.output_tokens === "number" ? data.usage.output_tokens : 0,
  };
}

async function handleGet(context: PagesContext): Promise<Response> {
  const { request, env } = context;

  // Owner token gate (constant-time; fails closed when the token is unset).
  const provided = request.headers.get("X-Publish-Token") ?? "";
  const expected = env.PUBLISH_TOKEN ?? "";
  if (expected.length === 0 || !timingSafeEqual(provided, expected)) {
    return json({ error: "Invalid or missing publish token.", code: "unauthorized" }, 401);
  }

  const now = new Date();
  const date = jstDateKey(now);
  const kv = env.TRY_KV;

  if (!kv) {
    return unavailable(date, "TRY_KV is not bound — drafts are cached in KV.");
  }

  // 1. Today's draft already generated? Serve it and spend nothing.
  const cachedRaw = await kv.get(draftKey(date));
  const cached = toPostDraft(parseJsonObject(cachedRaw ?? ""));
  if (cached !== null) {
    return json({ date, text: cached.text, angle: cached.angle, cached: true, model: null }, 200);
  }

  const apiKey = env.ANTHROPIC_API_KEY_TRY;
  if (!apiKey) {
    return unavailable(date, "ANTHROPIC_API_KEY_TRY is not set.");
  }

  // 2. Shared daily budget gate (UTC day), the same cap /try enforces. KV
  //    failures here fail CLOSED — unlike /try, skipping the gate would spend
  //    against a cap we could not read, and a missing draft costs nothing.
  const budget = (() => {
    const n = parseFloat(env.DAILY_BUDGET_USD ?? "5");
    return Number.isFinite(n) && n > 0 ? n : 5;
  })();
  const spent = await readKvNumber(kv, dailyUsageKey(now));
  if (spent >= budget) {
    return unavailable(date, "今日の予算上限に達しました（UTC日でリセット）");
  }

  // 3. Draft from first-party values only.
  const [uniqueTryUsers, repeatTryUsers, recentRaw] = await Promise.all([
    readKvNumber(kv, TRY_USERS_TOTAL_KEY),
    readKvNumber(kv, TRY_USERS_REPEAT_KEY),
    kv.get(RECENT_KEY),
  ]);
  const recentAngles = parseRecent(recentRaw);
  const model = env.POST_DRAFT_MODEL || POST_DRAFT_MODEL;

  const result = await generateDraft(
    apiKey,
    model,
    DRAFT_SYSTEM_PROMPT,
    buildDraftUserMessage({
      date,
      daysLeft: daysUntil(date, L01_END),
      uniqueTryUsers,
      repeatTryUsers,
      recentAngles,
    }),
  );
  if (!result.ok) {
    return json({ error: result.reason, code: "draft_failed" }, 502);
  }

  // 4. Cache the day's draft, remember the angle, and book the spend against
  //    the shared counter. A rare concurrent first-load-of-the-day can draft
  //    twice; the second write simply wins.
  const { draft } = result;
  await Promise.all([
    kv.put(draftKey(date), JSON.stringify(draft), { expirationTtl: DRAFT_TTL_S }),
    kv.put(RECENT_KEY, JSON.stringify(nextRecent(recentAngles, draft.angle)), {
      expirationTtl: DRAFT_TTL_S,
    }),
    kv.put(
      dailyUsageKey(now),
      String(spent + computeDraftCostUsd(result.inputTokens, result.outputTokens)),
      { expirationTtl: 3 * 24 * 3600 },
    ),
  ]);

  return json({ date, text: draft.text, angle: draft.angle, cached: false, model }, 200);
}

// Pages Functions dispatch: GET only, 405 otherwise (mirrors metrics.ts).
export async function onRequest(context: PagesContext): Promise<Response> {
  if (context.request.method === "GET") return handleGet(context);
  return json({ error: "Use GET.", code: "method_not_allowed" }, 405);
}
