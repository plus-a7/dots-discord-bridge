# Login Keychain credential reference

2026-10-09。本人が報告したservice `DOTS_DISCORD_BOT`、account `discord` の**参照名**だけをdisabled設定テンプレートへ組み込みました。本物の項目の有無・内容・ACL・unlock状態は調べていません。Hermes停止も未確認です。実秘密読出し、Discordへの送信、Bot login、常駐登録/起動は今回行っていません。

`deployment.example.json` の `credential` は次の形式です。元コードのAPI/fixtureへtokenを埋め込まず、設定に秘密値のフィールドはありません。credential未指定/不完全は拒否し、旧設定へ自動fallbackしません。

```json
{"kind":"keychain","service":"DOTS_DISCORD_BOT","account":"discord","timeoutMs":2000}
```

採用Keychain経路は、明示activateと全確認flag・private境界・共有Bot leaseの確認後にだけ実行します。login keychainのgeneric passwordを完全一致service/accountで検索し、他Keychain・環境変数・tokenファイル・`security -w`へfallbackしません。既存の専用ファイルreaderは、明示した別設定 `{"kind":"private_file"}` の場合だけ動きます。今回そのファイルに秘密を保存していません。

小さなSwift helperはmacOSのSecurity/LocalAuthentication frameworkを使います。`SecKeychainSetUserInteractionAllowed(false)` と `LAContext.interactionNotAllowed=true` でUI認証を禁止し、`kSecMatchSearchList`をlogin keychainだけに束縛します。拒否・locked・項目なし・UIが必要な場合はgeneric失敗だけを返します。自動unlock・ACL変更・許可ダイアログの承認は行いません。legacy login-keychain APIはSDKでdeprecatedですが、本人指定のlogin keychainを限定するため使用しています。現行APIのデータ保護Keychainへ勝手に移行しません。

Nodeは固定したhelperだけをshellなしで起動し、argvには非秘密参照名だけ、envはPATHだけを渡します。stdin/stdout/stderrはignore。秘密は追加fd 3の専用pipeだけを通り、最大256bytes/32chunks、50–3000msの期限と停止signalを適用します。helperはfd 3がpipe/socketでなければKeychainへ問い合わせる前に停止します。公開のcredential表示/診断コマンドはありません。実helperを有効なfd 3で手動実行する確認は、秘密読出しになるため今回行いません。

読出し成功はhelperの終了成功・pipe完了・Bot token形式をすべて確認してから、Node内でSDKのlogin引数に渡します。標準出力/標準エラー・tool応答・ログ・設定ファイル・SQLiteへ保存する経路はありません。受信Bufferは消去しますが、Swift/JS/SDK内の管理メモリ全体を厳密にzeroizeする保証はありません。稼働中のSDKは通信に必要なtokenを保持します。OSアカウント・信頼した実行コード・メモリ/クラッシュダンプ保護は別境界です。

ビルドにはmacOSのXcode Command Line Tools（Swift compiler）が必要です。新しい外部依存は追加していません。

```sh
npm run typecheck
npm run build
npm run build:keychain
npm run test:unit
```

`build:keychain`はコンパイルだけです。`npm test`/`test:unit`もコンパイルします。試験はdummy値と注入した子process/pipeだけを使います。nativeの実行試験は不正argsまたは非pipe fd 3でKeychain IO前に拒否するケースだけで、本物の項目へ問い合わせません。9追加試験で未指定/拒否/空値/不正形式/過大出力/timeout/取消し/遅延結果/エラー非開示/旧設定拒否/Bootstrapへのmock受渡しを確認します。

起動前にはHermes Botの停止・自動復帰防止と排他的引渡し、owner/Bot/guild/Intent/権限、専用入口/認証、対象dot購読と限定live試験、launchd登録/起動の承認が残ります。実Keychainアクセスが拒否される場合は、本人の許可・unlock・ACL確認を個別に相談して停止し、読出し迂回や秘密のコピーは行いません。

公式APIとSDK headerの説明を確認：[UI制限](https://developer.apple.com/documentation/security/seckeychainsetuserinteractionallowed(_:))、[SecItemCopyMatching](https://developer.apple.com/documentation/security/secitemcopymatching(_:_:))。実Keychain/常駐セッションでの互換性・ACL・no-UI動作は未試験です。
