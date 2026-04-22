import { Injectable, signal } from '@angular/core';
import { FirebaseApp, getApp, getApps, initializeApp } from 'firebase/app';
import { Auth, getAuth } from 'firebase/auth';
import {
  Firestore,
  getFirestore,
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';
import { firebaseConfigReady, firebaseOptions } from '../firebase/firebase.options';

@Injectable({ providedIn: 'root' })
export class FirebasePlatformService {
  readonly configReady = signal(firebaseConfigReady);
  readonly platformMessage = signal(
    firebaseConfigReady ? 'Firebase listo.' : 'Completa la Web App de Firebase para activar la nube.',
  );
  private readonly appInstance = firebaseConfigReady ? this.initApp() : null;
  private readonly authInstance = this.appInstance ? getAuth(this.appInstance) : null;
  private readonly firestoreInstance = this.appInstance ? this.initFirestore(this.appInstance) : null;

  get app(): FirebaseApp | null {
    return this.appInstance;
  }

  get auth(): Auth | null {
    return this.authInstance;
  }

  get firestore(): Firestore | null {
    return this.firestoreInstance;
  }

  private initApp(): FirebaseApp {
    const config = {
      apiKey: firebaseOptions.apiKey,
      authDomain: firebaseOptions.authDomain,
      projectId: firebaseOptions.projectId,
      storageBucket: firebaseOptions.storageBucket,
      messagingSenderId: firebaseOptions.messagingSenderId,
      appId: firebaseOptions.appId,
    };

    return getApps().length ? getApp() : initializeApp(config);
  }

  private initFirestore(app: FirebaseApp): Firestore {
    try {
      return initializeFirestore(app, {
        ignoreUndefinedProperties: true,
        localCache:
          typeof window !== 'undefined' && typeof indexedDB !== 'undefined'
            ? persistentLocalCache({
                tabManager: persistentMultipleTabManager(),
              })
            : memoryLocalCache(),
      });
    } catch (error) {
      this.platformMessage.set(
        error instanceof Error
          ? `Firestore uso cache simple: ${error.message}`
          : 'Firestore uso cache simple por compatibilidad del navegador.',
      );

      try {
        return getFirestore(app);
      } catch {
        return initializeFirestore(app, {
          ignoreUndefinedProperties: true,
          localCache: memoryLocalCache(),
        });
      }
    }
  }
}
