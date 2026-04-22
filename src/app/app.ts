import { CommonModule, CurrencyPipe, DatePipe } from '@angular/common';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firebaseOptions } from './firebase/firebase.options';
import { SyncSettings, SyncStatus, TransactionKind } from './models/finance.models';
import { FirebaseAuthService } from './services/firebase-auth.service';
import { FinanceStoreService } from './services/finance-store.service';

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule, CurrencyPipe, DatePipe],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly store = inject(FinanceStoreService);
  private readonly firebaseAuthService = inject(FirebaseAuthService);
  private lastKnownAuthState: boolean | null = null;

  protected readonly transactions = this.store.transactions;
  protected readonly settings = this.store.settings;
  protected readonly online = this.store.online;
  protected readonly syncState = this.store.syncState;
  protected readonly cloudState = this.store.cloudState;
  protected readonly deletedTransactionIds = this.store.deletedTransactionIds;
  protected readonly captureText = signal('');
  protected readonly captureFeedback = signal('');
  protected readonly transactionSearch = signal('');
  protected readonly transactionStatusFilter = signal<'all' | SyncStatus>('all');
  protected readonly transactionKindFilter = signal<'all' | TransactionKind>('all');

  protected readonly firebaseConfigReady = this.firebaseAuthService.configReady;
  protected readonly authLoading = this.firebaseAuthService.loading;
  protected readonly isSignedIn = this.firebaseAuthService.isSignedIn;
  protected readonly hasCloudAccess = this.firebaseAuthService.hasCloudAccess;
  protected readonly isEmailVerified = this.firebaseAuthService.isEmailVerified;
  protected readonly needsEmailVerification = this.firebaseAuthService.needsEmailVerification;
  protected readonly firebaseUserLabel = this.firebaseAuthService.displayName;
  protected readonly firebaseUserEmail = this.firebaseAuthService.email;
  protected readonly firebaseUserId = this.firebaseAuthService.uid;
  protected readonly firebaseProviderLabel = this.firebaseAuthService.providerLabel;
  protected readonly firebaseAuthError = this.firebaseAuthService.error;
  protected readonly firebaseAuthNotice = this.firebaseAuthService.notice;
  protected readonly firebaseAutomationUrl = this.firebaseAuthService.automationFunctionUrl;
  protected readonly authMode = signal<'signin' | 'register'>('signin');
  protected readonly authName = signal('');
  protected readonly authEmail = signal('');
  protected readonly authPassword = signal('');

  protected readonly form = signal(this.store.createDraft());

  protected readonly currentMonthLabel = computed(() =>
    new Intl.DateTimeFormat('es-PE', {
      month: 'long',
      year: 'numeric',
    }).format(new Date()),
  );

  protected readonly currentMonthTransactions = computed(() => {
    const monthKey = new Date().toISOString().slice(0, 7);
    return this.transactions().filter((item) => item.date.startsWith(monthKey));
  });

  protected readonly totals = computed(() => {
    const currentMonth = this.currentMonthTransactions();
    const income = currentMonth
      .filter((item) => item.kind === 'income')
      .reduce((sum, item) => sum + item.amount, 0);
    const expense = currentMonth
      .filter((item) => item.kind === 'expense')
      .reduce((sum, item) => sum + item.amount, 0);

    return {
      income,
      expense,
      balance: income - expense,
      pending: this.transactions().filter((item) => item.syncStatus !== 'synced').length,
    };
  });

  protected readonly categoryBreakdown = computed(() => {
    const totalsByCategory = new Map<string, number>();

    for (const item of this.currentMonthTransactions()) {
      if (item.kind !== 'expense') {
        continue;
      }

      const current = totalsByCategory.get(item.category) ?? 0;
      totalsByCategory.set(item.category, current + item.amount);
    }

    return [...totalsByCategory.entries()]
      .map(([category, total]) => ({ category, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);
  });

  protected readonly monthlyRunRate = computed(() => {
    const today = new Date();
    const dayOfMonth = Math.max(today.getDate(), 1);
    const monthDays = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const currentExpense = this.totals().expense;

    return dayOfMonth ? (currentExpense / dayOfMonth) * monthDays : currentExpense;
  });

  protected readonly topCategoryLabel = computed(
    () => this.categoryBreakdown()[0]?.category || 'Sin categoria dominante',
  );

  protected readonly visibleTransactions = computed(() => {
    const search = this.transactionSearch().trim().toLowerCase();
    const status = this.transactionStatusFilter();
    const kind = this.transactionKindFilter();

    return [...this.transactions()]
      .filter((item) => (status === 'all' ? true : item.syncStatus === status))
      .filter((item) => (kind === 'all' ? true : item.kind === kind))
      .filter((item) => {
        if (!search) {
          return true;
        }

        return [item.title, item.category, item.account, item.note, item.source]
          .join(' ')
          .toLowerCase()
          .includes(search);
      })
      .slice(0, 24);
  });

  protected readonly syncTargetLabel = computed(() => {
    const mode = this.settings().syncMode;

    if (mode === 'sheet') {
      return 'Sheets';
    }

    if (mode === 'firebase') {
      return this.hasCloudAccess() ? 'Firestore' : 'Firebase';
    }

    return 'Local';
  });

  protected readonly syncSummaryLabel = computed(() => {
    if (this.settings().syncMode === 'firebase' && this.hasCloudAccess()) {
      return 'Cloud-first activo';
    }

    if (this.isSignedIn() && !this.hasCloudAccess()) {
      return 'Verificacion pendiente';
    }

    if (this.settings().syncMode === 'sheet') {
      return 'Salida secundaria en Sheets';
    }

    return 'Solo cache local';
  });

  protected readonly automationSummary = computed(() => {
    if (!this.firebaseConfigReady()) {
      return 'Configura Firebase antes de preparar Gmail.';
    }

    if (!this.isSignedIn()) {
      return 'Inicia sesion para obtener tu UID y activar automatizaciones.';
    }

    if (!this.hasCloudAccess()) {
      return 'Tu cuenta existe, pero debes verificar el correo antes de activar automatizaciones.';
    }

    return 'Tu cuenta ya puede recibir movimientos desde Apps Script.';
  });

  protected readonly quickModes = [
    { label: 'Gasto', value: 'expense' },
    { label: 'Ingreso', value: 'income' },
  ] as const;

  protected readonly categories = [
    'Comida',
    'Casa',
    'Transporte',
    'Transferencias',
    'Suscripciones',
    'Salud',
    'Compras',
    'Servicios',
    'Ingreso',
    'Otros',
  ];

  protected readonly accountOptions = ['Tarjeta', 'Transferencia', 'Efectivo', 'Yape/Plin', 'Otro'];
  protected readonly firebaseProjectId = firebaseOptions.projectId;

  constructor() {
    this.consumeSharedCapture();

    effect(() => {
      if (this.authLoading()) {
        return;
      }

      const isSignedIn = this.hasCloudAccess();
      const configReady = this.firebaseConfigReady();
      const currentMode = this.settings().syncMode;

      if (!configReady && currentMode === 'firebase') {
        this.updateSetting('syncMode', 'local');
        return;
      }

      if (this.lastKnownAuthState === null) {
        this.lastKnownAuthState = isSignedIn;

        if (!isSignedIn && currentMode === 'firebase') {
          this.updateSetting('syncMode', 'local');
        } else if (isSignedIn && configReady && currentMode === 'local') {
          this.updateSetting('syncMode', 'firebase');
        }

        return;
      }

      if (this.lastKnownAuthState === isSignedIn) {
        return;
      }

      this.lastKnownAuthState = isSignedIn;

      if (!isSignedIn && currentMode === 'firebase') {
        this.updateSetting('syncMode', 'local');
      } else if (isSignedIn && configReady && currentMode === 'local') {
        this.updateSetting('syncMode', 'firebase');
      }
    });
  }

  protected submitTransaction(): void {
    this.store.addTransaction(this.form());
    this.form.set(this.store.createDraft());
    this.captureFeedback.set(
      this.settings().syncMode === 'firebase' && this.hasCloudAccess()
        ? 'Movimiento guardado y en cola para Firestore.'
        : 'Movimiento guardado localmente.',
    );
  }

  protected parseCapture(): void {
    const value = this.captureText().trim();

    if (!value) {
      this.captureFeedback.set('Pega primero un texto de WhatsApp, correo o notificacion.');
      return;
    }

    const parsed = this.store.parseCapturedText(value);

    if (!parsed) {
      this.captureFeedback.set(
        'Ese texto parece una alerta informativa o una operacion rechazada, asi que no se cargo como movimiento.',
      );
      return;
    }

    this.form.set({
      kind: parsed.kind,
      title: parsed.title,
      amount: parsed.amount ?? 0,
      category: parsed.category,
      date: parsed.date,
      account: parsed.account,
      note: parsed.note,
      source: parsed.source,
      rawText: parsed.rawText,
    });
    this.captureFeedback.set('Texto interpretado. Revisa y confirma el movimiento.');
  }

  protected async syncNow(): Promise<void> {
    await this.store.syncPendingTransactions();
  }

  protected updateForm<K extends keyof ReturnType<FinanceStoreService['createDraft']>>(
    key: K,
    value: ReturnType<FinanceStoreService['createDraft']>[K],
  ): void {
    this.form.update((current) => ({ ...current, [key]: value }));
  }

  protected updateSetting<K extends keyof SyncSettings>(key: K, value: SyncSettings[K]): void {
    this.store.updateSettings({ [key]: value } as Partial<SyncSettings>);
  }

  protected async signInWithGoogle(): Promise<void> {
    await this.firebaseAuthService.signIn();

    if (this.hasCloudAccess() && this.settings().syncMode === 'local') {
      this.updateSetting('syncMode', 'firebase');
    }
  }

  protected async submitEmailAuth(): Promise<void> {
    if (this.authMode() === 'register') {
      await this.firebaseAuthService.registerWithEmail(
        this.authName(),
        this.authEmail(),
        this.authPassword(),
      );
    } else {
      await this.firebaseAuthService.signInWithEmail(this.authEmail(), this.authPassword());
    }

    if (this.hasCloudAccess() && this.settings().syncMode === 'local') {
      this.updateSetting('syncMode', 'firebase');
    }
  }

  protected async sendVerificationEmail(): Promise<void> {
    await this.firebaseAuthService.resendVerificationEmail();
  }

  protected async refreshVerificationState(): Promise<void> {
    await this.firebaseAuthService.refreshUser();

    if (this.hasCloudAccess() && this.settings().syncMode === 'local') {
      this.updateSetting('syncMode', 'firebase');
    }
  }

  protected async sendPasswordReset(): Promise<void> {
    await this.firebaseAuthService.sendPasswordReset(this.authEmail() || this.firebaseUserEmail());
  }

  protected async signOutFromFirebase(): Promise<void> {
    await this.firebaseAuthService.signOut();

    if (this.settings().syncMode === 'firebase') {
      this.updateSetting('syncMode', 'local');
    }
  }

  protected setSyncMode(mode: SyncSettings['syncMode']): void {
    if (mode === 'firebase') {
      if (!this.firebaseConfigReady() || !this.hasCloudAccess()) {
        return;
      }
    }

    this.updateSetting('syncMode', mode);
  }

  protected exportCsv(): void {
    this.store.exportCsv();
  }

  protected removeTransaction(id: string): void {
    this.store.removeTransaction(id);
  }

  protected setAuthMode(mode: 'signin' | 'register'): void {
    this.authMode.set(mode);
  }

  private consumeSharedCapture(): void {
    if (typeof window === 'undefined') {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const sharedText =
      params.get('capture') ??
      params.get('text') ??
      params.get('body') ??
      [params.get('title'), params.get('url')].filter(Boolean).join(' ').trim();

    if (!sharedText) {
      return;
    }

    this.captureText.set(sharedText);
    this.parseCapture();

    const cleanedUrl = `${window.location.origin}${window.location.pathname}${window.location.hash}`;
    window.history.replaceState({}, document.title, cleanedUrl);
  }
}
