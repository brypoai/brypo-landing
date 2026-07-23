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

## 3. エンドポイント設計（Pages Functions・実装済み v0.2）

すべて owner token gate（`X-Publish-Token` / body.token = `PUBLISH_TOKEN`）。無認証 401。auto 送信
のため discover→draft→send は**人手を挟まず 1 本のオーケストレータ**に統合した（承認キューを分離
する意味が無くなったため。spec v0.1 の 3 分割エンドポイントを `run` に集約）。

### `POST /api/x-reply/run`（1 パス: discover → draft → guardrails → auto 送信）
- **kill switch**: `X_REPLY_ENABLED !== "true"` なら 503（既存 `PUBLISH_ENABLED` と同型・停止は env 1 つ）。
- 入力: `{ token, targets?: [{id, authorHandle, text}], queries?: string[], dry_run?: boolean, max_sends?: number }`。
  `max_sends` は 1 パスの送信上限（≤ daily cap）。Cron が小さく刻んでバースト（bot signal）を避ける。
  - `targets` あり → その投稿へ直接リプ（**読取 API 不要＝チャージ前でも動く**・手選びの種蒔き用）。
  - `targets` なし → `GET /2/tweets/search/recent`（従量課金・要チャージ）で ICP 候補を取得。失敗時は
    握り潰さず `searchError` を返す。
  - `dry_run: true` → 起草＋ガードレールまで実行し**送信しない**（prompt 較正・事後ダイジェスト用）。
- 動作（候補ごと）: KV `xreply:seen:<id>` で既リプ除外 → LLM 起草 → **ガードレール（§6）** → 冪等
  （`xreply:idem:<sha256(id+正規化本文)>`）→ `POST /2/tweets`（`reply.in_reply_to_tweet_id`）で送信 →
  `seen` / `xreply:recent` / 日次カウンタ更新。全結果を `xreply:digest:YYYY-MM-DD` に追記。
- **rate guard**: `xreply:count:YYYY-MM-DD` を increment。soft cap（既定 **20/日**・`X_REPLY_DAILY_CAP`
  で可変・アカウント上限 200/日 を十分下回る）到達で以降スキップ／全枠尽きたら 429。1 パス上限 25 件。
- 出力: `{ ok, considered, sent, skipped, dryRun, results:[{id,status,reply?,reason?,tweetId?}] }`。
  content-free ログのみ（`{action:"x-reply", status, considered, sent, skipped, ms}`）。

### `GET /api/x-reply/digest`（事後ダイジェスト・owner-only）
- 入力: `?date=YYYY-MM-DD`（既定 today・UTC）。
- 出力: その日の `xreply:digest:*`（送信/スキップの一覧・理由・本文つき）＋ 送信数。prompt 微調整用（任意）。

> オーケストレーション: `.github/workflows/x-reply.yml`（GitHub Actions cron・4h おき・`max_sends=2`）が
> `run` を叩く（metrics snapshot と同型・Cloudflare cron binding 不要）。`PUBLISH_TOKEN` 未設定 or
> `X_REPLY_ENABLED != true` の間は no-op（安全）。人手承認は無し。LLM 起草は `/try` の
> `ANTHROPIC_API_KEY_TRY`（$50/mo cap）を共有。

## 4. リプ起草 prompt（要点）

- **PERSONA**: @kokibuilds（build-in-public を実践する個人 founder）の声。宣伝臭を出さない。
- **原則**: (a) 相手の投稿に具体的に反応する（テンプレ反復禁止＝platform manipulation 回避）
  (b) brypo の押し売りをしない・自然な文脈でのみ言及 (c) 証拠/数値で語る (d) 英語（beta は EN-only）。
- **出力制約**: 原則 1 tweet（≤270 weighted）。リンクは付けない（$0.20 課金・スパム判定回避、
  プロフィール流入で waitlist へ誘導する設計）。
- app 側 `format-render` の SYSTEM_PROMPTS とは別系統（reply 専用）。drift guard の対象外。

## 5. env / secrets（キー名のみ・値は Cloudflare）

- 送信 creds は既存 `X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET` を流用。
- **追加 env（キー名のみ・`.dev.vars.example` に追記）**: `X_REPLY_ENABLED`（kill switch・既定 false）。
  任意で `X_REPLY_DAILY_CAP`（既定 20）・`X_REPLY_NG_WORDS`（CSV・既定なし）・`X_REPLY_MODEL`（既定 = `/try` の Haiku）。
- 読取（search）が有料 tier 前提のため、**課金設定は 👤**（developer portal / 従量課金の支払い設定）。
  `targets` を渡す運用なら読取不要で先行運用できる。
- LLM: 起草は既存 `ANTHROPIC_API_KEY_TRY` 系を流用（`/try` と同じ予算・kill switch を共有）。

## 6. ガードレール（人手承認の代替＝決定的な安全弁）

auto 送信のため、以下は「あれば良い」ではなく**送信の前提条件**。すべて決定的（LLM 判断に依存しない）。

- **kill switch**: `X_REPLY_ENABLED !== "true"` で全送信停止（env 1 つ）。
- **soft cap**: リプ既定 20/日をコードで強制。アカウント上限（200/日）に達する前に自前で止める。
- **類似度ガード**: 直近送信リプ（KV 保持）との類似度が閾値超なら破棄＝テンプレ反復・無差別リプを機械排除（platform manipulation 回避）。
- **リンク非付与 / NG 語**: 本文に URL を含めない・禁止語を弾く。
- **冪等**: 同一ツイートへの二重リプを弾く。
- 読取本文は prompt injection の入口。起草層に push / 送信 creds を持たせない（層分離）。

## 7. テスト（`scripts/test-xreply.mjs`・ネットワーク不要の unit・`npm test` に連結済み）

純ロジック（`_xreply.ts`）を 24 ケースで検証（実装済み・green）:
- ガードレール: too_long（weighted）/ contains_url（明示 URL のみ・bare domain は非検出）/ ng_word / 類似度（軽微改変の定型リプを検出）/ empty。
- 冪等ペイロード: 同一 `id`+正規化本文で一致・target/本文が違えば不一致。
- 候補フィルタ: 自分の投稿・`seen` 済み・ミュート語・短すぎ・id 重複の除外。
- 起草パース: JSON 以外・空 `reply`・非文字列を破棄（生テキストを送らない）。
- KV キーの UTC 安定性・prompt が no-link/no-pitch を明記・user message の injection guard。

## 8. 受け入れ基準

- ✅ `run`（discover → draft → ガードレール → 送信）が 1 本で回る。人手承認なし。`targets` 指定で読取なし運用も可。
- ✅ 無認証で全エンドポイント 401。`X_REPLY_ENABLED !== "true"` で `run` が 503（kill switch）。
- ✅ soft cap / 冪等 / 類似度ガード / seen 除外 / URL 除外が unit green（`npm test`・24 ケース）。
- ✅ Cloudflare Pages（esbuild）ビルド通過を実測（`.ts` 拡張 import・nested route も解決）。
- **有効化（`X_REPLY_ENABLED=true`）・読取課金は 👤 判断後**（戦略 doc §8）。実装はゲート OFF で無害にマージ可。
