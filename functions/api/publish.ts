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

import { isFormatType } from "./_lib";
import type { FormatType } from "./_lib";
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

  const tweets = toXThread(formatType, content);
  if (tweets.length === 0) {
    return { channel: "x", ok: false, detail: "nothing to post (empty content)" };
  }

  let replyTo: string | null = null;
  let firstId: string | null = null;
  let posted = 0;
  for (const text of tweets) {
    const r = await postTweet(creds, text, replyTo);
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
): Promise<ChannelResult> {
  const url = env.PUBLISH_WEBHOOK_URL;
  if (!url) {
    return { channel: "webhook", ok: false, detail: "PUBLISH_WEBHOOK_URL not configured" };
  }
  const text = toPlainText(formatType, content);
  if (text.length === 0) {
    return { channel: "webhook", ok: false, detail: "nothing to post (empty content)" };
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format_type: formatType, text, content }),
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

  // 6. Dispatch (channels run in parallel — one failing must not block others).
  const results = await Promise.all(
    uniqueChannels.map((ch) =>
      ch === "x"
        ? publishToX(env, formatType, contentObj)
        : publishToWebhook(env, formatType, contentObj),
    ),
  );

  const anyOk = results.some((r) => r.ok);
  const allOk = results.every((r) => r.ok);
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
