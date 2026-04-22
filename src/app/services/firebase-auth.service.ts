import { computed, Injectable, inject, signal } from '@angular/core';
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getRedirectResult,
  onAuthStateChanged,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updateProfile,
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
  readonly notice = signal('');

  readonly isSignedIn = computed(() => Boolean(this.user()));
  readonly email = computed(() => this.user()?.email || '');
  readonly uid = computed(() => this.user()?.uid || '');
  readonly isEmailVerified = computed(() => Boolean(this.user()?.emailVerified));
  readonly providerId = computed(() => this.user()?.providerData[0]?.providerId || '');
  readonly providerLabel = computed(() => {
    switch (this.providerId()) {
      case 'google.com':
        return 'Google';
      case 'password':
        return 'Correo';
      default:
        return 'Sesion activa';
    }
  });
  readonly displayName = computed(() => this.user()?.displayName || this.user()?.email || 'Sesion activa');
  readonly needsEmailVerification = computed(() => this.isSignedIn() && !this.isEmailVerified());
  readonly hasCloudAccess = computed(
    () => this.configReady() && this.isSignedIn() && this.isEmailVerified(),
  );
  readonly canSync = this.hasCloudAccess;
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

    this.clearMessages();
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

  async signInWithEmail(email: string, password: string): Promise<void> {
    if (!this.auth) {
      this.error.set('Firebase aun no esta listo para autenticar con correo.');
      return;
    }

    this.clearMessages();
    this.loading.set(true);

    try {
      await signInWithEmailAndPassword(this.auth, email.trim(), password);
      await this.refreshUser();

      if (this.needsEmailVerification()) {
        this.notice.set(
          'Tu cuenta entro correctamente, pero debes verificar tu correo antes de usar Firestore.',
        );
      }
    } catch (error) {
      this.error.set(this.describeEmailAuthError(error, 'signin'));
    } finally {
      this.loading.set(false);
    }
  }

  async registerWithEmail(name: string, email: string, password: string): Promise<void> {
    if (!this.auth) {
      this.error.set('Firebase aun no esta listo para registrar usuarios.');
      return;
    }

    this.clearMessages();
    this.loading.set(true);

    try {
      const credential = await createUserWithEmailAndPassword(this.auth, email.trim(), password);

      if (name.trim()) {
        await updateProfile(credential.user, { displayName: name.trim() });
      }

      await sendEmailVerification(credential.user, this.resolveActionCodeSettings());
      await this.refreshUser();
      this.notice.set(
        'Cuenta creada. Te enviamos un correo de verificacion; cuando lo confirmes, ya podras sincronizar.',
      );
    } catch (error) {
      this.error.set(this.describeEmailAuthError(error, 'register'));
    } finally {
      this.loading.set(false);
    }
  }

  async resendVerificationEmail(): Promise<void> {
    const currentUser = this.auth?.currentUser;

    if (!currentUser) {
      this.error.set('Inicia sesion primero para reenviar la verificacion.');
      return;
    }

    this.clearMessages();
    this.loading.set(true);

    try {
      await sendEmailVerification(currentUser, this.resolveActionCodeSettings());
      this.notice.set('Se envio un nuevo correo de verificacion.');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'No se pudo reenviar la verificacion.');
    } finally {
      this.loading.set(false);
    }
  }

  async sendPasswordReset(email: string): Promise<void> {
    if (!this.auth) {
      this.error.set('Firebase aun no esta listo para recuperar claves.');
      return;
    }

    const normalizedEmail = email.trim();

    if (!normalizedEmail) {
      this.error.set('Ingresa tu correo para enviar el enlace de recuperacion.');
      return;
    }

    this.clearMessages();
    this.loading.set(true);

    try {
      await sendPasswordResetEmail(this.auth, normalizedEmail, this.resolveActionCodeSettings());
      this.notice.set('Te enviamos un enlace para restablecer tu clave.');
    } catch (error) {
      this.error.set(this.describeEmailAuthError(error, 'reset'));
    } finally {
      this.loading.set(false);
    }
  }

  async refreshUser(): Promise<void> {
    if (!this.auth?.currentUser) {
      return;
    }

    try {
      await reload(this.auth.currentUser);
      await this.auth.currentUser.getIdToken(true);
      this.user.set(this.auth.currentUser);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'No se pudo refrescar la sesion.');
    }
  }

  async signOut(): Promise<void> {
    if (!this.auth) {
      return;
    }

    this.loading.set(true);

    try {
      await signOut(this.auth);
      this.clearMessages();
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

  private clearMessages(): void {
    this.error.set('');
    this.notice.set('');
  }

  private resolveActionCodeSettings(): { url: string; handleCodeInApp: boolean } | undefined {
    if (typeof window === 'undefined') {
      return undefined;
    }

    return {
      url: window.location.origin,
      handleCodeInApp: false,
    };
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

  private describeEmailAuthError(
    error: unknown,
    mode: 'signin' | 'register' | 'reset',
  ): string {
    const code = this.resolveErrorCode(error);

    switch (code) {
      case 'auth/invalid-email':
        return 'El correo no tiene un formato valido.';
      case 'auth/missing-password':
        return 'Ingresa una clave para continuar.';
      case 'auth/weak-password':
        return 'La clave debe tener al menos 6 caracteres.';
      case 'auth/email-already-in-use':
        return 'Ese correo ya esta registrado. Prueba entrando o recuperando tu clave.';
      case 'auth/user-not-found':
      case 'auth/invalid-credential':
        return mode === 'reset'
          ? 'No encontramos una cuenta con ese correo.'
          : 'Correo o clave incorrectos.';
      case 'auth/too-many-requests':
        return 'Se bloquearon temporalmente los intentos. Espera un momento y vuelve a probar.';
      case 'auth/network-request-failed':
        return 'Hubo un problema de red con Firebase Authentication.';
      default:
        return error instanceof Error ? error.message : 'No se pudo completar la autenticacion.';
    }
  }

  private resolveErrorCode(error: unknown): string {
    return typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  }
}
