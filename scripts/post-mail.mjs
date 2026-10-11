#!/usr/bin/env node
/**
 * scripts/post-mail.mjs
 *
 * Once a day, mail the /ops post draft to the owner with a one-tap
 * "X で投稿" link (docs/post-mail.md). Run hourly by
 * .github/workflows/post-mail.yml; this script decides whether the tick is
 * the one that sends.
 *
 *   node scripts/post-mail.mjs                       # what the workflow runs
 *   node scripts/post-mail.mjs --fixture f.json      # offline: no token, no network
 *   node scripts/post-mail.mjs --force               # ignore the send hour / once-a-day check
 *   node scripts/post-mail.mjs --now 2026-10-11T03:30:00Z   # pretend clock (tests)
 *   node scripts/post-mail.mjs --base http://localhost:8788  # against `npm run dev`
 *
 * Env (names only — values live in GitHub Secrets / Variables):
 *   POST_MAIL_MODE         Variable. "live" sends, "off" stops everything,
 *                          anything else (default) = dry_run: write the mail
 *                          to out/post-mail/ and send nothing.
 *   PUBLISH_TOKEN          Secret (already used by x-reply.yml). Reads the
 *                          draft and writes the run log on brypo.com.
 *   RESEND_API_KEY         Secret. Needed only for live.
 *   MAIL_TO                Secret. Recipient. Needed only for live.
 *   MAIL_FROM              Secret, optional. Default: Resend's shared
 *                          onboarding sender (delivers to the Resend account's
 *                          own address without verifying a domain).
 *   POST_MAIL_BLOCK_WORDS  Secret, optional. Comma-separated words a draft
 *                          must never contain (e.g. an employer name).
 *
 * Never printed: the token, the key, the addresses, the block words. The log
 * shows the mode, counts and HTTP statuses only.
 *
 * Requires Node >= 22.18 (type-stripped .ts imports). No deps.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMail, isDue, isLastChance, jstHour, parseBlockWords, parseConfig, parseMode } from "../functions/api/_postmail.ts";
import { alreadyRan, parseLog } from "../functions/api/_postlog.ts";
import { jstDateKey } from "../functions/api/_lib.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "out", "post-mail");
const RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "Brypo drafts <onboarding@resend.dev>";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? "");
}
const has = (name) => process.argv.includes(name);
const log = (msg) => console.log(`[post-mail] ${msg}`);

async function call(cfg, token, method, path, body) {
  try {
    const res = await fetch(`${cfg.base_url}${path}`, {
      method,
      headers: { "X-Publish-Token": token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {}
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: null, error: e?.name ?? "network error" };
  }
}

async function main() {
  const mode = parseMode(process.env.POST_MAIL_MODE);
  if (mode === "off") {
    log("POST_MAIL_MODE=off — stopped (no fetch, no mail).");
    return 0;
  }

  const cfg = parseConfig(JSON.parse(readFileSync(join(ROOT, "scripts", "post-mail.config.json"), "utf8")));
  // Local testing only: point at `npm run dev` (wrangler). https or localhost.
  const base = arg("--base");
  if (base) {
    if (!/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$))/.test(base)) {
      log("--base must be https:// or http://localhost");
      return 1;
    }
    cfg.base_url = base.replace(/\/+$/, "");
  }
  const now = arg("--now") ? new Date(arg("--now")) : new Date();
  const date = jstDateKey(now);
  const hour = jstHour(now);
  const force = has("--force");
  const fixture = arg("--fixture");
  log(`mode=${mode} date=${date} hour=${hour} send_hour=${cfg.send_hour_jst}${force ? " (forced)" : ""}`);

  if (!force && !isDue(hour, cfg)) {
    log("not yet — before today's send hour.");
    return 0;
  }

  const token = process.env.PUBLISH_TOKEN ?? "";
  let draft = null;
  let reason = null;

  if (fixture) {
    const f = JSON.parse(readFileSync(fixture, "utf8"));
    if (typeof f.text === "string" && f.text) draft = { text: f.text, angle: String(f.angle ?? "") };
    else reason = f.reason ?? "fixture has no text";
  } else if (!token) {
    if (mode === "live") {
      log("PUBLISH_TOKEN is not set — cannot fetch the draft. Set the repo secret.");
      return 1;
    }
    reason = "PUBLISH_TOKEN 未設定のため文案を取得していません（dry-run の見本）";
  } else {
    // Once a day: skip if this mode (or a live send) already ran today.
    const got = await call(cfg, token, "GET", "/api/post-log");
    if (got.status === 401) {
      log("post-log: 401 — PUBLISH_TOKEN in Actions does not match Cloudflare Pages.");
      return 1;
    }
    if (got.status === 200 && !force && alreadyRan(parseLog(JSON.stringify(got.data?.log ?? null)), date, mode)) {
      log("already ran today — nothing to do.");
      return 0;
    }
    if (got.status !== 200) log(`post-log: HTTP ${got.status} — continuing without the once-a-day check.`);

    const res = await call(cfg, token, "GET", "/api/post-draft");
    log(`post-draft: HTTP ${res.status}${res.data?.cached ? " (cached)" : ""}`);
    if (res.status === 200 && typeof res.data?.text === "string" && res.data.text) {
      draft = { text: res.data.text, angle: String(res.data.angle ?? "") };
    } else {
      reason = res.data?.reason || res.data?.error || (res.status ? `HTTP ${res.status}` : "接続できませんでした");
      if (!force && !isLastChance(hour, cfg)) {
        log("no draft yet — will retry next hour.");
        return 0;
      }
    }
  }

  const mail = buildMail({ date, draft, reason, cfg, blockWords: parseBlockWords(process.env.POST_MAIL_BLOCK_WORDS) });
  log(
    `built: drafts=${mail.drafts} weighted=${mail.meta.weighted ?? "-"} trimmed=${mail.meta.trimmed}` +
      (mail.meta.guard.length ? ` guard=${mail.meta.guard.length} hit(s)` : ""),
  );

  // Always keep a copy of what was (or would have been) sent. No address in it.
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${date}.html`), mail.html);
  writeFileSync(join(OUT_DIR, `${date}.txt`), `Subject: ${mail.subject}\nTo: (MAIL_TO)\n\n${mail.text}\n`);
  log(`wrote out/post-mail/${date}.html and .txt`);

  if (mode === "live") {
    const key = process.env.RESEND_API_KEY ?? "";
    const to = process.env.MAIL_TO ?? "";
    const missing = [!key && "RESEND_API_KEY", !to && "MAIL_TO"].filter(Boolean);
    if (missing.length) {
      log(`live mode but secret(s) not set: ${missing.join(", ")} — nothing sent.`);
      return 1;
    }
    let res;
    try {
      res = await fetch(RESEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          // Resend drops a repeat of the same key within 24h — a second run on
          // the same day can never mail twice.
          "Idempotency-Key": `post-mail/${date}`,
        },
        body: JSON.stringify({
          from: process.env.MAIL_FROM || DEFAULT_FROM,
          to: [to],
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      log(`resend: ${e?.name ?? "network error"} — nothing sent.`);
      return 1;
    }
    log(`resend: HTTP ${res.status}`);
    if (!res.ok) {
      // Resend's error body names the problem (e.g. unverified sender) without
      // echoing secrets; print only its message field.
      let msg = "";
      try {
        msg = (await res.json())?.message ?? "";
      } catch {}
      log(`resend error: ${String(msg).slice(0, 200)}`);
      return 1;
    }
  } else {
    log("dry_run — nothing sent (set Variable POST_MAIL_MODE=live to send).");
  }

  if (token && !fixture) {
    const rec = await call(cfg, token, "POST", "/api/post-log", { kind: "mail", date, drafts: mail.drafts, mode });
    log(`post-log write: HTTP ${rec.status}`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[post-mail] crashed: ${e?.message ?? e}`);
    process.exit(1);
  },
);
