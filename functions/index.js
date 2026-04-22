const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const crypto = require('crypto');

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
    const transactions = resolveAutomationTransactions(payload);

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

function resolveAutomationTransactions(payload) {
  const explicitTransactions = validateTransactions(payload.transactions);

  if (explicitTransactions.length) {
    return explicitTransactions;
  }

  return parseAutomationEntries(
    payload.entries || payload.captures || payload.notifications || payload.messages || [],
  );
}

function parseAutomationEntries(entries) {
  return validateAutomationEntries(entries)
    .map((entry) => buildTransactionFromAutomationEntry(entry))
    .filter(Boolean);
}

function validateAutomationEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries
    .filter((entry) => {
      if (!entry || typeof entry !== 'object') {
        return false;
      }

      const text =
        typeof entry.text === 'string'
          ? entry.text
          : typeof entry.rawText === 'string'
            ? entry.rawText
            : '';

      return Boolean(text.trim());
    })
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id.trim() : '',
      text:
        typeof entry.text === 'string'
          ? entry.text
          : typeof entry.rawText === 'string'
            ? entry.rawText
            : '',
      subject: typeof entry.subject === 'string' ? entry.subject.trim() : '',
      sender: typeof entry.sender === 'string' ? entry.sender.trim() : '',
      date:
        typeof entry.date === 'string' && entry.date.trim()
          ? entry.date.trim()
          : new Date().toISOString().slice(0, 10),
      createdAt:
        typeof entry.createdAt === 'string' && entry.createdAt.trim()
          ? entry.createdAt.trim()
          : new Date().toISOString(),
      source: normalizeSource(entry.source),
    }));
}

function buildTransactionFromAutomationEntry(entry) {
  const normalizedText = normalizeWhitespace(
    [entry.subject, entry.sender, entry.text].filter(Boolean).join('\n'),
  );

  if (!normalizedText || shouldIgnoreTransactionText(normalizedText)) {
    return null;
  }

  const amount = extractAmount(normalizedText);

  if (!amount) {
    return null;
  }

  const kind = inferKind(normalizedText);

  return {
    id:
      entry.id ||
      `automation-${crypto
        .createHash('sha1')
        .update(`${entry.source}|${entry.date}|${normalizedText}`)
        .digest('hex')
        .slice(0, 20)}`,
    kind,
    title: inferTitle(normalizedText, kind),
    amount,
    category: inferCategory(normalizedText, kind),
    date: entry.date,
    account: inferAccount(normalizedText),
    note: entry.subject || '',
    source: entry.source,
    rawText: normalizedText,
    createdAt: entry.createdAt,
    syncStatus: 'synced',
    syncMessage: '',
  };
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

function shouldIgnoreTransactionText(text) {
  return [
    /se rechazo tu compra/i,
    /compra fue rechazada/i,
    /compra no concretada/i,
    /configuracion de tarjeta/i,
    /experiencia de pago/i,
    /promo/i,
    /cyber/i,
    /descuento/i,
    /codigo de verificacion/i,
    /clave digital/i,
    /token digital/i,
    /estado de cuenta/i,
    /resumen de movimientos/i,
    /recordatorio de pago/i,
  ].some((pattern) => pattern.test(text));
}

function inferKind(text) {
  return /recibiste un yapeo|monto recibido|monto abonado|abono|deposito|te enviaron|te depositaron|recibiste una transferencia|transferencia recibida|ingreso/i.test(
    text,
  )
    ? 'income'
    : 'expense';
}

function inferAccount(text) {
  if (/yape|plin/i.test(text)) {
    return 'Yape/Plin';
  }

  if (/tarjeta|visa|mastercard|debito|credito|amex/i.test(text)) {
    return 'Tarjeta';
  }

  if (/transferencia|bcp|interbank|bbva|scotiabank|deposito|abono|cuenta ahorro|cuenta corriente/i.test(text)) {
    return 'Transferencia';
  }

  return 'Otro';
}

function inferCategory(text, kind) {
  if (kind === 'income') {
    return 'Ingreso';
  }

  if (/plin|yape|yapeo a celular|transferiste|transferencia enviada|enviaste|transferencia/i.test(text)) {
    return 'Transferencias';
  }

  if (/(uber|didi|cabify|taxi|rides|movilidad|peaje)/i.test(text)) {
    return 'Transporte';
  }

  if (/(rappi|restaurante|cafe|supermercado|plaza vea|tottus|wong|metro|tambo|comida|almuerzo|menu)/i.test(text)) {
    return 'Comida';
  }

  if (/(farmacia|clinica|medicina|salud|seguro)/i.test(text)) {
    return 'Salud';
  }

  if (/(luz|agua|internet|gas|telefono)/i.test(text)) {
    return 'Servicios';
  }

  if (/(spotify|netflix|apple|icloud|google one|suscripcion|subscription)/i.test(text)) {
    return 'Suscripciones';
  }

  if (/(ripley|saga|zara|h&m|compra)/i.test(text)) {
    return 'Compras';
  }

  return 'Otros';
}

function inferTitle(text, kind) {
  const companyMatch =
    text.match(/empresa\s+([A-Za-z0-9* .&-]{2,60})/i) ||
    text.match(/comercio\s+([A-Za-z0-9* .&-]{2,60})/i) ||
    text.match(/establecimiento\s+([A-Za-z0-9* .&-]{2,60})/i) ||
    text.match(/en\s+([A-Za-z0-9* .&-]{2,60}?)(?=\.|\n| con|$)/i) ||
    text.match(/en\s+(PLIN-[A-Za-z0-9 .&-]{2,60})/i) ||
    text.match(/consumo por .*? en\s+([A-Za-z0-9* .&-]{2,60}?)(?=\.|\n| con|$)/i);

  if (companyMatch && companyMatch[1] && !/^tu cuenta|^cuenta/i.test(companyMatch[1].trim())) {
    return beautifyCounterparty(companyMatch[1]);
  }

  const senderMatch =
    text.match(/enviado por\s+([A-Za-z0-9 .&-]{3,80}?)(?=\.|\n| en | desde |$)/i) ||
    text.match(/recibiste un yapeo de .*? de ([A-Za-z0-9 .&-]{3,80}?)(?=\.|\n| en | desde |$)/i) ||
    text.match(/recibiste una transferencia .*? de ([A-Za-z0-9 .&-]{3,80}?)(?=\.|\n| en | desde |$)/i) ||
    text.match(/te depositaron .*? de ([A-Za-z0-9 .&-]{3,80}?)(?=\.|\n| en | desde |$)/i) ||
    text.match(/transferencia .*? a ([A-Za-z0-9 .&-]{3,80}?)(?=\.|\n| en | desde |$)/i) ||
    text.match(/beneficiario\s+([A-Za-z0-9 .&-]{3,80}?)(?=\.|\n| en | desde |$)/i) ||
    text.match(/(?:a|de|para)\s+([A-Za-z0-9 .&-]{3,80}?)(?=\.|\n| en | desde |$)/i);

  if (senderMatch && senderMatch[1]) {
    return beautifyCounterparty(senderMatch[1]);
  }

  return kind === 'income' ? 'Ingreso detectado' : 'Gasto detectado';
}

function extractAmount(text) {
  const prioritizedPatterns = [
    /monto recibido\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /monto abonado\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /te depositaron\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /recibiste una transferencia(?:\s+por)?\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /transferencia(?:\s+por|\s+de)?\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /total del consumo\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /importe de (?:la )?compra\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /compra por\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /consumo por\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /realizaste un consumo de\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /recibiste un yapeo de\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
  ];

  for (const pattern of prioritizedPatterns) {
    const match = text.match(pattern);

    if (match && match[1]) {
      return normalizeAmount(match[1]);
    }
  }

  const fallback = text.match(
    /(?:s\/|\$|pen|usd)?\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{1,2})?)/i,
  );

  return fallback && fallback[1] ? normalizeAmount(fallback[1]) : null;
}

function normalizeAmount(rawAmount) {
  const normalized = rawAmount.replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function beautifyCounterparty(rawValue) {
  const cleaned = String(rawValue)
    .replace(/^plin-/i, '')
    .replace(/^(pyu|dlc)\*/i, '')
    .replace(/\s+-\s+servicio de notificaciones bcp$/i, '')
    .replace(/\s+-\s+bbva$/i, '')
    .replace(/\s+bbva$/i, '')
    .replace(/[.]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const dictionary = {
    uber: 'Uber',
    'uber rides': 'Uber Rides',
    'uber trip': 'Uber Trip',
    didi: 'Didi',
    rappi: 'Rappi',
    'pyu uber': 'Uber',
    'tambo 2': 'Tambo',
  };

  const lower = cleaned.toLowerCase();

  if (dictionary[lower]) {
    return dictionary[lower];
  }

  return cleaned
    .split(' ')
    .filter(Boolean)
    .map((word) => {
      if (word.length <= 3 && /^[A-Z0-9*]+$/.test(word)) {
        return word.replace('*', '');
      }

      const normalizedWord = word.replace('*', '');
      return normalizedWord.charAt(0).toUpperCase() + normalizedWord.slice(1).toLowerCase();
    })
    .join(' ')
    .trim();
}

function normalizeWhitespace(rawText) {
  return String(rawText || '')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
