/**
 * functions/api/_publish.ts
 *
 * Pure helpers for the /api/publish endpoint (content → platform text) plus
 * the OAuth 1.0a request signer for X (Twitter). Kept side-effect-free (aside
 * from the crypto-based signer, which takes all inputs explicitly) so
 * scripts/test-publish.mjs can unit-test the formatters under Node without a
 * Workers runtime.
 *
 * Content shapes mirror functions/api/_lib.ts CONTENT_VALIDATORS — the same
 * per-format objects the /try tool renders — so a card the user already sees
 * can be handed straight to a publish channel without reshaping.
 */

import type { FormatType } from "./_lib";

// ---- constants --------------------------------------------------------------

// X counts most posts by a 280 "weighted" length. We chunk on a plain
// character budget slightly under 280 to leave room for the " 1/ⁿ" numbering
// and the CJK/emoji weighting X applies (a rough, deliberately conservative
// approximation — see "Known limitations" in TRY_TOOL_README.md).
export const TWEET_LIMIT = 270;

// A whole thread longer than this many tweets is almost certainly a runaway
// (mangled content, or a format that should never have been an X thread).
// Truncate with a trailing marker rather than flooding the timeline.
export const MAX_TWEETS = 25;

export type Channel = "x" | "webhook";

export function isChannel(s: unknown): s is Channel {
  return s === "x" || s === "webhook";
}

// ---- content → line extraction ----------------------------------------------

interface Line {
  /** Optional short label (e.g. a section heading) shown before the text. */
  label?: string;
  text: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** Coerce a string | {text?} | {title?} element to its text, or null. */
function itemText(v: unknown): string | null {
  if (typeof v === "string") return str(v);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return str(o.text) ?? str(o.title) ?? null;
  }
  return null;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(itemText).filter((x): x is string => x !== null);
}

/**
 * Reduce one generated format object to an ordered list of lines. This is the
 * single source of truth both toPlainText and toXThread build on, so the two
 * channels stay consistent with each other and with the rendered card.
 */
export function contentToLines(
  formatType: FormatType,
  content: Record<string, unknown>,
): Line[] {
  const c = content;
  const lines: Line[] = [];
  const push = (text: string | null, label?: string) => {
    if (text !== null) lines.push(label ? { label, text } : { text });
  };
  const pushList = (v: unknown, label?: string) => {
    for (const item of strList(v)) push(item, label);
  };

  switch (formatType) {
    case "investor": {
      push(str(c.subject));
      push(str(c.greeting));
      for (const s of Array.isArray(c.sections) ? c.sections : []) {
        if (s && typeof s === "object") {
          const o = s as Record<string, unknown>;
          push(str(o.body), str(o.heading) ?? undefined);
        }
      }
      push(str(c.closing));
      break;
    }
    case "sns": {
      push(str(c.hook));
      pushList(c.thread);
      break;
    }
    case "hiring": {
      push(str(c.headline));
      push(str(c.mission_summary));
      push(str(c.team_culture));
      pushList(c.recent_milestones, "Milestone");
      pushList(c.open_roles, "Role");
      push(str(c.application_link), "Apply");
      break;
    }
    case "customer": {
      push(str(c.update_title));
      push(str(c.since_last_update));
      pushList(c.highlights, "Highlight");
      pushList(c.improvements, "Improved");
      pushList(c.known_issues, "Known issue");
      if (typeof c.next_steps === "string") push(str(c.next_steps), "Next");
      else pushList(c.next_steps, "Next");
      push(str(c.cta));
      break;
    }
    case "internal": {
      push(str(c.period_summary));
      pushList(c.key_events, "Event");
      pushList(c.decisions, "Decision");
      pushList(c.open_questions, "Question");
      pushList(c.action_items, "Action");
      break;
    }
  }
  return lines;
}

function renderLine(l: Line): string {
  return l.label ? `${l.label}: ${l.text}` : l.text;
}

// ---- plaintext (webhook / blog / generic) -----------------------------------

/**
 * A single newline-joined document — what a webhook consumer (Zapier / Make /
 * n8n → note, LinkedIn, a blog, TikTok/YouTube description, …) receives as the
 * body to post. Returns "" when the content has no usable text.
 */
export function toPlainText(
  formatType: FormatType,
  content: Record<string, unknown>,
): string {
  return contentToLines(formatType, content).map(renderLine).join("\n\n").trim();
}

// ---- X thread ---------------------------------------------------------------

/**
 * Split one long string into <=limit-char chunks, breaking on whitespace where
 * possible so words aren't cut mid-token. A single token longer than the limit
 * is hard-split (URLs, long identifiers).
 */
export function chunkText(text: string, limit: number = TWEET_LIMIT): string[] {
  const t = text.trim();
  if (t.length === 0) return [];
  if (t.length <= limit) return [t];

  const chunks: string[] = [];
  let rest = t;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(" ", limit);
    // No breakable space in range (or it's too early) → hard cut at the limit.
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/**
 * Turn a generated format into an ordered array of tweets. For the native "sns"
 * (X thread) format each line becomes its own tweet; other formats are flowed
 * into as few tweets as fit. Every tweet is <=TWEET_LIMIT chars; the whole
 * thread is capped at MAX_TWEETS (a truncation marker replaces the tail).
 */
export function toXThread(
  formatType: FormatType,
  content: Record<string, unknown>,
): string[] {
  const lines = contentToLines(formatType, content);

  let tweets: string[];
  if (formatType === "sns") {
    // The thread was authored as discrete posts — preserve that boundary,
    // only splitting a post that individually overflows.
    tweets = lines.flatMap((l) => chunkText(renderLine(l)));
  } else {
    // Non-thread formats: pack lines together, starting a new tweet only when
    // the next line wouldn't fit, so we don't emit one tiny tweet per bullet.
    tweets = [];
    let buf = "";
    for (const l of lines) {
      const piece = renderLine(l);
      for (const seg of chunkText(piece)) {
        if (buf.length === 0) {
          buf = seg;
        } else if (buf.length + 2 + seg.length <= TWEET_LIMIT) {
          buf += "\n\n" + seg;
        } else {
          tweets.push(buf);
          buf = seg;
        }
      }
    }
    if (buf.length > 0) tweets.push(buf);
  }

  tweets = tweets.filter((t) => t.trim().length > 0);
  if (tweets.length > MAX_TWEETS) {
    tweets = tweets.slice(0, MAX_TWEETS - 1);
    tweets.push("…(truncated)");
  }
  // Number multi-tweet threads so readers know where they are / when it ends.
  if (tweets.length > 1) {
    const total = tweets.length;
    tweets = tweets.map((t, i) => {
      const suffix = ` ${i + 1}/${total}`;
      // If numbering would blow the budget, trim the body to make room.
      const room = TWEET_LIMIT - suffix.length;
      const body = t.length > room ? t.slice(0, room - 1).trimEnd() + "…" : t;
      return body + suffix;
    });
  }
  return tweets;
}

// ---- constant-time token compare --------------------------------------------

/**
 * Length-independent, content constant-time string compare for the owner
 * token. Avoids leaking token length or a byte-by-byte early-exit timing
 * side channel via `===`.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Fold the length difference into the comparison so mismatched lengths still
  // run the full loop (over the longer buffer) and always return false.
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

// ---- OAuth 1.0a signing (X API v2 user context) -----------------------------

export interface OAuth1Creds {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

/** RFC 3986 percent-encoding (encodeURIComponent leaves !*'() unescaped). */
export function percentEncode(v: string): string {
  return encodeURIComponent(v).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function base64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

/**
 * Build the `Authorization: OAuth …` header for a request. The X v2 tweet
 * endpoint carries its payload as a JSON body, so no body/query params enter
 * the signature base string (only the oauth_* params do). `nonce` and
 * `timestamp` are injected by the caller (kept out of here so the signer is
 * deterministic and unit-testable).
 */
export async function buildOAuth1Header(
  method: string,
  url: string,
  creds: OAuth1Creds,
  nonce: string,
  timestamp: number,
): Promise<string> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  const paramString = Object.keys(oauthParams)
    .map((k) => [percentEncode(k), percentEncode(oauthParams[k])])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(paramString),
  ].join("&");

  const signingKey =
    percentEncode(creds.consumerSecret) +
    "&" +
    percentEncode(creds.accessTokenSecret);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(baseString),
  );
  const signature = base64(sig);

  const headerParams: Record<string, string> = {
    ...oauthParams,
    oauth_signature: signature,
  };
  const header =
    "OAuth " +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k])}"`)
      .join(", ");
  return header;
}
