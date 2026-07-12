# CLAUDE.md

<!--
Phase D（kokimi28/dev-env#2）でテンプレート標準（kokimi28/template-nextjs）を本リポの実態に
合わせて適用したもの。フレームワーク・ビルド工程なしの静的リポのため、規約は本ファイルに集約する。
-->

## 1. プロジェクト概要

brypo.com の静的ランディングページ + Cloudflare Pages Functions。ビルド工程なし（フレームワーク不使用・各ページは inline CSS/JS の単一 HTML）。

- 静的 LP（`index.html`）: Brypo のティザー / waitlist
- `/try` ミニツール（`try/index.html` + `functions/api/`）: founder notes を貼ると 5 formats（investor / X thread / hiring / customer / internal）を生成し、text-only cross-check で裏付けのない claim をフラグする
- **`/try` 関連（アーキテクチャ・prompts・レート制御・KV・オーナー用 checklist）の正は `TRY_TOOL_README.md`**。`/try` まわりを触る前に必ず読む
- ホスティング: Cloudflare Pages（main への push で自動デプロイ）。KV binding `TRY_KV` を予算・レート制御に使用

## 2. ディレクトリ構成

```
index.html                      LP 本体（inline CSS/JS、ビルドなし）
try/index.html                  /try ミニツール（単一ファイル）
functions/api/
  try-generate.ts               POST /api/try-generate（Pages Function）
  publish.ts                    POST /api/publish（X / webhook への公開）
  _lib.ts                       純粋ヘルパー（validator・parse・sanitize・cost）
  _prompts.ts                   5 生成 prompts + cross-check prompt
  _publish.ts                   公開系の純粋ヘルパー（整形・tweet chunking・OAuth 1.0a）
scripts/
  test-crosscheck.mjs           _lib.ts の unit テスト + ライブ tuning matrix
  test-publish.mjs              _publish.ts / _lib.ts の unit テスト
robots.txt / sitemap.xml / favicon* / og-image*   静的アセット
```

## 3. 使用コマンド

エージェントは実装後に必ず `npm test` を通してから完了とすること。

| 目的                                  | コマンド                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| **一括 unit テスト（実装後に必ず）**  | `npm test`（crosscheck `--unit` → publish を直列）                             |
| cross-check unit のみ                 | `node scripts/test-crosscheck.mjs --unit`                                      |
| cross-check ライブ tuning matrix      | `node scripts/test-crosscheck.mjs`（Anthropic キー必要・オーナーがローカルで） |
| publish unit                          | `node scripts/test-publish.mjs`                                                |
| ローカル開発                          | `npm run dev`（wrangler pages dev・ローカル KV エミュレーション）              |

- unit テストは**依存ゼロ・ネットワーク不要**（`scripts/*.mjs` が `functions/api/*.ts` を Node の type stripping で直接 import する）。**Node >= 22.18 必須**
- ライブ tuning matrix は `_prompts.ts` や cross-check の閾値を変えたときの検証手段。CI では実行しない（キーが必要なため）。prompts を変更する PR ではオーナーにライブ実行を依頼する

## 4. secrets

- **secrets の値はすべて Cloudflare Pages（ダッシュボード）側で管理する。このリポでは値を一切扱わない**（コード・コミット・Issue・PR・ログに書かない。扱うのはキー名のみ）
- キー名の一覧（`ANTHROPIC_API_KEY_TRY` / `PUBLISH_TOKEN` / `X_*` など）と設定手順は `TRY_TOOL_README.md` が正
- ローカル実行用の `.dev.vars` は gitignore 済み。読み取り・コミットしない。新しい env を足すときは `.dev.vars.example` にキー名だけ追記する（値は空）

## 5. 禁止事項

- `main` への直接 push（PR 経由・CI green が必須）。`git push --force` は使わない
- `package-lock.json` を手で編集しない
- `.dev.vars` など実 secrets ファイルの読み取り・コミット
