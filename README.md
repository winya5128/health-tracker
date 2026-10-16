# 体重ノート（health-tracker）

iPhoneで毎日の体重・食事・血圧を記録し、7日移動平均で減量トレンドを見るための静的Webアプリ。
サーバーもデータベースも持たず、GitHub Pagesで配信する。

- **設計書**: [design.md](design.md)
- **iPhoneセットアップ手順**: [SETUP.md](SETUP.md)

## このリポジトリに健康データは入っていません

配信されるのは HTML / JavaScript / CSS だけで、記録した体重や食事は
**利用者のiPhone内（localStorage）と、利用者自身の非公開Gist**にしか保存されません。
リポジトリがpublicなのはGitHub PagesをFreeプランで使うための制約によるものです。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | 画面構造（5タブ＋下部タブバー） |
| `app.js` | 全ロジック（記録・集計・グラフ・Gistバックアップ） |
| `style.css` | スタイル（モバイルファースト、ライト/ダーク対応） |
| `sw.js` | Service Worker（オフラインキャッシュ） |
| `manifest.json` | PWAマニフェスト |
| `vendor/chart.umd.min.js` | Chart.js v4.4.4（CDNではなく同梱） |
| `icons/` | ホーム画面アイコン |

## 開発時の手順

ローカル確認（`file://` ではService Workerが動かないのでHTTPで開くこと）:

```bash
python -m http.server 8000
# http://127.0.0.1:8000/index.html
```

デプロイ:

```bash
git add -A && git commit -m "..." && git push
```

> **変更時の注意**: `index.html` / `app.js` / `style.css` のいずれかを変更したら、
> `sw.js` の `CACHE_VERSION` を必ず上げること。上げ忘れるとiPhone側が古いキャッシュのまま更新されない。
