import { CommonModule, CurrencyPipe, DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FinanceStoreService } from './services/finance-store.service';

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule, CurrencyPipe, DatePipe],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly store = inject(FinanceStoreService);

  protected readonly transactions = this.store.transactions;
  protected readonly settings = this.store.settings;
  protected readonly online = this.store.online;
  protected readonly syncState = this.store.syncState;
  protected readonly captureText = signal('');
  protected readonly captureFeedback = signal('');

  protected readonly form = signal(this.store.createDraft());

  protected readonly currentMonthLabel = computed(() =>
    new Intl.DateTimeFormat('es-PE', {
      month: 'long',
      year: 'numeric',
    }).format(new Date()),
  );

  protected readonly totals = computed(() => {
    const monthKey = new Date().toISOString().slice(0, 7);
    const currentMonth = this.transactions().filter((item) => item.date.startsWith(monthKey));
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
    const monthKey = new Date().toISOString().slice(0, 7);
    const totalsByCategory = new Map<string, number>();

    for (const item of this.transactions()) {
      if (!item.date.startsWith(monthKey) || item.kind !== 'expense') {
        continue;
      }

      const current = totalsByCategory.get(item.category) ?? 0;
      totalsByCategory.set(item.category, current + item.amount);
    }

    return [...totalsByCategory.entries()]
      .map(([category, total]) => ({ category, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);
  });

  protected readonly recentTransactions = computed(() =>
    [...this.transactions()]
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 8),
  );

  protected readonly syncTargetLabel = computed(() => {
    const mode = this.settings().syncMode;
    if (mode === 'sheet') {
      return 'Google Sheets por webhook';
    }
    if (mode === 'firebase') {
      return 'Firebase Function / endpoint';
    }
    return 'Solo local';
  });

  protected readonly quickModes = [
    { label: 'Gasto', value: 'expense' },
    { label: 'Ingreso', value: 'income' },
  ] as const;

  protected readonly categories = [
    'Comida',
    'Casa',
    'Transporte',
    'Suscripciones',
    'Salud',
    'Compras',
    'Servicios',
    'Ingreso',
    'Otros',
  ];

  protected readonly accountOptions = ['Tarjeta', 'Transferencia', 'Efectivo', 'Yape/Plin', 'Otro'];

  protected submitTransaction(): void {
    this.store.addTransaction(this.form());
    this.form.set(this.store.createDraft());
    this.captureFeedback.set('Movimiento guardado localmente y listo para sincronizar.');
  }

  protected parseCapture(): void {
    const value = this.captureText().trim();

    if (!value) {
      this.captureFeedback.set('Pega primero un texto de WhatsApp o una notificacion.');
      return;
    }

    const parsed = this.store.parseCapturedText(value);
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
    this.captureFeedback.set('Texto interpretado. Revisa los campos y guarda.');
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

  protected updateSetting<K extends keyof ReturnType<FinanceStoreService['defaultSettings']>>(
    key: K,
    value: ReturnType<FinanceStoreService['defaultSettings']>[K],
  ): void {
    this.store.updateSettings({ [key]: value } as Partial<ReturnType<FinanceStoreService['defaultSettings']>>);
  }

  protected exportCsv(): void {
    this.store.exportCsv();
  }

  protected removeTransaction(id: string): void {
    this.store.removeTransaction(id);
  }
}
