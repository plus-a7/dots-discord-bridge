# 明示認証とOAuth resource server

2026-10-09。Cloudflareは必須ではありません。設定version 2は `authentication.kind` を `oauth_resource_server` または `cloudflare_access` と明示します。認証なし、未入力、自動選択、検証失敗後の別方式へのfallbackはありません。Bot・queue・署名Events・宛先束縛・Keychainの境界は共通です。これは隔離コード検証の成果であり、実IdP、公式Tunnel client、実dotとの接続結果ではありません。

## 標準OAuthの対応範囲

既存の適合IdPを利用できますが、今回確認できた実IdP設定はありません。新IdPや独自authorization serverを作成していません。対応するaccess tokenはRFC 9068の **RS256 / `typ:at+jwt`** JWTに限定します。署名、固定issuer、audience、subject、exp/nbf/iat、client_id、jti、scopeを検証します。必要scopeは全て必須です。ID token、opaque token、他方式JWT、Cloudflare assertionをBearerの代わりに受け付けません。opaque token introspection等は未実装です。

設定する例はダミーです。IdP側でhuman ownerに対応するsubjectであることを確認し、同名service accountやclient_credentialsを本人認証として割り当てないでください。emailやDiscord IDからsubjectを推定しません。principalはこのbridge専用で、実dot/chat IDの暗黙保証にはなりません。

```json
{
  "kind": "oauth_resource_server",
  "policy": {
    "issuer": "https://issuer.example.test/realm/bridge",
    "jwksUrl": "https://issuer.example.test/realm/bridge/keys",
    "resource": "https://mcp.example.test/mcp",
    "audience": "https://mcp.example.test/mcp",
    "ownerSubject": "mock-owner-sub",
    "principal": "mock-owner",
    "requiredScopes": ["discord:read", "discord:reply", "discord:events"],
    "revokedTokenDigests": []
  }
}
```

issuer/JWKS/resourceはcanonical HTTPS URLを設定で固定し、userinfo/query/fragment/IP/非標準portを拒否します。issuerのpathは使用可能です。audienceはresourceと完全一致させます。JWTのjku/x5u/jwk等から鍵取得先を選びません。JWKSは公開IPv4のA回答を全件検査し、IP固定、TLS hostname検証、redirect拒否、取得上限・timeout・cache・失敗cooldownを適用します。tokenや生エラーはログへ出しません。

これはresource serverでありOAuthログイン画面やtoken発行機能ではありません。IdP側はChatGPTのOAuth 2.1、PKCE S256、resource indicator、利用するCIMD/DCR/事前登録client方式に適合する必要があります。scope名称・JWT形式はIdP側でも明示設定します。既存IdPが上記profileに適合しなければ未対応として止め、認証を省略しません。[OpenAI認証](https://developers.openai.com/plugins/build/auth)・[MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

## 入口と発見応答の分離

全方式でlistenerは **127.0.0.1のみ** です。`http` は次のいずれかです。

| kind | 受け付けるHost | 外側の条件 |
|---|---|---|
| `tunnel_loopback` | 実際の `127.0.0.1:port` の完全一致 | 承認済みSecure MCP Tunnel clientがローカルHTTPへ転送する想定 |
| `forwarded_https` | 設定した `host` の完全一致 | 承認済みのHTTPS forwarderがHostを保持する想定 |

`oauth_resource_server` は両入口で使用可能です。`cloudflare_access` は `forwarded_https` に限定します。内側のRequest URL `https://local-mcp.invalid` は内部検証用でDNS接続先ではありません。外側のresource/audienceは実clientが認証するURLであり、内側Hostとは別設定です。Tunnelがresourceやmetadata URLを書き換える場合は実際の発行audienceとの一致を確認してください。内側URLへの置換やaudience wildcardで回避しません。

resourceが `https://mcp.example.test/mcp` なら公開metadataは `/.well-known/oauth-protected-resource/mcp` とroot alias `/.well-known/oauth-protected-resource` で返します。401の `WWW-Authenticate: Bearer` は設定した外側のcanonical metadata URLとscopeを示します。Bearerが提示されて検証に失敗した場合は `error="invalid_token"` を含みます。metadata自体は非秘密で認証不要ですがHost/Origin/path/body制限は適用します。issuerのdiscoveryをproxyしたり任意URLへアクセスしたりしません。

Tunnel runtime API keyはOpenAI側のclient接続用で、ownerのaccess tokenとは別です。鍵の流用やownerのBearerを静的injectする構成は採用しません。authorization serverのブラウザ向けendpointは別に到達可能である必要があります。Tunnel clientのインストール、runtime key読出し、Control Plane・workspace設定は未実施です。[公式Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)・[公式client](https://github.com/openai/tunnel-client)

## 永続購読の認証寿命

購読にはpolicy fingerprint、subject、tokenのSHA-256 digest、検証済みexpiresAtだけを保存し、生Bearerは保存しません。callback secretと本文は既存のprivate SQLiteに保存されます。`refreshBefore` は最大24時間の購読TTLとaccess tokenのexpの短い方です。長期購読でもtoken失効後に通知を継続しません。ChatGPTが期限前に同じ購読identityを新tokenでrefreshできるかは本接続の受入項目です。

dispatchのidle時・配送前・非同期DNS後・read/reply前にgrantを検証します。期限切れ、設定digest失効、互換性のないpolicy変更、旧版のgrantなし購読は無効化し、pending配送をdeadにします。現在有効な別tokenを提示しても古いgrantのread/cached replyを許可しません。同じprincipal/callback/event/argumentsの明示refreshは新grantで置換できます。

IdPでの即時logout/unlink/revocationを受信する機能はありません。署名JWTの期限と設定した `revokedTokenDigests` で検出する範囲です。digest設定更新には停止・設定変更・再起動が必要で、設定は実行中immutableです。緊急時はownerのbridge停止またはbridge自身を終了します。外部へ送信済みの1要求を撤回する保証はありません。実IdPの失効モデルを確認し、必要なら別途introspection/失効adapterを設計します。

## Cloudflareと設定移行

`deployment.example.json` はOAuth＋loopback、`deployment.cloudflare.example.json` はCloudflare＋HTTPS forwardingの**disabled/未設定**テンプレートです。nullを埋めただけでは起動せず、enabled/本人確認/排他所有/intents確認と明示activateが必要です。version 1を自動移行せず拒否します。private設定を扱う承認後、versionを2へ変更し、旧 `access` を選んだ `authentication.policy` へ、旧 `externalHost`/`port` を `http` へ移します。Cloudflareを使う場合もkindを明示します。

Cloudflare adapterは固定HTTPS originのissuer、Access audience、ownerEmail/任意ownerSubjectを検証し、`Cf-Access-Jwt-Assertion` のみを使用します。Cloudflare Managed OAuthのopaque client tokenをこのadapterでJWTとして解析しません。標準OAuthへの自動fallbackはありません。既存Cloudflare/POM設定を変更・流用していません。

## 検証と未確認

新経路は生成RSA鍵・fake JWKS/DNS/HTTPS・fake credential reader/login・署名mock callback・mock Discordだけで検証しました。`test/oauth-runtime.test.ts` はliteral127.0.0.1への**文書化されたHTTP転送のモック**です。公式tunnel-clientやOpenAI Control Planeは使わず、metadata書換え、runtime認証、実Tunnel readiness、実dotのwakeを検証したものではありません。

実接続前にIdP/profile/subject/scope/resource、TunnelID/workspace/鍵権限/費用、callback host、実dot会話の購読と更新、Discord本人・Bot・guild/intents、排他的所有を確認します。OSSソース公開とプラグイン公開は別です。公開プラグインの安定HTTPS要件をTunnel mockで満たしたとは扱いません。[接続仕様](https://developers.openai.com/plugins/deploy/connect-chatgpt)
