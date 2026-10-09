"""POST /api/extraer -> datos de la solicitud dichos en la conversacion.

Monto solicitado, ingresos mensuales y RUT, cada uno con la cita que lo
respalda. Es una propuesta: la persona la confirma o corrige antes de que
llegue al caso. Los valores son datos personales y no se registran en el log.
"""

import json
import logging

import azure.functions as func

from ..shared import evaluacion


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

    try:
        return _json(evaluacion.extraer(body.get("texto"), body.get("campos")))
    except ValueError as e:
        return _json({"error": str(e)}, 400)
    except evaluacion.EvalConfigError as e:
        return _json({"error": str(e)}, 500)
    except evaluacion.EvalUpstreamError as e:
        return _json({"error": str(e), "detail": getattr(e, "detail", None)}, 502)
    except Exception as e:
        logging.exception("Error no previsto extrayendo datos")
        return _json({"error": "Error interno: %s" % type(e).__name__}, 500)
