# 接続候補：選定前の判断材料

**2026-10-09現在：Cloudflare必須依存は除去済み。** 標準OAuth＋Secure MCP Tunnel/HTTPSと任意Cloudflare adapterを明示選択できます。[現行の認証・入口設定](oauth.md)を参照してください。以下の2026-10-07/08記録は選定履歴で、Cloudflareの現採用を示しません。実IdP・実Tunnel・費用とdot往復は未確認です。

2026-10-07、公式仕様と秘密を含まないローカル情報だけを確認。アカウント、Platform契約、請求状態、API key、トンネル権限は調査／変更していません。現時点では**追加課金なし・新認証なしで実dotへ接続できる経路は確認できていません**。Secure MCP Tunnelは未採用・未作成です。

| 経路 | 現在の到達範囲 | 必要な追加確認／承認 | 既存gatewayへの影響 |
|---|---|---|---|
| 認証なしin-process mock | 公式SDK Events＋署名mock callback＋read/reply。実dot wakeなし | なし。`npm run demo:mock`で再現可能 | なし |
| ローカルstdio MCP toolsだけ | 手動tools呼出しの検証 | これだけではdotsのEvents購読／wakeの証拠にならない | なし |
| 公開HTTPS（開発用forwardを含む） | 公式のcustom MCP接続候補 | 公開／forward、送信元アクセス認証、専用principal、plugin追加権限。既存endpoint/契約の有無・費用は未確認 | 別Botならなし。Hermes Botを排他利用するなら停止承認が必要 |
| Secure MCP Tunnel | 私設MCPを公開listenerなしで接続する公式候補 | tunnel_id、runtime API key、Platform組織の作成／利用権限、ChatGPT workspaceとの関連付け、常駐client、契約／費用の確認 | 別Botならなし。既存Botの二重Gatewayは解決しない |

公開HTTPSまたはSecure MCP Tunnelが公式の接続入口です。開発用HTTPS forwardingもテストで利用可能ですが、公開配布には安定した公開HTTPSが必要です。プラグイン追加と認証の設定も別の操作です。[公式の接続手順](https://developers.openai.com/plugins/deploy/connect-chatgpt)

Tunnelにはruntime API keyと組織単位のTunnels Read+Use権限が必要で、作成にはRead+Manageが必要です。目的のChatGPT workspaceを関連付け、clientを動かす必要があります。公式ガイドの接続要件は確認しましたが、本人の既存契約で追加請求なしに使えることまでは証明しません。[公式Tunnelガイド](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

Discord本文を扱う本接続では、ownerのアクセス認証と購読chatの束縛が必要です。現factoryの固定Bearerはローカル認証テスト用です。ChatGPTは任意のAPI keyを提示できず、ユーザー認証はOAuth 2.1等の公式要件に合わせる必要があります。既存の対応identity providerは未確認です。認証なしで公開する案は採用していません。[公式認証ガイド](https://developers.openai.com/plugins/build/auth)

実dot経路のために別LLMやResponses APIの推論を追加する必要はありません。ただし「推論APIを呼ばない」ことはTunnel/hosting/dot利用全体の無課金保証ではありません。Eventsはdots対象ですが、callbackの2xxは受領までで、実際の購読会話の非同期処理を別に測る必要があります。[公式MCP Events](https://developers.openai.com/plugins/build/mcp-events)

## 既存gatewayを変えない最小案

現在の許可内で完了できる最小構成は、独立したin-process mockと、fake issuer/Discordによる明示起動loopback runtimeです。既存Hermes／FF15／POMには依存しません。

実往復まで進む場合、既存Hermes Bot資格情報をそのまま並行利用すると受信／返信の所有者が重複するため採用しません。既存gatewayを一切変更しない要件なら、**専用Botとその資格情報の作成承認＋承認した接続入口／認証方式**が必要です。新Botを許可しないなら、Hermes全Gatewayの停止・排他的切替・rollbackを承認する案になり、既存gateway無変更の要件とは両立しません。コードがこの選択を勝手に行うことはありません。

既存Hermesへの影響と復帰案は `private/hermes-candidate.md` の非秘密調査メモにあります。候補owner/Bot IDは本接続前に再確認します。指定guildと全閲覧可能channelという希望はprivate候補設定に反映し、Bot/OS権限の追加は前提にしていません。公開exampleはダミーIDだけです。

## 2026-10-08追記：専用Cloudflare接続候補

主候補は専用named Cloudflare Tunnel → Mac bridge + 独立したowner限定AccessアプリのManaged OAuthです。Workerによる独自OAuth実装を省く案で、採用・設定・接続は未実施です。Cloudflare公式は同じZero Trust accountで提供されるMCP serverへのManaged OAuthを説明し、originにCf-Access-Jwt-Assertion検証を要求します。クライアントtokenはopaqueです。[公式仕様](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)

過去の承認済み読取ではPOMのCloudflare accountにActive domainと未使用の専用DNS候補を確認しましたが、Access画面はZero Trust初期設定案内でした。ドメインのFree表示はZero Trustの現契約・無料利用保証ではありません。ownerのAccess identityとDiscord IDの対応、Managed OAuthのこのaccountでの利用可否、料金・契約条件、実ChatGPT互換性は未確認です。公開docsには実account識別子・本人メール・実Bot/guild IDを転記していません。

`makeEndpoint` は固定Bearerのオフラインseamです。`AccessJwtAuthenticator`、固定host/pathのloopback HTTP、ready-gated workerと停止drainは実装済みでfake issuer/Discordにより検証しました。固定issuer JWKS取得provider、専用private credential reader、明示login bootstrap/CLIとdisabled LaunchAgentテンプレートも実装し、fake transport/loginで検証しました。実設定、外部接続、常駐登録/起動は未実施です。実issuer/audience/identity/Managed OAuth discoveryの適合も未検証です。コードのEvents対応が確認できたことと、この候補で本接続できることを区別してください。最小権限、導入順序、Hermes排他切替・rollback、実dot wakeの受入判定は [operations.md](operations.md) にあります。

Access assertionの検証方針は固定issuer、専用audience、ownerメールと必要ならsubject、RS256署名、exp/nbf/iatを検査します。opaque BearerをJWTとして解釈しません。providerは固定issuerから決めたJWKS endpointだけにアクセスし、token内のURLへアクセスしない契約です。[CloudflareのJWT検証仕様](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

2026-10-09の残る操作は [connect.md](connect.md) の4項目に整理しました。Cloudflare系認証コードの準備済み状態は、Secure MCP Tunnelなど別方式への認証適合も保証しません。
