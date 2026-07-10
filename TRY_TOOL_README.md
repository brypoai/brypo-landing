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
  (dependency-free validators, raw-text fallback on schema failure) →
  cross-check (never blocks; verbatim claim guard) → spend accumulation.
- Generation prompts are lifted from the app engine
  (`supabase/functions/format-render/index.ts`) with the provenance
  contract (`included_fact_ids` / `numbers_used`) removed; the cross-check
  prompt is adapted from `L2_SYSTEM_PROMPT` (source = pasted text instead
  of OCR).
- The Next.js app (Vercel) and Supabase are untouched. No DB anywhere.

### Language (日英両対応)

The tool is bilingual (English / 日本語). A language toggle in the page
header switches **both** the UI chrome and the generation output language;
the choice is persisted in `localStorage` and defaults to the browser
language (`navigator.language`).

- **UI**: `try/index.html` carries an `I18N` dictionary (`en` / `ja`) and a
  `t(key)` helper. Static elements are tagged `data-i18n` /
  `data-i18n-html` / `data-i18n-placeholder`; dynamic strings and card
  chrome (section headings, cross-check strip, statuses) go through `t()`.
- **Generation**: the page sends `language: "en" | "ja"` on
  `/api/try-generate`. Rather than a translated prompt per format, the
  server appends a short `LANGUAGE` directive (`languageDirective` in
  `_lib.ts`) that fixes every JSON string *value* to the chosen language
  while keeping the schema *keys* in English. The cross-check gets the
  matching `crossCheckLanguageDirective` (its verbatim `claim_text` guard
  already carries the output language). `language` defaults to `"en"` when
  absent, so pre-existing callers are unaffected.
- **Publishing**: `/api/publish` takes the same `language`; the structured
  bullet labels (`Milestone` → `マイルストーン`, etc.) are localized in
  `_publish.ts` while model-authored text stays as generated.

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

## Auto-publish (`/api/publish`)

Turns a generated card into a live post. Wired to the `/try` page as an
owner-only **Publish** button per card (open the "Auto-publish (owner)"
panel, paste the token, pick channels).

```
try/index.html            "Auto-publish (owner)" panel + per-card Publish button
functions/api/publish.ts  POST /api/publish (owner-gated dispatch)
functions/api/_publish.ts pure formatters (content→X thread / plaintext) + OAuth1
scripts/test-publish.mjs  unit tests for the formatters + signer
```

### Why it's owner-gated (read this)

`/try` is **public and login-free**. If publishing were open, any visitor
could post as your account. So `/api/publish`:

- is **off** unless `PUBLISH_ENABLED="true"`, and
- rejects (401) every request whose `X-Publish-Token` header (or `token`
  body field) doesn't match `PUBLISH_TOKEN` (constant-time compare).

The token lives only in the owner's browser memory (never persisted, sent
as a header so it never lands in a body log). Posting is still
**immediate, no review step** — the gate is about *who*, not *whether to
confirm*.

### Channels

| Channel   | What it does | Reaches |
|-----------|--------------|---------|
| `x`       | Native X API v2, OAuth 1.0a. Content is flowed into a **numbered thread**; each tweet replies to the previous. | X (Twitter) |
| `webhook` | POSTs `{ format_type, language, text, content }` to `PUBLISH_WEBHOOK_URL`. | **note, LinkedIn, TikTok, YouTube, blog, …** via a Zapier / Make / n8n scenario you own |

**Honest reality on the other platforms you asked about:**

- **note** has no public write API. **LinkedIn** posting needs an OAuth
  app review. → reach both through the **webhook** → an automation
  platform that has those connectors.
- **TikTok / YouTube are video platforms.** `/try` produces *text*, and
  both APIs require an uploaded video file plus app approval — there is no
  "auto-post this paragraph as a TikTok" path. The webhook still delivers
  the generated copy (caption/description/script), but a **video step** in
  your automation is required before it can post. Not something this
  text tool can do end-to-end.

The webhook channel is the extension point: add any platform there without
touching this repo.

### Env / bindings (add to the existing four)

| Name                     | Kind      | Notes |
|--------------------------|-----------|-------|
| `PUBLISH_ENABLED`        | Plain var | `"true"` to arm; anything else = 503 `code=disabled` |
| `PUBLISH_TOKEN`          | Secret    | long random string; the owner pastes this in the panel |
| `X_API_KEY`              | Secret    | X app consumer key |
| `X_API_SECRET`           | Secret    | X app consumer secret |
| `X_ACCESS_TOKEN`         | Secret    | user access token for the posting account |
| `X_ACCESS_TOKEN_SECRET`  | Secret    | user access token secret |
| `PUBLISH_WEBHOOK_URL`    | Secret    | Zapier / Make / n8n inbound hook (optional) |

### Owner checklist (before first publish)

1. **X developer portal** → create an app for the posting account
   (e.g. @brypoai) with **Read and Write** permission → generate the
   **consumer key/secret** and a **user access token/secret** → paste the
   four `X_*` values into Pages secrets.
2. Set a long random `PUBLISH_TOKEN` (e.g. `openssl rand -hex 32`) and
   `PUBLISH_ENABLED="true"` (both Production + Preview).
3. (Optional) Create a Zapier/Make/n8n inbound webhook and set
   `PUBLISH_WEBHOOK_URL`; map its `text`/`content` fields to note /
   LinkedIn / a video step / etc.
4. Local dev: fill the same keys in `.dev.vars`, `npm run dev`, open
   `/try`, generate, open the owner panel, paste the token, Publish.
5. Run `npm run test:publish` — the formatter/threading/OAuth unit tests
   must pass.

### Publish runbook

- **Stop all publishing now**: set `PUBLISH_ENABLED="false"` → 503.
- **Rotate the owner token**: change `PUBLISH_TOKEN`; the old value 401s
  immediately on the next request.
- **Partial thread**: if X accepts tweet 1 but rejects tweet 3, the
  response reports `posted N/total` and the first tweet's URL so you can
  reconcile by hand — the endpoint does not auto-delete a partial thread.

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
- **KV failures fail OPEN**: if a budget-gate read or rate-limit
  read/write throws (KV incident, or the free plan's 1,000 writes/day
  quota exhausted), the request proceeds without that gate rather than
  taking the endpoint down. The WAF rule and the Anthropic key's $50/mo
  hard cap remain enforced regardless; flip `TRY_TOOL_ENABLED=false` if
  spend must stop immediately during a KV outage.
- **KV write quota vs traffic**: each successful request performs 2 KV
  puts (rate counter + daily spend), so the free plan's 1,000 writes/day
  supports ~500 requests ≈ ~100 full 5-format runs before both gates
  fail open for the rest of the day (the monthly spend key was removed
  to stretch this from ~66 runs). If launch traffic should approach
  `DAILY_BUDGET_USD=25` ≈ 250 runs/day, upgrading to the Workers paid
  plan is a launch prerequisite.
- **Upstream timeouts**: generation calls abort at 60s, cross-check at
  30s (→ 502 `upstream` / `cross_check_skipped`), so a hung upstream
  can't stall requests indefinitely.
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
- **Publish: no cost/rate gate**: `/api/publish` is owner-token-gated, so it
  reuses no KV budget/rate limiting. It's protected by *who can call it*, not
  *how often* — don't share the token.
- **Publish: raw-fallback cards can't post**: a card that degraded to raw
  text has no structured `content`, so no Publish button appears for it.
- **Publish: partial threads aren't rolled back**: an X thread that fails
  midway leaves the already-posted tweets live (the response reports how far
  it got); reconcile by hand.
- **Publish: tweet length is X-weighted**: chunking measures X's *weighted*
  length (`weightedLength` in `_publish.ts`) — CJK/kana/Hangul/fullwidth and
  emoji count as 2, a URL as 23 — so Japanese and emoji/URL-heavy threads stay
  within the 280 cap (a plain-character budget would have over-run it and been
  rejected). The weight table is a close approximation of X's `twitter-text`
  config, biased toward over-counting (never under). Threads over `MAX_TWEETS`
  are truncated with a marker.
- **Publish: no video pipeline**: TikTok/YouTube can only be reached via the
  webhook + your own video-generation step; the text tool cannot post video.
