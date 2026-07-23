/**
 * scripts/prompt-drift-check.mjs
 *
 * Guards against silent drift between the /try generation prompts
 * (functions/api/_prompts.ts — SYSTEM_PROMPTS + CROSS_CHECK_SYSTEM_PROMPT)
 * and the app engine they were forked from
 * (brypo:supabase/functions/format-render/index.ts).
 *
 * The /try prompts are a hand-maintained fork (see the _prompts.ts
 * header): lifted from the app with three intentional differences —
 * provenance contract removed, mandatory-metric conditioned on input,
 * cross-check SOURCE is pasted text. Nothing keeps the two in sync, so
 * an app-side edit silently fails to propagate. This script makes that
 * LOUD:
 *
 *   Part A (always): fingerprint each /try prompt (the 5 generation
 *     prompts, the cross-check prompt, and the generation injection
 *     guard) and fail if one changed without re-baselining
 *     scripts/prompt-fingerprints.json via `--update`. Catches
 *     landing-side edits.
 *   Part B (only when ../brypo is checked out): compare the persona
 *     opening sentence of each format between app and /try. These must
 *     stay identical — the intentional differences live in later
 *     sentences, never the role line. Catches app-side edits in local
 *     dev. Skipped with a notice in CI (sibling repo absent), where
 *     Part A still holds the line.
 *   Part C (always): assert _prompts.ts still documents the fork
 *     provenance, so the sync relationship stays discoverable.
 *
 *   node scripts/prompt-drift-check.mjs           # check (exit 1 on drift)
 *   node scripts/prompt-drift-check.mjs --update  # re-baseline after a conscious sync
 *
 * No dependencies. Node >= 22.18 (type-stripped .ts import), same posture
 * as the other scripts in this directory.
 */
import {
  SYSTEM_PROMPTS,
  CROSS_CHECK_SYSTEM_PROMPT,
  GENERATION_INJECTION_GUARD,
} from "../functions/api/_prompts.ts";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FP_PATH = join(here, "prompt-fingerprints.json");
const PROMPTS_TS = join(here, "..", "functions", "api", "_prompts.ts");
const APP_FORMAT_RENDER = join(here, "..", "..", "brypo", "supabase", "functions", "format-render", "index.ts");

const norm = (s) => s.replace(/\s+/g, " ").trim();
const fp = (s) => createHash("sha256").update(norm(s)).digest("hex").slice(0, 16);
const firstSentence = (body) => norm(body).split(/(?<=\.)\s/)[0];

/**
 * Persona differences that already exist between app and /try and are
 * accepted as known — baselined so CI stays green, while ANY new or
 * changed persona drift (a pair that differs from what's recorded here)
 * still fails. Pin the exact strings so a later sync (or a further
 * app-side edit) re-trips the check for a fresh decision.
 */
const ACCEPTED_PERSONA_DRIFT = {
  internal: {
    app: "You are an internal-team-note writer for an early-stage startup founder sharing the period's state with the team (Stage 0: solo founder; Stage 1+: 2-10 person team).",
    try: "You are an internal-team-note writer for an early-stage startup founder sharing the period's state with the team.",
    reason: "PRE-EXISTING (found 2026-07-18): app added a Stage 0/1+ team-size parenthetical that was never mirrored to /try. Owner to decide: sync it into _prompts.ts, or keep it as an intentional omission for anonymous /try users.",
  },
};

// The prompt set under guard: the five generation prompts, the cross-check
// prompt, and the generation injection guard. The injection guard is another
// hand-maintained fork of an app-side string (format-render's
// GENERATION_INJECTION_GUARD) appended to every generation prompt at the call
// site (try-generate.ts) — so it drifts on the same silent path as the
// SYSTEM_PROMPTS and belongs under the same fingerprint. It stays out of the
// cross-repo persona check (Part B) because its delimiter wording is a
// documented intentional difference (/try wraps <<<FOUNDER_NOTES>>>, the app
// wraps <<<INTERNAL_VERSION>>>), same as __crosscheck.
const guarded = {
  ...SYSTEM_PROMPTS,
  __crosscheck: CROSS_CHECK_SYSTEM_PROMPT,
  __injection_guard: GENERATION_INJECTION_GUARD,
};
const current = Object.fromEntries(
  Object.keys(guarded).sort().map((k) => [k, fp(guarded[k])]),
);

if (process.argv.includes("--update")) {
  writeFileSync(FP_PATH, JSON.stringify(current, null, 2) + "\n");
  console.log(`✓ re-baselined ${Object.keys(current).length} prompt fingerprints → ${FP_PATH}`);
  process.exit(0);
}

const failures = [];
const warnings = [];

// ---- Part A: /try fingerprint guard (self-contained) ----
if (!existsSync(FP_PATH)) {
  failures.push("no baseline fingerprints — run `node scripts/prompt-drift-check.mjs --update` after confirming /try is synced with the app.");
} else {
  const expected = JSON.parse(readFileSync(FP_PATH, "utf8"));
  for (const k of Object.keys(current)) {
    if (expected[k] !== current[k]) {
      failures.push(`/try prompt "${k}" changed (fingerprint ${expected[k] ?? "∅"} → ${current[k]}). Re-sync against brypo format-render SYSTEM_PROMPTS, then \`--update\`.`);
    }
  }
  for (const k of Object.keys(expected)) {
    if (!(k in current)) failures.push(`/try prompt "${k}" is in the baseline but no longer exported.`);
  }
}

// ---- Part C: provenance header still present ----
const promptsSrc = readFileSync(PROMPTS_TS, "utf8");
if (!/lifted from the app engine/i.test(promptsSrc)) {
  failures.push('_prompts.ts header no longer documents the fork provenance ("lifted from the app engine …"). Keep the sync relationship discoverable.');
}

// ---- Part B: cross-repo persona-line check (only when ../brypo is present) ----
if (existsSync(APP_FORMAT_RENDER)) {
  const app = readFileSync(APP_FORMAT_RENDER, "utf8");
  const appConst = { investor: "INVESTOR_PROMPT", sns: "SNS_PROMPT", hiring: "HIRING_PROMPT", customer: "CUSTOMER_PROMPT", internal: "INTERNAL_PROMPT" };
  for (const [fmt, name] of Object.entries(appConst)) {
    const m = app.match(new RegExp("const " + name + "\\s*=\\s*`([\\s\\S]*?)`;", "m"));
    if (!m) { console.log(`  (skip ${fmt}: app const ${name} not found in format-render)`); continue; }
    const appPersona = firstSentence(m[1]);
    const tryPersona = firstSentence(SYSTEM_PROMPTS[fmt]);
    if (appPersona !== tryPersona) {
      const acc = ACCEPTED_PERSONA_DRIFT[fmt];
      if (acc && acc.app === appPersona && acc.try === tryPersona) {
        warnings.push(`persona diff [${fmt}] is baselined as known — ${acc.reason}`);
      } else {
        failures.push(`persona drift [${fmt}]:\n      app : ${appPersona}\n      /try: ${tryPersona}`);
      }
    }
  }
} else {
  console.log("  (cross-repo persona check skipped: ../brypo not checked out — fingerprint guard still enforced)");
}

if (warnings.length) {
  console.log("! known persona differences (baselined, non-failing):\n" + warnings.map((w) => "  - " + w).join("\n"));
}

if (failures.length) {
  console.error("✗ prompt drift check FAILED:\n" + failures.map((f) => "  - " + f).join("\n"));
  console.error("\nThe /try prompts are a hand-maintained fork of brypo format-render SYSTEM_PROMPTS (see _prompts.ts header).");
  console.error("When the app prompts change: mirror the change here (minus the documented provenance/metric differences), run the live tuning matrix, then re-baseline with `--update`.");
  process.exit(1);
}

console.log(
  `✓ prompt drift check passed (${Object.keys(guarded).length} prompts fingerprinted` +
  (existsSync(APP_FORMAT_RENDER) ? " + cross-repo persona lines aligned" : "") + ")",
);
