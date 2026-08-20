#!/usr/bin/env node
// UI 実機確認スクリプト（Playwright MCP の代替・リモートセッション対応）。
// プロジェクトに playwright があればそれを使い console error / pageerror も収集する。
// 無ければ同梱 Chromium（クラウド: /opt/pw-browsers/chromium）の headless CLI で
// スクリーンショットと DOM を取得する（依存追加ゼロ）。
//
// 使い方: 開発サーバーを起動した状態で
//   node scripts/verify-ui-remote.mjs <URL...>
//   例: node scripts/verify-ui-remote.mjs http://localhost:3000/ http://localhost:3000/faq
// 出力: .claude/tmp/ui-<n>.png（スクリーンショット）と ui-<n>.html（DOM）、結果サマリ。
// エラー検出（console error / 空 DOM / 取得失敗）時は exit 1。
// 注意: スクリーンショットは必ず Read ツールで開いて視覚確認すること（取得成功≠表示が正しい）。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const urls = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (urls.length === 0) {
  console.error('usage: node scripts/verify-ui-remote.mjs <URL...>');
  process.exit(2);
}

const outDir = join(process.cwd(), '.claude', 'tmp');
mkdirSync(outDir, { recursive: true });

function findChromiumBinary() {
  const fromEnv = process.env.PLAYWRIGHT_BROWSERS_PATH
    ? join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium')
    : null;
  for (const c of [fromEnv, '/opt/pw-browsers/chromium'].filter(Boolean)) {
    if (existsSync(c)) return c;
  }
  for (const bin of ['chromium', 'chromium-browser', 'google-chrome', 'chrome']) {
    if (spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0) return bin;
  }
  return null;
}

async function loadPlaywright() {
  for (const mod of ['playwright', '@playwright/test', 'playwright-core']) {
    try {
      const pw = await import(mod);
      if (pw?.chromium) return pw;
    } catch {
      /* 次の候補へ */
    }
  }
  return null;
}

const results = [];
const pw = await loadPlaywright();
let browser = null;

if (pw) {
  // pin されたバージョンとブラウザ不一致でも動くよう、既定 → 同梱バイナリの順に試す
  const attempts = [{}];
  if (existsSync('/opt/pw-browsers/chromium')) {
    attempts.push({ executablePath: '/opt/pw-browsers/chromium' });
  }
  for (const opts of attempts) {
    try {
      browser = await pw.chromium.launch({ args: ['--no-sandbox'], ...opts });
      break;
    } catch {
      /* 次の候補へ */
    }
  }
}

if (browser) {
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const shot = join(outDir, `ui-${i + 1}.png`);
    const errors = [];
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const loc = m.location?.();
      errors.push(`console: ${m.text()}${loc?.url ? ` (${loc.url})` : ''}`);
    });
    page.on('requestfailed', (req) =>
      errors.push(`requestfailed: ${req.url()} (${req.failure()?.errorText ?? ''})`)
    );
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    let status = null;
    let title = '';
    let ok = false;
    try {
      const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      status = res?.status() ?? null;
      title = await page.title();
      await page.screenshot({ path: shot, fullPage: true });
      ok = status !== null && status < 400 && errors.length === 0;
    } catch (e) {
      errors.push(`goto: ${e.message}`);
    }
    await page.close();
    results.push({ url, ok, status, title, errors, shot });
  }
  await browser.close();
} else {
  const chromium = findChromiumBinary();
  if (!chromium) {
    console.error(
      '[verify-ui] Chromium が見つからない（playwright も未導入）。この環境では UI 実機確認は不可。PR の未検証項目に記載すること。'
    );
    process.exit(1);
  }
  const base = ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--window-size=1280,900', '--virtual-time-budget=10000'];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const shot = join(outDir, `ui-${i + 1}.png`);
    const domFile = join(outDir, `ui-${i + 1}.html`);
    const errors = [];
    spawnSync(chromium, [...base, `--screenshot=${shot}`, url], { stdio: 'ignore', timeout: 60000 });
    const dump = spawnSync(chromium, [...base, '--dump-dom', url], { encoding: 'utf8', timeout: 60000 });
    const dom = dump.stdout || '';
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(domFile, dom);
    } catch {
      /* DOM 保存はベストエフォート */
    }
    const title = (dom.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
    const shotOk = existsSync(shot) && statSync(shot).size > 1000;
    const domOk = /<html[\s>]/i.test(dom);
    if (!shotOk) errors.push('screenshot 取得失敗または空');
    if (!domOk) errors.push('DOM が空（サーバー未起動 or レンダリング失敗の可能性）');
    results.push({ url, ok: shotOk && domOk, status: null, title, errors, shot });
  }
}

let failed = false;
for (const r of results) {
  const mark = r.ok ? 'OK ' : 'NG ';
  if (!r.ok) failed = true;
  console.log(
    `[verify-ui] ${mark} ${r.url}  title=${JSON.stringify(r.title)}` +
      (r.status !== null ? ` status=${r.status}` : '') +
      `  shot=${r.shot}`
  );
  for (const e of r.errors) console.log(`[verify-ui]      - ${e}`);
}
console.log('[verify-ui] スクリーンショットを Read ツールで開いて視覚確認すること（取得成功≠表示が正しい）。');
process.exit(failed ? 1 : 0);
