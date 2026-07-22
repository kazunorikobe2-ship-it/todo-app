// Initializes the Firebase Admin SDK once per serverless runtime instance.
// Uses a service account JSON pasted whole into the FIREBASE_SERVICE_ACCOUNT_KEY
// Vercel environment variable (Firebase console -> Project settings ->
// Service accounts -> Generate new private key). The Admin SDK bypasses
// Firestore security rules entirely, which is what lets the webhook write
// plan/subscription fields that regular signed-in users are not allowed to
// write to themselves.
const admin = require("firebase-admin");

function getAdminApp() {
  if (admin.apps.length) return admin.app();

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY environment variable is not set");
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (err) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON: " + err.message);
  }

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

function getAdminAuth() {
  getAdminApp();
  return admin.auth();
}

function getAdminDb() {
  getAdminApp();
  return admin.firestore();
}

// Verifies the Firebase ID token sent by the client in the
// `Authorization: Bearer <token>` header. Throws if missing/invalid.
async function requireAuth(req) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) {
    const err = new Error("Missing Authorization header");
    err.statusCode = 401;
    throw err;
  }
  try {
    const decoded = await getAdminAuth().verifyIdToken(match[1]);
    return decoded; // { uid, email, ... }
  } catch (err) {
    // Log the real underlying error (Admin SDK init failure, malformed
    // service account key, genuine expired/invalid token, etc.) so it shows
    // up in Vercel's function logs, and also surface it in the response
    // during setup/testing so it's actually diagnosable from the browser
    // console instead of a generic, misleading message.
    console.error("requireAuth failed:", err);
    const wrapped = new Error("認証エラー: " + (err.message || "Invalid or expired ID token"));
    wrapped.statusCode = 401;
    throw wrapped;
  }
}

module.exports = { admin, getAdminApp, getAdminAuth, getAdminDb, requireAuth };
