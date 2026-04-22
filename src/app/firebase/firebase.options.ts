export interface FirebaseClientOptions {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  functionsRegion: string;
}

export const firebaseOptions: FirebaseClientOptions = {
  apiKey: '',
  authDomain: 'app-gastospe.firebaseapp.com',
  projectId: 'app-gastospe',
  storageBucket: 'app-gastospe.firebasestorage.app',
  messagingSenderId: '301238787233',
  appId: '',
  functionsRegion: 'us-central1',
};

export const firebaseConfigReady = Boolean(firebaseOptions.apiKey && firebaseOptions.appId);
