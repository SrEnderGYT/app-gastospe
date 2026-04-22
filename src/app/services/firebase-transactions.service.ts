import { Injectable, inject } from '@angular/core';
import {
  Unsubscribe,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  writeBatch,
} from 'firebase/firestore';
import { SyncPayload, SyncResult, Transaction } from '../models/finance.models';
import { FirebaseAuthService } from './firebase-auth.service';
import { FirebasePlatformService } from './firebase-platform.service';

@Injectable({ providedIn: 'root' })
export class FirebaseTransactionsService {
  private readonly firebasePlatform = inject(FirebasePlatformService);
  private readonly firebaseAuth = inject(FirebaseAuthService);

  watchTransactions(
    onNext: (transactions: Transaction[]) => void,
    onError: (message: string) => void,
  ): Unsubscribe | null {
    const firestore = this.firebasePlatform.firestore;
    const uid = this.firebaseAuth.uid();

    if (!firestore || !uid || !this.firebaseAuth.hasCloudAccess()) {
      return null;
    }

    const transactionsRef = collection(firestore, `users/${uid}/transactions`);
    const transactionsQuery = query(transactionsRef, orderBy('date', 'desc'));

    return onSnapshot(
      transactionsQuery,
      (snapshot) => {
        const items = snapshot.docs.map((item) => this.normalizeTransaction(item.id, item.data()));
        onNext(items);
      },
      (error) => {
        onError(error instanceof Error ? error.message : 'No se pudo leer Firestore.');
      },
    );
  }

  async syncTransactions(payload: SyncPayload): Promise<SyncResult> {
    const firestore = this.firebasePlatform.firestore;
    const uid = this.firebaseAuth.uid();

    if (!firestore || !uid || !this.firebaseAuth.hasCloudAccess()) {
      return {
        success: false,
        message: 'Verifica tu cuenta para sincronizar con Firestore.',
      };
    }

    const syncedAt = new Date().toISOString();

    try {
      for (const chunk of this.chunk(payload.transactions, 400)) {
        const batch = writeBatch(firestore);

        for (const transaction of chunk) {
          const ref = doc(firestore, `users/${uid}/transactions/${transaction.id}`);

          batch.set(
            ref,
            {
              ...transaction,
              title: transaction.title.trim() || 'Movimiento sin titulo',
              amount: Number(transaction.amount),
              note: transaction.note || '',
              rawText: transaction.rawText || '',
              source: transaction.source || 'manual',
              syncStatus: 'synced',
              syncMessage: 'Sincronizado con Firestore.',
              owner: payload.owner,
              syncMode: 'firebase',
              exportedAt: payload.exportedAt,
              syncedAt,
              uid,
            },
            { merge: true },
          );
        }

        await batch.commit();
      }

      return {
        success: true,
        message: 'Movimientos enviados a Firestore.',
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'No se pudo sincronizar con Firestore.',
      };
    }
  }

  async deleteTransactions(ids: string[]): Promise<SyncResult> {
    const firestore = this.firebasePlatform.firestore;
    const uid = this.firebaseAuth.uid();

    if (!firestore || !uid || !this.firebaseAuth.hasCloudAccess()) {
      return {
        success: false,
        message: 'Verifica tu cuenta para eliminar en Firestore.',
      };
    }

    try {
      for (const chunk of this.chunk(ids, 400)) {
        const batch = writeBatch(firestore);

        for (const id of chunk) {
          batch.delete(doc(firestore, `users/${uid}/transactions/${id}`));
        }

        await batch.commit();
      }

      return {
        success: true,
        message: 'Eliminaciones aplicadas en Firestore.',
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'No se pudo eliminar en Firestore.',
      };
    }
  }

  private normalizeTransaction(id: string, payload: Record<string, unknown>): Transaction {
    return {
      id,
      kind: payload['kind'] === 'income' ? 'income' : 'expense',
      title: typeof payload['title'] === 'string' ? payload['title'] : 'Movimiento sin titulo',
      amount: Number(payload['amount'] ?? 0),
      category: typeof payload['category'] === 'string' ? payload['category'] : 'Otros',
      date:
        typeof payload['date'] === 'string'
          ? payload['date']
          : new Date().toISOString().slice(0, 10),
      account: typeof payload['account'] === 'string' ? payload['account'] : 'Otro',
      note: typeof payload['note'] === 'string' ? payload['note'] : '',
      source:
        payload['source'] === 'gmail'
          ? 'gmail'
          : payload['source'] === 'whatsapp'
            ? 'whatsapp'
            : payload['source'] === 'notification'
              ? 'notification'
              : 'manual',
      rawText: typeof payload['rawText'] === 'string' ? payload['rawText'] : '',
      createdAt:
        typeof payload['createdAt'] === 'string'
          ? payload['createdAt']
          : new Date().toISOString(),
      syncStatus:
        payload['syncStatus'] === 'failed'
          ? 'failed'
          : payload['syncStatus'] === 'pending'
            ? 'pending'
            : 'synced',
      syncMessage:
        typeof payload['syncMessage'] === 'string'
          ? payload['syncMessage']
          : 'Sincronizado con Firestore.',
      owner: typeof payload['owner'] === 'string' ? payload['owner'] : undefined,
      syncMode: payload['syncMode'] === 'sheet' ? 'sheet' : 'firebase',
      exportedAt: typeof payload['exportedAt'] === 'string' ? payload['exportedAt'] : undefined,
      syncedAt: typeof payload['syncedAt'] === 'string' ? payload['syncedAt'] : undefined,
      uid: typeof payload['uid'] === 'string' ? payload['uid'] : undefined,
    };
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const groups: T[][] = [];

    for (let index = 0; index < items.length; index += size) {
      groups.push(items.slice(index, index + size));
    }

    return groups;
  }
}
