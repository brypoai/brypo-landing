<!-- エージェントも人間もこの構成で埋める。レビューはこの「仕様」を基準に差分を評価する。 -->

## 目的 / What

<!-- この PR が解決する Issue と、何を変えたか -->

## 変更点 / Changes

-

## 検証 / How verified

- [ ] `npm test`（crosscheck → publish → xreply → postdraft → drift の unit 直列）green
- [ ] UI（LP / /try）変更あり → `node scripts/verify-ui-remote.mjs "file://$PWD/index.html" "file://$PWD/try/index.html"` で見た目を確認した / UI 変更なし
- [ ] `_prompts.ts` / cross-check 閾値の変更あり → オーナーにライブ tuning matrix の実行を依頼した / 変更なし

## 未検証項目 / Not verified

<!-- 実行環境の制約（リモートセッション: secrets 不在・外部疎通遮断・MCP 不在等）で実行できなかった検証を列挙する。全部実行できたら「なし」と書く -->

- なし

## スコープ確認 / Scope

- [ ] `/try` まわりの変更あり → `TRY_TOOL_README.md` との整合を確認した / 変更なし
- [ ] secrets はキー名のみ扱い、値をコード・コミット・ログに書いていない
- [ ] `package-lock.json` を手編集していない
