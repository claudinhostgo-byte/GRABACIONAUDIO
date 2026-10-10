/*
 * Recurso web JavaScript para el formulario de Caso (incident).
 *
 * 1. Muestra el grabador en hasta tres pestanas del formulario, pasandole el
 *    numero de caso como parametro de indexacion:
 *      - tab_grabacion        -> interfaz completa
 *      - tab_grabacion_simple -> interfaz simplificada (?modo=simple), opcional
 *      - tab_grabacion_vivo   -> simplificada con transcripcion y temas en
 *                                vivo (?modo=vivo), opcional
 * 2. Recibe la transcripcion de vuelta y la agrega a la Descripcion del caso.
 * 3. Recibe los datos de la solicitud que la persona confirmo en la pestana en
 *    vivo (monto solicitado, ingresos mensuales, RUT) y los escribe en sus
 *    campos del caso.
 *
 * Reglas de negocio:
 *   - La pestana permanece oculta mientras el caso no exista (formulario de
 *     creacion): el numero de caso se genera al guardar, y sin el no hay con
 *     que indexar la grabacion.
 *   - La transcripcion se AGREGA al final de la Descripcion, nunca la
 *     reemplaza: ese campo suele traer el problema que reporto el cliente.
 *
 * Dos detalles que hacen que esto funcione:
 *
 *   a) Dynamics construye el iframe sin atributo allow. Un iframe de otro
 *      origen sin ese atributo no puede usar microfono ni camara, sin importar
 *      que el usuario acepte el permiso: el atributo se evalua ANTES que el
 *      permiso. Por eso conceder el permiso en otra ventana no sirve de nada.
 *      montar() fija el atributo ANTES de navegar; asignarlo despues no aplica.
 *      Con el atributo puesto, el navegador pide el permiso dentro del propio
 *      formulario y lo recuerda: una sola vez por usuario y sitio.
 *
 *   b) La pagina no puede escribir en Dataverse (no tiene sesion ni pasaria
 *      CORS). En vez de eso avisa por postMessage y este script escribe con la
 *      sesion del propio usuario. Se le pasa el origen del formulario en la
 *      URL para que dirija el mensaje solo aca, y aca se valida el origen del
 *      remitente antes de aceptar nada.
 *
 * Registro en el formulario:
 *   Evento OnLoad -> WIT.Grabacion.onLoad   (marcar "pasar el contexto")
 *   Evento OnSave -> WIT.Grabacion.onSave   (opcional)
 */

"use strict";

var WIT = WIT || {};

WIT.Grabacion = (function () {

    // ---- configuracion -----------------------------------------------------
    // Version del recurso web. Se sube en cada cambio y viaja en la URL del
    // iframe: ademas de hacerla visible, evita que Dynamics sirva una copia
    // cacheada de la pagina.
    var VERSION      = "2026.10.10-1";

    var BASE_URL     = "https://proud-smoke-0ef172d03.5.azurestaticapps.net";
    // Pestana completa: todos los pasos, clip de evidencia y configuracion.
    var IFRAME_NAME  = "IFRAME_grabador";
    var TAB_NAME     = "tab_grabacion";

    // Pestana simplificada: cuantas personas hablan, grabar y detener. Al
    // detener sube y transcribe sola, y muestra el texto por hablante.
    var IFRAME_SIMPLE = "IFRAME_grabador_simple";
    var TAB_SIMPLE    = "tab_grabacion_simple";

    // Pestana en vivo: la simplificada, mas la conversacion transcrita
    // mientras se habla y los temas (creditos, beneficios) que se marcan solos.
    var IFRAME_VIVO   = "IFRAME_grabador_vivo";
    var TAB_VIVO      = "tab_grabacion_vivo";
    var CAMPO_NUMERO = "ticketnumber";
    var CAMPO_DESTINO = "description";

    // Permisos que el formulario delega al iframe. Sin esto el navegador
    // bloquea microfono y camara antes siquiera de preguntarle al usuario:
    // el atributo se evalua antes que el permiso concedido, de modo que
    // conceder el permiso en otra ventana no levanta este bloqueo.
    var ALLOW = "microphone; camera";

    var FORM_TYPE_CREATE = 1;
    var MAX_TEXTO = 30000;          // recorte defensivo del texto a escribir
    var TIPO_MENSAJE = "wit-transcripcion";
    var TIPO_DATO = "wit-dato";
    var TIPO_DATO_RESULTADO = "wit-dato-resultado";

    // Datos de la solicitud: campo de la pagina -> nombre logico en el caso.
    // El prefijo (wit_) es el del publicador de la solucion: si el suyo es
    // otro, cambielo aqui. Los campos deben estar agregados al formulario.
    var CAMPOS_DATOS = {
        monto:    "wit_montosolicitado",
        ingresos: "wit_ingresosmensuales",
        rut:      "wit_rut"
    };

    // ---- estado por formulario ---------------------------------------------
    // Dynamics mantiene varios formularios vivos a la vez (el caso anterior en
    // el historial, el de creacion que pasa a edicion al guardar, las sesiones
    // multiples) y todos comparten ESTE modulo. Con estado global, el
    // manejador de pestana de un caso terminaba escribiendo su URL en el
    // iframe de otro, y el otro se la devolvia: el grabador recargaba en ciclo
    // con numeros de caso distintos. Por eso no hay estado global del
    // formulario: cada uno tiene su instancia, identificada por el GUID del
    // registro, y todo lo que toca un iframe o un campo pasa por SU formContext.
    var _instancias = {};       // guid -> instancia (ver instanciaPara)
    var _escuchando = false;
    var _conDataOnLoad = typeof WeakSet === "function" ? new WeakSet() : null;
    var MAX_ESCRITURAS = 4;     // reescrituras de una URL ajena antes de rendirse
    var CICLOS_SIN_IFRAME = 50; // ~1 min sin ver ningun iframe: se pausa el vigilante

    var GRABADORES = [
        { tab: TAB_NAME,   control: IFRAME_NAME,   modo: null },
        { tab: TAB_SIMPLE, control: IFRAME_SIMPLE, modo: "simple" },
        { tab: TAB_VIVO,   control: IFRAME_VIVO,   modo: "vivo" }
    ];

    // ---- utilidades --------------------------------------------------------

    function numeroDeCaso(formContext) {
        try {
            var attr = formContext.getAttribute(CAMPO_NUMERO);
            var valor = attr && attr.getValue();
            return valor ? (String(valor).trim() || null) : null;
        } catch (e) {
            return null;            // formulario ya descartado
        }
    }

    function guidDe(formContext) {
        try {
            return String(formContext.data.entity.getId() || "").replace(/[{}]/g, "").toLowerCase();
        } catch (e) {
            return "";
        }
    }

    /** modo: null (completa), "simple" o "vivo". */
    function urlGrabador(numeroCaso, modo) {
        return BASE_URL + "/?id=" + encodeURIComponent(numeroCaso) +
               "&lock=1&parent=" + encodeURIComponent(window.location.origin) +
               (modo ? "&modo=" + encodeURIComponent(modo) : "") +
               "&v=" + encodeURIComponent(VERSION);
    }

    function obtenerTab(formContext, nombre) {
        try { return formContext.ui.tabs.get(nombre); } catch (e) { return null; }
    }

    function aviso(inst, mensaje, nivel) {
        try {
            inst.fc.ui.setFormNotification(mensaje, nivel || "INFO", "wit_grabacion");
            setTimeout(function () {
                try { inst.fc.ui.clearFormNotification("wit_grabacion"); } catch (e) {}
            }, 8000);
        } catch (e) {
            console.log("WIT.Grabacion: " + mensaje);
        }
    }

    /**
     * Instancia del formulario: su formContext, su caso y lo que vigila.
     * Si el mismo registro se vuelve a cargar con otro formContext, la anterior
     * se descarta; sus manejadores quedan inertes (ver vigente).
     */
    function instanciaPara(fc) {
        var guid = guidDe(fc), caso = numeroDeCaso(fc);
        if (!guid || !caso) { return null; }
        var inst = _instancias[guid];
        if (inst && inst.fc === fc && inst.caso === caso) { return inst; }
        if (inst) { detener(inst); }
        inst = { guid: guid, fc: fc, caso: caso, objetivos: {}, escrituras: {},
                 vigilante: null, ciclosVacios: 0, guardado: null, tabsRegistradas: false };
        _instancias[guid] = inst;
        return inst;
    }

    /** Sigue siendo la instancia activa de su registro y su formulario no cambio. */
    function vigente(inst) {
        return _instancias[inst.guid] === inst &&
               guidDe(inst.fc) === inst.guid && numeroDeCaso(inst.fc) === inst.caso;
    }

    function dosDigitos(n) { return (n < 10 ? "0" : "") + n; }

    function fechaLegible(d) {
        return d.getFullYear() + "-" + dosDigitos(d.getMonth() + 1) + "-" + dosDigitos(d.getDate()) +
               " " + dosDigitos(d.getHours()) + ":" + dosDigitos(d.getMinutes());
    }

    // ---- montaje del iframe ------------------------------------------------

    /** El iframe del control, buscado SOLO dentro del formulario de la instancia. */
    function buscarIframe(inst, nombreControl) {
        try {
            var c = inst.fc.getControl(nombreControl);
            var o = c && c.getObject && c.getObject();
            if (!o) { return null; }
            if (o.tagName === "IFRAME") { return o; }
            return (o.querySelector && o.querySelector("iframe")) || null;
        } catch (e) {
            return null;            // el control no esta disponible todavia
        }
    }

    /**
     * Asegura que el iframe tenga el atributo allow y la URL de su caso.
     *
     * La interfaz unificada renderiza una pestana recien cuando se abre, y al
     * hacerlo deja el iframe en about:blank. Rellenar un iframe en blanco es
     * lo normal y no tiene tope. Lo que si tiene tope es reemplazar OTRA URL:
     * si algo insiste en cambiarla, se avisa y se deja de pelear.
     */
    function asegurarIframe(inst, nombreControl) {
        var destino = inst.objetivos[nombreControl];
        var el = buscarIframe(inst, nombreControl);
        if (!el || !destino) { return false; }

        var src = el.getAttribute("src") || "";
        var faltaAllow = el.getAttribute("allow") !== ALLOW;
        var faltaSrc = src !== destino;
        if (!faltaAllow && !faltaSrc) { return true; }

        var enBlanco = !src || src === "about:blank";
        if (!enBlanco && faltaSrc) {
            var n = inst.escrituras[nombreControl] || 0;
            if (n >= MAX_ESCRITURAS) {
                if (n === MAX_ESCRITURAS) {
                    inst.escrituras[nombreControl] = n + 1;
                    console.warn("WIT.Grabacion: " + nombreControl + " del caso " + inst.caso +
                                 " fue cambiado " + MAX_ESCRITURAS + " veces desde afuera; " +
                                 "se deja de insistir. src actual: " + src);
                }
                return true;
            }
            inst.escrituras[nombreControl] = n + 1;
        }

        // El atributo allow SOLO aplica en una navegacion nueva: si falta, hay
        // que recargar el iframe o el microfono queda bloqueado aunque el
        // atributo figure en el elemento.
        if (faltaAllow) {
            el.setAttribute("allow", ALLOW);
            el.setAttribute("src", "about:blank");
            setTimeout(function () {
                try { el.setAttribute("src", destino); } catch (e) {}
            }, 50);
        } else {
            el.setAttribute("src", destino);
        }
        console.log("WIT.Grabacion: " + nombreControl + " montado para " + inst.caso +
                    (faltaAllow ? " (con recarga para aplicar allow)" : ""));
        return true;
    }

    function detener(inst) {
        if (inst.vigilante) { clearInterval(inst.vigilante); inst.vigilante = null; }
    }

    /**
     * Revisa periodicamente los iframes de UNA instancia. Es barato y hace el
     * montaje inmune al momento en que la UCI renderice la pestana. Se pausa
     * si la instancia deja de estar vigente o si pasa un rato sin ver ninguno
     * de sus iframes (otra pestana abierta o formulario cerrado); abrir una
     * pestana del grabador lo reanuda.
     */
    function vigilar(inst) {
        if (inst.vigilante) { return; }
        inst.ciclosVacios = 0;
        inst.vigilante = setInterval(function () {
            if (!vigente(inst)) { detener(inst); return; }
            var vistos = 0;
            for (var nombre in inst.objetivos) {
                if (asegurarIframe(inst, nombre)) { vistos++; }
            }
            inst.ciclosVacios = vistos ? 0 : inst.ciclosVacios + 1;
            if (inst.ciclosVacios >= CICLOS_SIN_IFRAME) { detener(inst); }
        }, 1200);
    }

    /**
     * Registra la URL del grabador en su control. setSrc va una sola vez por
     * URL: repetirlo en cada cambio de pestana recargaba la pagina y cortaba
     * una grabacion en curso.
     */
    function montar(inst, g) {
        var control = null;
        try { control = inst.fc.getControl(g.control); } catch (e) {}
        if (!control) { return false; }     // cada pestana es opcional

        var destino = urlGrabador(inst.caso, g.modo);
        if (inst.objetivos[g.control] !== destino) {
            inst.objetivos[g.control] = destino;
            inst.escrituras[g.control] = 0;
            try { control.setSrc(destino); } catch (e) {
                console.error("WIT.Grabacion: setSrc fallo en " + g.control, e);
            }
        }
        asegurarIframe(inst, g.control);
        vigilar(inst);
        return true;
    }

    function mostrarPestanas(fc, visibles) {
        GRABADORES.forEach(function (g) {
            var t = obtenerTab(fc, g.tab);
            if (t) { t.setVisible(visibles); }
        });
    }

    /**
     * Deja el formulario listo: pestanas visibles y grabadores montados para
     * su caso. Es idempotente; se llama al cargar, al guardar y en cada
     * recarga de datos, y solo actua si algo cambio.
     */
    function activar(fc) {
        var esCreacion = false;
        try { esCreacion = fc.ui.getFormType() === FORM_TYPE_CREATE; } catch (e) {}
        var inst = esCreacion ? null : instanciaPara(fc);
        if (!inst) {
            // sin numero de caso todavia (formulario de creacion): nada que indexar
            mostrarPestanas(fc, false);
            return;
        }

        mostrarPestanas(fc, true);
        escucharMensajes();
        GRABADORES.forEach(function (g) { montar(inst, g); });

        if (!inst.tabsRegistradas) {
            inst.tabsRegistradas = true;
            GRABADORES.forEach(function (g) {
                var t = obtenerTab(fc, g.tab);
                if (!t || !t.addTabStateChange) { return; }
                t.addTabStateChange(function () {
                    // un manejador de una instancia reemplazada no hace nada
                    if (_instancias[inst.guid] !== inst) { return; }
                    if (t.getDisplayState() === "expanded") { montar(inst, g); }
                });
            });
        }
    }

    // ---- transcripcion de vuelta ------------------------------------------

    function escucharMensajes() {
        if (_escuchando) { return; }
        window.addEventListener("message", alRecibirMensaje);
        _escuchando = true;
    }

    /**
     * La instancia cuyo iframe envio el mensaje. Es la unica forma segura de
     * saber a que caso pertenece: con varios formularios vivos, "el ultimo
     * cargado" puede ser otro.
     */
    function instanciaDeFuente(fuente) {
        for (var guid in _instancias) {
            var inst = _instancias[guid];
            if (!vigente(inst)) { continue; }
            for (var nombre in inst.objetivos) {
                var el = buscarIframe(inst, nombre);
                if (el && el.contentWindow === fuente) { return inst; }
            }
        }
        return null;
    }

    function alRecibirMensaje(ev) {
        // el remitente tiene que ser exactamente el grabador
        if (ev.origin !== BASE_URL) { return; }
        var d = ev.data;
        if (!d || (d.tipo !== TIPO_DATO && d.tipo !== TIPO_MENSAJE)) { return; }

        var inst = instanciaDeFuente(ev.source);
        if (!inst) {
            console.warn("WIT.Grabacion: mensaje de un grabador que no pertenece a ningun " +
                         "formulario abierto; se ignora.");
            return;
        }

        if (d.tipo === TIPO_DATO) {
            escribirDato(inst, d, ev.source);
            return;
        }
        try {
            escribirTranscripcion(inst, d);
        } catch (e) {
            console.error("WIT.Grabacion: fallo al escribir la transcripcion", e);
            aviso(inst, "No se pudo escribir la transcripcion en el caso: " + e.message, "ERROR");
        }
    }

    // ---- datos de la solicitud --------------------------------------------

    /** Misma normalizacion que usa el grabador para el ID del caso. */
    function idSeguro(v) {
        return String(v || "").trim().replace(/[{}]/g, "")
            .replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
    }

    /** Guarda de a uno: tres OK seguidos no deben pisarse entre si. */
    function guardarEnCola(inst) {
        var anterior = inst.guardado || Promise.resolve();
        inst.guardado = anterior.then(function () {}, function () {}).then(function () {
            return inst.fc.data.save();
        });
        return inst.guardado;
    }

    function escribirDato(inst, d, fuente) {
        function responder(ok, error) {
            try {
                fuente.postMessage({ tipo: TIPO_DATO_RESULTADO, campo: d.campo,
                                     ok: ok, error: error || null }, BASE_URL);
            } catch (e) {
                console.warn("WIT.Grabacion: no se pudo responder al grabador", e);
            }
        }

        // el dato tiene que ser de ESTE caso: si el formulario cambio de
        // registro mientras tanto, se rechaza en vez de escribirlo en otro
        if (idSeguro(d.recordId) !== idSeguro(inst.caso)) {
            responder(false, "El formulario ya no muestra el caso de esta grabacion.");
            return;
        }

        var nombre = CAMPOS_DATOS[d.campo];
        if (!nombre) { responder(false, "Campo desconocido: " + d.campo); return; }

        var attr = inst.fc.getAttribute(nombre);
        if (!attr) {
            responder(false, "El campo " + nombre + " no esta en el formulario del caso.");
            return;
        }

        var tipo = attr.getAttributeType();
        var valor;
        if (tipo === "money" || tipo === "decimal" || tipo === "double" || tipo === "integer") {
            valor = Number(d.valor);
            if (!isFinite(valor)) { responder(false, "El valor no es un numero."); return; }
            if (tipo === "integer") { valor = Math.round(valor); }
        } else {
            valor = String(d.valor == null ? "" : d.valor).trim();
        }

        try {
            attr.setValue(valor);
            attr.setSubmitMode("always");
        } catch (e) {
            responder(false, "No se pudo escribir el campo: " + e.message);
            return;
        }

        // si el guardado falla, el valor igual queda en el formulario y el
        // usuario puede guardar a mano
        guardarEnCola(inst).then(
            function () { responder(true); },
            function (err) {
                var msg = err && err.message ? err.message : "error desconocido";
                aviso(inst, "El dato quedo en el formulario pero no se pudo guardar: " + msg +
                      ". Guarde el caso manualmente.", "WARNING");
                responder(false, "quedo en el formulario pero no se pudo guardar (" + msg + ")");
            }
        );
    }

    function escribirTranscripcion(inst, datos) {
        var texto = String(datos.texto || "").trim();
        if (!texto) {
            aviso(inst, "La transcripcion llego vacia; no se escribio nada.", "WARNING");
            return;
        }

        var attr = inst.fc.getAttribute(CAMPO_DESTINO);
        if (!attr) {
            aviso(inst, "El campo Descripcion no esta en el formulario, no se puede escribir la " +
                  "transcripcion. Agreguelo al formulario.", "ERROR");
            return;
        }

        var actual = attr.getValue() || "";

        // idempotencia: si este mismo audio ya se escribio, no duplicar
        if (datos.blobName && actual.indexOf(datos.blobName) !== -1) {
            aviso(inst, "Esta grabacion ya estaba registrada en la descripcion.", "INFO");
            return;
        }

        if (texto.length > MAX_TEXTO) {
            texto = texto.slice(0, MAX_TEXTO) + "\n[...texto recortado...]";
        }

        var cabecera = [
            "----- Transcripcion de audio -----",
            "Fecha: " + fechaLegible(new Date()),
            "Audio: " + (datos.blobName || "(sin nombre)"),
            "Idioma: " + (datos.locale || "?") +
                (datos.segmentos ? " | segmentos: " + datos.segmentos : "")
        ];
        if (datos.simulado) {
            cabecera.push("AVISO: transcripcion SIMULADA, no proviene de Azure AI Speech.");
        }
        cabecera.push("");

        var bloque = cabecera.join("\n") + texto;
        attr.setValue(actual ? (actual + "\n\n" + bloque) : bloque);

        // el guardado deja el dato en Dataverse; si falla, el texto sigue en el
        // formulario y el usuario puede guardar a mano
        guardarEnCola(inst).then(
            function () { aviso(inst, "Transcripcion agregada a la descripcion del caso.", "INFO"); },
            function (err) {
                aviso(inst, "La transcripcion quedo en el formulario pero no se pudo guardar: " +
                      (err && err.message ? err.message : "error desconocido") +
                      ". Guarde el caso manualmente.", "WARNING");
            }
        );
    }

    // ---- manejadores de eventos -------------------------------------------

    function onLoad(executionContext) {
        console.log("WIT.Grabacion: recurso web version " + VERSION);
        var fc = executionContext.getFormContext();
        // La recarga de datos (tras guardar, incluido el primer guardado de un
        // caso nuevo, que es cuando nace el numero) vuelve a activar el
        // formulario. Se registra una sola vez por formulario.
        try {
            if (fc.data && fc.data.addOnLoad && (!_conDataOnLoad || !_conDataOnLoad.has(fc))) {
                if (_conDataOnLoad) { _conDataOnLoad.add(fc); }
                fc.data.addOnLoad(function () { activar(fc); });
            }
        } catch (e) {
            console.warn("WIT.Grabacion: no se pudo escuchar la recarga de datos", e);
        }
        activar(fc);
    }

    function onSave(executionContext) {
        activar(executionContext.getFormContext());
    }

    function abrirEnPestanaNueva(primaryControl) {
        var formContext = primaryControl;
        var numeroCaso = numeroDeCaso(formContext);
        if (!numeroCaso) {
            Xrm.Navigation.openAlertDialog({
                text: "Guarde el caso antes de grabar: el numero de caso se genera al guardar."
            });
            return;
        }
        Xrm.Navigation.openUrl(urlGrabador(numeroCaso, null));
    }

    return {
        onLoad: onLoad,
        onSave: onSave,
        abrirEnPestanaNueva: abrirEnPestanaNueva
    };
})();
