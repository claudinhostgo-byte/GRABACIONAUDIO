/*
 * Recurso web JavaScript para el formulario de Caso (incident).
 *
 * Muestra el grabador en una pestana del formulario, pasandole el numero de
 * caso como parametro de indexacion.
 *
 * Reglas de negocio:
 *   - La pestana permanece oculta mientras el caso no exista (formulario de
 *     creacion): el numero de caso se genera al guardar, y sin el no hay con
 *     que indexar la grabacion.
 *   - Una vez guardado, la pestana aparece y el iframe carga el grabador con
 *     ?id=<numero de caso>&lock=1, que prefija y bloquea el ID en la pagina.
 *
 * El detalle importante: Dynamics construye el iframe sin el atributo
 * allow="microphone". Sin ese atributo el navegador bloquea getUserMedia en un
 * iframe de otro origen, sin importar que el usuario acepte el permiso. Por eso
 * montar() fija el atributo antes de navegar. El atributo debe estar presente
 * ANTES de que el iframe cargue el documento; asignarlo despues no sirve.
 *
 * Registro en el formulario:
 *   Evento OnLoad  -> WIT.Grabacion.onLoad     (pasar el contexto de ejecucion)
 *   Evento OnSave  -> WIT.Grabacion.onSave     (opcional, refresca tras guardar)
 */

"use strict";

var WIT = WIT || {};

WIT.Grabacion = (function () {

    // ---- configuracion -----------------------------------------------------
    var BASE_URL     = "https://proud-smoke-0ef172d03.5.azurestaticapps.net";
    var IFRAME_NAME  = "IFRAME_grabador";   // nombre del control IFRAME en el formulario
    var TAB_NAME     = "tab_grabacion";     // nombre de la pestana que lo contiene
    var CAMPO_NUMERO = "ticketnumber";      // numero de caso

    var FORM_TYPE_CREATE = 1;

    // ---- utilidades --------------------------------------------------------

    function numeroDeCaso(formContext) {
        var attr = formContext.getAttribute(CAMPO_NUMERO);
        if (!attr) { return null; }
        var valor = attr.getValue();
        if (!valor) { return null; }
        return String(valor).trim() || null;
    }

    function urlGrabador(numeroCaso) {
        return BASE_URL + "/?id=" + encodeURIComponent(numeroCaso) + "&lock=1";
    }

    function obtenerTab(formContext) {
        try {
            return formContext.ui.tabs.get(TAB_NAME);
        } catch (e) {
            return null;
        }
    }

    /**
     * Carga el grabador en el iframe, garantizando allow="microphone".
     * Devuelve true si se pudo fijar el atributo, false si hubo que caer al
     * metodo soportado sin el (el microfono quedaria bloqueado).
     */
    function montar(formContext, numeroCaso) {
        var control = formContext.getControl(IFRAME_NAME);
        if (!control) {
            console.warn("WIT.Grabacion: no existe el control " + IFRAME_NAME);
            return false;
        }

        var destino = urlGrabador(numeroCaso);

        try {
            var el = control.getObject();
            // getObject puede devolver un contenedor; se busca el iframe dentro
            if (el && el.tagName !== "IFRAME") {
                el = el.querySelector ? el.querySelector("iframe") : null;
            }

            if (el && el.tagName === "IFRAME") {
                if (el.getAttribute("allow") !== "microphone") {
                    el.setAttribute("allow", "microphone");
                    // se fuerza una navegacion limpia para que el atributo aplique
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

        // Respaldo con la API soportada. La pagina detecta que el microfono esta
        // bloqueado y ofrece abrirse en una pestana nueva.
        try {
            control.setSrc(destino);
        } catch (e2) {
            console.error("WIT.Grabacion: setSrc fallo", e2);
        }
        return false;
    }

    // ---- manejadores de eventos -------------------------------------------

    function onLoad(executionContext) {
        var formContext = executionContext.getFormContext();
        var tab = obtenerTab(formContext);
        var esCreacion = formContext.ui.getFormType() === FORM_TYPE_CREATE;
        var numeroCaso = numeroDeCaso(formContext);

        // sin caso guardado no hay numero con que indexar: pestana oculta
        if (esCreacion || !numeroCaso) {
            if (tab) { tab.setVisible(false); }
            return;
        }

        if (tab) { tab.setVisible(true); }

        // Se monta al cargar y tambien al expandir la pestana: si el formulario
        // la abre colapsada, el iframe puede no estar en el DOM todavia.
        montar(formContext, numeroCaso);

        if (tab && tab.addTabStateChange) {
            tab.addTabStateChange(function () {
                if (tab.getDisplayState() === "expanded") {
                    montar(formContext, numeroCaso);
                }
            });
        }
    }

    /**
     * Tras guardar un caso nuevo el formulario se recarga y onLoad hace el
     * trabajo. Este manejador solo cubre el caso de un guardado que no recarga.
     */
    function onSave(executionContext) {
        var formContext = executionContext.getFormContext();
        if (formContext.ui.getFormType() === FORM_TYPE_CREATE) { return; }
        var numeroCaso = numeroDeCaso(formContext);
        if (!numeroCaso) { return; }
        var tab = obtenerTab(formContext);
        if (tab) { tab.setVisible(true); }
        montar(formContext, numeroCaso);
    }

    /**
     * Abre el grabador en una pestana nueva del navegador, como pagina de nivel
     * superior. Es la via mas confiable para el microfono: no depende de que el
     * iframe delegue el permiso. Se puede enganchar a un boton de la cinta.
     */
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
