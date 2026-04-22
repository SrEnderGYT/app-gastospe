# Gastospe

Aplicacion Angular offline-first para registrar gastos, ingresos y pagos, con almacenamiento local, captura rapida desde texto de notificaciones o WhatsApp, exportacion CSV y sincronizacion por webhook hacia Google Sheets o Firebase.

## Lo que ya hace

- Guarda movimientos localmente con `localStorage`.
- Funciona como PWA instalable para usarla como app.
- Mantiene una cola de movimientos pendientes cuando no hay internet.
- Sincroniza por `POST` a un webhook de Google Sheets o a un endpoint de Firebase.
- Permite pegar texto libre para convertir una notificacion en un movimiento editable.
- Permite abrir la app con texto precargado desde un enlace o flujo de compartir compatible.
- Exporta todo a CSV.

## Arranque local

```bash
npm install
npm start
```

La app queda disponible en `http://localhost:4200/`.

## Sincronizar con Google Sheets

1. Crea una hoja con una pestaña `Movimientos`.
2. Abre Apps Script y pega el contenido de [docs/google-apps-script.gs](docs/google-apps-script.gs).
3. Publica el script como Web App con acceso para quien tenga el link.
4. Copia la URL en el campo `Webhook de Google Sheets` dentro de la app.
5. Cambia el modo de sync a `Sheets`.

## Sincronizar con Firebase

1. Crea un proyecto Firebase.
2. Usa [docs/firebase-function.js](docs/firebase-function.js) como base de tu Cloud Function.
3. Publica la funcion y copia su URL en `Endpoint Firebase`.
4. Cambia el modo de sync a `Firebase`.
5. Si quieres publicar el frontend en Hosting, usa [firebase.json](firebase.json) y reemplaza `.firebaserc.example` por `.firebaserc` con tu project id.

## Nota importante sobre iPhone y WhatsApp

Una web local no puede leer por si sola tus notificaciones del iPhone ni tus chats de WhatsApp. Para automatizar eso de verdad necesitas un puente:

- iPhone: Atajos + webhook o una automatizacion propia.
- WhatsApp: WhatsApp Business API o un backend autorizado.

Por eso esta primera version resuelve el flujo practico: pegas el texto del mensaje o la notificacion, la app lo interpreta, lo guarda localmente y luego lo sincroniza.

## Flujo rapido con texto compartido

Puedes abrir la app con una captura precargada usando una URL como:

```text
http://localhost:4200/?capture=Pago%20Yape%20S%2F%2032.50
```

La app interpreta el texto automaticamente y llena el formulario para que solo confirmes y guardes.
