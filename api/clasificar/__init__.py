"""POST /api/clasificar -> Clasificacion > Motivo > Submotivo de la atencion.

Elige una combinacion del catalogo que manda la pagina, con la cita que la
respalda. Es una propuesta: la persona la confirma o cambia antes de que
llegue al caso.
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
        return _json(evaluacion.clasificar(body.get("texto"), body.get("opciones")))
    except ValueError as e:
        return _json({"error": str(e)}, 400)
    except evaluacion.EvalConfigError as e:
        return _json({"error": str(e)}, 500)
    except evaluacion.EvalUpstreamError as e:
        return _json({"error": str(e), "detail": getattr(e, "detail", None)}, 502)
    except Exception as e:
        logging.exception("Error no previsto clasificando")
        return _json({"error": "Error interno: %s" % type(e).__name__}, 500)
