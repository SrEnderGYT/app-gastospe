export type TransactionKind = 'expense' | 'income';
export type CaptureSource = 'manual' | 'notification' | 'whatsapp' | 'gmail';
export type SyncMode = 'local' | 'sheet' | 'firebase';
export type SyncStatus = 'pending' | 'synced' | 'failed';
export type WorkspaceView = 'overview' | 'add' | 'subscriptions' | 'automation' | 'profile';
export type SubscriptionStatus = 'active' | 'paused' | 'cancelled';
export type SubscriptionCycle = 'monthly' | 'annual';

export interface TransactionDraft {
  kind: TransactionKind;
  title: string;
  amount: number;
  category: string;
  date: string;
  account: string;
  note: string;
  source: CaptureSource;
  rawText?: string;
}

export interface Transaction extends TransactionDraft {
  id: string;
  createdAt: string;
  syncStatus: SyncStatus;
  syncMessage?: string;
  owner?: string;
  syncMode?: SyncMode;
  exportedAt?: string;
  syncedAt?: string;
  uid?: string;
}

export interface SyncSettings {
  owner: string;
  currency: string;
  syncMode: SyncMode;
  autoSync: boolean;
  sheetWebhookUrl: string;
}

export interface SyncPayload {
  source: 'gastospe-web';
  exportedAt: string;
  owner: string;
  syncMode: SyncMode;
  transactions: Transaction[];
}

export interface SyncResult {
  success: boolean;
  message: string;
}

export interface ParsedCapture {
  title: string;
  amount: number | null;
  kind: TransactionKind;
  category: string;
  account: string;
  note: string;
  source: CaptureSource;
  date: string;
  rawText: string;
}

export interface UserProfile {
  fullName: string;
  dni: string;
  phone: string;
  preferredView: WorkspaceView;
  onboardingCompleted: boolean;
}

export interface SubscriptionDraft {
  name: string;
  amount: number;
  cycle: SubscriptionCycle;
  nextBillingDate: string;
  provider: string;
  category: string;
  status: SubscriptionStatus;
  note: string;
  autopay: boolean;
}

export interface SubscriptionItem extends SubscriptionDraft {
  id: string;
  createdAt: string;
}
