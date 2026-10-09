# 公開担当への引渡し範囲

2026-10-09。本人が公開repo作成を別担当へ許可しました。この実装担当はrepo作成・git操作・pushを行いません。最終レビュー完了後に、明示allowlistから別の安全なstagingを作ってください。作業領域全体をコピーする手順ではありません。

## 含めるファイル

| 範囲 | 内容 |
|---|---|
| ルートの明示ファイル | `.gitignore`, `README.md`, `package.json`, `package-lock.json`, `tsconfig.json`, `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, `config.example.json`, `deployment.example.json`, `deployment.cloudflare.example.json` |
| `src/*.ts` | ブリッジ・認証adapter・明示bootstrap/CLI・in-process mock |
| `test/*.ts` | ダミーID、生成RSA鍵、fake credential/JWKS/Discord/callback fixtureと回帰試験 |
| `scripts/build-keychain.mjs` | compile-only script |
| `native/keychain-reader.swift` | helperの元コードのみ |
| `deploy/local.discord-dot-bridge.plist.example` | 未設定・disabled・未登録テンプレート |
| `docs/*.md` | 現行手順、履歴、検証・レビュー、公開範囲 |
| `docs/licenses/` | 採用依存版のLICENSE/NOTICE写し、inventory/provenanceの非秘密記録 |

公開前にstaging側でallowlistの実体、symlinkやbinary混入、公開テンプレートのダミー値、実個人情報・token・会話の不在を再確認してください。`package-lock.json`は固定依存の再現用で含めます。新たな依存追加はありません。Tunnel clientは未採用・未同梱です。将来同梱するならその採用版と配布物のLICENSE/NOTICEを別途確認します。

## 除外対象

`private/**`（候補実ID・Hermes調査・実設定を含む）、実 `deployment.json`、`node_modules/**`、`dist/**`、生成native binary、実 `deploy/*.plist`、`.env*`、`*.token`、`*.log`、`*.sqlite*`、DB journal/WAL/lock、Keychain内容、API/Tunnel/Bot/OAuth秘密、個人会話、ローカル履歴/memory/sessions、既存runtimeの設定を含めません。workspaceの `.agents` / `.codex` / `.aws` や親の他プロジェクトも対象外です。秘密や会話を公開検査のログへ出しません。

native helperの生成先は `dist/native/` で、元コードとcompile scriptだけを公開します。license inventoryは当該Macで実際にインストールされた依存の範囲です。他OSやバンドル配布で追加された依存は再点検します。元コードのLICENSEは**未選定**です。公開repoの許可をMIT等の選定許可と解釈せず、現LICENSE/NOTICEの未選定表示を維持します。公開ソースの閲覧可能性とOSS利用許諾は別です。

## 引渡し時の検証

`npm run typecheck`、JS/Swift build、全144 tests（119 socket-free + 25 literal127.0.0.1 loopback）がPASS、失敗・skipは0。`demo:mock`は実投稿0・実dot wake falseです。詳細は [validation.md](validation.md)、最終独立確認は [independent-review.md](independent-review.md)。実秘密読出し、実Bot/Tunnel/IdP/dot接続、外部公開、常駐設定はこの実装検証に含めていません。
