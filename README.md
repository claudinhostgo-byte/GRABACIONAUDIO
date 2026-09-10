# Grabador de conversaciones -> Azure Blob Storage

Prototipo de prueba (W-IT) para el componente que el cliente quiere incrustar en Dynamics 365.

Página web que toma el micrófono, permite elegir el dispositivo, graba con animación de nivel,
sube el audio a Azure Blob Storage indexado por un ID y lo transcribe con Azure AI Speech.

Se despliega como **Azure Static Web App**: la página como contenido estático y `/api` como
managed functions en Python. Ambas cosas salen del mismo repo, publicadas por GitHub Actions.

---

## Estructura

```
index.html                       UI de 4 pasos
assets/styles.css                estilos (claro/oscuro)
assets/app.js                    captura, animación, conversión WAV, subida y transcripción
staticwebapp.config.json         runtime, headers y rutas de Static Web Apps
api/                             managed functions de SWA (Python, modelo v1)
  shared/core.py                 lógica compartida: SAS y Azure AI Speech
  sas/                           POST /api/sas
  transcribe/                    POST /api/transcribe
  host.json, requirements.txt
webapp/app.py                    servidor local de desarrollo (Flask, mismo origen)
tools/mock_blob.py               emulador local de Blob + simulador de transcripción
```

## Configuración por defecto

La página decide sola según el host desde el que se sirve, sin tocar nada:

| | Servida desde `localhost` | Servida desde Azure |
|---|---|---|
| Modo de subida | SAS de contenedor (emulador) | Function → `/api/sas` |
| Transcripción | Simulador local | Function → `/api/transcribe` |
| Formato | WAV PCM 16 kHz mono | WAV PCM 16 kHz mono |
| Idioma | es-CL, sin diarización | es-CL, sin diarización |

En Azure la API vive en el mismo origen bajo `/api`, así que las rutas son relativas y no hay
endpoints que configurar. Los valores están en `CFG_LOCAL` y `CFG_NUBE`, al inicio de
`assets/app.js`. Lo que se guarde en el panel de Configuración queda en `localStorage` y tiene
prioridad; *Borrar configuración* vuelve a los defaults.

## Cómo funciona

1. **Paso 1 — ID.** Se ingresa el código de indexación (n.º de caso, GUID de Dynamics, etc.).
   Se normaliza a caracteres seguros para rutas de blob y se usa como carpeta:
   `grabaciones/<ID>/20260910-143502-a1b2c3d4.wav`.
   Así, listar todo lo de un registro es un `list blobs` con prefijo `<ID>/`.
   Además se escribe metadata en el blob: `recordid`, `durationms`, `createdat`, `source`.

2. **Paso 2 — Grabar.** `getUserMedia` + `MediaRecorder`. El `<select>` de micrófonos se llena con
   `enumerateDevices()` (los nombres solo aparecen después de conceder el permiso, es una
   restricción del navegador) y se refresca al conectar/desconectar dispositivos.
   La animación es un espectro dibujado en canvas desde un `AnalyserNode`, más punto rojo pulsante
   y cronómetro. Hay pausar/continuar.

3. **Paso 3 — Subir.** Por defecto el audio se convierte a **WAV PCM 16 kHz mono**
   (`OfflineAudioContext` + encoder propio), que es el formato más seguro para Azure AI Speech.
   Se puede dejar el nativo (WebM/Opus) si prefieres archivos livianos.
   La subida es un `PUT` de block blob con barra de progreso real.

## Modos de subida

| Modo | Cómo | Cuándo |
|---|---|---|
| **Azure Function** (recomendado) | La página pide a `/api/sas` un SAS de escritura para **un** blob, vigencia 15 min | Demo formal y producción |
| **SAS de contenedor pegado en la UI** | Se pega una URL con SAS en Configuración | Prueba rápida en tu máquina |

El SAS de contenedor queda visible en el navegador y en el historial de red: úsalo solo para probar,
con permisos `create`+`write` (nunca `read`/`list`/`delete`) y vigencia de horas, no de meses.

---

## Despliegue en Azure

### Recursos necesarios

| Recurso | Para qué | Notas |
|---|---|---|
| Static Web App | sirve la página y `/api` | plan **Free** basta; da HTTPS, requisito del micrófono |
| Storage Account + contenedor | guarda el audio | contenedor privado, con regla CORS |
| Azure AI Speech | transcribe | la región define el endpoint |

### 1. Crear los recursos

```bash
az group create -n rg-grabacion-demo -l brazilsouth
az storage account create -n <cuenta> -g rg-grabacion-demo -l brazilsouth --sku Standard_LRS --kind StorageV2
az storage container create --account-name <cuenta> -n grabaciones
az cognitiveservices account create -n <speech> -g rg-grabacion-demo -l brazilsouth --kind SpeechServices --sku S0 --yes
```

### 2. Crear la Static Web App conectada al repo

Portal → *Create resource* → **Static Web App**:

| Campo | Valor |
|---|---|
| Plan | Free |
| Source | GitHub → `claudinhostgo-byte/GRABACIONAUDIO`, rama `main` |
| Build presets | **Custom** |
| App location | `/` |
| Api location | `api` |
| Output location | *(vacío)* |

Azure genera el workflow en `.github/workflows/` y lo commitea al repo. Cada push a `main`
vuelve a publicar. **No hay que crear el workflow a mano.**

### 3. Configuración de la aplicación

Static Web App → *Settings* → **Environment variables** (aplican a la API):

| Nombre | Valor |
|---|---|
| `AUDIO_STORAGE_CONNECTION` | connection string de la cuenta de almacenamiento |
| `AUDIO_CONTAINER` | `grabaciones` |
| `SPEECH_KEY` | llave del recurso de Speech |
| `SPEECH_REGION` | p. ej. `brazilsouth` |
| `SAS_TTL_MINUTES` | `15` |

Obtener los valores:

```bash
az storage account show-connection-string -n <cuenta> -g rg-grabacion-demo -o tsv
az cognitiveservices account keys list -n <speech> -g rg-grabacion-demo --query key1 -o tsv
```

### 4. CORS del Storage con el dominio de la SWA

El `PUT` del audio va del navegador **directo al blob**, así que el origen de la SWA tiene que
estar autorizado. Sin esto la subida falla con error de red y sin código HTTP:

```bash
az storage cors add --account-name <cuenta> --services b --methods PUT OPTIONS --origins "https://<nombre>.azurestaticapps.net" --allowed-headers "x-ms-blob-type,x-ms-blob-content-type,x-ms-meta-*,content-type" --exposed-headers "*" --max-age 3600
```

### 5. Verificar

`https://<nombre>.azurestaticapps.net/api/health` responde si falta configuración, sin revelar
valores:

```json
{ "ok": true, "storageConfigured": true, "speechConfigured": true, "container": "grabaciones" }
```

> `/api/health` existe en el servidor local de desarrollo. En SWA hay que agregarlo como una
> tercera función si se quiere el mismo diagnóstico; mientras tanto, el síntoma de configuración
> faltante es un 500 de `/api/sas` con el mensaje del error.

---

## Desarrollo local

Tres formas, de la más liviana a la más fiel:

**a) Solo la página, con emuladores** (no necesita Azure ni credenciales):

```bash
python -m http.server 5500
```

```bash
python tools/mock_blob.py
```

**b) Página + API real contra Azure** (necesita credenciales, no necesita Core Tools):

```bash
python webapp/app.py
```

Levanta en `http://localhost:8000` sirviendo la página y la API en el mismo origen. Requiere
`AUDIO_STORAGE_CONNECTION`, `SPEECH_KEY` y `SPEECH_REGION` como variables de entorno del shell,
y agregar `http://localhost:8000` al CORS del Storage. En la página hay que cambiar el modo de
subida a *Azure Function* y el motor de transcripción a *Azure AI Speech*.

**c) Emulando SWA completa**: requiere Node (`npx @azure/static-web-apps-cli`) y Azure Functions
Core Tools. No es necesario para este prototipo.

`getUserMedia` exige contexto seguro: **HTTPS o `localhost`**. Abrir el `index.html` con doble
clic (`file://`) no funciona.

## Paso 4: transcripción

`POST /api/transcribe` con `{ "blobName": "CASO-1/2026....wav", "locales": ["es-CL"], "diarize": 2 }`
descarga el blob y lo envía a **Fast Transcription** de Azure AI Speech. Responde:

```json
{ "mock": false, "text": "...", "durationMilliseconds": 14000,
  "phrases": [ { "offsetMilliseconds": 0, "durationMilliseconds": 4200,
                 "text": "...", "speaker": 1, "confidence": 0.93 } ] }
```

La UI muestra el texto continuo y la lista de segmentos con marca de tiempo, chip de hablante y
confianza. Al reproducir el audio se resalta el segmento en curso, y hacer clic en un segmento
salta a ese instante. Exporta a `.txt` (con cabecera de ID y blob) y al `.json` crudo de Azure.

### Por qué la transcripción va por la Function y no desde el navegador

La llave de Azure AI Speech no puede vivir en el navegador: quien abra la página se la lleva.
Además los endpoints REST de Cognitive Services no están pensados para llamadas cross-origin
desde una página, así que el navegador podría bloquear la respuesta por CORS. Pasando por la
Function la llave queda en el servidor y no hay CORS de por medio.

Si en algún momento se necesita transcripción **en vivo mientras se graba**, ahí sí corresponde
el Speech SDK de JavaScript en el navegador (funciona por WebSocket y sí soporta browser), pero
alimentado con un **token temporal** emitido por la Function, nunca con la llave.

### Límites a considerar

- La versión de API (`2024-11-15`) y la forma exacta del bloque `diarization` hay que
  confirmarlas contra la documentación vigente y la región del recurso antes de darlas por buenas.
- **Static Web Apps corta cada request a `/api` a los 45 segundos.** Es el límite más duro del
  diseño actual: la transcripción síncrona sirve para audios de demo, no para una conversación
  de veinte minutos. Cuando el audio crezca, `/api/transcribe` va a devolver timeout.
- Fast Transcription tiene además su propio límite de tamaño y duración por llamada.

**Cómo se resuelve:** pasar a **Batch Transcription** con patrón asíncrono — `/api/transcribe`
crea el trabajo y devuelve un id, y la página consulta `/api/transcription-status?id=...` cada
pocos segundos. Cada request queda muy por debajo de los 45 s y deja de importar cuánto dure el
audio. Es la primera cosa a construir si el cliente confirma conversaciones largas.

Arquitectura recomendada para producción: trigger de Blob -> Batch Transcription -> guardar el
JSON en `transcripciones/<ID>/...` -> escribir la nota en Dynamics vía Dataverse Web API.

## Emulador local (`tools/mock_blob.py`)

```bash
python tools/mock_blob.py
```

Levanta en `http://localhost:5501` e implementa **solo** lo que consume la página:

- `OPTIONS` → preflight CORS con los headers `x-ms-*`
- `PUT /<contenedor>/<ruta>` → guarda el archivo en `_blobs_local/` y la metadata en un
  `.meta.json` al lado
- `POST /transcribe` → devuelve segmentos de **relleno** repartidos sobre la duración real del wav
- `GET /` → lista lo almacenado

**Ignora el SAS**: no valida firma, permisos ni expiración, y no transcribe nada. Sirve para
desarrollar y para validar la mecánica sin Azure. Cuando devuelve una transcripción simulada, la
página muestra un aviso ámbar y el `.txt` exportado lleva la advertencia en la cabecera, para que
nadie confunda ese texto con una transcripción real. **No es material para mostrar a un cliente
como si fuera Azure.**

---

## Incrustar en Dynamics 365: lo que hay que validar

Esto es el punto de riesgo del componente y conviene probarlo antes de comprometerlo:

- Un **web resource HTML** en Dynamics se carga dentro de un `iframe` cuyo atributo `allow`
  no controlamos. Si ese iframe no declara `allow="microphone"`, el navegador bloquea
  `getUserMedia` sin importar que el usuario acepte el permiso. **Hay que verificarlo en el
  entorno del cliente antes de elegir este camino.**
- Alternativa más segura: **botón de cinta que abre la página en una pestaña nueva**
  (`Xrm.Navigation.openUrl`) pasando el ID por querystring. La página soporta
  `?id=CASO-123&lock=1`: prellena y fija el ID, dejando al usuario solo grabar.
- Alternativa integrada: **componente PCF**, que se renderiza en el DOM de la app en lugar de un
  iframe anidado. Es la opción más prolija de cara al usuario y la que ofrecería como definitiva,
  a costa de más desarrollo.

Mi recomendación: validar la prueba con el flujo de pestaña nueva (es el que con más certeza
funciona), y ofrecer el PCF como fase de industrialización.

## Pendientes antes de mostrarlo a un cliente

- **Consentimiento.** Grabar una conversación exige aviso y consentimiento explícito del
  interlocutor, y el audio es dato personal. Hay que definir el texto de aviso y la política de
  retención con Administración y Finanzas antes de cualquier piloto con datos reales.
- Autenticación de la página (hoy es abierta): Entra ID + validación del token en la Function,
  y verificar que el usuario tenga acceso al registro de Dynamics que dice estar grabando.
- Blob container privado, cifrado en reposo (por defecto), y `Immutable`/retención según lo que
  exija el cliente.
- Reintento de subida si se corta la red (hoy el reintento es manual con el mismo botón).
- Para grabaciones largas, subida por bloques (`Put Block` + `Put Block List`) en lugar de un
  `PUT` único.
