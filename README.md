# Discord ↔ dot bridge（ローカル検証済み・実接続未完了）

このコードは指定guild内の既存権限で閲覧できるチャンネル／案件スレッドと、購読した実際のdot会話をつなぐ最小ブリッジの候補です。別LLM、UI、えるの人格模倣は含みません。既存FF15 Bot/POM/gatewayへの依存・変更はありません。import・build・demoは接続を起動しません。全テストには明示起動する一時127.0.0.1モックHTTP listenerを含み、終了時に閉じます。ここに記録した検証ではBot login、サービス外部公開、トンネル、プラグイン接続、実投稿を行っていません。CLIによる実接続は別の承認・実設定・受入試験が必要です。JWKS取得provider、専用秘密ファイルreader、明示login CLIと未設定LaunchAgentテンプレートは用意しました。実値は未設定・常駐未登録です。配布後のローカル確認は [セットアップ](docs/setup.md)、本人が朝に行う確認は [朝の最小手順](docs/morning.md)、実設定は [接続手順](docs/connect.md) を参照してください。

Bot未接続の初回準備は [OAuth metadataセットアップ](docs/oauth-setup.md) を使います。issuer/resource確定後にowner/callbackなしでmetadata/401だけを提供し、有効JWTでもMCP/Eventsを拒否します。本番への自動切替はありません。

## 確認した公式仕様と境界

2026-10-07確認、2026-10-09関連仕様を再確認：[OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)、[接続方法](https://developers.openai.com/plugins/deploy/connect-chatgpt)、[Discord Gateway](https://docs.discord.com/developers/events/gateway)、[Discord Threads](https://docs.discord.com/developers/topics/threads)、[公式MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。

Eventsはdotsに対応し、MCP 2.0 `2026-07-28`、同じ認証方針のendpointの `events/list` / `events/subscribe` / `events/unsubscribe`、永続購読、署名HTTPS callbackを必要とします。`server/discover`でeventsを宣言しています。署名callbackの2xxは受領確認であり、その後の購読会話での非同期処理は別です。通常toolsの成功、モックcallbackの受領、MCP tools/list成功だけで実際のdot wake成功とは判定しません。

接続には公開HTTPSまたはSecure MCP Tunnelが必要です。どちらも未設定です。実dotの対象会話・認証principal・callbackの対応は現時点で未確認です。認証方式は `oauth_resource_server` / `cloudflare_access` の明示選択です。Cloudflareは必須ではありません。標準OAuthは固定issuer/JWKS/resource・owner subject・scopeを持つRFC 9068 RS256 access tokenを検証し、metadata/401 discoveryを返します。固定Bearer factoryはオフラインseamです。両adapterのfake issuer検証は実IdP/Tunnel/複数chat間の隔離を証明しません。[認証と入口の設定](docs/oauth.md)を参照してください。接続後に専用owner/dot接続と購読会話の束縛を確認する必要があります。同一principalを他chatと共有する構成は承認前に再設計してください。

Guild内でownerのメンションなし本文を取得するにはMessageContentIntentが必要です。本接続時にDeveloper Portalで有効化・必要な審査と利用範囲を確認します。Botは投稿元を閲覧でき、通常channelへの返信はSendMessages、threadへの返信はSendMessagesInThreads権限が必要です。private threadでは招待/閲覧条件、archive/lock状態も確認します。user token/selfbotは使用しません。

## 構成

`Gateway messageCreate → normalize → scope/provenance filter → SQLite queue → signed MCP Event → subscribed actual dot chat → discord_read → discord_reply → bound original Discord channel/thread`

| ファイル | 役割 |
|---|---|
| `src/core.ts` | 指定guildと動的投稿元の境界、owner/第三者/Botの区別、messageID重複排除、永続queue、返信予約と上限 |
| `src/discord.ts` | discord.js正規化・受信登録・同じchannel/threadへの送信、実資源権限guard |
| `src/events.ts` | OpenAI固有Events adapter。通常MCP toolsから独立した発見/購読/解除/配送 |
| `src/callback.ts` | Standard Webhooks署名、HTTPS callback検証、DNS固定とSSRF防御 |
| `src/mcp.ts` | 公式SDK v2のfetch endpoint、専用principal、read/reply toolsとEvents |
| `src/auth.ts` / `src/oauth.ts` / `src/auth-factory.ts` | 明示認証factory、Access JWTまたは固定OAuth access token検証、requestごとのgrantと購読失効 |
| `src/jwks.ts` | 設定で固定したissuer/JWKSへのHTTPS GET、IPv4/DNS pin、raw上限・timeout/abort・失敗cooldown |
| `src/config-file.ts` / `src/deployment.ts` / `src/bootstrap.ts` | disabled設定拒否、private reader、Bot所有lock、有限login/ready、実identity確認後だけruntime開始 |
| `src/keychain.ts` / `native/keychain-reader.swift` | login Keychain完全一致参照、UI禁止、専用fd 3 pipe、秘密非ログ/非ファイル、時間/出力上限 |
| `src/cli.ts` / `src/main.ts` | 静的check、明示activateのrun、SIGINT/SIGTERMと自身process終了 |
| `deployment*.example.json` / `deploy/*.plist.example` | 値未入力・disabledの設定／Mac常駐テンプレート |
| `test/jwks.test.ts` / `test/deployment.test.ts` / `test/bootstrap.test.ts` | 隔離HTTPS transport、未設定拒否、fake login/再起動/遅延停止検証 |
| `src/http.ts` | 明示起動の127.0.0.1 HTTP、固定host/path、入力・応答上限と切断/timeout |
| `src/runtime.ts` | ready-gated単一worker、停止・遅延処理のdrain、Storeの安全な終了 |
| `test/auth.test.ts` / `test/runtime.test.ts` | fake issuer認証と実loopback HTTPの統合検証 |
| `src/mock-runtime.ts` | 認証なし・ネットワークなしのin-process組立と手動protocolデモ |
| `test/guild.test.ts` | 全guild owner限定、動的宛先とmock組立の検証 |
| `test/bridge.test.ts` | 完全オフラインの署名receiver、Discord sender、SDK endpointテスト |
| `test/recovery.test.ts` / `test/integration-recovery.test.ts` | DNS取消し、再起動/再送、二重配送、uncertain返信、停止・期限・権限エラーの回帰/統合検証 |
| `scripts/check-setup.mjs` | 公開checkoutのNode/依存/Swift/build/disabledテンプレートだけを確認。秘密・実設定・ネットワークは対象外 |

採用候補は `mode: guild_owner` です。指定した1guild全体を対象とし、既存Bot権限で受信／閲覧できる投稿元だけを扱います。channel列挙は不要です。ownerの非Bot投稿だけをメンションなしで拾い、第三者、Bot、webhook、自己投稿、guild外、DMを除外します。全guild指定は権限追加・Bot招待・thread参加・archive解除を許可しません。通常テキストchannelとthreadに対応し、guild/channel/thread（通常channelではthread=null）の組を不変のcase IDとして永続保存します。返信先は投稿元だけで、名前やtool引数から変更できません。

案件を分ける際は既存スレッドを1案件1スレッドで利用します。通常channelへの直接投稿も最新の全channel指定に合わせて受け付け、channel単位の文脈になります。スレッドの作成や自動参加は行いません。新しい案件を同じ通常channelで自動区切りする機能はありません。添付・embed・message edit/deleteは対象外です。既存の `fixed_cases` は静的thread／第三者・Botの明示条件の回帰検証用に残していますが、guild_ownerではこれらのallowlistを設定すると拒否します。

入力のprovenanceは `owner` / `third_party` / `allowed_bot` を保持し、全入力を `authorization:false` として返します。owner IDの一致自体を別の重要操作の承認として解釈せず、Bot/第三者の文面を本人承認として扱いません。返信toolは許可された返信だけを実行し、宛先channel/threadを引数で指定できません。イベントには本文を載せず、識別子とprovenanceのみ通知します。readで必要な本文を取得します。モデル側でのプロンプト注入耐性はライブ受入試験に含めてください。

ownerの投稿元での完全一致 `/bridge-stop` はその投稿元だけを永続停止します。他のchannel/threadの購読は続きます。`/bridge-stop-all` は指定guild全体を永続停止し、購読も無効化します。第三者やBotの同じ文字列には停止権限がありません。自動再開はありません。

標準上限は1案件8返信、最初の受信から30分、全体1送信同時実行、返信処理10秒、保存1000件、動的投稿元100個、保存購読identity32個です。期限や返信数は自動リセットしません。満杯なら安全側に拒否します。同じ購読identityのrefreshは可能ですが、期限切れ・解除済みidentityも保存上限に数え、秘密や過去返信の束縛を勝手に削除しません。既存案件を別threadへ再利用しないでください。変更時も旧宛先データをread/通知しないよう照合し、ownerの変更時も旧ownerの保存済み入力を拒否します。

## オフライン検証

Node `v24.20.0`で検証しています。組み込み `node:sqlite` を使用します。
Keychain経路のビルド/試験にはmacOSのXcode Command Line Tools（Swift compiler）も必要です。参照名だけをdisabledテンプレートへ組込済みで、実項目・秘密・ACLは未確認です。[Keychain手順](docs/keychain.md)に実装と残る操作を記録します。

```sh
cd discord-dot-bridge
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run build:keychain
npm run build
npm run setup:check
npm test
npm run demo:mock
```

依存の取得以外、外部通信は不要です。`npm test`は156件、`npm run test:unit`はsocketなし130件、`npm run test:loopback`は一時127.0.0.1 listenerを使う26件です。sandboxでbindが禁止される環境ではloopback試験だけローカルlistenerの実行許可が必要です。testは実際の公式MCP v2 SDKをRequest/Responseで通し、モックcallbackが署名を検証し、モックDiscordへ返信します。fixtureからの手動tool呼出しはdotの代替LLMではなく、プロトコルの検証です。テスト用ID・会話はすべてダミーで、実データを取り込みません。

`demo:mock` は資格情報・環境変数を読まず、HTTP listenerも作りません。認証なしのRequest/Responseを同一プロセスで公式SDKへ渡し、署名確認済みのモックEventsとread/replyを手動で通します。実dotの代役はありません。出力は `mockOnly:true, liveDiscordPosts:0, liveDotWake:false` です。認証なしの公開endpointは提供していません。

再現結果と未試験項目は [検証記録](docs/validation.md)、独立レビューは [レビュー記録](docs/independent-review.md) に記録します。実装済みコード・残る実設定と接続承認は [最小リリース候補](docs/release-candidate.md)、導入順序・最小権限・rollbackと実dot受入判定は [導入手順](docs/operations.md) にまとめました。

## 永続化・再送・停止

SQLite snapshotをFULL同期で保存します。別SQLiteの `BEGIN EXCLUSIVE` による排他lockはプロセス終了で解放され、クラッシュ後の残存PIDファイルを避けます。同一状態パスの二重起動は拒否します。動的投稿元とguild全体の停止状態も復旧します。`LoginBootstrap`はstate directoryと独立した共有ownershipDirectoryにBot IDのleaseを取り、同じBotを別stateで起動するbridge間の重複も拒否します。ただし既存Hermesはこのlockに参加しないため、停止確認と排他的引渡しは別途必要です。

購読identityはprincipal/callback/event/arguments（guildまたはcase）から決定し、同じ要求はrefreshします。採用guild全体につき同時active callbackは1つ（fixed_casesでは案件ごと）。callback challengeの検証後だけ有効化し、検証中unsubscribe/owner停止を再確認します。有限TTLは最大24時間と認証grantのexpの短い方で、`ttlMs:null`にも有限期限を返します。生Bearerは保存せず、policy/subject/digest/expだけを購読に保存します。旧grantなし・期限切れ・設定digest失効・policy変更は配送とread/cached replyを拒否し、明示refreshが必要です。IdP側の即時失効通知は未対応です。更新secretは短い60秒窓で旧新両署名、解除はidempotentです。

queueのcallback再送は同じeventIDと元の発生時刻を維持し、署名時刻は更新します。指数backoff、最大5回、410/413は再送しません。410は購読無効化。イベントは順不同になり得ます。cursorはnullで、protocol replayは提供しません。保存済みのpending queueは復旧しますが、Gateway停止中に受信しなかったmessageのbackfillはありません。

返信はsubscription/message単位で予約してから送信し、nonceとenforceNonce、allowedMentions空集合を使います。再呼出しは同じ結果を返し、内容変更は拒否します。送信結果が不明、または送信予約中にクラッシュした場合は `uncertain` とし、自動再投稿しません。ownerが実スレッドを確認して手動調整する必要があります。Discordのnonce重複排除は長期exactly-once保証として扱いません。

送信準備中のowner停止/期限/購読解除は送信直前guardで拒否します。callbackもDNS解決後・HTTPS request作成前に再確認し、検証challenge完了後は資源権限を再確認してから購読を有効化します。購読refreshで鍵が置換された場合も古い準備済み要求を送らず、次回再送で新しい署名を作ります。全体timeout後の返信準備も送信できず、残処理が終わるまで同時実行gateを維持します。REST rate-limit待ちは拒否します。ただしDiscordやcallbackへ**すでに送ったネットワーク要求は撤回できません**。停止・解除・期限と外部受理が競合した場合の既存in-flight 1件はライブ試験で確認します。

## セキュリティと承認後の組立境界

callbackは明示した完全一致hostだけを許可し、HTTPS/443、userinfo/fragmentなし、redirect禁止とします。毎接続でfamily:4のA取得を行い、全A結果を公開IPv4か検証して、そのIPに固定します。HTTPSにもfamily:4/rejectUnauthorized:trueを明示し、TLS SNI/証明書検証は元host名を維持します。IPv6 fallback、IPv6-only/空A、public/private A混在を拒否します。DNS3秒・HTTPS10秒・response8KiB・event256KiB以下です。

`EventsAdapter` は必須 `resourceAccess` guardを受け取ります。モックだけがno-op guardを使います。実運用では `resourceAccessGuard(client, config, id => bridge.binding(id))` を渡し、Bot ready/ID、指定guildの可視性（購読時）、宛先、強制取得したchannelとGateway cacheに基づくViewChannel権限を購読・read・配送前に確認します。permissionsForはguild/member/role cacheにも依存し、権限取消しの反映時刻を原子的に保証しません。返信も送信前に再確認します。権限が失われたらそのpending配送を停止します。ready前や一時通信障害は `ResourceUnavailable` としてpendingを保持し、1秒以降に再確認します。runtimeはready後だけ配送開始し、再接続時の復旧も受入試験してください。

`BridgeRuntime` がGateway adapter、送信adapter、Events、認証済みMCP、loopback HTTPとworkerを組み立てます。constructor/importでは起動せず、`start()`だけが127.0.0.1 listenerとworkerを開始します。Gateway未readyでは受信/配送/ツールを止め、pending queueを保持します。存続するcustom MCP handlerは最大8件で、取消し後も実処理の終了まで枠を保持します。HTTP取消しはSDKへ伝搬し、遅延ACL/challenge/送信準備後もrequest guardを確認します。`stop()`は新規受付を即時禁止し、custom MCP handlerも追跡してdrainします。期限内に終わらなければ`clean:false,pending:true`でStoreを保持し、遅延処理の終了後にstopを再試行します。古いruntime/workerは再起動不可で、新instanceで保存状態を開きます。`LoginBootstrap`は設定/明示activate確認→専用private境界→共有Bot lease→token reader→login/ready/実Bot+guild確認→runtimeの順で実行します。未設定でclient/秘密/DNS/listenerを起動しません。遅延loginが残る間はStore/leaseを保持し、最初のSDK destroyはlogin終了後に行います。CLIは有限drain後に自身だけを終了します。実issuer/秘密/入口の設定と常駐登録は未実施です。

専用設定は明示pathのowner600 regular fileだけを読み、symlink/hardlinkを拒否します。tokenはcredential.kindで選択した参照だけから取得します。採用Keychain経路はlogin Keychain完全一致検索・UI禁止・専用fd 3 pipe・genericエラー・時間/出力上限を持ち、秘密をログ/ファイルへ出しません。既存tokenファイルreaderはprivate_file明示選択の場合だけです。private/ownership directoryはcanonical owner700で、既存DB/lock/補助ファイルのaliasも拒否します。同UIDによるSQLite pathの同時置換はOSアカウントの別境界です。SDK環境tokenやsharding managerの存在時は暗黙流用せず拒否し、SDK debug/raw errorにはログを付けません。秘密をログへ出す機能はありません。stateにはcallback secretと会話本文が含まれ、専用privateフォルダ700、DB600で保護します。平文保存なのでOSアカウント管理者・バックアップ保護は別の境界です。実設定・会話、DBは `private/` に置き、gitignore対象とします。採用経路のDiscord tokenはKeychainに置き、ファイルへコピーしません。コード/fixture/docsへコピーしません。privateフォルダ以外の共用ディレクトリにStoreを置くとchmodが変わるため、専用ディレクトリだけを指定してください。

## 一括で必要な接続承認

1. owner/Botの実IDを本接続時に再確認。指定guild・全閲覧可能channelという希望はprivate候補に反映済みですが、既存権限だけを使います。公開exampleに実IDを入れていません。
2. Botの接続所有者を選ぶ。既存Hermes Botの排他的切替ならHermes全Gatewayと監督の停止・復帰承認が必要です。既存gatewayを一切変えないなら専用Bot／資格情報の別承認が必要です。同じBot資格情報で並行受信する案は採用しません。FF15は対象外。
3. Keychain参照はdisabledテンプレートへ反映。実読出し/ACL/常駐セッションは未試験。private設定、MessageContentIntentの現在設定と必要な利用権限を確認。値を会話・ソース・ログへ表示／コピーしません。既存channel/OS権限を勝手に拡張しません。
4. [接続候補比較](docs/connection-options.md)のHTTPSまたはSecure MCP Tunnel、アクセス認証、専用principal/chat束縛を選び、その費用・既存契約・追加権限が許容範囲内か確認。Tunnelは未作成・未接続です。標準OAuth経路も実IdPへの適合と実resource/audienceの確認が必要です。
5. 選択後、実装済みのprivate token reader/JWKS provider/login bootstrapへ承認済みの実値を設定する。callback host、プラグイン接続、実際の「える」会話の永続購読、常駐/rollbackを承認。
6. 対象guildの既存テスト用thread、専用経路・認証・排他的Bot所有を確認した後、利用者の許可内でGateway受信→署名callback→当該dot wake→read/reply→同じthread返信を実測する。新OAuth grant、永続アクセス、課金、入口の新設や既存runtimeの恒久停止は、それぞれ個別に判断する。

Keychain参照名の組込みは完了しています。実秘密読出し・Bot接続・外部設定・常駐操作は未実施です。ローカルMCP toolsが見えるだけ、callbackが2xxだけでは6の成功と報告しません。

## 公開準備と実装経路

ソース/モック/手順はprivate設定・秘密・個人会話から分離しています。LICENSEは元コードの公開ライセンス未選定を明示し、NOTICEと [依存ライセンス記録](THIRD_PARTY_NOTICES.md) に採用版の確認結果を記録しました。lockfileは固定版です。shipped license/notice本文を `docs/licenses/` に保存しました。npm同梱のMIT本文がない3パッケージも、採用版のnpm gitHeadと一致する上流commitでname/version/licenseを照合し、本文・copyright・出典URL・SHA-256を補完済みです。将来の配布物には実際に含む依存の再点検と元コードのライセンス選定が必要です。npmやプラグインの公開は行っていません。ソースrepoは [plus-a7/dots-discord-bridge](https://github.com/plus-a7/dots-discord-bridge) に公開済みです。これは実Discord/ChatGPT接続やプラグイン公開を示しません。元コードのLICENSEを勝手に選定せず、[公開ファイル範囲](docs/publication-scope.md)を引き渡します。

既存Claude Code CLIの存在/版だけを確認しました。新しい認証やAPI費用なしで利用できる経路をこの作業では確定できなかったため、Claudeの生成実行は行わず、独立レビューとオフラインテストで確認しています。追加セッション履歴を参照していません。

## 公開ソースの検証範囲

この公開用コピーはソース、無効化されたexample、ダミーfixture、ビルド・テスト手順だけを含みます。実Discord、実IdP、Tunnel、実dot wakeは未試験です。IdPの即時失効通知には未対応で、期限、設定digestの失効、owner停止による制御を実装しています。実サービスへの接続成功や即時失効を保証するものではありません。

元コードの公開ライセンスは未選定です。既存LICENSE/NOTICEと第三者依存のライセンス記録を保持し、元コードへMIT等のOSSライセンスは追加していません。
