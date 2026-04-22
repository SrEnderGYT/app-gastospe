export type TransactionKind = 'expense' | 'income';
export type CaptureSource = 'manual' | 'notification' | 'whatsapp';
export type SyncMode = 'local' | 'sheet' | 'firebase';
export type SyncStatus = 'pending' | 'synced' | 'failed';

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
