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

- **Auto-detect**: until the user picks a language explicitly (clicks the
  toggle, or has a saved preference), the tool detects the pasted notes'
  language on Generate (`detectTextLang`: CJK kana/kanji → `ja`, Latin →
  `en`) and switches to match, so Japanese notes produce Japanese output even
  with an English browser. An explicit toggle **locks** the choice
  (`state.langLocked`) and auto-detect no longer overrides it.

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
| `PUBLISH_DAILY_LIMIT`    | Plain var | max publishes per UTC day (default `50`); `TRY_KV` must be bound for it to apply |

> The rate gate reuses the `TRY_KV` binding (counter key `publish:YYYY-MM-DD`).
> If `TRY_KV` isn't bound to this Function, the gate is skipped (the token
> stays the only gate). Bind the same namespace `/try` already uses.

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

**Before your first real post, use "Test connection"** (owner panel, next to
the token field). It sends `{verify:true}` to `/api/publish`, which makes a
signed **GET /2/users/me** (no tweet posted) and reports the authenticated
`@handle` so you can confirm *which account* would post, plus which setup
mistake to fix if the keys are wrong:

- `401` → keys/tokens rejected (re-check all four; regenerate the access token
  if you changed app permissions after creating it).
- `403` → authenticated but forbidden (app lacks Read+Write, or the account
  has no X API credit).
- read-only token → flagged explicitly (`x-access-level: read`).

Note: X does **not** guarantee the `x-access-level` header on the v2 endpoint.
When it's absent, verify reports "keys valid, write not confirmed" rather than
over-promising — a truly conclusive write check is only possible by posting.

### Publish runbook

- **Stop all publishing now**: set `PUBLISH_ENABLED="false"` → 503.
- **Rotate the owner token**: change `PUBLISH_TOKEN`; the old value 401s
  immediately on the next request.
- **Adjust the daily cap**: change `PUBLISH_DAILY_LIMIT` (env-only, no
  redeploy needed). A day's count lives in `TRY_KV` under
  `publish:YYYY-MM-DD`; delete that key to reset a day early.
- **Partial thread**: if X accepts tweet 1 but rejects tweet 3, the
  response reports `posted N/total` and the first tweet's URL so you can
  reconcile by hand — the endpoint does not auto-delete a partial thread.

## Metrics snapshot (`/api/metrics`, D-1)

Owner-gated, read-only distribution KPIs for Go/No-Go #1 (docs/18 §3 Track D,
§9.1). `GET /api/metrics` with header `X-Publish-Token: <PUBLISH_TOKEN>` (same
token as publish; no new secret) returns:

- **X followers**: `followers_count` via the same `GET /2/users/me` verify
  path, plus `user.fields=public_metrics` (uses the existing `X_*` creds).
- **/try usage**: today's `publish:YYYY-MM-DD` count and `usage:YYYY-MM-DD`
  USD spend from `TRY_KV`.
- **waitlist**: signup count via the **Tally API** when `TALLY_API_KEY` is set
  (Tally → Settings → API keys; `GET api.tally.so/forms/{id}/submissions` →
  `totalNumberOfSubmissionsPerFilter.all`; form id defaults to the LP embed
  `dWQlbq`, override with `TALLY_FORM_ID`). Key unset or fetch failed →
  `null`, and the log row falls back to a fill-by-hand cell (docs/18 §9.2).
  One-time owner setup: create a Tally API key and add `TALLY_API_KEY` in
  Cloudflare Pages → Settings → Variables (Production).

**Recommended: fully unattended.** The brypo repo's weekly Actions workflow
(`.github/workflows/metrics-snapshot.yml`) calls this endpoint every Monday
09:00 JST and opens a PR appending the row to `docs/METRICS_LOG.md` — with
`TALLY_API_KEY` set, no manual step remains. Manual fallback:

```
PUBLISH_TOKEN=… node scripts/metrics-snapshot.mjs [--base https://brypo.com]
```

The token comes from `$PUBLISH_TOKEN` (never argv); the full JSON goes to
stderr, the single Markdown row to stdout. Unlike `/api/publish`, this
endpoint has no daily cap or `PUBLISH_ENABLED` gate (read-only); the constant-
time `PUBLISH_TOKEN` check is the only guard.

## Reply engine (`/api/x-reply/*`) — growth (distribution)

Owner-gated auto-reply engine for @kokibuilds growth (strategy: dev-env
`docs/dev-env/x-growth-strategy.md`; spec: `docs/specs/x-reply-engine/spec.md`).
Reuses the `X_*` creds, `ANTHROPIC_API_KEY_TRY`, and `PUBLISH_TOKEN`. **No
per-reply human approval** (owner decision 2026-07-22) — deterministic
guardrails in `functions/api/_xreply.ts` are the safety layer.

- `POST /api/x-reply/run` — one pass: discover (`GET /2/tweets/search/recent`,
  or explicit `targets`) → LLM draft → guardrails (weighted-length, no-link,
  NG-word, trigram-similarity vs recent, idempotency) → `POST /2/tweets`
  reply → daily cap. `dry_run:true` drafts without sending. Header
  `X-Publish-Token: <PUBLISH_TOKEN>`.
- `GET /api/x-reply/digest?date=YYYY-MM-DD` — owner readout of sends/skips.

**OFF by default.** Nothing runs until `X_REPLY_ENABLED="true"`. Live discovery
needs a **funded X read tier** (pay-per-use; owner sets billing in the X
developer portal) — but `targets:[{id,authorHandle,text}]` replies to
hand-picked posts with no read call, so it works before billing is set up.

| Key | Type | Purpose |
| --- | ---- | ------- |
| `X_REPLY_ENABLED`   | Plain var | `"true"` to arm; anything else = 503 `code=disabled` (kill switch) |
| `X_REPLY_DAILY_CAP` | Plain var | Max auto-sent replies per UTC day (optional; default 20) |
| `X_REPLY_NG_WORDS`  | Plain var | Comma-separated words that drop a draft (optional) |
| `X_REPLY_MODEL`     | Plain var | Override drafting model (optional; default = /try Haiku) |

- **Stop all replies now**: `X_REPLY_ENABLED="false"` → 503.
- **Calibrate the prompt**: run with `dry_run:true`, then read `/api/x-reply/digest`.
- **`max_sends`** (body, optional): per-run send ceiling, ≤ the daily cap. The
  scheduler passes a small value so replies trickle out instead of bursting.
- KV keys (namespace `TRY_KV`): `xreply:count:YYYY-MM-DD` (daily cap),
  `xreply:seen:<id>` (already replied), `xreply:recent` (similarity corpus),
  `xreply:digest:YYYY-MM-DD` (owner log), `xreply:idem:<hash>` (dedup).

### Scheduling (`.github/workflows/x-reply.yml`)

A GitHub Actions cron (every 4h, `max_sends=2` → ~12/day, under the daily cap)
POSTs to `/api/x-reply/run` — same pattern as the metrics snapshot, no
Cloudflare cron binding needed. It **no-ops safely** until armed: it skips when
the `PUBLISH_TOKEN` repo secret is unset, and logs "disabled" while the
endpoint returns 503. `workflow_dispatch` runs it on demand (with a `dry_run`
toggle for calibration).

### Arming the engine (owner — one-time)

1. **Fund the X read tier** (pay-per-use) in the X developer portal, so
   `GET /2/tweets/search/recent` works. *(Skippable at first: POST
   `{"targets":[{id,authorHandle,text}]}` replies to hand-picked posts with no
   read call.)*
2. **Cloudflare Pages → Settings → Variables** (Production + Preview): set
   `X_REPLY_ENABLED="true"`. Optional: `X_REPLY_DAILY_CAP`, `X_REPLY_NG_WORDS`.
   ⚠️ **Pages env changes only take effect on a NEW deployment** — after setting
   it, redeploy (Deployments → latest Production → Retry deployment, or push any
   commit to `main`). The running deployment keeps the vars it was built with,
   so `/api/x-reply/run` stays `503 disabled` until you redeploy.
3. **GitHub → Settings → Secrets and variables → Actions**: add `PUBLISH_TOKEN`
   (same value as the Cloudflare Pages secret) so the cron can authenticate.
4. **Calibrate first (recommended)**: Actions → x-reply → *Run workflow* with
   `dry_run=true`, then `GET /api/x-reply/digest` and tune the prompt in
   `functions/api/_xreply.ts` (`REPLY_SYSTEM_PROMPT`) if needed.
5. Leave the schedule on. To pause everything later: `X_REPLY_ENABLED="false"`.

### Full URLs (copy-paste)

**Endpoints** (production; live after PR #18 merges to `main`):
- `POST https://brypo.com/api/x-reply/run`
- `GET  https://brypo.com/api/x-reply/digest`

Branch preview (live now on the PR branch, if Preview env has the vars set):
- `https://claude-brypo-progress-0tbj9v.brypo-landing.pages.dev/api/x-reply/run`

**Arming pages** (the three owner switches):
- Fund X read tier → `https://developer.x.com/en/portal/dashboard`
- Cloudflare Pages env (`X_REPLY_ENABLED` etc.) → `https://dash.cloudflare.com/a26fbe7215ac6be590cdc325beb62c3a/pages/view/brypo-landing/settings/environment-variables`
- GitHub Actions secret (`PUBLISH_TOKEN`) → `https://github.com/brypoai/brypo-landing/settings/secrets/actions`
- Run the cron manually / `dry_run` → `https://github.com/brypoai/brypo-landing/actions/workflows/x-reply.yml`

**curl** (`$PUBLISH_TOKEN` = the Cloudflare Pages publish token; never inline the value):

```sh
# 1) calibrate — draft + guardrails, send nothing
curl -sS -X POST https://brypo.com/api/x-reply/run \
  -H "X-Publish-Token: $PUBLISH_TOKEN" -H "Content-Type: application/json" \
  -d '{"dry_run": true, "max_sends": 2}'

# 2) read today's digest (what it drafted / would send / skipped)
curl -sS "https://brypo.com/api/x-reply/digest" \
  -H "X-Publish-Token: $PUBLISH_TOKEN"

# 3) live one-off — send up to 2 replies now
curl -sS -X POST https://brypo.com/api/x-reply/run \
  -H "X-Publish-Token: $PUBLISH_TOKEN" -H "Content-Type: application/json" \
  -d '{"max_sends": 2}'

# 4) seed hand-picked targets — works BEFORE funding the read tier
curl -sS -X POST https://brypo.com/api/x-reply/run \
  -H "X-Publish-Token: $PUBLISH_TOKEN" -H "Content-Type: application/json" \
  -d '{"max_sends": 1, "targets": [
        {"id":"1890000000000000000","authorHandle":"somefounder","text":"just shipped v2 after 3 months solo"}
      ]}'
```

## Runbook

- **Launch day**: raise `DAILY_BUDGET_USD` to `25` in Pages → Settings →
  Variables (Production), then **redeploy** — Pages env changes only take
  effect on a new deployment; the running deployment keeps its build-time vars.
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

## Drift audit vs the app engine (C-5, 2026-07-14)

The 5 generation prompts and the cross-check prompt in `_prompts.ts` are
**manual copies** of the app engine (`brypo` repo,
`supabase/functions/format-render/index.ts`) — this section is the
required audit whenever the app's prompts/L2 evolve (brypo CLAUDE.md §4,
brypo docs/18 §3 C-5). Audited at brypo `c7573c2` ⇄ landing `0898df3`.

### Intentional adaptations (no action — re-verify, don't "fix")

| Area | Difference | Why intentional |
|---|---|---|
| All 5 generation prompts | Provenance contract removed (`included_fact_ids` / `numbers_used` and every rule referencing them) | /try feeds raw pasted text; there are no fact ids (documented in `_prompts.ts` header) |
| investor / sns | "MUST contain a metric" → conditioned on the input containing one | Raw text has no guaranteed metrics; unconditional demand pressures invention |
| hiring | `application_link` placeholder URL → "only if the input contains one, else empty" | brypo.com placeholder would be wrong for arbitrary /try founders |
| customer | `next_steps` string → array | Aligned to the app's Zod schema, which was already array (`_lib.ts` note) |
| internal | "role distinction" block removed | No Internal Version row exists in /try |
| Cross-check | paragraphs-vs-OCR reframed to output-vs-source; `paragraph_location` → verbatim `claim_text` (non-verbatim discarded); `kind` taxonomy added | No paragraph array / OCR in /try; verbatim guard is the L2 unknown-location-drop equivalent |
| /try has no pass/fail gate | App computes `cross_check_passed` (B-7 v2); /try returns flags only | /try is advisory; there is no persisted deliverable to gate |
| Model / tokens | — | Exact match: `claude-haiku-4-5-20251001`, generation 4096 / cross-check 2048 |

### Fixes applied (PR #9, 2026-07-14)

1. **Generation injection guard (C-1 port)** — the generation call passed
   `sourceText` raw (the repo's only unguarded LLM input path).
   Now: `GENERATION_INJECTION_GUARD` suffix + `<<<FOUNDER_NOTES>>>`
   delimiters, matching the app's `GENERATION_INJECTION_GUARD` posture.
2. **B-7 display tiering** — all flags used to render with equal weight;
   `unsupported` + low-confidence flags are the dominant false-positive
   source (the exact B-7 insight). Now: `isCriticalFlag` = `contradicted`
   × high/medium (same predicate as the app's `isBlockingL2Violation`);
   cc-strip counts critical vs advisory separately, the flags list sorts
   critical first and dims advisory, inline `<mark>`s are lighter for
   advisory. Still no gate.

### Reverse drift — the APP should adopt landing

**Status: back-ported in brypo #14 (2026-07-14)** — both points below are
now in the app's `L2_SYSTEM_PROMPT` (format-render deployed to dev;
dogfood verdict check recommended on next generate). Kept for the record:

1. Landing flags *invented specifics inside forward-looking sentences*
   (a made-up "launching August 3" is unsupported even in future tense);
   app L2 rule 4 exempts ALL forward-looking statements.
2. Landing checks claims in *subjects / titles / headlines / hooks*; app
   L2 rule 5 says "Do NOT flag headings, titles" — in latent tension with
   the app's own investor prompt requiring a metric in the subject (a
   wrong subject metric would go unflagged).

One cosmetic note: landing's investor Metrics body dropped the app's
"+ bulleted list of the key metric facts" formatting hint — judged
intentional (free-string field, not load-bearing).

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
- **Publish: rate gate is a daily count, fail-open**: `/api/publish` caps
  publishes at `PUBLISH_DAILY_LIMIT`/UTC-day via `TRY_KV` (429 `code=rate_limit`)
  to bound a leaked token. Like the /try gates it's read-modify-write (a
  concurrent burst can under-count) and **fails open** if KV is down or unbound
  — the token and X's own API limits remain the hard backstops. It's a
  runaway/leak backstop, not a fairness quota; still, don't share the token.
- **Publish: raw-fallback cards can't post**: a card that degraded to raw
  text has no structured `content`, so no Publish button appears for it.
- **Publish: partial threads aren't rolled back**: an X thread that fails
  midway leaves the already-posted tweets live (the response reports how far
  it got); reconcile by hand.
- **Publish: 503-only retry, bounded double-post risk**: a tweet that fails
  with HTTP `503` is retried once (up to `MAX_X_RETRIES` per request, 1.5s
  apart) so a brief X hiccup doesn't kill a thread. `429`/`500`/`502`/timeouts
  are **not** retried (rate-limit windows are minutes, and those outcomes are
  ambiguous — a blind retry could double-post). Residual risk: `503` *should*
  mean "not processed", but if X returned it after the write committed, the
  retry would post one duplicate. Rare and HTTP-noncompliant; accepted.
- **Verify is unmetered**: `{verify:true}` (Test connection) is read-only
  (`GET /2/users/me`, no post), so it skips the daily rate-limit and
  idempotency gates. Owner-token-gated, so the token remains the only gate on
  it; a leaked token could call users/me freely (cheap, but counts toward the
  account's X API usage).
- **Publish: idempotency is best-effort**: an identical publish (same
  format + language + channels + content) within `IDEM_TTL_S` (10 min) is
  deduped via a content-hash key in `TRY_KV` → `409 code=duplicate`, which
  stops a double-click or a lost-response retry from posting twice. The key is
  kept only on full success (a failed attempt releases it so you can retry).
  KV has no atomic compare-and-set, so two *simultaneous* identical requests
  can still both slip through — the client disables the button while a request
  is in flight, which covers that common case. To deliberately re-post the
  exact same text, wait out the window or change a character.
- **Publish: tweet length is X-weighted**: chunking measures X's *weighted*
  length (`weightedLength` in `_publish.ts`) — CJK/kana/Hangul/fullwidth and
  emoji count as 2, a URL as 23 — so Japanese and emoji/URL-heavy threads stay
  within the 280 cap (a plain-character budget would have over-run it and been
  rejected). The weight table is a close approximation of X's `twitter-text`
  config, biased toward over-counting (never under). Threads over `MAX_TWEETS`
  are truncated with a marker.
- **Publish: no video pipeline**: TikTok/YouTube can only be reached via the
  webhook + your own video-generation step; the text tool cannot post video.
