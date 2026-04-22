const CONFIG = {
  functionUrl:
    'https://us-central1-app-gastospe.cloudfunctions.net/ingestAutomationTransactions',
  ingestSecret: readScriptConfig_('GASTOSPE_INGEST_SECRET', 'REEMPLAZAR_CON_SECRET'),
  firebaseUid: readScriptConfig_('GASTOSPE_FIREBASE_UID', 'k4isjFEKaPT2pcunssO1XN1unPp2'),
  owner: 'Mi tablero',
  processedLabel: 'gastospe-procesado',
  gmailQuery:
    'newer_than:14d from:notificaciones@notificacionesbcp.com.pe (yapeo OR consumo OR plin OR abono OR deposito)',
  maxThreads: 25,
};

function setupGastospeConfig() {
  const properties = PropertiesService.getScriptProperties();
  properties.setProperties({
    GASTOSPE_FIREBASE_UID: 'k4isjFEKaPT2pcunssO1XN1unPp2',
  }, true);

  Logger.log(
    'UID listo. Ahora guarda tambien GASTOSPE_INGEST_SECRET en Script Properties o con setIngestSecret_().',
  );
}

function setIngestSecret_(secret) {
  const normalizedSecret = String(secret || '').trim();

  if (!normalizedSecret) {
    throw new Error('Ingresa un secreto valido antes de guardarlo.');
  }

  PropertiesService.getScriptProperties().setProperty(
    'GASTOSPE_INGEST_SECRET',
    normalizedSecret,
  );
  Logger.log('Se guardo GASTOSPE_INGEST_SECRET en Script Properties.');
}

function showCurrentConfig_() {
  Logger.log(
    JSON.stringify(
      {
        functionUrl: CONFIG.functionUrl,
        firebaseUid: CONFIG.firebaseUid,
        owner: CONFIG.owner,
        processedLabel: CONFIG.processedLabel,
        gmailQuery: CONFIG.gmailQuery,
        hasIngestSecret:
          CONFIG.ingestSecret && CONFIG.ingestSecret !== 'REEMPLAZAR_CON_SECRET',
      },
      null,
      2,
    ),
  );
}

function ingestBcpFinanceEmails() {
  validateConfig_();

  const transactions = collectCandidateTransactions_();

  if (!transactions.length) {
    Logger.log('No se detectaron movimientos nuevos para enviar.');
    return;
  }

  postTransactions_(transactions);
  Logger.log(`Movimientos enviados: ${transactions.length}`);
}

function previewRecentMatches() {
  const transactions = collectCandidateTransactions_({ skipLabeling: true });

  Logger.log(JSON.stringify(transactions, null, 2));

  if (!transactions.length) {
    Logger.log('No se detectaron movimientos nuevos.');
  }
}

function runParserSelfTest() {
  const fixtures = [
    {
      name: 'bcp_card_purchase',
      text:
        'Realizaste un consumo de S/ 6.30 con tu Tarjeta de Credito BCP en PYU*UBER.\n' +
        'Total del consumo\nS/ 6.30\nEmpresa\nPYU*UBER',
      expectedKind: 'expense',
      expectedTitle: 'Uber',
      expectedAmount: 6.3,
    },
    {
      name: 'bcp_yape_income',
      text:
        'Recibiste un yapeo de S/ 339.00 de Angelly Fiorella Carrion Ruiz.\n' +
        'Monto recibido\nS/ 339.00\nEnviado por\nAngelly Fiorella Carrion Ruiz',
      expectedKind: 'income',
      expectedTitle: 'Angelly Fiorella Carrion Ruiz',
      expectedAmount: 339,
    },
    {
      name: 'rejected_purchase',
      text:
        'Se rechazo tu compra por e-commerce no permitido.\n' +
        'Tu compra fue rechazada.\nMonto\nImporte de compra\nS/ 200.00',
      expectedIgnored: true,
    },
  ];

  const results = fixtures.map((fixture) => {
    const parsed = buildParsedDraft_(fixture.text, new Date('2026-04-22T00:00:00Z'));

    return {
      name: fixture.name,
      parsed: parsed,
      ok: fixture.expectedIgnored ? !parsed : Boolean(parsed),
    };
  });

  Logger.log(JSON.stringify(results, null, 2));
}

function createHourlyTrigger() {
  ScriptApp.newTrigger('ingestBcpFinanceEmails').timeBased().everyHours(1).create();
}

function deleteProjectTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    ScriptApp.deleteTrigger(trigger);
  });
}

function collectCandidateTransactions_(options) {
  const settings = options || {};
  const label = getOrCreateLabel_(CONFIG.processedLabel);
  const threads = GmailApp.search(
    `${CONFIG.gmailQuery} -label:${CONFIG.processedLabel}`,
    0,
    CONFIG.maxThreads,
  );
  const transactions = [];

  threads.forEach(function (thread) {
    const messages = thread.getMessages();
    let acceptedInThread = 0;

    messages.forEach(function (message) {
      const transaction = buildTransactionFromMessage_(message);

      if (transaction) {
        transactions.push(transaction);
        acceptedInThread += 1;
      }
    });

    if (!settings.skipLabeling && acceptedInThread > 0) {
      thread.addLabel(label);
    }
  });

  return transactions;
}

function buildTransactionFromMessage_(message) {
  const plainBody = (message.getPlainBody() || '').slice(0, 5000);
  const subject = message.getSubject() || 'Correo sin asunto';
  const sender = message.getFrom() || '';
  const text = `${subject}\n${sender}\n${plainBody}`.trim();

  if (!text || shouldIgnoreTransactionText_(text)) {
    return null;
  }

  const parsed = buildParsedDraft_(text, message.getDate());

  if (!parsed || !parsed.amount) {
    return null;
  }

  return {
    id: `gmail-${message.getId()}`,
    kind: parsed.kind,
    title: parsed.title,
    amount: parsed.amount,
    category: parsed.category,
    date: Utilities.formatDate(message.getDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    account: parsed.account,
    note: subject,
    source: 'gmail',
    rawText: text,
    createdAt: message.getDate().toISOString(),
  };
}

function buildParsedDraft_(text, fallbackDate) {
  const normalized = normalizeWhitespace_(text);

  if (!normalized || shouldIgnoreTransactionText_(normalized)) {
    return null;
  }

  return {
    kind: inferKind_(normalized),
    title: inferTitle_(normalized),
    amount: extractAmount_(normalized),
    category: inferCategory_(normalized),
    account: inferAccount_(normalized),
    date: Utilities.formatDate(fallbackDate || new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
  };
}

function postTransactions_(transactions) {
  const payload = {
    source: 'gmail-apps-script',
    uid: CONFIG.firebaseUid,
    owner: CONFIG.owner,
    exportedAt: new Date().toISOString(),
    transactions: transactions,
  };

  const response = UrlFetchApp.fetch(CONFIG.functionUrl, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-gastospe-secret': CONFIG.ingestSecret,
    },
    muteHttpExceptions: true,
    payload: JSON.stringify(payload),
  });

  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error(`Firebase respondio ${code}: ${body}`);
  }

  Logger.log(body);
}

function shouldIgnoreTransactionText_(text) {
  return [
    /se rechazo tu compra/i,
    /compra fue rechazada/i,
    /compra no concretada/i,
    /configuracion de tarjeta/i,
    /experiencia de pago/i,
    /promo/i,
    /cyber/i,
  ].some(function (pattern) {
    return pattern.test(text);
  });
}

function extractAmount_(text) {
  const prioritizedPatterns = [
    /monto recibido\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /total del consumo\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /realizaste un consumo de\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /recibiste un yapeo de\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
  ];

  for (let index = 0; index < prioritizedPatterns.length; index += 1) {
    const match = text.match(prioritizedPatterns[index]);

    if (match && match[1]) {
      return normalizeAmount_(match[1]);
    }
  }

  const fallback = text.match(
    /(?:s\/|\$|pen|usd)?\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{1,2})?)/i,
  );

  return fallback && fallback[1] ? normalizeAmount_(fallback[1]) : null;
}

function normalizeAmount_(rawAmount) {
  const normalized = rawAmount.replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function inferKind_(text) {
  return /recibiste un yapeo|monto recibido|abono|deposito|te enviaron|ingreso/i.test(text)
    ? 'income'
    : 'expense';
}

function inferCategory_(text) {
  if (inferKind_(text) === 'income') {
    return 'Ingreso';
  }

  if (/plin|yape/i.test(text)) {
    return 'Transferencias';
  }

  if (/uber|didi|cabify|taxi|rides|movilidad/i.test(text)) {
    return 'Transporte';
  }

  if (/rappi|restaurante|cafe|supermercado|comida|almuerzo|menu/i.test(text)) {
    return 'Comida';
  }

  if (/farmacia|clinica|medicina|salud/i.test(text)) {
    return 'Salud';
  }

  if (/luz|agua|internet|gas|telefono/i.test(text)) {
    return 'Servicios';
  }

  if (/spotify|netflix|apple|icloud|suscripcion/i.test(text)) {
    return 'Suscripciones';
  }

  return 'Otros';
}

function inferAccount_(text) {
  if (/yape|plin/i.test(text)) {
    return 'Yape/Plin';
  }

  if (/tarjeta|visa|mastercard|debito|credito/i.test(text)) {
    return 'Tarjeta';
  }

  if (/transferencia|bcp|interbank|bbva|scotiabank|deposito/i.test(text)) {
    return 'Transferencia';
  }

  return 'Otro';
}

function inferTitle_(text) {
  const companyMatch =
    text.match(/empresa\s+([A-Za-z0-9* .&-]{2,60})/i) ||
    text.match(/en\s+([A-Za-z0-9* .&-]{2,60})\./i) ||
    text.match(/en\s+(PLIN-[A-Za-z0-9 .&-]{2,60})/i);

  if (companyMatch && companyMatch[1]) {
    return beautifyCounterparty_(companyMatch[1]);
  }

  const senderMatch =
    text.match(/enviado por\s+([A-Za-z0-9 .&-]{3,80})/i) ||
    text.match(/recibiste un yapeo de .*? de ([A-Za-z0-9 .&-]{3,80})/i) ||
    text.match(/(?:a|de|para)\s+([A-Za-z0-9 .&-]{3,80})/i);

  if (senderMatch && senderMatch[1]) {
    return beautifyCounterparty_(senderMatch[1]);
  }

  return inferKind_(text) === 'income' ? 'Ingreso detectado' : 'Gasto detectado';
}

function beautifyCounterparty_(rawValue) {
  const cleaned = rawValue
    .replace(/^plin-/i, '')
    .replace(/^(pyu|dlc)\*/i, '')
    .replace(/\s+-\s+servicio de notificaciones bcp$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const dictionary = {
    uber: 'Uber',
    'uber rides': 'Uber Rides',
    didi: 'Didi',
    rappi: 'Rappi',
  };

  const lower = cleaned.toLowerCase();

  if (dictionary[lower]) {
    return dictionary[lower];
  }

  return cleaned
    .split(' ')
    .filter(Boolean)
    .map(function (word) {
      if (word.length <= 3 && /^[A-Z0-9*]+$/.test(word)) {
        return word.replace('*', '');
      }

      const normalizedWord = word.replace('*', '');
      return normalizedWord.charAt(0).toUpperCase() + normalizedWord.slice(1).toLowerCase();
    })
    .join(' ')
    .trim();
}

function normalizeWhitespace_(text) {
  return text.replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function validateConfig_() {
  if (CONFIG.ingestSecret === 'REEMPLAZAR_CON_SECRET') {
    throw new Error(
      'Completa CONFIG.ingestSecret o guarda GASTOSPE_INGEST_SECRET en Script Properties antes de ejecutar el script.',
    );
  }

  if (!CONFIG.firebaseUid || CONFIG.firebaseUid === 'REEMPLAZAR_CON_UID') {
    throw new Error(
      'Completa CONFIG.firebaseUid o guarda GASTOSPE_FIREBASE_UID en Script Properties antes de ejecutar el script.',
    );
  }
}

function readScriptConfig_(key, fallback) {
  const storedValue = PropertiesService.getScriptProperties().getProperty(key);
  return storedValue ? storedValue.trim() : fallback;
}
