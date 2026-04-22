const CONFIG = {
  functionUrl:
    'https://us-central1-app-gastospe.cloudfunctions.net/ingestAutomationTransactions',
  ingestSecret: 'REEMPLAZAR_CON_SECRET',
  firebaseUid: 'REEMPLAZAR_CON_UID',
  owner: 'Mi tablero',
  processedLabel: 'gastospe-procesado',
  gmailQuery: 'newer_than:7d (yape OR plin)',
  maxThreads: 20,
};

function ingestYapePlinEmails() {
  validateConfig_();

  const label = getOrCreateLabel_(CONFIG.processedLabel);
  const threads = GmailApp.search(
    `${CONFIG.gmailQuery} -label:${CONFIG.processedLabel}`,
    0,
    CONFIG.maxThreads,
  );

  const transactions = [];

  threads.forEach((thread) => {
    const messages = thread.getMessages();

    messages.forEach((message) => {
      const transaction = buildTransactionFromMessage_(message);

      if (transaction) {
        transactions.push(transaction);
      }
    });

    if (messages.length) {
      thread.addLabel(label);
    }
  });

  if (!transactions.length) {
    Logger.log('No se detectaron movimientos nuevos.');
    return;
  }

  postTransactions_(transactions);
  Logger.log(`Movimientos enviados: ${transactions.length}`);
}

function createHourlyTrigger() {
  ScriptApp.newTrigger('ingestYapePlinEmails').timeBased().everyHours(1).create();
}

function deleteProjectTriggers() {
  ScriptApp.getProjectTriggers().forEach((trigger) => ScriptApp.deleteTrigger(trigger));
}

function buildTransactionFromMessage_(message) {
  const plainBody = (message.getPlainBody() || '').slice(0, 4000);
  const subject = message.getSubject() || 'Correo sin asunto';
  const sender = message.getFrom() || '';
  const text = `${subject}\n${sender}\n${plainBody}`.trim();

  if (!text) {
    return null;
  }

  const amount = extractAmount_(text);

  if (!amount) {
    return null;
  }

  const kind = inferKind_(text);
  const createdAt = message.getDate();

  return {
    id: `gmail-${message.getId()}`,
    kind,
    title: extractTitle_(subject, sender, text, kind),
    amount,
    category: inferCategory_(text, kind),
    date: Utilities.formatDate(createdAt, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    account: /yape|plin/i.test(text) ? 'Yape/Plin' : 'Transferencia',
    note: subject,
    source: 'gmail',
    rawText: text,
    createdAt: createdAt.toISOString(),
  };
}

function postTransactions_(transactions) {
  const payload = {
    source: 'gmail-apps-script',
    uid: CONFIG.firebaseUid,
    owner: CONFIG.owner,
    exportedAt: new Date().toISOString(),
    transactions,
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

function extractAmount_(text) {
  const match = text.match(
    /(?:s\/|pen|\$|usd)?\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{1,2})?)/i,
  );

  if (!match) {
    return null;
  }

  const normalized = match[1].replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function inferKind_(text) {
  return /recibiste|abono|deposito|te enviaron|ingreso|transferencia recibida/i.test(text)
    ? 'income'
    : 'expense';
}

function inferCategory_(text, kind) {
  if (kind === 'income') {
    return 'Ingreso';
  }

  if (/almuerzo|menu|comida|restaurante|cafe|supermercado/i.test(text)) {
    return 'Comida';
  }
  if (/uber|taxi|bus|movilidad|peaje/i.test(text)) {
    return 'Transporte';
  }
  if (/farmacia|salud|clinica|medicina/i.test(text)) {
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

function extractTitle_(subject, sender, text, kind) {
  const explicitMatch =
    text.match(/(?:a|de|para)\s+([A-Za-z0-9 .&-]{3,40})/i) ||
    text.match(/(?:por|concepto)\s+([A-Za-z0-9 .&-]{3,40})/i);

  if (explicitMatch && explicitMatch[1]) {
    return explicitMatch[1].trim();
  }

  if (sender) {
    return sender.split('<')[0].trim();
  }

  return kind === 'income' ? subject || 'Ingreso desde Gmail' : subject || 'Gasto desde Gmail';
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function validateConfig_() {
  if (CONFIG.ingestSecret === 'REEMPLAZAR_CON_SECRET') {
    throw new Error('Completa CONFIG.ingestSecret antes de ejecutar el script.');
  }

  if (CONFIG.firebaseUid === 'REEMPLAZAR_CON_UID') {
    throw new Error('Completa CONFIG.firebaseUid antes de ejecutar el script.');
  }
}
