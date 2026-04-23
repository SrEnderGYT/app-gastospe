import { describe, expect, it } from 'vitest';
import { parseTransactionText } from './transaction-parser';

describe('parseTransactionText', () => {
  it('detects a BCP credit card purchase email as an expense', () => {
    const parsed = parseTransactionText(
      [
        'Realizaste un consumo con tu Tarjeta de Credito BCP',
        'Hola German,',
        'Realizaste un consumo de S/ 6.40 con tu Tarjeta de Credito BCP en DLC*UBER RIDES.',
        'Monto',
        'Total del consumo',
        'S/ 6.40',
        'Empresa',
        'DLC*UBER RIDES',
      ].join('\n'),
      { defaultDate: '2026-04-23', defaultSource: 'gmail' },
    );

    expect(parsed).toMatchObject({
      kind: 'expense',
      amount: 6.4,
      title: 'Uber Rides',
      category: 'Transporte',
      account: 'Tarjeta',
      source: 'gmail',
      date: '2026-04-23',
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

  it('detects a BBVA interbank transfer email as an expense', () => {
    const parsed = parseTransactionText(
      [
        'BBVA - Constancia Transf. Interbancaria',
        'Hola, German',
        'Has realizado con exito la operacion:',
        'Transferencia interbancaria',
        'Importe transferido',
        'S/ 1000.00',
        'Importe cargado S/ 1000.00',
        'Nombre del beneficiario',
        'German Cubas Saco',
      ].join('\n'),
      { defaultDate: '2026-04-15', defaultSource: 'gmail' },
    );

    expect(parsed).toMatchObject({
      kind: 'expense',
      amount: 1000,
      title: 'German Cubas Saco',
      category: 'Transferencias',
      account: 'Transferencia',
      source: 'gmail',
      date: '2026-04-15',
    });
  });

  it('detects a BBVA PLIN debit as a transfer expense', () => {
    const parsed = parseTransactionText(
      [
        'Constancia de operacion transferencia PLIN',
        'Hola, GERMAN',
        'Plineaste S/ 120.53 a German Cubas S',
        'Detalles de tu plineo',
        'Destino: Yape',
        'Numero de operacion: 28E3B9BE7006',
      ].join('\n'),
      { defaultDate: '2026-04-20', defaultSource: 'gmail' },
    );

    expect(parsed).toMatchObject({
      kind: 'expense',
      amount: 120.53,
      title: 'German Cubas S',
      category: 'Transferencias',
      account: 'Yape/Plin',
      source: 'gmail',
    });
  });

  it('detects a BCP service payment email as an expense even with mojibake', () => {
    const parsed = parseTransactionText(
      [
        'ENVIO AUTOMATICO - CONSTANCIA DE PAGO DE SERVICIO - BANCA MOVIL BCP',
        'Hola GERMAN,',
        'Â¡Tu operaciÃ³n se realizÃ³ con Ã©xito!',
        'OperaciÃ³n realizada:',
        'Pago de servicios',
        'Empresa:',
        'PAGOEFECTIVO',
        'Cuenta de origen:',
        'Tarjeta de credito',
        'Monto total:',
        'S/ 342.50',
      ].join('\n'),
      { defaultDate: '2026-04-21', defaultSource: 'gmail' },
    );

    expect(parsed).toMatchObject({
      kind: 'expense',
      amount: 342.5,
      title: 'PagoEfectivo',
      category: 'Servicios',
      account: 'Tarjeta',
      source: 'gmail',
    });
  });

  it('detects an automatic service payment email as an expense', () => {
    const parsed = parseTransactionText(
      [
        'Pago automatico exitoso de tu servicio WIN INTERNET',
        'El Pago AutomÃ¡tico de tu servicio favorito se realizÃ³ con Ã©xito.',
        'Monto',
        'Total transferido',
        'S/59.00',
        'Empresa',
        'WIN INTERNET',
        'N° de cuenta o tarjeta',
        'Cuenta de Ahorro',
      ].join('\n'),
      { defaultDate: '2026-04-21', defaultSource: 'gmail' },
    );

    expect(parsed).toMatchObject({
      kind: 'expense',
      amount: 59,
      title: 'WIN Internet',
      category: 'Servicios',
      account: 'Transferencia',
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
