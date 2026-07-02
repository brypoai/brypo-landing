# brypo.com/try — free mini-tool

Free, no-login tool: paste one week of founder notes → five stakeholder
write-ups (investor / X thread / hiring / customer / internal), each with a
text-only cross-check that flags claims the pasted text can't back up.

## Architecture

```
brypo.com (Cloudflare Pages, this repo, static + functions)
├── try/index.html                  single-file page (inline CSS/JS, no build)
├── functions/api/try-generate.ts   POST /api/try-generate (Pages Function)
├── functions/api/_prompts.ts       5 generation prompts + cross-check prompt
├── functions/api/_lib.ts           pure helpers (schemas, parse, sanitize, cost)
└── scripts/test-crosscheck.mjs     unit tests + live tuning matrix
```

- One request per format; the page fires them in parallel and renders each
  card as it resolves (progressive rendering).
- Plain `fetch` to `api.anthropic.com` (no SDK). Model:
  `claude-haiku-4-5-20251001` ($1/M input, $5/M output).
- Server flow per request: kill switch → validation (400/413) → KV daily
  budget gate → hashed-IP hourly backstop rate limit (60/hr) → generation
  (Zod `safeParse`, raw-text fallback on schema failure) → cross-check
  (never blocks; verbatim claim guard) → spend accumulation.
- Generation prompts are lifted from the app engine
  (`supabase/functions/format-render/index.ts`) with the provenance
  contract (`included_fact_ids` / `numbers_used`) removed; the cross-check
  prompt is adapted from `L2_SYSTEM_PROMPT` (source = pasted text instead
  of OCR).
- The Next.js app (Vercel) and Supabase are untouched. No DB anywhere.

### Privacy

Pasted text is processed and discarded: never stored, never logged. The
only log line per request is
`{format_type, status, input_tokens, output_tokens, ms}`. IPs appear only
as truncated SHA-256 hashes inside KV rate-limit keys.

## Env / bindings (Cloudflare Pages → Settings)

| Name                    | Kind       | Value                              | Notes |
|-------------------------|------------|------------------------------------|-------|
| `ANTHROPIC_API_KEY_TRY` | Secret     | dedicated key "brypo-try"          | $50/mo spend limit set in Anthropic Console |
| `TRY_TOOL_ENABLED`      | Plain var  | `"true"`                           | anything else = kill switch (503 `code=disabled`) |
| `DAILY_BUDGET_USD`      | Plain var  | `"5"` (launch day: `"25"`)         | daily cap, UTC day |
| `TRY_KV`                | KV binding | namespace e.g. `brypo-try-usage`   | budget counters + rate-limit counters |

Set all four for **both Production and Preview**.

## Owner checklist (dashboards — do these before first deploy)

1. **Anthropic Console**: create key `brypo-try` with a **$50/month spend
   limit** → paste into Cloudflare Pages secret `ANTHROPIC_API_KEY_TRY`
   (Production + Preview).
2. **Pages vars**: `TRY_TOOL_ENABLED=true`, `DAILY_BUDGET_USD=5`
   (both envs).
3. **KV**: create a namespace (e.g. `brypo-try-usage`) and bind it as
   `TRY_KV` (both envs).
4. **Zone WAF rate-limiting rule**: path `/api/try-generate`,
   30 requests / 10 min / IP → block. (The in-code 60/hr limit is a
   backstop, not a replacement.)
5. Confirm **Pages Functions** are available on the current plan (free
   plan: 100k requests/day shared with Workers — fine for launch).
6. Local dev: copy `.dev.vars.example` → `.dev.vars`, add the key, then
   `npm install && npm run dev` (wrangler serves static + functions with a
   local KV emulation).
7. **Run the live tuning matrix once before launch**:
   `npm run test:crosscheck` (needs the key in `.dev.vars` or env). All
   three cases must pass; if (c) over-flags, tighten the "Do NOT flag"
   list in `functions/api/_prompts.ts`.

## Runbook

- **Launch day**: raise `DAILY_BUDGET_USD` to `25` in Pages → Settings →
  Variables (Production), redeploy not required for env-only changes on
  Functions (new invocations pick it up; if in doubt, re-deploy latest).
- **Kill switch**: set `TRY_TOOL_ENABLED` to `false` → endpoint returns
  503 `code=disabled`; the page shows a friendly state with a waitlist CTA.
- **"Daily reset"** means the **UTC** date changes (09:00 JST). The budget
  key is `usage:YYYY-MM-DD`; monthly aggregate under `usage:YYYY-MM`.
  Inspect current spend: KV namespace → search `usage:`.
- **Budget hit**: users see "hit today's budget — resets daily" + waitlist
  CTA, so capped days still convert.
- **Cost expectations**: ~$0.02 per format (generation + cross-check),
  ~$0.09–0.10 for a full 5-format run. `DAILY_BUDGET_USD=5` ≈ ~50 full
  runs/day; `25` ≈ ~250 runs/day.

## Known limitations

- **KV races**: budget/rate counters are read-modify-write; concurrent
  requests can undercount. Accepted at this scale — the WAF rule, the
  60/hr backstop, and the key's $50/mo hard cap bound the damage.
- **Budget check timing**: the gate checks spend *before* the call, so the
  last requests of the day can overshoot the cap by a few cents.
- **Highlight misses**: flagged claims are matched as exact substrings in
  the rendered fields; if the model echoes a claim that spans two fields
  (or the server-side flattening differs), the inline `<mark>` won't
  attach — the collapsible "Flags (N)" list below the content is the
  catch-all and always shows every flag.
- **Cross-check false positives**: the checker may flag reasonable
  paraphrases as `unsupported` (confidence is surfaced per flag; most
  false positives arrive as `low`). Posture is "surface with confidence
  label", not "block".
- **Public repo files**: Pages serves the repo as-is, so
  `TRY_TOOL_README.md`, `package.json`, and `scripts/` are fetchable at
  brypo.com. They contain no secrets — keep it that way.
- **Schema fallback**: if the model returns non-JSON, the card degrades to
  raw text (`schema_fallback: true`) instead of erroring; cross-check is
  skipped for that run.
