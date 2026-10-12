#!/usr/bin/env node
/**
 * scripts/post-notify.mjs
 *
 * Once a day, push the /ops post draft to the owner's phone (ntfy). Tapping
 * the notification opens X's compose screen with the text filled in; the
 * owner posts by hand (docs/post-notify.md). Run every 15 minutes by
 * .github/workflows/post-notify.yml. Each tick books, with ntfy's scheduled
 * delivery, whichever of today's and tomorrow's send hour is not booked yet —
 * so a single tick at any time of day lands the next noon, however late or
 * rarely GitHub's cron fires (today's, if its hour has passed, goes out now).
 *
 *   node scripts/post-notify.mjs                       # what the workflow runs
 *   node scripts/post-notify.mjs --fixture f.json      # offline: no token, no network
 *   node scripts/post-notify.mjs --force               # deliver today's draft right now
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
import {
  buildNotice,
  deliveryDelay,
  isLastChance,
  jstHour,
  parseBlockWords,
  parseConfig,
  parseMode,
  planSlots,
} from "../functions/api/_postnotify.ts";
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
  const nowMs = now.getTime();
  const today = jstDateKey(now);
  const force = has("--force");
  const fixture = arg("--fixture");
  const token = process.env.PUBLISH_TOKEN ?? "";
  const blockWords = parseBlockWords(process.env.POST_NOTIFY_BLOCK_WORDS);
  log(`mode=${mode} today=${today} hour=${jstHour(now)} send_hour=${cfg.send_hour_jst}${force ? " (forced)" : ""}`);

  if (!token && !fixture && mode === "live") {
    log("PUBLISH_TOKEN is not set — cannot fetch the draft. Set the repo secret.");
    return 1;
  }

  /** The draft for `date` (today or tomorrow): { draft } or { reason }. */
  async function getDraft(date) {
    if (fixture) {
      const f = JSON.parse(readFileSync(fixture, "utf8"));
      return typeof f.text === "string" && f.text
        ? { draft: { text: f.text, angle: String(f.angle ?? "") } }
        : { reason: f.reason ?? "fixture has no text" };
    }
    if (!token) return { reason: "PUBLISH_TOKEN 未設定のため文案を取得していません（dry-run の見本）" };
    const res = await call(cfg, token, "GET", `/api/post-draft?date=${date}`);
    log(`${date}: post-draft HTTP ${res.status}${res.data?.cached ? " (cached)" : ""}`);
    if (res.status === 200 && typeof res.data?.text === "string" && res.data.text) {
      return { draft: { text: res.data.text, angle: String(res.data.angle ?? "") } };
    }
    return { reason: res.data?.reason || res.data?.error || (res.status ? `HTTP ${res.status}` : "接続できませんでした") };
  }

  /** Build, keep a copy, send (live) and record one notification. 0 = ok. */
  async function deliver(date, draft, reason, delay) {
    const notice = buildNotice({ date, draft, reason, cfg, blockWords });
    log(
      `${date}: built drafts=${notice.drafts} weighted=${notice.meta.weighted ?? "-"} trimmed=${notice.meta.trimmed}` +
        (notice.meta.guard.length ? ` guard=${notice.meta.guard.length} hit(s)` : ""),
    );
    log(delay ? `${date}: delivery scheduled for ${cfg.send_hour_jst}:00 JST (ntfy delay)` : `${date}: delivery: now`);

    // Keep a copy of what was (or would have been) sent. No topic in it.
    const { drafts, meta, ...fields } = notice;
    const payload = delay ? { ...fields, delay } : fields;
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, `${date}.json`), JSON.stringify({ topic: "(NTFY_TOPIC)", ...payload }, null, 2) + "\n");

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
      log(`${date}: ntfy HTTP ${res.status}`);
      if (!res.ok) {
        let msg = "";
        try {
          msg = (await res.json())?.error ?? "";
        } catch {}
        log(`ntfy error: ${String(msg).slice(0, 200)}`);
        return 1;
      }
    } else {
      log(`${date}: dry_run — nothing sent (config "mode": "live" or Variable POST_NOTIFY_MODE=live to send).`);
    }

    if (token && !fixture) {
      const rec = await call(cfg, token, "POST", "/api/post-log", { kind: "send", date, drafts, mode });
      log(`${date}: post-log write HTTP ${rec.status}`);
      if (rec.status !== 200 && mode === "live") {
        // Sent (or scheduled) but not marked as booked, so the next tick would
        // send it again. Fail the run so it shows red.
        log("post-log write failed after a live send — the next tick may send again; check /api/post-log.");
        return 1;
      }
    }
    return 0;
  }

  // A forced run (workflow_dispatch "force", or by hand): today's draft, now.
  if (force) {
    const { draft, reason } = await getDraft(today);
    return deliver(today, draft ?? null, reason ?? null, null);
  }

  // A normal tick: book whatever of today/tomorrow is not booked yet.
  let isBooked = () => false;
  if (token && !fixture) {
    const got = await call(cfg, token, "GET", "/api/post-log");
    if (got.status === 401) {
      log("post-log: 401 — PUBLISH_TOKEN in Actions does not match Cloudflare Pages.");
      return 1;
    }
    if (got.status === 200) {
      const booked = parseLog(JSON.stringify(got.data?.log ?? null));
      isBooked = (d) => alreadyRan(booked, d, mode);
    } else if (mode === "live") {
      // Without the log we cannot tell what is already booked; ntfy has no
      // idempotency key, so fail closed rather than notify on every tick.
      log(`post-log: HTTP ${got.status} — cannot check bookings; not sending.`);
      return 1;
    }
  }

  const slots = planSlots(nowMs, today, cfg, isBooked);
  if (slots.length === 0) {
    log("today and tomorrow are both booked — nothing to do.");
    return 0;
  }
  let failed = false;
  for (const slot of slots) {
    const { draft, reason } = await getDraft(slot.date);
    if (!draft && !(slot.late && isLastChance(nowMs, today, cfg))) {
      // Plenty of ticks left before this slot is due: try again later.
      log(`${slot.date}: no draft yet (${reason}) — will retry on a later tick.`);
      continue;
    }
    const delay = slot.late ? null : deliveryDelay(nowMs, slot.date, cfg);
    if ((await deliver(slot.date, draft ?? null, reason ?? null, delay)) !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[post-notify] crashed: ${e?.message ?? e}`);
    process.exit(1);
  },
);
