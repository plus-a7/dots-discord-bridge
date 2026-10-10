# Bot未接続のOAuth metadata準備

2026-10-09 UTC。明示モードoauth_setupはprotected-resource metadataと401 challengeだけを提供します。owner subject、Bot、callback host、Keychain参照、state/lease directoryを持ちません。read/reply、MCP discovery/tools、Events発見/購読/解除は有効にならず、有効JWTでも全MCP要求を401で拒否します。認証成功、プラグイン作成成功、callback hostname取得、実dot wakeをこのモードの成功と呼びません。

`oauth-setup.example.json`はdisabled/未設定です。本番version 2とは互換にせず、通常runへ渡すと拒否します。セットアップへowner/Bot/token/callback URL/secret等の余分なfieldを追加しても拒否します。ダミーownerやwildcard callbackで不足を埋めません。

[一時Tunnel metadata確認](tunnel-metadata.md)は別の診断経路です。Tunnel書換えを観察するための明示的な暫定resourceは本番resourceの代用ではなく、Auth0 APIへ登録禁止です。実接続の確認は未実施で、通常setup/本番のresource確定条件は維持します。

## 先に確定する非秘密値

| field | 確認元 |
|---|---|
| version / mode / enabled | 1 / oauth_setup / true。disabledテンプレートはそのまま起動不可 |
| oauth.issuer / jwksUrl | 実Auth0 discoveryのissuer / jwks_uri。末尾slashまで保持し、ドメインから推測しない |
| oauth.resource / audience | 選んだtransportで実clientが認証対象とするHTTPS URI。同じ文字列。確定前は起動しない |
| oauth.requiredScopes | 専用APIへ設定するscope。本番は全MCP requestに全requiredScopes必須 |
| http | tunnel_loopback＋固定port、またはforwarded_https＋完全一致host/port。1024〜65535、待受けは127.0.0.1のみ |

最小形は `{version:1,mode:"oauth_setup",enabled:true,oauth:{issuer,jwksUrl,resource,audience,requiredScopes},http:{kind:"tunnel_loopback",port}}` です。実値の保存は本人承認後に専用private directory700のregular file600へ行います。設定内容をargv/envへ展開しません。

## 静的確認と明示待受け

```sh
node dist/src/main.js setup-check --config /absolute/path/to/private/oauth-setup.json
node dist/src/main.js setup-serve --config /absolute/path/to/private/oauth-setup.json --activate
```

setup-checkはlistener/DNS/HTTP/Keychain/SQLite/clientを開始しません。成功は構文・ローカル設定の確認だけです。固定診断はmetadataConfigured:true、liveReady:false、mcpEnabled:false、eventsEnabled:falseと、owner_subject/callback_host_confirmation/production_configuration_and_activationの未完了を示します。issuerの実到達性、discovery内容、JWT形式は確認しません。

setup-serveは別途許可された手動試験でのみ実行します。owner700/600 readerを使い、--activateなしでは設定も読みません。設定resourceに対応する `/.well-known/oauth-protected-resource` とpath付きaliasのGETだけを提供します。POST /mcpはbody/Bearerを解析せず401、他pathは404。Host/Origin/query/重複header/body制限は既存loopback入口と同じです。Ctrl-C/SIGTERMで閉じ、常駐や外部forwarderを起動しません。Auth0のAS discoveryはAuth0自身が配信し、このモードはproxyしません。

## callback hostnameの診断

```sh
node dist/src/main.js setup-callback-check --host receiver.example.test
```

例はダミーです。実hostname単体だけを渡し、完全なcallback URL、path/query、署名secret、Bearerを入力しません。canonical lowercase DNS hostnameだけ受け付け、URL/wildcard/IP/port/userinfo等は固定errorで拒否します。正常時も入力をechoせずtrusted:falseで、DNS/HTTPS/challenge/保存/allowlist登録を行いません。

実callback hostnameは利用者の接続環境で実ChatGPT Eventsの発行情報から確認する必要があります。OAuth redirect URI/MCP公開hostは代用不可です。このcheckoutでは取得経路は未確認で、管理画面にEvents callbackが表示されるとも断定しません。秘密を含むrequest dumpや購読bodyをchat/logへ貼らず、利用者の環境でhostnameだけ確認できなければ接続前の阻害として止めます。取得元と本人承認が揃った後だけ本番callbackHostsへ完全一致hostを設定します。syntax成功はOpenAI由来やSSRF安全性の証明ではなく、実購読は既存HTTPS/DNS pin/TLS/署名challengeを必ず通します。

## 本番への切替

setup待受けを停止し、本番version 2でowner subject、専用principal、確認済みcallbackHosts、実Bot/intents/排他所有/秘密参照を揃えて通常checkを通します。setupから本番への自動昇格・設定自動保存・認証fallbackはありません。本番runは従来どおりactivate後にlogin/readyを確認してから開始します。同じportへ二重起動しません。

Auth0既定JWTは現コードでは拒否します。専用APIはRFC 9068/RS256、resource互換/issuer response、PKCE S256、実scope/subを確認します。API Identifierは作成後変更不可なのでresource確定前に作成しません。CIMD private_key_jwtはEnterprise限定であり、無料枠で通ると仮定せず、事前登録公開client none＋PKCEの利用可否を実UIで確認します。正確なOAuth redirect URI/client情報は実ChatGPT接続管理画面から取得します。setupの401だけでMCP scan/OAuth登録が完了するとは未検証で、UIがauthenticated discoveryを要求する場合は本番設定完成まで止めます。

公式根拠：[OpenAI認証](https://developers.openai.com/plugins/build/auth)、[Auth0 RFC 9068](https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles)、[resource互換](https://auth0.com/ai/docs/mcp/guides/resource-param-compatibility-profile)、[API Identifier](https://auth0.com/docs/get-started/apis/api-settings)、[Auth0 CIMD条件](https://auth0.com/ai/docs/mcp/guides/registering-your-mcp-client-application/manual-cimd-registration)、[Events](https://developers.openai.com/plugins/build/mcp-events)。
