/**
 * functions/api/publish.ts
 *
 * POST /api/publish — push one generated /try format to live channels.
 *
 * SECURITY: /try is a public, no-login tool. Publishing to a real account is
 * an irreversible outward action, so this endpoint is NOT public: every
 * request must carry the owner token (X-Publish-Token header or body.token)
 * matching the PUBLISH_TOKEN secret. Without it the endpoint 401s. This is the
 * gate that keeps a random brypo.com/try visitor from posting as @brypoai.
 *
 * Channels:
 *   - "x"       native X (Twitter) API v2, OAuth 1.0a user context. The
 *               content is flowed into a numbered thread; each tweet after the
 *               first replies to the previous one.
 *   - "webhook" POST the plaintext + structured content to PUBLISH_WEBHOOK_URL.
 *               This is the bridge to platforms without a usable write API
 *               (note, LinkedIn) or that need a separate media pipeline
 *               (TikTok, YouTube): point the webhook at Zapier / Make / n8n.
 *
 * Privacy/logging: like try-generate, the only log line is content-free
 * metadata { action:"publish", status, channels, ms }. Generated text and the
 * token are never logged.
 */

import { isFormatType, publishUsageKey, toLanguage } from "./_lib";
import type { FormatType, Language } from "./_lib";
import { idempotencyPayload } from "./_publish";

// Minimal KV shape (avoids pulling in @cloudflare/workers-types; wrangler's
// esbuild only strips types). Mirrors the interface in try-generate.ts.
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}
import {
  buildOAuth1Header,
  isChannel,
  timingSafeEqual,
  toPlainText,
  toXThread,
} from "./_publish";
import type { Channel, OAuth1Creds } from "./_publish";

interface Env {
  PUBLISH_ENABLED?: string;
  PUBLISH_TOKEN?: string;
  // X (Twitter) OAuth 1.0a — create these in the X developer portal for the
  // account you want to post as (e.g. @brypoai).
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_TOKEN_SECRET?: string;
  // Generic outbound webhook (Zapier / Make / n8n / your own worker).
  PUBLISH_WEBHOOK_URL?: string;
  // Max successful-or-attempted publishes per UTC day — bounds a leaked
  // token. Optional; defaults to DEFAULT_PUBLISH_DAILY_LIMIT. Shares the
  // /try KV namespace (counter key `publish:YYYY-MM-DD`).
  PUBLISH_DAILY_LIMIT?: string;
  TRY_KV?: KVNamespace;
}

// Owner-only endpoint, so this is a runaway/leak backstop, not a fairness
// quota — a comfortable ceiling for legitimate building-in-public cadence.
const DEFAULT_PUBLISH_DAILY_LIMIT = 50;
const PUBLISH_KEY_TTL_S = 3 * 24 * 3600;
// Idempotency window: how long an identical publish is deduped. Long enough to
// cover a double-click or a lost-response retry, short enough that a deliberate
// re-post of the same text later isn't blocked for long.
const IDEM_TTL_S = 600;

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

function errorResponse(status: number, code: string, message: string): Response {
  return json({ error: message, code }, status);
}

// ---- per-channel publishers -------------------------------------------------

interface ChannelResult {
  channel: Channel;
  ok: boolean;
  detail: string;
  /** Present on X success: URL of the first tweet in the thread. */
  url?: string;
  /** Present on X success: number of tweets posted. */
  count?: number;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return hex(new Uint8Array(digest));
}

// Retry only on 503 (service temporarily unavailable) — a short retry can
// genuinely clear it. 429 is excluded: X post rate-limit windows are minutes,
// so a ~1.5s retry is futile and just adds latency. 500/502/network-timeouts
// (status 0) are excluded because the outcome is ambiguous — the tweet may
// have been created and a blind retry would double-post.
//   Residual risk: HTTP 503 *should* mean "not processed", but if X's edge
//   returned 503 after the write committed, one retry would post a duplicate.
//   That path is rare and HTTP-noncompliant; accepted as a bounded tradeoff
//   (see TRY_TOOL_README.md "Known limitations").
const RETRYABLE_X_STATUSES = new Set([503]);
const MAX_X_RETRIES = 3; // per request; bounds latency + subrequest budget
const X_RETRY_DELAY_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Verify the X credentials WITHOUT posting: OAuth1-signed GET /2/users/me.
 * Returns the authenticated handle (so the owner sees which account a
 * Publish would post as) and, when X exposes it, the token's access level —
 * which catches the classic "token generated before Read+Write" mistake.
 */
async function verifyXCredentials(
  creds: OAuth1Creds,
): Promise<ChannelResult & { handle?: string; write?: "yes" | "unknown" }> {
  const url = "https://api.twitter.com/2/users/me";
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const timestamp = Math.floor(Date.now() / 1000);
  const auth = await buildOAuth1Header("GET", url, creds, nonce, timestamp);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { channel: "x", ok: false, detail: "network error or timeout reaching the X API" };
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body — handled below */
  }
  if (!res.ok) {
    const upstream =
      (data && (data.title || data.detail || data.error)) || `X API returned ${res.status}`;
    // Map the common setup failures to actionable hints.
    const hint =
      res.status === 401
        ? " — keys/tokens rejected: re-check all four values (and regenerate the access token if app permissions changed after it was created)"
        : res.status === 403
          ? " — authenticated but forbidden: app may lack Read+Write, or the account has no API credit"
          : "";
    return {
      channel: "x",
      ok: false,
      detail: `${String(upstream).slice(0, 160)}${hint}`,
    };
  }
  const handle = typeof data?.data?.username === "string" ? data.data.username : undefined;
  // x-access-level is a v1.1-era header that X *usually* still sends on OAuth1
  // requests, but it is NOT guaranteed on the v2 users/me endpoint. When it's
  // "read" we can catch the classic read-only-token mistake loudly; when it's
  // absent we deliberately DON'T claim posting works (a read-only token also
  // returns 200 here) — there's no non-destructive way to confirm write scope,
  // so we report "keys valid, write not confirmed" instead of over-promising.
  const accessLevel = res.headers.get("x-access-level") ?? "";
  if (accessLevel === "read") {
    return {
      channel: "x",
      ok: false,
      handle,
      detail: `authenticated as @${handle ?? "?"} but the access token is READ-ONLY — set the app to Read and Write, then regenerate the access token`,
    };
  }
  const write: "yes" | "unknown" = accessLevel.includes("write") ? "yes" : "unknown";
  return {
    channel: "x",
    ok: true,
    handle,
    write,
    detail:
      write === "yes"
        ? `authenticated as @${handle ?? "?"} with write access`
        : `authenticated as @${handle ?? "?"} — keys valid (write permission not confirmed without a live post)`,
  };
}

/** Post one tweet, optionally as a reply, returning its id. */
async function postTweet(
  creds: OAuth1Creds,
  text: string,
  replyToId: string | null,
): Promise<{ ok: true; id: string } | { ok: false; status: number; detail: string }> {
  const url = "https://api.twitter.com/2/tweets";
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const timestamp = Math.floor(Date.now() / 1000);
  const auth = await buildOAuth1Header("POST", url, creds, nonce, timestamp);

  const payload: Record<string, unknown> = { text };
  if (replyToId) payload.reply = { in_reply_to_tweet_id: replyToId };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, status: 0, detail: "network error or timeout" };
  }

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body — handled below */
  }
  if (!res.ok) {
    const detail =
      (data && (data.title || data.detail || data.error)) ||
      `X API returned ${res.status}`;
    return { ok: false, status: res.status, detail: String(detail).slice(0, 200) };
  }
  const id = data?.data?.id;
  if (typeof id !== "string") {
    return { ok: false, status: res.status, detail: "X API response missing tweet id" };
  }
  return { ok: true, id };
}

async function publishToX(
  env: Env,
  formatType: FormatType,
  content: Record<string, unknown>,
  lang: Language,
): Promise<ChannelResult> {
  const creds: OAuth1Creds = {
    consumerKey: env.X_API_KEY ?? "",
    consumerSecret: env.X_API_SECRET ?? "",
    accessToken: env.X_ACCESS_TOKEN ?? "",
    accessTokenSecret: env.X_ACCESS_TOKEN_SECRET ?? "",
  };
  if (
    !creds.consumerKey ||
    !creds.consumerSecret ||
    !creds.accessToken ||
    !creds.accessTokenSecret
  ) {
    return { channel: "x", ok: false, detail: "X credentials not configured" };
  }

  const tweets = toXThread(formatType, content, lang);
  if (tweets.length === 0) {
    return { channel: "x", ok: false, detail: "nothing to post (empty content)" };
  }

  let replyTo: string | null = null;
  let firstId: string | null = null;
  let posted = 0;
  let retriesUsed = 0;
  for (const text of tweets) {
    let r = await postTweet(creds, text, replyTo);
    // Transient-error retry so a long thread isn't killed by one hiccup.
    // See RETRYABLE_X_STATUSES for which statuses qualify and why. Capped per
    // request to bound latency and the Workers subrequest budget.
    if (!r.ok && RETRYABLE_X_STATUSES.has(r.status) && retriesUsed < MAX_X_RETRIES) {
      retriesUsed += 1;
      await sleep(X_RETRY_DELAY_MS);
      r = await postTweet(creds, text, replyTo);
    }
    if (!r.ok) {
      // Partial thread: report how far we got so the owner can reconcile.
      const base =
        posted === 0
          ? `X post failed: ${r.detail}`
          : `X thread stopped after ${posted}/${tweets.length}: ${r.detail}`;
      return { channel: "x", ok: false, detail: base, count: posted, url: firstId ? tweetUrl(firstId) : undefined };
    }
    posted += 1;
    if (firstId === null) firstId = r.id;
    replyTo = r.id;
  }
  return {
    channel: "x",
    ok: true,
    detail: `posted ${posted} tweet${posted !== 1 ? "s" : ""}`,
    count: posted,
    url: firstId ? tweetUrl(firstId) : undefined,
  };
}

function tweetUrl(id: string): string {
  // Account handle is unknown here; the id-only URL redirects to the canonical
  // status URL when opened.
  return `https://x.com/i/status/${id}`;
}

async function publishToWebhook(
  env: Env,
  formatType: FormatType,
  content: Record<string, unknown>,
  lang: Language,
): Promise<ChannelResult> {
  const url = env.PUBLISH_WEBHOOK_URL;
  if (!url) {
    return { channel: "webhook", ok: false, detail: "PUBLISH_WEBHOOK_URL not configured" };
  }
  const text = toPlainText(formatType, content, lang);
  if (text.length === 0) {
    return { channel: "webhook", ok: false, detail: "nothing to post (empty content)" };
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format_type: formatType, language: lang, text, content }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { channel: "webhook", ok: false, detail: "network error or timeout" };
  }
  if (!res.ok) {
    return { channel: "webhook", ok: false, detail: `webhook returned ${res.status}` };
  }
  return { channel: "webhook", ok: true, detail: "delivered to webhook" };
}

// ---- handler ----------------------------------------------------------------

export async function onRequestPost(context: PagesContext): Promise<Response> {
  const t0 = Date.now();
  const now = new Date();
  const { request, env } = context;

  const finish = (
    response: Response,
    channels: string[],
    extra?: Record<string, unknown>,
  ): Response => {
    console.log(
      JSON.stringify({
        action: "publish",
        status: response.status,
        channels,
        ms: Date.now() - t0,
        ...extra,
      }),
    );
    return response;
  };

  // 1. Kill switch (defaults OFF — publishing must be opted into explicitly).
  if (env.PUBLISH_ENABLED !== "true") {
    return finish(errorResponse(503, "disabled", "Publishing is disabled."), []);
  }

  // 2. Body.
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return finish(errorResponse(400, "bad_request", "Request body must be JSON."), []);
  }

  // 3. Owner token gate (constant-time). The token may arrive in the header
  // (preferred — keeps it out of any body log) or the body.
  const provided =
    request.headers.get("X-Publish-Token") ??
    (typeof body?.token === "string" ? body.token : "");
  const expected = env.PUBLISH_TOKEN ?? "";
  if (expected.length === 0 || !timingSafeEqual(provided, expected)) {
    return finish(errorResponse(401, "unauthorized", "Invalid or missing publish token."), []);
  }

  // 3b. Verify mode: check the channel credentials WITHOUT posting anything.
  // Read-only, so it skips the rate-limit and idempotency gates. The X check
  // is a live users/me call (also reveals which @handle would post); the
  // webhook is only checked for presence — calling it would fire the owner's
  // automation with a bogus payload.
  if (body?.verify === true) {
    const results: Array<Record<string, unknown>> = [];
    const creds: OAuth1Creds = {
      consumerKey: env.X_API_KEY ?? "",
      consumerSecret: env.X_API_SECRET ?? "",
      accessToken: env.X_ACCESS_TOKEN ?? "",
      accessTokenSecret: env.X_ACCESS_TOKEN_SECRET ?? "",
    };
    if (!creds.consumerKey || !creds.consumerSecret || !creds.accessToken || !creds.accessTokenSecret) {
      results.push({ channel: "x", ok: false, detail: "X credentials not configured" });
    } else {
      results.push(await verifyXCredentials(creds));
    }
    results.push({
      channel: "webhook",
      ok: Boolean(env.PUBLISH_WEBHOOK_URL),
      detail: env.PUBLISH_WEBHOOK_URL
        ? "PUBLISH_WEBHOOK_URL is configured (not called during verify)"
        : "PUBLISH_WEBHOOK_URL not configured",
    });
    // Handle/access level go to the response for the owner, never the logs.
    return finish(json({ verify: true, results }, 200), ["verify"], {
      verify_x_ok: results[0]?.ok === true,
    });
  }

  // 4. Validate format + content.
  if (!isFormatType(body?.format_type)) {
    return finish(
      errorResponse(400, "bad_request", "format_type must be one of: investor, sns, hiring, customer, internal."),
      [],
    );
  }
  const formatType: FormatType = body.format_type;
  const content = body?.content;
  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    return finish(errorResponse(400, "bad_request", "content must be an object."), []);
  }
  const contentObj = content as Record<string, unknown>;

  // Output language for labels (defaults to English for back-compat).
  const lang: Language = toLanguage(body?.language);

  // 5. Channels.
  const rawChannels = Array.isArray(body?.channels) ? body.channels : [];
  const channels = rawChannels.filter(isChannel) as Channel[];
  const uniqueChannels = Array.from(new Set(channels));
  if (uniqueChannels.length === 0) {
    return finish(
      errorResponse(400, "bad_request", "channels must include at least one of: x, webhook."),
      [],
    );
  }

  // 5b. Daily rate gate (UTC day). This bounds the damage if the owner token
  // leaks — publishing has no per-cost KV gate otherwise. Like the /try gates,
  // KV failures fail OPEN (availability wins; the token remains the real gate,
  // and X's own API rate limits are the hard backstop). Counts one unit per
  // accepted request (a request may post a whole thread).
  const limit = (() => {
    const n = parseInt(env.PUBLISH_DAILY_LIMIT ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_PUBLISH_DAILY_LIMIT;
  })();
  if (env.TRY_KV) {
    const key = publishUsageKey(now);
    try {
      const count = parseInt((await env.TRY_KV.get(key)) ?? "0", 10) || 0;
      if (count >= limit) {
        return finish(
          errorResponse(
            429,
            "rate_limit",
            "Daily publish limit reached. It resets daily (UTC).",
          ),
          uniqueChannels,
          { publish_count: count, publish_limit: limit },
        );
      }
      await env.TRY_KV.put(key, String(count + 1), {
        expirationTtl: PUBLISH_KEY_TTL_S,
      });
    } catch {
      // fail open — see above.
    }
  }

  // 5c. Idempotency guard. Posting to a live account is irreversible, and a
  // double-click or a lost-response retry would post the same content twice.
  // Reserve a content-hash key before dispatch; a repeat within IDEM_TTL_S is
  // rejected (409). After dispatch we keep the key on full success (so retries
  // stay deduped) but delete it on any failure (so a real retry can proceed).
  // Best-effort: KV has no atomic compare-and-set, so two *simultaneous*
  // identical requests can still both pass — the in-flight button-disable on
  // the client covers that common case. Fails OPEN on KV errors.
  let idemKey: string | null = null;
  if (env.TRY_KV) {
    try {
      idemKey =
        "idem:" +
        (await sha256Hex(idempotencyPayload(formatType, lang, uniqueChannels, contentObj)));
      if ((await env.TRY_KV.get(idemKey)) !== null) {
        return finish(
          errorResponse(
            409,
            "duplicate",
            "This exact post was just published — not sending it again.",
          ),
          uniqueChannels,
          { idempotent: true },
        );
      }
      await env.TRY_KV.put(idemKey, "pending", { expirationTtl: IDEM_TTL_S });
    } catch {
      idemKey = null; // fail open
    }
  }

  // 6. Dispatch (channels run in parallel — one failing must not block others).
  const results = await Promise.all(
    uniqueChannels.map((ch) =>
      ch === "x"
        ? publishToX(env, formatType, contentObj, lang)
        : publishToWebhook(env, formatType, contentObj, lang),
    ),
  );

  const anyOk = results.some((r) => r.ok);
  const allOk = results.every((r) => r.ok);

  // Finalize idempotency: keep the key only on full success (future identical
  // posts are deduped); release it otherwise so the owner can retry a failure.
  if (idemKey && env.TRY_KV) {
    try {
      if (allOk) {
        await env.TRY_KV.put(idemKey, "done", { expirationTtl: IDEM_TTL_S });
      } else {
        await env.TRY_KV.delete(idemKey);
      }
    } catch {
      // best-effort — a stale "pending" simply expires after IDEM_TTL_S.
    }
  }

  // 200 if everything posted, 207-style semantics folded into 200 when partial,
  // 502 only when every channel failed (so the client shows a clear error).
  const status = allOk ? 200 : anyOk ? 200 : 502;
  return finish(json({ ok: allOk, results }, status), uniqueChannels, {
    results_ok: results.filter((r) => r.ok).length,
    results_total: results.length,
  });
}

// Non-POST → JSON 405 (mirrors try-generate).
export async function onRequest(context: PagesContext): Promise<Response> {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }
  return errorResponse(405, "method_not_allowed", "Use POST.");
}
