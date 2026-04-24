const CONFIG = {
  functionUrl:
    'https://us-central1-app-gastospe.cloudfunctions.net/ingestAutomationTransactions',
  parseFunctionUrl:
    'https://us-central1-app-gastospe.cloudfunctions.net/parseGmailMessage',
  ingestSecret: readScriptConfig_('GASTOSPE_INGEST_SECRET', 'REEMPLAZAR_CON_SECRET'),
  firebaseUid: readScriptConfig_('GASTOSPE_FIREBASE_UID', 'k4isjFEKaPT2pcunssO1XN1unPp2'),
  owner: 'Mi tablero',
  processedLabel: 'gastospe-procesado',
  reviewLabel: 'gastospe-revisar',
  processedStoreKey: 'GASTOSPE_PROCESSED_MESSAGE_IDS',
  failedStoreKey: 'GASTOSPE_FAILED_MESSAGE_IDS',
  gmailQuery:
    'in:anywhere newer_than:45d (from:notificaciones@notificacionesbcp.com.pe OR from:procesos@bbva.com.pe OR from:no-reply@pagseguro.com OR from:noreply@steampowered.com OR from:noreply@uber.com)',
  maxThreads: 120,
  maxProcessedIds: 1200,
  maxFailures: 300,
  allowedSenders: [
    'notificaciones@notificacionesbcp.com.pe',
    'procesos@bbva.com.pe',
    'no-reply@pagseguro.com',
    'noreply@steampowered.com',
    'noreply@uber.com',
  ],
};

function setupGastospeConfig() {
  const properties = PropertiesService.getScriptProperties();
  properties.setProperties(
    {
      GASTOSPE_FIREBASE_UID: 'k4isjFEKaPT2pcunssO1XN1unPp2',
    },
    true,
  );

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
        parseFunctionUrl: CONFIG.parseFunctionUrl,
        firebaseUid: CONFIG.firebaseUid,
        owner: CONFIG.owner,
        gmailQuery: CONFIG.gmailQuery,
        processedIds: readProcessedMessageIds_().length,
        failedIds: readFailedMessageIds_().length,
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

  const lock = LockService.getScriptLock();

  if (!lock.tryLock(15000)) {
    throw new Error('Ya hay una ejecucion de Apps Script en curso.');
  }

  try {
    const candidates = collectCandidateMessages_();

    if (!candidates.length) {
      Logger.log('No se detectaron correos nuevos para procesar.');
      return;
    }

    const processed = [];
    const failed = [];
    const summary = {
      inserted: 0,
      filtered: 0,
      fallback: 0,
      review: 0,
    };

    candidates.forEach(function (candidate) {
      const result = processGmailMessage_(candidate);

      if (result.processed) {
        processed.push(candidate);

        if (result.mode === 'inserted') {
          summary.inserted += 1;
        } else if (result.mode === 'filtered') {
          summary.filtered += 1;
        } else if (result.mode === 'fallback') {
          summary.fallback += 1;
        }
      } else {
        failed.push(candidate.messageId);
        summary.review += 1;
        labelMessageForReview_(candidate);
      }
    });

    if (processed.length) {
      rememberProcessedMessages_(processed.map(function (item) {
        return item.messageId;
      }));
      clearFailedMessages_(processed.map(function (item) {
        return item.messageId;
      }));
      labelThreadsForCandidates_(processed);
    }

    if (failed.length) {
      rememberFailedMessages_(failed);
    }

    Logger.log(
      JSON.stringify(
        {
          scanned: candidates.length,
          processed: processed.length,
          failed: failed.length,
          summary: summary,
        },
        null,
        2,
      ),
    );
  } finally {
    lock.releaseLock();
  }
}

function previewRecentMatches() {
  validateConfig_();

  const candidates = collectCandidateMessages_({ skipFailures: true }).slice(0, 20);
  const preview = candidates.map(function (candidate) {
    const parsed = buildParsedDraft_(candidate.text, new Date(candidate.date));

    return {
      messageId: candidate.messageId,
      sender: candidate.sender,
      subject: candidate.subject,
      date: candidate.date,
      parsed: parsed,
    };
  });

  Logger.log(JSON.stringify(preview, null, 2));

  if (!preview.length) {
    Logger.log('No se detectaron correos nuevos.');
  }
}

function runParserSelfTest() {
  const fixtures = [
    {
      name: 'bcp_card_purchase',
      text:
        'Realizaste un consumo de S/ 6.40 con tu Tarjeta de Credito BCP en DLC*UBER RIDES.\n' +
        'Total del consumo\nS/ 6.40\nEmpresa\nDLC*UBER RIDES',
      expected: {
        kind: 'expense',
        title: 'Uber Rides',
        amount: 6.4,
      },
    },
    {
      name: 'bcp_yape_income',
      text:
        'Recibiste un yapeo de S/ 339.00 de Angelly Fiorella Carrion Ruiz.\n' +
        'Monto recibido\nS/ 339.00\nEnviado por\nAngelly Fiorella Carrion Ruiz',
      expected: {
        kind: 'income',
        title: 'Angelly Fiorella Carrion Ruiz',
        amount: 339,
      },
    },
    {
      name: 'bbva_interbank_expense',
      text:
        'Transferencia interbancaria\nImporte transferido\nS/ 1000.00\n' +
        'Importe cargado S/ 1000.00\nNombre del beneficiario\nGerman Cubas Saco',
      expected: {
        kind: 'expense',
        title: 'German Cubas Saco',
        amount: 1000,
      },
    },
    {
      name: 'bbva_plin_expense',
      text:
        'Plineaste S/ 120.53 a German Cubas S\n' +
        'Destino: Yape\nNumero de operacion: 28E3B9BE7006',
      expected: {
        kind: 'expense',
        title: 'German Cubas S',
        amount: 120.53,
      },
    },
    {
      name: 'bcp_service_payment',
      text:
        'Â¡Tu operaciÃ³n se realizÃ³ con Ã©xito!\nPago de servicios\nEmpresa:\nPAGOEFECTIVO\nMonto total:\nS/ 342.50',
      expected: {
        kind: 'expense',
        title: 'PagoEfectivo',
        amount: 342.5,
      },
    },
    {
      name: 'pagseguro_completed',
      text:
        'Updated Status #18A31547-9FCB-4957-A539-6092B2357415 - Completed\n' +
        'Your payment of\nS/. 14,50\nwas authorized.\nOrder:\nLeaf it Alone\nPayment Method:\nOnline Debit\nPagoEfectivo\nTotal: S/. 14,50',
      expected: {
        kind: 'expense',
        title: 'Leaf It Alone',
        amount: 14.5,
      },
    },
    {
      name: 'steam_receipt',
      text:
        '¡Gracias por comprar en Steam!\n' +
        'Gracias por tu reciente transaccion en Steam.\n' +
        'Leaf it Alone\nSubtotal (IVA no incluido): S/.12.29\nTotal:\nS/.14.50\nMetodo de pago:\nPagoEfectivo',
      expected: {
        kind: 'expense',
        title: 'Leaf It Alone',
        amount: 14.5,
      },
    },
    {
      name: 'uber_receipt',
      text:
        '[Personal] Tu viaje Uber del jueves por la tarde\n' +
        'Gracias por usar Uber, German\n' +
        'Total PEN 5.70\nTarifa del viaje PEN 6.20\nPagos\nVisa ••••8828 (ENDER) PEN 5.70',
      expected: {
        kind: 'expense',
        title: 'Uber',
        amount: 5.7,
      },
    },
    {
      name: 'ignored_rejected_purchase',
      text:
        'Se rechazo tu compra por e-commerce no permitido\n' +
        'Importe de compra\nS/ 200.00',
      expectedIgnored: true,
    },
    {
      name: 'ignored_pagseguro_pending_order',
      text:
        'New Order 18A31547-9FCB-4957-A539-6092B2357415\n' +
        'Your order has been registered!\n' +
        'We are waiting for the payment confirmation to start the processing.',
      expectedIgnored: true,
    },
  ];

  const results = fixtures.map(function (fixture) {
    const parsed = buildParsedDraft_(fixture.text, new Date('2026-04-23T00:00:00Z'));
    const ok = fixture.expectedIgnored
      ? !parsed
      : Boolean(parsed) &&
        parsed.kind === fixture.expected.kind &&
        parsed.title === fixture.expected.title &&
        parsed.amount === fixture.expected.amount;

    return {
      name: fixture.name,
      ok: ok,
      parsed: parsed,
    };
  });

  Logger.log(JSON.stringify(results, null, 2));
}

function createFastTrigger() {
  deleteProjectTriggers();
  ScriptApp.newTrigger('ingestBcpFinanceEmails').timeBased().everyMinutes(5).create();
  Logger.log('Trigger creado para revisar Gmail cada 5 minutos.');
}

function installOrRepairAutomation() {
  validateConfig_();
  getOrCreateLabel_(CONFIG.processedLabel);
  getOrCreateLabel_(CONFIG.reviewLabel);
  createFastTrigger();
  ingestBcpFinanceEmails();
  Logger.log('Automatizacion reparada: trigger creado, labels listas e ingesta inicial ejecutada.');
}

function backfillLast45Days() {
  validateConfig_();
  resetProcessedMessages_();
  ingestBcpFinanceEmails();
  Logger.log('Backfill de los ultimos 45 dias ejecutado.');
}

function createHourlyTrigger() {
  deleteProjectTriggers();
  ScriptApp.newTrigger('ingestBcpFinanceEmails').timeBased().everyHours(1).create();
  Logger.log('Trigger creado para revisar Gmail cada hora.');
}

function deleteProjectTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    ScriptApp.deleteTrigger(trigger);
  });
}

function resetProcessedMessages_() {
  const properties = PropertiesService.getScriptProperties();
  properties.deleteProperty(CONFIG.processedStoreKey);
  properties.deleteProperty(CONFIG.failedStoreKey);
  Logger.log('Se limpio el cache de mensajes procesados y fallidos.');
}

function collectCandidateMessages_(options) {
  const settings = options || {};
  const processedIds = readProcessedMessageIdsSet_();
  const failedIds = settings.skipFailures ? new Set() : readFailedMessageIdsSet_();
  const threads = GmailApp.search(CONFIG.gmailQuery, 0, CONFIG.maxThreads);
  const candidates = [];

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      const messageId = message.getId();

      if (processedIds.has(messageId) || failedIds.has(messageId)) {
        return;
      }

      const sender = String(message.getFrom() || '').trim();

      if (!isAllowedSender_(sender)) {
        return;
      }

      const plainBody = repairCommonEncoding_((message.getPlainBody() || '').slice(0, 9000));
      const subject = repairCommonEncoding_(message.getSubject() || 'Correo sin asunto');

      candidates.push({
        messageId: messageId,
        threadId: message.getThread().getId(),
        sender: sender,
        subject: subject,
        plainBody: plainBody,
        text: `${subject}\n${sender}\n${plainBody}`.trim(),
        date: Utilities.formatDate(
          message.getDate(),
          Session.getScriptTimeZone(),
          'yyyy-MM-dd',
        ),
        createdAt: message.getDate().toISOString(),
      });
    });
  });

  return candidates;
}

function processGmailMessage_(candidate) {
  const parseResult = parseInCloud_(candidate);

  if (parseResult.ok && parseResult.transaction) {
    return { processed: true, mode: 'inserted' };
  }

  if (parseResult.ok && parseResult.reason === 'filtered') {
    return { processed: true, mode: 'filtered' };
  }

  const parsedDraft = buildParsedDraft_(candidate.text, new Date(candidate.createdAt));

  if (!parsedDraft || !parsedDraft.amount) {
    return { processed: false, mode: 'review' };
  }

  postTransactions_([
    {
      id: `gmail-${candidate.messageId}`,
      kind: parsedDraft.kind,
      title: parsedDraft.title,
      amount: parsedDraft.amount,
      category: parsedDraft.category,
      date: candidate.date,
      account: parsedDraft.account,
      note: candidate.subject,
      source: 'gmail',
      rawText: candidate.text,
      createdAt: candidate.createdAt,
    },
  ]);

  return { processed: true, mode: 'fallback' };
}

function parseInCloud_(candidate) {
  const response = UrlFetchApp.fetch(CONFIG.parseFunctionUrl, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-gastospe-secret': CONFIG.ingestSecret,
    },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      uid: CONFIG.firebaseUid,
      sender: candidate.sender,
      subject: candidate.subject,
      body: candidate.plainBody,
      date: candidate.date,
      messageId: candidate.messageId,
    }),
  });

  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code < 200 || code >= 300) {
    Logger.log(`parseGmailMessage respondio ${code}: ${body}`);
    return { ok: false };
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    Logger.log(`No se pudo interpretar parseGmailMessage: ${error}`);
    return { ok: false };
  }
}

function postTransactions_(transactions) {
  const response = UrlFetchApp.fetch(CONFIG.functionUrl, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-gastospe-secret': CONFIG.ingestSecret,
    },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      source: 'gmail-apps-script',
      uid: CONFIG.firebaseUid,
      owner: CONFIG.owner,
      exportedAt: new Date().toISOString(),
      transactions: transactions,
    }),
  });

  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error(`Firebase respondio ${code}: ${body}`);
  }

  Logger.log(body);
}

function labelThreadsForCandidates_(candidates) {
  const label = getOrCreateLabel_(CONFIG.processedLabel);
  const seenThreads = {};

  candidates.forEach(function (candidate) {
    seenThreads[candidate.threadId] = true;
  });

  Object.keys(seenThreads).forEach(function (threadId) {
    const thread = GmailApp.getThreadById(threadId);

    if (thread) {
      thread.addLabel(label);
    }
  });
}

function labelMessageForReview_(candidate) {
  const thread = GmailApp.getThreadById(candidate.threadId);
  const label = getOrCreateLabel_(CONFIG.reviewLabel);

  if (thread) {
    thread.addLabel(label);
  }
}

function rememberProcessedMessages_(messageIds) {
  const merged = mergeIds_(readProcessedMessageIds_(), messageIds, CONFIG.maxProcessedIds);
  PropertiesService.getScriptProperties().setProperty(
    CONFIG.processedStoreKey,
    JSON.stringify(merged),
  );
}

function rememberFailedMessages_(messageIds) {
  const merged = mergeIds_(readFailedMessageIds_(), messageIds, CONFIG.maxFailures);
  PropertiesService.getScriptProperties().setProperty(
    CONFIG.failedStoreKey,
    JSON.stringify(merged),
  );
}

function clearFailedMessages_(messageIds) {
  const toDelete = {};

  messageIds.forEach(function (id) {
    toDelete[id] = true;
  });

  const remaining = readFailedMessageIds_().filter(function (id) {
    return !toDelete[id];
  });

  PropertiesService.getScriptProperties().setProperty(
    CONFIG.failedStoreKey,
    JSON.stringify(remaining),
  );
}

function readProcessedMessageIds_() {
  return readIdList_(CONFIG.processedStoreKey);
}

function readFailedMessageIds_() {
  return readIdList_(CONFIG.failedStoreKey);
}

function readProcessedMessageIdsSet_() {
  return new Set(readProcessedMessageIds_());
}

function readFailedMessageIdsSet_() {
  return new Set(readFailedMessageIds_());
}

function readIdList_(key) {
  const rawValue = PropertiesService.getScriptProperties().getProperty(key);

  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (error) {
    Logger.log(`No se pudo leer ${key}: ${error}`);
    return [];
  }
}

function mergeIds_(currentIds, newIds, maxItems) {
  const seen = {};

  currentIds.forEach(function (id) {
    seen[id] = true;
  });

  newIds.forEach(function (id) {
    if (id) {
      seen[String(id)] = true;
    }
  });

  return Object.keys(seen).slice(-maxItems);
}

function buildParsedDraft_(text, fallbackDate) {
  const prepared = normalizeWhitespace_(repairCommonEncoding_(text));
  const searchable = createMatchableText_(prepared);

  if (!prepared || shouldIgnoreTransactionText_(searchable)) {
    return null;
  }

  return {
    kind: inferKind_(searchable),
    title: inferTitle_(prepared, searchable),
    amount: extractAmount_(prepared, searchable),
    category: inferCategory_(searchable),
    account: inferAccount_(searchable),
    date: Utilities.formatDate(
      fallbackDate || new Date(),
      Session.getScriptTimeZone(),
      'yyyy-MM-dd',
    ),
  };
}

function shouldIgnoreTransactionText_(text) {
  return [
    /se rechazo tu compra/i,
    /compra fue rechazada/i,
    /compra no concretada/i,
    /operacion rechazada/i,
    /configuracion de tarjeta/i,
    /copia de estado de cuenta/i,
    /estado de cuenta/i,
    /cancelacion de cuenta/i,
    /codigo de verificacion/i,
    /clave digital/i,
    /token digital/i,
    /recordatorio de pago/i,
    /\bpromo\b/i,
    /\bcyber\b/i,
    /\bdescuento\b/i,
    /your order has been registered/i,
    /waiting for the payment confirmation/i,
    /lista de deseados/i,
    /esta en oferta/i,
    /rebajas de steam/i,
    /juegos? que quieres estan de oferta/i,
  ].some(function (pattern) {
    return pattern.test(text);
  });
}

function inferKind_(text) {
  if (
    /realizaste un consumo|total del consumo|importe de la compra|consumo tarjeta de credito|plineaste|transferencia interbancaria|transferencia a cuentas propias|transf\. a ctas\. propias|transf\. interbancaria|transf\. a ctas\. terceros|transferir a terceros bbva|pago automatico|pago de servicios|pago a tu tarjeta|monto pagado|importe transferido|importe cargado|total transferido|payment of|payment has been successfully sent|gracias por comprar en steam|total de esta transaccion/i.test(
      text,
    )
  ) {
    return 'expense';
  }

  if (/gracias por usar uber|\[personal\]\s*tu viaje|tarifa del viaje|pagos\s+visa/i.test(text)) {
    return 'expense';
  }

  return /recibiste un yapeo|monto recibido|monto abonado|recibiste una transferencia|transferencia recibida|te depositaron|te abonaron|hemos abonado|abono en cuenta|reembolso|cashback/i.test(
    text,
  )
    ? 'income'
    : 'expense';
}

function inferAccount_(text) {
  if (/yape|plin|plineaste|yapeo/i.test(text)) {
    return 'Yape/Plin';
  }

  if (/visa\s*[*•.]+|pagos?\s+visa|recibos de uber|gracias por usar uber/i.test(text)) {
    return 'Tarjeta';
  }

  if (
    /(tarjeta|visa|mastercard|amex|credito)/i.test(text) &&
    !/cuenta de ahorro|ahorros|cuenta corriente|cuenta sueldo|cuenta digital/i.test(text)
  ) {
    return 'Tarjeta';
  }

  if (/debito/i.test(text) && !/online debit/i.test(text)) {
    return 'Tarjeta';
  }

  if (/pagoefectivo|pagseguro|online debit|pago efectivo/i.test(text)) {
    return 'Efectivo';
  }

  if (
    /transferencia|cuenta de origen|cuenta de destino|cuenta sueldo|cuenta digital|cuenta de ahorro|ahorros|importe cargado|importe transferido/i.test(
      text,
    )
  ) {
    return 'Transferencia';
  }

  return 'Otro';
}

function inferCategory_(text) {
  if (inferKind_(text) === 'income') {
    return 'Ingreso';
  }

  if (
    /(steam|valve|boacompra|boa compra|leaf it alone|gracias por comprar en steam|your payment of|payment has been successfully sent)/i.test(
      text,
    )
  ) {
    return 'Compras';
  }

  if (/gracias por usar uber|recibos de uber|\[personal\]\s*tu viaje/i.test(text)) {
    return 'Transporte';
  }

  if (
    /win internet|internet|pago automatico|pago de servicios|pagoefectivo|claro|movistar|entel|bitel|recibo|servicio favorito/i.test(
      text,
    )
  ) {
    return 'Servicios';
  }

  if (
    /plin|yape|yapeo a celular|plineaste|transferiste|transferencia enviada|enviaste|beneficiario|pago a tu tarjeta|transferencia interbancaria|transferencia a cuentas propias|transferir a terceros bbva|importe transferido|importe cargado/i.test(
      text,
    )
  ) {
    return 'Transferencias';
  }

  if (/(uber|didi|cabify|taxi|rides|movilidad|peaje|metro|bus|combi)/i.test(text)) {
    return 'Transporte';
  }

  if (
    /(rappi|restaurante|cafe|cafeteria|supermercado|plaza vea|tottus|wong|metro|tambo|comida|almuerzo|menu|delivery|pedidosya|burger|pizza|kfc|mcdonald)/i.test(
      text,
    )
  ) {
    return 'Comida';
  }

  if (/(farmacia|clinica|medicina|salud|seguro medico|hospital|laboratorio|botica)/i.test(text)) {
    return 'Salud';
  }

  if (
    /(spotify|netflix|apple|icloud|google one|contabo|adobe|amazon prime|disney|hbo|suscripcion|subscription)/i.test(
      text,
    )
  ) {
    return 'Suscripciones';
  }

  if (/(steam|valve|boacompra|boa compra|pagseguro|videojuego|game purchase|juego)/i.test(text)) {
    return 'Compras';
  }

  return 'Otros';
}

function inferTitle_(preparedText, searchableText) {
  const paymentServiceFromSubject = preparedText.match(
    /pago automatico exitoso de tu servicio\s+([A-Za-z0-9* .&-]{2,80})/i,
  );

  if (paymentServiceFromSubject && paymentServiceFromSubject[1]) {
    return beautifyCounterparty_(paymentServiceFromSubject[1]);
  }

  if (/gracias por usar uber|recibos de uber|\[personal\]\s*tu viaje/i.test(searchableText)) {
    return 'Uber';
  }

  const orderMatch =
    preparedText.match(/order:\s*(?:•\s*)?([A-Za-z0-9'!,: .&-]{2,120})/i) ||
    preparedText.match(
      /gracias por tu reciente transaccion en steam[\s\S]{0,260}?\n\s*([A-Za-z0-9'!,: .&-]{2,120})\s*\n\s*subtotal\s*\(/i,
    );

  if (orderMatch && orderMatch[1]) {
    return beautifyCounterparty_(orderMatch[1]);
  }

  const companyMatch =
    preparedText.match(/empresa\s*:?\s*([A-Za-z0-9* .&-]{2,80})/i) ||
    preparedText.match(/comercio\s*:?\s*([A-Za-z0-9* .&-]{2,80})/i) ||
    preparedText.match(/establecimiento\s*:?\s*([A-Za-z0-9* .&-]{2,80})/i) ||
    preparedText.match(/en\s+([A-Za-z0-9* .&-]{2,80}?)(?=\.|\n| con|$)/i);

  if (companyMatch && companyMatch[1] && !/^tu cuenta|^cuenta/i.test(companyMatch[1].trim())) {
    return beautifyCounterparty_(companyMatch[1]);
  }

  const serviceMatch = extractLabelValue_(preparedText, ['Servicio', 'Empresa']);

  if (serviceMatch && !/^pago soles|^cuenta/i.test(serviceMatch.toLowerCase())) {
    return beautifyCounterparty_(serviceMatch);
  }

  const senderMatch =
    preparedText.match(/enviado por\s+([A-Za-z0-9 .&-]{3,80}?)(?=\.|\n| en | desde |$)/i) ||
    preparedText.match(/recibiste un yapeo de .*? de ([A-Za-z0-9 .&-]{3,80}?)(?=\.|\n| en | desde |$)/i) ||
    preparedText.match(/recibiste una transferencia .*? de ([A-Za-z0-9 .&-]{3,80}?)(?=\.|\n| en | desde |$)/i) ||
    preparedText.match(/plineaste .*? a ([A-Za-z0-9 .&-]{3,80}?)(?=\n| destino| itf| fecha| numero|$)/i) ||
    preparedText.match(/nombre del beneficiario\s+([A-Za-z0-9 .&-]{3,80}?)(?=\n|$)/i) ||
    preparedText.match(/titular del servicio\s+([A-Za-z0-9 .&-]{3,80}?)(?=\n|$)/i) ||
    preparedText.match(/beneficiario\s+([A-Za-z0-9 .&-]{3,80}?)(?=\n|$)/i);

  if (senderMatch && senderMatch[1]) {
    return beautifyCounterparty_(senderMatch[1]);
  }

  if (/pago a tu tarjeta/i.test(searchableText)) {
    return 'Pago tarjeta propia';
  }

  if (/transferencia interbancaria/i.test(searchableText)) {
    return 'Transferencia interbancaria';
  }

  return inferKind_(searchableText) === 'income' ? 'Ingreso detectado' : 'Gasto detectado';
}

function extractAmount_(preparedText, searchableText) {
  const prioritizedPatterns = [
    /monto recibido\s*:?\s*(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /monto abonado\s*:?\s*(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /monto pagado\s*:?\s*(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /monto total\s*:?\s*(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /total del consumo\s*:?\s*(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /total transferido\s*:?\s*(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /importe transferido\s*:?\s*(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /importe cargado\s*:?\s*(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /importe de la compra\s*:?\s*(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /realizaste un consumo de\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /recibiste un yapeo de\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /plineaste\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /payment of\s+(?:s\/\.?|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /total de esta transaccion\s*:?\s*(?:s\/\.?|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /total\s*:?\s*(?:s\/\.?|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
  ];

  for (let index = 0; index < prioritizedPatterns.length; index += 1) {
    const match = preparedText.match(prioritizedPatterns[index]);

    if (match && match[1]) {
      return normalizeAmount_(match[1]);
    }
  }

  const labeledAmount = extractLabelValue_(preparedText, [
    'Monto total',
    'Monto pagado',
    'Monto recibido',
    'Monto abonado',
    'Importe transferido',
    'Importe cargado',
    'Total transferido',
    'Total',
    'Total de esta transaccion',
  ]);

  if (labeledAmount) {
    const match = labeledAmount.match(/(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i);

    if (match && match[1]) {
      return normalizeAmount_(match[1]);
    }
  }

  const fallback = searchableText.match(
    /(?:s\/|\$|pen|usd)\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{1,2})?)/i,
  );

  return fallback && fallback[1] ? normalizeAmount_(fallback[1]) : null;
}

function normalizeAmount_(rawAmount) {
  const normalized = rawAmount.replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null;
}

function extractLabelValue_(preparedText, labels) {
  const lines = preparedText
    .split('\n')
    .map(function (line) {
      return line.trim();
    })
    .filter(Boolean);
  const normalizedLabels = labels.map(createMatchableText_);

  for (let index = 0; index < lines.length; index += 1) {
    const currentLine = createMatchableText_(lines[index]);

    if (normalizedLabels.indexOf(currentLine) === -1) {
      continue;
    }

    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const candidate = lines[nextIndex];

      if (!candidate || normalizedLabels.indexOf(createMatchableText_(candidate)) !== -1) {
        continue;
      }

      return candidate;
    }
  }

  return '';
}

function beautifyCounterparty_(rawValue) {
  const cleaned = String(rawValue || '')
    .replace(/^plin-/i, '')
    .replace(/^(pyu|dlc|paypal)\*/i, '')
    .replace(/\s+-\s+servicio de notificaciones bcp$/i, '')
    .replace(/\s+-\s+bbva$/i, '')
    .replace(/\s+bbva$/i, '')
    .replace(/[.]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const dictionary = {
    uber: 'Uber',
    'uber rides': 'Uber Rides',
    didi: 'Didi',
    rappi: 'Rappi',
    'tambo 2': 'Tambo',
    pagoefectivo: 'PagoEfectivo',
    pagseguro: 'PagSeguro',
    steam: 'Steam',
    'leaf it alone': 'Leaf It Alone',
    'win internet': 'WIN Internet',
    contabo: 'Contabo',
  };

  const lower = createMatchableText_(cleaned);

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

function isAllowedSender_(sender) {
  const normalizedSender = String(sender || '').toLowerCase();

  return CONFIG.allowedSenders.some(function (allowedSender) {
    return normalizedSender.indexOf(allowedSender.toLowerCase()) !== -1;
  });
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function repairCommonEncoding_(text) {
  return String(text || '')
    .replace(/Â¡/g, '¡')
    .replace(/Â¿/g, '¿')
    .replace(/Â/g, '')
    .replace(/Ã¡/g, 'á')
    .replace(/Ã©/g, 'é')
    .replace(/Ã­/g, 'í')
    .replace(/Ã³/g, 'ó')
    .replace(/Ãº/g, 'ú')
    .replace(/Ã±/g, 'ñ')
    .replace(/Ã/g, 'Á')
    .replace(/Ã‰/g, 'É')
    .replace(/Ã/g, 'Í')
    .replace(/Ã“/g, 'Ó')
    .replace(/Ãš/g, 'Ú')
    .replace(/Ã‘/g, 'Ñ')
    .replace(/â€“/g, '-')
    .replace(/â€”/g, '-')
    .replace(/â€œ|â€\u009d/g, '"')
    .replace(/â€˜|â€™/g, "'");
}

function createMatchableText_(text) {
  return repairCommonEncoding_(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\r/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .toLowerCase()
    .trim();
}

function normalizeWhitespace_(text) {
  return String(text || '').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
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
