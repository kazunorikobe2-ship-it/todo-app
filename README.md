# Kanban Board (todo-app)

Trello風のカンバンボードアプリ。プレーンなHTML/CSS/JavaScript + Firebase Firestoreで作られており、ビルド不要。複数人が同時に開くと、片方の変更(カード移動・編集・コメント等)がリアルタイムにもう片方にも反映される。

## 機能

- プロジェクト単位でリスト・カードを管理(左ドロワーで切り替え、表示・非表示も可能)
- ボード / テーブル / カレンダー / タイムライン / ダッシュボードの5つの表示形式を切り替え可能
- リスト(列)の追加・削除・リネーム
- カードの追加・削除・ドラッグ&ドロップでリスト間移動
- カードをクリックすると詳細モーダルが開き、以下を編集できる
  - 開始日・期日
  - 重要度(低・中・高)
  - アサインメンバー(複数可)
  - 備考
  - コメント(投稿者名・日時つき)
- Firestoreでリアルタイム共同編集(複数ブラウザ・複数人で同期)
- Googleアカウントでのログイン(未ログインだとボードは閲覧・編集不可)
- カード・コメントへのファイル添付(1ファイル5MBまで、画像は小さいサムネイル表示)
- 削除確認モーダル + ゴミ箱(個別・一括の完全削除、復元、プロジェクト単位)
- プロジェクトはユーザーに紐づく(オーナー / 共同編集 / 閲覧のみ)。メールアドレスでメンバーを招待可能(実際のメール送信はされず、招待されたメールアドレスのGoogleアカウントでログインするとアクセスできるようになる仕組み)

## セットアップ

`config.js` に自分のFirebaseプロジェクトの `firebaseConfig` を設定する(すでに設定済み)。

### Firebase Authentication(Googleログイン)

Firebaseコンソール → Authentication → Sign-in method タブ → 「Google」を有効化する。

Authentication → Settings → 承認済みドメイン に、デプロイ先のドメイン(例: Vercelの `xxxx.vercel.app` や独自ドメイン)を追加する。これがないとログインポップアップが失敗する。

### Firestore ルール

プロジェクトはユーザーごとに紐づく(`projects` コレクション、1プロジェクト1ドキュメント)。オーナーのメールアドレスと、招待された共同編集者・閲覧者のメールアドレスの配列(`memberEmails`)を持たせ、そのどちらに含まれるアカウントでログインした人だけが読み書きできるようにする。Firebaseコンソール → Firestore Database → ルール タブで以下に置き換えて公開する:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // 旧バージョン(単一ドキュメント)からの移行処理に使うため残しておく
    match /kanban/{document=**} {
      allow read, write: if request.auth != null;
    }

    match /projects/{projectId} {
      allow read: if request.auth != null &&
        request.auth.token.email in resource.data.memberEmails;

      allow create: if request.auth != null &&
        request.auth.token.email == request.resource.data.ownerEmail;

      allow update: if request.auth != null && (
        request.auth.token.email == resource.data.ownerEmail ||
        (
          request.auth.token.email in resource.data.editors &&
          request.resource.data.ownerEmail == resource.data.ownerEmail &&
          request.resource.data.editors == resource.data.editors &&
          request.resource.data.viewers == resource.data.viewers &&
          request.resource.data.memberEmails == resource.data.memberEmails
        )
      );

      allow delete: if request.auth != null &&
        request.auth.token.email == resource.data.ownerEmail;
    }
  }
}
```

上のルールでは、オーナーはプロジェクトの削除・メンバー管理・内容編集すべてができ、共同編集者(editors)はボードの内容(リスト・カード等)は編集できるがメンバー構成や削除はできない、閲覧者(viewers)は読み取りのみ、という制御をルール側でも強制している。

招待は「メールアドレスをプロジェクトのメンバーとして登録する」だけで、実際のメール送信は行われない。招待された人がそのメールアドレスのGoogleアカウントでログインすると、自動的にそのプロジェクトへアクセスできるようになる。招待したことは別途本人に直接伝える必要がある。

### Firebase Storage(ファイル添付)

Firebaseコンソール → Storage → 「始める」でCloud Storageを有効化する(まだの場合)。

Storage → Rules タブで以下を貼って公開する。ログイン済みユーザーのみ読み書き可能、かつ1ファイル5MBまでという制限をルール側でも強制している:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /kanban/{allPaths=**} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.resource.size < 5 * 1024 * 1024;
    }
  }
}
```

## ローカルで開く

`index.html` をブラウザで開くだけで動作する(Firestoreへの通信にはインターネット接続が必要)。

## Vercelへのデプロイ

ビルド設定不要の静的サイトなので、Vercelでリポジトリをインポートするだけでデプロイできる。
