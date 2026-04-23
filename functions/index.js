const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();

const ingestSecret = defineSecret('GASTOSPE_INGEST_SECRET');
const MAX_AUTOMATION_ITEMS = 50;
const MAX_TEXT_LENGTH = 12000;
const MAX_NOTE_LENGTH = 500;
const UID_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const TRUSTED_GMAIL_SENDERS = [
  /notificaciones@notificacionesbcp\.com\.pe/i,
  /procesos@bbva\.com\.pe/i,
];

// ─── syncTransactions ────────────────────────────────────────────────────────

exports.syncTransactions = onRequest({ cors: true, region: 'us-central1' }, async (request, response) => {
  if (request.method === 'GET') {
    response.status(200).json(
      buildEndpointInfo({
        endpoint: 'syncTransactions',
        method: 'POST',
        auth: 'Bearer Firebase ID token',
        body: ['transactions[]', 'owner', 'exportedAt'],
      }),
    );
    return;
  }

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

// ─── ingestAutomationTransactions ────────────────────────────────────────────

exports.ingestAutomationTransactions = onRequest(
  {
    cors: true,
    region: 'us-central1',
    secrets: [ingestSecret],
  },
  async (request, response) => {
    if (request.method === 'GET') {
      response.status(200).json(
        buildEndpointInfo({
          endpoint: 'ingestAutomationTransactions',
          method: 'POST',
          auth: 'Header x-gastospe-secret',
          body: ['uid', 'transactions[] o entries[]', 'owner', 'exportedAt'],
        }),
      );
      return;
    }

    if (request.method !== 'POST') {
      response.status(405).json({ ok: false, message: 'Method not allowed' });
      return;
    }

    const receivedSecret = String(request.headers['x-gastospe-secret'] || '').trim();

    if (!hasValidIngestSecret(receivedSecret)) {
      response.status(401).json({ ok: false, message: 'Invalid ingest secret' });
      return;
    }

    const payload = parsePayload(request.body);
    const uid = typeof payload.uid === 'string' ? payload.uid.trim() : '';
    const transactions = resolveAutomationTransactions(payload);

    if (!isValidUid(uid)) {
      response.status(400).json({ ok: false, message: 'uid is required and must be valid' });
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

// ─── parseGmailMessage (Vertex AI + regex fallback) ──────────────────────────
//
// Acepta un email financiero crudo y devuelve una transacción estructurada.
// Primero intenta Vertex AI Gemini Flash; si falla, cae a regex.
// Payload: { subject, body, sender, date, uid }
// Header: x-gastospe-secret

exports.parseGmailMessage = onRequest(
  {
    cors: true,
    region: 'us-central1',
    secrets: [ingestSecret],
    timeoutSeconds: 30,
  },
  async (request, response) => {
    if (request.method === 'GET') {
      response.status(200).json(
        buildEndpointInfo({
          endpoint: 'parseGmailMessage',
          method: 'POST',
          auth: 'Header x-gastospe-secret',
          body: ['uid', 'subject', 'body o text', 'sender', 'date'],
        }),
      );
      return;
    }

    if (request.method !== 'POST') {
      response.status(405).json({ ok: false, message: 'Method not allowed' });
      return;
    }

    const receivedSecret = String(request.headers['x-gastospe-secret'] || '').trim();

    if (!hasValidIngestSecret(receivedSecret)) {
      response.status(401).json({ ok: false, message: 'Invalid ingest secret' });
      return;
    }

    const payload = parsePayload(request.body);
    const uid = typeof payload.uid === 'string' ? payload.uid.trim() : '';
    const subject = String(payload.subject || '').trim();
    const body = String(payload.body || payload.text || '').trim();
    const sender = String(payload.sender || '').trim();
    const messageId = typeof payload.messageId === 'string' ? payload.messageId.trim() : '';
    const date =
      typeof payload.date === 'string' && payload.date.trim()
        ? payload.date.trim()
        : new Date().toISOString().slice(0, 10);

    if (!body && !subject) {
      response.status(400).json({ ok: false, message: 'body or subject is required' });
      return;
    }

    if (!isValidUid(uid)) {
      response.status(400).json({ ok: false, message: 'uid is required and must be valid' });
      return;
    }

    if ((subject + body).length > MAX_TEXT_LENGTH * 2) {
      response.status(413).json({ ok: false, message: 'Email body is too large' });
      return;
    }

    if (sender && !isTrustedGmailSender(sender)) {
      response.status(200).json({ ok: true, transaction: null, reason: 'untrusted-sender' });
      return;
    }

    const fullText = normalizeWhitespace(
      repairCommonEncoding([subject, sender, body].filter(Boolean).join('\n')),
    );

    if (shouldIgnoreTransactionText(fullText)) {
      logger.info('Email filtered out', { uid, reason: 'ignored pattern' });
      response.status(200).json({ ok: true, transaction: null, reason: 'filtered' });
      return;
    }

    let transaction = null;
    let parseMethod = 'none';

    // 1. Intentar Vertex AI Gemini
    try {
      transaction = await parseWithVertexAI(fullText, date, subject, messageId);
      if (transaction) {
        parseMethod = 'vertex-ai';
      }
    } catch (aiError) {
      logger.warn('Vertex AI parsing failed, falling back to regex', { error: String(aiError) });
    }

    // 2. Fallback a regex
    if (!transaction) {
      const amount = extractAmount(fullText);
      if (amount) {
        const kind = inferKind(fullText);
        transaction = {
          id: messageId ? `gmail-${messageId}` : buildStableId('gmail', date, fullText),
          kind,
          title: inferTitle(fullText, kind),
          amount,
          category: inferCategory(fullText, kind),
          date,
          account: inferAccount(fullText),
          note: subject,
          source: 'gmail',
          rawText: fullText,
          createdAt: new Date().toISOString(),
          syncStatus: 'synced',
          syncMessage: 'Parseado por regex',
        };
        parseMethod = 'regex';
      }
    }

    if (transaction) {
      await writeTransactions({
        uid,
        owner: '',
        syncMode: 'firebase',
        exportedAt: new Date().toISOString(),
        transactions: [transaction],
        syncMessage: `Procesado por ${parseMethod}.`,
      });
    }

    logger.info('Gmail message parsed', { uid, parseMethod, hasTransaction: Boolean(transaction) });

    response.status(200).json({
      ok: true,
      transaction,
      parseMethod,
    });
  },
);

// ─── Vertex AI parser ─────────────────────────────────────────────────────────

async function parseWithVertexAI(text, date, subject, messageId) {
  const { VertexAI } = require('@google-cloud/vertexai');

  const projectId = process.env.GCLOUD_PROJECT || admin.app().options.projectId;

  const vertexai = new VertexAI({ project: projectId, location: 'us-central1' });

  const model = vertexai.getGenerativeModel({
    model: 'gemini-2.0-flash-001',
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  });

  const prompt = `Analiza esta notificación bancaria o financiera peruana y extrae la transacción.

CORREO:
${text}

Responde SOLO con JSON válido. Si NO es una transacción financiera real, responde: null

Esquema esperado:
{
  "amount": <número positivo con hasta 2 decimales>,
  "currency": <"PEN" | "USD">,
  "merchant": <nombre del comercio o persona, string corto>,
  "category": <"Comida" | "Transporte" | "Transferencias" | "Suscripciones" | "Salud" | "Compras" | "Servicios" | "Ingreso" | "Casa" | "Otros">,
  "kind": <"expense" | "income">,
  "date": <"YYYY-MM-DD">,
  "account": <"Tarjeta" | "Yape/Plin" | "Transferencia" | "Efectivo" | "Otro">
}`;

  const result = await model.generateContent(prompt);
  const rawText = result.response?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  if (!rawText || rawText.trim() === 'null') {
    return null;
  }

  let parsed;
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch {
    return null;
  }

  if (!parsed || !Number.isFinite(Number(parsed.amount)) || Number(parsed.amount) <= 0) {
    return null;
  }

  const amount = Math.round(Number(parsed.amount) * 100) / 100;
  const kind = parsed.kind === 'income' ? 'income' : 'expense';

  return {
    id: messageId ? `gmail-${messageId}` : buildStableId('ai', date, text),
    kind,
    title: beautifyCounterparty(String(parsed.merchant || '')) || (kind === 'income' ? 'Ingreso detectado' : 'Gasto detectado'),
    amount,
    category: String(parsed.category || (kind === 'income' ? 'Ingreso' : 'Otros')),
    date: String(parsed.date || date),
    account: String(parsed.account || 'Otro'),
    note: subject,
    source: 'gmail',
    rawText: text,
    createdAt: new Date().toISOString(),
    syncStatus: 'synced',
    syncMessage: 'Parseado por Vertex AI Gemini',
  };
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function parsePayload(body) {
  if (body && typeof body === 'object') {
    return body;
  }

  return {};
}

function hasValidIngestSecret(receivedSecret) {
  const expectedSecret = ingestSecret.value();

  if (!expectedSecret || !receivedSecret) {
    return false;
  }

  const expectedBuffer = Buffer.from(expectedSecret);
  const receivedBuffer = Buffer.from(receivedSecret);

  return (
    expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

function isValidUid(uid) {
  return UID_PATTERN.test(String(uid || '').trim());
}

function isTrustedGmailSender(sender) {
  return TRUSTED_GMAIL_SENDERS.some((pattern) => pattern.test(String(sender || '')));
}

function buildEndpointInfo({ endpoint, method, auth, body }) {
  return {
    ok: true,
    endpoint,
    ready: true,
    method,
    auth,
    body,
    message: 'Usa este endpoint desde Apps Script o backend. Abrirlo en el navegador solo muestra su estado.',
  };
}

function validateTransactions(transactions) {
  if (!Array.isArray(transactions)) {
    return [];
  }

  return transactions
    .slice(0, MAX_AUTOMATION_ITEMS)
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
      id: transaction.id.trim().slice(0, 120),
      kind: transaction.kind === 'income' ? 'income' : 'expense',
      title: sanitizeText(transaction.title, 160) || 'Movimiento sin titulo',
      // Precision fix: round to 2 decimal places to avoid IEEE 754 drift
      amount: Math.round(Number(transaction.amount) * 100) / 100,
      category: sanitizeText(transaction.category || 'Otros', 60) || 'Otros',
      date: normalizeDate(transaction.date),
      account: sanitizeText(transaction.account || 'Otro', 60) || 'Otro',
      note: sanitizeText(transaction.note || '', MAX_NOTE_LENGTH),
      source: normalizeSource(transaction.source),
      rawText: sanitizeText(transaction.rawText || '', MAX_TEXT_LENGTH),
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
    .slice(0, MAX_AUTOMATION_ITEMS)
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
      id: typeof entry.id === 'string' ? entry.id.trim().slice(0, 120) : '',
      text: sanitizeText(
        typeof entry.text === 'string'
          ? entry.text
          : typeof entry.rawText === 'string'
            ? entry.rawText
            : '',
        MAX_TEXT_LENGTH,
      ),
      subject: sanitizeText(typeof entry.subject === 'string' ? entry.subject.trim() : '', 200),
      sender: sanitizeText(typeof entry.sender === 'string' ? entry.sender.trim() : '', 200),
      date: normalizeDate(
        typeof entry.date === 'string' && entry.date.trim()
          ? entry.date.trim()
          : new Date().toISOString().slice(0, 10),
      ),
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
    id: entry.id || buildStableId(entry.source, entry.date, normalizedText),
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
          // Precision guaranteed: always stored as rounded float
          amount: Math.round(Number(transaction.amount) * 100) / 100,
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

function buildStableId(source, date, text) {
  return `automation-${crypto
    .createHash('sha1')
    .update(`${source}|${date}|${text}`)
    .digest('hex')
    .slice(0, 20)}`;
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
    /operacion rechazada/i,
    /configuracion de tarjeta/i,
    /experiencia de pago/i,
    /\bpromo\b/i,
    /\bcyber\b/i,
    /\bdescuento\b/i,
    /codigo de verificacion/i,
    /clave digital/i,
    /token digital/i,
    /clave de seguridad/i,
    /estado de cuenta/i,
    /resumen de movimientos/i,
    /recordatorio de pago/i,
    /activar tarjeta/i,
    /solicitud de prestamo/i,
    /informacion de tu credito/i,
    /actualiza.*datos/i,
    /nueva oferta/i,
  ].some((pattern) => pattern.test(text));
}

function inferKind(text) {
  return /recibiste un yapeo|monto recibido|monto abonado|abono en cuenta|deposito|te enviaron|te depositaron|recibiste una transferencia|transferencia recibida|sueldo|salario|honorarios|pago recibido|ingreso|reembolso|cashback/i.test(
    text,
  )
    ? 'income'
    : 'expense';
}

function inferAccount(text) {
  if (/yape|plin/i.test(text)) {
    return 'Yape/Plin';
  }

  if (/transferencia|deposito|abono|cuenta ahorro|cuenta de ahorro|cuenta corriente/i.test(text)) {
    return 'Transferencia';
  }

  if (/tarjeta|visa|mastercard|debito|credito|amex/i.test(text)) {
    return 'Tarjeta';
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

  if (/(uber|didi|cabify|taxi|rides|movilidad|peaje|tren|metro lima|bus|combi)/i.test(text)) {
    return 'Transporte';
  }

  if (/(rappi|mcdonalds|kfc|burger king|pizza|restaurante|cafe|cafeteria|supermercado|plaza vea|tottus|wong|metro|tambo|comida|almuerzo|menu|delivery|pedidosya|inkafarma)/i.test(text)) {
    return 'Comida';
  }

  if (/(farmacia|clinica|medicina|salud|seguro medico|hospital|laboratorio|botica)/i.test(text)) {
    return 'Salud';
  }

  if (/(luz|agua|internet|claro|movistar|entel|bitel|gas|telefono|recibo|pago de servicio)/i.test(text)) {
    return 'Servicios';
  }

  if (/(spotify|netflix|apple|icloud|google one|disney|hbo|amazon prime|suscripcion|subscription|prime video)/i.test(text)) {
    return 'Suscripciones';
  }

  if (/(ripley|saga|zara|h&m|falabella|oechsle|compra|tienda|mall|ropa|calzado)/i.test(text)) {
    return 'Compras';
  }

  if (/(alquiler|mantenimiento|condominio|municipalidad|predial|hipoteca)/i.test(text)) {
    return 'Casa';
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
    /monto\s*:\s*(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /importe\s*:\s*(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /por\s+(?:s\/|\$)\s?(\d+(?:[.,]\d{1,2})?)/i,
  ];

  for (const pattern of prioritizedPatterns) {
    const match = text.match(pattern);

    if (match && match[1]) {
      return normalizeAmount(match[1]);
    }
  }

  const fallback = text.match(
    /(?:s\/|\$|pen|usd)\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{1,2})?)/i,
  );

  return fallback && fallback[1] ? normalizeAmount(fallback[1]) : null;
}

function normalizeAmount(rawAmount) {
  // Remove thousands separator dots, normalize comma to decimal point
  const normalized = rawAmount.replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const amount = parseFloat(normalized);
  // Fix IEEE 754 precision: always store with exactly 2 decimal places
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null;
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
    'mcdonalds': 'McDonald\'s',
    'plaza vea': 'Plaza Vea',
    netflix: 'Netflix',
    spotify: 'Spotify',
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

function sanitizeText(value, maxLength) {
  return String(value || '').slice(0, maxLength).trim();
}

function normalizeDate(value) {
  const normalized = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? normalized
    : new Date().toISOString().slice(0, 10);
}

function repairCommonEncoding(rawText) {
  return String(rawText || '')
    .replace(/Â¡/g, '¡')
    .replace(/Â¿/g, '¿')
    .replace(/Â/g, '')
    .replace(/Ã¡/g, 'á')
    .replace(/Ã©/g, 'é')
    .replace(/Ã­/g, 'í')
    .replace(/Ã³/g, 'ó')
    .replace(/Ãº/g, 'ú')
    .replace(/Ã±/g, 'ñ');
}
