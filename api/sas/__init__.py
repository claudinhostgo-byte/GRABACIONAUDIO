"""POST /api/sas -> URL de subida con SAS acotado a un unico blob.

La llave de la cuenta de almacenamiento se queda aca: el navegador solo recibe
una URL firmada, para un nombre de blob puntual y con vigencia de minutos.
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
        target = core.make_upload_target(body.get("recordId"), body.get("ext", "wav"))
    except Exception as e:
        status, payload = core.error_response(e)
        return _json(payload, status)

    # X-MS-CLIENT-PRINCIPAL-NAME lo inyecta Static Web Apps cuando la ruta exige login
    logging.info("SAS emitido: %s (usuario=%s)", target["blobName"],
                 req.headers.get("x-ms-client-principal-name", "anonimo"))
    return _json(target)
