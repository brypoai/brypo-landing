# spec: x-reply-engine（@kokibuilds 成長のためのリプライ起草・承認・送信）

- 版: v0.2（2026-07-22・設計のみ。**送信は auto**〔👤 決定「基本承認なし」〕。有効化・読取課金は 👤 判断後。X Premium 加入済み）
- 戦略の正本: dev-env `docs/dev-env/x-growth-strategy.md`
- 前提: `TRY_TOOL_README.md`（`/api/publish` のアーキテクチャ・OAuth・KV・レート制御が正）

## 0. 目的

Go/No-Go #1（2026-11-01・X フォロワー 300+）の律速 = distribution。その最大ドライバである
**リプライ**を「AI 起草 → 決定的ガードレール → auto 送信」の 3 層で回す（逐次の人手承認は無し＝
2026-07-22 👤 決定。安全弁は kill switch + rate cap + 類似度ガード）。いいね・フォローは
2026-04-20 の X 仕様変更で **Enterprise 専用（~$42k/月）** となったため本スコープに含めない
（👤 が手動運用）。

## 1. スコープ

### やること
- **reply 対象の取得**（読取）: ICP（build-in-public founder）の直近投稿を検索して候補化。
- **リプ起草**（AI）: 候補ツイートの文脈を読み、証拠ベースの短い付加価値リプを起草。
- **ガードレール（決定的）**: rate cap・kill switch・類似度/リンク/NG 語チェックを通過した下書きのみ送信対象に。
- **auto 送信**: 通過分を `POST /2/tweets`（`reply.in_reply_to_tweet_id`）で送信（人手承認なし）。
- **事後ダイジェスト**（任意・初期のみ）: 送ったリプ一覧を owner が読める形で残し、prompt 微調整に使う。
- **rate guard + 冪等ガード**: 日次上限・同一ツイートへの二重リプ防止。

### やらないこと（非スコープ）
- いいね / フォロー / 引用ポストの API 操作（Enterprise 専用・§戦略 doc §1）。
- 逐次の人手承認キュー（2026-07-22 👤 決定で不採用。安全弁はガードレール層）。
- 自動 DM。
- 新規テーブル・永続 DB（KV のみ。`/try` と同じく状態は最小）。

## 2. 既存資産の再利用（新規実装を最小化）

| 必要機能 | 既存 | 追加 |
|---|---|---|
| OAuth1.0a 署名 | `_publish.ts` `buildOAuth1Header` | 流用 |
| **reply 送信** | `publish.ts` `postTweet(creds, text, replyToId)` は既に `in_reply_to_tweet_id` 対応 | 流用（replyToId に対象ツイート id） |
| token gate | `PUBLISH_TOKEN` + `timingSafeEqual` | 流用 |
| 日次上限 / 冪等 | `publishUsageKey` / `idempotencyPayload` パターン | reply 用キーを追加 |
| リプ本文の 280 制限整形 | `chunkText` / `weightedLength` / `trimToWeight` | 流用（リプは原則 1 tweet） |

→ **新規は「読取（対象取得）」「起草 prompt」「承認キュー」の 3 点のみ**。送信路は既存を流用。

## 3. エンドポイント設計（Pages Functions）

すべて owner token gate（`X-Publish-Token` / body.token = `PUBLISH_TOKEN`）。無認証 401。

### `POST /api/x-reply/discover`（読取・候補取得）
- 入力: `{ token, queries?: string[], max?: number }`（既定 queries は ICP キーワード群）。
- 動作: `GET /2/tweets/search/recent`（従量課金・$0.005/読取）で候補を取得。自分の過去リプ済み id・
  ミュート語・過度に古い投稿を除外。KV `x-reply:seen:<tweetId>` で既処理を弾く。
- 出力: `{ candidates: [{ id, authorHandle, text, url }] }`（**本文以外の PII は保持しない**）。

### `POST /api/x-reply/draft`（起草・AI）
- 入力: `{ token, candidates: [...] }`。
- 動作: 候補ごとに reply prompt（§4）で 1 リプ起草。**起草は読取専用の思想**（secrets 非接触の
  純関数＋LLM 呼び出しのみ、送信 creds に触れない）。**ガードレール（§6）を通過した下書きのみ**
  送信対象キュー `x-reply:queue:<id>` に put（TTL 72h）。不通過は理由付きで破棄（ダイジェストに記録）。
- 出力: `{ drafts: [{ inReplyToId, authorHandle, sourceUrl, draftText, rationale, passed }] }`。

### `POST /api/x-reply/send`（auto 送信・人手承認なし）
- 入力: `{ token, id }`（オーケストレータが draft ステップ後に通過分を渡す。人の介在なし）。
- **kill switch**: `X_REPLY_ENABLED !== "true"` なら 503（既存 `PUBLISH_ENABLED` と同型）。停止は env 1 つ。
- 動作: KV から draft を取り出し、`postTweet(creds, draftText, inReplyToId)` で送信。
  - **冪等**: `idempotencyPayload`（handle + inReplyToId + 正規化本文）で二重送信を弾く。
  - **rate guard**: `x-reply:count:YYYY-MM-DD` を increment。soft cap（既定 **20 リプ/日**・
    投稿含む合算はアカウント上限 200/日 を十分下回る）超過で 429。
- 出力: `{ ok, tweetId }`。content-free ログのみ（`{action:"x-reply", status, ms}`）。

### オーケストレーション
- discover → draft（+ガードレール）→ send を 1 本で回すのは Cloudflare Cron Trigger か
  owner token を持つ最小ワーカー（`/try` の予算・kill switch を共有）。人手承認は挟まない。
- **事後ダイジェスト**: 送信済み・破棄を KV `x-reply:digest:YYYY-MM-DD` に content 付きで残し、
  owner-only エンドポイント or 既存 `/api/metrics` 拡張で読む（初期の prompt 微調整用・任意）。

## 4. リプ起草 prompt（要点）

- **PERSONA**: @kokibuilds（build-in-public を実践する個人 founder）の声。宣伝臭を出さない。
- **原則**: (a) 相手の投稿に具体的に反応する（テンプレ反復禁止＝platform manipulation 回避）
  (b) brypo の押し売りをしない・自然な文脈でのみ言及 (c) 証拠/数値で語る (d) 英語（beta は EN-only）。
- **出力制約**: 原則 1 tweet（≤270 weighted）。リンクは付けない（$0.20 課金・スパム判定回避、
  プロフィール流入で waitlist へ誘導する設計）。
- app 側 `format-render` の SYSTEM_PROMPTS とは別系統（reply 専用）。drift guard の対象外。

## 5. env / secrets（キー名のみ・値は Cloudflare）

- 送信 creds は既存 `X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET` を流用。
- **追加 env（キー名のみ）**: `X_REPLY_ENABLED`（kill switch・既定 false）。任意で `X_REPLY_DAILY_CAP`（既定 20）。
- 読取（search）が有料 tier 前提のため、**課金設定は 👤**（developer portal / 従量課金の支払い設定）。
- LLM: 起草は既存 `ANTHROPIC_API_KEY_TRY` 系を流用（`/try` と同じ予算・kill switch を共有）。

## 6. ガードレール（人手承認の代替＝決定的な安全弁）

auto 送信のため、以下は「あれば良い」ではなく**送信の前提条件**。すべて決定的（LLM 判断に依存しない）。

- **kill switch**: `X_REPLY_ENABLED !== "true"` で全送信停止（env 1 つ）。
- **soft cap**: リプ既定 20/日をコードで強制。アカウント上限（200/日）に達する前に自前で止める。
- **類似度ガード**: 直近送信リプ（KV 保持）との類似度が閾値超なら破棄＝テンプレ反復・無差別リプを機械排除（platform manipulation 回避）。
- **リンク非付与 / NG 語**: 本文に URL を含めない・禁止語を弾く。
- **冪等**: 同一ツイートへの二重リプを弾く。
- 読取本文は prompt injection の入口。起草層に push / 送信 creds を持たせない（層分離）。

## 7. テスト（`scripts/test-publish.mjs` 拡張・ネットワーク不要の unit）

- reply 整形: 270 weighted 超過ツイートの単一 tweet 化・URL 非付与。
- 冪等: 同一 `inReplyToId` + 同一本文で 2 回目が弾かれる。
- rate guard: soft cap 到達で送信が 429 相当を返す（KV モック）。
- discover の除外: `seen` 済み id・自分の投稿・空本文の除外。

## 8. 受け入れ基準

- discover → draft（+ガードレール）→ send の 1 本が、既存 `PUBLISH_TOKEN` gate 下で通る（人手承認なし）。
- 無認証で全エンドポイントが 401。`X_REPLY_ENABLED` 未設定なら send が 503（kill switch）。
- soft cap / 冪等 / 類似度ガード / seen 除外が unit で green（`npm test`）。
- **有効化（`X_REPLY_ENABLED=true`）・読取課金は 👤 判断後**（戦略 doc §8）。
