"""
Logica compartida del grabador: firma de SAS y transcripcion con Azure AI Speech.

No depende de Flask ni de azure.functions, para que sirva igual detras de un
App Service (webapp/app.py) o de una Azure Function (api/function_app.py).

Variables de entorno:
  AUDIO_STORAGE_CONNECTION  connection string de la cuenta de almacenamiento
  AUDIO_CONTAINER           contenedor destino (default "grabaciones")
  SAS_TTL_MINUTES           vigencia del SAS de subida (default 15)
  SPEECH_KEY / SPEECH_REGION            recurso de Azure AI Speech
  SPEECH_API_VERSION        version de la API de Fast Transcription
"""

import datetime
import json
import logging
import os
import re
import uuid

import requests
from azure.storage.blob import (
    BlobSasPermissions,
    BlobServiceClient,
    ContentSettings,
    generate_blob_sas,
)

ALLOWED_EXT = {"wav", "webm", "ogg", "m4a", "mp3", "mp4"}
CONTENT_TYPES = {
    "wav": "audio/wav", "webm": "audio/webm", "ogg": "audio/ogg",
    "m4a": "audio/mp4", "mp3": "audio/mpeg",
}
# el clip de evidencia comparte extension con el audio (webm), asi que el tipo
# lo decide el llamador y no la extension
CONTENT_TYPES_VIDEO = {"webm": "video/webm", "mp4": "video/mp4"}
PREFIJO_CLIP = "clip-"
MAX_LOCALES = 4
_ID_RE = re.compile(r"[^A-Za-z0-9._-]+")


class UserError(Exception):
    """Entrada invalida del cliente -> 400."""


class ConfigError(Exception):
    """Falta configuracion del servidor -> 500."""


class UpstreamError(Exception):
    """Fallo de un servicio de Azure -> 502."""

    def __init__(self, msg, detail=None):
        super().__init__(msg)
        self.detail = detail


def container_name():
    return os.environ.get("AUDIO_CONTAINER", "grabaciones")


def _sas_ttl():
    try:
        return max(1, min(120, int(os.environ.get("SAS_TTL_MINUTES", "15"))))
    except ValueError:
        return 15


_svc_cache = {}


def _svc():
    """BlobServiceClient reutilizado entre invocaciones del mismo proceso."""
    cs = os.environ.get("AUDIO_STORAGE_CONNECTION", "")
    # tolera comillas y espacios pegados al copiar el valor desde el portal
    cs = cs.strip().strip('"').strip("'").strip()
    if not cs:
        raise ConfigError("Falta AUDIO_STORAGE_CONNECTION.")

    if _svc_cache.get("cs") == cs and "svc" in _svc_cache:
        return _svc_cache["svc"]

    # el cliente se construye ANTES de poblar la cache: si esto falla, la cache
    # no queda a medias enmascarando el error real en las llamadas siguientes
    try:
        svc = BlobServiceClient.from_connection_string(cs)
    except Exception as e:
        raise ConfigError(
            "AUDIO_STORAGE_CONNECTION no es una cadena de conexion valida (%s: %s). "
            "Debe empezar con DefaultEndpointsProtocol= e incluir AccountName y AccountKey."
            % (type(e).__name__, e)
        )

    _svc_cache.clear()
    _svc_cache["cs"] = cs
    _svc_cache["svc"] = svc
    _svc_cache["container_ready"] = False
    return svc


def _ensure_container(svc):
    """Crea el contenedor si falta, una sola vez por proceso."""
    if _svc_cache.get("container_ready"):
        return
    try:
        svc.create_container(container_name())
    except Exception as e:                     # ya existe, o sin permiso para crear
        logging.info("create_container: %s", e)
    _svc_cache["container_ready"] = True


def sanitize_id(raw):
    """Convierte el ID del cliente en un segmento de ruta seguro para el blob."""
    clean = _ID_RE.sub("-", (raw or "").strip().replace("{", "").replace("}", ""))
    clean = clean.strip("-.")[:80]
    if len(clean) < 3:
        raise UserError("recordId invalido: minimo 3 caracteres utiles.")
    return clean


def make_upload_target(record_id, ext="wav", kind="audio"):
    """Devuelve una URL de subida con SAS acotado a un unico blob.

    kind "video" marca el clip de evidencia: cambia el tipo de contenido y
    antepone un prefijo al nombre, para distinguirlo del audio de la
    conversacion al listar.
    """
    record_id = sanitize_id(record_id)
    ext = str(ext or "wav").lower().lstrip(".")
    if ext not in ALLOWED_EXT:
        raise UserError("Extension no permitida: %s" % ext)

    kind = "video" if str(kind).lower() == "video" else "audio"
    if kind == "video" and ext not in CONTENT_TYPES_VIDEO:
        raise UserError("Extension no permitida para video: %s" % ext)

    svc = _svc()
    _ensure_container(svc)

    key = getattr(svc.credential, "account_key", None)
    if not key:
        raise ConfigError(
            "La connection string no trae AccountKey. Para firmar con identidad "
            "administrada hay que usar un SAS de delegacion de usuario."
        )

    now = datetime.datetime.now(datetime.timezone.utc)
    ttl = _sas_ttl()
    blob_name = "{}/{}{}-{}.{}".format(
        record_id,
        PREFIJO_CLIP if kind == "video" else "",
        now.strftime("%Y%m%d-%H%M%S"), uuid.uuid4().hex[:8], ext
    )

    try:
        token = generate_blob_sas(
            account_name=svc.account_name,
            container_name=container_name(),
            blob_name=blob_name,
            account_key=key,
            permission=BlobSasPermissions(create=True, write=True),
            start=now - datetime.timedelta(minutes=5),      # tolerancia de reloj
            expiry=now + datetime.timedelta(minutes=ttl),
        )
    except Exception as e:
        raise UpstreamError("No se pudo generar el SAS: %s" % e)

    blob_url = "{}/{}/{}".format(svc.url.rstrip("/"), container_name(), blob_name)
    return {
        "blobName": blob_name,
        "blobUrl": blob_url,
        "uploadUrl": "%s?%s" % (blob_url, token),
        "kind": kind,
        "contentType": (CONTENT_TYPES_VIDEO if kind == "video" else CONTENT_TYPES)
                       .get(ext, "application/octet-stream"),
        "expiresOn": (now + datetime.timedelta(minutes=ttl)).isoformat(),
    }


def _sas_lectura(svc, blob_name, minutos=60):
    """SAS de solo lectura para reproducir un audio ya almacenado."""
    key = getattr(svc.credential, "account_key", None)
    if not key:
        return None
    now = datetime.datetime.now(datetime.timezone.utc)
    token = generate_blob_sas(
        account_name=svc.account_name,
        container_name=container_name(),
        blob_name=blob_name,
        account_key=key,
        permission=BlobSasPermissions(read=True),
        start=now - datetime.timedelta(minutes=5),
        expiry=now + datetime.timedelta(minutes=minutos),
    )
    return "{}/{}/{}?{}".format(svc.url.rstrip("/"), container_name(), blob_name, token)


def _nombre_transcripcion(blob_name):
    """La transcripcion vive junto al audio, con el mismo nombre + .json."""
    return blob_name + ".json"


def guardar_transcripcion(blob_name, payload):
    """Persiste la transcripcion para poder recuperarla al reabrir el registro."""
    try:
        svc = _svc()
        cuerpo = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        svc.get_blob_client(container_name(), _nombre_transcripcion(blob_name)).upload_blob(
            cuerpo, overwrite=True,
            content_settings=ContentSettings(content_type="application/json; charset=utf-8"),
        )
        return True
    except Exception as e:
        # que falle el guardado no debe tumbar la transcripcion ya obtenida
        logging.warning("No se pudo guardar la transcripcion de %s: %s", blob_name, e)
        return False


def listar_grabaciones(record_id, con_texto=True):
    """Devuelve las grabaciones de un ID con su transcripcion, si existe."""
    rid = sanitize_id(record_id)
    prefijo = rid + "/"
    svc = _svc()
    cc = svc.get_container_client(container_name())

    try:
        blobs = list(cc.list_blobs(name_starts_with=prefijo, include=["metadata"]))
    except Exception as e:
        raise UpstreamError("No se pudo listar el contenedor: %s" % e)

    transcripciones = set(b.name for b in blobs if b.name.endswith(".json"))
    audios = [b for b in blobs if not b.name.endswith(".json")]
    # mas recientes primero: el nombre empieza por fecha y hora
    audios.sort(key=lambda b: b.name, reverse=True)

    items = []
    for b in audios:
        meta = b.metadata or {}
        ctype = (b.content_settings.content_type if b.content_settings else "") or ""
        es_video = (ctype.startswith("video/")
                    or os.path.basename(b.name).startswith(PREFIJO_CLIP))
        item = {
            "kind": "video" if es_video else "audio",
            "blobName": b.name,
            "sizeBytes": b.size,
            "createdAt": (meta.get("createdat")
                          or (b.creation_time.isoformat() if b.creation_time else None)),
            "durationMs": int(meta.get("durationms") or 0) or None,
            "contentType": ctype or None,
            "url": _sas_lectura(svc, b.name),
            "audioUrl": _sas_lectura(svc, b.name),   # alias, compatibilidad
            "transcript": None,
        }
        nombre_t = _nombre_transcripcion(b.name)
        if nombre_t in transcripciones and con_texto:
            try:
                crudo = cc.get_blob_client(nombre_t).download_blob().readall()
                item["transcript"] = json.loads(crudo.decode("utf-8"))
            except Exception as e:
                logging.warning("No se pudo leer %s: %s", nombre_t, e)
                item["transcript"] = {"error": "No se pudo leer la transcripcion almacenada."}
        elif nombre_t in transcripciones:
            item["transcript"] = {"disponible": True}
        items.append(item)

    return {"recordId": rid, "count": len(items), "items": items}


def transcribe_blob(blob_name, locales=None, diarize=0):
    """Descarga el blob y lo transcribe con Fast Transcription de Azure AI Speech."""
    key = os.environ.get("SPEECH_KEY")
    region = os.environ.get("SPEECH_REGION")
    if not key or not region:
        raise ConfigError("Faltan SPEECH_KEY / SPEECH_REGION.")

    blob_name = (blob_name or "").lstrip("/")
    if not blob_name or ".." in blob_name:
        raise UserError("blobName invalido.")

    locales = [str(l) for l in (locales or ["es-CL"])][:MAX_LOCALES]
    try:
        diarize = int(diarize or 0)
    except (TypeError, ValueError):
        diarize = 0

    # _svc() fuera del try: un problema de configuracion no debe disfrazarse
    # de "blob no encontrado"
    svc = _svc()
    try:
        audio = svc.get_blob_client(container_name(), blob_name).download_blob().readall()
    except Exception as e:
        raise UserError("No se pudo leer el blob '%s': %s: %s"
                        % (blob_name, type(e).__name__, e))

    definition = {"locales": locales, "profanityFilterMode": "None"}
    if diarize > 1:
        definition["diarization"] = {"enabled": True, "maxSpeakers": diarize}

    api_version = os.environ.get("SPEECH_API_VERSION", "2024-11-15")
    url = ("https://{}.api.cognitive.microsoft.com"
           "/speechtotext/transcriptions:transcribe?api-version={}").format(region, api_version)

    try:
        r = requests.post(
            url,
            headers={"Ocp-Apim-Subscription-Key": key},
            files={
                "audio": (os.path.basename(blob_name), audio, "application/octet-stream"),
                "definition": (None, json.dumps(definition), "application/json"),
            },
            timeout=600,
        )
    except requests.RequestException as e:
        raise UpstreamError("Fallo al llamar a Azure AI Speech: %s" % e)

    if r.status_code >= 300:
        raise UpstreamError("Azure AI Speech respondio %d" % r.status_code,
                            detail=r.text[:1000])

    data = r.json()
    combined = data.get("combinedPhrases") or []
    phrases = [{
        "offsetMilliseconds": p.get("offsetMilliseconds", 0),
        "durationMilliseconds": p.get("durationMilliseconds", 0),
        "text": p.get("text", ""),
        "speaker": p.get("speaker"),
        "confidence": p.get("confidence"),
    } for p in data.get("phrases", [])]

    resultado = {
        "mock": False,
        "blobName": blob_name,
        "locales": locales,
        "text": combined[0].get("text", "") if combined else "",
        "durationMilliseconds": data.get("durationMilliseconds"),
        "phrases": phrases,
        "raw": data,
    }

    # se persiste para poder recuperarla al reabrir el registro
    resultado["persisted"] = guardar_transcripcion(blob_name, resultado)
    return resultado


STATUS_BY_ERROR = ((UserError, 400), (ConfigError, 500), (UpstreamError, 502))


def error_response(exc):
    """Traduce una excepcion del core a (status, cuerpo json)."""
    for kind, status in STATUS_BY_ERROR:
        if isinstance(exc, kind):
            body = {"error": str(exc)}
            if getattr(exc, "detail", None):
                body["detail"] = exc.detail
            return status, body
    logging.exception("Error no previsto")
    # se incluye el tipo: un str(exc) suelto puede ser ilegible (p. ej. un
    # KeyError se serializa solo como el nombre de la clave)
    return 500, {"error": "Error interno: %s: %s" % (type(exc).__name__, exc)}
