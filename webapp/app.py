"""
Servidor local de desarrollo: sirve la pagina y la API real en el mismo origen.

Al compartir origen no hace falta CORS para la API. El unico CORS necesario es
el del Storage Account, porque el PUT del audio va del navegador directo al blob.

Rutas:
  GET  /                 index.html
  GET  /assets/...       estaticos
  POST /api/sas          URL de subida con SAS acotado a un blob
  POST /api/transcribe   transcripcion con Azure AI Speech
  GET  /api/health       diagnostico de configuracion (sin exponer secretos)

Permite probar /api/sas y /api/transcribe contra Azure de verdad sin instalar
Azure Functions Core Tools. El despliegue en la nube NO usa este archivo: va por
Static Web Apps con las managed functions de api/ (ver README).

    python webapp/app.py
"""

import os
import sys

from flask import Flask, jsonify, request, send_from_directory

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "api", "shared"))
import core  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
WWW = os.path.abspath(os.path.join(HERE, ".."))        # index.html y assets/ del repo

app = Flask(__name__, static_folder=None)


def _fail(exc):
    status, body = core.error_response(exc)
    return jsonify(body), status


def _principal():
    """Usuario autenticado que inyecta App Service, si la auth esta activa."""
    return (request.headers.get("X-MS-CLIENT-PRINCIPAL-NAME")
            or request.headers.get("X-MS-CLIENT-PRINCIPAL-ID"))


@app.after_request
def _headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/")
def index():
    return send_from_directory(WWW, "index.html")


@app.get("/<path:path>")
def static_files(path):
    if path.startswith("api/"):
        return jsonify({"error": "Ruta no encontrada."}), 404
    return send_from_directory(WWW, path)


@app.post("/api/sas")
def api_sas():
    body = request.get_json(silent=True) or {}
    try:
        target = core.make_upload_target(body.get("recordId"), body.get("ext", "wav"))
    except Exception as e:
        return _fail(e)
    app.logger.info("SAS emitido: %s (usuario=%s)", target["blobName"], _principal() or "anonimo")
    return jsonify(target)


@app.post("/api/transcribe")
def api_transcribe():
    body = request.get_json(silent=True) or {}
    try:
        result = core.transcribe_blob(
            body.get("blobName"), body.get("locales"), body.get("diarize", 0)
        )
    except Exception as e:
        return _fail(e)
    app.logger.info("Transcrito: %s (%d segmentos, usuario=%s)",
                    result["blobName"], len(result["phrases"]), _principal() or "anonimo")
    return jsonify(result)


@app.get("/api/health")
def health():
    """Dice si falta configuracion, sin revelar valores."""
    return jsonify({
        "ok": True,
        "storageConfigured": bool(os.environ.get("AUDIO_STORAGE_CONNECTION")),
        "speechConfigured": bool(os.environ.get("SPEECH_KEY") and os.environ.get("SPEECH_REGION")),
        "speechRegion": os.environ.get("SPEECH_REGION"),
        "container": core.container_name(),
        "authenticatedAs": _principal(),
    })


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "8000")), debug=False)
