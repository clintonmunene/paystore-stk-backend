/**
 * v2-safe Cloud Functions entrypoint (stkPush, darajaCallback)
 * - Reads secrets from process.env (set via --set-secrets)
 * - Falls back to Firestore app_config/daraja if necessary
 */

const admin = require('firebase-admin');
const axios = require('axios');

// Safe firebase-admin init
if (!admin.apps.length) {
  try {
    admin.initializeApp();
  } catch (e) {
    // ignore if already initialized
  }
}
const db = admin.firestore();

// Helpers ------------------------------------------------
function normalizePhoneForDaraja(raw) {
  const s0 = (raw || '').toString().trim();
  if (!s0) throw new Error('Phone is empty');
  let s = s0.startsWith('+') ? s0.substring(1) : s0;
  s = s.replace(/\D/g,'');
  if (/^0[7]\d{8}$/.test(s)) return '254' + s.substring(1);
  if (/^[7]\d{8}$/.test(s)) return '254' + s;
  if (/^254[7]\d{8}$/.test(s)) return s;
  throw new Error('Unsupported phone format: ' + raw);
}

function utcTimestamp() {
  const now = new Date();
  const yyyy = now.getUTCFullYear().toString().padStart(4,'0');
  const mm = (now.getUTCMonth()+1).toString().padStart(2,'0');
  const dd = now.getUTCDate().toString().padStart(2,'0');
  const hh = now.getUTCHours().toString().padStart(2,'0');
  const min = now.getUTCMinutes().toString().padStart(2,'0');
  const ss = now.getUTCSeconds().toString().padStart(2,'0');
  return `${yyyy}${mm}${dd}${hh}${min}${ss}`;
}

function makePassword(paybill, passkey, timestamp) {
  const raw = paybill + passkey + timestamp;
  return Buffer.from(raw).toString('base64');
}

async function loadDarajaConfigFromFirestore() {
  const ref = db.collection('app_config').doc('daraja');
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  const have = data && data.consumerKey && data.consumerSecret && data.passkey && data.paybill && data.oauthurl && data.stkurl && data.callbackurl;
  if (!have) return null;
  return {
    consumerKey: data.consumerKey,
    consumerSecret: data.consumerSecret,
    passkey: data.passkey,
    paybill: data.paybill.toString(),
    oauthurl: data.oauthurl,
    stkurl: data.stkurl,
    callbackurl: data.callbackurl
  };
}

async function getDarajaConfig() {
  // Prefer environment variables (set via Secret Manager or env)
  const env = process.env;
  if (env.DARAJA_CONSUMER_KEY && env.DARAJA_CONSUMER_SECRET && env.DARAJA_PASSKEY && env.DARAJA_PAYBILL && env.DARAJA_OAUTHURL && env.DARAJA_STKURL && env.DARAJA_CALLBACKURL) {
    return {
      consumerKey: env.DARAJA_CONSUMER_KEY,
      consumerSecret: env.DARAJA_CONSUMER_SECRET,
      passkey: env.DARAJA_PASSKEY,
      paybill: env.DARAJA_PAYBILL.toString(),
      oauthurl: env.DARAJA_OAUTHURL,
      stkurl: env.DARAJA_STKURL,
      callbackurl: env.DARAJA_CALLBACKURL
    };
  }
  // Fallback to Firestore document if env not set
  const fsCfg = await loadDarajaConfigFromFirestore();
  if (fsCfg) return fsCfg;
  throw new Error('Daraja config missing. Set secrets or populate app_config/daraja in Firestore.');
}

async function getDarajaToken(oauthurl, consumerKey, consumerSecret) {
  const creds = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  const resp = await axios.get(oauthurl, {
    headers: { Authorization: `Basic ${creds}` },
    timeout: 15000,
    validateStatus: () => true
  });
  if (resp.status >= 200 && resp.status < 300 && resp.data && resp.data.access_token) {
    return resp.data.access_token;
  }
  const body = resp.data ? JSON.stringify(resp.data) : '';
  throw new Error(`daraja-oauth-error:status ${resp.status} ${body}`);
}

// Handlers ------------------------------------------------
/**
 * POST / HTTP
 * body: { phone, amount, uid?, accountRef?, description? }
 */
exports.stkPush = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  try {
    const body = (req.body && Object.keys(req.body).length) ? req.body : req.query;
    const phoneRaw = body.phone;
    const amount = parseInt(body.amount, 10);
    if (!phoneRaw || !amount) return res.status(400).json({ error: 'phone and amount required' });

    const cfg = await getDarajaConfig();
    // attempt token using oauthurl; if environment provides a full oauth URL variation, it should work
    let token;
    try {
      token = await getDarajaToken(cfg.oauthurl, cfg.consumerKey, cfg.consumerSecret);
    } catch (err) {
      // try sandbox url if oauthurl is missing or failing
      if (cfg.oauthurl && cfg.oauthurl.includes('api.safaricom.co.ke')) {
        const sandbox = cfg.oauthurl.replace('api.safaricom.co.ke', 'sandbox.safaricom.co.ke');
        token = await getDarajaToken(sandbox, cfg.consumerKey, cfg.consumerSecret);
      } else {
        throw err;
      }
    }

    const phone = normalizePhoneForDaraja(phoneRaw);
    const timestamp = utcTimestamp();
    const password = makePassword(cfg.paybill, cfg.passkey, timestamp);

    const stkBody = {
      BusinessShortCode: cfg.paybill,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: cfg.paybill,
      PhoneNumber: phone,
      CallBackURL: cfg.callbackurl,
      AccountReference: body.accountRef || phone,
      TransactionDesc: body.description || 'Payment'
    };

    const pendingRef = db.collection('payments_pending').doc();
    await pendingRef.set({
      uid: body.uid || null,
      msisdn: phone,
      amount: amount,
      checkoutRequestId: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'initiated',
      requestBody: stkBody
    });

    const resp = await axios.post(cfg.stkurl, stkBody, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 20000,
      validateStatus: () => true
    });

    let checkoutRequestId = null;
    if (resp && resp.data) {
      checkoutRequestId = resp.data.CheckoutRequestID || resp.data.checkoutRequestID || resp.data.CheckoutRequestId || null;
    }

    await pendingRef.update({
      checkoutRequestId: checkoutRequestId,
      status: resp.status >= 200 && resp.status < 300 ? 'pending' : 'failed',
      responseStatus: resp.status,
      responseBody: resp.data || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.status(200).json({ ok: true, status: resp.status, data: resp.data || null, checkoutRequestId });
  } catch (err) {
    console.error('stkPush error', err && err.stack ? err.stack : err);
    return res.status(502).json({ error: 'stk_push_failed', details: err && err.message ? err.message : String(err) });
  }
};

/**
 * POST /darajaCallback - Daraja calls here
 * Accepts both raw StkCallback structures and JSON-wrapped Body.StkCallback
 */
exports.darajaCallback = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  try {
    const body = req.body || {};
    const payload = body.Body && body.Body.stkCallback ? body.Body.stkCallback : (body.StkCallback || body.stkCallback || body);

    const checkoutRequestId = payload.CheckoutRequestID || payload.checkoutRequestID || null;
    const resultCode = payload.ResultCode || payload.resultCode || null;
    const resultDesc = payload.ResultDesc || payload.resultDesc || null;

    const docId = checkoutRequestId || db.collection('payments_results').doc().id;
    await db.collection('payments_results').doc(docId).set({
      raw: body,
      checkoutRequestId: checkoutRequestId,
      resultCode,
      resultDesc,
      receivedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    if (checkoutRequestId) {
      const q = await db.collection('payments_pending').where('checkoutRequestId','==',checkoutRequestId).limit(1).get();
      if (!q.empty) {
        const pdoc = q.docs[0].ref;
        await pdoc.update({
          status: resultCode === 0 ? 'success' : 'failed',
          resultCode,
          resultDesc,
          callbackAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('darajaCallback error', err && err.stack ? err.stack : err);
    return res.status(500).send('error');
  }
};
