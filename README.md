# StageVector Motion

iPhone Safariで加速度・角速度を記録し、CANログとの比較用CSVを保存する静的ページです。HTTPSで開いてください。実際のiPhoneでのセンサー許可・取得周期・保存操作は端末で確認が必要です。

## 使い方

1. iPhoneを固定し、取り付け方向をメモします。
2. 「計測を開始」を押して動作センサーを許可します。
3. Safariを前面表示したまま計測します。
4. 「停止して保存」の後、「CSVを保存」または共有からファイルへ書き出します。

画面ロック・別アプリへの切替では記録を中断し、自動再開しません。保存済み部分は「この端末の記録」から回収できます。未保存の最大約1秒分や、OSが即停止した直前のデータを保証するものではありません。ブラウザーのデータ消去・ストレージ回収で記録を失うことがあるため、計測後にCSVを書き出してください。

## データ

外部ライブラリー・分析タグ・データ送信処理を使いません。ページ配信サービス自体のアクセス記録とは別に、センサー値は端末のIndexedDBへ保存します。位置情報・カメラ・マイクは要求しません。

CSVはUTF-8 BOM付き、20列固定。META / EVENT / SAMPLE / SUMMARYの各行を同じ列で保存します。加速度はm/s²、角速度はdeg/s。画面の加速度だけgへ換算します。加速度・重力込み加速度・角速度の未取得値は空欄で、0に置換しません。

`t_us`は計測開始からの単調増加時刻、`epoch_ms`は開始時の時計＋経過時間、`wall_ms`は各イベント時の端末時計です。CANと時計を自動同期していないため、最後は波形を照合してください。α/β/γはブラウザーの端末軸で、車体ヨーへの自動割当ては行いません。

100msを超える間隔をSAMPLE_GAPとして残します。5秒の無受信で停止、30分で正常停止するのはこの比較ツールの設計判断です。固定取得周波数を保証しません。画面維持APIは拒否・解除されることがあります。

模擬データは明示して開始した場合だけ生成します。画面にSIMと表示し、CSVのsourceとファイル名もSIMに分けます。センサー取得に失敗しても自動で模擬値へ切り替えません。

## GitHub Pages

このディレクトリーの公開用ファイルだけを専用リポジトリーへ配置し、Settings → Pages → Deploy from a branch → main / (root) で配信できます。車両ログなどをアップロードする必要はありません。ビルド不要で、`.nojekyll`を含めます。

## 参照

- [W3C Device Orientation and Motion, 2026-10-26 draft](https://www.w3.org/TR/2026/CRD-orientation-event-20261026/)
- [WebKit: motion permission requires user interaction](https://bugs.webkit.org/show_bug.cgi?id=201676)
- [WebKit: Safari 16.4 / Screen Wake Lock](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)
- [W3C IndexedDB 3.0](https://www.w3.org/TR/IndexedDB/)
- [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)
