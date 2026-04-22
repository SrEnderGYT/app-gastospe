import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { FirebaseAuthService } from './firebase-auth.service';
import { FirebaseTransactionsService } from './firebase-transactions.service';
import {
  ParsedCapture,
  SyncPayload,
  SyncResult,
  SyncSettings,
  Transaction,
  TransactionDraft,
  TransactionKind,
} from '../models/finance.models';

const TRANSACTIONS_KEY = 'gastospe.transactions.v2';
const SETTINGS_KEY = 'gastospe.settings.v2';
const DELETED_TRANSACTIONS_KEY = 'gastospe.deleted-transactions.v1';

type SyncState = {
  syncing: boolean;
  lastAttempt: string;
  lastMessage: string;
};

type CloudState = {
  connected: boolean;
  lastPulledAt: string;
  lastMessage: string;
};

@Injectable({ providedIn: 'root' })
export class FinanceStoreService {
  private readonly firebaseAuth = inject(FirebaseAuthService);
  private readonly firebaseTransactions = inject(FirebaseTransactionsService);

  readonly transactions = signal<Transaction[]>(this.loadTransactions());
  readonly settings = signal<SyncSettings>(this.loadSettings());
  readonly deletedTransactionIds = signal<string[]>(this.loadDeletedTransactionIds());
  readonly online = signal(this.resolveOnline());
  readonly syncState = signal<SyncState>({
    syncing: false,
    lastAttempt: '',
    lastMessage: 'Todavia no hubo sincronizacion.',
  });
  readonly cloudState = signal<CloudState>({
    connected: false,
    lastPulledAt: '',
    lastMessage: 'Firestore aun no esta conectado.',
  });

  readonly pendingTransactions = computed(() =>
    this.transactions().filter((item) => item.syncStatus !== 'synced'),
  );

  constructor() {
    effect(() => {
      this.saveJson(TRANSACTIONS_KEY, this.transactions());
    });

    effect(() => {
      this.saveJson(SETTINGS_KEY, this.settings());
    });

    effect(() => {
      this.saveJson(DELETED_TRANSACTIONS_KEY, this.deletedTransactionIds());
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

    effect((onCleanup) => {
      if (!this.firebaseAuth.isSignedIn() || !this.firebaseAuth.configReady()) {
        this.cloudState.set({
          connected: false,
          lastPulledAt: untracked(() => this.cloudState().lastPulledAt),
          lastMessage: this.firebaseAuth.configReady()
            ? 'Inicia sesion con Google para leer Firestore.'
            : 'Completa Firebase para activar la nube.',
        });
        return;
      }

      const unsubscribe = this.firebaseTransactions.watchTransactions(
        (remoteTransactions) => {
          this.mergeRemoteTransactions(remoteTransactions);
          this.cloudState.set({
            connected: true,
            lastPulledAt: new Date().toISOString(),
            lastMessage: remoteTransactions.length
              ? `${remoteTransactions.length} movimientos visibles en Firestore.`
              : 'Firestore conectado. Aun no hay movimientos remotos.',
          });
        },
        (message) => {
          this.cloudState.set({
            connected: false,
            lastPulledAt: untracked(() => this.cloudState().lastPulledAt),
            lastMessage: message,
          });
        },
      );

      if (unsubscribe) {
        onCleanup(unsubscribe);
      }
    });

    effect(() => {
      if (!this.settings().autoSync || !this.online()) {
        return;
      }

      if (this.pendingTransactions().length || this.deletedTransactionIds().length) {
        void this.syncPendingTransactions();
      }
    });
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

    this.transactions.update((items) => this.sortTransactions([transaction, ...items]));

    if (this.settings().autoSync && this.online()) {
      void this.syncPendingTransactions();
    }
  }

  removeTransaction(id: string): void {
    this.transactions.update((items) => items.filter((item) => item.id !== id));

    if (this.firebaseAuth.isSignedIn() && this.firebaseAuth.configReady()) {
      this.deletedTransactionIds.update((items) => (items.includes(id) ? items : [...items, id]));

      if (this.settings().autoSync && this.online()) {
        void this.syncPendingTransactions();
      }
    }
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
      source: /(gmail|correo|mail)/i.test(lower)
        ? 'gmail'
        : /(whatsapp|wsp)/i.test(lower)
          ? 'whatsapp'
          : 'notification',
      date: new Date().toISOString().slice(0, 10),
      rawText: normalized,
    };
  }

  async syncPendingTransactions(): Promise<void> {
    const pending = this.pendingTransactions();
    const deletions = this.deletedTransactionIds();
    const settings = this.settings();

    if (!pending.length && !deletions.length) {
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
        lastMessage: 'Sin conexion: tus cambios siguen guardados localmente.',
      });
      return;
    }

    if (settings.syncMode === 'local') {
      this.syncState.set({
        syncing: false,
        lastAttempt: new Date().toISOString(),
        lastMessage: 'Modo local activo. Exporta CSV, usa Sheets o inicia sesion para la nube.',
      });
      return;
    }

    if (settings.syncMode === 'firebase' && !this.firebaseAuth.configReady()) {
      this.syncState.set({
        syncing: false,
        lastAttempt: new Date().toISOString(),
        lastMessage: 'Falta configurar la Web App de Firebase.',
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

    const messages: string[] = [];
    let success = true;

    if (pending.length) {
      const payload: SyncPayload = {
        source: 'gastospe-web',
        exportedAt: new Date().toISOString(),
        owner: settings.owner,
        syncMode: settings.syncMode,
        transactions: pending,
      };

      const result =
        settings.syncMode === 'sheet'
          ? await this.sendToSheet(payload)
          : await this.firebaseTransactions.syncTransactions(payload);

      this.transactions.update((items) =>
        items.map((item) => {
          if (!pending.some((pendingItem) => pendingItem.id === item.id)) {
            return item;
          }

          return {
            ...item,
            owner: settings.owner,
            syncMode: settings.syncMode,
            exportedAt: payload.exportedAt,
            syncedAt: result.success ? new Date().toISOString() : item.syncedAt,
            uid: this.firebaseAuth.uid() || item.uid,
            syncStatus: result.success ? 'synced' : 'failed',
            syncMessage: result.message,
          };
        }),
      );

      success = success && result.success;
      messages.push(result.message);
    }

    if (settings.syncMode === 'firebase' && deletions.length) {
      const deleteResult = await this.firebaseTransactions.deleteTransactions(deletions);

      if (deleteResult.success) {
        this.deletedTransactionIds.set([]);
      }

      success = success && deleteResult.success;
      messages.push(deleteResult.message);
    }

    this.syncState.set({
      syncing: false,
      lastAttempt: new Date().toISOString(),
      lastMessage: messages.join(' ') || (success ? 'Sincronizacion completa.' : 'No se pudo sincronizar.'),
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

  private async postJson(url: string, payload: SyncPayload, successMessage: string): Promise<SyncResult> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
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

  private mergeRemoteTransactions(remoteTransactions: Transaction[]): void {
    const deletedIds = new Set(this.deletedTransactionIds());
    const visibleRemoteTransactions = remoteTransactions.filter((item) => !deletedIds.has(item.id));
    const remoteIds = new Set(visibleRemoteTransactions.map((item) => item.id));

    const localUnsyncedTransactions = this.transactions().filter(
      (item) => item.syncStatus !== 'synced' && !remoteIds.has(item.id) && !deletedIds.has(item.id),
    );

    this.transactions.set(
      this.sortTransactions([...visibleRemoteTransactions, ...localUnsyncedTransactions]),
    );
  }

  private loadTransactions(): Transaction[] {
    const raw = this.readJson<Transaction[]>(TRANSACTIONS_KEY);
    return Array.isArray(raw) ? raw : [];
  }

  private loadSettings(): SyncSettings {
    const raw = this.readJson<Partial<SyncSettings>>(SETTINGS_KEY);
    return { ...this.defaultSettings(), ...(raw || {}) };
  }

  private loadDeletedTransactionIds(): string[] {
    const raw = this.readJson<string[]>(DELETED_TRANSACTIONS_KEY);
    return Array.isArray(raw) ? raw.filter((item) => typeof item === 'string') : [];
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
    if (/(restaurante|cafe|super|plaza vea|tottus|wong|metro|comida|almuerzo|menu)/i.test(text)) {
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

  private readJson<T>(key: string): T | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }

    const raw = localStorage.getItem(key);

    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private saveJson(key: string, value: unknown): void {
    if (typeof localStorage === 'undefined') {
      return;
    }

    localStorage.setItem(key, JSON.stringify(value));
  }

  private sortTransactions(items: Transaction[]): Transaction[] {
    return [...items].sort((left, right) => {
      const dateCompare = right.date.localeCompare(left.date);

      if (dateCompare !== 0) {
        return dateCompare;
      }

      return (right.createdAt || '').localeCompare(left.createdAt || '');
    });
  }
}
