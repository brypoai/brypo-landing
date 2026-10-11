// functions/api/post-log.ts
//
// /api/post-log — owner-only record behind the daily draft notification
// (docs/post-notify.md). Gated by PUBLISH_TOKEN, like every owner endpoint.
//
//   GET   → { log, judgment, today }   read by /ops and by post-notify.mjs
//                                       (to skip a day that already ran)
//   POST  { kind: "send", date, drafts, mode }   machine row (post-notify.mjs)
//   POST  { kind: "weekly", week, posts, mood }  owner row (/ops, Sundays)
//
// One small JSON document in TRY_KV (key postlog:v1, no TTL). Read-modify-
// write is fine here: the writers are one hourly workflow (concurrency 1)
// and one person on /ops, so a lost update would need both in the same
// millisecond. Nothing here sends anything or calls a model.

import { timingSafeEqual } from "./_publish";
import { jstDateKey } from "./_lib";
import { POST_LOG_KEY, applyLogInput, judge, parseLog, parseLogInput } from "./_postlog";

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
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

export async function onRequest(context: PagesContext): Promise<Response> {
  const { request, env } = context;
  const method = request.method;
  if (method !== "GET" && method !== "POST") {
    return json({ error: "Use GET or POST.", code: "method_not_allowed" }, 405);
  }

  // Owner token gate (constant-time; fails closed when the token is unset).
  const provided = request.headers.get("X-Publish-Token") ?? "";
  const expected = env.PUBLISH_TOKEN ?? "";
  if (expected.length === 0 || !timingSafeEqual(provided, expected)) {
    return json({ error: "Invalid or missing publish token.", code: "unauthorized" }, 401);
  }

  const kv = env.TRY_KV;
  if (!kv) return json({ error: "TRY_KV is not bound.", code: "no_kv" }, 503);

  const now = new Date();
  const today = jstDateKey(now);
  let log = parseLog(await kv.get(POST_LOG_KEY));

  if (method === "POST") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Body must be JSON.", code: "bad_json" }, 400);
    }
    const input = parseLogInput(body);
    if (typeof input === "string") return json({ error: input, code: "invalid" }, 400);
    log = applyLogInput(log, input, now.toISOString());
    await kv.put(POST_LOG_KEY, JSON.stringify(log));
  }

  return json({ today, log, judgment: judge(log, today) }, 200);
}
