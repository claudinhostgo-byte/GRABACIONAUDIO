/*
 * Recurso web JavaScript para el formulario de Caso (incident).
 *
 * 1. Muestra el grabador en una pestana del formulario, pasandole el numero de
 *    caso como parametro de indexacion.
 * 2. Recibe la transcripcion de vuelta y la agrega a la Descripcion del caso.
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
 *   a) Dynamics construye el iframe sin el atributo allow="microphone". Un
 *      iframe de otro origen sin ese atributo no puede usar getUserMedia, sin
 *      importar que el usuario acepte el permiso. montar() fija el atributo
 *      ANTES de navegar; asignarlo despues no aplica.
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
    var BASE_URL     = "https://proud-smoke-0ef172d03.5.azurestaticapps.net";
    var IFRAME_NAME  = "IFRAME_grabador";
    var TAB_NAME     = "tab_grabacion";
    var CAMPO_NUMERO = "ticketnumber";
    var CAMPO_DESTINO = "description";

    var FORM_TYPE_CREATE = 1;
    var MAX_TEXTO = 30000;          // recorte defensivo del texto a escribir
    var TIPO_MENSAJE = "wit-transcripcion";

    var _formContext = null;
    var _escuchando = false;

    // ---- utilidades --------------------------------------------------------

    function numeroDeCaso(formContext) {
        var attr = formContext.getAttribute(CAMPO_NUMERO);
        if (!attr) { return null; }
        var valor = attr.getValue();
        if (!valor) { return null; }
        return String(valor).trim() || null;
    }

    function urlGrabador(numeroCaso) {
        return BASE_URL + "/?id=" + encodeURIComponent(numeroCaso) +
               "&lock=1&parent=" + encodeURIComponent(window.location.origin);
    }

    function obtenerTab(formContext) {
        try { return formContext.ui.tabs.get(TAB_NAME); } catch (e) { return null; }
    }

    function aviso(mensaje, nivel) {
        try {
            _formContext.ui.setFormNotification(mensaje, nivel || "INFO", "wit_grabacion");
            setTimeout(function () {
                try { _formContext.ui.clearFormNotification("wit_grabacion"); } catch (e) {}
            }, 8000);
        } catch (e) {
            console.log("WIT.Grabacion: " + mensaje);
        }
    }

    function dosDigitos(n) { return (n < 10 ? "0" : "") + n; }

    function fechaLegible(d) {
        return d.getFullYear() + "-" + dosDigitos(d.getMonth() + 1) + "-" + dosDigitos(d.getDate()) +
               " " + dosDigitos(d.getHours()) + ":" + dosDigitos(d.getMinutes());
    }

    // ---- montaje del iframe ------------------------------------------------

    function montar(formContext, numeroCaso) {
        var control = formContext.getControl(IFRAME_NAME);
        if (!control) {
            console.warn("WIT.Grabacion: no existe el control " + IFRAME_NAME);
            return false;
        }

        var destino = urlGrabador(numeroCaso);

        try {
            var el = control.getObject();
            if (el && el.tagName !== "IFRAME") {
                el = el.querySelector ? el.querySelector("iframe") : null;
            }
            if (el && el.tagName === "IFRAME") {
                if (el.getAttribute("allow") !== "microphone") {
                    el.setAttribute("allow", "microphone");
                    el.setAttribute("src", "about:blank");
                }
                if (el.getAttribute("src") !== destino) {
                    el.setAttribute("src", destino);
                }
                return true;
            }
        } catch (e) {
            console.warn("WIT.Grabacion: no se pudo fijar allow=microphone", e);
        }

        try { control.setSrc(destino); } catch (e2) {
            console.error("WIT.Grabacion: setSrc fallo", e2);
        }
        return false;
    }

    // ---- transcripcion de vuelta ------------------------------------------

    function escucharMensajes() {
        if (_escuchando) { return; }
        window.addEventListener("message", alRecibirMensaje);
        _escuchando = true;
    }

    function alRecibirMensaje(ev) {
        // el remitente tiene que ser exactamente el grabador
        if (ev.origin !== BASE_URL) { return; }
        var d = ev.data;
        if (!d || d.tipo !== TIPO_MENSAJE) { return; }
        if (!_formContext) { return; }

        try {
            escribirTranscripcion(d);
        } catch (e) {
            console.error("WIT.Grabacion: fallo al escribir la transcripcion", e);
            aviso("No se pudo escribir la transcripcion en el caso: " + e.message, "ERROR");
        }
    }

    function escribirTranscripcion(datos) {
        var texto = String(datos.texto || "").trim();
        if (!texto) {
            aviso("La transcripcion llego vacia; no se escribio nada.", "WARNING");
            return;
        }

        var attr = _formContext.getAttribute(CAMPO_DESTINO);
        if (!attr) {
            aviso("El campo Descripcion no esta en el formulario, no se puede escribir la " +
                  "transcripcion. Agreguelo al formulario.", "ERROR");
            return;
        }

        var actual = attr.getValue() || "";

        // idempotencia: si este mismo audio ya se escribio, no duplicar
        if (datos.blobName && actual.indexOf(datos.blobName) !== -1) {
            aviso("Esta grabacion ya estaba registrada en la descripcion.", "INFO");
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
        _formContext.data.save().then(
            function () { aviso("Transcripcion agregada a la descripcion del caso.", "INFO"); },
            function (err) {
                aviso("La transcripcion quedo en el formulario pero no se pudo guardar: " +
                      (err && err.message ? err.message : "error desconocido") +
                      ". Guarde el caso manualmente.", "WARNING");
            }
        );
    }

    // ---- manejadores de eventos -------------------------------------------

    function onLoad(executionContext) {
        _formContext = executionContext.getFormContext();
        var tab = obtenerTab(_formContext);
        var esCreacion = _formContext.ui.getFormType() === FORM_TYPE_CREATE;
        var numeroCaso = numeroDeCaso(_formContext);

        if (esCreacion || !numeroCaso) {
            if (tab) { tab.setVisible(false); }
            return;
        }

        if (tab) { tab.setVisible(true); }
        escucharMensajes();
        montar(_formContext, numeroCaso);

        if (tab && tab.addTabStateChange) {
            tab.addTabStateChange(function () {
                if (tab.getDisplayState() === "expanded") {
                    montar(_formContext, numeroCaso);
                }
            });
        }
    }

    function onSave(executionContext) {
        _formContext = executionContext.getFormContext();
        if (_formContext.ui.getFormType() === FORM_TYPE_CREATE) { return; }
        var numeroCaso = numeroDeCaso(_formContext);
        if (!numeroCaso) { return; }
        var tab = obtenerTab(_formContext);
        if (tab) { tab.setVisible(true); }
        escucharMensajes();
        montar(_formContext, numeroCaso);
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
        Xrm.Navigation.openUrl(urlGrabador(numeroCaso));
    }

    return {
        onLoad: onLoad,
        onSave: onSave,
        abrirEnPestanaNueva: abrirEnPestanaNueva
    };
})();
