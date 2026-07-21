# Kanban Board (todo-app)

Trello風のカンバンボードアプリ。プレーンなHTML/CSS/JavaScript + Firebase Firestoreで作られており、ビルド不要。複数人が同時に開くと、片方の変更(カード移動・編集・コメント等)がリアルタイムにもう片方にも反映される。

## 機能

- リスト(列)の追加・削除・リネーム
- カードの追加・削除・ドラッグ&ドロップでリスト間移動
- カードをクリックすると詳細モーダルが開き、以下を編集できる
  - 期日
  - 重要度(低・中・高)
  - アサインメンバー(複数可)
  - 備考
  - コメント(投稿者名・日時つき)
- Firestoreでリアルタイム共同編集(複数ブラウザ・複数人で同期)

## セットアップ

`config.js` に自分のFirebaseプロジェクトの `firebaseConfig` を設定する(すでに設定済み)。

Firestoreのルールで読み書きを許可する必要がある。Firebaseコンソール → Firestore Database → ルール タブで以下を貼って公開する(認証なしの簡易版。誰でも読み書きできるので、社内ツール等の用途向け):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /kanban/{document=**} {
      allow read, write: if true;
    }
  }
}
```

## ローカルで開く

`index.html` をブラウザで開くだけで動作する(Firestoreへの通信にはインターネット接続が必要)。

## Vercelへのデプロイ

ビルド設定不要の静的サイトなので、Vercelでリポジトリをインポートするだけでデプロイできる。
