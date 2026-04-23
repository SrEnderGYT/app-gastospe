import { ParsedCapture, TransactionKind } from '../models/finance.models';

const IGNORABLE_PATTERNS = [
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
  /games? que quieres estan de oferta/i,
];

const EXPENSE_PATTERNS = [
  /realizaste un consumo/i,
  /total del consumo/i,
  /importe de la compra/i,
  /consumo tarjeta de credito/i,
  /plineaste/i,
  /transferencia interbancaria/i,
  /transferencia a cuentas propias/i,
  /transf\. a ctas\. propias/i,
  /transf\. interbancaria/i,
  /transf\. a ctas\. terceros/i,
  /transferir a terceros bbva/i,
  /pago automatico/i,
  /pago de servicios/i,
  /pago a tu tarjeta/i,
  /monto pagado/i,
  /importe transferido/i,
  /importe cargado/i,
  /total transferido/i,
  /pago automatico exitoso/i,
  /payment of/i,
  /payment has been successfully sent/i,
  /gracias por comprar en steam/i,
  /recente transaccion en steam/i,
  /total de esta transaccion/i,
];

const INCOME_PATTERNS = [
  /recibiste un yapeo/i,
  /monto recibido/i,
  /monto abonado/i,
  /recibiste una transferencia/i,
  /transferencia recibida/i,
  /te depositaron/i,
  /te abonaron/i,
  /hemos abonado/i,
  /abono en cuenta/i,
  /ingreso/i,
  /reembolso/i,
  /cashback/i,
];

const PERSON_TO_PERSON_PATTERNS = [
  /plin/i,
  /yape/i,
  /yapeo a celular/i,
  /plineaste/i,
  /transferiste/i,
  /transferencia enviada/i,
  /enviaste/i,
  /beneficiario/i,
];

const KNOWN_GMAIL_PATTERNS = [
  /notificaciones@notificacionesbcp\.com\.pe/i,
  /procesos@bbva\.com\.pe/i,
  /no-reply@pagseguro\.com/i,
  /noreply@steampowered\.com/i,
  /servicio de notificaciones bcp/i,
  /\bbbva\b/i,
  /\bpagseguro\b/i,
  /\bsteam\b/i,
];

type ParserOptions = {
  defaultDate?: string;
  defaultSource?: ParsedCapture['source'];
};

export function parseTransactionText(
  rawText: string,
  options: ParserOptions = {},
): ParsedCapture | null {
  const prepared = normalizeWhitespace(repairCommonEncoding(rawText));
  const matchable = createMatchableText(prepared);

  if (!prepared) {
    return null;
  }

  if (shouldIgnoreTransactionText(matchable)) {
    return null;
  }

  const kind = inferKind(matchable);
  const amount = extractAmount(prepared, matchable);
  const date = options.defaultDate || new Date().toISOString().slice(0, 10);
  const account = inferAccount(matchable);
  const category = inferCategory(matchable, kind);
  const source = options.defaultSource || inferSource(matchable);
  const title = inferTitle(prepared, matchable, kind);

  return {
    title,
    amount,
    kind,
    category,
    account,
    note: prepared,
    source,
    date,
    rawText: prepared,
  };
}

export function shouldIgnoreTransactionText(rawText: string): boolean {
  return IGNORABLE_PATTERNS.some((pattern) => pattern.test(rawText));
}

function inferKind(rawText: string): TransactionKind {
  if (EXPENSE_PATTERNS.some((pattern) => pattern.test(rawText))) {
    return 'expense';
  }

  return INCOME_PATTERNS.some((pattern) => pattern.test(rawText)) ? 'income' : 'expense';
}

function inferAccount(rawText: string): string {
  if (/yape|plin|plineaste|yapeo/i.test(rawText)) {
    return 'Yape/Plin';
  }

  if (
    /(tarjeta|visa|mastercard|amex|credito)/i.test(rawText) &&
    !/cuenta de ahorro|ahorros|cuenta corriente|cuenta sueldo|cuenta digital/i.test(rawText)
  ) {
    return 'Tarjeta';
  }

  if (/debito/i.test(rawText) && !/online debit/i.test(rawText)) {
    return 'Tarjeta';
  }

  if (/pagoefectivo|pagseguro|online debit|pago efectivo/i.test(rawText)) {
    return 'Efectivo';
  }

  if (
    /transferencia|cuenta de origen|cuenta de destino|cuenta sueldo|cuenta digital|cuenta de ahorro|ahorros|importe cargado|importe transferido/i.test(
      rawText,
    )
  ) {
    return 'Transferencia';
  }

  return 'Otro';
}

function inferCategory(rawText: string, kind: TransactionKind): string {
  if (kind === 'income') {
    return 'Ingreso';
  }

  if (
    /(steam|valve|boacompra|boa compra|leaf it alone|gracias por comprar en steam|your payment of|payment has been successfully sent)/i.test(
      rawText,
    )
  ) {
    return 'Compras';
  }

  if (
    /win internet|internet|pago automatico|pago de servicios|pagoefectivo|claro|movistar|entel|bitel|recibo|servicio favorito/i.test(
      rawText,
    )
  ) {
    return 'Servicios';
  }

  if (
    PERSON_TO_PERSON_PATTERNS.some((pattern) => pattern.test(rawText)) ||
    /pago a tu tarjeta|transferencia interbancaria|transferencia a cuentas propias|transferir a terceros bbva|importe transferido|importe cargado/i.test(
      rawText,
    )
  ) {
    return 'Transferencias';
  }

  if (/(uber|didi|cabify|taxi|rides|movilidad|peaje|tren|metro lima|bus|combi)/i.test(rawText)) {
    return 'Transporte';
  }

  if (
    /(rappi|restaurante|cafe|cafeteria|supermercado|plaza vea|tottus|wong|metro|tambo|comida|almuerzo|menu|delivery|pedidosya|burger|pizza|kfc|mcdonald)/i.test(
      rawText,
    )
  ) {
    return 'Comida';
  }

  if (/(farmacia|clinica|medicina|salud|seguro medico|hospital|laboratorio|botica)/i.test(rawText)) {
    return 'Salud';
  }

  if (
    /(spotify|netflix|apple|icloud|google one|contabo|adobe|amazon prime|disney|hbo|suscripcion|subscription)/i.test(
      rawText,
    )
  ) {
    return 'Suscripciones';
  }

  if (/(ripley|saga|zara|h&m|falabella|oechsle|compra|tienda|mall|ropa|calzado)/i.test(rawText)) {
    return 'Compras';
  }

  if (/(steam|valve|boacompra|boa compra|pagseguro|videojuego|game purchase|juego)/i.test(rawText)) {
    return 'Compras';
  }

  if (/(alquiler|mantenimiento|condominio|municipalidad|predial|hipoteca)/i.test(rawText)) {
    return 'Casa';
  }

  return 'Otros';
}

function inferSource(rawText: string): ParsedCapture['source'] {
  if (KNOWN_GMAIL_PATTERNS.some((pattern) => pattern.test(rawText))) {
    return 'gmail';
  }

  if (/whatsapp|wsp/i.test(rawText)) {
    return 'whatsapp';
  }

  return 'notification';
}

function inferTitle(
  preparedText: string,
  rawText: string,
  kind: TransactionKind,
): string {
  const paymentServiceFromSubject = preparedText.match(
    /pago automatico exitoso de tu servicio\s+([A-Za-z0-9* .&-]{2,80})/i,
  );

  if (paymentServiceFromSubject?.[1]) {
    return beautifyCounterparty(paymentServiceFromSubject[1]);
  }

  const orderMatch =
    preparedText.match(/order:\s*(?:•\s*)?([A-Za-z0-9'!,: .&-]{2,120})/i) ||
    preparedText.match(
      /gracias por tu reciente transaccion en steam[\s\S]{0,260}?\n\s*([A-Za-z0-9'!,: .&-]{2,120})\s*\n\s*subtotal\s*\(/i,
    );

  if (orderMatch?.[1]) {
    return beautifyCounterparty(orderMatch[1]);
  }

  const companyMatch =
    preparedText.match(/empresa\s*:?\s*([A-Za-z0-9* .&-]{2,80})/i) ||
    preparedText.match(/comercio\s*:?\s*([A-Za-z0-9* .&-]{2,80})/i) ||
    preparedText.match(/establecimiento\s*:?\s*([A-Za-z0-9* .&-]{2,80})/i) ||
    preparedText.match(/en\s+([A-Za-z0-9* .&-]{2,80}?)(?=\.|\n| con|$)/i) ||
    preparedText.match(/consumo por .*? en\s+([A-Za-z0-9* .&-]{2,80}?)(?=\.|\n| con|$)/i);

  if (companyMatch?.[1] && !/^tu cuenta|^cuenta/i.test(companyMatch[1].trim())) {
    return beautifyCounterparty(companyMatch[1]);
  }

  const serviceMatch = extractLabelValue(preparedText, ['Servicio', 'Empresa']);

  if (serviceMatch && !/^pago soles|^cuenta/i.test(serviceMatch.toLowerCase())) {
    return beautifyCounterparty(serviceMatch);
  }

  const senderMatch =
    preparedText.match(/enviado por\s+([A-Za-z0-9 .&-]{3,80}?)(?=\.|\n| en | desde |$)/i) ||
    preparedText.match(/recibiste un yapeo de .*? de ([A-Za-z0-9 .&-]{3,80}?)(?=\.|\n| en | desde |$)/i) ||
    preparedText.match(/recibiste una transferencia .*? de ([A-Za-z0-9 .&-]{3,80}?)(?=\.|\n| en | desde |$)/i) ||
    preparedText.match(/plineaste .*? a ([A-Za-z0-9 .&-]{3,80}?)(?=\n| destino| itf| fecha| numero|$)/i) ||
    preparedText.match(/nombre del beneficiario\s+([A-Za-z0-9 .&-]{3,80}?)(?=\n|$)/i) ||
    preparedText.match(/titular del servicio\s+([A-Za-z0-9 .&-]{3,80}?)(?=\n|$)/i) ||
    preparedText.match(/beneficiario\s+([A-Za-z0-9 .&-]{3,80}?)(?=\n|$)/i);

  if (senderMatch?.[1]) {
    return beautifyCounterparty(senderMatch[1]);
  }

  if (/pago a tu tarjeta/i.test(rawText)) {
    return 'Pago tarjeta propia';
  }

  if (/transferencia interbancaria/i.test(rawText)) {
    return 'Transferencia interbancaria';
  }

  if (/transferencia a cuentas propias|transf\. a ctas\. propias/i.test(rawText)) {
    return 'Transferencia propia';
  }

  return kind === 'income' ? 'Ingreso detectado' : 'Gasto detectado';
}

function extractAmount(preparedText: string, rawText: string): number | null {
  const prioritizedPatterns = [
    /monto recibido\s*:?\s*(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /monto abonado\s*:?\s*(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /monto pagado\s*:?\s*(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /monto total\s*:?\s*(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /total del consumo\s*:?\s*(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /total transferido\s*:?\s*(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /importe transferido\s*:?\s*(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /importe cargado\s*:?\s*(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /importe de (?:la )?compra\s*:?\s*(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /realizaste un consumo de\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /consumo por\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /recibiste un yapeo de\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /plineaste\s+(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /payment of\s+(?:s\/\.?|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /total de esta transaccion\s*:?\s*(?:s\/\.?|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    /total\s*:?\s*(?:s\/\.?|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
  ];

  for (const pattern of prioritizedPatterns) {
    const match = preparedText.match(pattern);

    if (match?.[1]) {
      return normalizeAmount(match[1]);
    }
  }

  const labeledAmount = extractLabelValue(preparedText, [
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
    const normalizedLabeledAmount = labeledAmount.match(
      /(?:s\/|\$|pen|usd)?\s?(\d+(?:[.,]\d{1,2})?)/i,
    );

    if (normalizedLabeledAmount?.[1]) {
      return normalizeAmount(normalizedLabeledAmount[1]);
    }
  }

  const fallbackMatch = rawText.match(
    /(?:s\/|\$|pen|usd)\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{1,2})?)/i,
  );

  return fallbackMatch?.[1] ? normalizeAmount(fallbackMatch[1]) : null;
}

function normalizeAmount(rawAmount: string): number | null {
  const normalized = rawAmount.replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null;
}

function extractLabelValue(rawText: string, labels: string[]): string {
  const lines = rawText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const normalizedLabels = labels.map((label) => createMatchableText(label));

  for (let index = 0; index < lines.length; index += 1) {
    const currentLine = createMatchableText(lines[index]);

    if (!normalizedLabels.some((label) => currentLine === label)) {
      continue;
    }

    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const candidate = lines[nextIndex].trim();

      if (!candidate || normalizedLabels.includes(createMatchableText(candidate))) {
        continue;
      }

      return candidate;
    }
  }

  return '';
}

function beautifyCounterparty(rawValue: string): string {
  const cleaned = rawValue
    .replace(/^plin-/i, '')
    .replace(/^(pyu|dlc|paypal)\*/i, '')
    .replace(/\s+-\s+servicio de notificaciones bcp$/i, '')
    .replace(/\s+-\s+bbva$/i, '')
    .replace(/\s+bbva$/i, '')
    .replace(/[.]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const dictionary: Record<string, string> = {
    uber: 'Uber',
    'uber rides': 'Uber Rides',
    'uber trip': 'Uber Trip',
    didi: 'Didi',
    rappi: 'Rappi',
    'pyu uber': 'Uber',
    'tambo 2': 'Tambo',
    mcdonalds: "McDonald's",
    'plaza vea': 'Plaza Vea',
    netflix: 'Netflix',
    spotify: 'Spotify',
    pagoefectivo: 'PagoEfectivo',
    pagseguro: 'PagSeguro',
    steam: 'Steam',
    'leaf it alone': 'Leaf It Alone',
    'win internet': 'WIN Internet',
    contabo: 'Contabo',
  };

  const lower = createMatchableText(cleaned);

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

function repairCommonEncoding(rawText: string): string {
  return String(rawText || '')
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

function createMatchableText(rawText: string): string {
  return repairCommonEncoding(rawText)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\r/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .toLowerCase()
    .trim();
}

function normalizeWhitespace(rawText: string): string {
  return String(rawText || '').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
