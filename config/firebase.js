const admin = require('firebase-admin');
require('dotenv').config();

/**
 * Build the Firebase Admin service-account credentials from environment
 * variables only — we never read a JSON file from disk, and we never ship
 * the JSON key inside the repository.
 *
 * Preferred (recommended): three individual variables
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY        (PEM, \n escapes are auto-unescaped)
 *
 * Fallback (still safe — env var, not a file):
 *   FIREBASE_SERVICE_ACCOUNT_JSON  (full JSON blob as a single line)
 */
function loadServiceAccount() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (projectId && clientEmail && privateKey) {
    // .env stores the PEM with literal "\n" — normalise back to real newlines.
    privateKey = privateKey.replace(/\\n/g, '\n');
    return { projectId, clientEmail, privateKey };
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      return {
        projectId: parsed.project_id,
        clientEmail: parsed.client_email,
        privateKey: (parsed.private_key || '').replace(/\\n/g, '\n')
      };
    } catch (e) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.');
    }
  }

  throw new Error(
    'Firebase credentials are missing. Set FIREBASE_PROJECT_ID, ' +
    'FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in backend/.env ' +
    '(or provide FIREBASE_SERVICE_ACCOUNT_JSON as a single-line JSON). ' +
    'Service-account JSON files MUST NOT be committed to the repository.'
  );
}

const serviceAccount = loadServiceAccount();

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL:
      process.env.FIREBASE_DATABASE_URL ||
      `https://${serviceAccount.projectId}-default-rtdb.firebaseio.com`,
    storageBucket:
      process.env.FIREBASE_STORAGE_BUCKET ||
      `${serviceAccount.projectId}.firebasestorage.app`
  });
}

const db = admin.firestore();
const realtimeDb = admin.database();
const auth = admin.auth();
const storage = admin.storage();

module.exports = { admin, db, realtimeDb, auth, storage };
