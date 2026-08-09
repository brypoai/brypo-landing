/**
 * functions/api/x-reply/digest.ts
 *
 * GET /api/x-reply/digest — owner-only reply-candidate list (L0-1: the human
 * reads this, then replies by hand in the X app). Read-only; PUBLISH_TOKEN
 * gated. ?date=YYYY-MM-DD selects a day (default today, UTC). Returns the KV
 * digest array written by run.ts (each entry: url, postedAtJst, likes,
 * replies, textHead, via).
 */

import { timingSafeEqual } from "../_publish";
import { xReplyDigestKey } from "../_xreply";

interface KVNamespace {
  get(key: string): Promise<string | null>;
}

interface Env {
  PUBLISH_TOKEN?: string;
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function handleGet(context: PagesContext): Promise<Response> {
  const { request, env } = context;

  const provided = request.headers.get("X-Publish-Token") ?? "";
  const expected = env.PUBLISH_TOKEN ?? "";
  if (expected.length === 0 || !timingSafeEqual(provided, expected)) {
    return json({ error: "Invalid or missing publish token.", code: "unauthorized" }, 401);
  }
  if (!env.TRY_KV) {
    return json({ error: "KV not configured.", code: "kv_unconfigured" }, 503);
  }

  // Resolve the target day: ?date=YYYY-MM-DD, else today (UTC). A malformed
  // date is rejected rather than silently coerced.
  const url = new URL(request.url);
  const dateParam = url.searchParams.get("date");
  if (dateParam !== null && !DATE_RE.test(dateParam)) {
    return json({ error: "date must be YYYY-MM-DD.", code: "bad_request" }, 400);
  }
  const day = dateParam ?? new Date().toISOString().slice(0, 10);
  // xReply*Key take a Date; anchor at midnight UTC of the chosen day.
  const anchor = new Date(`${day}T00:00:00Z`);

  let entries: unknown[] = [];
  try {
    const raw = await env.TRY_KV.get(xReplyDigestKey(anchor));
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) entries = arr;
    }
  } catch {
    entries = [];
  }
  return json({ date: day, summary: { entries: entries.length }, entries }, 200);
}

export async function onRequest(context: PagesContext): Promise<Response> {
  if (context.request.method === "GET") return handleGet(context);
  return json({ error: "Use GET.", code: "method_not_allowed" }, 405);
}
