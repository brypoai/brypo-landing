#!/usr/bin/env node
/**
 * scripts/post-notify.mjs
 *
 * Once a day, push the /ops post draft to the owner's phone (ntfy). Tapping
 * the notification opens X's compose screen with the text filled in; the
 * owner posts by hand (docs/post-notify.md). Run hourly by
 * .github/workflows/post-notify.yml; this script decides whether the tick is
 * the one that sends.
 *
 *   node scripts/post-notify.mjs                       # what the workflow runs
 *   node scripts/post-notify.mjs --fixture f.json      # offline: no token, no network
 *   node scripts/post-notify.mjs --force               # ignore the send hour / once-a-day check
 *   node scripts/post-notify.mjs --now 2026-10-11T03:30:00Z   # pretend clock (tests)
 *   node scripts/post-notify.mjs --base http://localhost:8788  # against `npm run dev`
 *
 * Mode: config file `mode` ("dry_run" default / "live"), overridden by the
 * Variable POST_NOTIFY_MODE when set ("off" = stop everything). dry_run builds
 * the notification into out/post-notify/ and sends nothing.
 *
 * Env (names only — values live in GitHub Secrets / Variables). Both secrets
 * were already registered for x-reply.yml; nothing new to set up:
 *   PUBLISH_TOKEN            reads the draft / writes the run log on brypo.com
 *   NTFY_TOPIC               the owner's ntfy topic (live only)
 *   POST_NOTIFY_BLOCK_WORDS  optional: comma-separated words a draft must never
 *                            contain (e.g. an employer name)
 *
 * Never printed: the token, the topic, the block words. The log shows the
 * mode, counts and HTTP statuses only.
 *
 * Requires Node >= 22.18 (type-stripped .ts imports). No deps.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNotice, isDue, isLastChance, jstHour, parseBlockWords, parseConfig, parseMode } from "../functions/api/_postnotify.ts";
import { alreadyRan, parseLog } from "../functions/api/_postlog.ts";
import { jstDateKey } from "../functions/api/_lib.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "out", "post-notify");
const NTFY_URL = "https://ntfy.sh/";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? "");
}
const has = (name) => process.argv.includes(name);
const log = (msg) => console.log(`[post-notify] ${msg}`);

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
  const cfg = parseConfig(JSON.parse(readFileSync(join(ROOT, "scripts", "post-notify.config.json"), "utf8")));
  const mode = parseMode(process.env.POST_NOTIFY_MODE, cfg.mode);
  if (mode === "off") {
    log("POST_NOTIFY_MODE=off — stopped (no fetch, no notification).");
    return 0;
  }
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
    if (got.status !== 200 && mode === "live" && !force) {
      // Without the log we cannot tell whether today already went out; ntfy
      // has no idempotency key, so fail closed rather than notify every hour.
      log(`post-log: HTTP ${got.status} — cannot check today's run; not sending.`);
      return 1;
    }
    if (got.status === 200 && !force && alreadyRan(parseLog(JSON.stringify(got.data?.log ?? null)), date, mode)) {
      log("already ran today — nothing to do.");
      return 0;
    }

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

  const notice = buildNotice({ date, draft, reason, cfg, blockWords: parseBlockWords(process.env.POST_NOTIFY_BLOCK_WORDS) });
  log(
    `built: drafts=${notice.drafts} weighted=${notice.meta.weighted ?? "-"} trimmed=${notice.meta.trimmed}` +
      (notice.meta.guard.length ? ` guard=${notice.meta.guard.length} hit(s)` : ""),
  );

  // Keep a copy of what was (or would have been) sent. No topic in it.
  const { drafts, meta, ...payload } = notice;
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${date}.json`), JSON.stringify({ topic: "(NTFY_TOPIC)", ...payload }, null, 2) + "\n");
  log(`wrote out/post-notify/${date}.json`);

  if (mode === "live") {
    const topic = process.env.NTFY_TOPIC ?? "";
    if (!topic) {
      log("live mode but secret not set: NTFY_TOPIC — nothing sent.");
      return 1;
    }
    let res;
    try {
      res = await fetch(NTFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, ...payload }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      log(`ntfy: ${e?.name ?? "network error"} — nothing sent.`);
      return 1;
    }
    log(`ntfy: HTTP ${res.status}`);
    if (!res.ok) {
      let msg = "";
      try {
        msg = (await res.json())?.error ?? "";
      } catch {}
      log(`ntfy error: ${String(msg).slice(0, 200)}`);
      return 1;
    }
  } else {
    log('dry_run — nothing sent (config "mode": "live" or Variable POST_NOTIFY_MODE=live to send).');
  }

  if (token && !fixture) {
    const rec = await call(cfg, token, "POST", "/api/post-log", { kind: "send", date, drafts, mode });
    log(`post-log write: HTTP ${rec.status}`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[post-notify] crashed: ${e?.message ?? e}`);
    process.exit(1);
  },
);
