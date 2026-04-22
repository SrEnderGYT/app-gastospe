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
  apiKey: 'AIzaSyA66GtHCXfEviinPbtwK7OzRN_qi0gVxVs',
  authDomain: 'app-gastospe.firebaseapp.com',
  projectId: 'app-gastospe',
  storageBucket: 'app-gastospe.firebasestorage.app',
  messagingSenderId: '301238787233',
  appId: '1:301238787233:web:ab9e79f5a4d09f346864e0',
  functionsRegion: 'us-central1',
};

export const firebaseConfigReady = Boolean(firebaseOptions.apiKey && firebaseOptions.appId);
