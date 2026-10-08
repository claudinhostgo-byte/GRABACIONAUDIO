# Borrador — Lámina de arquitectura

Presentación: reunión C-level con **[placeholder: nombre del cliente]**
Fecha: **[placeholder]** · Preparado por: **[placeholder: nombre y cargo]**

---

## Título de la lámina

**Grabación y análisis de atenciones, dentro de Dynamics 365**

Bajada: *Todo ocurre en el ecosistema Microsoft del cliente. El agente no cambia de herramienta.*

---

## Diagrama central — el recorrido en 5 pasos

Una fila horizontal de cinco bloques conectados por flechas. Cada bloque: ícono, título corto, una línea de explicación.

| # | Bloque | Qué pasa | Tecnología |
|---|---|---|---|
| 1 | **Caso en Dynamics 365** | El agente abre el caso y entra a la pestaña Grabación | Dynamics 365 Customer Service |
| 2 | **Grabar la conversación** | Un botón. El número de caso se asocia solo | Navegador del agente |
| 3 | **Guardar el audio** | Queda almacenado y vinculado al número de caso | Azure Blob Storage |
| 4 | **Transcribir** | Texto separado por hablante, en español de Chile | Azure AI Speech |
| 5 | **Revisar el guion** | Verifica si se trataron los puntos definidos, con la cita que lo respalda | Azure OpenAI |

**Flecha de retorno** desde el paso 5 hacia el paso 1, con la etiqueta:
*La transcripción vuelve al caso automáticamente*

---

## Tres mensajes de apoyo (franja inferior)

1. **Sin cambiar de herramienta**
   El agente trabaja en Dynamics. La grabación es una pestaña más del caso.

2. **Trazabilidad por número de caso**
   Cada audio y cada transcripción quedan asociados al caso que los originó.

3. **Todo en la nube del cliente**
   Los datos permanecen en la suscripción de Azure de **[placeholder: cliente]**. No intervienen servicios de terceros.

---

## Dato destacado (recuadro lateral o pie)

**De la conversación al dato estructurado, sin digitación manual.**
Lo que hoy depende de que alguien escriba una nota, queda registrado, transcrito y verificado automáticamente.

---

## Nota al pie de la lámina

*Grabar conversaciones requiere aviso y consentimiento del interlocutor. La definición del texto de aviso y la política de retención forman parte de la puesta en marcha.*

---

## Decisiones que tomé en este borrador — revísalas

- **No incluí la arquitectura técnica detallada** (Static Web App, managed functions, SAS, contenedores). En C-level eso resta claridad y no cambia ninguna decisión que ellos tomen. Si en la misma reunión hay perfil técnico, lo natural es una segunda lámina de respaldo.
- **No puse cifras de costo ni de tiempos.** No tengo datos medidos que pueda sostener, y en C-level una cifra imprecisa se transforma en compromiso.
- **Dejé la nota de consentimiento.** En una cooperativa financiera, que el tema aparezca planteado por nosotros transmite control; que lo levanten ellos, lo contrario.
- **Mencioné el clip de video de evidencia?** No. Está construido, pero en una lámina de arquitectura para C-level agrega ruido. Dime si quieres que aparezca como un sexto bloque o como mención en la franja inferior.

---

## Placeholders por completar antes de presentar

- Nombre del cliente (aparece 2 veces)
- Fecha de la reunión
- Nombre y cargo de quien presenta
