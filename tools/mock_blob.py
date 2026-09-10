"""
Emulador minimo de Azure Blob Storage para probar la pagina sin Azure.

NO es Azurite ni reemplaza la prueba real: solo implementa lo que usa el grabador
(preflight CORS + PUT de block blob + metadata x-ms-meta-*), guardando los archivos
en disco con la misma estructura de rutas que tendria el contenedor.

Uso:
    python tools/mock_blob.py

Luego, en la pagina (Configuracion > modo "SAS de contenedor"):
    http://localhost:5501/grabaciones?sv=mock&sig=mock

Los archivos quedan en ./_blobs_local/<contenedor>/<ID>/<archivo>
y la metadata en un .meta.json al lado. GET http://localhost:5501/ lista lo subido.
"""

import json
import os
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

PORT = int(os.environ.get("MOCK_PORT", "5501"))
ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_blobs_local")
ORIGIN = os.environ.get("MOCK_ORIGIN", "*")


def _ruta_blob(blob):
    """Resuelve el archivo del blob.

    La pagina envia el nombre SIN el contenedor ("ID/archivo.wav"), porque en
    Azure el contenedor va aparte. En disco los archivos viven bajo
    grabaciones/. Se aceptan ambas formas.
    """
    blob = (blob or "").lstrip("/")
    for cand in (os.path.join(ROOT, "grabaciones", blob), os.path.join(ROOT, blob)):
        cand = os.path.normpath(cand)
        if cand.startswith(ROOT) and os.path.isfile(cand):
            return cand
    return os.path.normpath(os.path.join(ROOT, "grabaciones", blob))


def _wav_duration_ms(path):
    """Duracion real del wav si esta en disco; si no, un valor de respaldo."""
    try:
        import wave
        with wave.open(path) as w:
            return int(w.getnframes() / float(w.getframerate()) * 1000)
    except Exception:
        return 20000


class Handler(BaseHTTPRequestHandler):
    server_version = "MockBlob/1.0"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", ORIGIN)
        self.send_header("Access-Control-Expose-Headers", "*")

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))

    def do_OPTIONS(self):
        """Preflight: el navegador lo dispara por los headers x-ms-*."""
        req_headers = self.headers.get("Access-Control-Request-Headers", "*")
        self.send_response(200)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "PUT, OPTIONS, GET")
        self.send_header("Access-Control-Allow-Headers", req_headers)
        self.send_header("Access-Control-Max-Age", "3600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        ruta = urlparse(self.path).path.rstrip("/")
        if ruta == "/records":
            return self._records()
        if ruta != "/transcribe":
            return self._fail(404, "ResourceNotFound", "Ruta no soportada.")
        return self._transcribe()

    def _records(self):
        """Grabaciones existentes de un ID, con su transcripcion si la hay."""
        size = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(size) or b"{}")
        except ValueError:
            return self._fail(400, "InvalidInput", "JSON invalido.")

        rid = str(req.get("recordId") or "").strip("/")
        base = os.path.normpath(os.path.join(ROOT, "grabaciones", rid))
        items = []
        if base.startswith(ROOT) and os.path.isdir(base):
            for fn in sorted(os.listdir(base), reverse=True):
                if fn.endswith(".json"):
                    continue
                full = os.path.join(base, fn)
                if not os.path.isfile(full):
                    continue
                blob = "grabaciones/%s/%s" % (rid, fn)
                item = {
                    "blobName": "%s/%s" % (rid, fn),
                    "sizeBytes": os.path.getsize(full),
                    "durationMs": _wav_duration_ms(full),
                    "createdAt": datetime.fromtimestamp(
                        os.path.getmtime(full), timezone.utc).isoformat(),
                    "contentType": "audio/wav" if fn.endswith(".wav") else None,
                    # el emulador no valida SAS: la URL directa sirve para reproducir
                    "audioUrl": "http://localhost:%d/%s" % (PORT, blob),
                    "transcript": None,
                }
                meta = full + ".meta.json"
                if os.path.exists(meta):
                    try:
                        with open(meta, encoding="utf-8") as f:
                            m = json.load(f).get("metadata") or {}
                        if m.get("durationms"):
                            item["durationMs"] = int(m["durationms"])
                        item["createdAt"] = m.get("createdat") or item["createdAt"]
                    except Exception:
                        pass
                tj = full + ".json"
                if os.path.exists(tj):
                    try:
                        with open(tj, encoding="utf-8") as f:
                            item["transcript"] = json.load(f)
                    except Exception:
                        item["transcript"] = {"error": "no se pudo leer"}
                items.append(item)

        payload = {"mock": True, "recordId": rid, "count": len(items), "items": items}
        print("  POST /records  %s -> %d grabaciones" % (rid, len(items)), flush=True)
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _transcribe(self):
        """Simulador de transcripcion. Devuelve relleno, NO transcribe."""
        size = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(size) or b"{}")
        except ValueError:
            return self._fail(400, "InvalidInput", "JSON invalido.")

        blob = (req.get("blobName") or "").lstrip("/")
        diarize = int(req.get("diarize") or 0)
        ruta = _ruta_blob(blob)
        dur_ms = _wav_duration_ms(ruta)

        # segmentos de ~4 s repartidos sobre la duracion real del audio
        n = max(1, min(12, round(dur_ms / 4000) or 1))
        step = dur_ms / n
        phrases = []
        for i in range(n):
            ph = {
                "offsetMilliseconds": int(i * step),
                "durationMilliseconds": int(step),
                "text": ("Segmento simulado %d de %d: texto de relleno para validar la "
                         "visualizacion, no es una transcripcion real." % (i + 1, n)),
            }   # sin "confidence": el simulador no tiene nada que medir
            if diarize:
                ph["speaker"] = (i % diarize) + 1
            phrases.append(ph)

        payload = {
            "mock": True,
            "blobName": blob,
            "durationMilliseconds": dur_ms,
            "locales": req.get("locales"),
            "text": " ".join(p["text"] for p in phrases),
            "phrases": phrases,
        }
        # se persiste junto al audio, igual que en el backend real
        try:
            dest = ruta + ".json"
            if dest.startswith(ROOT):
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "w", encoding="utf-8") as f:
                    json.dump(payload, f, ensure_ascii=False, indent=2)
                payload["persisted"] = True
        except Exception as e:
            print("  no se pudo persistir la transcripcion:", e, flush=True)

        print("  POST /transcribe  {}  {} segmentos simulados".format(blob, n), flush=True)
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_PUT(self):
        path = unquote(urlparse(self.path).path).lstrip("/")
        if not path or path.endswith("/"):
            return self._fail(400, "InvalidUri", "Falta el nombre del blob.")
        if self.headers.get("x-ms-blob-type") != "BlockBlob":
            return self._fail(400, "InvalidHeaderValue", "Se esperaba x-ms-blob-type: BlockBlob.")

        size = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(size) if size else b""

        dest = os.path.normpath(os.path.join(ROOT, path))
        if not dest.startswith(ROOT):                      # defensa contra path traversal
            return self._fail(400, "InvalidUri", "Ruta invalida.")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(body)

        meta = {k[len("x-ms-meta-"):]: v for k, v in self.headers.items()
                if k.lower().startswith("x-ms-meta-")}
        info = {
            "blob": path,
            "bytes": len(body),
            "contentType": self.headers.get("x-ms-blob-content-type") or self.headers.get("Content-Type"),
            "metadata": meta,
            "receivedAt": datetime.now(timezone.utc).isoformat(),
        }
        with open(dest + ".meta.json", "w", encoding="utf-8") as f:
            json.dump(info, f, indent=2, ensure_ascii=False)

        print("  PUT  {}  {:,} bytes  meta={}".format(path, len(body), meta), flush=True)

        self.send_response(201)
        self._cors()
        self.send_header("ETag", '"mock-%d"' % len(body))
        self.send_header("x-ms-request-id", "mock-request")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        """Listado de lo almacenado; con ruta, devuelve el archivo."""
        ruta = unquote(urlparse(self.path).path).lstrip("/")
        if ruta:
            full = os.path.normpath(os.path.join(ROOT, ruta))
            if full.startswith(ROOT) and os.path.isfile(full):
                datos = open(full, "rb").read()
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "audio/wav" if ruta.endswith(".wav")
                                 else "application/octet-stream")
                self.send_header("Content-Length", str(len(datos)))
                self.end_headers()
                self.wfile.write(datos)
                return
            if ruta not in ("", "/"):
                return self._fail(404, "BlobNotFound", "No existe: " + ruta)

        items = []
        for base, _, files in os.walk(ROOT):
            for fn in files:
                if fn.endswith(".meta.json"):
                    continue
                full = os.path.join(base, fn)
                items.append({
                    "blob": os.path.relpath(full, ROOT).replace("\\", "/"),
                    "bytes": os.path.getsize(full),
                })
        payload = json.dumps({"root": ROOT, "count": len(items), "blobs": items},
                             indent=2, ensure_ascii=False).encode()
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _fail(self, status, code, msg):
        body = ('<?xml version="1.0" encoding="utf-8"?><Error><Code>%s</Code>'
                "<Message>%s</Message></Error>" % (code, msg)).encode()
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/xml")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    os.makedirs(ROOT, exist_ok=True)
    print("Emulador de Blob en http://localhost:%d" % PORT)
    print("Archivos en: %s" % ROOT)
    print("Pega en la pagina: http://localhost:%d/grabaciones?sv=mock&sig=mock" % PORT)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
