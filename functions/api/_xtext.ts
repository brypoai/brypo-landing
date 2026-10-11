// functions/api/_xtext.ts
//
// X (Twitter) post-length helpers shared by /api/post-draft (the /ops
// "X で投稿" link) and scripts/post-mail.mjs (the daily draft mail). Pure — no
// I/O, no env — so scripts/test-postmail.mjs can unit-test it under Node.
//
// weightedLength() follows twitter-text v3's weighting (the config X uses to
// enforce the 280 limit), implemented here without the npm package because
// this repo runs Pages Functions with zero runtime deps:
//
//   - every code point weighs 2, except these ranges which weigh 1:
//     U+0000–U+10FF (Latin, Greek, Cyrillic, …), U+2000–U+200D, U+2010–U+201F,
//     U+2032–U+2037. So Japanese counts 2 per character.
//   - an emoji (one grapheme, ZWJ sequences included) counts 2 in total.
//   - a URL counts 23 whatever its length (t.co wrapping) — including bare
//     domains like "brypo.com/try", which X auto-links.
//
// The limit is 280 weighted units, i.e. 140 Japanese characters.
//
// Why not _publish.ts's weightedLength(): that one is the thread-chunking
// approximation (CJK block list, every emoji code point = 2, only http(s)
// URLs = 23). It over-counts ZWJ emoji and under-counts bare domains such as
// "brypo.com/try", which the daily draft prompt mentions. A one-tap post
// must not open X's compose screen already over the limit, so this file
// follows twitter-text's own rules; _publish.ts is left as is (its chunking
// budget of 270 absorbs the difference, and its tests pin its behaviour).

export const X_MAX_WEIGHTED = 280;
export const X_URL_WEIGHT = 23;
export const X_INTENT_BASE = "https://x.com/intent/tweet?text=";

const LIGHT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];

// URL-ish runs: explicit http(s) URLs, or bare domains (X auto-links those
// too). ASCII only — X stops a URL at CJK text, so "brypo.com/tryで試せます"
// links just "brypo.com/try". TLDs: common gTLDs plus every 2-letter
// ccTLD-shaped ending.
//
// This errs on the HIGH side on purpose: twitter-text sometimes declines to
// link a bare domain (e.g. a sentence that already contains " /try" earlier),
// and a 2-letter ending like "file.ts" is not always a real TLD. Counting
// those as 23 can only make us trim a draft X would have accepted — never
// open X's compose screen over the limit. Checked against twitter-text 3.1.0
// on 20 strings (scripts/test-postmail.mjs pins the same cases): 19 exact,
// 1 over-count (89 vs 79), 0 under-counts.
const URL_RE =
  /https?:\/\/[\x21-\x7e]+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|info|biz|dev|app|xyz|blog|tech|site|online|page|[a-z]{2})\b(?:\/[\x21-\x7e]*)?/gi;

const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

function codePointWeight(cp: number): number {
  for (const [lo, hi] of LIGHT_RANGES) if (cp >= lo && cp <= hi) return 1;
  return 2;
}

function graphemes(s: string): string[] {
  const seg = new Intl.Segmenter("ja", { granularity: "grapheme" });
  return Array.from(seg.segment(s), (x) => x.segment);
}

function plainWeight(s: string): number {
  let n = 0;
  for (const g of graphemes(s)) {
    if (EMOJI_RE.test(g)) {
      n += 2;
      continue;
    }
    for (const ch of g) n += codePointWeight(ch.codePointAt(0) ?? 0);
  }
  return n;
}

/** X's weighted length of `text` (280 = the post limit). */
export function weightedLength(text: string): number {
  let n = 0;
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const at = m.index ?? 0;
    n += plainWeight(text.slice(last, at)) + X_URL_WEIGHT;
    last = at + m[0].length;
  }
  return n + plainWeight(text.slice(last));
}

/**
 * Fit `text` under `max` weighted units. Returns the text unchanged when it
 * already fits; otherwise cuts whole graphemes from the end and appends "…".
 */
export function fitToWeighted(
  text: string,
  max = X_MAX_WEIGHTED,
): { text: string; trimmed: boolean } {
  const t = text.trim();
  if (weightedLength(t) <= max) return { text: t, trimmed: false };
  const gs = graphemes(t);
  while (gs.length > 0) {
    gs.pop();
    const candidate = gs.join("").trimEnd() + "…";
    if (weightedLength(candidate) <= max) return { text: candidate, trimmed: true };
  }
  return { text: "", trimmed: true };
}

/** X compose ("intent") URL with `text` prefilled. The caller fits it first. */
export function xIntentUrl(text: string): string {
  return X_INTENT_BASE + encodeURIComponent(text);
}
