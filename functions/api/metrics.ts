// functions/api/metrics.ts
//
// GET /api/metrics — owner-only distribution snapshot (D-1, docs/18 §3 "Track
// D"). Read-only: X follower count (via the existing OAuth1 verify path,
// extended with user.fields=public_metrics) + the /try KV counters + the
// waitlist signup count from the Tally API. Gated by PUBLISH_TOKEN, exactly
// like /api/publish.
//
// Waitlist: the LP embeds a Tally.so form (dWQlbq) with no repo-side
// backend/DB/KV (docs/18 §9.2). When TALLY_API_KEY is set, the count is
// fetched from the Tally API (GET /forms/{id}/submissions →
// totalNumberOfSubmissionsPerFilter.all); when unset or failing, waitlist is
// null and the log line renders a fill-by-hand marker instead.
//
// Consume with scripts/metrics-snapshot.mjs, which prints a ready-to-paste
// docs/METRICS_LOG.md row — or let the brypo repo's weekly
// metrics-snapshot.yml Actions workflow do it unattended.

import { buildOAuth1Header, timingSafeEqual } from "./_publish";
import type { OAuth1Creds } from "./_publish";
import { dailyUsageKey, publishUsageKey } from "./_lib";
import { buildMetricsLogLine } from "./_metrics";
import type { MetricsSnapshot } from "./_metrics";

interface Env {
  PUBLISH_TOKEN?: string;
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_TOKEN_SECRET?: string;
  // Tally API key (Tally → Settings → API keys). Optional: unset → waitlist
  // stays a manual cell. Read-only usage (submission counts only).
  TALLY_API_KEY?: string;
  // Tally form id of the LP waitlist. Optional; defaults to dWQlbq (the form
  // embedded in index.html).
  TALLY_FORM_ID?: string;
  // Shared with /try and /api/publish (counter keys usage:/publish:YYYY-MM-DD).
  TRY_KV?: KVNamespace;
}

/** Form id of the waitlist Tally embed in index.html (data-tally-open). */
const DEFAULT_TALLY_FORM_ID = "dWQlbq";

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

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Fetch the authenticated account's follower count. Reuses the verify path's
 * GET /2/users/me, adding user.fields=public_metrics — the query param is
 * folded into the OAuth signature base string (RFC 5849) but stays off the
 * Authorization header. Never throws: failures become a null count + reason so
 * the snapshot is still useful (e.g. the /try counters still come through).
 */
async function fetchXFollowers(
  creds: OAuth1Creds,
): Promise<MetricsSnapshot["x"]> {
  const base = "https://api.twitter.com/2/users/me";
  const query = { "user.fields": "public_metrics" };
  const url = `${base}?user.fields=public_metrics`;
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const timestamp = Math.floor(Date.now() / 1000);
  const auth = await buildOAuth1Header("GET", base, creds, nonce, timestamp, query);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { followers: null, handle: null, error: "network error or timeout" };
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON — handled below */
  }
  if (!res.ok) {
    const upstream =
      (data && (data.title || data.detail || data.error)) || `X API returned ${res.status}`;
    return { followers: null, handle: null, error: String(upstream).slice(0, 120) };
  }
  const handle = typeof data?.data?.username === "string" ? data.data.username : null;
  const followers =
    typeof data?.data?.public_metrics?.followers_count === "number"
      ? data.data.public_metrics.followers_count
      : null;
  return {
    followers,
    handle,
    error: followers === null ? "followers_count absent in response" : undefined,
  };
}

/**
 * Fetch the waitlist signup count from the Tally API. Never throws: any
 * failure (bad key, network, unexpected shape) returns null so the rest of
 * the snapshot still comes through and the log line falls back to the
 * fill-by-hand marker. Count = totalNumberOfSubmissionsPerFilter.all
 * (completed + partial), with totalNumberOfSubmissions as a shape fallback.
 */
async function fetchTallyWaitlist(
  apiKey: string,
  formId: string,
): Promise<number | null> {
  let res: Response;
  try {
    res = await fetch(
      `https://api.tally.so/forms/${encodeURIComponent(formId)}/submissions?page=1`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  const n =
    data?.totalNumberOfSubmissionsPerFilter?.all ??
    data?.totalNumberOfSubmissions ??
    null;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

async function readKvNumber(kv: KVNamespace | undefined, key: string): Promise<number> {
  if (!kv) return 0;
  const raw = await kv.get(key);
  const n = raw === null ? 0 : Number(raw);
  return Number.isFinite(n) ? n : 0;
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

  const haveX =
    !!env.X_API_KEY && !!env.X_API_SECRET && !!env.X_ACCESS_TOKEN && !!env.X_ACCESS_TOKEN_SECRET;

  // The three sources are independent — fetch them concurrently.
  const [x, waitlist, publishCountToday, spendUsdToday] = await Promise.all([
    haveX
      ? fetchXFollowers({
          consumerKey: env.X_API_KEY!,
          consumerSecret: env.X_API_SECRET!,
          accessToken: env.X_ACCESS_TOKEN!,
          accessTokenSecret: env.X_ACCESS_TOKEN_SECRET!,
        })
      : Promise.resolve<MetricsSnapshot["x"]>({
          followers: null,
          handle: null,
          error: "X_* credentials not set",
        }),
    env.TALLY_API_KEY
      ? fetchTallyWaitlist(env.TALLY_API_KEY, env.TALLY_FORM_ID || DEFAULT_TALLY_FORM_ID)
      : Promise.resolve<number | null>(null),
    readKvNumber(env.TRY_KV, publishUsageKey(now)),
    readKvNumber(env.TRY_KV, dailyUsageKey(now)),
  ]);

  const snapshot: MetricsSnapshot = {
    date: now.toISOString().slice(0, 10),
    x,
    try: { publishCountToday, spendUsdToday },
    waitlist,
  };

  const notes = [
    "spendUsdToday is /try LLM spend (USD), not a generation count; no per-request /try counter exists",
  ];
  if (waitlist === null) {
    notes.unshift(
      env.TALLY_API_KEY
        ? "Tally fetch failed — waitlist is a manual cell this run; check TALLY_API_KEY / form id (docs/18 §9.2)"
        : "TALLY_API_KEY not set — waitlist is a manual cell; add the key in Cloudflare Pages to automate it (docs/18 §9.2)",
    );
  }

  return json(
    {
      ...snapshot,
      // Ready-to-paste docs/METRICS_LOG.md row.
      logLine: buildMetricsLogLine(snapshot),
      notes,
    },
    200,
  );
}

// Pages Functions dispatch: GET only, 405 otherwise (mirrors publish.ts).
export async function onRequest(context: PagesContext): Promise<Response> {
  if (context.request.method === "GET") return handleGet(context);
  return json({ error: "Use GET.", code: "method_not_allowed" }, 405);
}
