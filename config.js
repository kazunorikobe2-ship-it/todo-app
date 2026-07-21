// Firebase config (client-side, safe to expose — access is controlled by Firestore security rules)
const firebaseConfig = {
  apiKey: "AIzaSyDUFu41wkWXgABDvWqPquhyaB3tD4MovoE",
  authDomain: "kanban-todo-app-9ea86.firebaseapp.com",
  projectId: "kanban-todo-app-9ea86",
  storageBucket: "kanban-todo-app-9ea86.firebasestorage.app",
  messagingSenderId: "210201939866",
  appId: "1:210201939866:web:12febc5a59bb1e6f7b7423",
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
