const express = require('express');
const admin = require('firebase-admin');

process.on('unhandledRejection', (r) => { console.error('unhandledRejection', r); });
process.on('uncaughtException', (e) => { console.error('uncaughtException', e); process.exit(1); });

// 1) Initialize Firebase Admin using FIREBASE_SERVICE_ACCOUNT_JSON env var
if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error('FIREBASE_SERVICE_ACCOUNT_JSON is not set. Exiting.');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} catch (e) {
  console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:', e);
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
    // If you use Realtime DB add databaseURL: "https://<your-project-id>.firebaseio.com"
  });
}
const db = admin.firestore();

// Import your function exports (index.js should export stkPush and darajaCallback)
const handlers = require('./index.js');

// Build Express server and routes
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => res.status(200).json({ ok: true }));

app.post('/stkPush', (req, res) => handlers.stkPush(req, res));
app.post('/darajaCallback', (req, res) => handlers.darajaCallback(req, res));

app.get('/', (req, res) => res.send('PayStore STK backend running'));

const port = process.env.PORT ? Number(process.env.PORT) : 10000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
