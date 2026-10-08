/*
 * Recurso web JavaScript para el formulario de Caso (incident).
 *
 * 1. Muestra el grabador en una o dos pestanas del formulario, pasandole el
 *    numero de caso como parametro de indexacion:
 *      - tab_grabacion        -> interfaz completa
 *      - tab_grabacion_simple -> interfaz simplificada (?modo=simple), opcional
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
    var VERSION      = "2026.10.08-2";

    var BASE_URL     = "https://proud-smoke-0ef172d03.5.azurestaticapps.net";
    // Pestana completa: todos los pasos, clip de evidencia y configuracion.
    var IFRAME_NAME  = "IFRAME_grabador";
    var TAB_NAME     = "tab_grabacion";

    // Pestana simplificada: cuantas personas hablan, grabar y detener. Al
    // detener sube y transcribe sola, y muestra el texto por hablante.
    var IFRAME_SIMPLE = "IFRAME_grabador_simple";
    var TAB_SIMPLE    = "tab_grabacion_simple";
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

    var _formContext = null;
    var _escuchando = false;
    var _vigilante = null;      // intervalo que mantiene los iframes correctos
    var _objetivos = [];        // [{destino, control}] a vigilar
    var _montados = {};         // para no repetir el log de montaje
    var _ciclos = 0;
    var _casoActual = null;     // numero de caso que el vigilante esta sirviendo
    var _escrituras = {};       // cuantas veces se escribio el src de cada control
    var MAX_ESCRITURAS = 4;     // tope duro: ningun ciclo puede pasar de aqui

    // ---- utilidades --------------------------------------------------------

    function numeroDeCaso(formContext) {
        var attr = formContext.getAttribute(CAMPO_NUMERO);
        if (!attr) { return null; }
        var valor = attr.getValue();
        if (!valor) { return null; }
        return String(valor).trim() || null;
    }

    function urlGrabador(numeroCaso, simple) {
        return BASE_URL + "/?id=" + encodeURIComponent(numeroCaso) +
               "&lock=1&parent=" + encodeURIComponent(window.location.origin) +
               (simple ? "&modo=simple" : "") +
               "&v=" + encodeURIComponent(VERSION);
    }

    function obtenerTab(formContext, nombre) {
        try { return formContext.ui.tabs.get(nombre || TAB_NAME); } catch (e) { return null; }
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

    /**
     * Ubica el elemento iframe real. La interfaz unificada no garantiza que
     * getObject() devuelva el iframe, ni que este en el DOM cuando corre
     * OnLoad, asi que hay un segundo camino por src.
     */
    function buscarIframe(destino, nombreControl) {
        var nombre = nombreControl || IFRAME_NAME;

        // Solo a traves del control de ESTE formulario. Antes habia un respaldo
        // que recorria document.getElementsByTagName("iframe") buscando por id
        // o por src: con varios formularios vivos en el mismo DOM (multisesion,
        // panel lateral), el vigilante de un caso encontraba el iframe de otro
        // y le escribia su URL, y el vigilante del otro se la devolvia. El
        // resultado era el iframe recargando en ciclo con numeros de caso
        // distintos.
        try {
            var c = _formContext && _formContext.getControl(nombre);
            if (c && c.getObject) {
                var o = c.getObject();
                if (o) {
                    if (o.tagName === "IFRAME") { return o; }
                    // contenedor del propio control: la busqueda queda acotada a el
                    if (o.querySelector) {
                        var dentro = o.querySelector("iframe");
                        if (dentro) { return dentro; }
                    }
                }
            }
        } catch (e) { /* el control no esta disponible todavia */ }

        return null;
    }

    /**
     * Asegura que el iframe tenga el atributo allow y la URL correcta.
     *
     * La interfaz unificada renderiza el contenido de una pestana recien
     * cuando el usuario la abre, y al hacerlo aplica la URL configurada en el
     * formulario (about:blank), descartando lo que se haya puesto antes. Por
     * eso no basta con reintentar unos segundos tras el OnLoad: hace falta un
     * vigilante que corrija el iframe cada vez que la UCI lo vuelva a armar.
     */
    function asegurarIframe(destino, nombreControl, forzar) {
        var el = buscarIframe(destino, nombreControl);
        if (!el) { return false; }

        var src = el.getAttribute("src") || "";
        var faltaAllow = el.getAttribute("allow") !== ALLOW;
        var yaEsDelGrabador = src.indexOf(BASE_URL) === 0;

        // Regla que cierra el ciclo por construccion: el vigilante NUNCA pisa
        // una URL que ya apunta al grabador, aunque muestre otro numero de
        // caso. Si dos formularios comparten el DOM, pisarla hace que cada uno
        // se la devuelva al otro indefinidamente. Solo el montaje explicito
        // (onLoad, onSave, abrir la pestana) puede forzar el cambio.
        if (!forzar && yaEsDelGrabador && !faltaAllow) { return true; }
        if (!forzar && yaEsDelGrabador && faltaAllow) {
            el.setAttribute("allow", ALLOW);   // sin recargar: evita el ciclo
            return true;
        }

        if (src === destino && !faltaAllow) { return true; }   // ya estaba bien

        // Tope duro por control: si algo externo sigue reescribiendo el src,
        // el script se rinde en vez de pelear para siempre.
        var n = _escrituras[nombreControl] || 0;
        if (n >= MAX_ESCRITURAS) {
            if (n === MAX_ESCRITURAS) {
                _escrituras[nombreControl] = n + 1;
                console.warn("WIT.Grabacion: " + nombreControl + " se reescribio " +
                             MAX_ESCRITURAS + " veces; se deja de insistir. " +
                             "src actual: " + src);
            }
            return true;
        }
        _escrituras[nombreControl] = n + 1;

        if (faltaAllow) { el.setAttribute("allow", ALLOW); }
        el.setAttribute("src", destino);

        console.log("WIT.Grabacion: " + nombreControl + " -> src asignado (" +
                    (n + 1) + "/" + MAX_ESCRITURAS + ")" +
                    (src ? " | anterior: " + src.slice(0, 80) : ""));
        return true;
    }

    /**
     * Revisa periodicamente los iframes registrados. Es barato (un
     * getElementById y dos lecturas de atributo) y hace el montaje inmune al
     * momento en que la UCI decida renderizar o re-renderizar la pestana.
     */
    function detenerVigilante() {
        if (_vigilante) { clearInterval(_vigilante); _vigilante = null; }
        _objetivos = [];
        _montados = {};
        _escrituras = {};
        _ciclos = 0;
    }

    function vigilar() {
        if (_vigilante) { return; }
        _vigilante = setInterval(function () {
            // si el formulario ya no es el de este caso, no hay nada que vigilar
            if (!_formContext || numeroDeCaso(_formContext) !== _casoActual) {
                detenerVigilante();
                return;
            }
            var pendientes = 0;
            for (var i = 0; i < _objetivos.length; i++) {
                if (!asegurarIframe(_objetivos[i].destino, _objetivos[i].control, false)) {
                    pendientes++;
                }
            }
            _ciclos++;
            // tras un rato sin encontrar ninguno, se avisa una sola vez
            if (_ciclos === 20 && pendientes === _objetivos.length) {
                console.warn("WIT.Grabacion: los iframes no aparecen en el DOM. " +
                             "Abra la pestana del grabador; si sigue en blanco, " +
                             "revise que el control IFRAME exista en este formulario.");
            }
        }, 1200);
    }

    function montar(formContext, numeroCaso, nombreControl, simple) {
        var nombre = nombreControl || IFRAME_NAME;
        var control = formContext.getControl(nombre);
        if (!control) {
            // cada pestana es opcional: que falte una no es un error
            return false;
        }

        var destino = urlGrabador(numeroCaso, simple);

        // via soportada: deja la URL registrada en el control
        try { control.setSrc(destino); } catch (e) {
            console.error("WIT.Grabacion: setSrc fallo en " + nombre, e);
        }

        // se registra para que el vigilante lo mantenga correcto
        var ya = false;
        for (var i = 0; i < _objetivos.length; i++) {
            if (_objetivos[i].control === nombre) {
                _objetivos[i].destino = destino;
                ya = true;
            }
        }
        if (!ya) { _objetivos.push({ destino: destino, control: nombre }); }

        // un montaje explicito reinicia el contador y si puede cambiar la URL
        _escrituras[nombre] = 0;
        asegurarIframe(destino, nombre, true);
        vigilar();
        return true;
    }

    /** Monta las dos pestanas: la completa y la simplificada, si existen. */
    function montarTodo(formContext, numeroCaso) {
        montar(formContext, numeroCaso, IFRAME_NAME, false);
        montar(formContext, numeroCaso, IFRAME_SIMPLE, true);
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
        console.log("WIT.Grabacion: recurso web version " + VERSION);
        // cada carga empieza de cero: si quedaron objetivos de otro registro, el
        // vigilante seguiria persiguiendo una URL que ya no corresponde
        detenerVigilante();
        _formContext = executionContext.getFormContext();
        var tabs = [
            { tab: obtenerTab(_formContext, TAB_NAME),   control: IFRAME_NAME,   simple: false },
            { tab: obtenerTab(_formContext, TAB_SIMPLE), control: IFRAME_SIMPLE, simple: true }
        ];
        var esCreacion = _formContext.ui.getFormType() === FORM_TYPE_CREATE;
        var numeroCaso = numeroDeCaso(_formContext);

        if (esCreacion || !numeroCaso) {
            tabs.forEach(function (t) { if (t.tab) { t.tab.setVisible(false); } });
            return;
        }

        _casoActual = numeroCaso;
        escucharMensajes();

        tabs.forEach(function (t) {
            if (!t.tab) { return; }
            t.tab.setVisible(true);
            montar(_formContext, numeroCaso, t.control, t.simple);
            if (t.tab.addTabStateChange) {
                t.tab.addTabStateChange(function () {
                    if (t.tab.getDisplayState() === "expanded") {
                        montar(_formContext, numeroCaso, t.control, t.simple);
                    }
                });
            }
        });
    }

    function onSave(executionContext) {
        _formContext = executionContext.getFormContext();
        if (_formContext.ui.getFormType() === FORM_TYPE_CREATE) { return; }
        var numeroCaso = numeroDeCaso(_formContext);
        if (!numeroCaso) { return; }
        [TAB_NAME, TAB_SIMPLE].forEach(function (n) {
            var t = obtenerTab(_formContext, n);
            if (t) { t.setVisible(true); }
        });
        _casoActual = numeroCaso;
        escucharMensajes();
        montarTodo(_formContext, numeroCaso);
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
        Xrm.Navigation.openUrl(urlGrabador(numeroCaso, false));
    }

    return {
        onLoad: onLoad,
        onSave: onSave,
        abrirEnPestanaNueva: abrirEnPestanaNueva
    };
})();
