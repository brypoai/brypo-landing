/**
 * functions/api/x-reply/run.ts
 *
 * POST /api/x-reply/run — one pass of the X reply-engine (@kokibuilds growth,
 * dev-env docs/dev-env/x-growth-strategy.md; spec docs/specs/x-reply-engine).
 *
 * discover → draft → deterministic guardrails → auto-send, in one owner-gated,
 * kill-switched call. Intended to be driven by a Cloudflare Cron Trigger (or a
 * manual owner POST). There is NO per-reply human approval (2026-07-22 owner
 * decision); the guardrails in _xreply.ts are the safety layer, and
 * X_REPLY_ENABLED is the kill switch.
 *
 * Two input modes:
 *   - body.targets: [{id, authorHandle, text}, ...] — reply to these directly.
 *     Cheap (reply writes only, no search reads); usable before the paid search
 *     tier is funded, and the way to seed hand-picked targets.
 *   - no targets → live search (GET /2/tweets/search/recent) with ICP queries.
 *     Requires a funded (pay-per-use) read tier; without it X returns an error
 *     which is surfaced, not swallowed.
 *
 * body.dry_run: true drafts + guards but sends NOTHING (calibration / testing;
 * the strategy doc's "post-hoc digest to tune the prompt" without posting).
 *
 * Cost/safety gates, in order: kill switch → owner token → daily cap → per
 * candidate (seen dedup → draft → guardrails → idempotency → reply). Every
 * outcome is written to the day's digest (KV) for the owner to review.
 *
 * Logging discipline mirrors /api/publish: metadata only — never the drafted
 * text, never the token. { action:"x-reply", status, considered, sent,
 * skipped, ms }.
 */

import { timingSafeEqual, buildOAuth1Header } from "../_publish";
import type { OAuth1Creds } from "../_publish";
import { MODEL } from "../_lib";
import {
  DEFAULT_ICP_QUERIES,
  DEFAULT_REPLY_DAILY_CAP,
  RECENT_REPLIES_KEPT,
  buildReplyUserMessage,
  filterCandidates,
  normalizeText,
  parseReplyDraft,
  replyIdempotencyPayload,
  validateReplyText,
  xReplyCountKey,
  xReplyDigestKey,
  xReplyRecentKey,
  xReplySeenKey,
  REPLY_SYSTEM_PROMPT,
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
  // Auto-send ceiling per UTC day. Optional; defaults to DEFAULT_REPLY_DAILY_CAP.
  X_REPLY_DAILY_CAP?: string;
  // Comma-separated NG words; a draft containing any is dropped. Optional.
  X_REPLY_NG_WORDS?: string;
  // Override the drafting model. Optional; defaults to the /try MODEL (Haiku).
  X_REPLY_MODEL?: string;
  // X OAuth 1.0a (same four as /api/publish).
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_TOKEN_SECRET?: string;
  // Anthropic key — shared with /try (same $50/mo cap + kill switch posture).
  ANTHROPIC_API_KEY_TRY?: string;
  TRY_KV?: KVNamespace;
}

interface PagesContext {
  request: Request;
  env: Env;
}

const DIGEST_TTL_S = 7 * 24 * 3600;
const SEEN_TTL_S = 30 * 24 * 3600;
const RECENT_TTL_S = 30 * 24 * 3600;
const IDEM_TTL_S = 24 * 3600;
// Hard ceiling on candidates processed per request — bounds LLM spend and the
// Workers subrequest budget even if a huge target list is posted.
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

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return hex(new Uint8Array(d));
}

// ---- X search (recent) — paid read tier -------------------------------------

/** Search recent posts for reply candidates. Never throws: returns [] + a
 *  reason string so a missing/unfunded read tier is surfaced, not swallowed. */
async function searchRecent(
  creds: OAuth1Creds,
  query: string,
  maxResults: number,
): Promise<{ candidates: Candidate[]; error?: string }> {
  const base = "https://api.twitter.com/2/tweets/search/recent";
  const qp: Record<string, string> = {
    query,
    max_results: String(Math.min(Math.max(maxResults, 10), 100)),
    expansions: "author_id",
    "tweet.fields": "lang",
    "user.fields": "username",
  };
  const url = `${base}?${Object.entries(qp)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&")}`;
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
  const candidates: Candidate[] = [];
  for (const tw of data?.data ?? []) {
    if (!tw || typeof tw.id !== "string" || typeof tw.text !== "string") continue;
    candidates.push({
      id: tw.id,
      authorHandle: users[tw.author_id] ?? "",
      text: tw.text,
    });
  }
  return { candidates };
}

// ---- Anthropic reply draft --------------------------------------------------

async function draftReply(
  apiKey: string,
  model: string,
  c: Candidate,
): Promise<string | null> {
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
        max_tokens: 512,
        system: REPLY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildReplyUserMessage(c) }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
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
  const block = Array.isArray(data?.content)
    ? data.content.find((b: any) => b?.type === "text")
    : null;
  return typeof block?.text === "string" ? block.text : null;
}

// ---- X reply (write) --------------------------------------------------------

async function postReply(
  creds: OAuth1Creds,
  text: string,
  inReplyToId: string,
): Promise<{ ok: true; id: string } | { ok: false; detail: string }> {
  const url = "https://api.twitter.com/2/tweets";
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const ts = Math.floor(Date.now() / 1000);
  const auth = await buildOAuth1Header("POST", url, creds, nonce, ts);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: inReplyToId } }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, detail: "network error or timeout" };
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
      `X API returned ${res.status}`;
    return { ok: false, detail: String(detail).slice(0, 200) };
  }
  const id = data?.data?.id;
  if (typeof id !== "string") return { ok: false, detail: "X response missing tweet id" };
  return { ok: true, id };
}

// ---- KV helpers -------------------------------------------------------------

async function readRecentReplies(kv: KVNamespace): Promise<string[]> {
  try {
    const raw = await kv.get(xReplyRecentKey());
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function appendRecentReply(kv: KVNamespace, recent: string[], text: string) {
  const next = [normalizeText(text), ...recent].slice(0, RECENT_REPLIES_KEPT);
  try {
    await kv.put(xReplyRecentKey(), JSON.stringify(next), { expirationTtl: RECENT_TTL_S });
  } catch {
    /* non-fatal */
  }
}

interface DigestEntry {
  id: string;
  authorHandle: string;
  status: "sent" | "skipped" | "would_send";
  reply?: string;
  reason?: string;
}

async function appendDigest(kv: KVNamespace, now: Date, entries: DigestEntry[]) {
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

  // 3. Credentials + config.
  const creds: OAuth1Creds = {
    consumerKey: env.X_API_KEY ?? "",
    consumerSecret: env.X_API_SECRET ?? "",
    accessToken: env.X_ACCESS_TOKEN ?? "",
    accessTokenSecret: env.X_ACCESS_TOKEN_SECRET ?? "",
  };
  if (!creds.consumerKey || !creds.consumerSecret || !creds.accessToken || !creds.accessTokenSecret) {
    return finish(json({ error: "X credentials not configured.", code: "x_unconfigured" }, 503));
  }
  const anthropicKey = env.ANTHROPIC_API_KEY_TRY ?? "";
  if (anthropicKey.length === 0) {
    return finish(json({ error: "Drafting key not configured.", code: "llm_unconfigured" }, 503));
  }
  const kv = env.TRY_KV;
  if (!kv) {
    return finish(json({ error: "KV not configured.", code: "kv_unconfigured" }, 503));
  }
  const model = env.X_REPLY_MODEL || MODEL;
  const ngWords = (env.X_REPLY_NG_WORDS ?? "").split(",").map((w) => w.trim()).filter(Boolean);
  const dailyCap = (() => {
    const n = parseInt(env.X_REPLY_DAILY_CAP ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_REPLY_DAILY_CAP;
  })();
  const dryRun = body?.dry_run === true;
  // Per-run send ceiling — lets a scheduled trigger send a few at a time
  // instead of emptying the whole daily budget in one burst (burst = bot
  // signal). Defaults to the daily budget when unset. Never exceeds it.
  const perRunCap = (() => {
    const n = parseInt(String(body?.max_sends ?? ""), 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, dailyCap) : dailyCap;
  })();

  // 4. Daily cap (UTC). Read-modify-write; a dropped increment at this scale
  // only ever UNDER-counts (sends fewer), which is the safe direction.
  let sentToday = 0;
  try {
    sentToday = parseInt((await kv.get(xReplyCountKey(now))) ?? "0", 10) || 0;
  } catch {
    sentToday = 0;
  }
  let budget = Math.max(0, dailyCap - sentToday);
  if (!dryRun && budget === 0) {
    return finish(
      json({ error: "Daily reply cap reached.", code: "rate_limit", sentToday, dailyCap }, 429),
      { considered: 0, sent: 0 },
    );
  }

  // 5. Gather candidates: explicit targets, else live search (paid tier).
  let rawCandidates: unknown[] = [];
  let searchError: string | undefined;
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
      rawCandidates.push(...r.candidates);
    }
  }

  // 6. Load anti-abuse state, filter, cap.
  const recentReplies = await readRecentReplies(kv);
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
          sent: 0,
          skipped: 0,
          dryRun,
          ...(searchError ? { searchError } : {}),
          note:
            rawCandidates.length === 0 && searchError
              ? "No candidates — search returned an error (read tier may be unfunded)."
              : "No fresh candidates to reply to.",
        },
        200,
      ),
      { considered: 0, sent: 0, ...(searchError ? { search_error: true } : {}) },
    );
  }

  // 7. Per candidate: draft → guardrails → idempotency → send.
  const digest: DigestEntry[] = [];
  const results: Array<Record<string, unknown>> = [];
  let sent = 0;
  let skipped = 0;
  const localRecent = [...recentReplies]; // grows within the run to dedup peers

  for (const c of candidates) {
    if (!dryRun && (budget <= 0 || sent >= perRunCap)) {
      const reason = budget <= 0 ? "daily_cap_reached" : "per_run_cap_reached";
      results.push({ id: c.id, status: "skipped", reason });
      digest.push({ id: c.id, authorHandle: c.authorHandle, status: "skipped", reason });
      skipped++;
      continue;
    }

    const rawDraft = await draftReply(anthropicKey, model, c);
    const parsed = rawDraft ? parseReplyDraft(rawDraft) : null;
    if (parsed === null) {
      results.push({ id: c.id, status: "skipped", reason: "no_usable_draft" });
      digest.push({ id: c.id, authorHandle: c.authorHandle, status: "skipped", reason: "no_usable_draft" });
      skipped++;
      continue;
    }

    const guard = validateReplyText(parsed.reply, { recentReplies: localRecent, ngWords });
    if (!guard.ok) {
      results.push({ id: c.id, status: "skipped", reason: guard.reason });
      digest.push({ id: c.id, authorHandle: c.authorHandle, status: "skipped", reply: parsed.reply, reason: guard.reason });
      skipped++;
      continue;
    }

    if (dryRun) {
      results.push({ id: c.id, status: "would_send", reply: parsed.reply });
      digest.push({ id: c.id, authorHandle: c.authorHandle, status: "would_send", reply: parsed.reply });
      localRecent.unshift(normalizeText(parsed.reply));
      continue;
    }

    // Idempotency: same target + same normalized text can't post twice.
    const idemKey = `xreply:idem:${await sha256Hex(replyIdempotencyPayload(c.id, parsed.reply))}`;
    try {
      if (await kv.get(idemKey)) {
        results.push({ id: c.id, status: "skipped", reason: "duplicate" });
        digest.push({ id: c.id, authorHandle: c.authorHandle, status: "skipped", reason: "duplicate" });
        skipped++;
        continue;
      }
    } catch {
      /* fail open — the seen marker below is the second line of defence */
    }

    const posted = await postReply(creds, parsed.reply, c.id);
    if (!posted.ok) {
      results.push({ id: c.id, status: "skipped", reason: `send_failed:${posted.detail}` });
      digest.push({ id: c.id, authorHandle: c.authorHandle, status: "skipped", reply: parsed.reply, reason: `send_failed:${posted.detail}` });
      skipped++;
      continue;
    }

    // Success — record everything so we never touch this target again.
    sent++;
    budget--;
    localRecent.unshift(normalizeText(parsed.reply));
    await appendRecentReply(kv, localRecent.slice(1), parsed.reply);
    try {
      await kv.put(idemKey, "1", { expirationTtl: IDEM_TTL_S });
      await kv.put(xReplySeenKey(c.id), "1", { expirationTtl: SEEN_TTL_S });
      await kv.put(xReplyCountKey(now), String(sentToday + sent), { expirationTtl: 3 * 24 * 3600 });
    } catch {
      /* counters are best-effort; the reply already posted */
    }
    results.push({ id: c.id, status: "sent", tweetId: posted.id, reply: parsed.reply });
    digest.push({ id: c.id, authorHandle: c.authorHandle, status: "sent", reply: parsed.reply });
  }

  await appendDigest(kv, now, digest);

  return finish(
    json(
      {
        ok: true,
        considered: candidates.length,
        sent,
        skipped,
        dryRun,
        ...(searchError ? { searchError } : {}),
        results,
      },
      200,
    ),
    { considered: candidates.length, sent, skipped, dry_run: dryRun },
  );
}

export async function onRequest(context: PagesContext): Promise<Response> {
  if (context.request.method === "POST") return handlePost(context);
  return json({ error: "Use POST.", code: "method_not_allowed" }, 405);
}
