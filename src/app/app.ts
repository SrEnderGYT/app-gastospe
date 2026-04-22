import { CommonModule, CurrencyPipe, DatePipe } from '@angular/common';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firebaseOptions } from './firebase/firebase.options';
import {
  SubscriptionItem,
  SyncSettings,
  SyncStatus,
  TransactionKind,
  UserProfile,
  WorkspaceView,
} from './models/finance.models';
import { FirebaseAuthService } from './services/firebase-auth.service';
import { FinanceStoreService } from './services/finance-store.service';

type AccessStep = 'auth' | 'profile' | 'workspace';
type CaptchaChallenge = { left: number; right: number };

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
  protected readonly profile = this.store.profile;
  protected readonly subscriptions = this.store.subscriptions;
  protected readonly online = this.store.online;
  protected readonly syncState = this.store.syncState;
  protected readonly cloudState = this.store.cloudState;
  protected readonly deletedTransactionIds = this.store.deletedTransactionIds;

  protected readonly captureText = signal('');
  protected readonly captureFeedback = signal('');
  protected readonly transactionSearch = signal('');
  protected readonly transactionStatusFilter = signal<'all' | SyncStatus>('all');
  protected readonly transactionKindFilter = signal<'all' | TransactionKind>('all');
  protected readonly activeView = signal<WorkspaceView>(this.profile().preferredView || 'overview');
  protected readonly subscriptionForm = signal(this.store.createSubscriptionDraft());
  protected readonly subscriptionFeedback = signal('');
  protected readonly authWallMessage = signal('');
  protected readonly captchaAnswer = signal('');
  protected readonly captchaChallenge = signal<CaptchaChallenge>(this.generateCaptcha());

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
  protected readonly authDni = signal('');
  protected readonly authPhone = signal('');

  protected readonly form = signal(this.store.createDraft());

  protected readonly workspaceNav = [
    {
      value: 'overview',
      label: 'Resumen',
      eyebrow: 'Control general',
      description: 'Balance, alertas, agenda y salud financiera.',
    },
    {
      value: 'add',
      label: 'Agregar',
      eyebrow: 'Registro diario',
      description: 'Carga gastos, ingresos o captura texto bancario.',
    },
    {
      value: 'subscriptions',
      label: 'Suscripciones',
      eyebrow: 'Pagos recurrentes',
      description: 'Vencimientos, autopago y costo mensual estimado.',
    },
    {
      value: 'automation',
      label: 'Automatizacion',
      eyebrow: 'Flujos cloud',
      description: 'Gmail, Firestore, sync y puente para automatizaciones.',
    },
    {
      value: 'profile',
      label: 'Perfil',
      eyebrow: 'Cuenta y ajustes',
      description: 'Datos personales, seguridad y preferencias.',
    },
  ] as const satisfies ReadonlyArray<{
    value: WorkspaceView;
    label: string;
    eyebrow: string;
    description: string;
  }>;

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
  protected readonly subscriptionCategories = [
    'Streaming',
    'Software',
    'Educacion',
    'Cloud',
    'Gimnasio',
    'Membresia',
    'Servicios',
    'Otro',
  ];
  protected readonly firebaseProjectId = firebaseOptions.projectId;

  protected readonly accessStep = computed<AccessStep>(() => {
    if (!this.isSignedIn()) {
      return 'auth';
    }

    return this.isProfileComplete(this.profile()) ? 'workspace' : 'profile';
  });

  protected readonly currentMonthLabel = computed(() =>
    new Intl.DateTimeFormat('es-PE', {
      month: 'long',
      year: 'numeric',
    }).format(new Date()),
  );

  protected readonly welcomeName = computed(
    () => this.profile().fullName || this.firebaseUserLabel() || 'tu tablero',
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
      .slice(0, 28);
  });

  protected readonly latestTransactions = computed(() => this.transactions().slice(0, 6));

  protected readonly activeSubscriptions = computed(() =>
    this.subscriptions().filter((item) => item.status === 'active'),
  );

  protected readonly upcomingSubscriptions = computed(() => {
    const today = new Date();
    const threshold = new Date();
    threshold.setDate(today.getDate() + 21);

    return this.activeSubscriptions()
      .filter((item) => {
        const billingDate = new Date(item.nextBillingDate);
        return billingDate >= startOfDay(today) && billingDate <= endOfDay(threshold);
      })
      .slice(0, 8);
  });

  protected readonly overdueSubscriptions = computed(() => {
    const today = startOfDay(new Date());
    return this.activeSubscriptions().filter((item) => new Date(item.nextBillingDate) < today);
  });

  protected readonly subscriptionSummary = computed(() => {
    const active = this.activeSubscriptions();
    const monthlyEquivalent = active.reduce((sum, item) => {
      const normalizedAmount = Number(item.amount) || 0;
      return sum + (item.cycle === 'annual' ? normalizedAmount / 12 : normalizedAmount);
    }, 0);

    return {
      active: active.length,
      paused: this.subscriptions().filter((item) => item.status === 'paused').length,
      monthlyEquivalent,
      upcoming: this.upcomingSubscriptions().length,
    };
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

    return 'Tu cuenta ya puede recibir movimientos automáticos desde Apps Script.';
  });

  protected readonly authTitle = computed(() =>
    this.authMode() === 'register' ? 'Crea tu acceso de equipo' : 'Ingresa a tu tablero financiero',
  );

  protected readonly authSubtitle = computed(() =>
    this.authMode() === 'register'
      ? 'Registra datos basicos, protege el acceso con captcha y deja listo tu espacio personal.'
      : 'Entra con correo o Google y continua con una experiencia más ordenada por secciones.',
  );

  protected readonly captchaPrompt = computed(
    () => `${this.captchaChallenge().left} + ${this.captchaChallenge().right}`,
  );

  protected readonly radarAlerts = computed(() => {
    const alerts: { title: string; detail: string }[] = [];

    if (this.totals().pending > 0) {
      alerts.push({
        title: 'Tienes pendientes de sync',
        detail: `${this.totals().pending} movimientos aun esperan salida cloud o sheet.`,
      });
    }

    if (this.overdueSubscriptions().length > 0) {
      alerts.push({
        title: 'Hay suscripciones vencidas',
        detail: `${this.overdueSubscriptions().length} cobros ya pasaron su fecha y conviene revisarlos.`,
      });
    }

    if (this.upcomingSubscriptions().length > 0) {
      alerts.push({
        title: 'Se vienen cobros recurrentes',
        detail: `${this.upcomingSubscriptions().length} suscripciones vencen en los proximos 21 dias.`,
      });
    }

    if (this.totals().expense > this.totals().income && this.currentMonthTransactions().length > 0) {
      alerts.push({
        title: 'Este mes vienes en negativo',
        detail: 'Los gastos del mes superan a los ingresos registrados hasta hoy.',
      });
    }

    if (!alerts.length) {
      alerts.push({
        title: 'Tablero estable',
        detail: 'No hay alertas criticas por ahora. Puedes enfocarte en automatizar más fuentes.',
      });
    }

    return alerts.slice(0, 4);
  });

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

    effect(() => {
      const preferred = this.profile().preferredView;

      if (preferred && preferred !== this.activeView()) {
        this.activeView.set(preferred);
      }
    });

    effect(() => {
      if (!this.isSignedIn()) {
        return;
      }

      if (!this.profile().fullName) {
        const fallbackName = this.firebaseUserLabel();

        if (fallbackName && fallbackName !== 'Sesion activa') {
          this.store.updateProfile({ fullName: fallbackName });
        }
      }
    });
  }

  protected setActiveView(view: WorkspaceView): void {
    this.activeView.set(view);
    this.store.updateProfile({ preferredView: view });
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

  protected updateProfileField<K extends keyof UserProfile>(key: K, value: UserProfile[K]): void {
    this.store.updateProfile({ [key]: value } as Partial<UserProfile>);
  }

  protected updateSubscriptionForm<K extends keyof ReturnType<FinanceStoreService['createSubscriptionDraft']>>(
    key: K,
    value: ReturnType<FinanceStoreService['createSubscriptionDraft']>[K],
  ): void {
    this.subscriptionForm.update((current) => ({ ...current, [key]: value }));
  }

  protected async signInWithGoogle(): Promise<void> {
    if (!this.ensureCaptchaSolved()) {
      return;
    }

    await this.firebaseAuthService.signIn();
    this.authWallMessage.set('');

    if (this.hasCloudAccess() && this.settings().syncMode === 'local') {
      this.updateSetting('syncMode', 'firebase');
    }
  }

  protected async submitEmailAuth(): Promise<void> {
    if (!this.ensureCaptchaSolved()) {
      return;
    }

    if (this.authMode() === 'register') {
      const profileMessage = this.validateProfile({
        fullName: this.authName(),
        dni: this.authDni(),
        phone: this.authPhone(),
        preferredView: 'overview',
      });

      if (profileMessage) {
        this.authWallMessage.set(profileMessage);
        return;
      }

      await this.firebaseAuthService.registerWithEmail(
        this.authName(),
        this.authEmail(),
        this.authPassword(),
      );

      if (this.isSignedIn()) {
        this.store.updateProfile({
          fullName: this.authName().trim(),
          dni: this.sanitizeDni(this.authDni()),
          phone: this.normalizePhone(this.authPhone()),
          preferredView: this.activeView(),
        });
        this.updateSetting('owner', this.authName().trim());
      }
    } else {
      await this.firebaseAuthService.signInWithEmail(this.authEmail(), this.authPassword());
    }

    this.authWallMessage.set('');

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
    this.refreshCaptcha();
    this.authWallMessage.set('');

    if (this.settings().syncMode === 'firebase') {
      this.updateSetting('syncMode', 'local');
    }
  }

  protected setSyncMode(mode: SyncSettings['syncMode']): void {
    if (mode === 'firebase' && (!this.firebaseConfigReady() || !this.hasCloudAccess())) {
      return;
    }

    this.updateSetting('syncMode', mode);
  }

  protected exportCsv(): void {
    this.store.exportCsv();
  }

  protected removeTransaction(id: string): void {
    this.store.removeTransaction(id);
  }

  protected addSubscription(): void {
    const draft = this.subscriptionForm();

    if (!draft.name.trim()) {
      this.subscriptionFeedback.set('Ponle nombre a la suscripcion antes de guardarla.');
      return;
    }

    if (!(Number(draft.amount) > 0)) {
      this.subscriptionFeedback.set('El monto de la suscripcion debe ser mayor a cero.');
      return;
    }

    this.store.addSubscription(draft);
    this.subscriptionForm.set(this.store.createSubscriptionDraft());
    this.subscriptionFeedback.set('Suscripcion agregada al calendario de cobros.');
  }

  protected removeSubscription(id: string): void {
    this.store.removeSubscription(id);
  }

  protected setAuthMode(mode: 'signin' | 'register'): void {
    this.authMode.set(mode);
    this.authWallMessage.set('');
  }

  protected refreshCaptcha(): void {
    this.captchaChallenge.set(this.generateCaptcha());
    this.captchaAnswer.set('');
  }

  protected completeProfileSetup(): void {
    const message = this.validateProfile(this.profile());

    if (message) {
      this.authWallMessage.set(message);
      return;
    }

    const name = this.profile().fullName.trim();

    if (!this.settings().owner || this.settings().owner === 'Mi tablero') {
      this.updateSetting('owner', name);
    }

    this.authWallMessage.set('');
    this.setActiveView(this.profile().preferredView || 'overview');
  }

  protected describeSubscriptionCadence(item: SubscriptionItem): string {
    return item.cycle === 'annual' ? 'Anual' : 'Mensual';
  }

  protected describeSubscriptionBilling(item: SubscriptionItem): string {
    const days = this.daysUntil(item.nextBillingDate);

    if (days < 0) {
      return `Vencida hace ${Math.abs(days)} dias`;
    }

    if (days === 0) {
      return 'Vence hoy';
    }

    if (days === 1) {
      return 'Vence mañana';
    }

    return `Vence en ${days} dias`;
  }

  protected describeSubscriptionStatus(item: SubscriptionItem): string {
    switch (item.status) {
      case 'active':
        return 'Activa';
      case 'paused':
        return 'Pausada';
      default:
        return 'Cancelada';
    }
  }

  protected badgeClassForSubscription(item: SubscriptionItem): string {
    switch (item.status) {
      case 'active':
        return 'ok';
      case 'paused':
        return 'warn';
      default:
        return 'muted';
    }
  }

  protected isCurrentView(view: WorkspaceView): boolean {
    return this.activeView() === view;
  }

  private ensureCaptchaSolved(): boolean {
    const expected = this.captchaChallenge().left + this.captchaChallenge().right;

    if (Number(this.captchaAnswer()) !== expected) {
      this.authWallMessage.set('Resuelve bien el captcha simple antes de continuar.');
      this.refreshCaptcha();
      return false;
    }

    return true;
  }

  private validateProfile(profile: UserProfile): string {
    if (!profile.fullName.trim()) {
      return 'Necesitamos tu nombre o alias para personalizar el tablero.';
    }

    if (!/^\d{8}$/.test(this.sanitizeDni(profile.dni))) {
      return 'El DNI debe tener 8 digitos.';
    }

    const phone = this.normalizePhone(profile.phone);

    if (!/^9\d{8}$/.test(phone)) {
      return 'El telefono debe ser un celular valido de 9 digitos.';
    }

    return '';
  }

  private isProfileComplete(profile: UserProfile): boolean {
    return !this.validateProfile(profile);
  }

  private sanitizeDni(value: string): string {
    return String(value || '').replace(/\D/g, '');
  }

  private normalizePhone(value: string): string {
    const digits = String(value || '').replace(/\D/g, '');

    if (digits.startsWith('51') && digits.length >= 11) {
      return digits.slice(2, 11);
    }

    return digits.slice(0, 9);
  }

  private generateCaptcha(): CaptchaChallenge {
    return {
      left: Math.floor(Math.random() * 8) + 2,
      right: Math.floor(Math.random() * 8) + 1,
    };
  }

  private daysUntil(date: string): number {
    const target = startOfDay(new Date(date));
    const now = startOfDay(new Date());
    const diffMs = target.getTime() - now.getTime();
    return Math.round(diffMs / 86400000);
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

function startOfDay(date: Date): Date {
  const normalized = new Date(date);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
}

function endOfDay(date: Date): Date {
  const normalized = new Date(date);
  normalized.setHours(23, 59, 59, 999);
  return normalized;
}
