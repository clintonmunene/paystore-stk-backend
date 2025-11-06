// functions/src/index.ts â€” Spark-plan friendly
// Uses v2 HTTPS callables (single `req` param), no scheduler, runtime config for creds.

import * as admin from 'firebase-admin';

// We use v2 `onCall` & `HttpsError` so the handler receives a single request object.
import { onCall, HttpsError } from 'firebase-functions/v2/https';

// We still read config from v1 namespace (allowed on Spark plan).
import * as functions from 'firebase-functions';

// If TypeScript ever complains about fetch in your environment, uncomment these lines:
// import fetch from 'node-fetch';
// (globalThis as any).fetch = fetch;

admin.initializeApp();
const db = admin.firestore();

// ----- Runtime config (you already set these):
// firebase functions:config:set oneisp.base="https://YOUR-ONEISP-BASE" oneisp.token="YOUR_LONG_BEARER_TOKEN"
const cfg = (process && process.env && Object.keys(process.env).length) ? {} : {}; // replaced functions.config() -> use process.env or Firestore
const ONE_ISP_BASE: string = (cfg.oneisp && cfg.oneisp.base) || '';
const ONE_ISP_TOKEN: string = (cfg.oneisp && cfg.oneisp.token) || '';

// ----- Helper to call One-ISP
async function oneIspGet(path: string): Promise<any> {
  if (!ONE_ISP_BASE || !ONE_ISP_TOKEN) {
    throw new Error('One-ISP config missing. Run: firebase functions:config:set oneisp.base="..." oneisp.token="..."');
  }
  const url = `${ONE_ISP_BASE}${path}`;
  const res: any = await (fetch as any)(url, {
    headers: { Authorization: `Bearer ${ONE_ISP_TOKEN}` },
  } as any);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`One-ISP ${res.status} ${res.statusText} :: ${url} :: ${text}`);
  }
  return res.json();
}

// ----- Mappers (adapt to your exact One-ISP payload)
function mapStats(accountNumber: string, stats: any) {
  return {
    accountNumber,
    expiryDate: String(stats?.expiryDate ?? stats?.expiresAt ?? ''),
    daysRemaining: Number(stats?.remainingDays ?? stats?.daysRemaining ?? 0),
    walletBalance: Number(stats?.walletBalance ?? stats?.wallet ?? 0),
    currentPackage: String(stats?.currentPackage ?? stats?.package ?? ''),
    status: String(stats?.status ?? 'Active'),
    usage: {
      downloadGB: Number(stats?.usage?.downloadGB ?? stats?.downloadGB ?? 0),
      uploadGB: Number(stats?.usage?.uploadGB ?? stats?.uploadGB ?? 0),
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function mapLogItem(it: any) {
  const when = it?.timestamp ?? it?.time ?? it?.createdAt ?? null;
  return {
    type: String(it?.type ?? it?.action ?? 'event'),
    at: when
      ? admin.firestore.Timestamp.fromDate(new Date(when))
      : admin.firestore.FieldValue.serverTimestamp(),
    details: String(it?.details ?? it?.note ?? it?.description ?? ''),
  };
}

function mapQuickNote(it: any) {
  return {
    title: String(it?.title ?? ''),
    body: String(it?.body ?? it?.content ?? ''),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

// ----- Core sync: pull from One-ISP and write to Firestore
async function syncCustomer(uid: string, customerId: string, accountNumber?: string) {
  // 1) Stats
  const stats = await oneIspGet(`/api/isp/customers/${customerId}/statistics`);
  const doc = mapStats(accountNumber ?? customerId, stats);
  await db.collection('customers').doc(uid).set(doc, { merge: true });

  // 2) Logs (optional)
  try {
    const logs = await oneIspGet(`/api/isp/customers/${customerId}/logs`);
    if (Array.isArray(logs)) {
      const batch = db.batch();
      const coll = db.collection('customers').doc(uid).collection('logs');
      logs.slice(0, 100).forEach((it: any) => {
        const id = (it.id ?? it._id ?? it.timestamp ?? Date.now()).toString();
        batch.set(coll.doc(id), mapLogItem(it), { merge: true });
      });
      await batch.commit();
    }
  } catch (e) {
    console.warn('Logs fetch failed (ignored):', e);
  }

  // 3) Quick template notes (optional, global)
  try {
    const notes = await oneIspGet(`/api/v2/setting/quick-template-note`);
    if (Array.isArray(notes)) {
      const batch = db.batch();
      const coll = db.collection('config').doc('quick_notes').collection('items');
      notes.slice(0, 100).forEach((it: any) => {
        const id = (it.id ?? it._id ?? it.title ?? `${Date.now()}`).toString();
        batch.set(coll.doc(id), mapQuickNote(it), { merge: true });
      });
      await batch.commit();
    }
  } catch (e) {
    console.warn('Notes fetch failed (ignored):', e);
  }
}

// ===== v2 Callables (single request object) =====

// First link + initial sync
export const linkAndSyncAccount = onCall(async (req) => {
  // Auth check
  if (!req.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  const uid = req.auth.uid;

  // Payload
  const customerId = String((req.data as any)?.customerId ?? '').trim();
  const accountNumber = (req.data as any)?.accountNumber
    ? String((req.data as any).accountNumber).trim()
    : undefined;
  const verificationCode = String((req.data as any)?.verificationCode ?? '').trim();

  if (!customerId || !verificationCode) {
    throw new HttpsError('invalid-argument', 'Missing customerId or verificationCode.');
  }

  await db.collection('links').doc(uid).set({ customerId, accountNumber, verified: true }, { merge: true });
  await syncCustomer(uid, customerId, accountNumber);
  return { ok: true };
});

// Manual refresh
export const refreshCustomerInfo = onCall(async (req) => {
  if (!req.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  const uid = req.auth.uid;

  const link = await db.collection('links').doc(uid).get();
  if (!link.exists || !link.data()?.verified) {
    throw new HttpsError('failed-precondition', 'Account not linked.');
  }

  const { customerId, accountNumber } = link.data() as { customerId: string; accountNumber?: string };
  await syncCustomer(uid, customerId, accountNumber);
  return { ok: true };
});

