# 導入・停止・rollback手順（承認前のレビュー用）

2026-10-09。これは操作を実施した記録ではありません。現成果物はオフラインの最小リリース候補です。明示OAuth/Access JWT verifier、metadata/401、購読grantの失効、明示起動のloopback HTTPとworker、停止/drainは実装・モック検証済みです。production JWKS provider、専用資格情報reader、明示login bootstrap/CLIと未設定LaunchAgentテンプレートは追加しました。実資格情報・issuer・入口の設定、外部公開、常駐登録/起動はしていません。短い手順は [connect.md](connect.md) にまとめています。下記は接続方式と操作承認が確定した後の組立・受入順序です。モックをHTTP公開して本番runtimeにする手順はありません。

## 対象と最小権限

採用設定は `guild_owner`。本人が指定したownerと1guildの実IDはprivate候補にだけ保存し、接続前にDiscordの本人・Bot・guild表示と照合します。名前をIDの代用にせず、home channelをallowlistと解釈しません。指定guildの既存権限で受信できる全投稿元でownerの発言をメンションなしに扱い、Bot・第三者・webhook・DM・guild外を除外します。

| 境界 | 必要な最小条件 | 自動追加しないもの |
|---|---|---|
| Gateway | Bot token、Guilds / GuildMessages / MessageContent intents。Message ContentのPortal設定・必要な審査を確認 | user token/selfbot、GuildMembers privileged intent、追加Bot作成 |
| 受信・read・callback | 投稿元のViewChannel、正しいguild/channel/thread tuple | Administrator、権限付与、非公開threadへの自動参加 |
| 通常channel返信 | ViewChannel + SendMessages | ManageChannels、ManageMessages、ManageWebhooks、mention権限 |
| thread返信 | ViewChannel + SendMessagesInThreads、閲覧可能な既存thread、active/unlocked | CreatePublicThreads、CreatePrivateThreads、ManageThreads、archive解除 |
| MCP | 専用owner認証、対象resourceのaudience、認証済みprincipalと購読callbackの束縛 | NoAuth公開、同一principalの別chatへの無検証共有 |
| callback | ChatGPTが実際に指定した完全一致HTTPS host、443、公開IPv4、TLS、署名key | wildcard host、redirect、私設IP、DNS検査回避 |
| Mac | 専用private directory 700、state/秘密600、Bot接続の排他的所有 | 既存Hermes/FF15/POM設定の流用・改変、秘密のログ出力 |

このコードは保存したGateway本文をreadするため、ReadMessageHistoryを要求するREST履歴取得はありません。停止中に届かなかった投稿の取得を追加する場合は、別途範囲・権限・保持期限を設計します。添付、embed、edit/delete、フォーラム親の本文や既存案件の自動区切りは対象外です。forum/media内の閲覧可能なthreadはthreadの束縛で扱います。

[Discord Threads](https://docs.discord.com/developers/topics/threads)ではprivate threadの閲覧条件とSendMessagesInThreadsが通常channelとは異なり、投稿でarchiveが解除され得ます。本senderはarchived/lockedなら送信しません。全guild指定は既存権限の範囲を広げる操作ではありません。

## 承認を揃えてから進める順序

1. **変更対象を確定する。** 既存Hermes Botを排他的に切り替える案を主候補とし、本人の承認なしに新Botへ変更しません。FF15/POMは対象外。owner/Bot/guild ID、既存権限、秘密の参照方法、Message Content設定を照合します。tokenの値は会話・コード・ログに出しません。
2. **専用接続を選ぶ。** 標準OAuth＋Secure MCP Tunnel/HTTPSを利用可能で、Cloudflareは任意です。実IdP/profile/subject/resourceとTunnel権限・workspace・料金を確認します。[oauth.md](oauth.md)の固定URL・入口・grant期限の条件に従います。Cloudflareを採用するなら専用named Tunnel、専用hostname、独立Accessアプリ、owner限定policy、Managed OAuthを用意します。同じZero Trust account内で動かし、POM既存Accessアプリ・Worker・routeを変更しません。Zero Trust初期設定・契約条件・identity・料金は未承認です。
3. **選んだ認証を確定し実issuerと照合する。** version 2の `authentication.kind` を明示します。標準OAuthは固定issuer/JWKS/resource/audience、ownerSubject、requiredScopesを設定し、RFC 9068 RS256 `at+jwt`を検証します。`http.kind` は入口を別選択し、常に127.0.0.1のみで待受けます。購読はaccess token期限内だけ有効で、旧grantのcached replyも拒否します。IdP即時失効通知は未対応です。CFを選ぶ場合は以下の固有条件を確認します。固定Bearer endpointは本番OAuthではありません。`AccessJwtAuthenticator`はfake issuerで検証済みで、実Access issuer/audience/ownerは未設定です。`HttpsJwksProvider`は固定issuerのcerts endpoint、redirect禁止、IPv4 pin、TLS検証、raw64KiB/128chunks、abort/timeout、失敗cooldownを実装済みです。validatorも利用不能keysetへのcooldownを持ち、valid keyのbad signature/unknown kidではcacheを破棄しません。実issuerの到達性・鍵・identityとOAuth discoveryを本接続時に照合します。Managed OAuthではopaque client tokenをJWTとして解析せず、originでCf-Access-Jwt-Assertionの署名、許可issuer、専用audience、exp/nbf、owner identityを確認します。JWKS取得先は固定issuerから決定し、リクエスト中のURLへアクセスしません。生JWT/header/key/bodyをログへ出しません。ownerメール候補とDiscord IDを暗黙に同一人物扱いせず、本人に対応を確認します。追加domainを同じAccessアプリへ混ぜません。[公式Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
4. **検証済みruntimeへ実接続adapterを渡す。** dedicated loopbackだけで待受け、外側は選んだ認証と専用host/pathで保護。`makeClient → DiscordJsSender → Bridge → PinnedHttps → EventsAdapter(resourceAccessGuard必須) → 認証済みMCP endpoint` を結びます。Bot loginと配送workerは明示起動に限定。配送はready/実Bot ID確認後だけ開始し、再接続中はpendingを保持、callback/送信準備中の取消しは必須guardで再確認。`BridgeRuntime.start()`はloopback HTTP/workerを明示開始しますがloginは行いません。`stop()`は受付・worker停止、auth close、Gateway detach/destroy後にHTTP/custom MCP handler/Events/返信を有限時間待ちます。存続custom handlerは8件上限で、HTTP取消し後も終了まで枠を保持します。drain完了時だけStoreを閉じ、未完了なら`clean:false,pending:true`でStoreを保持します。生存処理終了後にstopを再試行し、完了を確認するまで別runtime/Hermesを起動しません。返信timeoutはuncertainで自動再送なし。`LoginBootstrap`/CLIがcredential.kindで明示選択したKeychain/helper（または専用ファイルreader）とJWKS providerを結び、共有Bot leaseを取ってloginし、expected Bot ID/non-user identity/guild visibility確認後だけlistener/workerを始めます。設定はfrozenで、enabled=true/確認flags/完全値/明示--activateが必要。承認後は実値と起動監督を設定します。import/build/demoは起動しません。
5. **Hermesを排他的に切り替える。** 作業中の会話・子処理、cron/dispatch/watchersなどGatewayが担う範囲を確認してから、承認した既存LaunchAgent監督を停止。KeepAliveで再起動しないこと、対象Gateway/子処理終了、Bot token lock解放を確認します。既存設定・cron定義・FF15常駐は変更しません。終了しなければbridgeのBot loginへ進まず、force killを自動実行しません。同じtokenを別state pathで起動してもこのStoreの排他lockでは検出できません。
6. **接続・購読を受け入れる。** 下表を親の実dot「える」の指定会話で実施します。MCP tool listingだけで完成とせず、各境界の実測証拠を残します。最初は本人の限定テスト投稿だけで進め、内容が個人会話のログへ広がらないようprivate記録を使います。
7. **常駐化を別途検証する。** 手動live受入が通った後に専用の監督と起動順序を設定。Mac起動・再接続・停止・rollbackを確認し、片方のBot接続だけが所有する状態を維持します。stateの自動削除・上限リセット・自動再開を追加しません。

## 実dotの受入判定

[OpenAI Events](https://developers.openai.com/plugins/build/mcp-events)の現公式仕様はdots、MCP 2.0 `2026-07-28`、同じ認証endpointでのEvents、永続購読、署名callback、購読chatでの非同期処理に対応しています。現SDK adapterはこのprotocolをin-processで検証済みです。通信経路やidentity、実dot購読は未検証であり、固定Bearer seamやfake issuer検証を、そのまま実ChatGPTへ接続できる証拠にしません。

| 順序 | 実測する証拠 | 失敗時の判断 |
|---|---|---|
| 1 | owner認証で専用host/resourceへ接続、他identity・誤audience・直origin・expired tokenを拒否 | Events購読へ進まない |
| 2 | 実ChatGPTからserver/discoverとevents/list。events capabilityとguild_id filterがpluginに表示 | 通常MCP toolsの成功だけでは不可 |
| 3 | 親dotの指定会話からevents/subscribe、正しいguild・callback、署名challengeと有限TTLを保存 | 別chatのcallbackと共存させない |
| 4 | ownerがメンションなしで1投稿、message IDを1回だけqueueへ保存 | 他Bot/第三者/webhook/別guildを誤受信したら停止 |
| 5 | 正しい署名・subscription ID・event IDのcallbackが2xx | 受領だけでwake成功としない |
| 6 | **購読した実「える」会話が非同期に動き、discord_read → discord_replyを呼ぶ** | 手動tool呼出し/別LLM/別UIは代替証拠にならない |
| 7 | 元のguild/channel/threadへ1返信。mentions無効、nonce、重複呼出しでも追加投稿なし | 別threadへ出たら接続を停止して原因確認 |
| 8 | 他Botの反応はqueueに増えない。owner停止、解除、期限、再起動、権限取消しを確認 | in-flight既受理1件の限界を区別して記録 |

modern SDKの手動protocol検証ではMCP-Protocol-Version/Mcp-Method headersを使います。これは実ChatGPT requestの観測結果ではありません。callback IPv4到達性、認証discovery、会話束縛、Gateway resume、rate-limit、権限cache反映に問題があれば本接続仕様を修正して再レビューします。cursorはnullで、未受信の投稿を再生できません。

## 停止・障害・rollback

- ownerの `/bridge-stop` は元のchannel/threadを永続停止し、他originは継続。`/bridge-stop-all` はguild全体を永続停止し、購読を無効化。第三者/Botの同文には停止権限なし。自動復帰なし。
- callback準備中の停止・解除・TTL失効はDNS後のguardでPOST開始を拒否。Discord準備中も最後のguardで拒否。既にネットワークへ渡した要求は撤回できず、結果不明はuncertain。再送したcallbackのevent IDは同じで、署名時刻は新しい。Discord返信はsent/uncertainを自動再投稿しません。
- uncertain返信は本人が実threadで投稿有無を確認。元本文・宛先・nonce・返却IDなど必要な最小情報をprivate領域で照合し、盲目的なqueueリセットやDB直接編集で再送しません。
- rollbackは、owner全停止 → 新規配送/受信停止 → bridgeと専用Tunnel/clientの終了 → in-flight/子処理・Bot lock解放確認 → **既存の未変更Hermes LaunchAgentを復帰** の順。既存FF15/POMは操作しません。bridgeが残っている状態ではHermesを再接続しません。起動状態を確認できなければ親へ状況を返します。
- 専用Accessアプリ/route/DNSの撤去は、新規作成した対象を照合して承認の下で実施。既存POMのDNSやworker routeを削除・変更しません。rollback前に認証設定やtokenを無効化すると停止中callbackが残る可能性があるため、停止と終了を先に確認します。
- login timeout後もSDK内部のREST/準備処理は遅れてconnectし得るため、libraryはlogin実settleまでStore/leaseを保持し、初回destroyを先行しません。stopはpendingを明示。CLIのSIGTERM/SIGINTはstartとraceし、有限drain後は自身processのみ終了します。OSはそのsocket/lockを回収しますが、これを実Gateway接続の正常終了証拠としません。
- `ownershipDirectory`はBot IDのcanonical共有leaseを持ち、state pathを変えた新bridgeの重複を拒否します。既存runtimeはこのlockに参加しないので、その停止と所有権移譲の別確認は必要です。
- Storeの同時利用lockはOS終了で解放されます。保存済みqueue/subscriptions/stop/reserved→uncertainを復旧します。power loss、disk fault、secret漏洩復旧は未試験。stateは700/600のprivate領域で保存し、公開成果物・issue・通常ログへ添付しません。
- 1000 records、100 origins、32 subscription identitiesで満杯なら拒否。同じ購読refreshは可能。保持・削除・案件を再開する運用は未承認で、データを失う自動cleanupをしません。期限切れのoriginは同じ通常channelでも自動再開しないため、継続運用のretention/案件更新は将来の別設計です。

## オフラインで再現できること

`npm run typecheck`、`npm test`、`npm run demo:mock`。Keychain native helperはmacOSのSwift compilerでコンパイルし、試験はKeychain IO前の拒否またはfake pipeだけを使います。実項目へ問い合わせません。認証設定や実Bot接続を必要とせず、dummy dataのみで動きます。全156件のうち`test:unit`130件はsocketなし、`test:loopback`26件はliteral127.0.0.1の一時listenerとfake issuer/Discordだけを使います。`test/recovery.test.ts`のDNS/HTTPS seamは外部接続を開始しないfakeを使い、受領直後のクラッシュはmock callbackと一時SQLiteを使った子プロセスで検証します。fixtureの手動tool呼出しは実dot受入の代わりになりません。

Keychain参照名の組込みと安全なローダーは用意しています。既存Bot runtimeの排他所有、自動起動・再起動条件と復帰手順は利用者の環境で確認してください。他サービスを巻き込む一括停止は行いません。実秘密読出し・Bot起動・常駐登録、入口や認証サービスの作成、権限変更、plugin接続、実投稿、課金はこのローカル検証に含みません。[Keychain手順](keychain.md)を参照してください。
