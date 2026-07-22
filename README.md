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
- Googleアカウント、またはメールアドレス+パスワードでのログイン・新規登録(未ログインだとボードは閲覧・編集不可)。パスワードを忘れた場合の再設定メールにも対応
- カード・コメントへのファイル添付(1ファイル5MBまで、画像は小さいサムネイル表示)
- 削除確認モーダル + ゴミ箱(個別・一括の完全削除、復元、プロジェクト単位)
- ログアウトも確認モーダルを経てから実行される
- プロジェクトはユーザーに紐づく(オーナー / 共同編集 / 閲覧のみ)。メールアドレスでメンバーを招待可能(実際のメール送信はされず、招待されたメールアドレスのアカウントでログインするとアクセスできるようになる仕組み)
- カレンダー表示は開始日〜期日の範囲を日ごとに表示(1日だけの期日にも対応)
- ヘッダーのユーザー名をクリックするとプロフィール設定(表示名・プラン)を編集できる
- カードにカバー(色 or 画像)を設定でき、ボードのカード一覧・カード詳細モーダルの両方に表示される
- カードのドラッグ&ドロップ時に挿入位置を点線プレースホルダーで表示し、同一リスト内の並び替えにも対応
- プラン(Free / Pro / Business)によって使える機能が変わる(下記「プラン制限」参照)。プロジェクトドロワー下部の案内、またはロックされた表示形式タブをクリックするとプラン比較モーダルが開く
- Businessプランのプロジェクトはオーナーが「公開共有リンク」を発行でき、リンクを知っている人なら誰でも(未ログインでも)そのプロジェクトを閲覧専用で見られる

## プラン制限

プランはプロジェクトの「オーナー」に紐づく(Trelloのボードと同じ考え方で、オーナーのプランがそのプロジェクトの機能を決める)。

| | Free | Pro | Business |
|---|---|---|---|
| プロジェクト数(オーナーとして) | 最大10個 | 無制限 | 無制限 |
| 表示形式 | ボード・テーブルのみ | 全形式(ボード/テーブル/カレンダー/タイムライン/ダッシュボード) | 全形式 |
| 添付ファイル1つあたりの上限 | 5MB | 150MB | 無制限 |
| 共同編集者の人数 | 制限なし | 制限なし | 制限なし |
| プロジェクトの公開共有リンク | 不可 | 不可 | 可 |

`kazunorikobe2@gmail.com` は固定の管理者(admin)アカウントとして扱われ、自分がオーナーのプロジェクトでは常にBusiness相当の制限なし状態になる(他人のプロジェクトの権限には影響しない)。

プランの変更はヘッダーのユーザー名から開くプロフィール設定、またはプラン比較モーダルの「このプランにする」ボタンから行える。実際の決済(Stripe連携)はまだ実装されておらず、現時点ではプランの切り替えのみが行われる。

## セットアップ

`config.js` に自分のFirebaseプロジェクトの `firebaseConfig` を設定する(すでに設定済み)。

### Firebase Authentication(Googleログイン + メール/パスワードログイン)

Firebaseコンソール → Authentication → Sign-in method タブ → 「Google」と「メール/パスワード」の両方を有効化する(メール/パスワードを有効化しないと新規登録・ログイン時にエラーになる)。

Authentication → Settings → 承認済みドメイン に、デプロイ先のドメイン(例: Vercelの `xxxx.vercel.app` や独自ドメイン)を追加する。これがないとGoogleログインポップアップが失敗する。

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

      // Businessプランのオーナーが「公開共有リンク」を有効にしたプロジェクトは、
      // ログインしていなくても(request.auth == null でも)読み取りだけ許可する。
      allow read: if resource.data.publicShareEnabled == true;

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

    // プロフィール(表示名・プラン等)。本人のみ読み書き可能。
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

上のルールでは、オーナーはプロジェクトの削除・メンバー管理・内容編集すべてができ、共同編集者(editors)はボードの内容(リスト・カード等)は編集できるがメンバー構成や削除はできない、閲覧者(viewers)は読み取りのみ、という制御をルール側でも強制している。

招待は「メールアドレスをプロジェクトのメンバーとして登録する」だけで、実際のメール送信は行われない。招待された人がそのメールアドレスのGoogleアカウントでログインすると、自動的にそのプロジェクトへアクセスできるようになる。招待したことは別途本人に直接伝える必要がある。

### Firebase Storage(ファイル添付)

Firebaseコンソール → Storage → 「始める」でCloud Storageを有効化する(まだの場合)。

Storage → Rules タブで以下を貼って公開する。ログイン済みユーザーのみ読み書き可能で、アップロードしようとしている本人の `users/{uid}` ドキュメントの `plan` を読みに行って、プラン別の上限(Free 5MB / Pro 150MB / Business 無制限)をルール側でも強制している(`kazunorikobe2@gmail.com` は常に無制限):

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /kanban/{allPaths=**} {
      allow read: if request.auth != null;

      allow write: if request.auth != null && (
        request.auth.token.email == 'kazunorikobe2@gmail.com' ||
        request.resource.size < (
          firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data.plan == 'business'
            ? 1024 * 1024 * 1024
            : firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data.plan == 'pro'
              ? 150 * 1024 * 1024
              : 5 * 1024 * 1024
        )
      );
    }
  }
}
```

補足: このルールは `users/{uid}` ドキュメントをアップロード時に参照するため、Firestoreの`users`コレクションが存在している必要がある(プロフィール設定を一度開けば自動作成される)。アプリ側(クライアント)でもプランに応じた上限を事前にチェックしているので、通常はここまで到達する前にアプリ側のメッセージで弾かれる。このルールはそれをすり抜けようとした場合の安全網。

## ローカルで開く

`index.html` をブラウザで開くだけで動作する(Firestoreへの通信にはインターネット接続が必要)。

## Vercelへのデプロイ

ビルド設定不要の静的サイトなので、Vercelでリポジトリをインポートするだけでデプロイできる。

## プロフィール・プラン(今後のStripe連携について)

プラン(Free/Pro/Business)は実際にプロジェクト数・表示形式・添付ファイル容量・公開共有の可否を制御している(詳細は上の「プラン制限」を参照)。ただし決済処理そのもの(Stripe連携)はまだ実装しておらず、プロフィール設定またはプラン比較モーダルからプランを選ぶと `users/{uid}` ドキュメントの `plan` フィールドが即座に書き換わるだけ。将来Stripeを繋ぐ場合は、Checkout完了後のWebhookを受けてこの `plan` フィールドを更新するサーバーサイド(Cloud Functionsなど)を追加するのが自然な流れになる。
