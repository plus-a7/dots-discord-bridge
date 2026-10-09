# 最小リリース候補：実装と本接続の境界

2026-10-09。独立Mac作業領域のオフライン候補です。コードは未設定で停止する明示login bootstrap、JWKS network provider、private reader、CLI/disabled常駐テンプレートを備え、ローカル検証済みです。実環境での設定・受入は残っています。実Bot接続・公開・常駐・実dot往復を完了した版ではありません。

| 境界 | 実装済み・隔離検証済み | 実環境で未実施／未確認 |
|---|---|---|
| Discord | discord.js正規化・宛先束縛・Gateway、専用秘密reader・明示login/ready・Bot lease | 実ID/秘密/intents/権限/reconnect |
| Queue / Events | SQLite排他・復旧、署名challenge・購読/解除、安定eventIDと再送、有限TTL、callback SSRF guard | 実ChatGPT callback host/TLSと購読会話の実測 |
| 認証 | 明示OAuth/CF factory、固定issuer/JWKS/resource/subject/scope、RS256、metadata/401、購読grant TTL/失効、caps/cache/timeout/cooldown | 実IdP/OAuth/profile/subject、Tunnel metadata/resource対応、即時IdP失効通知は未対応 |
| HTTP / lifecycle | loopback HTTP、worker、8 handler枠、取消し/drain、CLIとdisabled LaunchAgent | 専用HTTPS/Tunnel、監督登録、実Mac再起動/rollback |
| 実dot | 公式SDKのEventsとread/replyをモックで往復 | **親の実際の「える」会話への購読→非同期wake→実Discord返信は未試験** |

`BridgeRuntime`に認証済みGateway/Discord sender、callback transport、必須resourceAccess、RequestAuthenticatorを渡します。constructor/importは起動せず、`start()`がloopback HTTPとworkerだけを明示開始します。Bot loginは呼びません。`LoginBootstrap`/CLIは明示activateでcredential.kindの選択元だけを読み、loginとexpected Bot/guild確認後だけruntimeを開始します。未設定テンプレートはそれより前に停止します。秘密の自動探索やenv token loaderはありません。

今回、固定issuerのHTTPS JWKS取得とそのraw上限/abort/cooldown、専用owner600/O_NOFOLLOW token reader、login bootstrap、共有Bot lease、CLIの有限停止、未設定LaunchAgentを仕上げました。本接続の残りは [connect.md](connect.md) の実ID/intents/排他、専用入口/identity、private実値、実会話/投稿/常駐の承認と実測です。

`stop()`は受付とworkerを止め、認証を閉じ、Gatewayを解除/終了し、HTTP応答より遅れて生きるcustom handlerも追跡します。8件上限は切断後も実処理の終了まで保持します。drain失敗なら`clean:false,pending:true`でStoreを閉じず、処理終了後にstopを再試行します。loginが残る場合もleaseを保持し、初回SDK destroyは実login終了後に行います。CLIは有限drain後に自身processのみ終了し、そのOS lock/socketを回収します。既送信要求は撤回できず、返信結果不明はuncertainで自動再投稿しません。新instanceによる再起動は完了確認後です。

## 再現と証拠

```sh
npm run typecheck
npm run test:unit
npm run test:loopback
npm run demo:mock
```

125 socket-free casesと25 loopback cases、合計150件です。最新結果は検証記録に記載します。全件は`npm test`でも実行できます。loopbackはliteral127.0.0.1の一時listener・fake issuer/JWKS・fake Discord・署名mock callbackだけを使い、閉じます。sandboxのbind制限がある場合はその試験のローカル実行許可が必要です。demoはin-processでlistenerなし、`liveDiscordPosts:0, liveDotWake:false`です。

[詳細検証](validation.md)と[独立レビュー](independent-review.md)に根拠を保存しています。独立レビューで見つかったrequest取消し、応答読込上限、SDK応答後の遅延handler追跡・上限を修正し、回帰試験を追加しました。

## 親へ一括確認する接続承認

1. **Bot所有と秘密参照。** owner/Bot/guildの実ID、MessageContentIntent、既存閲覧/送信権限を再確認する。既存Hermesを使うなら影響範囲・監督停止・排他的切替・rollbackを承認する。既存gateway無変更なら専用Bot/資格情報の別承認が必要。同じBotの並行接続は行わない。Hermes Bot停止とKeychain参照組込みは個別に許可済み。限定読取では対象LaunchAgent/既知PIDが見えなかったが、plistの自動起動設定は残り、将来の再起動防止は未確認。他タスクの一括停止はしない。実Keychain読出し・Bot起動は行っていない。
2. **入口とidentity。** Cloudflare必須依存は除去した。標準OAuth＋Secure MCP Tunnel/HTTPS、または任意Cloudflareについて、実IdP・resource・owner subject、組織・権限・契約/料金・workspace対応を確認して実設定・接続を承認する。[認証手順](oauth.md)参照。既存POM/FF15の変更を含めない。
3. **実会話と配備。** 実装済みbootstrap/providerのprivate実設定、callback完全一致host、プラグイン接続、親の実「える」会話の購読、限定実Discord投稿試験、常駐/再起動/rollbackを承認する。

具体的な導入順序と受入証拠は[operations.md](operations.md)。callback 2xxや手動tools成功だけではwake成功としません。現段階で上記接続操作は実施していません。

元コードの公開LICENSEは未選定です。採用依存版のLICENSE/NOTICEと補完した上流MIT本文は保存済みですが、この実装担当は公開repo/push/配布を行っていません。公開許可後のrepo/stagingはGit担当が行い、[公開範囲](publication-scope.md)を引き渡します。公開コード・ダミーfixture・手順とprivate設定・秘密・会話は分離します。
