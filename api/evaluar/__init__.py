"""POST /api/evaluar -> revisa si la conversacion cubrio ciertos puntos.

Devuelve indicios con cita textual para que una persona los verifique. No
califica a nadie: constata si el tema aparece en la transcripcion.
"""

import json
import logging

import azure.functions as func

from ..shared import core, evaluacion


def _json(body, status=200):
    return func.HttpResponse(
        json.dumps(body, ensure_ascii=False),
        status_code=status,
        mimetype="application/json",
        headers={"Cache-Control": "no-store"},
    )


def main(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
    except ValueError:
        return _json({"error": "Se esperaba un cuerpo JSON."}, 400)

    texto = body.get("texto")
    blob = body.get("blobName")

    # si no mandan el texto, se toma el de la transcripcion ya guardada
    if not texto and blob:
        try:
            datos = core.listar_grabaciones(body.get("recordId") or blob.split("/")[0])
            item = next((x for x in datos["items"] if x["blobName"] == blob), None)
            if item and item.get("transcript"):
                texto = item["transcript"].get("text")
        except Exception as e:
            logging.warning("No se pudo recuperar la transcripcion: %s", e)

    try:
        resultado = evaluacion.evaluar(texto, body.get("criterios"))
    except ValueError as e:
        return _json({"error": str(e)}, 400)
    except evaluacion.EvalConfigError as e:
        return _json({"error": str(e)}, 500)
    except evaluacion.EvalUpstreamError as e:
        return _json({"error": str(e), "detail": getattr(e, "detail", None)}, 502)
    except Exception as e:
        logging.exception("Error no previsto evaluando")
        return _json({"error": "Error interno: %s: %s" % (type(e).__name__, e)}, 500)

    logging.info("Evaluados %d puntos", len(resultado["resultados"]))
    return _json(resultado)
