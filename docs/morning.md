# 実疎通前の最小確認と受入証拠

ローカルコード検証は完了しています。実Discord/ChatGPTの往復は未確認です。以下は利用者の既存権限と認証の範囲で、限定疎通を行うための手順です。新しい認証・権限・契約や既存runtimeの変更を許可する文書ではありません。

## 最初に確認する3点

1. **専用MCP接続・認証を確認する。** ログイン済みの設定とサービス仕様でbridge用の接続を確認し、issuer/discovery URL、access-token形式、resource/audience、owner subject、scope、専用principal/chat束縛を照合する。health-only接続は別機能の利用証拠にならない。設定値や秘密を公開文書へ転記しない。
2. **Bot所有とテスト先を確認する。** 本人・Bot・guildを実UIで照合し、既存テスト用channel/threadを選ぶ。MessageContentIntentと既存閲覧/送信権限、既存runtimeの自動起動・再起動条件と排他所有を確認する。共有leaseに参加しないruntimeとの二重loginを行わない。
3. **不足する操作を区別する。** 新IdP、OAuth grant、token、永続アクセス、料金、セキュリティ設定、入口新設や既存runtimeの恒久停止が必要なら、対象・影響・rollbackを示して利用者の判断を待つ。既存ログインによる限定疎通の許可を、これらへ拡大しない。秘密は抽出して別経路へ送らない。

既存gatewayを再利用する場合も、bridge用途を明示した接続・認証仕様が必要です。導入済clientの存在やhealth応答だけでEventsや汎用操作を使えるとは判断しません。既存サービスへbridgeを混載しないでください。

## 既存認証で進められる場合の順序

許可済みの実設定と排他的Bot所有を確認した場合だけ、専用private設定の静的check → 明示activate → 限定テストへ進みます。Keychain service/account参照を使い、実秘密をLLM・argv・ログへ出しません。static checkはKeychain読出しや有効性確認を行いません。helperがUIを要求する/拒否する場合はfallbackせず止めます。常駐登録や自動起動は手動試験と別です。[connect.md](connect.md)

投稿例は「Discord dot bridge 疎通テスト：このスレッドへの短い返信確認」です。実UIで既存テスト用threadを確認してから本人のアカウントで1回だけ送り、繰り返しや全channel投稿はしません。replyは元のthreadだけ、allowed_mentions無効、1入力1返信です。通常ユーザーのtoken/selfbotは使いません。

| 確認段階 | 必要な証拠 | 判定できないこと |
|---|---|---|
| Bot → Discord | 想定Botが許可済みthreadへ最小1返信、返却message IDと実UIの一致 | Discord → dotのwake |
| Gateway → SQLite | ownerのメンションなし1投稿を1件保存、元のguild/channel/thread束縛 | callback/実dot処理 |
| Events callback | 実購読の署名challenge、有限TTL、署名event受領 | 2xxだけでは実dot wake不可 |
| Discord → 実dot → Discord | 専用購読会話が非同期に動き、read/replyを呼び、元threadへ1返信 | 手動tools・別LLM・別UI・mockは代替不可 |
| 停止/再起動 | owner停止で追加投稿なし、解除/期限/権限取消し、再起動後の重複なし | 既送信ネットワーク要求の撤回保証 |

受入証拠はprivate記録へ日時・段階・必要最小のID/結果だけ保存し、秘密や個人会話を公開issue/READMEへ貼りません。Bot送信のみ通った場合はその段階だけPASS、実dot往復は未確認と報告します。

## ローカル検証の範囲

150 tests（125 socket-free + 25 loopback）、型検査・JS/Swift build、setup checker、mock demoを検証しました。追加統合は実Gateway正規化・SQLite・OAuth・公式SDK・resource ACL・Discord senderを使い、callback応答喪失の再送、再起動、uncertain返信の再投稿防止、owner停止、期限、403/404と一時障害をfake transportだけで確認します。実ネットワーク疎通の証拠ではありません。[validation.md](validation.md)

実IdP/専用入口・対応resource、実設定、テスト先/本人/権限、排他的所有と許可範囲は利用者の環境で確認してください。新規契約や鍵発行が不要と判断できる証拠が得られるまでは、それらを開始しません。
