"""POST /api/records -> grabaciones existentes de un ID, con su transcripcion.

Permite que al cargar un caso la pagina sepa si ya hay audio grabado y, en ese
caso, mostrarlo con su texto en vez de ofrecer grabar de nuevo.
"""

import json
import logging

import azure.functions as func

from ..shared import core


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
        datos = core.listar_grabaciones(body.get("recordId"))
    except Exception as e:
        status, payload = core.error_response(e)
        return _json(payload, status)

    logging.info("Consulta de grabaciones: %s -> %d", datos["recordId"], datos["count"])
    return _json(datos)
