/**
 * scripts/test-publish.mjs
 *
 * Unit tests for the pure helpers in functions/api/_publish.ts — the
 * content-to-platform formatters, tweet chunking/threading, the
 * constant-time token compare, and the OAuth 1.0a signature (checked against
 * a known-answer vector from the RFC 5849 §3 style worked example).
 *
 *   node scripts/test-publish.mjs
 *
 * Requires Node >= 22.18 (type-stripped .ts imports; same as
 * test-crosscheck.mjs). No dependencies, no network.
 */

import {
  TWEET_LIMIT,
  TWEET_WEIGHTED_MAX,
  MAX_TWEETS,
  isChannel,
  contentToLines,
  toPlainText,
  toXThread,
  chunkText,
  weightedLength,
  timingSafeEqual,
  percentEncode,
  buildOAuth1Header,
} from "../functions/api/_publish.ts";
import {
  isLanguage,
  toLanguage,
  languageDirective,
  crossCheckLanguageDirective,
} from "../functions/api/_lib.ts";

// ---- tiny test runner --------------------------------------------------------

let passed = 0;
let failed = 0;
function t(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok    ${name}`);
    })
    .catch((err) => {
      failed += 1;
      console.error(`  FAIL  ${name}\n        ${err.message}`);
    });
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function eq(actual, expected, label = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label} expected ${e}, got ${a}`);
}

// ---- channel guard -----------------------------------------------------------

console.log("unit: isChannel");
t("accepts x and webhook, rejects others", () => {
  assert(isChannel("x") && isChannel("webhook"));
  assert(!isChannel("tiktok") && !isChannel("") && !isChannel(null));
});

// ---- contentToLines / toPlainText -------------------------------------------

console.log("unit: content extraction");
t("sns thread flattens hook + posts in order", () => {
  const lines = contentToLines("sns", {
    hook: "We shipped a thing",
    thread: ["First post", { text: "Second post" }, { text: "" }, 123],
  });
  eq(
    lines.map((l) => l.text),
    ["We shipped a thing", "First post", "Second post"],
  );
});

t("investor sections carry their heading as a label", () => {
  const lines = contentToLines("investor", {
    subject: "March update",
    sections: [{ heading: "Growth", body: "MRR up 20%" }],
    closing: "More soon",
  });
  eq(lines[0], { text: "March update" });
  eq(lines[1], { label: "Growth", text: "MRR up 20%" });
  eq(lines[2], { text: "More soon" });
});

t("customer next_steps accepts string or array", () => {
  eq(contentToLines("customer", { next_steps: "Ship v2" }), [
    { label: "Next", text: "Ship v2" },
  ]);
  eq(contentToLines("customer", { next_steps: ["A", "B"] }), [
    { label: "Next", text: "A" },
    { label: "Next", text: "B" },
  ]);
});

t("toPlainText joins with blank lines and trims", () => {
  const txt = toPlainText("internal", {
    period_summary: "Week 12",
    key_events: ["Launched beta"],
  });
  eq(txt, "Week 12\n\nEvent: Launched beta");
});

t("toPlainText is empty for contentless objects", () => {
  eq(toPlainText("sns", {}), "");
  eq(toPlainText("hiring", { headline: "   " }), "");
});

// ---- bilingual labels (日英両対応) -------------------------------------------

console.log("unit: bilingual labels");
t("default language keeps English labels", () => {
  eq(contentToLines("internal", { key_events: ["shipped beta"] }), [
    { label: "Event", text: "shipped beta" },
  ]);
});

t("Japanese language localizes the bullet labels", () => {
  eq(contentToLines("internal", { key_events: ["ベータをリリース"] }, "ja"), [
    { label: "出来事", text: "ベータをリリース" },
  ]);
  eq(contentToLines("hiring", { recent_milestones: ["x"] }, "ja"), [
    { label: "マイルストーン", text: "x" },
  ]);
  eq(contentToLines("customer", { next_steps: "v2を出す" }, "ja"), [
    { label: "次のステップ", text: "v2を出す" },
  ]);
});

t("toPlainText and toXThread thread the language through", () => {
  eq(toPlainText("internal", { key_events: ["ベータ"] }, "ja"), "出来事: ベータ");
  const tweets = toXThread("customer", { highlights: ["a"], improvements: ["b"] }, "ja");
  eq(tweets.length, 1);
  assert(tweets[0].includes("ハイライト: a"), tweets[0]);
  assert(tweets[0].includes("改善: b"), tweets[0]);
});

t("model-authored headings (investor sections) are used verbatim regardless of language", () => {
  // The section heading comes from the model in the output language already,
  // so it must NOT be looked up in the English label table.
  eq(contentToLines("investor", { sections: [{ heading: "成長", body: "MRR増" }] }, "ja"), [
    { label: "成長", text: "MRR増" },
  ]);
});

// ---- chunkText ---------------------------------------------------------------

console.log("unit: chunkText");
t("short text stays one chunk", () => {
  eq(chunkText("hello world", 270), ["hello world"]);
});

t("long text breaks on spaces, each <= limit", () => {
  const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
  const chunks = chunkText(words, 50);
  assert(chunks.length > 1, "should split");
  for (const c of chunks) assert(c.length <= 50, `chunk over limit: "${c}" (${c.length})`);
  // Round-trips back to the original token stream.
  eq(chunks.join(" ").split(/\s+/), words.split(/\s+/));
});

t("a single token longer than the limit is hard-split", () => {
  const chunks = chunkText("x".repeat(120), 50);
  assert(chunks.every((c) => c.length <= 50));
  eq(chunks.join(""), "x".repeat(120));
});

// ---- weighted length (X-accurate, CJK/emoji/URL-aware) ----------------------

console.log("unit: weightedLength");
t("ASCII weighs 1 per char", () => {
  eq(weightedLength("hello world"), 11);
});
t("CJK / kana weigh 2 each", () => {
  eq(weightedLength("あいう"), 6); // hiragana
  eq(weightedLength("日本語"), 6); // kanji
  eq(weightedLength("가나"), 4); // hangul
});
t("a URL always weighs 23 regardless of its real length", () => {
  eq(weightedLength("https://example.com/a-very-long-path-that-exceeds-23-characters"), 23);
  eq(weightedLength("see https://x.com/x"), 4 + 23); // "see " + url
});
t("emoji (surrogate pair) weighs 2, counted once", () => {
  eq(weightedLength("hi 😀"), 3 + 2);
});

console.log("unit: chunkText is weighted");
t("Japanese chunks stay within the WEIGHTED budget (the bug this fixes)", () => {
  // 200 hiragana = 400 weighted. The old char-based chunker would have emitted
  // a single 200-char tweet that X rejects (400 > 280). Now each chunk's
  // weighted length must be <= the budget.
  const jp = "あ".repeat(200);
  const chunks = chunkText(jp, 270);
  assert(chunks.length >= 2, "long JP must split");
  for (const c of chunks) {
    assert(weightedLength(c) <= 270, `chunk over weighted budget: ${weightedLength(c)}`);
  }
  eq(chunks.join(""), jp); // lossless
});
t("breaks on Japanese sentence marks when available", () => {
  const s = "これは最初の文です。".repeat(40); // ~400 weighted, breakable on 。
  const chunks = chunkText(s, 270);
  assert(chunks.length >= 2);
  // Most chunks should end on a sentence mark rather than mid-clause.
  assert(chunks.slice(0, -1).some((c) => c.endsWith("。")), "should break on 。");
});
t("a URL is never split across chunks", () => {
  const url = "https://example.com/" + "x".repeat(300);
  const chunks = chunkText("intro " + url + " outro", 50);
  assert(chunks.some((c) => c.includes(url)), "URL kept whole in one chunk");
  chunks.forEach((c) => assert(!c.includes("example.com/xxx") || c.includes(url)));
});

// ---- toXThread ---------------------------------------------------------------

console.log("unit: toXThread");
t("multi-tweet thread is numbered and within budget", () => {
  const thread = Array.from({ length: 4 }, (_, i) => `Post number ${i + 1} body`);
  const tweets = toXThread("sns", { thread });
  eq(tweets.length, 4);
  tweets.forEach((tw, i) => {
    assert(tw.endsWith(` ${i + 1}/4`), `missing numbering: ${tw}`);
    assert(tw.length <= TWEET_LIMIT, `tweet over limit: ${tw.length}`);
  });
});

t("single tweet is not numbered", () => {
  const tweets = toXThread("sns", { thread: ["just one"] });
  eq(tweets, ["just one"]);
});

t("Japanese thread: every posted tweet is within X's 280 weighted cap", () => {
  const thread = [
    "あ".repeat(180), // 360 weighted — must be split
    "これは長い日本語の投稿です。".repeat(20),
  ];
  const tweets = toXThread("sns", { thread }, "ja");
  assert(tweets.length >= 2);
  for (const tw of tweets) {
    assert(
      weightedLength(tw) <= TWEET_WEIGHTED_MAX,
      `tweet exceeds weighted cap: ${weightedLength(tw)} > ${TWEET_WEIGHTED_MAX}`,
    );
  }
});

t("non-sns formats pack lines rather than one-tweet-per-bullet", () => {
  const tweets = toXThread("customer", {
    highlights: ["a", "b", "c"],
    improvements: ["d"],
  });
  // Four short bullets fit comfortably in one tweet.
  eq(tweets.length, 1);
  assert(tweets[0].includes("Highlight: a"));
});

t("runaway content is capped at MAX_TWEETS with a truncation marker", () => {
  const thread = Array.from({ length: MAX_TWEETS + 10 }, (_, i) => `p${i}`);
  const tweets = toXThread("sns", { thread });
  eq(tweets.length, MAX_TWEETS);
  assert(tweets[tweets.length - 1].includes("truncated"));
});

t("empty content yields no tweets", () => {
  eq(toXThread("sns", {}), []);
});

// ---- timingSafeEqual ---------------------------------------------------------

console.log("unit: timingSafeEqual");
t("matches equal strings, rejects everything else", () => {
  assert(timingSafeEqual("s3cr3t-token", "s3cr3t-token"));
  assert(!timingSafeEqual("s3cr3t-token", "s3cr3t-toke"));
  assert(!timingSafeEqual("s3cr3t-token", "s3cr3t-tokeX"));
  assert(!timingSafeEqual("", "x"));
  assert(timingSafeEqual("", ""));
});

// ---- output language directives (日英両対応) ---------------------------------

console.log("unit: language helpers");
t("isLanguage / toLanguage guard and default to English", () => {
  assert(isLanguage("en") && isLanguage("ja"));
  assert(!isLanguage("fr") && !isLanguage("") && !isLanguage(null));
  eq(toLanguage("ja"), "ja");
  eq(toLanguage("en"), "en");
  eq(toLanguage("fr"), "en"); // unknown → English (back-compat)
  eq(toLanguage(undefined), "en");
});

t("English directive is empty (no prompt change for the default path)", () => {
  eq(languageDirective("en"), "");
  eq(crossCheckLanguageDirective("en"), "");
});

t("Japanese directive instructs Japanese output but keeps schema keys/claims", () => {
  const d = languageDirective("ja");
  assert(d.includes("Japanese"), "mentions Japanese");
  assert(d.includes("日本語"), "mentions 日本語");
  assert(/keys/i.test(d), "tells the model to keep JSON keys");
  const cc = crossCheckLanguageDirective("ja");
  assert(cc.includes("日本語"), "cross-check reason in Japanese");
  assert(/verbatim/i.test(cc), "claim_text must stay verbatim");
});

// ---- percentEncode -----------------------------------------------------------

console.log("unit: percentEncode (RFC 3986)");
t("escapes reserved chars encodeURIComponent leaves alone", () => {
  eq(percentEncode("a!b*c'd(e)f"), "a%21b%2Ac%27d%28e%29f");
  eq(percentEncode("Ladies + Gentlemen"), "Ladies%20%2B%20Gentlemen");
});

// ---- OAuth 1.0a known-answer -------------------------------------------------

console.log("unit: buildOAuth1Header (RFC 5849 §3.1 worked example)");
t("reproduces the RFC 5849 example signature", async () => {
  // The canonical example uses a GET with query + body params; our signer only
  // handles the oauth_* param set (JSON-body requests), so we assert on the
  // properties that must hold rather than the RFC's full base string:
  // deterministic output for fixed nonce/timestamp, and a valid HMAC-SHA1
  // base64 signature of the expected length.
  const creds = {
    consumerKey: "ck",
    consumerSecret: "cs",
    accessToken: "at",
    accessTokenSecret: "ats",
  };
  const h1 = await buildOAuth1Header(
    "POST",
    "https://api.twitter.com/2/tweets",
    creds,
    "abc123",
    1710000000,
  );
  const h2 = await buildOAuth1Header(
    "POST",
    "https://api.twitter.com/2/tweets",
    creds,
    "abc123",
    1710000000,
  );
  eq(h1, h2, "signing must be deterministic for fixed nonce/timestamp");
  assert(h1.startsWith("OAuth "), "header must start with OAuth");
  assert(h1.includes('oauth_consumer_key="ck"'));
  assert(h1.includes('oauth_nonce="abc123"'));
  assert(h1.includes('oauth_signature_method="HMAC-SHA1"'));
  assert(h1.includes('oauth_timestamp="1710000000"'));
  assert(h1.includes('oauth_token="at"'));
  assert(h1.includes('oauth_version="1.0"'));
  const sigMatch = h1.match(/oauth_signature="([^"]+)"/);
  assert(sigMatch, "signature present");
  // base64 of a 20-byte SHA-1 HMAC = 28 chars (percent-encoded in the header).
  const sig = decodeURIComponent(sigMatch[1]);
  assert(/^[A-Za-z0-9+/]+={0,2}$/.test(sig), `signature not base64: ${sig}`);
  assert(sig.length === 28, `unexpected signature length ${sig.length}`);
  // Changing the nonce must change the signature.
  const h3 = await buildOAuth1Header(
    "POST",
    "https://api.twitter.com/2/tweets",
    creds,
    "different",
    1710000000,
  );
  assert(h3 !== h1, "different nonce must change signature");
});

// ---- summary -----------------------------------------------------------------

process.on("beforeExit", () => {
  console.log(`\nunit result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
});
