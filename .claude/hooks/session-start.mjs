#!/usr/bin/env node
// SessionStart hook — リモート（claude.ai/code クラウド）セッションの準備＋環境自己診断（preflight）。
// ローカル実行では何もしない（即 exit 0）。クロスプラットフォーム（Windows/macOS/Linux）。
// ベストエフォート: 失敗してもセッションを止めない（常に exit 0）。
// stdout はセッション冒頭のコンテキストに注入される＝エージェントが「何ができる環境か」を最初から知る。

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

if (process.env.CLAUDE_CODE_REMOTE !== 'true') process.exit(0);

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// --- 依存導入（冪等・クラウドのコンテナキャッシュに乗る） ---
let deps = '対象なし';
if (existsSync(join(cwd, 'package.json'))) {
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd,
    encoding: 'utf8',
    timeout: 540000,
  });
  deps =
    r.status === 0
      ? 'npm install 済'
      : `npm install 失敗: ${(r.stderr || String(r.error || '')).trim().split('\n').slice(-3).join(' / ')}`;
}

// --- Node バージョン（unit テストは Node >= 22.18 の type stripping 必須） ---
const [maj, min] = process.versions.node.split('.').map(Number);
const nodeWarn = maj > 22 || (maj === 22 && min >= 18) ? '' : '\n- 警告: Node < 22.18 のため unit テスト（.ts の type stripping 直接 import）が実行できない';

// --- 能力診断 ---
const chromium = existsSync('/opt/pw-browsers/chromium') ? 'あり' : 'なし';
// fetch はプロキシ env を見ないため curl で疎通確認する（この環境の HTTPS はプロキシ経由）
const probe = spawnSync(
  'curl',
  ['-s', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null', '-m', '4', '-w', '%{http_code}', 'https://brypo.com'],
  { encoding: 'utf8' }
);
const site = (probe.stdout || '').trim() || '000';

console.log(`[remote-preflight] クラウドコンテナ（Linux）で実行中。環境診断:
- 依存: ${deps} / node ${process.version}${nodeWarn}
- 同梱 Chromium: ${chromium} / brypo.com 疎通: HTTP ${site}（000=遮断）
この環境での動き方（CLAUDE.md「リモート/クラウドセッション運用」§6 が正）:
- 検証コマンド（npm test = 依存ゼロの unit 直列）は必ず実行。実行できない検証は PR の「未検証項目」に列挙し、それを理由に停止しない。
- 静的ページの見た目確認は node scripts/verify-ui-remote.mjs "file://$PWD/index.html" "file://$PWD/try/index.html"（同梱 Chromium・開発サーバー不要）。
- ライブ tuning matrix（Anthropic キー）と wrangler dev（KV）はこの環境では不可 → オーナー依頼を PR に明記。secrets（.dev.vars / Cloudflare 側の値）には触れない。`);
process.exit(0);
