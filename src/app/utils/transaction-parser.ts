import { ParsedCapture, TransactionKind } from '../models/finance.models';

const IGNORABLE_PATTERNS = [
  /se rechazo tu compra/i,
  /compra fue rechazada/i,
  /compra no concretada/i,
  /configuracion de tarjeta/i,
  /experiencia de pago/i,
  /promo/i,
  /cyber/i,
  /descuento/i,
];

const INCOME_PATTERNS = [
  /recibiste un yapeo/i,
  /monto recibido/i,
  /te enviaron/i,
  /abono/i,
  /deposito/i,
  /transferencia recibida/i,
  /ingreso/i,
];

const PERSON_TO_PERSON_PATTERNS = [/plin/i, /yape/i, /yapeo a celular/i];

type ParserOptions = {
  defaultDate?: string;
  defaultSource?: ParsedCapture['source'];
};

export function parseTransactionText(rawText: string, options: ParserOptions = {}): ParsedCapture | null {
  const normalized = normalizeWhitespace(rawText);

  if (!normalized) {
    return null;
  }

  if (shouldIgnoreTransactionText(normalized)) {
    return null;
  }

  const kind = inferKind(normalized);
  const amount = extractAmount(normalized);
  const date = options.defaultDate || new Date().toISOString().slice(0, 10);
  const account = inferAccount(normalized);
  const category = inferCategory(normalized, kind);
  const source = options.defaultSource || inferSource(normalized);
  const title = inferTitle(normalized, kind);

  return {
    title,
    amount,
    kind,
    category,
    account,
    note: normalized,
    source,
    date,
    rawText: normalized,
  };
}

export function shouldIgnoreTransactionText(rawText: string): boolean {
  return IGNORABLE_PATTERNS.some((pattern) => pattern.test(rawText));
}

function inferKind(rawText: string): TransactionKind {
  return INCOME_PATTERNS.some((pattern) => pattern.test(rawText)) ? 'income' : 'expense';
}

function inferAccount(rawText: string): string {
  if (/yape|plin/i.test(rawText)) {
    return 'Yape/Plin';
  }

  if (/tarjeta|visa|mastercard|debito|credito/i.test(rawText)) {
    return 'Tarjeta';
  }

  if (/transferencia|bcp|interbank|bbva|scotiabank|deposito/i.test(rawText)) {
    return 'Transferencia';
  }

  return 'Otro';
}

function inferCategory(rawText: string, kind: TransactionKind): string {
  if (kind === 'income') {
    return 'Ingreso';
  }

  if (PERSON_TO_PERSON_PATTERNS.some((pattern) => pattern.test(rawText))) {
    return 'Transferencias';
  }

  if (/(uber|didi|cabify|taxi|rides|movilidad|peaje)/i.test(rawText)) {
    return 'Transporte';
  }

  if (/(rappi|restaurante|cafe|supermercado|plaza vea|tottus|wong|metro|comida|almuerzo|menu)/i.test(rawText)) {
    return 'Comida';
  }

  if (/(farmacia|clinica|medicina|salud|seguro)/i.test(rawText)) {
    return 'Salud';
  }

  if (/(luz|agua|internet|gas|telefono)/i.test(rawText)) {
    return 'Servicios';
  }

  if (/(spotify|netflix|apple|icloud|google one|suscripcion|subscription)/i.test(rawText)) {
    return 'Suscripciones';
  }

  if (/(ripley|saga|zara|h&m|compra)/i.test(rawText)) {
    return 'Compras';
  }

  return 'Otros';
}

function inferSource(rawText: string): ParsedCapture['source'] {
  if (/gmail|correo|mail|notificaciones@notificacionesbcp\.com\.pe|servicio de notificaciones bcp/i.test(rawText)) {
    return 'gmail';
  }

  if (/whatsapp|wsp/i.test(rawText)) {
    return 'whatsapp';
  }

  return 'notification';
}

function inferTitle(rawText: string, kind: TransactionKind): string {
  const companyMatch =
    rawText.match(/empresa\s+([A-Za-z0-9* .&-]{2,60})/i) ||
    rawText.match(/en\s+([A-Za-z0-9* .&-]{2,60})\./i) ||
    rawText.match(/en\s+(PLIN-[A-Za-z0-9 .&-]{2,60})/i);

  if (companyMatch?.[1]) {
    return beautifyCounterparty(companyMatch[1]);
  }

  const senderMatch =
    rawText.match(/enviado por\s+([A-Za-z0-9 .&-]{3,80})/i) ||
    rawText.match(/recibiste un yapeo de .*? de ([A-Za-z0-9 .&-]{3,80})/i) ||
    rawText.match(/(?:a|de|para)\s+([A-Za-z0-9 .&-]{3,80})/i);

  if (senderMatch?.[1]) {
    return beautifyCounterparty(senderMatch[1]);
  }

  return kind === 'income' ? 'Ingreso detectado' : 'Gasto detectado';
}

function extractAmount(rawText: string): number | null {
  const prioritizedPatterns = [
    /monto recibido\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /total del consumo\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /realizaste un consumo de\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /recibiste un yapeo de\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
  ];

  for (const pattern of prioritizedPatterns) {
    const match = rawText.match(pattern);

    if (match?.[1]) {
      return normalizeAmount(match[1]);
    }
  }

  const fallbackMatch = rawText.match(
    /(?:s\/|\$|pen|usd)?\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{1,2})?)/i,
  );

  return fallbackMatch?.[1] ? normalizeAmount(fallbackMatch[1]) : null;
}

function normalizeAmount(rawAmount: string): number | null {
  const normalized = rawAmount.replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function beautifyCounterparty(rawValue: string): string {
  const cleaned = rawValue
    .replace(/^plin-/i, '')
    .replace(/^(pyu|dlc)\*/i, '')
    .replace(/\s+-\s+servicio de notificaciones bcp$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const dictionary: Record<string, string> = {
    'uber': 'Uber',
    'uber rides': 'Uber Rides',
    'didi': 'Didi',
    'rappi': 'Rappi',
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

function normalizeWhitespace(rawText: string): string {
  return rawText.replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
