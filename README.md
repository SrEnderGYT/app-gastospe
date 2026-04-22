# Gastospe

Aplicacion Angular offline-first para registrar gastos, ingresos y pagos, con PWA instalable, sincronizacion cloud en Firestore, exportacion CSV y automatizacion por Gmail mediante Apps Script.

## Estado actual

- Guarda movimientos localmente y trabaja sin red.
- Sincroniza el flujo principal directo a Firestore cuando hay sesion verificada con Google o correo.
- Mantiene cola local para pendientes y eliminaciones remotas.
- Exporta movimientos a CSV.
- Permite captura rapida desde texto compartido, notificaciones, WhatsApp o Gmail.
- Mantiene Google Sheets como salida secundaria por webhook.
- Incluye Cloud Functions para sync autenticado y para ingestion automatizada desde Apps Script.

## Arranque local

```bash
npm install
npm start
```

La app queda disponible en `http://localhost:4200/`.

## Verificacion rapida del entorno

```bash
npm run firebase:doctor
```

Ese comando hoy valida dos cosas:

- si `firebase-tools` esta disponible localmente;
- si tu Java alcanza para usar Emulator Suite.

Importante: la maquina actual todavia tiene `Java 8`, y Firebase Emulator Suite pide `JDK 21+`.

## Firebase web

La configuracion Web App ya esta cargada en [src/app/firebase/firebase.options.ts](src/app/firebase/firebase.options.ts).

Para que el login funcione de punta a punta, revisa en Firebase Console:

1. `Authentication` ya esta inicializado en el proyecto.
2. `Identity Platform / Authentication > Providers > Google` debe quedar configurado.
3. `Identity Platform / Authentication > Providers > Email/Password` debe quedar habilitado si quieres cuentas con correo y clave.
3. En dominios autorizados agrega:
   - `localhost`
   - `app-gastospe.web.app`
   - cualquier dominio custom que uses despues
4. En el cliente OAuth Web de Google usa como redirect URI:
   - `https://app-gastospe.firebaseapp.com/__/auth/handler`

Importante: en este proyecto el backend ya quedo inicializado con `Identity Platform`. La app ya soporta Google y correo/clave; las cuentas por correo deben verificar su email antes de activar Firestore y automatizaciones.

## Arquitectura que queda en el repo

- [src/app/services/firebase-platform.service.ts](src/app/services/firebase-platform.service.ts): inicializa Firebase App, Auth y Firestore con cache local.
- [src/app/services/firebase-auth.service.ts](src/app/services/firebase-auth.service.ts): login Google o correo, persistencia, verificacion y errores guiados.
- [src/app/services/firebase-transactions.service.ts](src/app/services/firebase-transactions.service.ts): lectura y escritura directa en Firestore.
- [src/app/services/finance-store.service.ts](src/app/services/finance-store.service.ts): store local-first, merge cloud/local, cola de sync y export.
- [functions/index.js](functions/index.js): `syncTransactions` e `ingestAutomationTransactions`.
- [firestore.rules](firestore.rules): aislamiento por usuario.

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

Publicar frontend + firestore + functions:

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

## Secret para automatizaciones Gmail

La Function `ingestAutomationTransactions` necesita un secreto para aceptar llamadas desde Apps Script.

Definelo asi:

```bash
npx firebase-tools functions:secrets:set GASTOSPE_INGEST_SECRET
```

Luego vuelve a desplegar Functions.

## Gmail + Apps Script

Para leer correos de Yape/Plin y enviarlos a Firestore, usa:

- [docs/gmail-firestore-apps-script.gs](docs/gmail-firestore-apps-script.gs)

Este es el flujo recomendado si quieres operar casi sin escribir nada en la web:

- llegan correos de BCP, BBVA, Yape o Plin;
- Apps Script los revisa en Gmail;
- Gastospe los registra solo en Firestore;
- la web queda mas como tablero y respaldo, no como punto de captura principal.

Pasos:

1. Crear un proyecto de Apps Script.
2. Pegar el contenido del archivo.
3. El UID principal ya quedo cargado para la cuenta `undersansyt267@gmail.com`.
4. Guardar el secreto en Apps Script:
   - abrir `Project Settings > Script Properties`
   - crear `GASTOSPE_INGEST_SECRET`
   - pegar el secreto actual de ingestion
5. Si quieres, corre `setupGastospeConfig()` para volver a fijar el UID en Script Properties.
6. Ejecutar `showCurrentConfig_()` para confirmar que el script ya ve tu UID y el secreto.
7. Ejecutar `previewRecentMatches()` para ver que esta detectando sin enviar nada.
8. Ejecutar `runParserSelfTest()` para una verificacion rapida del parser.
9. Ejecutar `ingestBcpFinanceEmails()` manualmente una vez.
10. Ejecutar `createHourlyTrigger()`.

El script:

- busca correos recientes de BCP;
- tambien soporta correos y alertas con texto tipo BBVA;
- detecta compras, plines y yapeos;
- detecta transferencias, abonos y depositos;
- ignora compras rechazadas y correos de configuracion;
- usa `gmail-${messageId}` como ID estable para evitar duplicados;
- envia los movimientos a Firebase por HTTPS;
- permite guardar `UID` y secreto en `Script Properties` para no dejar secretos en el repo.

## Google Sheets

Si quieres mantener Sheets como salida secundaria, usa:

- [docs/google-apps-script.gs](docs/google-apps-script.gs)

y pega el webhook en la app.

## Nota importante sobre iPhone y WhatsApp

Una web no puede leer por si sola tus notificaciones push del iPhone ni tus chats de WhatsApp personal.

Para automatizar eso de verdad necesitas un puente:

- iPhone: Atajos + webhook o una automatizacion propia.
- WhatsApp: WhatsApp Business Platform / Cloud API con webhook oficial.

Guia practica:

- [docs/telefono-y-whatsapp.md](docs/telefono-y-whatsapp.md)

Por eso esta version deja resuelto el flujo practico y estable:

- captura manual o por texto,
- persistencia local,
- cloud real con Firestore,
- automatizacion de Gmail por Apps Script,
- salida opcional a Sheets.
