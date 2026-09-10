"""POST /api/transcribe -> transcribe un blob ya subido con Azure AI Speech.

Sincrono, con Fast Transcription. Static Web Apps corta cada request a los 45
segundos, asi que esto sirve para audios de demo. Para conversaciones largas hay
que pasar a Batch Transcription con polling (ver README).
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
        result = core.transcribe_blob(
            body.get("blobName"), body.get("locales"), body.get("diarize", 0)
        )
    except Exception as e:
        status, payload = core.error_response(e)
        return _json(payload, status)

    logging.info("Transcrito: %s (%d segmentos, usuario=%s)",
                 result["blobName"], len(result["phrases"]),
                 req.headers.get("x-ms-client-principal-name", "anonimo"))
    return _json(result)
