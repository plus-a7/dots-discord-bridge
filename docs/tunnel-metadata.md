# 一時Tunnel metadata確認

別のmetadata専用runtimeで、protected-resource metadataと401 challengeだけを提供します。Discord、SQLite、Events、read/reply、JWT検証、JWKS取得は起動せず、有効BearerでもMCP/Eventsを401で拒否します。本番へ自動切替しません。実Keychain/公式client認証・readiness・ChatGPT resource取得はモック試験では確認できません。

## 対応版と配布範囲

準備scriptは[OpenAI公式Homebrew tap](https://github.com/openai/homebrew-tools)の`openai/tools/tunnel-client` 0.0.16、darwin-arm64を対象とします。参照tap commitは`a32b3a99c1fc162d56d800cceebb041ffa434c3c`、版は`0.0.16+5f99daabd4aa4a77049e6d81d54a0d8c18335397`です。

| 固定対象 | SHA-256 |
|---|---|
| 公式darwin-arm64 zip（formula宣言） | `a160820d45089b5253d8d671fe2a689bde0f73d78c135d1497a7b33f28a3ac62` |
| 対応client binary | `6f1e8d5494d6c4d6c45cd4f6e07b5291459c0b23f4b8cd8266c7a64be3d9a2a0` |

client pathは`/opt/homebrew/Cellar/tunnel-client/0.0.16/libexec/tunnel-client`へ固定します。別版・別platform・別binary hashは拒否されるため、移設や更新後は対応版とpinsを再レビューしてください。client/cloudflared binaryは同梱しません。[LICENSE/NOTICE/SBOM](../THIRD_PARTY_NOTICES.md)は参照版の写しで、Homebrew生成SBOMは完全なbinary再配布監査ではありません。

[公式Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)、[OAuth](https://developers.openai.com/plugins/build/auth)、[client 0.0.16 source](https://github.com/openai/tunnel-client/tree/v0.0.16)を参照してください。sourceの`file:`入力対応と、実clientによるFD4利用の実測は区別します。

## 公開テンプレートの準備

公開checkoutに運用値やprivate planはありません。`native/tunnel-keychain-launcher.swift`の`__TUNNEL_KEYCHAIN_SERVICE__`と`__TUNNEL_KEYCHAIN_ACCOUNT__`を、利用者が許可した専用項目の参照名へローカルで設定します。未設定ではKeychain読出し前に拒否します。参照名の変更を公開commitへ含めないでください。既存項目や別サービスのキーを流用しません。

必要な対象・権限・保存参照を確認後、JSとnative helperをcompileします。compileはKeychainを読みません。

```sh
npm run build
npm run build:tunnel-helper
node scripts/prepare-tunnel-metadata.mjs --tunnel-id TUNNEL_ID --organization-id ORGANIZATION_ID --issuer AUTH0_ISSUER
node scripts/tunnel-metadata.mjs --check
```

大文字の引数は未設定placeholderです。実際の非秘密値へ置き換えます。現在のplan validatorはAuth0 US地域のHTTPS issuer末尾slashを要求します。設定はcheckout内の`private/tunnel-metadata/`（owner700、regular file600）へ新規作成します。キーは保存せず、Node/client/helper/設定のhashを固定します。既存directory・alias・不正権限・hash変更・run lockは拒否します。再準備による上書きや自動修復はありません。

`https://tunnel-bootstrap.invalid/mcp`は診断だけの暫定resourceです。Auth0 API Identifierや本番audienceへ登録してはいけません。実clientが使うresourceを確認してから別途Auth0設定をレビューします。Tunnel ID、ローカルURL、hostから推測しません。

## キーの経路と手動開始

利用者がMac Terminalで明示開始したときだけ、native helperがlogin Keychainを参照名の完全一致で検索します。認証ダイアログは利用者が要求元を確認して許可またはキャンセルし、ACL恒久変更・キー再発行は自動実行しません。

```sh
node scripts/tunnel-metadata.mjs --start --person-start
```

準備時と同じNodeを使います。非TTY・追加引数・環境経由のclient/helper overrideは拒否します。開始するとruntimeキーがOpenAI control planeへ送られます。キーはnative helperからOS pipe FD4を通してclientへ渡し、Node、argv、環境、設定、stdout/stderrへ値を渡しません。client引数は`file:/dev/fd/4`、child出力は破棄し、logは`/dev/null`、payload capture/raw HTTP logは無効です。同UID/管理者によるメモリ検査からの保護は別の境界です。

常駐登録や自動再起動はなく、最大15分で停止します。`metadata_only_session_started`はhelper起動要求だけで、キー取得・readiness・OAuth・dot wake成功ではありません。

ChatGPTのカスタムMCP追加画面で専用Tunnelを選び、metadata確認だけが可能な範囲を観察します。実resource URIが表示された場合のみ時刻と共に控えます。OAuth redirect URI/CIMD client情報は実管理画面から取得します。state、token、署名URL、完全なrequest/callback URLを記録・共有しません。認証済みMCP discovery・Connect・OAuthログイン/同意・Install/登録が必要なら、その操作の許可を別途確認します。metadata-only 401だけで画面が進むことは未検証です。

## 停止と検証の限界

開始TerminalでCtrl-C、または同じcheckoutとNodeで停止要求します。

```sh
node scripts/tunnel-metadata.mjs --stop
```

`metadata_stop_requested`は受付だけです。完了は開始側の`metadata_session_stopped`で確認します。FD3のparent生存/停止通知とguardianの専用process groupにより、終了、SIGINT/SIGTERM/SIGHUP、parent死亡、上限到達時に子孫を停止します。TERMを無視する子孫も回収しますが、guardian自体のSIGKILLやOS障害までは保証しません。正常時に自身のrun lockだけを削除します。parent強制終了はstale lockを残し再起動を拒否します。

残るKeychainダイアログは利用者がキャンセルします。`metadata_stop_pending`やstale lockがある場合はlock削除・再起動前に固定診断で状態をレビューします。別Tunnelや既存Botは停止しません。

`npm run test:tunnel-metadata`は別のTUNNEL_MOCK helperと合成キー・mock client、一時Unix/127.0.0.1 socketだけを使う6件です。既存156件とは別です。Swift、Python3が必要です。FD4/非露出、失敗・timeout・競合cleanup、parent死亡、metadata GET/MCP・Events 401、CLI拒否、SIGHUP/分割停止応答を確認します。実Keychain・実clientのFD4読込み/認証/readiness、metadata書換え、resource表示、Auth0/JWT適合、dot購読/wake/Discord返信は別の受入試験です。
