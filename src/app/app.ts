import { CommonModule, CurrencyPipe, DatePipe } from '@angular/common';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firebaseOptions } from './firebase/firebase.options';
import {
  SubscriptionItem,
  SyncSettings,
  SyncStatus,
  ThemePreference,
  Transaction,
  TransactionDraft,
  TransactionKind,
  UserProfile,
  WorkspaceView,
} from './models/finance.models';
import { FirebaseAuthService } from './services/firebase-auth.service';
import { FinanceStoreService } from './services/finance-store.service';

type AccessStep = 'auth' | 'profile' | 'workspace';
type CaptchaGlyph = { char: string; rotate: number; offset: number; scale: number };
type CaptchaChallenge = { value: string; glyphs: CaptchaGlyph[] };

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule, CurrencyPipe, DatePipe],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly store = inject(FinanceStoreService);
  private readonly firebaseAuthService = inject(FirebaseAuthService);
  private lastKnownCloudState: boolean | null = null;

  protected readonly transactions = this.store.transactions;
  protected readonly settings = this.store.settings;
  protected readonly profile = this.store.profile;
  protected readonly subscriptions = this.store.subscriptions;
  protected readonly online = this.store.online;
  protected readonly syncState = this.store.syncState;
  protected readonly cloudState = this.store.cloudState;

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
  protected readonly firebaseAutomationUrl = this.firebaseAuthService.automationFunctionUrl;

  protected readonly authMode = signal<'signin' | 'register'>('signin');
  protected readonly authEmail = signal('');
  protected readonly authPassword = signal('');
  protected readonly authMessage = signal('');
  protected readonly captchaInput = signal('');
  protected readonly captchaChallenge = signal<CaptchaChallenge>(this.createCaptchaChallenge());
  protected readonly onboardingStayOpen = signal(false);
  protected readonly captureText = signal('');
  protected readonly captureFeedback = signal('');
  protected readonly subscriptionFeedback = signal('');
  protected readonly profileMessage = signal('');
  protected readonly activeView = signal<WorkspaceView>(this.profile().preferredView || 'overview');
  protected readonly form = signal(this.store.createDraft());
  protected readonly subscriptionForm = signal(this.store.createSubscriptionDraft());

  protected readonly workspaceNav = [
    { value: 'overview', label: 'Resumen' },
    { value: 'add', label: 'Agregar' },
    { value: 'subscriptions', label: 'Suscripciones' },
    { value: 'automation', label: 'Automatizacion' },
    { value: 'profile', label: 'Perfil' },
  ] as const satisfies ReadonlyArray<{ value: WorkspaceView; label: string }>;

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

    if (!this.profile().onboardingCompleted || this.onboardingStayOpen()) {
      return 'profile';
    }

    return 'workspace';
  });

  protected readonly authTitle = computed(() =>
    this.authMode() === 'register' ? 'Crear cuenta' : 'Entrar',
  );

  protected readonly authPrimaryLabel = computed(() =>
    this.authMode() === 'register' ? 'Crear con correo' : 'Entrar con correo',
  );

  protected readonly authBannerText = computed(() => this.authMessage() || this.firebaseAuthError());

  protected readonly authBannerIsError = computed(() =>
    Boolean(this.authMessage() || this.firebaseAuthError()),
  );

  protected readonly profileBannerText = computed(
    () => this.profileMessage() || this.firebaseAuthError(),
  );

  protected readonly profileBannerIsError = computed(() =>
    Boolean(this.profileMessage() || this.firebaseAuthError()),
  );

  protected readonly activeViewMeta = computed(
    () => this.workspaceNav.find((item) => item.value === this.activeView()) || this.workspaceNav[0],
  );
  protected readonly currentTheme = computed<ThemePreference>(() => this.profile().theme || 'light');

  protected readonly welcomeName = computed(
    () => this.profile().fullName || this.firebaseUserLabel() || 'Tu espacio',
  );

  protected readonly currentMonthLabel = computed(() =>
    new Intl.DateTimeFormat('es-PE', { month: 'long', year: 'numeric' }).format(new Date()),
  );

  protected readonly currentMonthTransactions = computed(() => {
    const monthKey = new Date().toISOString().slice(0, 7);
    return this.transactions().filter((item) => item.date.startsWith(monthKey));
  });

  protected readonly totals = computed(() => {
    const monthItems = this.currentMonthTransactions();
    const income = monthItems
      .filter((item) => item.kind === 'income')
      .reduce((sum, item) => sum + item.amount, 0);
    const expense = monthItems
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

      totalsByCategory.set(item.category, (totalsByCategory.get(item.category) ?? 0) + item.amount);
    }

    return [...totalsByCategory.entries()]
      .map(([category, total]) => ({ category, total }))
      .sort((left, right) => right.total - left.total)
      .slice(0, 5);
  });

  protected readonly latestTransactions = computed(() => this.transactions().slice(0, 8));

  protected readonly categoryChartArcs = computed(() => {
    const breakdown = this.categoryBreakdown();
    const total = breakdown.reduce((sum, item) => sum + item.total, 0);

    if (!total || !breakdown.length) {
      return [];
    }

    const palette = ['#3b82f6', '#34d399', '#fbbf24', '#a78bfa', '#f87171'];
    let cumulativeDeg = -90;

    return breakdown.map((item, index) => {
      const fraction = item.total / total;
      const spanDeg = Math.min(fraction * 360, 359.99);
      const startDeg = cumulativeDeg;
      cumulativeDeg += spanDeg;

      return {
        category: item.category,
        total: item.total,
        color: palette[index % palette.length],
        percentage: Math.round(fraction * 100),
        path: this.buildDonutPath(50, 50, 42, 26, startDeg, cumulativeDeg),
      };
    });
  });

  protected readonly monthlyRunRate = computed(() => {
    const today = new Date();
    const dayOfMonth = Math.max(today.getDate(), 1);
    const monthDays = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    return dayOfMonth ? (this.totals().expense / dayOfMonth) * monthDays : this.totals().expense;
  });

  protected readonly trend = computed(() => this.buildTrend(this.currentMonthTransactions()));

  protected readonly activeSubscriptions = computed(() =>
    this.subscriptions().filter((item) => item.status === 'active'),
  );

  protected readonly upcomingSubscriptions = computed(() => {
    const today = startOfDay(new Date());
    const limit = startOfDay(new Date());
    limit.setDate(limit.getDate() + 21);

    return this.activeSubscriptions()
      .filter((item) => {
        const billingDate = startOfDay(new Date(item.nextBillingDate));
        return billingDate >= today && billingDate <= limit;
      })
      .slice(0, 6);
  });

  protected readonly subscriptionSummary = computed(() => {
    const active = this.activeSubscriptions();
    const monthlyEquivalent = active.reduce((sum, item) => {
      const amount = Number(item.amount) || 0;
      return sum + (item.cycle === 'annual' ? amount / 12 : amount);
    }, 0);

    return {
      active: active.length,
      paused: this.subscriptions().filter((item) => item.status === 'paused').length,
      monthlyEquivalent,
      nextCount: this.upcomingSubscriptions().length,
    };
  });

  protected readonly automationStatus = computed(() => {
    if (!this.firebaseConfigReady()) {
      return 'Configura Firebase';
    }

    if (!this.isSignedIn()) {
      return 'Inicia sesion';
    }

    if (!this.hasCloudAccess()) {
      return 'Verifica tu correo';
    }

    return 'Listo para Gmail';
  });

  protected readonly cloudSummary = computed(() => {
    if (!this.firebaseConfigReady()) {
      return 'Sin Firebase';
    }

    if (!this.isSignedIn()) {
      return 'Cuenta cerrada';
    }

    if (!this.hasCloudAccess()) {
      return 'Falta verificacion';
    }

    return 'Cloud activo';
  });

  protected readonly syncModeLabel = computed(() => {
    switch (this.settings().syncMode) {
      case 'firebase':
        return 'Firestore';
      case 'sheet':
        return 'Sheets';
      default:
        return 'Local';
    }
  });

  protected readonly automationItems = computed(() => [
    { label: 'Cloud', value: this.cloudSummary() },
    { label: 'Gmail', value: this.automationStatus() },
    { label: 'Sync', value: this.syncModeLabel() },
    { label: 'Cuenta', value: this.formatIdentifier(this.firebaseUserId()) || 'Pendiente' },
  ]);

  constructor() {
    this.consumeSharedCapture();

    effect(() => {
      if (!this.isSignedIn()) {
        this.onboardingStayOpen.set(false);
      }
    });

    effect(() => {
      if (this.authLoading()) {
        return;
      }

      const hasCloudAccess = this.hasCloudAccess();
      const currentMode = this.settings().syncMode;

      if (this.lastKnownCloudState === null) {
        this.lastKnownCloudState = hasCloudAccess;

        if (hasCloudAccess && currentMode === 'local') {
          this.updateSetting('syncMode', 'firebase');
        }

        return;
      }

      if (this.lastKnownCloudState === hasCloudAccess) {
        return;
      }

      this.lastKnownCloudState = hasCloudAccess;

      if (!hasCloudAccess && currentMode === 'firebase') {
        this.updateSetting('syncMode', 'local');
      } else if (hasCloudAccess && currentMode === 'local') {
        this.updateSetting('syncMode', 'firebase');
      }
    });

    effect(() => {
      const preferredView = this.profile().preferredView;

      if (preferredView && preferredView !== this.activeView()) {
        this.activeView.set(preferredView);
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

    effect(() => {
      if (typeof document === 'undefined') {
        return;
      }

      const theme = this.currentTheme();
      document.documentElement.dataset['theme'] = theme;
      document.documentElement.style.colorScheme = theme;
    });
  }

  protected setAuthMode(mode: 'signin' | 'register'): void {
    this.authMode.set(mode);
    this.authMessage.set('');
    this.refreshCaptcha();
  }

  protected async signInWithGoogle(): Promise<void> {
    this.authMessage.set('');
    await this.firebaseAuthService.signIn();
  }

  protected async submitEmailAuth(): Promise<void> {
    if (!this.ensureEmailCaptchaSolved()) {
      return;
    }

    if (this.authMode() === 'register') {
      await this.firebaseAuthService.registerWithEmail('', this.authEmail(), this.authPassword());
    } else {
      await this.firebaseAuthService.signInWithEmail(this.authEmail(), this.authPassword());
    }

    if (!this.firebaseAuthError()) {
      this.authMessage.set('');
    }
  }

  protected async sendVerificationEmail(): Promise<void> {
    await this.firebaseAuthService.resendVerificationEmail();
  }

  protected async refreshVerificationState(): Promise<void> {
    await this.firebaseAuthService.refreshUser();
  }

  protected async sendPasswordReset(): Promise<void> {
    await this.firebaseAuthService.sendPasswordReset(this.authEmail() || this.firebaseUserEmail());
  }

  protected async signOutFromFirebase(): Promise<void> {
    await this.firebaseAuthService.signOut();
    this.refreshCaptcha();
    this.authMessage.set('');
    this.profileMessage.set('');

    if (this.settings().syncMode === 'firebase') {
      this.updateSetting('syncMode', 'local');
    }
  }

  protected refreshCaptcha(): void {
    this.captchaChallenge.set(this.createCaptchaChallenge());
    this.captchaInput.set('');
  }

  protected setTheme(theme: ThemePreference): void {
    this.store.updateProfile({ theme });
  }

  protected setActiveView(view: WorkspaceView): void {
    this.activeView.set(view);
    this.store.updateProfile({ preferredView: view });
  }

  protected submitTransaction(): void {
    this.store.addTransaction(this.form());
    this.form.set(this.store.createDraft());
    this.captureFeedback.set('');
  }

  protected parseCapture(): void {
    const value = this.captureText().trim();

    if (!value) {
      this.captureFeedback.set('Pega un texto primero.');
      return;
    }

    const parsed = this.store.parseCapturedText(value);

    if (!parsed) {
      this.captureFeedback.set('No pude convertir ese texto en movimiento.');
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
    this.captureFeedback.set('');
  }

  protected async syncNow(): Promise<void> {
    await this.store.syncPendingTransactions();
  }

  protected updateForm<K extends keyof TransactionDraft>(key: K, value: TransactionDraft[K]): void {
    this.form.update((current) => ({ ...current, [key]: value }));
  }

  protected updateSetting<K extends keyof SyncSettings>(key: K, value: SyncSettings[K]): void {
    this.store.updateSettings({ [key]: value } as Partial<SyncSettings>);
  }

  protected updateProfileField<K extends keyof UserProfile>(key: K, value: UserProfile[K]): void {
    this.store.updateProfile({ [key]: value } as Partial<UserProfile>);
  }

  protected updateSubscriptionForm<
    K extends keyof ReturnType<FinanceStoreService['createSubscriptionDraft']>,
  >(
    key: K,
    value: ReturnType<FinanceStoreService['createSubscriptionDraft']>[K],
  ): void {
    this.subscriptionForm.update((current) => ({ ...current, [key]: value }));
  }

  protected addSubscription(): void {
    const draft = this.subscriptionForm();

    if (!draft.name.trim()) {
      this.subscriptionFeedback.set('Agrega un nombre.');
      return;
    }

    if (!(Number(draft.amount) > 0)) {
      this.subscriptionFeedback.set('El monto debe ser mayor a cero.');
      return;
    }

    this.store.addSubscription(draft);
    this.subscriptionForm.set(this.store.createSubscriptionDraft());
    this.subscriptionFeedback.set('');
  }

  protected removeSubscription(id: string): void {
    this.store.removeSubscription(id);
  }

  protected removeTransaction(id: string): void {
    this.store.removeTransaction(id);
  }

  protected exportCsv(): void {
    this.store.exportCsv();
  }

  protected setSyncMode(mode: SyncSettings['syncMode']): void {
    if (mode === 'firebase' && (!this.firebaseConfigReady() || !this.hasCloudAccess())) {
      return;
    }

    this.updateSetting('syncMode', mode);
  }

  protected async copyToClipboard(value: string): Promise<void> {
    if (!value || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard support depends on browser permissions.
    }
  }

  protected saveInitialProfile(): void {
    const validationMessage = this.validateProfileDraft(this.profile());

    if (validationMessage) {
      this.profileMessage.set(validationMessage);
      return;
    }

    this.store.updateProfile({
      fullName: this.profile().fullName.trim(),
      dni: this.sanitizeDni(this.profile().dni),
      phone: this.normalizePhone(this.profile().phone),
      preferredView: this.profile().preferredView || 'overview',
      onboardingCompleted: true,
    });

    if (!this.settings().owner || this.settings().owner === 'Mi tablero') {
      this.updateSetting('owner', this.profile().fullName.trim());
    }

    this.onboardingStayOpen.set(true);
    this.profileMessage.set('');
  }

  protected enterWorkspaceAfterSetup(): void {
    if (!this.profile().onboardingCompleted) {
      this.profileMessage.set('Primero guarda tus datos.');
      return;
    }

    this.onboardingStayOpen.set(false);
    this.profileMessage.set('');
    this.setActiveView(this.profile().preferredView || 'overview');
  }

  protected saveProfileChanges(): void {
    const validationMessage = this.validateProfileDraft(this.profile(), false);

    if (validationMessage) {
      this.profileMessage.set(validationMessage);
      return;
    }

    this.store.updateProfile({
      fullName: this.profile().fullName.trim(),
      dni: this.sanitizeDni(this.profile().dni),
      phone: this.normalizePhone(this.profile().phone),
      preferredView: this.profile().preferredView || 'overview',
      onboardingCompleted: true,
    });

    this.profileMessage.set('');
  }

  protected describeSubscriptionCadence(item: SubscriptionItem): string {
    return item.cycle === 'annual' ? 'Anual' : 'Mensual';
  }

  protected describeSubscriptionBilling(item: SubscriptionItem): string {
    const days = this.daysUntil(item.nextBillingDate);

    if (days < 0) {
      return `Hace ${Math.abs(days)} d`;
    }

    if (days === 0) {
      return 'Hoy';
    }

    if (days === 1) {
      return 'Manana';
    }

    return `${days} dias`;
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

  protected syncTone(): string {
    if (this.settings().syncMode === 'firebase' && this.hasCloudAccess()) {
      return 'ok';
    }

    if (this.settings().syncMode === 'sheet') {
      return 'warn';
    }

    return 'neutral';
  }

  protected cloudTone(): string {
    if (!this.firebaseConfigReady()) {
      return 'warn';
    }

    if (this.hasCloudAccess()) {
      return 'ok';
    }

    if (this.isSignedIn()) {
      return 'warn';
    }

    return 'neutral';
  }

  private ensureEmailCaptchaSolved(): boolean {
    if (this.captchaInput().trim().toUpperCase() !== this.captchaChallenge().value) {
      this.authMessage.set('Captcha incorrecto.');
      this.refreshCaptcha();
      return false;
    }

    return true;
  }

  private validateProfileDraft(profile: UserProfile, allowPartial = false): string {
    const fullName = profile.fullName.trim();
    const dni = this.sanitizeDni(profile.dni);
    const phone = this.normalizePhone(profile.phone);

    if (!allowPartial || fullName) {
      if (!fullName) {
        return 'Completa tu nombre.';
      }
    }

    if (!allowPartial || dni) {
      if (!/^\d{8}$/.test(dni)) {
        return 'El DNI debe tener 8 digitos.';
      }
    }

    if (!allowPartial || phone) {
      if (!/^9\d{8}$/.test(phone)) {
        return 'Ingresa un celular valido.';
      }
    }

    return '';
  }

  private sanitizeDni(value: string): string {
    return String(value || '').replace(/\D/g, '').slice(0, 8);
  }

  private normalizePhone(value: string): string {
    const digits = String(value || '').replace(/\D/g, '');

    if (digits.startsWith('51') && digits.length >= 11) {
      return digits.slice(2, 11);
    }

    return digits.slice(0, 9);
  }

  private createCaptchaChallenge(): CaptchaChallenge {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let value = '';

    for (let index = 0; index < 5; index += 1) {
      value += alphabet[Math.floor(Math.random() * alphabet.length)];
    }

    return {
      value,
      glyphs: [...value].map((char, index) => ({
        char,
        rotate: (Math.random() * 20 - 10) * (index % 2 === 0 ? 1 : -1),
        offset: Math.random() * 6 - 3,
        scale: 0.92 + Math.random() * 0.18,
      })),
    };
  }

  private formatIdentifier(value: string): string {
    const normalized = String(value || '').trim();

    if (!normalized) {
      return '';
    }

    if (normalized.length <= 16) {
      return normalized;
    }

    return `${normalized.slice(0, 8)}...${normalized.slice(-6)}`;
  }

  private daysUntil(date: string): number {
    const target = startOfDay(new Date(date));
    const today = startOfDay(new Date());
    return Math.round((target.getTime() - today.getTime()) / 86400000);
  }

  private buildTrend(items: Transaction[]): { points: string; labels: string[]; total: number } {
    const labels: string[] = [];
    const values: number[] = [];
    const today = startOfDay(new Date());

    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = new Date(today);
      date.setDate(today.getDate() - offset);
      const key = date.toISOString().slice(0, 10);
      labels.push(
        new Intl.DateTimeFormat('es-PE', { weekday: 'short' })
          .format(date)
          .replace('.', '')
          .toUpperCase(),
      );

      const dayTotal = items.reduce((sum, item) => {
        if (item.date !== key) {
          return sum;
        }

        return sum + (item.kind === 'income' ? item.amount : -item.amount);
      }, 0);

      values.push(dayTotal);
    }

    const min = Math.min(...values, 0);
    const max = Math.max(...values, 0);
    const range = Math.max(max - min, 1);

    const points = values
      .map((value, index) => {
        const x = (index / Math.max(values.length - 1, 1)) * 100;
        const y = 84 - ((value - min) / range) * 66;
        return `${x},${y}`;
      })
      .join(' ');

    return {
      points,
      labels,
      total: values.reduce((sum, value) => sum + value, 0),
    };
  }

  private buildDonutPath(cx: number, cy: number, outerR: number, innerR: number, startDeg: number, endDeg: number): string {
    const rad = (d: number) => (d * Math.PI) / 180;
    const pt = (r: number, d: number) => ({ x: cx + r * Math.cos(rad(d)), y: cy + r * Math.sin(rad(d)) });
    const o1 = pt(outerR, startDeg);
    const o2 = pt(outerR, endDeg);
    const i1 = pt(innerR, startDeg);
    const i2 = pt(innerR, endDeg);
    const large = endDeg - startDeg > 180 ? 1 : 0;
    const f = (n: number) => n.toFixed(3);
    return `M ${f(o1.x)} ${f(o1.y)} A ${outerR} ${outerR} 0 ${large} 1 ${f(o2.x)} ${f(o2.y)} L ${f(i2.x)} ${f(i2.y)} A ${innerR} ${innerR} 0 ${large} 0 ${f(i1.x)} ${f(i1.y)} Z`;
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
