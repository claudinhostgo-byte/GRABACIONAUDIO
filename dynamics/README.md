# Integración con Dynamics 365 — formulario de Caso

Entorno objetivo: `https://demolegrand.crm2.dynamics.com/`
Grabador: `https://proud-smoke-0ef172d03.5.azurestaticapps.net`

## Qué hace

Una pestaña nueva en el formulario de Caso con el grabador incrustado. La pestaña
**permanece oculta hasta que el caso existe**, porque el número de caso se genera al guardar y es
lo que indexa la grabación. Una vez guardado, el iframe carga:

```
https://proud-smoke-0ef172d03.5.azurestaticapps.net/?id=<ticketnumber>&lock=1
```

`lock=1` prefija el ID y lo bloquea: el usuario no puede cambiarlo ni equivocarse. El audio queda
en `grabaciones/<número de caso>/<fecha>-<aleatorio>.wav`, y la metadata del blob repite el
número en `recordid`.

## El problema del micrófono y la cámara, y cómo se resuelve

Dynamics construye el `iframe` **sin atributo `allow`**. Un iframe de otro origen sin ese
atributo no puede usar micrófono ni cámara, sin importar que el usuario acepte el permiso: el
navegador lo bloquea antes de preguntar.

Son **dos permisos independientes**, y se evalúan en este orden:

| | Quién lo controla |
|---|---|
| Permissions Policy: el atributo `allow` del iframe | este recurso web |
| Permiso del usuario: el diálogo *Permitir / Bloquear* | el usuario, por sitio |

El atributo se evalúa **antes** que el permiso del usuario. De ahí que conceder el permiso en
otra ventana no sirva de nada: la ventana resuelve el segundo, y el que bloquea es el primero.

Con el atributo puesto, el navegador pide el permiso **dentro del propio formulario**, una sola
vez por usuario y sitio, y lo recuerda. El script delega ambos: `allow="microphone; camera"`.

Verificado: la lista de permitidos del documento padre para `microphone` contiene únicamente su
propio origen. El iframe del grabador no está en ella salvo que se declare explícitamente.

`wit_grabacion_caso.js` fija el atributo sobre el elemento del iframe **antes** de navegar
(asignarlo después no aplica). Si el DOM no está accesible, cae a `setSrc()` y la página avisa que
el micrófono está bloqueado, ofreciendo abrirse en pestaña nueva.

Esto usa manipulación directa del DOM del formulario, que **Microsoft no soporta oficialmente**.
Funciona hoy y es la única forma de tener el grabador embebido. Si una actualización de la
plataforma lo rompe, el respaldo es el botón de cinta que abre el grabador en pestaña nueva
(`WIT.Grabacion.abrirEnPestanaNueva`), que no depende de esto.

## Configuración

En `https://make.powerapps.com`, entorno **demolegrand**, dentro de una solución **no
administrada**.

### 1. Recurso web

*Solución* → **Nuevo** → *Más* → **Recurso web**

| Campo | Valor |
|---|---|
| Nombre | `wit_grabacion_caso.js` |
| Nombre para mostrar | Grabación de audio — Caso |
| Tipo | **JavaScript (JS)** |
| Archivo | `dynamics/wit_grabacion_caso.js` de este repo |

Guardar y **Publicar**.

### 2. Campo del número de caso en el formulario

`formContext.getAttribute("ticketnumber")` devuelve `null` **si el campo no está en el
formulario**, aunque exista en la tabla. Verifica que **Número de caso** esté en el formulario
principal (normalmente va en el encabezado). Si no está, agrégalo; puede quedar oculto, basta con
que forme parte del formulario.

Es el error más común al montar esto: todo parece bien configurado y la pestaña nunca aparece.

### 3. Pestaña e iframe

Editar el formulario **principal** de la tabla *Caso*:

**Agregar una pestaña**

| Propiedad | Valor |
|---|---|
| Nombre | `tab_grabacion` |
| Etiqueta | Grabación |
| Columnas | 1 |

**Agregar un componente IFRAME dentro de esa pestaña**

| Propiedad | Valor |
|---|---|
| Nombre | `IFRAME_grabador` |
| URL | `about:blank` — el script asigna la real |
| **Restringir scripts entre marcos** | **Desmarcado** |
| Pasar código de tipo de objeto y identificador como parámetros | Desmarcado |
| Visible de forma predeterminada | Marcado (el script controla la pestaña, no el iframe) |
| Alto | 700 px, o *usar todo el espacio vertical disponible* |

Desmarcar **Restringir scripts entre marcos** es obligatorio: si queda marcado, Dynamics agrega
atributos de aislamiento al iframe y el grabador no funciona.

### 4. Biblioteca y eventos

En las propiedades del formulario:

- **Bibliotecas de formulario** → agregar `wit_grabacion_caso.js`
- **Controladores de eventos**:

| Evento | Función | Pasar contexto de ejecución |
|---|---|---|
| Al cargar (OnLoad) | `WIT.Grabacion.onLoad` | **Marcado** |
| Al guardar (OnSave) | `WIT.Grabacion.onSave` | **Marcado** (opcional) |

Marcar *Pasar el contexto de ejecución como primer parámetro* es obligatorio: sin eso el script
no recibe `executionContext` y falla en la primera línea.

### 5. Guardar y publicar

**Guardar** → **Publicar**. Los cambios de formulario no aplican hasta publicar.

## Prueba

1. Crear un caso nuevo → la pestaña **Grabación** no debe aparecer.
2. Guardar → la pestaña aparece y muestra el grabador con el número de caso ya fijado.
3. *Permitir micrófono* → el navegador pide permiso para el dominio `azurestaticapps.net`.
   Aceptar. El permiso queda recordado para ese origen.
4. Grabar, subir y transcribir.
5. Verificar en el portal de Azure: `stgrabacionwit01` → `grabaciones` → debe existir la carpeta
   con el número de caso.

Si en el paso 3 aparece el aviso rojo *"el contenedor no le delegó el micrófono"*, el atributo no
se pudo fijar. Revisar en la consola del navegador si hay un `WIT.Grabacion:` advirtiendo, y usar
el botón *Abrir en pestaña nueva* mientras se investiga.

## Respaldo: botón de cinta

Si la vía del iframe no resulta en el entorno del cliente, `WIT.Grabacion.abrirEnPestanaNueva`
abre el grabador como pestaña de primer nivel, donde el micrófono funciona siempre. Se engancha a
un botón de comando en la cinta del formulario de Caso, pasando **PrimaryControl** como
parámetro. Valida que el caso esté guardado antes de abrir.

## Pendiente antes de un piloto real

- **La URL del grabador es pública.** Cualquiera que la tenga puede subir audio y consumir la
  cuota de Speech. Hay que cerrarla con Entra ID en la Static Web App.
- **Tope de 45 segundos** por request en `/api/transcribe` (límite de Static Web Apps). Con audios
  de demo no se nota; con conversaciones largas hay que pasar a Batch Transcription con polling.
- **Consentimiento.** Grabar una conversación exige aviso y consentimiento del interlocutor, y el
  audio es dato personal. Definir el texto de aviso y la política de retención antes de grabar
  conversaciones reales.
- **Escribir el resultado en Dynamics.** Hoy la transcripción se muestra y se exporta, pero no se
  guarda en el caso. El siguiente paso natural es crear una anotación o una nota de caso vía
  Dataverse Web API con el texto y el enlace al blob.
