/**
 * functions/api/x-reply/run.ts
 *
 * POST /api/x-reply/run — the X reply-CANDIDATE lister (@kokibuilds; dev-env
 * docs/dev-env/x-growth-strategy.md): discover → filter → LIST. No drafting —
 * the Anthropic call was removed 2026-08-10 (drafts were templated + invented
 * first-person experience); the human writes every reply.
 * It never posts to X — the send path was severed AT CODE LEVEL (2026-08-10,
 * L0-1): postReply / POST /2/tweets no longer exists here, and any request
 * without body.dry_run === true gets 400. The human reads the digest and
 * replies by hand in the X app. Dedup is presentation-based: a listed id is
 * held in KV for 7 days; human replies are not tracked. Logging: metadata only.
 */

import { timingSafeEqual, buildOAuth1Header } from "../_publish";
import type { OAuth1Creds } from "../_publish";
import {
  DEFAULT_ICP_QUERIES,
  filterCandidates,
  toQueryString,
  xReplyDigestKey,
  xReplySeenKey,
} from "../_xreply";
import type { Candidate } from "../_xreply";

// Minimal KV shape (avoids @cloudflare/workers-types; esbuild strips types).
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

interface Env {
  PUBLISH_TOKEN?: string;
  // Kill switch — OFF unless exactly "true". Nothing sends while this is unset.
  X_REPLY_ENABLED?: string;
  // X OAuth 1.0a (same four as /api/publish).
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_TOKEN_SECRET?: string;
  TRY_KV?: KVNamespace;
}

interface PagesContext {
  request: Request;
  env: Env;
}

const DIGEST_TTL_S = 7 * 24 * 3600;
// Presented-in-digest marker (L0-1): once listed, held out for 7 days.
const SEEN_TTL_S = 7 * 24 * 3600;
// Hard ceiling on candidates processed per request — bounds the Workers
// subrequest budget even if a huge target list is posted.
const MAX_PER_RUN = 25;

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

// ---- X search (recent) — paid read tier -------------------------------------

/** Presentation metadata carried alongside a Candidate. */
interface SearchExtras {
  createdAt?: string;
  likeCount?: number;
  replyCount?: number;
}

/** Search recent posts for reply candidates. Never throws: returns [] + a
 *  reason string so a missing/unfunded read tier is surfaced, not swallowed. */
async function searchRecent(
  creds: OAuth1Creds,
  query: string,
  maxResults: number,
): Promise<{ candidates: (Candidate & SearchExtras)[]; error?: string }> {
  const base = "https://api.twitter.com/2/tweets/search/recent";
  const qp: Record<string, string> = {
    query,
    max_results: String(Math.min(Math.max(maxResults, 10), 100)),
    expansions: "author_id",
    "tweet.fields": "lang,created_at,public_metrics",
    "user.fields": "username",
  };
  // Encode the URL with the SAME percent-encoding as the OAuth signature base
  // string (see toQueryString) — otherwise queries with operator groups like
  // "(a OR b)" mismatch the signature and X returns 401 Unauthorized.
  const url = `${base}?${toQueryString(qp)}`;
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const ts = Math.floor(Date.now() / 1000);
  const auth = await buildOAuth1Header("GET", base, creds, nonce, ts, qp);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { candidates: [], error: "network error or timeout reaching X search" };
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* handled below */
  }
  if (!res.ok) {
    const detail =
      (data && (data.title || data.detail || data.error)) ||
      `X search returned ${res.status}`;
    return { candidates: [], error: String(detail).slice(0, 200) };
  }
  const users: Record<string, string> = {};
  for (const u of data?.includes?.users ?? []) {
    if (u && typeof u.id === "string" && typeof u.username === "string") {
      users[u.id] = u.username;
    }
  }
  const candidates: (Candidate & SearchExtras)[] = [];
  for (const tw of data?.data ?? []) {
    if (!tw || typeof tw.id !== "string" || typeof tw.text !== "string") continue;
    candidates.push({
      id: tw.id,
      authorHandle: users[tw.author_id] ?? "",
      text: tw.text,
      createdAt: typeof tw.created_at === "string" ? tw.created_at : undefined,
      likeCount: typeof tw.public_metrics?.like_count === "number" ? tw.public_metrics.like_count : undefined,
      replyCount: typeof tw.public_metrics?.reply_count === "number" ? tw.public_metrics.reply_count : undefined,
    });
  }
  return { candidates };
}

// ---- KV helpers -------------------------------------------------------------

interface DigestEntry {
  url?: string;
  postedAtJst?: string | null;
  likes?: number | null;
  replies?: number | null;
  textHead?: string;
  via?: string;
}

async function appendDigest(kv: KVNamespace, now: Date, entries: DigestEntry[], listedIds: string[]) {
  if (entries.length === 0) return;
  const key = xReplyDigestKey(now);
  let existing: DigestEntry[] = [];
  try {
    const raw = await kv.get(key);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) existing = arr;
    }
  } catch {
    /* start fresh */
  }
  try {
    await kv.put(key, JSON.stringify([...existing, ...entries]), {
      expirationTtl: DIGEST_TTL_S,
    });
  } catch {
    /* non-fatal */
  }
  // Presentation-based dedup: a listed id is held out for 7 days (SEEN_TTL_S).
  for (const id of listedIds) {
    try {
      await kv.put(xReplySeenKey(id), "1", { expirationTtl: SEEN_TTL_S });
    } catch {
      /* non-fatal */
    }
  }
}

// ---- handler ----------------------------------------------------------------

async function handlePost(context: PagesContext): Promise<Response> {
  const t0 = Date.now();
  const { request, env } = context;
  const now = new Date();

  const finish = (
    response: Response,
    extra?: Record<string, unknown>,
  ): Response => {
    console.log(
      JSON.stringify({ action: "x-reply", status: response.status, ms: Date.now() - t0, ...extra }),
    );
    return response;
  };

  // 1. Kill switch (OFF unless exactly "true").
  if (env.X_REPLY_ENABLED !== "true") {
    return finish(json({ error: "The reply-engine is disabled.", code: "disabled" }, 503));
  }

  // 2. Body + owner token gate (constant-time; fails closed when unset).
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return finish(json({ error: "Request body must be JSON.", code: "bad_request" }, 400));
  }
  const provided =
    request.headers.get("X-Publish-Token") ??
    (typeof body?.token === "string" ? body.token : "");
  const expected = env.PUBLISH_TOKEN ?? "";
  if (expected.length === 0 || !timingSafeEqual(provided, expected)) {
    return finish(json({ error: "Invalid or missing publish token.", code: "unauthorized" }, 401));
  }

  // 3. L0-1: sending is severed at code level — no POST /2/tweets code exists below (not a flag).
  if (body?.dry_run !== true) {
    return finish(
      json({ error: 'Sending is disabled. Call with {"dry_run": true} — this endpoint only lists reply candidates.', code: "send_disabled" }, 400),
    );
  }

  // 4. Credentials + config.
  const creds: OAuth1Creds = {
    consumerKey: env.X_API_KEY ?? "",
    consumerSecret: env.X_API_SECRET ?? "",
    accessToken: env.X_ACCESS_TOKEN ?? "",
    accessTokenSecret: env.X_ACCESS_TOKEN_SECRET ?? "",
  };
  if (!creds.consumerKey || !creds.consumerSecret || !creds.accessToken || !creds.accessTokenSecret) {
    return finish(json({ error: "X credentials not configured.", code: "x_unconfigured" }, 503));
  }
  const kv = env.TRY_KV;
  if (!kv) {
    return finish(json({ error: "KV not configured.", code: "kv_unconfigured" }, 503));
  }

  // 5. Gather candidates: explicit targets, else live search (paid tier).
  // meta rides beside the Candidate shape (filterCandidates drops extras).
  let rawCandidates: unknown[] = [];
  let searchError: string | undefined;
  const meta = new Map<string, SearchExtras & { query?: string }>();
  if (Array.isArray(body?.targets) && body.targets.length > 0) {
    rawCandidates = body.targets as unknown[];
  } else {
    const queries = Array.isArray(body?.queries) && body.queries.length > 0
      ? (body.queries as unknown[]).filter((q): q is string => typeof q === "string")
      : DEFAULT_ICP_QUERIES;
    const perQuery = Math.max(10, Math.ceil(MAX_PER_RUN / Math.max(queries.length, 1)));
    for (const q of queries) {
      const r = await searchRecent(creds, q, perQuery);
      if (r.error) searchError = r.error;
      for (const c of r.candidates) {
        if (!meta.has(c.id)) {
          meta.set(c.id, { createdAt: c.createdAt, likeCount: c.likeCount, replyCount: c.replyCount, query: q });
        }
      }
      rawCandidates.push(...r.candidates);
    }
  }

  // 6. Load anti-abuse state, filter, cap.
  const seen = new Set<string>();
  // Cheaply check the seen marker for each id we're about to consider.
  const provisional = filterCandidates(rawCandidates, { selfHandle: "kokibuilds" });
  await Promise.all(
    provisional.map(async (c) => {
      try {
        if (await kv.get(xReplySeenKey(c.id))) seen.add(c.id);
      } catch {
        /* treat as unseen */
      }
    }),
  );
  const candidates = filterCandidates(rawCandidates, {
    selfHandle: "kokibuilds",
    seen,
  }).slice(0, MAX_PER_RUN);

  if (candidates.length === 0) {
    return finish(
      json(
        {
          ok: true,
          considered: 0,
          listed: 0,
          skipped: 0,
          ...(searchError ? { searchError } : {}),
          note:
            rawCandidates.length === 0 && searchError
              ? "No candidates — search returned an error (read tier may be unfunded)."
              : "No fresh candidates.",
        },
        200,
      ),
      { considered: 0, listed: 0, ...(searchError ? { search_error: true } : {}) },
    );
  }

  const entryBase = (c: Candidate) => {
    const m = meta.get(c.id);
    const posted = m?.createdAt ? Date.parse(m.createdAt) : NaN;
    return {
      url: c.authorHandle
        ? `https://x.com/${c.authorHandle}/status/${c.id}`
        : `https://x.com/i/web/status/${c.id}`,
      postedAtJst: Number.isFinite(posted)
        ? `${new Date(posted + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ")} JST`
        : null,
      likes: m?.likeCount ?? null,
      replies: m?.replyCount ?? null,
      textHead: [...c.text].slice(0, 80).join(""), // raw slice, no summarisation
      via: m?.query ? `query:${m.query}` : "targets", // which existing gate surfaced it
    };
  };

  // 7. Record every surviving candidate. (No drafting; no send path exists.)
  const digest: DigestEntry[] = candidates.map(entryBase);
  await appendDigest(kv, now, digest, candidates.map((c) => c.id));

  return finish(
    json(
      {
        ok: true,
        considered: candidates.length,
        listed: digest.length,
        skipped: 0,
        ...(searchError ? { searchError } : {}),
        results: digest,
      },
      200,
    ),
    { considered: candidates.length, listed: digest.length },
  );
}

export async function onRequest(context: PagesContext): Promise<Response> {
  if (context.request.method === "POST") return handlePost(context);
  return json({ error: "Use POST.", code: "method_not_allowed" }, 405);
}
