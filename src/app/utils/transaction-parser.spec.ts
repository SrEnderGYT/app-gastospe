import { describe, expect, it } from 'vitest';
import { parseTransactionText } from './transaction-parser';

describe('parseTransactionText', () => {
  it('detects a BCP credit card purchase email as an expense', () => {
    const parsed = parseTransactionText(
      [
        'Realizaste un consumo con tu Tarjeta de Credito BCP',
        'Hola German,',
        'Realizaste un consumo de S/ 6.30 con tu Tarjeta de Credito BCP en PYU*UBER.',
        'Monto',
        'Total del consumo',
        'S/ 6.30',
        'Empresa',
        'PYU*UBER',
      ].join('\n'),
      { defaultDate: '2026-04-21' },
    );

    expect(parsed).toMatchObject({
      kind: 'expense',
      amount: 6.3,
      title: 'Uber',
      category: 'Transporte',
      account: 'Tarjeta',
      source: 'notification',
      date: '2026-04-21',
    });
  });

  it('detects a BCP incoming Yape email as income', () => {
    const parsed = parseTransactionText(
      [
        'Constancia de recepcion de Yapeo a celular BCP',
        'Hola German,',
        'Recibiste un yapeo de S/ 339.00 de Angelly Fiorella Carrion Ruiz.',
        'Monto recibido',
        'S/ 339.00',
        'Enviado por',
        'Angelly Fiorella Carrion Ruiz',
      ].join('\n'),
      { defaultDate: '2026-04-21', defaultSource: 'gmail' },
    );

    expect(parsed).toMatchObject({
      kind: 'income',
      amount: 339,
      title: 'Angelly Fiorella Carrion Ruiz',
      category: 'Ingreso',
      account: 'Yape/Plin',
      source: 'gmail',
      date: '2026-04-21',
    });
  });

  it('detects a PLIN debit as a transfer expense', () => {
    const parsed = parseTransactionText(
      [
        'Realizaste un consumo con tu Tarjeta de Debito BCP',
        'Realizaste un consumo de S/ 500.00 con tu Tarjeta de Debito BCP en PLIN-FIORELLA RUIZ.',
        'Monto',
        'Total del consumo',
        'S/ 500.00',
      ].join('\n'),
      { defaultDate: '2026-04-09', defaultSource: 'gmail' },
    );

    expect(parsed).toMatchObject({
      kind: 'expense',
      amount: 500,
      title: 'Fiorella Ruiz',
      category: 'Transferencias',
      account: 'Yape/Plin',
      source: 'gmail',
    });
  });

  it('ignores rejected BCP purchases', () => {
    const parsed = parseTransactionText(
      [
        'Se rechazo tu compra por e-commerce no permitido',
        'Hola German,',
        'Lo sentimos, tu compra fue rechazada por no tener habilitada la opcion de compras por internet.',
        'Monto',
        'Importe de compra',
        'S/ 200.00',
      ].join('\n'),
    );

    expect(parsed).toBeNull();
  });

  it('ignores BCP configuration notices', () => {
    const parsed = parseTransactionText(
      [
        'Constancia de Configuracion de Tarjeta en Banca Movil BCP',
        'Realizaste una configuracion para tu Tarjeta de Credito Visa Infinite Sapphire.',
      ].join('\n'),
    );

    expect(parsed).toBeNull();
  });
});
