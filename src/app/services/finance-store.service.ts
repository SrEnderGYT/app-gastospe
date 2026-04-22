import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { FirebaseAuthService } from './firebase-auth.service';
import {
  ParsedCapture,
  SyncPayload,
  SyncResult,
  SyncSettings,
  Transaction,
  TransactionDraft,
  TransactionKind,
} from '../models/finance.models';

const TRANSACTIONS_KEY = 'gastospe.transactions.v1';
const SETTINGS_KEY = 'gastospe.settings.v1';

@Injectable({ providedIn: 'root' })
export class FinanceStoreService {
  private readonly firebaseAuth = inject(FirebaseAuthService);

  readonly transactions = signal<Transaction[]>(this.loadTransactions());
  readonly settings = signal<SyncSettings>(this.loadSettings());
  readonly online = signal(this.resolveOnline());
  readonly syncState = signal({
    syncing: false,
    lastAttempt: '',
    lastMessage: 'Todavia no hubo sincronizacion.',
  });

  readonly pendingTransactions = computed(() =>
    this.transactions().filter((item) => item.syncStatus !== 'synced'),
  );

  constructor() {
    effect(() => {
      localStorage.setItem(TRANSACTIONS_KEY, JSON.stringify(this.transactions()));
    });

    effect(() => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings()));
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.online.set(true);
        if (this.settings().autoSync) {
          void this.syncPendingTransactions();
        }
      });

      window.addEventListener('offline', () => this.online.set(false));
    }
  }

  createDraft(): TransactionDraft {
    return {
      kind: 'expense',
      title: '',
      amount: 0,
      category: 'Comida',
      date: new Date().toISOString().slice(0, 10),
      account: 'Tarjeta',
      note: '',
      source: 'manual',
      rawText: '',
    };
  }

  defaultSettings(): SyncSettings {
    return {
      owner: 'Mi tablero',
      currency: 'PEN',
      syncMode: 'local',
      autoSync: true,
      sheetWebhookUrl: '',
    };
  }

  addTransaction(draft: TransactionDraft): void {
    const transaction: Transaction = {
      ...draft,
      title: draft.title.trim() || 'Movimiento sin titulo',
      note: draft.note.trim(),
      amount: Math.abs(Number(draft.amount) || 0),
      id: this.createId(),
      createdAt: new Date().toISOString(),
      syncStatus: 'pending',
      syncMessage: 'Pendiente',
    };

    this.transactions.update((items) => [transaction, ...items]);

    if (this.settings().autoSync && this.online()) {
      void this.syncPendingTransactions();
    }
  }

  removeTransaction(id: string): void {
    this.transactions.update((items) => items.filter((item) => item.id !== id));
  }

  updateSettings(patch: Partial<SyncSettings>): void {
    this.settings.update((current) => ({ ...current, ...patch }));
  }

  parseCapturedText(rawText: string): ParsedCapture {
    const normalized = rawText.trim();
    const amount = this.extractAmount(normalized);
    const lower = normalized.toLowerCase();
    const kind: TransactionKind =
      /(recibiste|ingreso|deposito|abono|te enviaron|transferencia recibida)/i.test(lower)
        ? 'income'
        : 'expense';

    const category = this.inferCategory(lower, kind);
    const account = /(yape|plin)/i.test(lower)
      ? 'Yape/Plin'
      : /(tarjeta|visa|mastercard|debito|credito)/i.test(lower)
        ? 'Tarjeta'
        : /(transferencia|bcp|interbank|bbva|scotiabank)/i.test(lower)
          ? 'Transferencia'
          : 'Otro';

    return {
      title: this.inferTitle(normalized, kind),
      amount,
      kind,
      category,
      account,
      note: normalized,
      source: /(whatsapp|wsp)/i.test(lower) ? 'whatsapp' : 'notification',
      date: new Date().toISOString().slice(0, 10),
      rawText: normalized,
    };
  }

  async syncPendingTransactions(): Promise<void> {
    const pending = this.pendingTransactions();
    const settings = this.settings();

    if (!pending.length) {
      this.syncState.set({
        syncing: false,
        lastAttempt: new Date().toISOString(),
        lastMessage: 'No hay movimientos pendientes.',
      });
      return;
    }

    if (!this.online()) {
      this.syncState.set({
        syncing: false,
        lastAttempt: new Date().toISOString(),
        lastMessage: 'Sin conexion: los movimientos siguen guardados localmente.',
      });
      return;
    }

    if (settings.syncMode === 'local') {
      this.syncState.set({
        syncing: false,
        lastAttempt: new Date().toISOString(),
        lastMessage: 'Modo local activo. Exporta CSV o inicia sesion para sincronizar.',
      });
      return;
    }

    if (settings.syncMode === 'firebase' && !this.firebaseAuth.configReady()) {
      this.syncState.set({
        syncing: false,
        lastAttempt: new Date().toISOString(),
        lastMessage: 'Falta configurar la Web App de Firebase para activar la nube.',
      });
      return;
    }

    if (settings.syncMode === 'firebase' && !this.firebaseAuth.isSignedIn()) {
      this.syncState.set({
        syncing: false,
        lastAttempt: new Date().toISOString(),
        lastMessage: 'Inicia sesion con Google para sincronizar en Firebase.',
      });
      return;
    }

    this.syncState.update((current) => ({
      ...current,
      syncing: true,
      lastAttempt: new Date().toISOString(),
    }));

    const result =
      settings.syncMode === 'sheet'
        ? await this.sendToSheet({
            source: 'gastospe-web',
            exportedAt: new Date().toISOString(),
            owner: settings.owner,
            syncMode: settings.syncMode,
            transactions: pending,
          })
        : await this.sendToFirebase({
            source: 'gastospe-web',
            exportedAt: new Date().toISOString(),
            owner: settings.owner,
            syncMode: settings.syncMode,
            transactions: pending,
          });

    this.transactions.update((items) =>
      items.map((item) => {
        if (!pending.some((pendingItem) => pendingItem.id === item.id)) {
          return item;
        }

        return {
          ...item,
          syncStatus: result.success ? 'synced' : 'failed',
          syncMessage: result.message,
        };
      }),
    );

    this.syncState.set({
      syncing: false,
      lastAttempt: new Date().toISOString(),
      lastMessage: result.message,
    });
  }

  exportCsv(): void {
    const lines = [
      [
        'id',
        'fecha',
        'tipo',
        'titulo',
        'monto',
        'categoria',
        'cuenta',
        'origen',
        'nota',
        'estado_sync',
      ].join(','),
      ...this.transactions().map((item) =>
        [
          item.id,
          item.date,
          item.kind,
          this.escapeCsv(item.title),
          item.amount.toFixed(2),
          this.escapeCsv(item.category),
          this.escapeCsv(item.account),
          item.source,
          this.escapeCsv(item.note || ''),
          item.syncStatus,
        ].join(','),
      ),
    ];

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `gastospe-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  private async sendToSheet(payload: SyncPayload): Promise<SyncResult> {
    const url = this.settings().sheetWebhookUrl.trim();

    if (!url) {
      return {
        success: false,
        message: 'Falta configurar la URL del webhook de Google Sheets.',
      };
    }

    return this.postJson(url, payload, 'Movimientos enviados a Google Sheets.');
  }

  private async sendToFirebase(payload: SyncPayload): Promise<SyncResult> {
    const authorization = await this.firebaseAuth.getAuthorizationHeader();
    const url = this.firebaseAuth.functionUrl();

    if (!authorization || !url) {
      return {
        success: false,
        message: 'La sesion de Firebase no esta lista para sincronizar.',
      };
    }

    return this.postJson(url, payload, 'Movimientos enviados a Firestore.', {
      Authorization: authorization,
    });
  }

  private async postJson(
    url: string,
    payload: SyncPayload,
    successMessage: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<SyncResult> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        return {
          success: false,
          message: `El destino respondio ${response.status}.`,
        };
      }

      return {
        success: true,
        message: successMessage,
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'No se pudo sincronizar.',
      };
    }
  }

  private loadTransactions(): Transaction[] {
    const raw = localStorage.getItem(TRANSACTIONS_KEY);

    if (!raw) {
      return this.seedTransactions();
    }

    try {
      return JSON.parse(raw) as Transaction[];
    } catch {
      return this.seedTransactions();
    }
  }

  private loadSettings(): SyncSettings {
    const raw = localStorage.getItem(SETTINGS_KEY);

    if (!raw) {
      return this.defaultSettings();
    }

    try {
      return { ...this.defaultSettings(), ...(JSON.parse(raw) as Partial<SyncSettings>) };
    } catch {
      return this.defaultSettings();
    }
  }

  private seedTransactions(): Transaction[] {
    const today = new Date();
    const asDate = (delta: number) => {
      const date = new Date(today);
      date.setDate(date.getDate() - delta);
      return date.toISOString().slice(0, 10);
    };

    return [
      {
        id: this.createId(),
        kind: 'expense',
        title: 'Supermercado',
        amount: 148.2,
        category: 'Comida',
        date: asDate(0),
        account: 'Tarjeta',
        note: 'Compra semanal',
        source: 'manual',
        createdAt: new Date().toISOString(),
        syncStatus: 'pending',
        syncMessage: 'Pendiente',
      },
      {
        id: this.createId(),
        kind: 'expense',
        title: 'Spotify',
        amount: 24.9,
        category: 'Suscripciones',
        date: asDate(2),
        account: 'Tarjeta',
        note: 'Renovacion mensual',
        source: 'notification',
        rawText: 'Se realizo el cobro de Spotify por S/ 24.90',
        createdAt: new Date().toISOString(),
        syncStatus: 'synced',
        syncMessage: 'Sincronizado',
      },
      {
        id: this.createId(),
        kind: 'income',
        title: 'Pago de cliente',
        amount: 820,
        category: 'Ingreso',
        date: asDate(4),
        account: 'Transferencia',
        note: 'Transferencia recibida',
        source: 'whatsapp',
        rawText: 'Cliente confirmo pago por S/ 820',
        createdAt: new Date().toISOString(),
        syncStatus: 'pending',
        syncMessage: 'Pendiente',
      },
    ];
  }

  private inferTitle(rawText: string, kind: TransactionKind): string {
    const merchantMatch =
      rawText.match(/(?:en|a|por)\s+([A-Za-z0-9 .&-]{3,40})/i) ??
      rawText.match(/(?:compra|pago|abono|transferencia)\s+([A-Za-z0-9 .&-]{3,40})/i);

    if (merchantMatch?.[1]) {
      return merchantMatch[1].trim();
    }

    return kind === 'income' ? 'Ingreso detectado' : 'Gasto detectado';
  }

  private inferCategory(text: string, kind: TransactionKind): string {
    if (kind === 'income') {
      return 'Ingreso';
    }

    if (/(uber|bus|taxi|combustible|peaje)/i.test(text)) {
      return 'Transporte';
    }
    if (/(farmacia|clinica|seguro|salud)/i.test(text)) {
      return 'Salud';
    }
    if (/(luz|agua|internet|gas|telefono)/i.test(text)) {
      return 'Servicios';
    }
    if (/(netflix|spotify|icloud|subscription|suscripcion)/i.test(text)) {
      return 'Suscripciones';
    }
    if (/(restaurante|cafe|super|plaza vea|tottus|wong|metro|comida)/i.test(text)) {
      return 'Comida';
    }
    if (/(ripley|saga|zara|h&m|compra)/i.test(text)) {
      return 'Compras';
    }
    return 'Otros';
  }

  private extractAmount(text: string): number | null {
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

  private escapeCsv(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
  }

  private createId(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  private resolveOnline(): boolean {
    return typeof navigator !== 'undefined' ? navigator.onLine : true;
  }
}
