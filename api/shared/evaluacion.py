"""
Verificacion de cumplimiento de guion sobre una transcripcion, con Azure OpenAI.

Que hace: dado el texto de una conversacion y una lista de puntos a verificar
("se ofrecieron creditos?", "se explicaron los beneficios?"), responde por cada
punto si se cubrio, con la CITA TEXTUAL que lo respalda.

Tambien extrae los datos de la solicitud (monto, ingresos, RUT) dichos en la
conversacion, con la misma regla: sin cita textual no hay dato.

Que NO hace: calificar a la persona. Devuelve indicios sobre el contenido de la
conversacion para que alguien los revise. Por eso toda respuesta afirmativa
exige evidencia citada: sin cita, no hay afirmacion que sostener.

Variables de entorno:
  AOAI_ENDPOINT     https://<recurso>.openai.azure.com
  AOAI_KEY          clave del recurso
  AOAI_DEPLOYMENT   nombre del despliegue del modelo (p. ej. gpt-4o-mini)
  AOAI_API_VERSION  version de la API (por defecto 2024-10-21)
  EVAL_CRITERIOS    puntos por defecto, uno por linea
"""

import json
import logging
import os
import re

import requests

MAX_CRITERIOS = 20
MAX_TEXTO = 60000

CRITERIOS_POR_DEFECTO = [
    "¿Sabía ud. que tiene un crédito preaprobado?",
    "¿El funcionario explicó los beneficios?",
    "¿Se informó sobre Coopeuch Educa?",
]

INSTRUCCIONES = (
    "Eres un asistente de control de calidad. Recibes la transcripción de una "
    "conversación de atención a un cliente y una lista de puntos a verificar.\n\n"
    "Para cada punto responde si el tema fue cubierto en la conversación:\n"
    '  "si"      el tema se trató de forma explícita\n'
    '  "parcial" se mencionó de pasada o de forma incompleta\n'
    '  "no"      no aparece en la conversación\n\n'
    "Reglas estrictas:\n"
    "1. Toda respuesta \"si\" o \"parcial\" DEBE incluir en \"evidencia\" una cita "
    "textual literal de la transcripción. Si no puedes citar, la respuesta es \"no\".\n"
    "2. No inventes contenido que no esté en la transcripción.\n"
    "3. No evalúes ni califiques a las personas. Limítate a constatar si el tema "
    "aparece o no. No uses adjetivos sobre el desempeño.\n"
    "4. La transcripción viene de reconocimiento automático y puede tener errores; "
    "si una parte es ambigua, usa \"parcial\" y dilo en la justificación.\n\n"
    "Responde SOLO un objeto JSON con esta forma:\n"
    '{"resultados":[{"indice":1,"cumple":"si|parcial|no",'
    '"evidencia":"cita literal o null","justificacion":"una frase breve"}]}'
)


def _json_del_texto(texto):
    """Extrae el objeto JSON de la respuesta.

    Con response_format el contenido es JSON puro, pero si el modelo no admite
    ese parametro puede venir envuelto en texto o en un bloque de codigo.
    """
    if not texto:
        return None
    texto = texto.strip()
    try:
        return json.loads(texto)
    except Exception:
        pass
    bloque = re.search(r"```(?:json)?\s*(.+?)```", texto, re.S)
    if bloque:
        try:
            return json.loads(bloque.group(1).strip())
        except Exception:
            pass
    ini, fin = texto.find("{"), texto.rfind("}")
    if ini != -1 and fin > ini:
        try:
            return json.loads(texto[ini:fin + 1])
        except Exception:
            pass
    return None


class EvalConfigError(Exception):
    pass


class EvalUpstreamError(Exception):
    def __init__(self, msg, detail=None):
        super().__init__(msg)
        self.detail = detail


def criterios_por_defecto():
    crudo = os.environ.get("EVAL_CRITERIOS", "")
    lista = [c.strip() for c in crudo.replace("\r", "").split("\n") if c.strip()]
    return lista or list(CRITERIOS_POR_DEFECTO)


def disponible():
    return bool(os.environ.get("AOAI_ENDPOINT") and os.environ.get("AOAI_KEY")
                and os.environ.get("AOAI_DEPLOYMENT"))


def _chat(instrucciones, usuario):
    """Una llamada a Azure OpenAI que debe responder JSON.

    Devuelve (objeto JSON, uso de tokens, nombre del despliegue).
    """
    endpoint = (os.environ.get("AOAI_ENDPOINT") or "").rstrip("/")
    key = os.environ.get("AOAI_KEY")
    deployment = os.environ.get("AOAI_DEPLOYMENT")
    api_version = os.environ.get("AOAI_API_VERSION", "2024-10-21")
    if not (endpoint and key and deployment):
        # se nombra exactamente lo que falta: "faltan las tres" y "falta una"
        # son problemas distintos y conviene distinguirlos de inmediato
        faltan = [n for n, v in (("AOAI_ENDPOINT", endpoint),
                                 ("AOAI_KEY", key),
                                 ("AOAI_DEPLOYMENT", deployment)) if not v]
        presentes = [n for n in ("AOAI_ENDPOINT", "AOAI_KEY", "AOAI_DEPLOYMENT")
                     if n not in faltan]
        raise EvalConfigError(
            "Azure OpenAI sin configurar. Falta: %s.%s" % (
                ", ".join(faltan),
                (" Presentes: %s." % ", ".join(presentes)) if presentes else
                " El runtime no ve ninguna de las tres: revise que los cambios en "
                "las variables de entorno se hayan aplicado."))

    url = "%s/openai/deployments/%s/chat/completions?api-version=%s" % (
        endpoint, deployment, api_version)

    cabeceras = {"api-key": key, "Content-Type": "application/json"}
    cuerpo = {
        "messages": [
            {"role": "system", "content": instrucciones},
            {"role": "user", "content": usuario},
        ],
        "temperature": 0,
        "response_format": {"type": "json_object"},
    }

    def pedir(payload):
        try:
            return requests.post(url, headers=cabeceras, json=payload, timeout=120)
        except requests.RequestException as e:
            raise EvalUpstreamError("Fallo al llamar a Azure OpenAI: %s" % e)

    r = pedir(cuerpo)

    # Los modelos de razonamiento rechazan temperature y algunos no aceptan
    # response_format. Antes de darlo por error se reintenta sin el parametro
    # que la propia respuesta senala, para no atar el codigo a un modelo.
    if r.status_code == 400:
        detalle = (r.text or "").lower()
        quitados = []
        for parametro in ("temperature", "response_format"):
            if parametro in detalle and parametro in cuerpo:
                cuerpo.pop(parametro)
                quitados.append(parametro)
        if quitados:
            logging.info("Azure OpenAI rechazo %s; se reintenta sin ese parametro",
                         ", ".join(quitados))
            r = pedir(cuerpo)

    if r.status_code >= 300:
        raise EvalUpstreamError("Azure OpenAI respondio %d" % r.status_code,
                                detail=r.text[:800])

    try:
        contenido = r.json()["choices"][0]["message"]["content"]
    except Exception as e:
        raise EvalUpstreamError("Respuesta inesperada de Azure OpenAI: %s" % e)

    datos = _json_del_texto(contenido)
    if datos is None:
        raise EvalUpstreamError(
            "El modelo no devolvio JSON interpretable.",
            detail=(contenido or "")[:500])

    return datos, (r.json().get("usage") or {}), deployment


def evaluar(texto, criterios=None):
    """Devuelve el resultado por criterio. No persiste nada."""
    texto = (texto or "").strip()
    if not texto:
        raise ValueError("No hay transcripción que revisar.")
    texto = texto[:MAX_TEXTO]

    criterios = [str(c).strip() for c in (criterios or criterios_por_defecto()) if str(c).strip()]
    criterios = criterios[:MAX_CRITERIOS]
    if not criterios:
        raise ValueError("No hay puntos que verificar.")

    numerados = "\n".join("%d. %s" % (i + 1, c) for i, c in enumerate(criterios))
    usuario = ("PUNTOS A VERIFICAR:\n%s\n\nTRANSCRIPCIÓN:\n%s" % (numerados, texto))
    datos, uso, deployment = _chat(INSTRUCCIONES, usuario)

    crudos = datos.get("resultados") or []
    salida = []
    for i, criterio in enumerate(criterios):
        encontrado = next((x for x in crudos if int(x.get("indice", 0) or 0) == i + 1), None)
        if encontrado is None and i < len(crudos):
            encontrado = crudos[i]
        cumple = str((encontrado or {}).get("cumple", "no")).lower()
        if cumple not in ("si", "sí", "parcial", "no"):
            cumple = "no"
        if cumple == "sí":
            cumple = "si"
        evidencia = (encontrado or {}).get("evidencia")
        evidencia = str(evidencia).strip() if evidencia else None

        # sin cita no hay afirmacion que sostener: se degrada a "no"
        if cumple in ("si", "parcial") and not evidencia:
            cumple = "no"

        salida.append({
            "indice": i + 1,
            "criterio": criterio,
            "cumple": cumple,
            "evidencia": evidencia,
            "justificacion": str((encontrado or {}).get("justificacion") or "").strip() or None,
        })

    return {
        "mock": False,
        "resultados": salida,
        "modelo": deployment,
        "tokens": uso.get("total_tokens"),
        "aviso": ("Indicio automático sobre el contenido de la conversación. "
                  "No constituye una evaluación de la persona ni reemplaza una revisión humana."),
    }


# ---- datos de la solicitud -------------------------------------------------

INSTRUCCIONES_EXTRAER = (
    "Eres un asistente que toma nota durante una conversación de atención a un "
    "cliente. Recibes la transcripción automática y debes extraer estos datos, "
    "SOLO si el cliente los dijo de forma explícita:\n"
    "  monto_solicitado    monto del crédito que el cliente pide, en pesos chilenos\n"
    "  ingresos_mensuales  ingreso mensual del cliente, en pesos chilenos\n"
    "  rut                 RUT chileno del cliente\n\n"
    "Reglas estrictas:\n"
    "1. Cada dato que entregues DEBE traer en \"evidencia\" la cita textual literal "
    "de la transcripción de donde sale. Si no puedes citar, el valor es null.\n"
    "2. Montos como número entero de pesos, sin puntos ni símbolos: \"un millón y "
    "medio\" es 1500000, \"ochocientas cincuenta lucas\" es 850000.\n"
    "3. RUT como cuerpo sin puntos, guion y dígito verificador: \"12345678-5\". "
    "La letra K va en mayúscula. No completes ni inventes dígitos que no se dijeron.\n"
    "4. Si un dato se dijo más de una vez, usa la última mención: suele ser una corrección.\n"
    "5. No confundas el monto solicitado con los ingresos ni con otras cifras "
    "(cuotas, plazos, tasas). Ante la duda, null.\n"
    "6. La transcripción viene de reconocimiento de voz y puede tener errores.\n\n"
    "Responde SOLO un objeto JSON con esta forma:\n"
    '{"monto_solicitado":{"valor":1500000,"evidencia":"cita"},'
    '"ingresos_mensuales":{"valor":null,"evidencia":null},'
    '"rut":{"valor":"12345678-5","evidencia":"cita"}}'
)

CAMPOS_EXTRAER = ("monto_solicitado", "ingresos_mensuales", "rut")
_RUT_RE = re.compile(r"^(\d{1,8})-([\dK])$")


def rut_valido(rut):
    """Comprueba el digito verificador (modulo 11) de un RUT "12345678-5"."""
    m = _RUT_RE.match(rut or "")
    if not m:
        return False
    cuerpo, dv = m.group(1), m.group(2)
    suma, factor = 0, 2
    for d in reversed(cuerpo):
        suma += int(d) * factor
        factor = 2 if factor == 7 else factor + 1
    esperado = 11 - suma % 11
    esperado = "0" if esperado == 11 else "K" if esperado == 10 else str(esperado)
    return dv == esperado


def _normalizar_rut(v):
    t = re.sub(r"[^0-9kK]", "", str(v or "")).upper()
    if len(t) < 2:
        return None
    return "%s-%s" % (t[:-1].lstrip("0") or "0", t[-1])


def _normalizar_monto(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        n = int(round(v))
    else:
        digitos = re.sub(r"[^0-9]", "", str(v or ""))
        n = int(digitos) if digitos else 0
    return n if n > 0 else None


def extraer(texto, campos=None):
    """Datos de la solicitud dichos en la conversacion. No persiste nada.

    Sin cita no hay dato: un valor sin evidencia se descarta. El RUT trae
    ademas si su digito verificador es valido, para que la pagina lo advierta.
    """
    texto = (texto or "").strip()
    if not texto:
        raise ValueError("No hay transcripción de la que extraer datos.")
    texto = texto[-MAX_TEXTO:]
    pedidos = [c for c in (campos or CAMPOS_EXTRAER) if c in CAMPOS_EXTRAER]
    if not pedidos:
        raise ValueError("No hay campos que extraer.")

    datos, uso, deployment = _chat(INSTRUCCIONES_EXTRAER,
                                   "TRANSCRIPCIÓN:\n%s" % texto)

    salida = {}
    for campo in pedidos:
        crudo = datos.get(campo) or {}
        if not isinstance(crudo, dict):
            crudo = {"valor": crudo}
        evidencia = crudo.get("evidencia")
        evidencia = str(evidencia).strip() if evidencia else None
        if campo == "rut":
            valor = _normalizar_rut(crudo.get("valor"))
        else:
            valor = _normalizar_monto(crudo.get("valor"))
        if valor is None or not evidencia:
            salida[campo] = None
            continue
        item = {"valor": valor, "evidencia": evidencia}
        if campo == "rut":
            item["dvValido"] = rut_valido(valor)
        salida[campo] = item

    # solo conteos: los valores son datos personales y no van al log
    logging.info("Extraccion: %d de %d campos con dato",
                 sum(1 for v in salida.values() if v), len(pedidos))
    return {
        "mock": False,
        "datos": salida,
        "modelo": deployment,
        "tokens": uso.get("total_tokens"),
    }
