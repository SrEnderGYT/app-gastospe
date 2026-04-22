# Telefono y WhatsApp

## Modo cero escritura

Si no quieres registrar nada desde la web, el camino mas estable hoy es este:

1. Activa las alertas por correo de tu banco, Yape y Plin.
2. Deja funcionando `docs/gmail-firestore-apps-script.gs`.
3. Crea el trigger horario en Apps Script.

Con eso, cuando llegue el correo de BCP, BBVA, Yape o Plin, Gastospe lo procesa solo y lo manda a Firestore sin que escribas en la web.

## iPhone

1. Abre `https://app-gastospe.web.app` en Safari.
2. Toca `Compartir`.
3. Elige `Agregar a pantalla de inicio`.
4. Abre la app desde el icono para usarla como PWA.

## Enviar un gasto desde WhatsApp al telefono

Importante: una PWA o web no puede leer por si sola las notificaciones push del iPhone ni los chats de tu WhatsApp personal. Apple y Meta no exponen ese acceso directo a una web.

### Opcion rapida

1. Copia el texto del mensaje o del comprobante que te llegue por WhatsApp.
2. Abre Gastospe.
3. Pega el texto en `Pegar texto de WhatsApp, Gmail o notificacion`.
4. Toca `Interpretar texto`.
5. Revisa y guarda.

### Opcion con Atajos en iPhone

Si quieres evitar pegar a mano cada vez, crea un Atajo en iPhone:

1. Abre la app `Atajos`.
2. Crea un atajo nuevo.
3. Configuralo para `Recibir` texto y URLs desde la hoja de compartir.
4. Agrega estas acciones:
   - `Codificar URL` sobre el texto recibido
   - `Abrir URL`
5. Usa como URL:

```text
https://app-gastospe.web.app/?capture=[TextoCodificado]
```

Cuando compartas un mensaje desde WhatsApp hacia ese Atajo, Gastospe abrira el texto ya cargado para interpretarlo.

## Android

En Android, Chrome suele manejar mejor la PWA como destino de compartido. Si aparece `Gastospe` en la hoja de compartir, usalo directo. Si no aparece, copia y pega el texto igual que en iPhone.

## WhatsApp oficial con Meta

La integracion oficial para enviar mensajes automaticos o recibir comandos por WhatsApp requiere una fase aparte:

- Meta Cloud API
- numero de WhatsApp Business
- webhook publico
- verificacion del webhook

Eso si permite automatizar mensajes entrantes y salientes, pero no sirve para espiar tu WhatsApp personal existente. Para un flujo 100% automatico hoy, Gmail bancario sigue siendo la ruta mas limpia.

La app ya tiene una base util hoy sin eso:

- capturas por texto,
- automatizacion por Gmail,
- persistencia local,
- sync cloud con Firestore.
