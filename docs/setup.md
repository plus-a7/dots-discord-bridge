# 配布後のローカルセットアップ確認

ソース公開と実接続は別です。このcheckoutは実Discord/ChatGPT接続を完了した配備物ではありません。元コードのLICENSEは未選定で、repo公開だけで利用・改変・再配布の許諾を付与しません。依存の採用版LICENSE/NOTICEは別に保存しています。

## ネットワーク・秘密を使わないチェック

Node 24.20.0以上とmacOSのSwift compiler/Xcode Command Line Toolsが必要です。下記はコード・fixtureの検証です。最初の `npm ci` だけは固定依存を取得する通信が必要で、接続アカウントや秘密を入力しません。必要ツールの新規インストールは自動実行せず、利用者が別途判断してください。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run build
npm run build:keychain
npm run setup:check
npm run test:unit
npm run test:loopback
npm run demo:mock
```

`setup:check` は公開checkout内のcanonical root内のregular file（no symlink/hardlink、最大64KiB）だけを読み、Node・依存のversion・Swift compilerの存在・JS/native buildの存在・disabledテンプレートを確認します。Swiftの確認は `xcrun --find swiftc` だけです。実helperを実行せず、Keychain/private設定/env/session/既存サービスを読みません。DNS/HTTP/listenerやBot loginも開始しません。buildの存在確認は署名/ACLやビルド内容の完全性を保証しないため、型検査・build・testsも実行します。

期待する結果は `offlineReady:true, liveReady:false, sourceLicense:"unselected"` です。exit 2ならJSON内のfalse項目を確認し、不足したローカル手順だけを行います。root package/依存parentのaliasや想定外package名も拒否します。checker自身はインストール・コンパイル・設定変更をしません。実接続可否や秘密の有効性を成功扱いするチェックではありません。

`test:unit` は125件のsocket-free検証、`test:loopback` は25件のliteral127.0.0.1一時listener検証です。全体150件は `npm test` でも実行できます。sandboxがbindを拒否する場合は一時loopback実行だけを許可する必要があります。外部公開や実Discord接続の許可と混同しません。macOS以外では現Swift build/scriptは対応外として停止します。

## 設定テンプレートの確認

OAuthは `deployment.example.json`、任意Cloudflareは `deployment.cloudflare.example.json` です。両方ともenabledと確認flagはfalse、実設定はnullです。CLIの静的checkへ渡すには絶対pathを使います。

```sh
node dist/src/main.js check --config /absolute/path/to/checkout/deployment.example.json
```

未設定テンプレートはexit 2 / `deployment_disabled_or_incomplete` が正常な結果です。実Bot tokenファイルをcheckへ渡しません。実設定は承認後に専用private 700/600境界へ作成し、version 2の認証・入口・本人/intents/排他を明示します。秘密値をソース・argv・env・ログ・chatへコピーしません。[認証設定](oauth.md)・[Keychain境界](keychain.md)

## 配布担当の確認

[publication-scope.md](publication-scope.md)のallowlistだけを新しいstagingへコピーし、private/DB/env/secret/log/実plist/生成binary/node_modulesを除外します。初回公開commitとの差分、ダミーID、秘密・会話不在、LICENSE未選定、NOTICEをstaging側でも確認します。テスト用tempファイルは配布しません。

## 本接続前

利用者が許可した既存ログイン・既存Botの範囲で限定疎通を行います。新IdPアカウント・OAuth grant・新token・永続アクセス・セキュリティ設定・課金・入口新設・既存runtimeの恒久停止は個別に判断してください。使える既存の専用接続を確認できなければ、その不足で止めます。health-only gatewayの成功を別機能の許可と解釈せず、既存serviceへ混載しません。[朝の手順](morning.md)に残る確認と実測証拠をまとめています。
