/**
 * scripts/test-postdraft.mjs
 *
 * Unit tests for the pure helpers in functions/api/_postdraft.ts — the daily
 * /ops post draft: KV keys, the JST countdown, draft validation (the only
 * thing standing between a malformed model response and a half-rendered
 * board), the recent-angle ring, Opus-rate cost accounting, and the prompt
 * builder's grounding contract.
 *
 *   node scripts/test-postdraft.mjs
 *
 * Requires Node >= 22.18 (type-stripped .ts imports). No deps, no network.
 */

import {
  DRAFT_MAX_TOKENS,
  DRAFT_SYSTEM_PROMPT,
  DRAFT_TTL_S,
  L01_END,
  POST_CHAR_LIMIT,
  POST_DRAFT_MODEL,
  RECENT_KEY,
  RECENT_LIMIT,
  buildDraftUserMessage,
  computeDraftCostUsd,
  daysUntil,
  draftKey,
  nextRecent,
  parseRecent,
  toPostDraft,
} from "../functions/api/_postdraft.ts";
import { jstDateKey, parseJsonObject } from "../functions/api/_lib.ts";

// ---- tiny runner ------------------------------------------------------------

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

// ---- KV keys ----------------------------------------------------------------

console.log("unit: post-draft KV keys");
t("draft key is namespaced per JST day", () => {
  eq(draftKey("2026-08-10"), "postdraft:2026-08-10");
  // 08-10 08:00 UTC is already 08-10 17:00 JST; 08-10 23:00 UTC is 08-11 JST.
  eq(draftKey(jstDateKey(new Date("2026-08-10T08:00:00Z"))), "postdraft:2026-08-10");
  eq(draftKey(jstDateKey(new Date("2026-08-10T23:00:00Z"))), "postdraft:2026-08-11");
});
t("recent key is a single rolling entry", () => {
  eq(RECENT_KEY, "postdraft:recent");
});

// ---- countdown --------------------------------------------------------------

console.log("unit: countdown");
t("daysUntil counts whole days and floors at zero", () => {
  eq(daysUntil("2026-08-10", L01_END), 28);
  eq(daysUntil("2026-09-07", L01_END), 0);
  eq(daysUntil("2026-09-30", L01_END), 0, "past the gate");
  eq(daysUntil("garbage", L01_END), 0, "unparseable input");
});

// ---- draft validation -------------------------------------------------------

console.log("unit: draft validation");
t("accepts a well-formed draft and trims it", () => {
  const d = toPostDraft({ text: "  今日は cross-check の閾値を下げた。  ", angle: " 実装の一手 " });
  eq(d, { text: "今日は cross-check の閾値を下げた。", angle: "実装の一手" });
});
t("accepts a fenced JSON response through parseJsonObject", () => {
  const raw = '```json\n{"text":"今日の一歩","angle":"進捗"}\n```';
  eq(toPostDraft(parseJsonObject(raw)), { text: "今日の一歩", angle: "進捗" });
});
t("rejects malformed shapes rather than half-rendering", () => {
  eq(toPostDraft(null), null, "null input");
  eq(toPostDraft(parseJsonObject("not json")), null, "unparseable");
  eq(toPostDraft({ text: "本文だけ" }), null, "missing angle");
  eq(toPostDraft({ angle: "角度だけ" }), null, "missing text");
  eq(toPostDraft({ text: "", angle: "a" }), null, "empty text");
  eq(toPostDraft({ text: "   ", angle: "a" }), null, "whitespace-only text");
  eq(toPostDraft({ text: 42, angle: "a" }), null, "non-string text");
  eq(toPostDraft({ text: "a", angle: ["b"] }), null, "non-string angle");
  eq(toPostDraft({ text: "あ".repeat(401), angle: "a" }), null, "essay, not a post");
  eq(toPostDraft({ text: "a", angle: "あ".repeat(201) }), null, "essay, not an angle");
});
t("tolerates a slightly-over-limit post so it can be trimmed by hand", () => {
  const long = "あ".repeat(POST_CHAR_LIMIT + 10);
  const d = toPostDraft({ text: long, angle: "長め" });
  assert(d !== null, "not rejected");
  assert(d.text.length > POST_CHAR_LIMIT, "the UI is what flags the overage");
});

// ---- recent-angle ring ------------------------------------------------------

console.log("unit: recent-angle ring");
t("parseRecent tolerates absent and corrupt values", () => {
  eq(parseRecent(null), []);
  eq(parseRecent("{"), [], "corrupt JSON");
  eq(parseRecent('{"a":1}'), [], "not an array");
  eq(parseRecent('["a",2,null,"b",""]'), ["a", "b"], "drops non-strings and empties");
});
t("nextRecent prepends, de-duplicates, and caps", () => {
  eq(nextRecent([], "初日"), ["初日"]);
  eq(nextRecent(["b", "a"], "c"), ["c", "b", "a"]);
  eq(nextRecent(["b", "a"], "a"), ["a", "b"], "reused angle moves to the front, not duplicated");
  eq(nextRecent(["a"], "   "), ["a"], "blank angle does not enter the ring");
  const many = Array.from({ length: RECENT_LIMIT + 5 }, (_, i) => `angle-${i}`);
  eq(nextRecent(many, "new").length, RECENT_LIMIT, "capped");
  eq(nextRecent(many, "new")[0], "new", "newest first");
});

// ---- cost accounting --------------------------------------------------------

console.log("unit: cost accounting");
t("draft cost uses the drafting model's own rates, not /try's", () => {
  // Opus 5: $5/M in, $25/M out. 1M in + 1M out = $30.
  eq(computeDraftCostUsd(1_000_000, 1_000_000), 30);
  eq(computeDraftCostUsd(0, 0), 0);
  eq(computeDraftCostUsd(-5, Number.NaN), 0, "garbage usage counts as zero");
});
t("a realistic daily call stays far under the shared cap", () => {
  const cost = computeDraftCostUsd(1200, 400);
  assert(cost > 0 && cost < 0.05, `expected a sub-cent-ish call, got ${cost}`);
});

// ---- prompt grounding -------------------------------------------------------

console.log("unit: prompt grounding");
t("system prompt forbids invented facts and fixes the output shape", () => {
  assert(/ONLY the facts given/.test(DRAFT_SYSTEM_PROMPT), "grounding rule present");
  assert(/Never invent/.test(DRAFT_SYSTEM_PROMPT), "no-invention rule present");
  assert(/OUTPUT LANGUAGE: Japanese/.test(DRAFT_SYSTEM_PROMPT), "output language fixed");
  assert(DRAFT_SYSTEM_PROMPT.includes('"text"') && DRAFT_SYSTEM_PROMPT.includes('"angle"'), "shape stated");
  assert(/140/.test(DRAFT_SYSTEM_PROMPT), "character budget stated");
});
t("user message carries only first-party values", () => {
  const msg = buildDraftUserMessage({
    date: "2026-08-10",
    daysLeft: 28,
    uniqueTryUsers: 1,
    repeatTryUsers: 0,
    recentAngles: ["昨日の角度", "一昨日の角度"],
  });
  assert(msg.includes("2026-08-10"), "date");
  assert(msg.includes("28"), "days left");
  assert(msg.includes(": 1"), "unique users");
  assert(msg.includes("昨日の角度"), "recent angles fed back");
  assert(msg.includes("pick a different one today"), "dedup instruction");
});
t("first run says so instead of listing an empty section", () => {
  const msg = buildDraftUserMessage({
    date: "2026-08-10",
    daysLeft: 28,
    uniqueTryUsers: 0,
    repeatTryUsers: 0,
    recentAngles: [],
  });
  assert(msg.includes("No posts drafted yet"), "first-run wording");
  assert(!msg.includes("pick a different one today"), "no dangling dedup list");
});

// ---- constants sanity -------------------------------------------------------

console.log("unit: constants");
t("defaults are sane", () => {
  assert(POST_DRAFT_MODEL.startsWith("claude-"), "model id looks like a Claude model");
  assert(DRAFT_MAX_TOKENS >= 1000, "headroom for adaptive thinking + the JSON body");
  assert(DRAFT_TTL_S > 28 * 24 * 3600, "cached drafts outlive the L0-1 window");
  eq(POST_CHAR_LIMIT, 140);
});

// ---- summary ----------------------------------------------------------------

process.on("beforeExit", () => {
  console.log(`\nunit result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
});
