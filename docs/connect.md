# 実接続に残る条件

2026-10-09。JWKS取得、秘密ファイルreader、明示Bot login、排他lock、CLI停止処理、Mac常駐テンプレートまでコードを用意しました。現在は**実設定未入力・常駐未登録・実接続なし**です。配布用テンプレートにはKeychain参照名を組み込んでいますが、実読出しやBot所有は別の受入確認が必要です。既存runtimeの停止・自動起動・再起動条件は利用者の環境で確認してください。実接続に必要な条件は [朝の手順](morning.md)の順で照合します。 Bot未接続のmetadata準備は [oauth-setup.md](oauth-setup.md) で本番設定と分離できます。

1. **使うBotと閲覧範囲を確定する。** owner/Bot/guildの実ID、MessageContentIntent、既存ViewChannel/SendMessages/SendMessagesInThreadsを本人が確認する。既存Hermesを使うなら全Gatewayと監督の排他的切替・復帰を個別承認する。既存gatewayを変更しない場合は専用Botの承認が必要。同じtokenの並行利用はしない。
2. **専用の入口と認証を確定する。** Cloudflareは必須ではなく、標準OAuth＋Secure MCP TunnelまたはHTTPSを選べる。`authentication.kind` を明示し、既存IdPのRFC 9068 RS256 profile・issuer/JWKS/resource/audience/owner subject/scopeと利用権限・費用を確認する。実IdPは未確定。Cloudflareは任意adapterとして残す。Tunnelのruntime認証はowner認証とは別。詳細は [oauth.md](oauth.md)。既存POM/FF15の設定は対象外。
3. **承認済みの値をprivate領域へ設定する。** 専用owner700ディレクトリに選んだdisabledテンプレートを`deployment.json`として保存し、owner600にする。`enabled`と3つの確認flagは上記確認後にだけtrueへ変更する。`bridge`は既存configのguild_owner形式、`authentication`と`http`は下表の値、残りのnullも確定値を入力する。`credential`には承認済みのlogin Keychain参照を組込み済み。実値の読出しは未実施で、helperはUIを出さず拒否時停止する。tokenをソース/argv/env/plist/chat/ファイルへコピーしない。[Keychain経路](keychain.md)を確認し、`npm run build:keychain`でhelperをコンパイルする。version 1は拒否する。version 2への明示移行は [oauth.md](oauth.md)に記載。
4. **限定live受入後に常駐化する。** 親の実「える」会話のプラグイン接続・永続購読と、限定Discord投稿往復を承認して実測する。通った後でのみplistの絶対pathを確定し、常駐登録/起動を承認する。テンプレートはDisabled=true、RunAtLoad=false、KeepAlive=falseで、登録も実行もしていない。

| 設定 | 確定する値 |
|---|---|
| `bridge` | ownerUserId / bridgeBotId / guildId / 専用principal。`mode:guild_owner`、cases/allowlistsは空 |
| `authentication` | `oauth_resource_server`：固定issuer/JWKS/resource/audience/ownerSubject/requiredScopes、bridgeと同一principal。任意CF：kind `cloudflare_access` とAccess policy |
| `credential` | `kind:keychain`、service `DOTS_DISCORD_BOT`、account `discord`。参照名のみ、秘密値なし |
| `privateDirectory` | config/token/state/log専用のcanonical絶対path、既存owner700 |
| `ownershipDirectory` | 同じBotを使うbridge全instanceで共有するcanonical owner700 path。state directoryを変えても同じBot lockを使用 |
| `http` | `tunnel_loopback` + port、または `forwarded_https` + host/port。全listenerは127.0.0.1、外側OAuth resourceとは別 |
| `callbackHosts` | 実購読で指定されるcallbackの完全一致HTTPS host（wildcard不可） |

設定の静的検査は次のコマンドです。listener/login/DNS/秘密読出しを開始せず、未設定テンプレートはexit 2で拒否します。秘密tokenファイルを設定検査の入力にしないでください。

```sh
npm run config:check -- /absolute/path/to/private/deployment.json
```

実行は**既存の許可内の実設定と排他所有を確認できた場合、または不足する操作の追加承認後のみ**です。今回このコマンドを実設定で実行していません。

```sh
node /absolute/path/to/project/dist/src/main.js run --config /absolute/path/to/private/deployment.json --activate
```

実「える」の受入証拠は、Gateway→保存queue→署名callback→**当該購読会話の非同期wake**→read/reply→同じchannel/threadの返信です。callback 2xxや手動tools成功はwake成功に数えません。

停止はこのbridge自身へのSIGTERM/SIGINTを使います。CLIは新規受付を閉じ、有限drain後に自身だけを終了します。login/ACL/送信が残ればpendingを明示し、ライブラリはStoreとBot leaseを保持します。discord.jsのlogin準備は中断できないawaitを含むため、遅延loginの終了前にSDK destroyやlock解放を成功扱いしません。CLIが自身を終了するとOSがそのsocket/lockを回収し、reserved返信は次回uncertainに復旧します。他サービスを停止・killしません。

共有Bot lockはこのbootstrapを使うinstance間の仕組みで、既存Hermesなど別runtimeとの排他を自動証明しません。終了と接続所有者を確認するまで既存runtimeの復帰や新instanceの起動へ進まないでください。通常の再接続・再起動は保存済みpendingを復旧しますが、未受信messageのbackfillはありません。

全156件のうち130件socket-free、26件loopbackです。最新の実行結果は [検証記録](validation.md)を参照してください。実Keychain ACL/unlock/UI制限、実IdP issuer/TLS/OAuth、公式Tunnel client/metadata書換え、権限cacheの反映、Gateway reconnect/rate limits、実dot wake、Mac常駐/再起動は未試験です。[検証記録](validation.md)・[詳細手順とrollback](operations.md)・[独立レビュー](independent-review.md)を参照してください。
