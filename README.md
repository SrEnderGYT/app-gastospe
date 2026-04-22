# Gastospe

Aplicacion Angular offline-first para registrar gastos, ingresos y pagos, con PWA instalable, almacenamiento local, captura rapida desde texto compartido y sincronizacion hacia Google Sheets o Firebase.

## Lo que ya hace

- Guarda movimientos localmente con `localStorage`.
- Funciona como PWA instalable.
- Mantiene una cola de movimientos pendientes cuando no hay internet.
- Permite pegar texto libre de notificaciones o WhatsApp para convertirlo en un movimiento.
- Permite abrir la app con texto precargado por URL o share target.
- Exporta todo a CSV.
- Sincroniza con Google Sheets por webhook.
- Sincroniza con Firebase usando Google Login + HTTPS Function + Firestore.

## Arranque local

```bash
npm install
npm start
```

La app queda disponible en `http://localhost:4200/`.

## Configurar Firebase Web App

Antes de usar login y sync en Firebase, completa [src/app/firebase/firebase.options.ts](src/app/firebase/firebase.options.ts) con la configuracion de la Web App creada en la consola de Firebase.

Valores ya definidos:

- `projectId`: `app-gastospe`
- `authDomain`: `app-gastospe.firebaseapp.com`
- `messagingSenderId`: `301238787233`
- `functionsRegion`: `us-central1`

Te faltan sobre todo:

- `apiKey`
- `appId`

## Firebase en este repo

El repo ya incluye:

- [.firebaserc](.firebaserc) con proyecto default `app-gastospe`
- [firebase.json](firebase.json) para Hosting + Functions + Firestore
- [functions/index.js](functions/index.js) con `syncTransactions`
- [firestore.rules](firestore.rules) para aislar datos por usuario

## Despliegue Firebase

Instala dependencias de Functions:

```bash
cd functions
npm install
cd ..
```

Verifica login del CLI:

```bash
npm run firebase:login:list
```

Publicar todo:

```bash
npm run firebase:deploy
```

Solo Hosting:

```bash
npm run firebase:deploy:hosting
```

Solo Functions:

```bash
npm run firebase:deploy:functions
```

## Google Sheets

Si quieres seguir usando Sheets como salida secundaria, usa [docs/google-apps-script.gs](docs/google-apps-script.gs) y pega la URL del webhook en la app.

## Nota importante sobre iPhone y WhatsApp

Una web local no puede leer por si sola tus notificaciones del iPhone ni tus chats de WhatsApp. Para automatizar eso de verdad necesitas un puente:

- iPhone: Atajos + webhook o una automatizacion propia.
- WhatsApp: WhatsApp Business API o un backend autorizado.

Por eso esta version resuelve el flujo practico: pegas el texto del mensaje o la notificacion, la app lo interpreta, lo guarda localmente y luego lo sincroniza.
