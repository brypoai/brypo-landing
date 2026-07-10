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

import type { FormatType, Language } from "./_lib";

// ---- constants --------------------------------------------------------------

// X's hard cap is 280 *weighted* units, not characters: CJK ideographs, kana,
// Hangul, fullwidth forms and emoji each weigh 2, and a URL is always 23 (it's
// shortened to a t.co link). See weightedLength() below. We chunk to a slightly
// smaller budget so the " 1/ⁿ" numbering suffix always fits without a re-trim.
export const TWEET_WEIGHTED_MAX = 280;
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

// Bilingual labels for the structured bullets. Keyed by a stable slug so the
// switch below reads the same in both languages; the display string is chosen
// at render time from the requested output language.
const LABELS: Record<string, { en: string; ja: string }> = {
  milestone: { en: "Milestone", ja: "マイルストーン" },
  role: { en: "Role", ja: "募集ポジション" },
  apply: { en: "Apply", ja: "応募" },
  highlight: { en: "Highlight", ja: "ハイライト" },
  improved: { en: "Improved", ja: "改善" },
  known_issue: { en: "Known issue", ja: "既知の問題" },
  next: { en: "Next", ja: "次のステップ" },
  event: { en: "Event", ja: "出来事" },
  decision: { en: "Decision", ja: "決定事項" },
  question: { en: "Question", ja: "オープンな論点" },
  action: { en: "Action", ja: "アクション" },
};

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
  lang: Language = "en",
): Line[] {
  const c = content;
  const lines: Line[] = [];
  // Resolve a label slug to its display string in the requested language.
  const lab = (slug: keyof typeof LABELS | (string & {})): string =>
    LABELS[slug] ? LABELS[slug][lang] : String(slug);
  const push = (text: string | null, label?: string) => {
    if (text !== null) lines.push(label ? { label, text } : { text });
  };
  const pushList = (v: unknown, labelSlug?: keyof typeof LABELS) => {
    const label = labelSlug ? lab(labelSlug) : undefined;
    for (const item of strList(v)) push(item, label);
  };

  switch (formatType) {
    case "investor": {
      push(str(c.subject));
      push(str(c.greeting));
      for (const s of Array.isArray(c.sections) ? c.sections : []) {
        if (s && typeof s === "object") {
          const o = s as Record<string, unknown>;
          // Section headings come from the model in the output language
          // already, so they're used verbatim (not looked up in LABELS).
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
      pushList(c.recent_milestones, "milestone");
      pushList(c.open_roles, "role");
      push(str(c.application_link), lab("apply"));
      break;
    }
    case "customer": {
      push(str(c.update_title));
      push(str(c.since_last_update));
      pushList(c.highlights, "highlight");
      pushList(c.improvements, "improved");
      pushList(c.known_issues, "known_issue");
      if (typeof c.next_steps === "string") push(str(c.next_steps), lab("next"));
      else pushList(c.next_steps, "next");
      push(str(c.cta));
      break;
    }
    case "internal": {
      push(str(c.period_summary));
      pushList(c.key_events, "event");
      pushList(c.decisions, "decision");
      pushList(c.open_questions, "question");
      pushList(c.action_items, "action");
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
  lang: Language = "en",
): string {
  return contentToLines(formatType, content, lang)
    .map(renderLine)
    .join("\n\n")
    .trim();
}

// ---- X thread ---------------------------------------------------------------

// Weight-2 Unicode ranges — an approximation of X's twitter-text config: CJK
// ideographs & radicals, Hiragana/Katakana, Hangul, fullwidth forms, and emoji.
// Bias is intentionally toward over-counting (weight 2 when unsure), which only
// ever makes tweets shorter — never long enough for X to reject.
function charWeight(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals … CJK symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana … CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo Ext A
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms (excl. halfwidth kana)
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    cp >= 0x1f000 // emoji & supplementary symbols
  ) {
    return 2;
  }
  return 1;
}

const URL_WEIGHT = 23;
const URL_RE = /https?:\/\/\S+/g;

interface Atom {
  s: string;
  w: number;
  /** True if a chunk may end just after this atom (whitespace / JP sentence end). */
  brk: boolean;
}

// Break text into weight-bearing atoms. A URL is ONE atom of weight 23 (X never
// splits a link); everything else is per-code-point so surrogate pairs (emoji)
// and CJK are measured correctly.
function atomize(text: string): Atom[] {
  const atoms: Atom[] = [];
  const pushChars = (s: string) => {
    for (const ch of s) {
      atoms.push({
        s: ch,
        w: charWeight(ch.codePointAt(0) as number),
        // English breaks on spaces; Japanese has none, so also allow a break
        // right after a sentence-ending mark rather than mid-clause.
        brk: ch === " " || ch === "\n" || "。、！？".indexOf(ch) !== -1,
      });
    }
  };
  let last = 0;
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    pushChars(text.slice(last, m.index));
    atoms.push({ s: m[0], w: URL_WEIGHT, brk: false });
    last = m.index + m[0].length;
  }
  pushChars(text.slice(last));
  return atoms;
}

/** X-weighted length of a string (CJK/emoji = 2, URL = 23, else 1). */
export function weightedLength(text: string): number {
  return atomize(text).reduce((sum, a) => sum + a.w, 0);
}

/**
 * Split one string into chunks each of X-weighted length <= limit, preferring
 * to break after whitespace or a Japanese sentence mark. URLs are kept whole.
 * A run with no break opportunity (e.g. a long Japanese sentence) is hard-split
 * at a code-point boundary within budget — never mid-URL, never mid-emoji.
 */
export function chunkText(text: string, limit: number = TWEET_LIMIT): string[] {
  const t = text.trim();
  if (t.length === 0) return [];
  const atoms = atomize(t);
  if (atoms.reduce((s, a) => s + a.w, 0) <= limit) return [t];

  const join = (from: number, to: number): string => {
    let out = "";
    for (let k = from; k < to; k++) out += atoms[k].s;
    return out;
  };

  const chunks: string[] = [];
  let start = 0; // first atom of the current chunk
  let w = 0; // accumulated weight of the current chunk
  let lastBreak = -1; // atom index just AFTER the last breakable atom in-chunk
  let i = start;
  while (i < atoms.length) {
    const a = atoms[i];
    if (w + a.w > limit && i > start) {
      const end = lastBreak > start ? lastBreak : i;
      chunks.push(join(start, end).trim());
      start = end;
      while (start < atoms.length && atoms[start].s === " ") start++;
      i = start;
      w = 0;
      lastBreak = -1;
      continue;
    }
    w += a.w;
    if (a.brk) lastBreak = i + 1;
    i++;
  }
  if (start < atoms.length) chunks.push(join(start, atoms.length).trim());
  return chunks.filter((c) => c.length > 0);
}

/** Longest prefix of `text` whose weighted length is <= maxW. */
function trimToWeight(text: string, maxW: number): string {
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = charWeight(ch.codePointAt(0) as number);
    if (w + cw > maxW) break;
    out += ch;
    w += cw;
  }
  return out;
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
  lang: Language = "en",
): string[] {
  const lines = contentToLines(formatType, content, lang);

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
        } else if (weightedLength(buf) + 2 + weightedLength(seg) <= TWEET_LIMIT) {
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
      const suffix = ` ${i + 1}/${total}`; // ASCII → weight === length
      // The chunk budget (TWEET_LIMIT) already reserves room for numbering, so
      // this trim is a safety net for a pre-numbered tweet that's near the cap.
      if (weightedLength(t) + suffix.length <= TWEET_WEIGHTED_MAX) return t + suffix;
      return trimToWeight(t, TWEET_WEIGHTED_MAX - suffix.length - 1).trimEnd() + "…" + suffix;
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
