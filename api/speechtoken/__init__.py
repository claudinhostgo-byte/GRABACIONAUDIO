"""POST /api/speechtoken -> token de Azure AI Speech para la transcripcion en vivo.

El navegador abre su propia conexion de reconocimiento con este token, que
vence a los 10 minutos. La llave del recurso nunca sale del servidor.
"""

import json

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
        return _json(core.speech_token())
    except Exception as e:
        status, payload = core.error_response(e)
        return _json(payload, status)
