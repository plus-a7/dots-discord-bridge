# 一時Tunnel metadata確認

別のmetadata専用runtimeで、protected-resource metadataと401 challengeだけを提供します。Discord、SQLite、Events、read/reply、JWT検証、JWKS取得は起動せず、有効BearerでもMCP/Eventsを401で拒否します。本番へ自動切替しません。実Keychain/公式client認証・readiness・ChatGPT resource取得はモック試験では確認できません。

## 対応版と配布範囲

準備scriptは[OpenAI公式Homebrew tap](https://github.com/openai/homebrew-tools)の`openai/tools/tunnel-client` 0.0.16、darwin-arm64を対象とします。参照tap commitは`a32b3a99c1fc162d56d800cceebb041ffa434c3c`、版は`0.0.16+5f99daabd4aa4a77049e6d81d54a0d8c18335397`です。

| 固定対象 | SHA-256 |
|---|---|
| 公式darwin-arm64 zip（formula宣言） | `a160820d45089b5253d8d671fe2a689bde0f73d78c135d1497a7b33f28a3ac62` |
| 対応client binary | `6f1e8d5494d6c4d6c45cd4f6e07b5291459c0b23f4b8cd8266c7a64be3d9a2a0` |

client pathは`/opt/homebrew/Cellar/tunnel-client/0.0.16/libexec/tunnel-client`へ固定します。別版・別platform・別binary hashは拒否されるため、移設や更新後は対応版とpinsを再レビューしてください。client/cloudflared binaryは同梱しません。[LICENSE/NOTICE/SBOM](../THIRD_PARTY_NOTICES.md)は参照版の写しで、Homebrew生成SBOMは完全なbinary再配布監査ではありません。

[公式Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)、[OAuth](https://developers.openai.com/plugins/build/auth)、[client 0.0.16 source](https://github.com/openai/tunnel-client/tree/v0.0.16)を参照してください。固定版公式binaryによるFD4読込みは合成キー・全ネットワーク禁止の設定回帰で確認します。これは実キーの認証・readinessの証明ではありません。

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

## 本人用の起動・停止ファイル

本人用の`private/tunnel-metadata/launchers/Start Metadata.command`をFinderから開きます。runtime keyをlogin Keychainから読み、OpenAI control plane（`https://api.openai.com`）へ送る説明が表示されます。キーなしpreflightに通った場合だけEnterを1回押して開始します。Keychainの許可ダイアログが出た場合の操作は本人に残ります。取消は開始前にCtrl-C、または文字を入力してEnterです。キーや署名URLを貼らないでください。終了後は固定診断を画面に残し、閉じるときだけもう一度Enterを押します。失敗時に自動retryしません。

停止は`Stop Metadata.command`を開くか開始画面でCtrl-Cです。停止ファイルは既存socketへ停止を要求し、PID単独killは行いません。「停止受付」は完了の証明ではなく、開始画面の「停止完了」で確認します。「開始受付」や「ローカルready」も認証・OAuth・dot wake成功ではありません。最大15分、metadata-only401、既存TTYガードとFD4単一参照の経路を維持します。

TTY/Enterは本人性を証明しません。エージェントは本番wrapperを起動せず、Terminalアプリの読取り・自動操作や安全拒否の迂回も行いません。Finder関連付け・OS起動制限の実GUI動作は未試験です。OSが拒否した場合にセキュリティ設定を変更する手順は含みません。

公開用generatorは`scripts/prepare-tunnel-launchers.mjs`です。`npm run build:tunnel-launchers`で検証済みplanのNode絶対pathを使うowner700ファイルを新規生成します。`.command`は環境をHOME/PATHに限定し、引数override・秘密読取り・AppleScriptを含みません。privateの個人パス入りwrapperは公開除外です。既存フォルダへの上書きや自動再生成は拒否します。キーなし`node scripts/tunnel-metadata.mjs --preflight`はhash/設定/lock・schema・専用43125/43126のport状態だけを確認し、native helper・Keychain・HTTP listener・外部通信を開始しません。port確認はsnapshotなので、本開始時の既存lock/port/listener確認も再実行します。

## キーの経路と手動開始

利用者がMac Terminalで明示開始したときだけ、native helperがlogin Keychainを参照名の完全一致で検索します。認証ダイアログは利用者が要求元を確認して許可またはキャンセルし、ACL恒久変更・キー再発行は自動実行しません。

```sh
node scripts/tunnel-metadata.mjs --start --person-start
```

準備時と同じNodeを使います。非TTY・追加引数・環境経由のclient/helper overrideは拒否します。開始するとruntimeキーがOpenAI control planeへ送られます。キーはnative helperからOS pipe FD4を通してclientへ渡し、Node、argv、環境、設定、stdout/stderrへ値を渡しません。参照はCLIの`--control-plane.api-key file:/dev/fd/4`一箇所だけです。YAMLに`api_key`を置きません。child出力は破棄し、logは`/dev/null`、payload capture/raw HTTP logは無効です。同UID/管理者によるメモリ検査からの保護は別の境界です。

常駐登録や自動再起動はなく、最大15分で停止します。`metadata_only_session_started`はhelper起動要求だけで、キー取得・readiness・OAuth・dot wake成功ではありません。

ChatGPTのカスタムMCP追加画面で専用Tunnelを選び、metadata確認だけが可能な範囲を観察します。実resource URIが表示された場合のみ時刻と共に控えます。OAuth redirect URI/CIMD client情報は実管理画面から取得します。state、token、署名URL、完全なrequest/callback URLを記録・共有しません。認証済みMCP discovery・Connect・OAuthログイン/同意・Install/登録が必要なら、その操作の許可を別途確認します。metadata-only 401だけで画面が進むことは未検証です。

## 停止と検証の限界

開始TerminalでCtrl-C、または同じcheckoutとNodeで停止要求します。

```sh
node scripts/tunnel-metadata.mjs --stop
```

`metadata_stop_requested`は受付だけです。完了は開始側の`metadata_session_stopped`で確認します。FD3のparent生存/停止通知とguardianの専用process groupにより、終了、SIGINT/SIGTERM/SIGHUP、parent死亡、上限到達時に子孫を停止します。TERMを無視する子孫も回収しますが、guardian自体のSIGKILLやOS障害までは保証しません。正常時に自身のrun lockだけを削除します。parent強制終了はstale lockを残し再起動を拒否します。

残るKeychainダイアログは利用者がキャンセルします。`metadata_stop_pending`やstale lockがある場合はlock削除・再起動前に固定診断で状態をレビューします。別Tunnelや既存Botは停止しません。

`npm run test:tunnel-metadata`は別のTUNNEL_MOCK helperと合成キー・mock client、一時Unix/127.0.0.1 socketだけを使う13件です。既存156件とは別です。Swift、Python3が必要です。FD4/非露出、失敗・timeout・競合cleanup、parent死亡、metadata GET/MCP・Events 401、CLI拒否、SIGHUP/分割停止応答を確認します。実Keychain・実clientのFD4読込み/認証/readiness、metadata書換え、resource表示、Auth0/JWT適合、dot購読/wake/Discord返信は別の受入試験です。

## FD4二重読込みの修正と固定診断

0.0.16はCLI overrideがあってもYAMLのAPIKey参照を先に解決し、続いてCLIの参照を解決します。消費型FD4 pipeを両方へ指定すると二度目が空になりexit1になります。profileからYAMLの`api_key`を削除し、native CLI一箇所だけへ指定します。schema-onlyのprofiles add成功だけでは、この実行時読込みを検証できません。

`npm run test:tunnel-client-config`は固定hashの公式0.0.16 binaryを、合成キーとdummy設定だけで二回実行します。追加sandboxで全networkを禁止し、`mcp.max-concurrent-requests=0`を設定解析後のsentinelにします。旧二重参照は`api_key_pipe_empty`、修正版は`intentional_post_key_config_sentinel`まで進むことを確認します。両clientのexit1は試験で意図した設定拒否で、harnessのexit0が成功です。runtimeは構築しません。stderrは8KiB以内のメモリだけで分類し、完全一致の2メッセージを固定名へ変換して、未知内容は破棄します。私的設定やKeychainを読みません。

FD3はparent生存/停止と固定診断の双方向経路です。ASCII allowlist、1行96bytes、合計4096bytes、64行で制限し、未知・秘密・state・長大入力を反射しません。nativeの診断writeはnonblocking/best effortでcleanupを妨げません。生stdout/stderr、例外stack、HTTP body/header、URL/token/stateは記録しません。

| 診断 | 意味 |
|---|---|
| `metadata_command_denied_stage_arguments/terminal/static_plan` | 引数・TTY・private planで拒否。Keychain前 |
| `tunnel_helper_reference_unconfigured` | 公開テンプレート参照名が未設定。Keychain前 |
| `metadata_client_config_check_passed` / `metadata_client_config_schema_only_not_runtime_or_auth` | オフラインschema確認のみ。実行・認証の成功ではない |
| `metadata_client_config_rejected/spawn_or_timeout` | schema拒否、validator起動失敗またはtimeout |
| `metadata_start_failed_stage_metadata_listener` | metadata待受けの失敗 |
| `tunnel_keychain_open/lookup_failed_<分類>` | 既知OSStatusだけの固定分類。生errorは出さない |
| `tunnel_keychain_lookup_complete` / `tunnel_credential_handoff_complete` | Data取得・FD4 write段階。client認証とは別 |
| `tunnel_client_exit_code_<整数>` / `tunnel_client_exit_signal_<整数>` | client終了。guardian終了の診断とは別 |
| `metadata_client_health_timeout` | handoff後30秒以内にlocal readinessを確認できずcleanup |
| `metadata_client_local_ready_does_not_prove_auth_or_dot_wake` | 同一PIDのlocal healthが200。Control Plane認証、OAuth、dot wakeとは別 |
| `metadata_listener_stopped/session_lock_released/session_stopped` | owned listener/lockを片付けた。pending/failedはレビュー対象 |

health確認は明示start時だけです。固定127.0.0.1:43126のlistener PIDをclient PIDと照合した後、healthz/readyzへ認証headerなしGETを行います。1 request最大1秒、redirect拒否、body/header破棄でstatusだけ分類します。PID照合はOSの同時変更に対する原子的証明ではありません。残り起動期限によるabort/raceと前後deadline確認で、late-readyやabortを無視するprobeから期限後の成功を出しません。

## 起動wrapperのキーなし検証

`npm run test:tunnel-launchers`は別途7件です。説明/preflight/Enter/startの順序、取消/EOF/signal/入力上限、固定エラー・秘密非表示、既存socket停止と受理/完了区別、lock/schema/port拒否、shell path引用を検証します。Mac PTYでは専用fixtureだけを使い、起動→socket停止、二重開始拒否、取消、mock helper失敗、起動ファイル欠落・module import失敗の固定表示と画面保持を確認します。実Terminalアプリ・本番wrapper・Keychain・公式clientを起動せず、実キーを使いません。これはFinderでの実GUIや実認証の証明ではありません。
