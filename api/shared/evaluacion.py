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
    "SOLO si se dijeron de forma explícita. Los del cliente los dice el cliente; los "
    "de la oferta los dice normalmente el ejecutivo al presentarla:\n"
    "  monto_solicitado    monto del crédito que el cliente pide, en pesos chilenos\n"
    "  ingresos_mensuales  ingreso mensual del cliente, en pesos chilenos\n"
    "  rut                 RUT chileno del cliente\n"
    "  nombre              nombre(s) de pila del cliente, sin apellidos\n"
    "  apellido_paterno    primer apellido del cliente\n"
    "  apellido_materno    segundo apellido del cliente\n"
    "  telefono            teléfono de contacto del cliente\n"
    "  producto_ofrecido   producto que el ejecutivo ofrece; SOLO uno de: {productos}\n"
    "  monto_oferta        monto que el ejecutivo ofrece, en pesos chilenos\n"
    "  plazo_meses         plazo de la oferta en meses; se suele decir como número de "
    "cuotas (\"en 36 cuotas\", \"36 meses\" y \"tres años\" son 36)\n"
    "  valor_cuota         valor de la cuota mensual ofrecida, en pesos chilenos\n"
    "  tasa                tasa de interés mensual ofrecida, en porcentaje (\"uno coma "
    "ochenta y nueve\" es 1.89)\n"
    "  cae                 carga anual equivalente (CAE), en porcentaje\n"
    "  respuesta_cliente   respuesta del cliente a la oferta; SOLO uno de: {respuestas}\n\n"
    "Reglas estrictas:\n"
    "1. Cada dato que entregues DEBE traer en \"evidencia\" la cita textual literal "
    "de la transcripción de donde sale. Si no puedes citar, el valor es null.\n"
    "2. Montos como número entero de pesos, sin puntos ni símbolos: \"un millón y "
    "medio\" es 1500000, \"ochocientas cincuenta lucas\" es 850000.\n"
    "3. RUT como cuerpo sin puntos, guion y dígito verificador: \"12345678-5\". "
    "La letra K va en mayúscula. No completes ni inventes dígitos que no se dijeron. "
    "El reconocimiento de voz casi nunca escribe bien la palabra RUT: suele aparecer "
    "como \"surat\", \"su rat\", \"mírate\", \"mira\", \"el rap\", \"Ruth\" o \"root\". "
    "Un número de 7 u 8 dígitos seguido de guion (o \"guión\", \"raya\") y un dígito o K "
    "(\"ka\") es el RUT aunque la palabra venga mal escrita. Si el número viene pegado a "
    "otra cifra y no se puede separar con certeza, null.\n"
    "4. Si un dato se dijo más de una vez, usa la última mención: suele ser una corrección.\n"
    "5. No confundas las cifras entre sí: el monto que el cliente pide (monto_solicitado) "
    "no es el que se le ofrece (monto_oferta), y ninguno es una cuota, un plazo, una tasa "
    "ni un ingreso. Ante la duda, null.\n"
    "6. Nombre y apellidos son los del CLIENTE, nunca los del ejecutivo que lo "
    "atiende. Si el cliente dice su nombre completo, sepáralo: \"Juan Pérez Soto\" es "
    "nombre Juan, apellido_paterno Pérez, apellido_materno Soto. Con mayúscula inicial.\n"
    "7. Teléfono solo con dígitos, tal como se dictó (9 dígitos para un celular chileno: "
    "\"nueve ocho siete...\" es 987...). No completes dígitos que faltan.\n"
    "8. producto_ofrecido y respuesta_cliente deben ser EXACTAMENTE uno de los textos "
    "permitidos, o null. La respuesta es la ÚLTIMA postura del cliente frente a la oferta.\n"
    "9. La transcripción viene de reconocimiento de voz y puede tener errores.\n\n"
    "Responde SOLO un objeto JSON con esta forma:\n"
    '{"monto_solicitado":{"valor":1500000,"evidencia":"cita"},'
    '"ingresos_mensuales":{"valor":null,"evidencia":null},'
    '"rut":{"valor":"12345678-5","evidencia":"cita"},'
    '"nombre":{"valor":"Juan","evidencia":"cita"},'
    '"apellido_paterno":{"valor":"Pérez","evidencia":"cita"},'
    '"apellido_materno":{"valor":null,"evidencia":null},'
    '"telefono":{"valor":"987654321","evidencia":"cita"},'
    '"producto_ofrecido":{"valor":"Compra de cartera","evidencia":"cita"},'
    '"monto_oferta":{"valor":5000000,"evidencia":"cita"},'
    '"plazo_meses":{"valor":36,"evidencia":"cita"},'
    '"valor_cuota":{"valor":180000,"evidencia":"cita"},'
    '"tasa":{"valor":1.89,"evidencia":"cita"},'
    '"cae":{"valor":null,"evidencia":null},'
    '"respuesta_cliente":{"valor":"Lo pensará","evidencia":"cita"}}'
)

CAMPOS_EXTRAER = ("monto_solicitado", "ingresos_mensuales", "rut",
                  "nombre", "apellido_paterno", "apellido_materno", "telefono",
                  "producto_ofrecido", "monto_oferta", "plazo_meses", "valor_cuota",
                  "tasa", "cae", "respuesta_cliente")
CAMPOS_MONTO = ("monto_solicitado", "ingresos_mensuales", "monto_oferta", "valor_cuota")
CAMPOS_PORCENTAJE = ("tasa", "cae")
# campos de lista cerrada: la pagina manda las opciones validas
CAMPOS_LISTA = {"producto_ofrecido": "productos", "respuesta_cliente": "respuestas"}
CAMPOS_TEXTO = ("nombre", "apellido_paterno", "apellido_materno")
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


def _normalizar_nombre(v):
    """Mayuscula inicial por palabra; descarta lo que no parece un nombre."""
    t = re.sub(r"\s+", " ", str(v or "")).strip(" .,;")
    if not t or len(t) > 60 or re.search(r"\d", t):
        return None
    minusculas = ("de", "del", "la", "las", "los", "y")
    partes = [w if (i and w.lower() in minusculas) else w[:1].upper() + w[1:].lower()
              for i, w in enumerate(t.split(" "))]
    return " ".join(partes)


def _normalizar_telefono(v):
    """Digitos; un celular chileno de 9 digitos queda como +56 9 XXXX XXXX."""
    d = re.sub(r"\D", "", str(v or ""))
    if d.startswith("56") and len(d) == 11:
        d = d[2:]
    if len(d) == 9 and d.startswith("9"):
        return "+56 9 %s %s" % (d[1:5], d[5:])
    return d if 8 <= len(d) <= 12 else None


def _normalizar_porcentaje(v):
    """Numero con hasta dos decimales; acepta "1,89" o "1.89 %"."""
    if isinstance(v, bool):
        return None
    try:
        n = float(str(v).replace("%", "").replace(",", ".").strip()) if not isinstance(v, (int, float)) else float(v)
    except ValueError:
        return None
    return round(n, 2) if 0 < n < 100 else None


def _normalizar_plazo(v):
    n = _normalizar_monto(v)
    return n if n and n <= 480 else None


def _en_lista(v, opciones):
    """La opcion permitida que coincide, sin distinguir mayusculas."""
    t = str(v or "").strip().lower()
    return next((o for o in opciones if o.lower() == t), None)


def extraer(texto, campos=None, listas=None):
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

    listas = {k: [str(o).strip() for o in (listas or {}).get(k) or [] if str(o).strip()][:50]
              for k in set(CAMPOS_LISTA.values())}
    instrucciones = (INSTRUCCIONES_EXTRAER
                     .replace("{productos}", " | ".join(listas["productos"]) or "(ninguno)")
                     .replace("{respuestas}", " | ".join(listas["respuestas"]) or "(ninguna)"))
    datos, uso, deployment = _chat(instrucciones, "TRANSCRIPCIÓN:\n%s" % texto)

    salida = {}
    for campo in pedidos:
        crudo = datos.get(campo) or {}
        if not isinstance(crudo, dict):
            crudo = {"valor": crudo}
        evidencia = crudo.get("evidencia")
        evidencia = str(evidencia).strip() if evidencia else None
        if campo == "rut":
            valor = _normalizar_rut(crudo.get("valor"))
        elif campo in CAMPOS_TEXTO:
            valor = _normalizar_nombre(crudo.get("valor"))
        elif campo == "telefono":
            valor = _normalizar_telefono(crudo.get("valor"))
        elif campo in CAMPOS_LISTA:
            valor = _en_lista(crudo.get("valor"), listas[CAMPOS_LISTA[campo]])
        elif campo in CAMPOS_PORCENTAJE:
            valor = _normalizar_porcentaje(crudo.get("valor"))
        elif campo == "plazo_meses":
            valor = _normalizar_plazo(crudo.get("valor"))
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


# ---- clasificacion de la atencion ------------------------------------------

INSTRUCCIONES_CLASIFICAR = (
    "Eres un asistente que clasifica conversaciones de atención a clientes de una "
    "cooperativa financiera. Recibes la transcripción y una lista NUMERADA de "
    "combinaciones posibles de Clasificación > Motivo > Submotivo.\n\n"
    "Elige la combinación que mejor describe el motivo PRINCIPAL por el que el "
    "cliente se contactó.\n\n"
    "Reglas estrictas:\n"
    "1. Solo puedes elegir un número de la lista. No inventes combinaciones.\n"
    "2. \"evidencia\" DEBE ser una cita textual literal de la transcripción que "
    "respalde la elección. Si ninguna combinación calza o no puedes citar, "
    "responde opcion null.\n"
    "3. Si se trataron varios temas, prima el que motivó el contacto; un "
    "ofrecimiento hecho por el ejecutivo no es el motivo del cliente.\n"
    "4. No evalúes a las personas.\n\n"
    "Además redacta \"comentarios\": el registro de la gestión para el sistema, en 2 a 4 "
    "frases, en tercera persona y en tono de bitácora (por ejemplo: \"Se conversa con el "
    "socio, se da a conocer la oferta...\"). Incluye el motivo, lo ofrecido y la respuesta "
    "del cliente. Solo hechos de la conversación; sin RUT, teléfonos ni montos de ingresos; "
    "sin opiniones sobre las personas.\n\n"
    "Responde SOLO un objeto JSON con esta forma:\n"
    '{"opcion":3,"evidencia":"cita literal","justificacion":"una frase breve",'
    '"comentarios":"Se conversa con ..."}'
)


def clasificar(texto, opciones):
    """Elige una combinacion del catalogo que manda la pagina. No persiste nada.

    `opciones` es una lista de [clasificacion, motivo, submotivo]. El modelo
    solo puede devolver el numero de una de ellas, y sin cita no hay propuesta.
    """
    texto = (texto or "").strip()
    if not texto:
        raise ValueError("No hay transcripción que clasificar.")
    texto = texto[-MAX_TEXTO:]

    validas = []
    for o in (opciones or [])[:200]:
        if isinstance(o, (list, tuple)) and len(o) == 3 and all(str(x).strip() for x in o):
            validas.append([str(x).strip() for x in o])
    if not validas:
        raise ValueError("No hay catálogo con el que clasificar.")

    lista = "\n".join("%d. %s > %s > %s" % (i + 1, c, m, sm) for i, (c, m, sm) in enumerate(validas))
    datos, uso, deployment = _chat(INSTRUCCIONES_CLASIFICAR,
                                   "OPCIONES:\n%s\n\nTRANSCRIPCIÓN:\n%s" % (lista, texto))

    propuesta = None
    try:
        n = int(datos.get("opcion"))
    except (TypeError, ValueError):
        n = 0
    evidencia = datos.get("evidencia")
    evidencia = str(evidencia).strip() if evidencia else None
    if 1 <= n <= len(validas) and evidencia:
        c, m, sm = validas[n - 1]
        propuesta = {"clasificacion": c, "motivo": m, "submotivo": sm,
                     "evidencia": evidencia,
                     "justificacion": str(datos.get("justificacion") or "").strip() or None}

    comentarios = str(datos.get("comentarios") or "").strip()[:2000] or None

    logging.info("Clasificacion: %s", "con propuesta" if propuesta else "sin propuesta")
    return {
        "mock": False,
        "propuesta": propuesta,
        "comentarios": comentarios,
        "modelo": deployment,
        "tokens": uso.get("total_tokens"),
        "aviso": ("Propuesta automática a partir de la conversación. "
                  "La decide la persona que atiende."),
    }
