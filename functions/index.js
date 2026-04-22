const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();

const ingestSecret = defineSecret('GASTOSPE_INGEST_SECRET');

exports.syncTransactions = onRequest({ cors: true, region: 'us-central1' }, async (request, response) => {
  if (request.method !== 'POST') {
    response.status(405).json({ ok: false, message: 'Method not allowed' });
    return;
  }

  const authHeader = request.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!idToken) {
    response.status(401).json({ ok: false, message: 'Missing bearer token' });
    return;
  }

  let decodedToken;

  try {
    decodedToken = await admin.auth().verifyIdToken(idToken);
  } catch (error) {
    logger.error('Invalid token', error);
    response.status(401).json({ ok: false, message: 'Invalid auth token' });
    return;
  }

  if (!decodedToken.email_verified) {
    response.status(403).json({ ok: false, message: 'Verify email before syncing' });
    return;
  }

  const payload = parsePayload(request.body);
  const transactions = validateTransactions(payload.transactions);

  if (!transactions.length) {
    response.status(400).json({ ok: false, message: 'transactions is required' });
    return;
  }

  await writeTransactions({
    uid: decodedToken.uid,
    owner: payload.owner,
    syncMode: 'firebase',
    exportedAt: payload.exportedAt,
    transactions,
    syncMessage: 'Sincronizado en Firestore.',
  });

  logger.info('Transactions synced', { uid: decodedToken.uid, count: transactions.length });

  response.status(200).json({
    ok: true,
    inserted: transactions.length,
  });
});

exports.ingestAutomationTransactions = onRequest(
  {
    cors: true,
    region: 'us-central1',
    secrets: [ingestSecret],
  },
  async (request, response) => {
    if (request.method !== 'POST') {
      response.status(405).json({ ok: false, message: 'Method not allowed' });
      return;
    }

    const expectedSecret = ingestSecret.value();
    const receivedSecret = String(request.headers['x-gastospe-secret'] || '').trim();

    if (!expectedSecret || !receivedSecret || receivedSecret !== expectedSecret) {
      response.status(401).json({ ok: false, message: 'Invalid ingest secret' });
      return;
    }

    const payload = parsePayload(request.body);
    const uid = typeof payload.uid === 'string' ? payload.uid.trim() : '';
    const transactions = validateTransactions(payload.transactions);

    if (!uid) {
      response.status(400).json({ ok: false, message: 'uid is required' });
      return;
    }

    if (!transactions.length) {
      response.status(400).json({ ok: false, message: 'transactions is required' });
      return;
    }

    await writeTransactions({
      uid,
      owner: payload.owner,
      syncMode: 'firebase',
      exportedAt: payload.exportedAt,
      transactions,
      syncMessage: 'Ingresado por automatizacion.',
    });

    logger.info('Automation transactions ingested', {
      uid,
      count: transactions.length,
      source: payload.source || 'automation',
    });

    response.status(200).json({
      ok: true,
      inserted: transactions.length,
    });
  },
);

function parsePayload(body) {
  if (body && typeof body === 'object') {
    return body;
  }

  return {};
}

function validateTransactions(transactions) {
  if (!Array.isArray(transactions)) {
    return [];
  }

  return transactions
    .filter((transaction) => {
      return (
        transaction &&
        typeof transaction.id === 'string' &&
        typeof transaction.title === 'string' &&
        typeof transaction.date === 'string' &&
        typeof transaction.kind === 'string' &&
        Number.isFinite(Number(transaction.amount))
      );
    })
    .map((transaction) => ({
      id: transaction.id.trim(),
      kind: transaction.kind === 'income' ? 'income' : 'expense',
      title: transaction.title.trim() || 'Movimiento sin titulo',
      amount: Number(transaction.amount),
      category: String(transaction.category || 'Otros'),
      date: String(transaction.date),
      account: String(transaction.account || 'Otro'),
      note: String(transaction.note || ''),
      source: normalizeSource(transaction.source),
      rawText: String(transaction.rawText || ''),
      createdAt: String(transaction.createdAt || new Date().toISOString()),
      syncStatus: 'synced',
      syncMessage: '',
    }));
}

async function writeTransactions({ uid, owner, syncMode, exportedAt, transactions, syncMessage }) {
  const firestore = admin.firestore();
  const syncedAt = new Date().toISOString();

  for (const chunk of chunkItems(transactions, 400)) {
    const batch = firestore.batch();

    for (const transaction of chunk) {
      const ref = firestore.doc(`users/${uid}/transactions/${transaction.id}`);

      batch.set(
        ref,
        {
          id: transaction.id,
          kind: transaction.kind,
          title: transaction.title,
          amount: Number(transaction.amount),
          category: transaction.category,
          date: transaction.date,
          account: transaction.account,
          note: transaction.note,
          source: transaction.source,
          rawText: transaction.rawText,
          createdAt: transaction.createdAt,
          syncStatus: 'synced',
          syncMessage,
          owner: typeof owner === 'string' && owner.trim() ? owner.trim() : 'Mi tablero',
          syncMode,
          exportedAt: typeof exportedAt === 'string' ? exportedAt : syncedAt,
          syncedAt,
          uid,
        },
        { merge: true },
      );
    }

    await batch.commit();
  }
}

function chunkItems(items, size) {
  const groups = [];

  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }

  return groups;
}

function normalizeSource(source) {
  switch (String(source || '').toLowerCase()) {
    case 'gmail':
      return 'gmail';
    case 'whatsapp':
      return 'whatsapp';
    case 'notification':
      return 'notification';
    default:
      return 'manual';
  }
}
