const { onRequest } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();

exports.syncTransactions = onRequest(async (request, response) => {
  if (request.method !== 'POST') {
    response.status(405).json({ ok: false, message: 'Method not allowed' });
    return;
  }

  const payload = request.body;
  const batch = admin.firestore().batch();

  for (const transaction of payload.transactions || []) {
    const ref = admin.firestore().collection('transactions').doc(transaction.id);
    batch.set(ref, {
      ...transaction,
      owner: payload.owner,
      exportedAt: payload.exportedAt,
      syncMode: payload.syncMode,
      syncedAt: new Date().toISOString(),
    });
  }

  await batch.commit();
  logger.info('Transactions synced', { count: (payload.transactions || []).length });

  response.json({
    ok: true,
    inserted: (payload.transactions || []).length,
  });
});
