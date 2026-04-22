import { computed, Injectable, signal } from '@angular/core';
import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from 'firebase/auth';
import { firebaseConfigReady, firebaseOptions } from '../firebase/firebase.options';

@Injectable({ providedIn: 'root' })
export class FirebaseAuthService {
  private readonly app = firebaseConfigReady
    ? initializeApp({
        apiKey: firebaseOptions.apiKey,
        authDomain: firebaseOptions.authDomain,
        projectId: firebaseOptions.projectId,
        storageBucket: firebaseOptions.storageBucket,
        messagingSenderId: firebaseOptions.messagingSenderId,
        appId: firebaseOptions.appId,
      })
    : null;

  private readonly auth = this.app ? getAuth(this.app) : null;

  readonly configReady = signal(firebaseConfigReady);
  readonly loading = signal(firebaseConfigReady);
  readonly user = signal<User | null>(null);
  readonly error = signal(
    firebaseConfigReady
      ? ''
      : 'Completa src/app/firebase/firebase.options.ts con la configuracion Web App de Firebase.',
  );

  readonly isSignedIn = computed(() => Boolean(this.user()));
  readonly canSync = computed(() => this.configReady() && this.isSignedIn());
  readonly displayName = computed(() => this.user()?.displayName || this.user()?.email || 'Sesion activa');
  readonly email = computed(() => this.user()?.email || '');
  readonly functionUrl = computed(() =>
    this.configReady()
      ? `https://${firebaseOptions.functionsRegion}-${firebaseOptions.projectId}.cloudfunctions.net/syncTransactions`
      : '',
  );

  constructor() {
    const auth = this.auth;

    if (!auth) {
      this.loading.set(false);
      return;
    }

    void setPersistence(auth, browserLocalPersistence)
      .catch(() => undefined)
      .finally(() => {
        onAuthStateChanged(auth, (user) => {
          this.user.set(user);
          this.loading.set(false);
        });
      });
  }

  async signIn(): Promise<void> {
    if (!this.auth) {
      this.error.set('Falta configurar la Web App de Firebase antes de iniciar sesion.');
      return;
    }

    this.error.set('');
    this.loading.set(true);

    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    try {
      await signInWithPopup(this.auth, provider);
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';

      if (
        code === 'auth/popup-blocked' ||
        code === 'auth/popup-closed-by-user' ||
        code === 'auth/operation-not-supported-in-this-environment'
      ) {
        await signInWithRedirect(this.auth, provider);
        return;
      }

      this.error.set(error instanceof Error ? error.message : 'No se pudo iniciar sesion con Google.');
    } finally {
      this.loading.set(false);
    }
  }

  async signOut(): Promise<void> {
    if (!this.auth) {
      return;
    }

    this.loading.set(true);

    try {
      await signOut(this.auth);
      this.error.set('');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'No se pudo cerrar la sesion.');
    } finally {
      this.loading.set(false);
    }
  }

  async getAuthorizationHeader(): Promise<string | null> {
    if (!this.auth?.currentUser) {
      return null;
    }

    return `Bearer ${await this.auth.currentUser.getIdToken()}`;
  }
}
