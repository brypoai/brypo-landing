/**
 * scripts/test-crosscheck.mjs
 *
 * Unit tests for the pure helpers in functions/api/_lib.ts, plus a live
 * cross-check tuning harness (runs only when an Anthropic key is
 * available in the environment or in .dev.vars).
 *
 *   node scripts/test-crosscheck.mjs            # unit tests (+ live if key found)
 *   node scripts/test-crosscheck.mjs --unit     # unit tests only
 *   node scripts/test-crosscheck.mjs --runs 5   # live consistency runs per case
 *
 * Live cases (the required tuning matrix):
 *   (a) seeded-contradiction: OUTPUT inflates $4,200 MRR -> $42,000 and
 *       14 tickets -> 140. MUST produce >=1 verdict="contradicted" flag
 *       on the inflated MRR.
 *   (b) faithful: OUTPUT restates the source accurately. Max 1 flag.
 *   (c) tone/hype/plans only: OUTPUT has no specific factual claims.
 *       MUST produce 0 flags.
 *
 * Requires Node >= 23.6 (type-stripped .ts imports) and `npm install`
 * (zod). Uses the same request shape as functions/api/try-generate.ts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CROSS_CHECK_MAX_TOKENS,
  MODEL,
  computeCostUsd,
  dailyUsageKey,
  flattenContentStrings,
  hourlyRateKey,
  monthlyUsageKey,
  parseJsonObject,
  sanitizeFlags,
  stripFences,
  CONTENT_VALIDATORS,
} from "../functions/api/_lib.ts";
import { CROSS_CHECK_SYSTEM_PROMPT } from "../functions/api/_prompts.ts";

// ---- tiny test runner --------------------------------------------------------

let passed = 0;
let failed = 0;
function t(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}
function eq(actual, expected, label = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label} expected ${e}, got ${a}`);
}

// ---- unit tests ----------------------------------------------------------------

console.log("unit: stripFences / parseJsonObject");
t("strips ```json fences", () => {
  eq(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
});
t("strips bare ``` fences", () => {
  eq(stripFences('```\n{"a":1}\n```'), '{"a":1}');
});
t("leaves unfenced text alone", () => {
  eq(stripFences('{"a":1}'), '{"a":1}');
});
t("parseJsonObject parses fenced object", () => {
  eq(parseJsonObject('```json\n{"a":1}\n```'), { a: 1 });
});
t("parseJsonObject rejects arrays", () => {
  eq(parseJsonObject("[1,2]"), null);
});
t("parseJsonObject rejects garbage", () => {
  eq(parseJsonObject("not json at all"), null);
});

console.log("unit: flattenContentStrings");
t("collects nested string leaves in order, joined by newline", () => {
  const flat = flattenContentStrings({
    subject: "June update: $4,200 MRR",
    sections: [{ heading: "Highlights", body: "MRR crossed $4,200 this week." }],
    closing: "Always happy to chat.",
  });
  eq(flat.split("\n"), [
    "June update: $4,200 MRR",
    "Highlights",
    "MRR crossed $4,200 this week.",
    "Always happy to chat.",
  ]);
});
t("drops short artefact strings and _meta", () => {
  const flat = flattenContentStrings({
    a: "USD",
    _meta: { note: "should never appear in output" },
    b: "long enough to keep",
  });
  eq(flat, "long enough to keep");
});

console.log("unit: sanitizeFlags");
const FLAT = "MRR reached $42,000 this week, with 32 paying users.";
t("keeps a valid verbatim flag", () => {
  const raw = JSON.stringify({
    flags: [{
      claim_text: "$42,000",
      verdict: "contradicted",
      kind: "metric",
      reason: "Source says $4,200.",
      confidence: "high",
    }],
  });
  const r = sanitizeFlags(raw, FLAT);
  eq(r.cross_check_skipped, false);
  eq(r.flags.length, 1);
  eq(r.flags[0].verdict, "contradicted");
});
t("drops non-verbatim (paraphrased) claim_text", () => {
  const raw = JSON.stringify({
    flags: [{
      claim_text: "MRR of 42000 dollars",
      verdict: "contradicted",
      kind: "metric",
      reason: "x",
      confidence: "high",
    }],
  });
  eq(sanitizeFlags(raw, FLAT).flags.length, 0);
});
t("drops invalid verdict, coerces unknown kind/confidence", () => {
  const raw = JSON.stringify({
    flags: [
      { claim_text: "$42,000", verdict: "sus", kind: "metric", reason: "x", confidence: "high" },
      { claim_text: "$42,000", verdict: "unsupported", kind: "vibes", reason: "x", confidence: "extreme" },
    ],
  });
  const r = sanitizeFlags(raw, FLAT);
  eq(r.flags.length, 1);
  eq(r.flags[0].kind, "other");
  eq(r.flags[0].confidence, "low");
});
t("non-JSON output -> skipped, never throws", () => {
  const r = sanitizeFlags("I could not check this.", FLAT);
  eq(r.flags.length, 0);
  eq(r.cross_check_skipped, true);
});
t("missing flags array -> skipped", () => {
  const r = sanitizeFlags('{"violations":[]}', FLAT);
  eq(r.cross_check_skipped, true);
});
t("fenced flags JSON is accepted", () => {
  const raw = '```json\n{"flags":[]}\n```';
  const r = sanitizeFlags(raw, FLAT);
  eq(r.cross_check_skipped, false);
  eq(r.flags.length, 0);
});

console.log("unit: cost + KV keys");
t("computeCostUsd: $1/M in + $5/M out", () => {
  eq(computeCostUsd(1_000_000, 0), 1);
  eq(computeCostUsd(0, 1_000_000), 5);
  eq(computeCostUsd(2000, 1000), 0.007);
});
t("computeCostUsd tolerates junk", () => {
  eq(computeCostUsd(NaN, -5), 0);
});
t("KV key builders are UTC-stable", () => {
  const d = new Date("2026-07-02T23:59:59Z");
  eq(dailyUsageKey(d), "usage:2026-07-02");
  eq(monthlyUsageKey(d), "usage:2026-07");
  eq(hourlyRateKey("abcdef0123456789", d), "ip:abcdef0123456789:2026070223");
});

console.log("unit: content validators");
t("customer validator accepts next_steps as string OR array", () => {
  eq(CONTENT_VALIDATORS.customer({ next_steps: "Ship it." }).ok, true);
  eq(CONTENT_VALIDATORS.customer({ next_steps: ["Ship it."] }).ok, true);
});
t("sns validator accepts string and object posts", () => {
  eq(CONTENT_VALIDATORS.sns({ hook: "h", thread: ["a", { text: "b" }] }).ok, true);
});
t("valid investor content passes and round-trips known fields", () => {
  const r = CONTENT_VALIDATORS.investor({
    subject: "June: $4,200 MRR",
    greeting: "Hi all",
    sections: [{ heading: "Highlights", body: "MRR up." }],
    closing: "Cheers",
  });
  eq(r.ok, true);
  eq(r.value.subject, "June: $4,200 MRR");
  eq(r.value.sections, [{ heading: "Highlights", body: "MRR up." }]);
});
t("unknown / misnamed keys are stripped to {} (routes to raw fallback)", () => {
  const r = CONTENT_VALIDATORS.investor({ investor_update: { subject: "x" }, foo: 1 });
  eq(r.ok, true);
  eq(Object.keys(r.value).length, 0);
});
t("wrong-typed present field fails the whole object (-> fallback)", () => {
  eq(CONTENT_VALIDATORS.investor({ subject: 42 }).ok, false); // number, not string
  eq(CONTENT_VALIDATORS.investor({ sections: "not an array" }).ok, false);
  eq(CONTENT_VALIDATORS.investor({ sections: ["stringy element"] }).ok, false);
  eq(CONTENT_VALIDATORS.customer({ next_steps: 5 }).ok, false);
  eq(CONTENT_VALIDATORS.sns({ thread: [42] }).ok, false);
});
t("null present field fails (optional means absent, not null)", () => {
  eq(CONTENT_VALIDATORS.investor({ subject: null }).ok, false);
});
t("non-object input fails", () => {
  eq(CONTENT_VALIDATORS.investor("nope").ok, false);
  eq(CONTENT_VALIDATORS.investor([1, 2]).ok, false);
});
t("empty object validates ok (caller's emptiness check handles fallback)", () => {
  const r = CONTENT_VALIDATORS.internal({});
  eq(r.ok, true);
  eq(Object.keys(r.value).length, 0);
});

console.log(`\nunit result: ${passed} passed, ${failed} failed`);

// ---- live tuning harness -------------------------------------------------------

const SOURCE_TEXT = `Mon: shipped onboarding v2 (new checklist flow). took way longer than planned, ~3 days instead of 1.
Tue: MRR crossed $4,200 (was $3,850 last week). 32 paying users now.
Wed: call with Dana from Northwind — she wants the Slack integration before she'll upgrade the team plan.
Thu: fixed the export bug (CSV columns misaligned when metrics empty). 14 support tickets closed.
Fri: decided to postpone the mobile app until Q4. focus stays on the web dashboard.
Also: signed up 61 new free users this week, mostly from the HN comment.
Plan: ship Slack integration beta by July 15.`;

const CASE_A_OUTPUT = `June update: $42,000 MRR and strong momentum
Hi all —
MRR reached $42,000 this week, up from $3,850 the week before, with 32 paying users.
We closed 140 support tickets after fixing the CSV export bug.
Onboarding v2 shipped after about three days of work.
We decided to postpone the mobile app until Q4 to keep focus on the web dashboard.
Next month we plan to ship the Slack integration beta by July 15.
Always happy to chat — replies welcome.`;

const CASE_B_OUTPUT = `June update: $4,200 MRR, 32 paying users
Hi all —
MRR crossed $4,200 this week, up from $3,850 last week, with 32 paying users. We added 61 new free signups, mostly from a Hacker News comment.
Onboarding v2 shipped with the new checklist flow, taking about three days instead of the planned one.
We fixed the CSV export bug and closed 14 support tickets. Northwind asked for the Slack integration before upgrading to the team plan.
We decided to postpone the mobile app until Q4 so focus stays on the web dashboard.
Next up: shipping the Slack integration beta by July 15.
Always happy to chat — replies welcome.`;

const CASE_C_OUTPUT = `What a week for the team.
We're incredibly energized by the momentum we're seeing.
The product is really coming together and the direction feels right.
We plan to move even faster next month.
Next quarter we're aiming to expand what the product can do.
Onwards — this is just the beginning.`;

const CASES = [
  {
    id: "a-seeded-contradiction",
    output: CASE_A_OUTPUT,
    check(flags, skipped) {
      if (skipped) return "cross-check skipped";
      const hit = flags.some(
        (f) => f.verdict === "contradicted" && f.claim_text.includes("42,000"),
      );
      return hit ? null : "no contradicted flag on the inflated $42,000 MRR";
    },
    expectation: "MUST flag $42,000 as contradicted",
  },
  {
    id: "b-faithful",
    output: CASE_B_OUTPUT,
    check(flags, skipped) {
      if (skipped) return "cross-check skipped";
      return flags.length <= 1
        ? null
        : `${flags.length} flags on a faithful document (max 1 allowed)`;
    },
    expectation: "0-1 flags max",
  },
  {
    id: "c-tone-hype-plans",
    output: CASE_C_OUTPUT,
    check(flags, skipped) {
      if (skipped) return "cross-check skipped";
      return flags.length === 0
        ? null
        : `${flags.length} flags on tone/plans-only text (0 allowed)`;
    },
    expectation: "MUST NOT flag",
  },
];

function findApiKey() {
  for (const name of ["ANTHROPIC_API_KEY_TRY", "ANTHROPIC_API_KEY"]) {
    if (process.env[name]) return process.env[name];
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const devVars = readFileSync(join(here, "..", ".dev.vars"), "utf8");
    const m = devVars.match(/^ANTHROPIC_API_KEY_TRY=(.+)$/m);
    if (m && m[1].trim()) return m[1].trim();
  } catch {
    /* no .dev.vars */
  }
  return null;
}

async function callCrossCheck(apiKey, sourceText, outputText) {
  const userMessage =
    `SOURCE TEXT (ground truth — the founder's pasted notes):\n` +
    `<<<\n${sourceText}\n>>>\n\n` +
    `OUTPUT TEXT (generated document to check):\n` +
    `<<<\n${outputText}\n>>>\n\n` +
    `Return the flags JSON object.`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: CROSS_CHECK_MAX_TOKENS,
      system: CROSS_CHECK_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.content?.find((b) => b.type === "text")?.text ?? "";
  return {
    text,
    input_tokens: data.usage?.input_tokens ?? 0,
    output_tokens: data.usage?.output_tokens ?? 0,
  };
}

async function runLive(apiKey, runsPerCase) {
  console.log(`\nlive: cross-check tuning matrix (${runsPerCase} runs/case, model ${MODEL})`);
  let totalIn = 0;
  let totalOut = 0;
  let liveFailed = 0;
  const matrix = [];

  for (const c of CASES) {
    const results = [];
    for (let i = 0; i < runsPerCase; i++) {
      let failure;
      let flags = [];
      try {
        const { text, input_tokens, output_tokens } = await callCrossCheck(
          apiKey,
          SOURCE_TEXT,
          c.output,
        );
        totalIn += input_tokens;
        totalOut += output_tokens;
        const sanitized = sanitizeFlags(text, c.output);
        flags = sanitized.flags;
        failure = c.check(flags, sanitized.cross_check_skipped);
      } catch (err) {
        failure = `API error: ${err.message}`;
        if (/API 401/.test(err.message)) {
          console.error(`  ${c.id} run ${i + 1}: FAIL — ${failure}`);
          console.error(
            "  aborting live matrix: the key is invalid (check ANTHROPIC_API_KEY_TRY in .dev.vars)",
          );
          return false;
        }
      }
      results.push({ flags, failure });
      const summary = flags
        .map((f) => `[${f.verdict}/${f.confidence}] "${f.claim_text.slice(0, 60)}"`)
        .join(", ");
      console.log(
        `  ${c.id} run ${i + 1}: ${failure ? "FAIL — " + failure : "ok"}` +
          (flags.length ? `  flags: ${summary}` : "  flags: none"),
      );
    }
    const fails = results.filter((r) => r.failure).length;
    if (fails > 0) liveFailed += 1;
    matrix.push({ case: c.id, expectation: c.expectation, passed: runsPerCase - fails, of: runsPerCase });
  }

  console.log("\nlive matrix:");
  for (const row of matrix) {
    console.log(
      `  ${row.passed === row.of ? "PASS" : "FAIL"}  ${row.case}  (${row.passed}/${row.of})  — ${row.expectation}`,
    );
  }
  console.log(
    `live cost: ${totalIn} in + ${totalOut} out tokens ≈ $${computeCostUsd(totalIn, totalOut).toFixed(4)}`,
  );
  return liveFailed === 0;
}

// ---- main ----------------------------------------------------------------------

const unitOnly = process.argv.includes("--unit");
const runsArg = process.argv.indexOf("--runs");
const runsPerCase = runsArg !== -1 ? parseInt(process.argv[runsArg + 1], 10) || 3 : 3;

if (!unitOnly) {
  const apiKey = findApiKey();
  if (!apiKey) {
    console.log(
      "\nlive: skipped — no ANTHROPIC_API_KEY_TRY / ANTHROPIC_API_KEY in env and no .dev.vars",
    );
  } else {
    const ok = await runLive(apiKey, runsPerCase);
    if (!ok) failed += 1;
  }
}

process.exitCode = failed > 0 ? 1 : 0;
