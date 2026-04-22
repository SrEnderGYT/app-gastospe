import { computed, Injectable, inject, signal } from '@angular/core';
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getRedirectResult,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from 'firebase/auth';
import { firebaseOptions } from '../firebase/firebase.options';
import { FirebasePlatformService } from './firebase-platform.service';

@Injectable({ providedIn: 'root' })
export class FirebaseAuthService {
  private readonly firebasePlatform = inject(FirebasePlatformService);
  private readonly auth = this.firebasePlatform.auth;

  readonly configReady = this.firebasePlatform.configReady;
  readonly loading = signal(this.configReady());
  readonly user = signal<User | null>(null);
  readonly error = signal(
    this.configReady()
      ? ''
      : 'Completa src/app/firebase/firebase.options.ts con la configuracion Web App de Firebase.',
  );

  readonly isSignedIn = computed(() => Boolean(this.user()));
  readonly canSync = computed(() => this.configReady() && this.isSignedIn());
  readonly displayName = computed(() => this.user()?.displayName || this.user()?.email || 'Sesion activa');
  readonly email = computed(() => this.user()?.email || '');
  readonly uid = computed(() => this.user()?.uid || '');
  readonly syncFunctionUrl = computed(() =>
    this.configReady()
      ? `https://${firebaseOptions.functionsRegion}-${firebaseOptions.projectId}.cloudfunctions.net/syncTransactions`
      : '',
  );
  readonly automationFunctionUrl = computed(() =>
    this.configReady()
      ? `https://${firebaseOptions.functionsRegion}-${firebaseOptions.projectId}.cloudfunctions.net/ingestAutomationTransactions`
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
      .then(async () => {
        try {
          await getRedirectResult(auth);
        } catch (error) {
          this.error.set(this.describeAuthError(error));
        }
      })
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
      const code = this.resolveErrorCode(error);

      if (
        code === 'auth/popup-blocked' ||
        code === 'auth/popup-closed-by-user' ||
        code === 'auth/operation-not-supported-in-this-environment'
      ) {
        await signInWithRedirect(this.auth, provider);
        return;
      }

      this.error.set(this.describeAuthError(error));
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

  private describeAuthError(error: unknown): string {
    const code = this.resolveErrorCode(error);
    const currentDomain =
      typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.host}` : '';

    switch (code) {
      case 'auth/configuration-not-found':
        return `Firebase Auth respondio configuration-not-found. El proyecto ya tiene Authentication inicializado, pero falta configurar el proveedor Google en Identity Platform / Authentication > Providers > Google y dejar ${currentDomain || 'tu dominio actual'} en dominios autorizados.`;
      case 'auth/unauthorized-domain':
        return `El dominio ${currentDomain || 'actual'} no esta autorizado en Firebase Authentication. Agregalo en Authentication > Settings > Authorized domains.`;
      case 'auth/popup-closed-by-user':
        return 'Se cerro la ventana de Google antes de completar el inicio de sesion.';
      case 'auth/popup-blocked':
        return 'El navegador bloqueo la ventana emergente. Intentalo otra vez o permite popups para esta web.';
      case 'auth/network-request-failed':
        return 'Hubo un problema de red al iniciar sesion con Google.';
      default:
        return error instanceof Error ? error.message : 'No se pudo iniciar sesion con Google.';
    }
  }

  private resolveErrorCode(error: unknown): string {
    return typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  }
}
