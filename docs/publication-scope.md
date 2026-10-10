# 公開担当への引渡し範囲

公開用stagingは、レビュー済みの明示allowlistから作成します。実運用設定・秘密・作業履歴を除外し、配布対象だけを検証して公開してください。

## 含めるファイル

| 範囲 | 内容 |
|---|---|
| ルートの明示ファイル | `.gitignore`, `README.md`, `package.json`, `package-lock.json`, `tsconfig.json`, `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, `config.example.json`, `deployment.example.json`, `deployment.cloudflare.example.json`, `oauth-setup.example.json` |
| `src/*.ts` | ブリッジ・認証adapter・明示bootstrap/CLI・in-process mock |
| `test/*.ts` | ダミーID、生成RSA鍵、fake credential/JWKS/Discord/callback fixtureと回帰試験 |
| `scripts/build-keychain.mjs`, `scripts/check-setup.mjs` | compile-only buildと公開checkout-only setup checker |
| `native/keychain-reader.swift` | helperの元コードのみ |
| `native/tunnel-keychain-launcher.swift`, `test/tunnel-metadata.test.mjs`, `test/tunnel-client-pipe.test.mjs` | 手動metadata-only helperの元コードと合成キーmock試験 |
| `scripts/build-tunnel-keychain.mjs`, `scripts/tunnel-plan.mjs`, `scripts/prepare-tunnel-metadata.mjs`, `scripts/tunnel-session-core.mjs`, `scripts/tunnel-metadata.mjs`, `scripts/tunnel-diagnostics.mjs`, `scripts/check-tunnel-client-pipe.py` | compile・private準備・hash確認・本人開始/停止。実ID・キーは含まない |
| `scripts/prepare-tunnel-launchers.mjs`, `scripts/tunnel-launcher.mjs`, `scripts/tunnel-preflight.mjs`, `test/tunnel-launcher.test.mjs` | 汎用generator・Enter確認・キーなしpreflight・テスト専用PTY fixture。生成されたprivate個人パス入り.commandは除外 |
| `deploy/local.discord-dot-bridge.plist.example` | 未設定・disabled・未登録テンプレート |
| `docs/*.md` | 現行手順、履歴、検証・レビュー、公開範囲 |
| `docs/licenses/` | 採用依存版のLICENSE/NOTICE写し、inventory/provenanceの非秘密記録 |

公開前にstaging側でallowlistの実体、symlinkやbinary混入、公開テンプレートのダミー値、実個人情報・token・会話の不在を再確認してください。`package-lock.json`は固定依存の再現用で含めます。新たなnpm依存追加はありません。手動Tunnel準備は公式client 0.0.16を対象としますがclient/cloudflared binaryは同梱しません。参照版LICENSE/NOTICE/SBOMをdocs/licensesへ保存します。公開native helperのKeychain参照名は未設定placeholderで、変更・再compile・plan再作成前には実キーを取得できません。将来binaryを同梱するなら配布物全体の依存ライセンスを再点検します。

## 除外対象

`private/**`（候補実ID・Hermes調査・実設定を含む）、実 `deployment.json`、`node_modules/**`、`dist/**`、生成native binary、実 `deploy/*.plist`、`.env*`、`*.token`、`*.log`、`*.sqlite*`、DB journal/WAL/lock、Keychain内容、API/Tunnel/Bot/OAuth秘密、個人会話、ローカル履歴/memory/sessions、既存runtimeの設定を含めません。workspaceの `.agents` / `.codex` / `.aws` や親の他プロジェクトも対象外です。秘密や会話を公開検査のログへ出しません。

native helperの生成先は `dist/native/` で、元コードとcompile scriptだけを公開します。license inventoryは当該Macで実際にインストールされた依存の範囲です。他OSやバンドル配布で追加された依存は再点検します。元コードのLICENSEは**未選定**です。公開repoの許可をMIT等の選定許可と解釈せず、現LICENSE/NOTICEの未選定表示を維持します。公開ソースの閲覧可能性とOSS利用許諾は別です。

## 引渡し時の検証

`npm run typecheck`、JS/Swift build、全156 tests（130 socket-free + 26 literal127.0.0.1 loopback）がPASS、失敗・skipは0。`demo:mock`は実投稿0・実dot wake falseです。詳細は [validation.md](validation.md)、最終独立確認は [independent-review.md](independent-review.md)。実秘密読出し、実Bot/Tunnel/IdP/dot接続、外部公開、常駐設定はこの実装検証に含めていません。

起動UXの追加試験は7件です。生成private.commandは個人の絶対pathを含むため公開せず、generic generatorとモックPTYコードだけを含めます。Finder関連付け・本番起動・実認証の動作は未検証です。

公開コピーで型・必要なSwift build・既存156/156・mock13/13・UX7/7・公式offline設定1/1を再検証し、全PASS・失敗/skip/cancel0。setupはofflineReady:true/liveReady:false、demoは実投稿0・実dot wake falseです。
