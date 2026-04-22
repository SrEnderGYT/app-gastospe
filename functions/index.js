const { onRequest } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();

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

  const payload = request.body && typeof request.body === 'object' ? request.body : {};
  const transactions = Array.isArray(payload.transactions) ? payload.transactions : [];

  if (!transactions.length) {
    response.status(400).json({ ok: false, message: 'transactions is required' });
    return;
  }

  const invalidTransaction = transactions.find((transaction) => {
    return (
      !transaction ||
      typeof transaction.id !== 'string' ||
      typeof transaction.title !== 'string' ||
      typeof transaction.date !== 'string' ||
      typeof transaction.kind !== 'string' ||
      !Number.isFinite(Number(transaction.amount))
    );
  });

  if (invalidTransaction) {
    response.status(400).json({ ok: false, message: 'Invalid transaction payload' });
    return;
  }

  const firestore = admin.firestore();
  const batch = firestore.batch();
  const syncedAt = new Date().toISOString();

  for (const transaction of transactions) {
    const ref = firestore.doc(`users/${decodedToken.uid}/transactions/${transaction.id}`);

    batch.set(
      ref,
      {
        id: transaction.id,
        kind: transaction.kind,
        title: transaction.title.trim(),
        amount: Number(transaction.amount),
        category: String(transaction.category || 'Otros'),
        date: transaction.date,
        account: String(transaction.account || 'Otro'),
        note: String(transaction.note || ''),
        source: String(transaction.source || 'manual'),
        rawText: String(transaction.rawText || ''),
        createdAt: String(transaction.createdAt || syncedAt),
        syncStatus: 'synced',
        syncMessage: 'Sincronizado en Firestore.',
        owner: typeof payload.owner === 'string' && payload.owner.trim() ? payload.owner.trim() : 'Mi tablero',
        syncMode: 'firebase',
        exportedAt: typeof payload.exportedAt === 'string' ? payload.exportedAt : syncedAt,
        syncedAt,
        uid: decodedToken.uid,
      },
      { merge: true },
    );
  }

  await batch.commit();
  logger.info('Transactions synced', { uid: decodedToken.uid, count: transactions.length });

  response.status(200).json({
    ok: true,
    inserted: transactions.length,
  });
});
