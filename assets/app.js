/* Grabador de audio -> Azure Blob Storage
   Prototipo W-IT. Paso 1 ID, Paso 2 grabar, Paso 3 subir. */
(() => {
'use strict';

/* Version visible en pantalla. Se sube en cada cambio de la pagina, para
   poder confirmar de un vistazo si el navegador esta sirviendo lo ultimo. */
const VERSION = '2026.10.22-3';

const $ = (id) => document.getElementById(id);
const CFG_KEY  = 'wit.audiorec.cfg.v2';
const HIST_KEY = 'wit.audiorec.hist.v1';
const TARGET_SR = 16000;

/* En Azure Static Web Apps la API vive en el mismo origen bajo /api, asi que los
   defaults de nube son rutas relativas y no hay nada que configurar a mano.
   Sirviendo desde localhost se asume el entorno de pruebas con los emuladores. */
const EN_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

const CFG_NUBE = {
  mode: 'function',
  fnUrl: '/api/sas',
  fnKey: '',
  sasUrl: '',
  format: 'wav',
  trMode: 'function',
  trUrl: '/api/transcribe',
  trMockUrl: '',
  recUrl: '/api/records',
  evalUrl: '/api/evaluar',
  extraerUrl: '/api/extraer',
  clasificarUrl: '/api/clasificar',
  speechTokenUrl: '/api/speechtoken',
  locale: 'es-CL',
  diarize: '0'
};

const CFG_LOCAL = {
  mode: 'sas',
  fnUrl: 'http://localhost:8000/api/sas',
  fnKey: '',
  sasUrl: 'http://localhost:5501/grabaciones?sv=mock&sig=mock',
  format: 'wav',
  trMode: 'mock',
  trUrl: 'http://localhost:8000/api/transcribe',
  trMockUrl: 'http://localhost:5501/transcribe',
  recUrl: 'http://localhost:5501/records',
  evalUrl: 'http://localhost:5501/evaluar',
  extraerUrl: 'http://localhost:5501/extraer',
  clasificarUrl: 'http://localhost:5501/clasificar',
  speechTokenUrl: 'http://localhost:5501/speechtoken',
  locale: 'es-CL',
  diarize: '0'
};

const CFG_DEFAULT = EN_LOCAL ? CFG_LOCAL : CFG_NUBE;

const S = {
  id: null, idLocked: false,
  stream: null, rec: null, chunks: [],
  ac: null, analyser: null, srcNode: null, raf: 0,
  t0: 0, accMs: 0, tick: 0,
  blob: null, mime: '', durMs: 0, blobName: '',
  uploaded: null, tr: null, segEls: [], activeSeg: -1, previa: null,
  cam: { stream: null, rec: null, chunks: [], blob: null, mime: '', durMs: 0,
         t0: 0, tick: 0, tope: 60000, blobName: '' },
  cfg: Object.assign({}, CFG_DEFAULT)
};

/* ---------- utilidades ---------- */
const pad = (n) => String(n).padStart(2, '0');
function fmtTime(ms){
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return (h ? h + ':' : '') + pad(m) + ':' + pad(s % 60);
}
const fmtSize = (b) => b < 1024 ? b + ' B'
  : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(2) + ' MB';

/** ID -> segmento de ruta seguro para Blob Storage */
function sanitizeId(raw){
  return String(raw).trim().replace(/[{}]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
}
/** metadata de blob: solo ASCII imprimible */
const asciiMeta = (v) => String(v).replace(/[^\x20-\x7E]/g, '?').slice(0, 200);

function stamp(d){
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
         pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}
function rand4(){
  const a = new Uint8Array(2); crypto.getRandomValues(a);
  return Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
}

function setMsg(el, text, kind){
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}
/** Enlace que reabre esta misma página como pestaña de primer nivel, donde el
 *  navegador sí concede micrófono y cámara. Es la salida cuando el contenedor
 *  no delega los permisos. */
function enlaceEscape(etiqueta){
  const a = document.createElement('a');
  a.className = 'banner-act';
  a.href = location.href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = etiqueta || 'Abrir en pestaña nueva';
  return a;
}

/** banner de aviso; con accion opcional que abre esta misma pagina de primer nivel */
function banner(text, conAccion){
  const b = $('banner');
  if (!text) { b.classList.add('hidden'); return; }
  b.textContent = text;
  if (conAccion) b.appendChild(enlaceEscape());
  b.classList.remove('hidden');
}

/** Mensaje con enlace de escape, para avisos dentro de una sección. */
function msgConEscape(el, texto, etiqueta){
  el.textContent = texto;
  el.className = 'msg bad';
  el.appendChild(enlaceEscape(etiqueta));
}

/** Interfaz simplificada: una sola pantalla, todo automatico al detener.
    El modo en vivo es la misma pantalla, con transcripcion y temas mientras
    se habla; al detener sigue el mismo camino que la simple. */
const MODO = new URLSearchParams(location.search).get('modo');
const MODO_VIVO   = MODO === 'vivo';
const MODO_SIMPLE = MODO === 'simple' || MODO_VIVO;

/** Modos compactos de la misma pagina, abiertos como ventana propia. */
const SOLO = new URLSearchParams(location.search).get('solo');
const SOLO_CLIP    = SOLO === 'clip';
const SOLO_PERMISO = SOLO === 'permiso';

/* ---------- deteccion de incrustacion (Dynamics) ---------- */
const EN_IFRAME = (() => {
  try { return window.self !== window.top; } catch (e) { return true; }
})();

/**
 * ¿El marco contenedor nos delego el microfono?
 * Un iframe de otro origen sin allow="microphone" no puede usar getUserMedia,
 * aunque el usuario acepte el permiso. Devuelve null si no se puede saber.
 */
function marcoBloqueaMic(){
  try {
    const fp = document.featurePolicy;
    if (fp && typeof fp.allowsFeature === 'function') return !fp.allowsFeature('microphone');
  } catch (e) {}
  return null;
}

const AVISO_MARCO = 'La página está incrustada y el contenedor no le delegó el micrófono ' +
  '(falta allow="microphone" en el iframe). Ábrela en una pestaña nueva para grabar.';

/** ¿El marco nos delegó la cámara? Mismo mecanismo que el micrófono. */
function marcoBloqueaCam(){
  try {
    const fp = document.featurePolicy;
    if (fp && typeof fp.allowsFeature === 'function') return !fp.allowsFeature('camera');
  } catch (e) {}
  return null;
}

const AVISO_CAM = 'El contenedor no le delegó la cámara: en Dynamics el iframe necesita ' +
  'allow="microphone; camera". Abra la página aparte para grabar el clip.';

/**
 * Origen del contenedor al que se le puede devolver la transcripción.
 * Lo declara quien incrusta la página (?parent=https://...). Sin este dato NO
 * se envía nada: postMessage con '*' entregaría el texto a cualquier sitio que
 * decida enmarcar esta página.
 */
const ORIGEN_PADRE = (() => {
  try {
    const v = new URLSearchParams(location.search).get('parent');
    if (!v) return null;
    const u = new URL(v);
    // Dynamics siempre es https; http se acepta solo en localhost, para desarrollo
    const permitido = u.protocol === 'https:' ||
                      ['localhost', '127.0.0.1'].indexOf(u.hostname) !== -1;
    return permitido ? u.origin : null;
  } catch (e) { return null; }
})();

/** Devuelve la transcripción al contenedor (el formulario de Dynamics). */
function avisarAlPadre(t){
  if (!EN_IFRAME || !ORIGEN_PADRE) return false;
  try {
    window.parent.postMessage({
      tipo: 'wit-transcripcion',
      recordId: S.id,
      blobName: t.blobName,
      texto: t.text,
      locale: t.locale,
      segmentos: t.phrases.length,
      simulado: !!t.mock
    }, ORIGEN_PADRE);
    return true;
  } catch (e) {
    console.warn('No se pudo avisar al contenedor:', e);
    return false;
  }
}

/* ---------- configuración ---------- */
function loadCfg(){
  try { Object.assign(S.cfg, JSON.parse(localStorage.getItem(CFG_KEY) || '{}')); } catch (e) {}
  $('cfgMode').value      = S.cfg.mode;
  $('cfgFnUrl').value     = S.cfg.fnUrl;
  $('cfgFnKey').value     = S.cfg.fnKey;
  $('cfgSasUrl').value    = S.cfg.sasUrl;
  $('cfgFormat').value    = S.cfg.format;
  $('cfgTrMode').value    = S.cfg.trMode;
  $('cfgTrUrl').value     = S.cfg.trUrl;
  $('cfgTrMockUrl').value = S.cfg.trMockUrl;
  $('cfgLocale').value    = S.cfg.locale;
  $('cfgDiarize').value   = S.cfg.diarize;
  applyModeVisibility();
}
function applyModeVisibility(){
  const m = $('cfgMode').value, t = $('cfgTrMode').value;
  document.querySelectorAll('[data-mode]').forEach((r) => {
    r.classList.toggle('hidden', r.dataset.mode !== m);
  });
  document.querySelectorAll('[data-tr]').forEach((r) => {
    r.classList.toggle('hidden', r.dataset.tr !== t);
  });
}
function saveCfg(){
  S.cfg = {
    mode:      $('cfgMode').value,
    fnUrl:     $('cfgFnUrl').value.trim(),
    fnKey:     $('cfgFnKey').value.trim(),
    sasUrl:    $('cfgSasUrl').value.trim(),
    format:    $('cfgFormat').value,
    trMode:    $('cfgTrMode').value,
    trUrl:     $('cfgTrUrl').value.trim(),
    trMockUrl: $('cfgTrMockUrl').value.trim(),
    recUrl:    S.cfg.recUrl,
    evalUrl:   S.cfg.evalUrl,
    extraerUrl:     S.cfg.extraerUrl,
    clasificarUrl:  S.cfg.clasificarUrl,
    speechTokenUrl: S.cfg.speechTokenUrl,
    locale:    $('cfgLocale').value,
    diarize:   $('cfgDiarize').value
  };
  localStorage.setItem(CFG_KEY, JSON.stringify(S.cfg));
  setMsg($('cfgMsg'), 'Configuración guardada.', 'ok');
  refreshUploadBtn(); refreshTrBtn();
}
const cfgReady = () => S.cfg.mode === 'sas' ? !!S.cfg.sasUrl : !!S.cfg.fnUrl;
const trEndpoint = () => S.cfg.trMode === 'mock' ? S.cfg.trMockUrl : S.cfg.trUrl;
/** Endpoint de consulta de grabaciones existentes; sigue al modo elegido. */
const recEndpoint = () => S.cfg.recUrl ||
  (S.cfg.trMode === 'mock' ? 'http://localhost:5501/records' : '/api/records');

/* ---------- Paso 1: ID ---------- */
function confirmId(){
  const clean = sanitizeId($('recId').value);
  if (clean.length < 3){
    $('idErr').textContent = 'Ingrese un ID de al menos 3 caracteres (letras, números, - _ .).';
    return;
  }
  $('idErr').textContent = '';
  S.id = clean; S.idLocked = true;
  $('recId').value = clean;
  $('recId').disabled = true;
  $('btnId').classList.add('hidden');
  $('btnIdEdit').classList.remove('hidden');
  $('s1state').textContent = 'ID: ' + clean;
  $('s1state').className = 'pill ok';
  if (MODO_SIMPLE){
    $('simpleCaso').textContent = clean;
    $('simpleCaso').className = 'pill ok';
  }
  refreshUploadBtn();
  // el paso 2 se habilita solo si no hay una grabación previa para este ID
  habilitarClip();
  if (SOLO_CLIP){
    // la ventana compacta solo graba el clip: no consulta ni bloquea nada
    $('clipIdInfo').textContent = 'Caso: ' + clean;
    return;
  }
  bloquearGrabacion();
  buscarExistentes();
}
function editId(){
  if (S.rec && S.rec.state !== 'inactive') return;
  S.idLocked = false;
  $('recId').disabled = false;
  $('btnId').classList.remove('hidden');
  $('btnIdEdit').classList.add('hidden');
  $('s1state').textContent = 'Pendiente'; $('s1state').className = 'pill';
  $('recId').focus();
}


/* ---------- Grabaciones ya registradas para el ID ---------- */

function bloquearGrabacion(){
  $('step2').classList.add('disabled');
  $('s2state').textContent = 'Bloqueado'; $('s2state').className = 'pill';
}
function desbloquearGrabacion(){
  $('step2').classList.remove('disabled');
  $('s2state').textContent = 'Listo'; $('s2state').className = 'pill';
}

/**
 * Al cargar un ID se consulta si ya existe audio para ese registro.
 * Si existe se muestra con su transcripción y NO se habilita grabar; si no
 * existe, se habilita. Si la consulta falla se habilita igual: dejar la
 * herramienta inservible por un error transitorio es peor que grabar de más.
 */
async function buscarExistentes(){
  const url = recEndpoint();
  $('existentes').classList.add('hidden');
  $('exList').innerHTML = '';

  if (!url){ setMsg($('buscaMsg'), ''); desbloquearGrabacion(); return; }

  $('s2state').textContent = 'Verificando';
  $('buscaMsg').innerHTML = '<span class="spin"></span>Buscando grabaciones registradas para este ID…';
  $('buscaMsg').className = 'msg';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordId: S.id })
    });
    const txt = await res.text();
    let d;
    try { d = JSON.parse(txt); }
    catch (e){ throw new Error('respuesta no JSON: ' + txt.slice(0, 150)); }
    if (!res.ok) throw new Error(d.error || ('HTTP ' + res.status));

    if (MODO_SIMPLE){
      // simpleMostrarPrevia decide si el caso queda en modo consulta
      simpleMostrarPrevia(d);
      desbloquearGrabacion();
      return;
    }
    if (d.count > 0){
      renderExistentes(d);
      return;
    }
    setMsg($('buscaMsg'), 'Sin grabaciones previas para este ID: puede grabar.', 'ok');
    desbloquearGrabacion();
  } catch (e){
    setMsg($('buscaMsg'), 'No se pudo verificar si ya existe una grabación (' + e.message +
      '). Se habilita la grabación de todas formas.', 'bad');
    desbloquearGrabacion();
  }
}

const esClip = (it) => it.kind === 'video' ||
  /^video\//.test(it.contentType || '') || /(^|\/)clip-/.test(it.blobName || '');

function renderExistentes(d){
  const cont = $('exList');
  cont.innerHTML = '';
  d.items.forEach((it) => cont.appendChild(tarjetaExistente(it)));
  $('existentes').classList.remove('hidden');

  // Solo el audio de la conversación bloquea el paso 2. Un clip de evidencia
  // es aditivo: que exista no significa que la conversación esté grabada.
  const audios = d.items.filter((it) => !esClip(it)).length;
  const clips  = d.items.length - audios;

  const partes = [];
  if (audios) partes.push(audios + (audios === 1 ? ' grabación de audio' : ' grabaciones de audio'));
  if (clips)  partes.push(clips + (clips === 1 ? ' clip de evidencia' : ' clips de evidencia'));

  if (audios > 0){
    setMsg($('buscaMsg'), 'Ya hay ' + partes.join(' y ') +
      ' para este ID. Puede escuchar y transcribir aquí.', 'ok');
    $('s2state').textContent = 'Ya existe grabación'; $('s2state').className = 'pill';
    $('step2').classList.add('disabled');
    $('btnOtra').classList.remove('hidden');
  } else {
    setMsg($('buscaMsg'), 'Hay ' + partes.join(' y ') +
      ' para este ID, pero todavía no hay audio de la conversación: puede grabarlo.', 'ok');
    desbloquearGrabacion();
    $('btnOtra').classList.add('hidden');
  }
}

function tarjetaExistente(it){
  const box = document.createElement('div');
  box.className = 'exitem';

  const meta = document.createElement('div');
  meta.className = 'meta';
  [
    it.createdAt ? new Date(it.createdAt).toLocaleString('es-CL') : 'fecha n/d',
    it.durationMs ? 'Duración: ' + fmtTime(it.durationMs) : null,
    it.sizeBytes ? fmtSize(it.sizeBytes) : null,
    it.blobName
  ].filter(Boolean).forEach((t) => {
    const sp = document.createElement('span'); sp.textContent = t; meta.appendChild(sp);
  });
  box.appendChild(meta);

  const src = it.url || it.audioUrl;
  if (src){
    const esVideo = it.kind === 'video' ||
                    /^video\//.test(it.contentType || '') ||
                    /(^|\/)clip-/.test(it.blobName || '');
    const el = document.createElement(esVideo ? 'video' : 'audio');
    el.controls = true; el.src = src;
    el.className = esVideo ? 'camprev exvideo' : 'player';
    if (esVideo) el.playsInline = true;
    box.appendChild(el);
  }

  const zona = document.createElement('div');
  zona.className = 'exTr';
  box.appendChild(zona);
  pintarTranscripcion(zona, it);
  return box;
}

/** Contenido de transcripción de una grabación existente, o el botón para pedirla. */
function pintarTranscripcion(zona, it){
  zona.innerHTML = '';
  // el clip de evidencia no se transcribe: el texto sale del audio de la
  // conversación, no del video
  if (it.kind === 'video' || /(^|\/)clip-/.test(it.blobName || '')){
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Clip de evidencia. No se transcribe.';
    zona.appendChild(p);
    return;
  }
  const t = it.transcript;

  const h = document.createElement('h3');
  h.className = 'trh'; h.textContent = 'Transcripción';
  zona.appendChild(h);

  if (t && t.text){
    if (t.mock){
      const w = document.createElement('div');
      w.className = 'banner mock';
      w.textContent = 'Transcripción simulada: no proviene de Azure AI Speech.';
      zona.appendChild(w);
    }
    const st = document.createElement('div');
    st.className = 'trmeta';
    const sp = document.createElement('span');
    const nSeg = (t.phrases || []).length;
    sp.textContent = [
      String(t.text).split(/\s+/).filter(Boolean).length + ' palabras',
      nSeg ? nSeg + ' segmentos' : null,
      (t.locales && t.locales[0]) ? 'idioma ' + t.locales[0] : null
    ].filter(Boolean).join(' · ');
    st.appendChild(sp); zona.appendChild(st);

    const cuerpo = document.createElement('div');
    cuerpo.className = 'trfull';
    cuerpo.textContent = t.text;
    zona.appendChild(cuerpo);

    const acciones = document.createElement('div');
    acciones.className = 'ctrls';
    const copiar = document.createElement('button');
    copiar.type = 'button'; copiar.className = 'ghost small'; copiar.textContent = 'Copiar texto';
    copiar.onclick = () => navigator.clipboard.writeText(t.text)
      .then(() => { copiar.textContent = 'Copiado'; });
    acciones.appendChild(copiar);

    const enviar = document.createElement('button');
    enviar.type = 'button'; enviar.className = 'ghost small';
    enviar.textContent = 'Enviar al caso';
    enviar.onclick = () => {
      const ok = avisarAlPadre({ blobName: it.blobName, text: t.text,
                                 locale: (t.locales && t.locales[0]) || S.cfg.locale,
                                 phrases: t.phrases || [], mock: !!t.mock });
      enviar.textContent = ok ? 'Enviado' : 'No hay contenedor';
    };
    if (EN_IFRAME && ORIGEN_PADRE) acciones.appendChild(enviar);

    zona.appendChild(acciones);
    return;
  }

  if (t && t.error){
    const p = document.createElement('p');
    p.className = 'msg bad'; p.textContent = t.error;
    zona.appendChild(p);
  }

  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = 'Este audio está almacenado pero todavía no tiene transcripción.';
  zona.appendChild(p);

  const acciones = document.createElement('div');
  acciones.className = 'ctrls';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'primary'; btn.textContent = 'Transcribir';
  btn.onclick = () => transcribirExistente(it, zona, btn);
  acciones.appendChild(btn);
  zona.appendChild(acciones);

  const est = document.createElement('div');
  est.className = 'msg'; est.id = 'exmsg-' + it.blobName.replace(/[^A-Za-z0-9]/g, '');
  zona.appendChild(est);
}

/** Transcribe una grabación ya almacenada, sin volver a grabarla. */
async function transcribirExistente(it, zona, btn){
  const url = trEndpoint();
  const est = zona.querySelector('.msg');
  btn.disabled = true;
  if (est){
    est.className = 'msg';
    est.innerHTML = '<span class="spin"></span>Transcribiendo, puede tardar según la duración…';
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blobName: it.blobName, blobUrl: it.audioUrl,
        locales: [S.cfg.locale], diarize: Number(S.cfg.diarize) || 0
      })
    });
    const txt = await res.text();
    let d;
    try { d = JSON.parse(txt); }
    catch (e){ throw new Error('respuesta no JSON: ' + txt.slice(0, 150)); }
    if (!res.ok) throw new Error(d.error || ('HTTP ' + res.status));
    if (!d.text) throw new Error('Azure no devolvió texto. ¿El audio quedó en silencio?');

    it.transcript = d;
    pintarTranscripcion(zona, it);
    avisarAlPadre({ blobName: it.blobName, text: d.text,
                    locale: (d.locales && d.locales[0]) || S.cfg.locale,
                    phrases: d.phrases || [], mock: !!d.mock });
  } catch (e){
    btn.disabled = false;
    if (est) setMsg(est, 'Error al transcribir: ' + e.message, 'bad');
  }
}



/* ---------- Panel de revisión del guion ---------- */

/* Puntos a verificar. Viven aquí para la POC; el backend acepta la lista en la
   petición, de modo que puedan venir de configuración sin tocar la página. */
const CRITERIOS = [
  '¿Sabía ud. que tiene un crédito preaprobado?',
  '¿El funcionario explicó los beneficios?',
  '¿Se informó sobre Coopeuch Educa?'
];

const MARCAS = { si: '✓', parcial: '~', no: '✕', pend: '·' };

function pintarCriterios(resultados){
  const ol = $('listaCriterios');
  ol.innerHTML = '';

  CRITERIOS.forEach((criterio, i) => {
    const r = resultados ? resultados[i] : null;
    const estado = r ? r.cumple : 'pend';

    const li = document.createElement('li');

    const cab = document.createElement('div');
    cab.className = 'crit-cab';

    const marca = document.createElement('span');
    marca.className = 'crit-marca ' + estado;
    marca.textContent = MARCAS[estado] || MARCAS.pend;
    marca.title = { si: 'Se trató', parcial: 'Se mencionó de forma incompleta',
                    no: 'No aparece', pend: 'Sin revisar' }[estado];
    cab.appendChild(marca);

    const txt = document.createElement('span');
    txt.className = 'crit-texto';
    txt.textContent = (r && r.criterio) || criterio;
    cab.appendChild(txt);

    li.appendChild(cab);

    if (r && r.evidencia){
      const ev = document.createElement('div');
      ev.className = 'crit-evidencia';
      ev.textContent = '«' + r.evidencia + '»';
      li.appendChild(ev);
    }
    if (r && r.justificacion){
      const ju = document.createElement('div');
      ju.className = 'crit-just';
      ju.textContent = r.justificacion;
      li.appendChild(ju);
    }

    ol.appendChild(li);
  });
}

async function evaluarGuion(){
  if (!S.tr || !S.tr.text){
    setMsg($('evalMsg'), 'Primero tiene que haber una transcripción.', 'bad');
    return;
  }
  const url = S.cfg.evalUrl;
  if (!url){
    setMsg($('evalMsg'), 'Falta el endpoint de revisión en Configuración.', 'bad');
    return;
  }

  const btn = $('btnEvaluar');
  btn.disabled = true;
  $('evalMsg').innerHTML = '<span class="spin"></span>Revisando la conversación…';
  $('evalMsg').className = 'msg';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto: S.tr.text, blobName: S.tr.blobName,
                             recordId: S.id, criterios: CRITERIOS })
    });
    const txt = await res.text();
    let d;
    try { d = JSON.parse(txt); }
    catch (e){ throw new Error('respuesta no es JSON: ' + txt.slice(0, 150)); }
    if (!res.ok) throw new Error(d.error || ('HTTP ' + res.status));

    pintarCriterios(d.resultados || []);
    setMsg($('evalMsg'), d.mock ? 'Revisión simulada.' : 'Revisión lista.', d.mock ? 'bad' : 'ok');

    const aviso = $('evalAviso');
    aviso.textContent = d.aviso ||
      'Indicio automático sobre el contenido de la conversación. No constituye una ' +
      'evaluación de la persona ni reemplaza una revisión humana.';
    aviso.classList.remove('hidden');
  } catch (e){
    setMsg($('evalMsg'), 'No se pudo revisar: ' + e.message, 'bad');
  }
  btn.disabled = false;
}

/* ---------- Revisión en vivo (?modo=vivo) ---------- */

/* Temas que se marcan mientras se habla. Se envian como criterios al mismo
   /api/evaluar: un tema queda marcado solo si el modelo puede citar la frase
   que lo respalda, igual que en la revision del guion. */
/* En vivo basta con que el tema se MENCIONE. `claves` marca el tema en el
   acto, sin esperar al modelo, cuando aparece una de esas palabras (se compara
   sin tildes ni mayusculas, por inicio de palabra). El modelo sigue revisando
   para detectar menciones con otras palabras. */
const TEMAS_VIVO = [
  /* Credito NO se marca por palabra clave: que alguien diga "credito" no es
     una gestion. Se marca solo cuando el modelo constata una oferta o una
     negociacion concreta, y "parcial" no cuenta. Lleva como guia el monto
     preaprobado del caso. */
  { titulo: 'Crédito ofrecido',
    criterio: '¿Se ofreció o se negoció un crédito concreto con el cliente, hablando de su ' +
              'monto, cuota, plazo, tasa o condiciones? Que alguien solo nombre la palabra ' +
              '"crédito" o pregunte por uno NO basta: tiene que haber una oferta o una negociación.',
    claves: [], soloSi: true, guia: 'preaprobado' },
  /* Beneficios: igual que el credito, sin palabra clave ni "parcial". Solo
     cuenta que el ejecutivo nombre explicitamente un beneficio concreto. */
  { titulo: 'Beneficios',
    criterio: '¿El ejecutivo le informó EXPLÍCITAMENTE al cliente qué beneficios concretos tiene ' +
              'por ser socio, nombrando al menos uno (por ejemplo un descuento, un convenio, un ' +
              'seguro o un programa como salud o educación)? NO cuentan: que el cliente pregunte ' +
              'por beneficios, las condiciones de un crédito (cuotas, plazos, tasas, montos), ' +
              'frases genéricas sin nombrar ningún beneficio, ni deducciones o suposiciones.',
    claves: [], soloSi: true }
];

const sinTildes = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Indice de los temas pendientes que el texto menciona por palabra clave. */
function temasPorClave(texto){
  const palabras = sinTildes(texto).split(/[^a-z0-9]+/).filter(Boolean);
  return TEMAS_VIVO.map((t, i) => i).filter((i) =>
    V.temas[i].cumple !== 'si' &&
    TEMAS_VIVO[i].claves.some((c) => palabras.some((w) => w.startsWith(c))));
}

/**
 * Marca en el acto lo que se reconoce por palabra clave. `provisoria` indica
 * que la cita viene de texto aun en reconocimiento: cuando llega la frase
 * final, la cita se reemplaza por esa.
 */
function marcarPorClave(texto, provisoria){
  let recien = -1, cambio = false;
  temasPorClave(texto).forEach((i) => {
    V.temas[i] = { cumple: 'si', evidencia: texto, provisoria };
    recien = i; cambio = true;
  });
  if (!provisoria){
    // la frase final reemplaza la cita provisoria que la anticipaba
    const palabras = sinTildes(texto).split(/[^a-z0-9]+/);
    V.temas.forEach((t, i) => {
      if (t.provisoria && TEMAS_VIVO[i].claves.some((c) => palabras.some((w) => w.startsWith(c)))){
        V.temas[i] = { cumple: 'si', evidencia: texto, provisoria: false };
        cambio = true;
      }
    });
  }
  if (cambio) pintarTemasVivo(recien);
}

/* Version fija del SDK de voz para el navegador. Se carga solo en este modo. */
const SDK_VOZ = 'https://cdn.jsdelivr.net/npm/microsoft-cognitiveservices-speech-sdk@1.40.0' +
                '/distrib/browser/microsoft.cognitiveservices.speech.sdk.bundle-min.js';

const VIVO_PAUSA_MS   = 6000;    // separacion minima entre revisiones
const VIVO_VENTANA    = 6000;    // caracteres finales que se revisan cada vez
const VIVO_TOKEN_MS   = 9 * 60 * 1000;   // el token vence a los 10 minutos

const V = {
  gen: 0,                 // cambia al reiniciar: descarta respuestas de una sesion anterior
  activo: false, conectado: false, rec: null, simulador: 0, tokenTimer: 0,
  previo: null,           // {tk, t}: token pedido al abrir la pantalla
  frases: [], parcial: '', t0: 0,
  temas: [],              // [{cumple, evidencia}] por tema, solo sube de nivel
  datos: {},              // por campo de DATOS_SOLICITUD, ver datoVacio()
  timer: 0, enCurso: false, pendiente: false, ultima: 0, revisadoHasta: 0
};

function vivoReiniciar(){
  V.gen++;
  V.frases = []; V.parcial = ''; V.ultima = 0; V.revisadoHasta = 0;
  V.pendiente = false; V.enCurso = false; V.conectado = false; V.simulado = false;
  V.ventanaRut = 0;
  clearTimeout(V.timer);
  V.temas = TEMAS_VIVO.map(() => ({ cumple: 'pend', evidencia: null }));
  DATOS_SOLICITUD.forEach((c) => { V.datos[c.id] = datoVacio(); });
  pintarDatos();
  aplicarTasaPorDefecto();
  pintarSimulacion();
  V.clasif = clasifVacia();
  V.textos = {};
  Object.keys(TEXTOS).forEach((id) => { V.textos[id] = textoVacio(); });
  pintarSelectClasif();
  Object.keys(TEXTOS).forEach(pintarTexto);
  mostrarPestana('cliente');
  $('vivoCol').classList.remove('hidden');
  $('vivoAviso').classList.add('hidden');
  setMsg($('vivoMsg'), '');
  pintarVivoTexto();
  pintarTemasVivo(-1);
}

function pintarVivoTexto(){
  const caja = $('vivoTexto');
  caja.innerHTML = '';
  if (!V.frases.length && !V.parcial){
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = !V.activo ? 'El texto aparece aquí mientras se habla.'
                  : V.conectado ? 'Escuchando…' : 'Conectando con el servicio de voz…';
    caja.appendChild(p);
    return;
  }
  V.frases.forEach((f) => {
    const p = document.createElement('p');
    const h = document.createElement('span');
    h.className = 'hora';
    h.textContent = fmtTime(f.ms);
    p.appendChild(h);
    p.appendChild(document.createTextNode(f.texto));
    caja.appendChild(p);
  });
  if (V.parcial){
    const p = document.createElement('p');
    p.className = 'parcial';
    p.textContent = V.parcial + '…';
    caja.appendChild(p);
  }
  caja.scrollTop = caja.scrollHeight;
}

/** `recien` resalta el tema que acaba de marcarse. */
function pintarTemasVivo(recien){
  const ol = $('vivoTemas');
  ol.innerHTML = '';
  TEMAS_VIVO.forEach((tema, i) => {
    const r = V.temas[i] || { cumple: 'pend' };
    // en vivo un "no" solo significa "todavia no": se muestra como pendiente
    const estado = r.cumple === 'no' ? 'pend' : r.cumple;

    const li = document.createElement('li');
    if (i === recien) li.className = 'recien';
    const cab = document.createElement('div');
    cab.className = 'crit-cab';
    const marca = document.createElement('span');
    marca.className = 'crit-marca ' + estado;
    marca.textContent = MARCAS[estado];
    marca.title = { si: 'Se habló del tema', parcial: 'Se mencionó de pasada',
                    pend: 'Aún no aparece' }[estado];
    cab.appendChild(marca);
    const txt = document.createElement('span');
    txt.className = 'crit-texto';
    txt.textContent = tema.titulo;
    cab.appendChild(txt);
    li.appendChild(cab);

    if (tema.guia === 'preaprobado') li.appendChild(guiaPreaprobado());

    if (r.evidencia){
      const ev = document.createElement('div');
      ev.className = 'crit-evidencia';
      ev.textContent = '«' + r.evidencia + '»';
      ev.title = r.evidencia;
      li.appendChild(ev);
    }
    ol.appendChild(li);
  });
}

/* ---------- contexto del caso: credito preaprobado ----------

   El monto preaprobado viene del caso de Dynamics (en produccion lo pondria
   la campana) y se muestra como guia para el ejecutivo. Fuera de Dynamics se
   puede pasar en la URL (?preaprobado=400000) para probar. */
const CONTEXTO = { preaprobado: null, pedido: false };

function guiaPreaprobado(){
  const g = document.createElement('div');
  g.className = 'tema-guia';
  const pre = CONTEXTO.preaprobado;
  if (!pre){
    g.classList.add('vacia');
    g.textContent = 'Sin crédito preaprobado registrado en el caso.';
    return g;
  }
  const linea = document.createElement('div');
  linea.innerHTML = '';
  const et = document.createElement('span'); et.textContent = 'Preaprobado ';
  const v = document.createElement('strong'); v.textContent = formatoDato('monto', pre);
  linea.appendChild(et); linea.appendChild(v);
  g.appendChild(linea);

  // lo ofrecido en la conversacion, contra la guia
  // el valor vigente: lo que esta en pantalla, aunque aun no se confirme
  const ofrecido = V.datos && V.datos.montooferta ? Number(valorVigente('montooferta')) : 0;
  if (ofrecido > 0){
    const o = document.createElement('div');
    o.className = 'tema-ofrecido' + (ofrecido > Number(pre) ? ' supera' : '');
    o.textContent = 'Ofrecido ' + formatoDato('monto', ofrecido) +
      (ofrecido > Number(pre) ? ' · supera el preaprobado' : '');
    g.appendChild(o);
  }
  return g;
}

function recibirContexto(c){
  const n = Number(c && c.preaprobado);
  CONTEXTO.preaprobado = n > 0 ? n : null;
  pintarTemasVivo(-1);
  pintarSimulacion();
}

/** Pide el contexto al formulario; reintenta mientras el recurso web se engancha. */
function pedirContexto(){
  const qs = Number(new URLSearchParams(location.search).get('preaprobado'));
  if (qs > 0){ recibirContexto({ preaprobado: qs }); return; }
  if (!EN_IFRAME || !ORIGEN_PADRE) return;
  let intentos = 0;
  const pedir = () => {
    if (CONTEXTO.pedido || intentos++ >= 8) return;
    try { window.parent.postMessage({ tipo: 'wit-contexto-pedir', recordId: S.id }, ORIGEN_PADRE); } catch (e) {}
    setTimeout(pedir, 1500);
  };
  pedir();
}

function vivoFrase(texto){
  texto = String(texto || '').trim();
  if (!texto) return;
  V.frases.push({ texto, ms: performance.now() - V.t0 });
  V.parcial = '';
  pintarVivoTexto();
  marcarPorClave(texto, false);
  rutPorPatron(texto);
  rutPorContexto(texto);
  vivoProgramar();
}

function vivoParcial(texto){
  V.parcial = texto;
  pintarVivoTexto();
  marcarPorClave(texto, true);
}

/* Revisiones espaciadas: a lo mas una en curso y una cada VIVO_PAUSA_MS. Lo
   que llegue mientras tanto se junta en la siguiente. */
function vivoHayPendientes(){
  return V.temas.some((t) => t.cumple !== 'si') || datosPendientes().length > 0;
}

function vivoProgramar(){
  if (!vivoHayPendientes()) return;
  if (V.enCurso){ V.pendiente = true; return; }
  clearTimeout(V.timer);
  V.timer = setTimeout(vivoRevisar, Math.max(0, V.ultima + VIVO_PAUSA_MS - Date.now()));
}

async function postJson(url, cuerpo){
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo)
  });
  const txt = await res.text();
  let d;
  try { d = JSON.parse(txt); }
  catch (e){ throw new Error('respuesta no es JSON: ' + txt.slice(0, 150)); }
  if (!res.ok) throw new Error(d.error || ('HTTP ' + res.status));
  return d;
}

/** Una vuelta de revision: temas pendientes y datos sin confirmar, a la vez. */
async function vivoRevisar(){
  if (!vivoHayPendientes() || V.revisadoHasta >= V.frases.length) return;

  // solo el tramo final: lo anterior ya se reviso, y asi el costo de cada
  // llamada no crece con el largo de la conversacion
  const texto = V.frases.map((f) => f.texto).join(' ').slice(-VIVO_VENTANA);
  const gen = V.gen;
  const hasta = V.frases.length;
  V.enCurso = true; V.ultima = Date.now();

  const [errTemas, errDatos] = await Promise.all([
    revisarTemas(texto, gen).then(() => null, (e) => e),
    revisarDatos(texto, gen).then(() => null, (e) => e)
  ]);
  if (gen !== V.gen) return;            // la sesion se reinicio mientras tanto

  V.revisadoHasta = hasta;
  const errores = [errTemas && 'temas: ' + errTemas.message,
                   errDatos && 'datos: ' + errDatos.message].filter(Boolean);
  if (errores.length) setMsg($('vivoMsg'), 'No se pudo revisar (' + errores.join('; ') + ').', 'bad');
  else if (V.simulado) setMsg($('vivoMsg'), 'Revisión simulada, no proviene de un análisis real.', 'bad');
  else setMsg($('vivoMsg'), '');

  V.enCurso = false;
  if (V.pendiente){ V.pendiente = false; vivoProgramar(); }
}

async function revisarTemas(texto, gen){
  const pendientes = TEMAS_VIVO.map((t, i) => i).filter((i) => V.temas[i].cumple !== 'si');
  if (!S.cfg.evalUrl || !pendientes.length) return;
  const d = await postJson(S.cfg.evalUrl, {
    texto, vivo: true, recordId: S.id,
    criterios: pendientes.map((i) => TEMAS_VIVO[i].criterio)
  });
  if (gen !== V.gen) return;
  V.simulado = !!d.mock;

  let recien = -1;
  (d.resultados || []).forEach((r, k) => {
    const i = pendientes[k];
    if (i == null) return;
    // en vivo basta la mencion: "parcial" tambien es check. Un tema
    // marcado no se desmarca: la frase ya se dijo
    const basta = r.cumple === 'si' || (r.cumple === 'parcial' && !TEMAS_VIVO[i].soloSi);
    if (basta && V.temas[i].cumple !== 'si'){
      V.temas[i] = { cumple: 'si', evidencia: r.evidencia };
      recien = i;
    }
  });
  pintarTemasVivo(recien);
}

async function revisarDatos(texto, gen){
  const pendientes = datosPendientes();
  if (!S.cfg.extraerUrl || !pendientes.length) return;
  const d = await postJson(S.cfg.extraerUrl, {
    texto, recordId: S.id, campos: pendientes.map((c) => c.clave),
    listas: { productos: opcionesDe({ lista: 'productos' }), respuestas: opcionesDe({ lista: 'respuestas' }) }
  });
  if (gen !== V.gen) return;
  V.simulado = V.simulado || !!d.mock;
  pendientes.forEach((c) => {
    const r = (d.datos || {})[c.clave];
    // si el modelo no lo encuentra en este tramo, se conserva lo anterior
    if (r && r.valor != null && r.evidencia) proponerDato(c.id, r.valor, r.evidencia, r.interpretacion);
  });
}

/* ---------- Datos de la solicitud (modo en vivo) ----------

   El ejecutivo los pide en la conversacion; aqui se proponen solos y la
   persona los confirma o corrige. Solo lo confirmado pasa al caso de
   Dynamics. Un campo corregido a mano no se vuelve a sobrescribir. */
/* `pestana` decide donde se muestra; `lista` nombra las opciones del catalogo
   (assets/catalogo.json) para los campos de lista cerrada. */
const DATOS_SOLICITUD = [
  { id: 'nombre',    clave: 'nombre',             titulo: 'Nombre',             tipo: 'texto',    pestana: 'cliente', grupo: 'Datos del socio' },
  { id: 'paterno',   clave: 'apellido_paterno',   titulo: 'Apellido paterno',   tipo: 'texto',    pestana: 'cliente', grupo: 'Datos del socio' },
  { id: 'materno',   clave: 'apellido_materno',   titulo: 'Apellido materno',   tipo: 'texto',    pestana: 'cliente', grupo: 'Datos del socio' },
  { id: 'rut',       clave: 'rut',                titulo: 'RUT',                tipo: 'rut',      pestana: 'cliente', grupo: 'Datos del socio' },
  { id: 'telefono',  clave: 'telefono',           titulo: 'Teléfono',           tipo: 'telefono', pestana: 'cliente', grupo: 'Datos del socio' },
  { id: 'ingresos',  clave: 'ingresos_mensuales', titulo: 'Ingresos mensuales', tipo: 'monto',    pestana: 'cliente', grupo: 'Datos del socio' },
  { id: 'monto',     clave: 'monto_solicitado',   titulo: 'Monto solicitado',   tipo: 'monto',    pestana: 'oferta',  grupo: 'Lo que pide el cliente' },
  { id: 'producto',  clave: 'producto_ofrecido',  titulo: 'Producto ofrecido',  tipo: 'lista', lista: 'productos', pestana: 'oferta', grupo: 'Oferta presentada' },
  { id: 'montooferta', clave: 'monto_oferta',     titulo: 'Monto oferta',       tipo: 'monto',    pestana: 'oferta',  grupo: 'Oferta presentada' },
  { id: 'plazo',     clave: 'plazo_meses',        titulo: 'N.º de cuotas (meses)', tipo: 'entero',   pestana: 'oferta',  grupo: 'Oferta presentada' },
  { id: 'valorcuota', clave: 'valor_cuota',       titulo: 'Valor cuota',        tipo: 'monto',    pestana: 'oferta',  grupo: 'Oferta presentada' },
  { id: 'tasa',      clave: 'tasa',               titulo: 'Tasa mensual',       tipo: 'porcentaje', pestana: 'oferta', grupo: 'Oferta presentada' },
  { id: 'cae',       clave: 'cae',                titulo: 'CAE',                tipo: 'porcentaje', pestana: 'oferta', grupo: 'Oferta presentada' },
  { id: 'respuesta', clave: 'respuesta_cliente',  titulo: 'Respuesta del cliente', tipo: 'lista', lista: 'respuestas', pestana: 'oferta', grupo: 'Respuesta del cliente' }
];

const opcionesDe = (c) => (CATALOGO && CATALOGO[c.lista]) || [];

/* ---------- pestanas del panel ---------- */

function mostrarPestana(p){
  document.querySelectorAll('.pestana').forEach((b) => {
    const activa = b.dataset.p === p;
    b.classList.toggle('activa', activa);
    b.setAttribute('aria-selected', activa ? 'true' : 'false');
  });
  document.querySelectorAll('.pestana-panel').forEach((x) => x.classList.toggle('hidden', x.dataset.p !== p));
}

/** Cuantos datos esperan confirmacion en cada pestana. */
function actualizarContadores(){
  const cuenta = { cliente: 0, oferta: 0, cierre: 0 };
  DATOS_SOLICITUD.forEach((c) => {
    const d = V.datos[c.id];
    if (d && (d.estado === 'detectado' || d.estado === 'editado')) cuenta[c.pestana]++;
  });
  [V.clasif].concat(Object.values(V.textos || {})).forEach((k) => {
    if (k && (k.estado === 'propuesto' || k.estado === 'editado')) cuenta.cierre++;
  });
  document.querySelectorAll('.pestana').forEach((b) => {
    const n = cuenta[b.dataset.p];
    const sp = b.querySelector('.cuenta');
    sp.textContent = n ? String(n) : '';
    sp.title = n ? n + ' por confirmar' : '';
  });
}
const DATO_TRASPASO_MS = 15000;     // espera maxima de la respuesta de Dynamics

/* estado: vacio -> detectado -> (editado) -> confirmado
   traspaso: null | enviando | ok | error | sin-dynamics */
const datoVacio = () => ({ valor: null, evidencia: null, estado: 'vacio', traspaso: null,
                          error: '', corregido: false });

/** Los que la extraccion todavia puede completar o actualizar. */
const datosPendientes = () => DATOS_SOLICITUD.filter((c) =>
  V.datos[c.id] && (V.datos[c.id].estado === 'vacio' || V.datos[c.id].estado === 'detectado'));

/** Cuerpo y digito verificador de un RUT, o null si no tiene forma de RUT. */
function partesRut(texto){
  const t = String(texto || '').replace(/[^0-9kK]/g, '').toUpperCase();
  if (t.length < 2 || t.length > 9 || !/^\d+[\dK]$/.test(t)) return null;
  return { cuerpo: t.slice(0, -1).replace(/^0+/, '') || '0', dv: t.slice(-1) };
}

function rutValido(texto){
  const p = partesRut(texto);
  if (!p) return false;
  let suma = 0, factor = 2;
  for (let i = p.cuerpo.length - 1; i >= 0; i--){
    suma += Number(p.cuerpo[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const r = 11 - (suma % 11);
  return p.dv === (r === 11 ? '0' : r === 10 ? 'K' : String(r));
}

/** Telefono como +56 9 XXXX XXXX si es un celular chileno; si no, los digitos. */
function formatoTelefono(texto){
  let d = String(texto || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('56')) d = d.slice(2);
  if (d.length === 9 && d.startsWith('9')) return '+56 9 ' + d.slice(1, 5) + ' ' + d.slice(5);
  return d;
}

function formatoDato(tipo, valor){
  if (valor == null || valor === '') return '';
  if (tipo === 'rut'){
    const p = partesRut(valor);
    return p ? Number(p.cuerpo).toLocaleString('es-CL') + '-' + p.dv : String(valor);
  }
  if (tipo === 'telefono') return formatoTelefono(valor);
  if (tipo === 'texto' || tipo === 'lista') return String(valor).trim();
  if (tipo === 'entero') return String(Math.round(Number(valor)));
  if (tipo === 'porcentaje') return Number(valor).toLocaleString('es-CL', { maximumFractionDigits: 2 }) + ' %';
  return '$' + Number(valor).toLocaleString('es-CL');
}

/** Valor del campo listo para guardar, o un texto de error. */
function leerDato(c, texto){
  if (c.tipo === 'rut'){
    if (!partesRut(texto)) return { error: 'Escriba el RUT con su dígito verificador, por ejemplo 12.345.678-5.' };
    if (!rutValido(texto)) return { error: 'El dígito verificador no corresponde a ese RUT.' };
    return { valor: formatoDato('rut', texto) };
  }
  if (c.tipo === 'texto'){
    const t = String(texto || '').replace(/\s+/g, ' ').trim();
    if (!t) return { error: 'Escriba el ' + c.titulo.toLowerCase() + '.' };
    if (/\d/.test(t)) return { error: 'No debería llevar números.' };
    return { valor: t };
  }
  if (c.tipo === 'lista'){
    if (opcionesDe(c).indexOf(texto) === -1) return { error: 'Elija una opción.' };
    return { valor: texto };
  }
  if (c.tipo === 'entero'){
    const n = Number(String(texto || '').replace(/[^0-9]/g, ''));
    if (!n || n > 480) return { error: 'Escriba el plazo en meses.' };
    return { valor: n };
  }
  if (c.tipo === 'porcentaje'){
    // con coma, el punto es de miles ("1.234,5"); sin coma, el punto es el decimal
    let t = String(texto || '').replace('%', '').trim();
    t = t.indexOf(',') !== -1 ? t.replace(/\./g, '').replace(',', '.') : t;
    const n = Number(t);
    if (!(n > 0 && n < 100)) return { error: 'Escriba un porcentaje, por ejemplo 1,49.' };
    return { valor: Math.round(n * 100) / 100 };
  }
  if (c.tipo === 'telefono'){
    const d = String(texto || '').replace(/\D/g, '');
    if (d.length < 8 || d.length > 12) return { error: 'Escriba el teléfono con todos sus dígitos.' };
    return { valor: formatoTelefono(d) };
  }
  const n = Number(String(texto || '').replace(/[^0-9]/g, ''));
  if (!n) return { error: 'Escriba un monto en pesos, mayor que cero.' };
  return { valor: n };
}

/** Propuesta que llega de la conversacion. No pisa lo corregido ni lo confirmado. */
function proponerDato(id, valor, evidencia, interpretacion){
  const d = V.datos[id];
  if (!d || (d.estado !== 'vacio' && d.estado !== 'detectado')) return;
  // con monto, plazo y tasa la cuota se calcula: lo dicho no la reemplaza
  if (id === 'valorcuota' && cuotaCalculada()) return;
  const c = DATOS_SOLICITUD.find((x) => x.id === id);
  const numerico = c.tipo === 'monto' || c.tipo === 'entero' || c.tipo === 'porcentaje';
  const nuevo = numerico ? Number(valor) : formatoDato(c.tipo, valor);
  if (d.estado === 'detectado' && String(d.valor) === String(nuevo)) return;
  V.datos[id] = Object.assign(datoVacio(), { valor: nuevo, evidencia, estado: 'detectado',
                                            interpretacion: interpretacion || null });
  pintarDato(c, true);
}

/* ---------- valor cuota calculado ----------

   Con monto oferta, plazo y tasa mensual, la cuota sale de la formula de cuota
   fija (sistema frances): cuota = monto * i / (1 - (1 + i)^-n). Es una
   referencia SIN seguros ni impuestos (desgravamen, timbres): la cuota real de
   una simulacion oficial es mayor. Se propone como cualquier otro dato, con
   OK, y no pisa una cuota corregida a mano o ya confirmada. */

/** Valor vigente de un dato: lo que esta escrito si se esta corrigiendo. */
function valorVigente(id){
  const d = V.datos[id];
  if (!d || d.estado === 'vacio') return null;
  if (d.estado === 'editado'){
    const c = DATOS_SOLICITUD.find((x) => x.id === id);
    const r = leerDato(c, $('datoIn_' + id).value);
    return r.error ? null : r.valor;
  }
  return d.valor;
}

/** Cuota fija de un monto con el plazo y la tasa vigentes, o null si falta alguno. */
function cuotaPara(monto){
  const n = Number(valorVigente('plazo'));
  const tasa = valorVigente('tasa');
  if (!(monto > 0) || !(n > 0) || tasa == null || !(Number(tasa) >= 0)) return null;
  const i = Number(tasa) / 100;
  const cuota = i === 0 ? monto / n : monto * i / (1 - Math.pow(1 + i, -n));
  return Math.round(cuota);
}

/** La cuota que corresponde a monto oferta, plazo y tasa vigentes. */
const cuotaCalculada = () => cuotaPara(Number(valorVigente('montooferta')));

/* ---------- opciones de monto oferta ----------

   A partir de lo que pide el cliente se proponen montos alrededor (catalogo:
   opcionesMonto; por defecto -20 %, -7 %, igual, +7 % y +13 %, redondeados a
   $100.000), para que el ejecutivo pueda ofrecer mas de lo solicitado. Cada
   opcion muestra su cuota; las que superan el preaprobado se marcan. */
function opcionesMonto(solicitado){
  const cfg = (CATALOGO && CATALOGO.opcionesMonto) || {};
  const factores = cfg.factores || [0.8, 0.93, 1, 1.07, 1.13];
  // a escala del monto: con un redondeo fijo, los montos chicos repetian opciones
  const red = Number(cfg.redondeo) ||
    (solicitado < 1000000 ? 10000 : solicitado < 10000000 ? 100000 : 500000);
  const vistos = new Set();
  return factores.map((f) => Math.round(solicitado * f / red) * red)
    .filter((m) => m > 0 && !vistos.has(m) && vistos.add(m))
    .sort((a, b) => a - b);
}

function elegirMontoOferta(m){
  const d = V.datos.montooferta;
  if (!d || d.estado === 'confirmado') return;
  const inp = $('datoIn_montooferta');
  inp.value = String(m);
  inp.dispatchEvent(new Event('input'));
}

/**
 * Monto oferta parte igual a lo solicitado, para que la cuota salga de
 * inmediato. Solo si nadie lo fijo: lo dicho en la conversacion, lo corregido
 * y lo confirmado mandan.
 */
function proponerMontoOferta(){
  const sol = Number(valorVigente('monto'));
  const d = V.datos && V.datos.montooferta;
  if (!d || !(sol > 0)) return;
  const libre = d.estado === 'vacio' || (d.estado === 'detectado' && d.origen === 'opcion');
  if (!libre || d.valor === sol) return;
  V.datos.montooferta = Object.assign(datoVacio(), { valor: sol, estado: 'detectado', origen: 'opcion' });
  pintarDato(DATOS_SOLICITUD.find((x) => x.id === 'montooferta'));
}

function pintarOpcionesMonto(caja){
  const sol = Number(valorVigente('monto'));
  if (!(sol > 0)) return;
  const elegido = Number(valorVigente('montooferta'));
  const pre = CONTEXTO.preaprobado;
  const titulo = document.createElement('div');
  titulo.className = 'simulacion-nota opciones-titulo';
  titulo.textContent = 'Opciones según lo solicitado (' + formatoDato('monto', sol) + '):';
  const fila = document.createElement('div');
  fila.className = 'opciones-monto';
  opcionesMonto(sol).forEach((m) => {
    const b = document.createElement('button');
    b.type = 'button';
    const supera = pre && m > pre;
    b.className = 'opcion-monto' + (m === elegido ? ' elegida' : '') + (supera ? ' supera' : '') +
                  (m === sol ? ' solicitado' : '');
    const v = document.createElement('span'); v.className = 'opcion-valor'; v.textContent = formatoDato('monto', m);
    const c = cuotaPara(m);
    const q = document.createElement('span'); q.className = 'opcion-cuota';
    q.textContent = c == null ? '—' : formatoDato('monto', c);
    b.append(v, q);
    b.title = (m === sol ? 'Lo que pidió el cliente. ' : m > sol ? 'Más de lo solicitado. ' : 'Menos de lo solicitado. ') +
              (c == null ? '' : 'Cuota ' + formatoDato('monto', c) + '. ') +
              (supera ? 'Supera el preaprobado (' + formatoDato('monto', pre) + ').' : '');
    b.onclick = () => elegirMontoOferta(m);
    fila.appendChild(b);
  });
  caja.append(titulo, fila);
}

/**
 * Tasa de la campana precargada (catalogo: tasaPorDefecto) para que la cuota
 * salga apenas hay monto y cuotas. Es una propuesta mas: se confirma con OK, se
 * puede corregir, y si en la conversacion se dice otra tasa, gana la dicha.
 */
function aplicarTasaPorDefecto(){
  const t = Number(CATALOGO && CATALOGO.tasaPorDefecto);
  const d = V.datos && V.datos.tasa;
  if (!(t > 0) || !d || d.estado !== 'vacio') return;
  V.datos.tasa = Object.assign(datoVacio(), { valor: t, estado: 'detectado', origen: 'defecto' });
  pintarDato(DATOS_SOLICITUD.find((x) => x.id === 'tasa'));
}

/** La frase que el ejecutivo le dice al cliente, arriba de la pestana Oferta. */
function pintarSimulacion(){
  const caja = $('simulacion');
  if (!caja) return;
  caja.innerHTML = '';
  const cuota = cuotaCalculada();
  const monto = Number(valorVigente('montooferta')), n = Number(valorVigente('plazo'));
  const tasa = valorVigente('tasa');
  if (cuota == null){
    caja.classList.add('vacia');
    caja.textContent = 'Indique monto y número de cuotas para calcular la cuota.';
    pintarOpcionesMonto(caja);
    return;
  }
  caja.classList.remove('vacia');
  const frase = document.createElement('div');
  frase.className = 'simulacion-frase';
  const b1 = document.createElement('strong'); b1.textContent = formatoDato('monto', monto);
  const b2 = document.createElement('strong'); b2.textContent = n + ' cuotas';
  const b3 = document.createElement('strong'); b3.className = 'simulacion-cuota';
  b3.textContent = formatoDato('monto', cuota);
  frase.append(b1, ' en ', b2, ' de ', b3);
  const nota = document.createElement('div');
  nota.className = 'simulacion-nota';
  nota.textContent = 'Tasa ' + formatoDato('porcentaje', tasa) + ' mensual · sin seguros ni impuestos';
  caja.append(frase, nota);
  pintarOpcionesMonto(caja);
}

function recalcularCuota(){
  pintarSimulacion();
  const d = V.datos && V.datos.valorcuota;
  if (!d || d.estado === 'confirmado' || d.estado === 'editado') return;
  const cuota = cuotaCalculada();
  if (cuota == null){
    // si dejo de haber datos para calcularla, la calculada ya no se sostiene
    if (d.origen === 'calculo'){ V.datos.valorcuota = datoVacio(); pintarDato(DATOS_SOLICITUD.find((x) => x.id === 'valorcuota')); }
    return;
  }
  if (d.origen === 'calculo' && d.valor === cuota) return;
  V.datos.valorcuota = Object.assign(datoVacio(), { valor: cuota, estado: 'detectado', origen: 'calculo',
    evidencia: null });
  pintarDato(DATOS_SOLICITUD.find((x) => x.id === 'valorcuota'), true);
}

/* El RUT dicho con digitos se reconoce sin esperar al modelo; solo se acepta
   si el digito verificador calza, para no confundirlo con otra cifra. */
const RUT_EN_TEXTO = /\b\d{1,2}\.?\d{3}\.?\d{3}\s*-?\s*[\dkK]\b/g;
/* Como llega el RUT desde Azure Speech: "12345678. Guión 5", "12.345.678 guion
   ka". Se lleva a "12345678-5" antes de buscar; el digito verificador sigue
   siendo el filtro contra cualquier otra cifra. */
function normalizarDictadoRut(texto){
  return String(texto)
    .replace(/[.,]?\s*\b(gui[oó]n|raya)\b\s*/gi, '-')
    .replace(/-\s*ka\b/gi, '-K');
}

function rutPorPatron(texto){
  const m = normalizarDictadoRut(texto).match(RUT_EN_TEXTO);
  // sin guion ni puntos, 9 digitos seguidos pueden ser un celular ("987654321"):
  // se exige forma de RUT de persona (no empieza con 9, cuerpo bajo 50 millones)
  const plausible = (x) => /[-.]/.test(x) ||
    (x[0] !== '9' && Number(partesRut(x).cuerpo) < 50000000);
  const valido = (m || []).reverse().find((x) => rutValido(x) && plausible(x));
  if (valido) proponerDato('rut', valido, texto);
}

/* RUT por contexto. Azure Speech casi nunca escribe "RUT": sale "root", "ruth",
   "rud", "surat", "mirate". En una atencion financiera, si se pide el RUT y se
   responde con un numero, ese numero es el RUT, aunque no se diga "guion": el
   ultimo digito (o K) es el verificador. Se mira la frase que lo pide y las dos
   siguientes. Si el verificador no calza, igual se propone y la ficha avisa.
   No se toma un numero con forma de celular ni uno pegado o mal cortado. */
const PIDE_RUT = /(^|[^a-záéíóúñ])(rut|ruts|root|ruth|rud|run|rot|surat|surac|m[ií]rate|carnet|c[eé]dula)(?![a-záéíóúñ])/i;
const FRASES_TRAS_PEDIR_RUT = 2;

function rutPorContexto(texto){
  const t = normalizarDictadoRut(texto);
  const m = t.match(PIDE_RUT);
  let tramo = null;
  if (m){
    V.ventanaRut = FRASES_TRAS_PEDIR_RUT;
    tramo = t.slice(m.index + m[0].length);        // lo que viene despues de pedirlo
  } else if (V.ventanaRut > 0){
    V.ventanaRut--;
    tramo = t;
  }
  if (!tramo) return;
  // primer tramo numerico: digitos con puntos, espacios o guion, terminado en digito o K
  const n = tramo.match(/\d[\d.\s-]*[\dkK]\b/);
  if (!n) return;
  const crudo = n[0];
  const limpio = crudo.replace(/[^\dkK]/g, '').toUpperCase();
  if (limpio.length < 8 || limpio.length > 9) return;     // pegado o cortado: no se inventa
  if (!/^\d+[\dK]$/.test(limpio)) return;
  if (!/[-.]/.test(crudo) && limpio[0] === '9') return;   // forma de celular
  V.ventanaRut = 0;
  proponerDato('rut', limpio.slice(0, -1) + '-' + limpio.slice(-1), texto);
}

/** Arma los campos una sola vez; despues se actualizan sin perder el foco. */
function pintarDatos(){
  const conts = { cliente: $('datosCliente'), oferta: $('datosOferta') };
  if (!conts.cliente) return;
  Object.values(conts).forEach((x) => { x.innerHTML = ''; });
  let grupo = null;
  DATOS_SOLICITUD.forEach((c) => {
    const cont = conts[c.pestana];
    if (c.grupo !== grupo){
      grupo = c.grupo;
      const h = document.createElement('h3');
      h.className = 'trh datos-grupo';
      h.textContent = grupo;
      cont.appendChild(h);
    }
    const box = document.createElement('div');
    box.className = 'dato';
    box.id = 'dato_' + c.id;

    const lab = document.createElement('label');
    lab.htmlFor = 'datoIn_' + c.id;
    lab.textContent = c.titulo;
    box.appendChild(lab);

    const fila = document.createElement('div');
    fila.className = 'dato-fila';
    let inp;
    if (c.tipo === 'lista'){
      inp = document.createElement('select');
      llenarSelect(inp, opcionesDe(c), '');
    } else {
      inp = document.createElement('input');
      inp.type = 'text';
      inp.autocomplete = 'off';
      inp.spellcheck = false;
      inp.inputMode = { monto: 'numeric', entero: 'numeric', porcentaje: 'decimal', telefono: 'tel' }[c.tipo] || 'text';
      inp.placeholder = { rut: '12.345.678-5', monto: '$0', telefono: '+56 9 1234 5678',
                          entero: '36', porcentaje: '1,49 %' }[c.tipo] || '';
    }
    inp.id = 'datoIn_' + c.id;
    inp.addEventListener(c.tipo === 'lista' ? 'change' : 'input', () => {
      const d = V.datos[c.id];
      if (d.estado === 'confirmado') return;
      d.estado = 'editado'; d.error = ''; d.corregido = true;
      pintarDato(c, false, true);
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmarDato(c); });
    fila.appendChild(inp);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary small';
    btn.id = 'datoBtn_' + c.id;
    btn.onclick = () => confirmarDato(c);
    fila.appendChild(btn);
    box.appendChild(fila);

    if (c.id === 'plazo'){
      const chips = document.createElement('div');
      chips.className = 'chips';
      ((CATALOGO && CATALOGO.plazosRapidos) || []).forEach((n) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'chip'; b.textContent = n;
        b.title = n + ' cuotas';
        b.onclick = () => {
          const d = V.datos[c.id];
          if (d.estado === 'confirmado') return;
          inp.value = String(n);
          inp.dispatchEvent(new Event('input'));
        };
        chips.appendChild(b);
      });
      box.appendChild(chips);
    }

    const est = document.createElement('div');
    est.className = 'dato-estado';
    est.id = 'datoEst_' + c.id;
    box.appendChild(est);

    const ev = document.createElement('div');
    ev.className = 'crit-evidencia hidden';
    ev.id = 'datoEv_' + c.id;
    box.appendChild(ev);

    cont.appendChild(box);
    pintarDato(c);
  });
}

/** `soloEstado` evita reescribir el campo mientras la persona escribe. */
function pintarDato(c, recien, soloEstado){
  const d = V.datos[c.id];
  const box = $('dato_' + c.id);
  if (!d || !box) return;
  const inp = $('datoIn_' + c.id), btn = $('datoBtn_' + c.id);
  const est = $('datoEst_' + c.id), ev = $('datoEv_' + c.id);

  if (!soloEstado){
    inp.value = (c.tipo === 'monto' || c.tipo === 'porcentaje') ? formatoDato(c.tipo, d.valor)
              : (d.valor == null ? '' : String(d.valor));
  }
  const confirmado = d.estado === 'confirmado';
  if (c.tipo === 'lista') inp.disabled = confirmado; else inp.readOnly = confirmado;
  btn.textContent = confirmado ? 'Editar' : 'OK';
  btn.className = confirmado ? 'ghost small' : 'primary small';

  box.className = 'dato' + (d.estado === 'detectado' ? ' detectado' : '') +
                  (d.estado === 'editado' ? ' editado' : '') +
                  (confirmado ? ' confirmado' : '') + (recien ? ' recien' : '');

  let texto = '', clase = '';
  // un error de traspaso se explica abajo, junto a como reintentar
  if (d.error && !confirmado){ texto = d.error; clase = 'bad'; }
  // vacio, detectado y corregido se leen en el color del borde: con siete
  // campos, una linea de estado por campo no cabe
  else if (d.estado === 'detectado' && c.tipo === 'rut' && !rutValido(d.valor)){
    texto = 'El dígito verificador no corresponde.'; clase = 'bad';
  }
  else if (d.interpretacion && d.estado === 'detectado'){
    texto = 'Interpretado: ' + d.interpretacion + '. Revise antes de confirmar.';
  }
  else if (d.origen === 'opcion' && d.estado === 'detectado'){
    texto = 'Igual a lo solicitado: elija otra opción arriba si corresponde.';
  }
  else if (d.origen === 'defecto' && d.estado === 'detectado'){
    texto = 'Tasa por defecto de la campaña.';
  }
  else if (d.origen === 'calculo' && d.estado === 'detectado'){
    texto = 'Calculada con monto, plazo y tasa · sin seguros ni impuestos.';
  }
  else if (confirmado){
    texto = { enviando: 'Traspasando al caso…',
              ok: '✓ En el caso',
              error: 'Confirmado, pero no llegó al caso: ' + (d.error || 'sin respuesta') +
                     '. Use Editar y OK para reintentar.',
              'sin-dynamics': 'Confirmado. Para traspasarlo al caso, use esta pantalla desde Dynamics.'
            }[d.traspaso] || 'Confirmado.';
    clase = d.traspaso === 'ok' ? 'ok' : d.traspaso === 'error' ? 'bad' : '';
  }
  est.textContent = texto;
  est.className = 'dato-estado' + (clase ? ' ' + clase : '');

  // corregido a mano: la cita queda como respaldo de lo que se escuchó
  ev.textContent = !d.evidencia ? '' :
    (d.corregido ? 'Corregido a mano. En la conversación: ' : '') + '«' + d.evidencia + '»';
  ev.title = d.evidencia || '';
  // la cita importa mientras el dato espera revision; despues queda al pasar el mouse
  ev.classList.toggle('hidden', !d.evidencia || confirmado);
  actualizarContadores();
  if (c.id === 'montooferta') pintarTemasVivo(-1);
  if (c.id === 'monto') proponerMontoOferta();
  if (c.id === 'montooferta' || c.id === 'plazo' || c.id === 'tasa' || c.id === 'monto') recalcularCuota();
  box.title = d.evidencia ? 'Dicho en la conversación: «' + d.evidencia + '»' : '';
}

function confirmarDato(c){
  const d = V.datos[c.id];
  if (d.estado === 'confirmado'){
    // Editar: vuelve a abrir el campo; lo traspasado se reemplaza al confirmar
    d.estado = 'editado'; d.traspaso = null; d.error = '';
    pintarDato(c, false, true);
    $('datoIn_' + c.id).focus();
    return;
  }
  const r = leerDato(c, $('datoIn_' + c.id).value);
  if (r.error){ d.error = r.error; pintarDato(c, false, true); return; }
  d.valor = r.valor; d.estado = 'confirmado'; d.error = '';
  traspasarDato(c);
}

/* Traspaso al caso: el formulario de Dynamics escribe el campo con la sesion
   del usuario y responde. Mismo canal y misma validacion de origen que la
   transcripcion. */
/* Envios al caso pendientes de respuesta, por campo. Un envio nuevo del
   mismo campo reemplaza al anterior. */
const ENVIOS = {};

/**
 * Pide al formulario de Dynamics que escriba un campo del caso. Resuelve con
 * {ok, error} cuando responde, o con error si no responde a tiempo. Fuera de
 * Dynamics resuelve {sinDynamics: true}.
 */
function enviarACaso(campo, valor){
  if (!EN_IFRAME || !ORIGEN_PADRE) return Promise.resolve({ ok: false, sinDynamics: true });
  if (ENVIOS[campo]) ENVIOS[campo].resolver({ ok: false, error: 'reemplazado por un envío nuevo' });
  return new Promise((resolver) => {
    const envio = { resolver: (r) => { clearTimeout(envio.t); delete ENVIOS[campo]; resolver(r); } };
    envio.t = setTimeout(() => envio.resolver({ ok: false,
      error: 'Dynamics no respondió. ¿Está actualizado el recurso web?' }), DATO_TRASPASO_MS);
    ENVIOS[campo] = envio;
    try {
      window.parent.postMessage({ tipo: 'wit-dato', recordId: S.id, campo, valor }, ORIGEN_PADRE);
    } catch (e){
      envio.resolver({ ok: false, error: e.message });
    }
  });
}

async function traspasarDato(c){
  const d = V.datos[c.id];
  d.traspaso = 'enviando';
  pintarDato(c);
  const valor = d.valor;
  const r = await enviarACaso(c.id, valor);
  // si mientras tanto se edito o se volvio a confirmar otro valor, este resultado ya no aplica
  if (d.estado !== 'confirmado' || d.valor !== valor) return;
  d.traspaso = r.sinDynamics ? 'sin-dynamics' : r.ok ? 'ok' : 'error';
  d.error = r.ok || r.sinDynamics ? '' : (r.error || 'error desconocido');
  pintarDato(c);
}

function escucharRespuestaDynamics(){
  window.addEventListener('message', (ev) => {
    // se valida el origen (el dominio de Dynamics) y no la ventana: en la
    // interfaz unificada la respuesta la envia el iframe oculto donde corren
    // los scripts del formulario, del mismo dominio pero distinto de parent
    if (!ORIGEN_PADRE || ev.origin !== ORIGEN_PADRE) return;
    const m = ev.data;
    if (m && m.tipo === 'wit-contexto'){ CONTEXTO.pedido = true; recibirContexto(m); return; }
    if (!m || m.tipo !== 'wit-dato-resultado' || !ENVIOS[m.campo]) return;
    const envio = ENVIOS[m.campo];
    if (m.ok){ clearTimeout(envio.tError); envio.resolver({ ok: true }); return; }
    // un rechazo espera un momento: puede responder mas de una copia del
    // script del formulario (al navegar entre casos queda viva la anterior) y
    // el OK de la copia correcta siempre gana
    if (!envio.tError){
      envio.tError = setTimeout(() => {
        if (ENVIOS[m.campo] === envio) envio.resolver({ ok: false, error: m.error });
      }, 2000);
    }
  });
}

/* ---------- Clasificacion de la atencion (modo en vivo) ----------

   Al terminar la conversacion (o con "Proponer" durante ella) se propone
   Clasificacion > Motivo > Submotivo del catalogo, con la frase que lo
   respalda. La persona puede cambiarlo; al dar OK se escribe en el caso.
   El catalogo vive en assets/catalogo.json: la misma fuente con la que se
   crean las opciones en Dynamics. */
let CATALOGO = null;

async function cargarCatalogo(){
  try {
    const r = await fetch('assets/catalogo.json?v=' + VERSION);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    CATALOGO = await r.json();
    pintarDatos();
    aplicarTasaPorDefecto();
  } catch (e){
    CATALOGO = { clasificaciones: [] };
    setMsg($('clasifEstado'), 'No se pudo cargar el catálogo de clasificación (' + e.message + ').', 'bad');
  }
  pintarSelectClasif();
}

/** Todas las combinaciones validas, para que el modelo elija una. */
const opcionesCatalogo = () => (CATALOGO ? CATALOGO.clasificaciones : []).flatMap((c) =>
  c.motivos.flatMap((m) => m.submotivos.map((sm) => [c.nombre, m.nombre, sm])));

function llenarSelect(sel, valores, elegido){
  sel.innerHTML = '';
  const vacio = document.createElement('option');
  vacio.value = ''; vacio.textContent = '— elegir —';
  sel.appendChild(vacio);
  valores.forEach((v) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    sel.appendChild(o);
  });
  sel.value = valores.indexOf(elegido) !== -1 ? elegido : '';
}

/** Selectores en cascada: cada nivel solo ofrece lo que cabe bajo el anterior. */
function pintarSelectClasif(){
  const k = V.clasif || {};
  const cs = (CATALOGO ? CATALOGO.clasificaciones : []);
  llenarSelect($('clasifC'), cs.map((c) => c.nombre), k.clasificacion);
  const c = cs.find((x) => x.nombre === $('clasifC').value);
  llenarSelect($('clasifM'), c ? c.motivos.map((m) => m.nombre) : [], k.motivo);
  const m = c && c.motivos.find((x) => x.nombre === $('clasifM').value);
  llenarSelect($('clasifS'), m ? m.submotivos : [], k.submotivo);
  pintarClasif();
}

function pintarClasif(){
  const k = V.clasif;
  if (!k) return;
  const confirmado = k.estado === 'confirmado';
  ['clasifC', 'clasifM', 'clasifS'].forEach((id) => { $(id).disabled = confirmado; });
  $('clasifOk').textContent = confirmado ? 'Editar' : 'OK';
  $('clasifOk').className = confirmado ? 'ghost small' : 'primary small';
  $('clasifProponer').disabled = confirmado || k.pidiendo;
  $('clasif').className = 'clasif' + (k.estado === 'propuesto' ? ' detectado' : '') +
                          (confirmado ? ' confirmado' : '');

  let texto = '', clase = '';
  if (k.pidiendo) texto = 'Analizando la conversación…';
  else if (k.error && !confirmado){ texto = k.error; clase = 'bad'; }
  else if (k.estado === 'vacio') texto = 'Se propone al terminar la conversación, o con «Proponer».';
  else if (k.estado === 'propuesto') texto = 'Propuesta: revise y confirme con OK.';
  else if (k.estado === 'editado') texto = 'Elegida a mano: confirme con OK.';
  else if (confirmado){
    texto = { enviando: 'Traspasando al caso…', ok: 'Traspasada al caso ✓',
              error: 'No llegó al caso: ' + (k.error || 'sin respuesta') + '. Use Editar y OK para reintentar.',
              'sin-dynamics': 'Confirmada. Para traspasarla al caso, use esta pantalla desde Dynamics.'
            }[k.traspaso] || 'Confirmada.';
    clase = k.traspaso === 'ok' ? 'ok' : k.traspaso === 'error' ? 'bad' : '';
  }
  $('clasifEstado').textContent = texto;
  $('clasifEstado').className = 'dato-estado' + (clase ? ' ' + clase : '');
  $('clasifEv').textContent = k.evidencia ? '«' + k.evidencia + '»' : '';
  $('clasifEv').title = k.evidencia || '';
  $('clasifEv').classList.toggle('hidden', !k.evidencia || k.estado === 'editado');
  actualizarContadores();
}

const clasifVacia = () => ({ estado: 'vacio', clasificacion: '', motivo: '', submotivo: '',
                             evidencia: null, traspaso: null, error: '', pidiendo: false });
/* Bloques de texto libre del cierre. Los redacta el modelo al clasificar y
   la persona los revisa y confirma con OK, como el resto. `vacio` explica por
   que puede quedar en blanco (las notas solo existen si el cliente conto algo
   util para el seguimiento). */
const TEXTOS = {
  coment: { campo: 'comentarios', clave: 'comentarios',
            falta: 'Escriba los comentarios de la gestión.' },
  notas:  { campo: 'notas', clave: 'notas',
            falta: 'Escriba la nota o deje el campo vacío y no la confirme.',
            vacio: 'El cliente no compartió nada personal relevante para el seguimiento.' }
};
const textoVacio = () => ({ estado: 'vacio', texto: '', traspaso: null, error: '', sinContenido: false });

function pintarTexto(id){
  const k = V.textos && V.textos[id];
  if (!k) return;
  const confirmado = k.estado === 'confirmado';
  const ta = $(id + 'Txt');
  if (document.activeElement !== ta) ta.value = k.texto || '';
  ta.readOnly = confirmado;
  $(id + 'Ok').textContent = confirmado ? 'Editar' : 'OK';
  $(id + 'Ok').className = confirmado ? 'ghost small' : 'primary small';
  $(id).className = 'clasif coment' + (k.estado === 'propuesto' ? ' detectado' : '') +
                    (confirmado ? ' confirmado' : '');
  let texto = '', clase = '';
  if (k.error && !confirmado){ texto = k.error; clase = 'bad'; }
  else if (k.estado === 'propuesto') texto = 'Redactado automáticamente: revise y confirme con OK.';
  else if (k.estado === 'vacio' && k.sinContenido) texto = TEXTOS[id].vacio || '';
  else if (confirmado){
    texto = { enviando: 'Traspasando al caso…', ok: '✓ En el caso',
              error: 'No llegó al caso: ' + (k.error || 'sin respuesta') + '. Use Editar y OK para reintentar.',
              'sin-dynamics': 'Confirmado. Para traspasarlo al caso, use esta pantalla desde Dynamics.'
            }[k.traspaso] || 'Confirmado.';
    clase = k.traspaso === 'ok' ? 'ok' : k.traspaso === 'error' ? 'bad' : '';
  }
  $(id + 'Estado').textContent = texto;
  $(id + 'Estado').className = 'dato-estado' + (clase ? ' ' + clase : '');
  actualizarContadores();
}

async function confirmarTexto(id){
  const k = V.textos[id];
  if (k.estado === 'confirmado'){
    k.estado = 'editado'; k.traspaso = null; k.error = '';
    pintarTexto(id);
    return;
  }
  const texto = $(id + 'Txt').value.trim();
  if (!texto){ k.error = TEXTOS[id].falta; pintarTexto(id); return; }
  k.texto = texto; k.estado = 'confirmado'; k.traspaso = 'enviando'; k.error = '';
  pintarTexto(id);
  const r = await enviarACaso(TEXTOS[id].campo, texto);
  if (V.textos[id] !== k || k.estado !== 'confirmado' || k.texto !== texto) return;
  k.traspaso = r.sinDynamics ? 'sin-dynamics' : r.ok ? 'ok' : 'error';
  k.error = r.ok || r.sinDynamics ? '' : (r.error || 'error desconocido');
  pintarTexto(id);
}

/** Propuesta del modelo: solo si nadie lo escribio ni confirmo. */
function proponerTexto(id, valor, simulado){
  const k = V.textos[id];
  if (!k || (k.estado !== 'vacio' && k.estado !== 'propuesto')) return;
  if (valor){
    Object.assign(k, { texto: valor + (simulado ? ' (simulado)' : ''), estado: 'propuesto',
                       error: '', sinContenido: false });
  } else {
    Object.assign(k, { texto: '', estado: 'vacio', sinContenido: true });
  }
  pintarTexto(id);
}

/** Pide la propuesta con TODA la conversacion: el motivo suele decirse al principio. */
async function vivoClasificar(){
  const k = V.clasif;
  if (!k || k.pidiendo) return;
  const quiereClasif = k.estado !== 'confirmado' && k.estado !== 'editado';
  const quiereTexto = Object.values(V.textos || {}).some((t) => t.estado === 'vacio' || t.estado === 'propuesto');
  if (!quiereClasif && !quiereTexto) return;
  const texto = V.frases.map((f) => f.texto).join(' ');
  if (!texto.trim()){ k.error = 'Todavía no hay conversación que clasificar.'; pintarClasif(); return; }
  if (!S.cfg.clasificarUrl){ k.error = 'Falta el endpoint de clasificación.'; pintarClasif(); return; }
  const gen = V.gen;
  k.pidiendo = true; k.error = '';
  pintarClasif();
  try {
    const d = await postJson(S.cfg.clasificarUrl, { texto, recordId: S.id, opciones: opcionesCatalogo() });
    if (gen !== V.gen || V.clasif !== k) return;
    k.pidiendo = false;
    Object.keys(TEXTOS).forEach((id) => proponerTexto(id, d[TEXTOS[id].clave], d.mock));
    // si la persona eligio a mano mientras tanto, manda lo suyo
    if (k.estado === 'editado' || k.estado === 'confirmado'){ pintarClasif(); return; }
    if (!d.propuesta){
      k.error = 'La conversación no calza con ninguna opción del catálogo: elija a mano.';
    } else {
      Object.assign(k, d.propuesta, { estado: 'propuesto', error: '' });
      if (d.mock) k.evidencia = (k.evidencia || '') + ' (simulado)';
    }
    pintarSelectClasif();
  } catch (e){
    if (gen !== V.gen || V.clasif !== k) return;
    k.pidiendo = false;
    k.error = 'No se pudo proponer: ' + e.message;
    pintarClasif();
  }
}

function alCambiarClasif(nivel){
  const k = V.clasif;
  if (!k || k.estado === 'confirmado') return;
  k.clasificacion = $('clasifC').value;
  // cambiar un nivel invalida los de abajo si ya no caben
  k.motivo = nivel === 'C' ? '' : $('clasifM').value;
  k.submotivo = nivel === 'S' ? $('clasifS').value : '';
  k.estado = 'editado'; k.error = '';
  pintarSelectClasif();
}

async function confirmarClasif(){
  const k = V.clasif;
  if (k.estado === 'confirmado'){
    k.estado = 'editado'; k.traspaso = null; k.error = '';
    pintarClasif();
    return;
  }
  if (!$('clasifC').value || !$('clasifM').value || !$('clasifS').value){
    k.error = 'Elija clasificación, motivo y submotivo.';
    pintarClasif();
    return;
  }
  k.clasificacion = $('clasifC').value; k.motivo = $('clasifM').value; k.submotivo = $('clasifS').value;
  k.estado = 'confirmado'; k.traspaso = 'enviando'; k.error = '';
  pintarClasif();
  const elegido = [k.clasificacion, k.motivo, k.submotivo].join('>');
  const rs = await Promise.all([enviarACaso('clasificacion', k.clasificacion),
                                enviarACaso('motivo', k.motivo),
                                enviarACaso('submotivo', k.submotivo)]);
  if (V.clasif !== k || k.estado !== 'confirmado' ||
      [k.clasificacion, k.motivo, k.submotivo].join('>') !== elegido) return;
  const fallo = rs.find((r) => !r.ok && !r.sinDynamics);
  k.traspaso = rs[0].sinDynamics ? 'sin-dynamics' : fallo ? 'error' : 'ok';
  k.error = fallo ? (fallo.error || 'error desconocido') : '';
  pintarClasif();
}

function cargarSdkVoz(){
  if (window.SpeechSDK) return Promise.resolve(window.SpeechSDK);
  return new Promise((ok, mal) => {
    const s = document.createElement('script');
    s.src = SDK_VOZ;
    s.onload  = () => window.SpeechSDK ? ok(window.SpeechSDK)
                                       : mal(new Error('el SDK de voz no se inicializó'));
    s.onerror = () => mal(new Error('no se pudo descargar el SDK de voz'));
    document.head.appendChild(s);
  });
}

async function pedirTokenVoz(){
  const res = await fetch(S.cfg.speechTokenUrl, { method: 'POST' });
  const txt = await res.text();
  let d;
  try { d = JSON.parse(txt); }
  catch (e){ throw new Error('respuesta no es JSON: ' + txt.slice(0, 150)); }
  if (!res.ok) throw new Error(d.error || ('HTTP ' + res.status));
  return d;
}

/**
 * Deja el SDK descargado y un token en mano al abrir la pantalla. Sin esto,
 * ambas cosas ocurrian recien al tocar Grabar y la primera frase aparecia con
 * varios segundos de retraso. Si falla no pasa nada: vivoIniciar lo reintenta.
 */
async function vivoPreparar(){
  if (!S.cfg.speechTokenUrl) return;
  try {
    const tk = await pedirTokenVoz();
    V.previo = { tk, t: Date.now() };
    if (!tk.mock) await cargarSdkVoz();
  } catch (e){
    console.warn('No se pudo preparar la transcripción en vivo', e);
  }
}

/** Token preparado si sigue vigente con margen; si no, uno nuevo. */
async function tokenVozVigente(){
  const p = V.previo;
  V.previo = null;                       // se usa una sola vez
  if (p && Date.now() - p.t < 8 * 60 * 1000) return p.tk;
  return pedirTokenVoz();
}

/** Arranca junto con la grabacion. Si falla, la grabacion sigue igual. */
async function vivoIniciar(){
  vivoReiniciar();
  V.activo = true; V.t0 = performance.now();
  pintarVivoTexto();
  const gen = V.gen;

  if (!S.cfg.speechTokenUrl){
    setMsg($('vivoMsg'), 'Falta el endpoint del token de voz: la revisión en vivo no está disponible.', 'bad');
    return;
  }
  try {
    const tk = await tokenVozVigente();
    if (gen !== V.gen || !V.activo) return;
    if (tk.mock){ V.conectado = true; vivoSimular(); return; }

    const sdk = await cargarSdkVoz();
    if (gen !== V.gen || !V.activo) return;

    const cfg = sdk.SpeechConfig.fromAuthorizationToken(tk.token, tk.region);
    cfg.speechRecognitionLanguage = S.cfg.locale || 'es-CL';
    // el mismo audio que ya se esta grabando, no una segunda apertura del
    // microfono: hay dispositivos (las webcams, tipicamente) que Windows no
    // entrega dos veces y fallan con NotReadableError. Se pasa un clon para
    // que el SDK pueda cerrar sus pistas sin cortar la grabacion.
    const audio = (S.stream && S.stream.active)
      ? sdk.AudioConfig.fromStreamInput(S.stream.clone())
      : sdk.AudioConfig.fromDefaultMicrophoneInput();
    const rec = new sdk.SpeechRecognizer(cfg, audio);

    if (tk.phrases && tk.phrases.length){
      const lista = sdk.PhraseListGrammar.fromRecognizer(rec);
      tk.phrases.forEach((f) => lista.addPhrase(f));
    }

    rec.sessionStarted = () => { V.conectado = true; pintarVivoTexto(); };
    rec.recognizing = (s, e) => vivoParcial(e.result.text);
    rec.recognized  = (s, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizedSpeech) vivoFrase(e.result.text);
    };
    rec.canceled = (s, e) => {
      if (e.reason === sdk.CancellationReason.Error){
        setMsg($('vivoMsg'), 'La transcripción en vivo se interrumpió: ' + e.errorDetails +
          '. La grabación continúa.', 'bad');
      }
    };

    V.rec = rec;
    rec.startContinuousRecognitionAsync(() => {},
      (err) => setMsg($('vivoMsg'), 'No se pudo iniciar la transcripción en vivo: ' + err +
        '. La grabación continúa.', 'bad'));

    // se renueva antes de que venza, sin cortar el reconocimiento
    V.tokenTimer = setInterval(async () => {
      try { rec.authorizationToken = (await pedirTokenVoz()).token; }
      catch (e){ console.warn('No se pudo renovar el token de voz', e); }
    }, VIVO_TOKEN_MS);
  } catch (e){
    if (gen === V.gen){
      setMsg($('vivoMsg'), 'La transcripción en vivo no está disponible (' + e.message +
        '). La grabación continúa y se transcribe al detener.', 'bad');
    }
  }
}

/* Sin Azure: conversacion de relleno para ver como se marcan los temas. */
const GUION_SIMULADO = [
  'Buenos días, ¿en qué le puedo ayudar?',
  'Hola, quería consultar el saldo de mi cuenta.',
  'Claro, lo reviso. Por cierto, usted tiene un crédito preaprobado de consumo.',
  'No sabía, ¿y de cuánto sería?',
  'Se lo detallo enseguida. También tiene beneficios por ser socio en salud y educación.',
  'Me interesa. ¿Con quién tengo el gusto?',
  'Me llamo Juan Pérez Soto.',
  '¿Me indica su RUT, por favor?',
  'Sí, mi RUT es 12.345.678-5.',
  '¿Cuánto necesita solicitar?',
  'Necesito solicitar $2.000.000.',
  '¿Y cuáles son sus ingresos mensuales?',
  'Mi sueldo es de $850.000 al mes.',
  '¿A qué teléfono lo podemos contactar?',
  'Mi celular es 9 8765 4321.',
  'Le cuento que tenemos una campaña de compra de cartera para usted.',
  'Le podemos ofrecer $5.000.000 a 36 meses.',
  'La cuota quedaría en $185.000, con una tasa de 1,49 % mensual y un CAE de 19,8 %.',
  'Me parece bien, lo voy a pensar y le confirmo mañana.',
  'Perfecto, muchas gracias.'
];

function vivoSimular(){
  $('vivoAviso').textContent = 'Transcripción en vivo SIMULADA: es texto de relleno, ' +
    'no lo que se está diciendo.';
  $('vivoAviso').classList.remove('hidden');
  let i = 0, letras = 0;
  V.simulador = setInterval(() => {
    const frase = GUION_SIMULADO[i];
    if (!frase){ clearInterval(V.simulador); V.simulador = 0; return; }
    letras += 12;
    if (letras < frase.length){
      vivoParcial(frase.slice(0, letras));
    } else {
      vivoFrase(frase);
      i++; letras = 0;
    }
  }, 350);
}

/** Corta el reconocimiento y hace una ultima revision con lo que quede. */
function vivoDetener(){
  if (!V.activo) return;
  V.activo = false;
  clearInterval(V.simulador); V.simulador = 0;
  clearInterval(V.tokenTimer); V.tokenTimer = 0;
  const rec = V.rec;
  V.rec = null;
  // con el SDK, la frase en curso llega igual como reconocida al detener;
  // en el simulador hay que cerrarla a mano
  if (!rec && V.parcial) vivoFrase(V.parcial);
  if (rec){
    rec.stopContinuousRecognitionAsync(() => rec.close(), () => rec.close());
  }
  clearTimeout(V.timer);
  if (V.enCurso) V.pendiente = true;
  else { V.ultima = 0; vivoProgramar(); }
  pintarVivoTexto();
  // la ultima frase llega como reconocida poco despues de detener
  const gen = V.gen;
  setTimeout(() => { if (gen === V.gen){ mostrarPestana('cierre'); vivoClasificar(); } }, 1500);
}

/* ---------- Clip de evidencia ---------- */

const CLIP_MIMES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus',
                    'video/webm', 'video/mp4'];

function clipMime(){
  for (const c of CLIP_MIMES){
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}
const clipExt = (t) => /mp4/.test(t) ? 'mp4' : 'webm';

async function permitirCamara(){
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
    tmp.getTracks().forEach((t) => t.stop());
    await listarCamaras();
    $('btnCam').classList.add('hidden');
    $('btnClipRec').disabled = false;
    await previsualizar();
  } catch (e){
    if (EN_IFRAME && (e.name === 'NotAllowedError' || e.name === 'SecurityError')){
      setMsg($('clipMsg'), 'No se pudo usar la cámara (' + e.name + ').', 'bad');
      pintarDiagnosticoCam();
    } else {
      setMsg($('clipMsg'), 'No se pudo acceder a la cámara: ' + e.name, 'bad');
    }
  }
}

async function listarCamaras(){
  const devs = (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === 'videoinput');
  const sel = $('camSel'), prev = sel.value;
  sel.innerHTML = '';
  if (!devs.length){
    sel.innerHTML = '<option value="">-- sin cámaras detectadas --</option>';
    sel.disabled = true; return;
  }
  devs.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || ('Cámara ' + (i + 1));
    sel.appendChild(o);
  });
  sel.disabled = false;
  if (prev && devs.some((d) => d.deviceId === prev)) sel.value = prev;

  espejarMicrofonos(devs);
}

/** Replica la lista en el selector de la pantalla simple, que es otro control. */
function espejarMicrofonos(devs){
  const sim = $('simpleMic');
  if (!sim) return;
  const prev = sim.value;
  sim.innerHTML = '';
  if (!devs.length){
    sim.innerHTML = '<option value="">-- sin micrófonos detectados --</option>';
    sim.disabled = true;
    return;
  }
  devs.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || ('Micrófono ' + (i + 1));
    sim.appendChild(o);
  });
  sim.disabled = false;
  if (prev && devs.some((d) => d.deviceId === prev)) sim.value = prev;
}

/**
 * Micrófono elegido en la pantalla activa.
 * Un selector deshabilitado o posado sobre el texto de relleno no es una
 * elección: devolver ese texto como si fuera un deviceId hacía que se pidiera
 * un dispositivo inexistente y que nunca se solicitara el permiso.
 */
function valorDeSelector(el){
  if (!el || el.disabled) return '';
  const op = el.options[el.selectedIndex];
  return (op && op.value) ? op.value : '';
}

function micSeleccionado(){
  if (MODO_SIMPLE){
    const v = valorDeSelector($('simpleMic'));
    if (v) return v;
  }
  return valorDeSelector($('micSel'));
}

/** Previsualización en vivo; se rearma al cambiar de cámara. */
async function previsualizar(){
  detenerCamara();
  try {
    const devId = valorDeSelector($('camSel'));
    S.cam.stream = await navigator.mediaDevices.getUserMedia({
      video: devId ? { deviceId: { exact: devId } } : true,
      audio: { echoCancellation: true, noiseSuppression: true }
    });
    $('camHint').classList.add('hidden');
    const v = $('camPrev');
    v.controls = false;
    v.srcObject = S.cam.stream;
    v.muted = true;                      // evita realimentación con el micrófono
    await v.play().catch(() => {});
    setMsg($('clipMsg'), '');
  } catch (e){
    setMsg($('clipMsg'), 'No se pudo abrir la cámara: ' + e.name, 'bad');
  }
}

function detenerCamara(){
  if (S.cam.stream){
    S.cam.stream.getTracks().forEach((t) => t.stop());
    S.cam.stream = null;
  }
}

function grabarClip(){
  if (!S.cam.stream){ setMsg($('clipMsg'), 'Primero permita la cámara.', 'bad'); return; }
  S.cam.tope = (Number($('clipMax').value) || 60) * 1000;
  S.cam.mime = clipMime();
  S.cam.chunks = [];
  S.cam.blob = null;

  try {
    S.cam.rec = new MediaRecorder(S.cam.stream,
      S.cam.mime ? { mimeType: S.cam.mime, videoBitsPerSecond: 1500000 } : undefined);
  } catch (e){
    setMsg($('clipMsg'), 'Este navegador no puede grabar video: ' + e.message, 'bad'); return;
  }

  S.cam.rec.ondataavailable = (e) => { if (e.data && e.data.size) S.cam.chunks.push(e.data); };
  S.cam.rec.onstop = clipDetenido;
  S.cam.rec.start(1000);
  S.cam.t0 = performance.now();

  // el tope de duración es parte del diseño: un clip de evidencia no debe
  // convertirse en una grabación larga sin que nadie lo note
  S.cam.tick = setInterval(() => {
    const ms = performance.now() - S.cam.t0;
    const resta = Math.max(0, S.cam.tope - ms);
    $('clipTimer').textContent = fmtTime(ms) + '  /  -' + fmtTime(resta);
    if (ms >= S.cam.tope) detenerClip();
  }, 200);

  $('clipTimer').classList.remove('hidden');
  $('camDot').classList.remove('hidden');
  $('btnClipRec').disabled = true; $('btnClipStop').disabled = false;
  $('btnClipUp').disabled = true; $('btnClipDrop').disabled = true;
  $('camSel').disabled = true; $('clipMax').disabled = true;
  $('sClipState').textContent = 'Grabando'; $('sClipState').className = 'pill live';
  setMsg($('clipMsg'), '');
}

function detenerClip(){
  if (!S.cam.rec || S.cam.rec.state === 'inactive') return;
  S.cam.durMs = performance.now() - S.cam.t0;
  clearInterval(S.cam.tick);
  S.cam.rec.stop();
  $('btnClipStop').disabled = true;
  $('camDot').classList.add('hidden');
}

function clipDetenido(){
  const blob = new Blob(S.cam.chunks, { type: S.cam.mime || 'video/webm' });
  S.cam.blob = blob;
  const ext = clipExt(blob.type);
  S.cam.blobName = 'clip-' + stamp(new Date()) + '-' + rand4() + '.' + ext;

  const v = $('camPrev');
  v.srcObject = null;
  v.src = URL.createObjectURL(blob);
  v.muted = false; v.controls = true;

  $('clipMeta').innerHTML = '';
  ['Duración: ' + fmtTime(S.cam.durMs), 'Tamaño: ' + fmtSize(blob.size), 'Tipo: ' + blob.type]
    .forEach((t) => { const sp = document.createElement('span'); sp.textContent = t;
                      $('clipMeta').appendChild(sp); });

  $('btnClipRec').disabled = false; $('btnClipUp').disabled = false;
  $('btnClipDrop').disabled = false;
  $('camSel').disabled = false; $('clipMax').disabled = false;
  $('clipTimer').classList.add('hidden');
  $('sClipState').textContent = 'Listo para subir'; $('sClipState').className = 'pill';

  if (blob.size > 60 * 1024 * 1024){
    setMsg($('clipMsg'), 'El clip pesa ' + fmtSize(blob.size) +
      '. La subida es de una sola pieza y en una red inestable puede fallar.', 'bad');
  }
}

async function descartarClip(){
  S.cam.blob = null; S.cam.chunks = []; S.cam.durMs = 0;
  const v = $('camPrev');
  v.controls = false; v.removeAttribute('src'); v.load();
  $('clipMeta').innerHTML = '';
  $('btnClipUp').disabled = true; $('btnClipDrop').disabled = true;
  $('clipProgWrap').classList.add('hidden'); setMsg($('clipMsg'), '');
  $('sClipState').textContent = 'Listo'; $('sClipState').className = 'pill';
  await previsualizar();
}

async function subirClip(){
  if (!S.cam.blob || !S.id) return;
  $('btnClipUp').disabled = true;
  $('clipProgWrap').classList.remove('hidden');
  $('clipProgBar').style.width = '0'; $('clipProgTxt').textContent = '0%';
  setMsg($('clipMsg'), 'Subiendo clip...');

  const contentType = S.cam.blob.type || 'video/webm';
  const ext = clipExt(contentType);

  try {
    let t;
    if (S.cfg.mode === 'sas'){
      const u = new URL(S.cfg.sasUrl);
      const base = u.origin + u.pathname.replace(/\/+$/, '');
      const path = (S.id + '/' + S.cam.blobName).split('/').map(encodeURIComponent).join('/');
      t = { uploadUrl: base + '/' + path + u.search, blobUrl: base + '/' + path,
            blobName: S.id + '/' + S.cam.blobName, contentType: contentType };
    } else {
      let url = S.cfg.fnUrl;
      if (S.cfg.fnKey) url += (url.includes('?') ? '&' : '?') + 'code=' + encodeURIComponent(S.cfg.fnKey);
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordId: S.id, ext: ext, kind: 'video',
                               contentType: contentType, durationMs: Math.round(S.cam.durMs) })
      });
      if (!res.ok) throw new Error('La Function respondió ' + res.status + ': ' +
                                   (await res.text()).slice(0, 200));
      const j = await res.json();
      if (!j.uploadUrl) throw new Error('La Function no devolvió uploadUrl.');
      t = { uploadUrl: j.uploadUrl, blobUrl: j.blobUrl || j.uploadUrl.split('?')[0],
            blobName: j.blobName, contentType: j.contentType || contentType };
    }

    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', t.uploadUrl, true);
      xhr.setRequestHeader('x-ms-blob-type', 'BlockBlob');
      xhr.setRequestHeader('Content-Type', t.contentType);
      xhr.setRequestHeader('x-ms-blob-content-type', t.contentType);
      xhr.setRequestHeader('x-ms-meta-recordid', asciiMeta(S.id));
      xhr.setRequestHeader('x-ms-meta-durationms', String(Math.round(S.cam.durMs)));
      xhr.setRequestHeader('x-ms-meta-createdat', new Date().toISOString());
      xhr.setRequestHeader('x-ms-meta-source', 'web-recorder-clip');
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const p = Math.round(e.loaded / e.total * 100);
        $('clipProgBar').style.width = 'calc(' + p + '% - ' + (p * 0.52) + 'px)';
        $('clipProgTxt').textContent = p + '%';
      };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve()
        : reject(new Error('HTTP ' + xhr.status + ' ' + String(xhr.responseText).slice(0, 300)));
      xhr.onerror = () => reject(new Error('Fallo de red o CORS.'));
      xhr.send(S.cam.blob);
    });

    setMsg($('clipMsg'), 'Clip subido: ' + t.blobName, 'ok');
    $('sClipState').textContent = 'Subido'; $('sClipState').className = 'pill ok';
    if (SOLO_CLIP && window.opener && !window.opener.closed){
      try {
        window.opener.postMessage({ tipo: 'wit-clip-listo', recordId: S.id,
                                    blobName: t.blobName }, location.origin);
      } catch (e) { console.warn('No se pudo avisar a la ventana de origen', e); }
    }
  } catch (e){
    setMsg($('clipMsg'), 'Error al subir el clip: ' + e.message, 'bad');
    $('btnClipUp').disabled = false;
  }
}

/**
 * Abre la misma página en modo autorización, como ventana propia y pequeña.
 * Fuera del iframe el navegador sí muestra su diálogo nativo de permiso.
 */
function abrirVentanaPermiso(){
  const u = new URL(location.href);
  u.searchParams.set('solo', 'permiso');
  u.searchParams.delete('parent');
  u.searchParams.delete('id');
  u.searchParams.delete('lock');
  const w = window.open(u.toString(), 'wit_permiso',
                        'width=440,height=320,menubar=no,toolbar=no,location=no');
  if (!w){
    setMsg($('clipMsg'), 'El navegador bloqueó la ventana emergente. ' +
      'Permita las ventanas emergentes para este sitio y reintente.', 'bad');
    return;
  }
  setMsg($('clipMsg'), 'Autorice la cámara en la ventana que se abrió y vuelva aquí.');
  w.focus();
}

/** La ventana de autorización avisa cuando el usuario ya aceptó. */
function escucharVentanaPermiso(){
  window.addEventListener('message', (ev) => {
    if (ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.tipo !== 'wit-permiso-ok') return;
    setMsg($('clipMsg'), 'Cámara autorizada. Reintentando aquí…');
    permitirCamara().then(pintarDiagnosticoCam);
  });
}

/**
 * Muestra el estado real de los dos controles que deciden si la cámara sirve
 * aquí, para no tener que adivinar cuál de los dos está cerrando el paso.
 */
async function pintarDiagnosticoCam(){
  const caja = $('camDiag');
  const delegada = document.featurePolicy && document.featurePolicy.allowsFeature
    ? document.featurePolicy.allowsFeature('camera') : null;

  let permiso = 'desconocido';
  try {
    if (navigator.permissions && navigator.permissions.query){
      permiso = (await navigator.permissions.query({ name: 'camera' })).state;
    }
  } catch (e) { /* Firefox no expone 'camera' en permissions */ }

  const si = (v) => v === true  ? '<span class="si">sí</span>'
           : v === false ? '<span class="no">no</span>' : '<span>no se pudo determinar</span>';

  const estadoPermiso = permiso === 'granted' ? '<span class="si">concedido</span>'
                      : permiso === 'denied'  ? '<span class="no">denegado</span>'
                      : permiso === 'prompt'  ? 'aún no preguntado'
                      : permiso;

  let veredicto;
  if (delegada === false){
    veredicto = '<b>El bloqueo está en el contenedor, no en su autorización.</b> ' +
      'El iframe de Dynamics no declara <code>camera</code> en su atributo ' +
      '<code>allow</code>, y ese control se evalúa antes que el permiso del usuario. ' +
      'Autorizar de nuevo no va a cambiar esto: hay que corregir el recurso web ' +
      '(<code>allow="microphone; camera"</code>).';
  } else if (permiso === 'denied'){
    veredicto = 'El contenedor sí delega la cámara, pero el permiso está denegado para este ' +
      'sitio. Use «Autorizar cámara», o restablezca el permiso desde el candado de la barra ' +
      'de direcciones.';
  } else if (delegada === true){
    veredicto = 'Ambos controles están en orden: use «Permitir cámara» para comenzar.';
  } else {
    veredicto = 'No se pudo determinar el estado del contenedor en este navegador.';
  }

  caja.innerHTML =
    '<h4>Diagnóstico de la cámara</h4><ul>' +
    '<li>El contenedor delega la cámara a esta página: ' + si(delegada) + '</li>' +
    '<li>Permiso del usuario para este sitio: ' + estadoPermiso + '</li>' +
    '<li>Página incrustada en otro sitio: ' + si(EN_IFRAME) + '</li>' +
    '</ul><div class="veredicto">' + veredicto + '</div>';
  caja.classList.remove('hidden');
}

/** Pide el permiso en la ventana de autorización y avisa a quien la abrió. */
async function permitirAqui(){
  const btn = $('btnPermitirAqui');
  btn.disabled = true;
  setMsg($('permisoMsg'), 'Esperando su respuesta en el diálogo del navegador…');
  try {
    const st = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    // solo interesa que quede concedido: no se retiene la captura
    st.getTracks().forEach((t) => t.stop());
    setMsg($('permisoMsg'), 'Cámara y micrófono autorizados. Ya puede cerrar esta ventana.', 'ok');
    if (window.opener && !window.opener.closed){
      try {
        window.opener.postMessage({ tipo: 'wit-permiso-ok' }, location.origin);
      } catch (e) { console.warn('No se pudo avisar a la ventana de origen', e); }
    }
  } catch (e){
    btn.disabled = false;
    setMsg($('permisoMsg'), e.name === 'NotAllowedError'
      ? 'Autorización rechazada. Vuelva a intentarlo y elija Permitir.'
      : 'No se pudo autorizar: ' + e.name, 'bad');
  }
}

function habilitarClip(){
  $('clip').classList.remove('disabled');
  $('sClipState').textContent = 'Listo'; $('sClipState').className = 'pill';
}

/* ---------- Paso 2: micrófonos ---------- */
/**
 * Traduce el error de getUserMedia a algo accionable. Cada nombre tiene una
 * causa distinta: confundir "sin permiso" con "Windows no entrega el
 * dispositivo" manda al usuario a revisar lo que no es.
 */
function avisarErrorMic(e){
  // dentro de un iframe, NotAllowedError casi siempre es el marco, no el usuario
  const delMarco = EN_IFRAME && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
  let texto;
  if (delMarco){
    texto = AVISO_MARCO;
  } else if (e.name === 'NotAllowedError'){
    texto = 'El navegador tiene bloqueado el micrófono para este sitio. Haga clic en el ícono ' +
      'del candado, junto a la dirección, cambie Micrófono a «Permitir» y recargue la página.';
  } else if (e.name === 'NotReadableError' || e.name === 'AbortError'){
    // hay permiso: es el sistema el que no entrega el dispositivo
    texto = 'El permiso está concedido, pero Windows no le entrega el micrófono al navegador. ' +
      'Revise que ninguna otra aplicación lo esté usando (Teams, Zoom, Webex) y que en ' +
      'Configuración de Windows > Privacidad y seguridad > Micrófono esté activado el acceso ' +
      'para las aplicaciones de escritorio. También puede elegir otro micrófono de la lista ' +
      'y volver a intentar.';
  } else if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError'){
    texto = 'No se encontró el micrófono. Revise que esté conectado y encendido, o elija otro de la lista.';
  } else {
    texto = 'No se pudo acceder al micrófono: ' + e.name + '. ' +
      'Revise el permiso del sitio en el navegador y que la página se sirva por HTTPS o localhost.';
  }
  // la pantalla simple no muestra el banner: el error va bajo los botones
  if (MODO_SIMPLE){
    if (delMarco) msgConEscape($('simpleErr'), texto);
    else setMsg($('simpleErr'), texto, 'bad');
  } else {
    banner(texto, delMarco);
  }
}

/** Pide el permiso y prueba abrir el micrófono. Devuelve si quedó utilizable. */
async function askPermission(){
  // si ya hay uno elegido se prueba ese: el predeterminado puede ser justo el que falla
  const devId = micSeleccionado();
  try {
    const tmp = await navigator.mediaDevices.getUserMedia(
      { audio: devId ? { deviceId: { exact: devId } } : true });
    tmp.getTracks().forEach((t) => t.stop());
    await listMics();
    S.micOk = true;
    $('btnPerm').classList.add('hidden');
    $('simplePermitir').classList.add('hidden');
    $('btnRec').disabled = false;
    $('vizmsg').textContent = 'Listo para grabar';
    return true;
  } catch (e){
    S.micOk = false;
    avisarErrorMic(e);
    // con permiso concedido la lista ya trae nombres: se ofrece elegir otro
    if (e.name === 'NotReadableError' || e.name === 'AbortError' ||
        e.name === 'NotFoundError' || e.name === 'OverconstrainedError'){
      try { await listMics(); } catch (e2) {}
      $('simplePermitir').textContent = 'Probar micrófono';
    }
    return false;
  }
}

/** Boton de la pantalla simple: abre el dialogo de permiso del navegador. */
async function simplePermitir(){
  const btn = $('simplePermitir');
  btn.disabled = true;
  setMsg($('simpleErr'), '');
  simpleEstado('Solicitando acceso al micrófono…', true);
  const ok = await askPermission();
  btn.disabled = false;
  simpleEstado(ok ? 'Listo para grabar' : 'Sin acceso al micrófono', false);
}
async function listMics(){
  const devs = (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === 'audioinput');
  const sel = $('micSel'), prev = sel.value;
  sel.innerHTML = '';
  if (!devs.length){
    sel.innerHTML = '<option value="">-- sin micrófonos detectados --</option>';
    sel.disabled = true; return;
  }
  devs.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || ('Micrófono ' + (i + 1));
    sel.appendChild(o);
  });
  sel.disabled = false;
  if (prev && devs.some((d) => d.deviceId === prev)) sel.value = prev;

  espejarMicrofonos(devs);
}

/** Replica la lista en el selector de la pantalla simple, que es otro control. */
function espejarMicrofonos(devs){
  const sim = $('simpleMic');
  if (!sim) return;
  const prev = sim.value;
  sim.innerHTML = '';
  if (!devs.length){
    sim.innerHTML = '<option value="">-- sin micrófonos detectados --</option>';
    sim.disabled = true;
    return;
  }
  devs.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || ('Micrófono ' + (i + 1));
    sim.appendChild(o);
  });
  sim.disabled = false;
  if (prev && devs.some((d) => d.deviceId === prev)) sim.value = prev;
}

/**
 * Micrófono elegido en la pantalla activa.
 * Un selector deshabilitado o posado sobre el texto de relleno no es una
 * elección: devolver ese texto como si fuera un deviceId hacía que se pidiera
 * un dispositivo inexistente y que nunca se solicitara el permiso.
 */
function valorDeSelector(el){
  if (!el || el.disabled) return '';
  const op = el.options[el.selectedIndex];
  return (op && op.value) ? op.value : '';
}

function micSeleccionado(){
  if (MODO_SIMPLE){
    const v = valorDeSelector($('simpleMic'));
    if (v) return v;
  }
  return valorDeSelector($('micSel'));
}

/* ---------- visualizador ---------- */
const BARS = 56, GAP = 3, VIZ_H = 140;

/** prepara el canvas al ancho actual y devuelve {ctx, w, h, bw} */
function vizGeom(){
  const cv = $(MODO_SIMPLE ? 'vizSimple' : 'viz');
  const ctx = cv.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = cv.clientWidth || 900, h = cv.clientHeight || VIZ_H;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // en un medidor angosto caben menos barras: se ajustan para no quedar
  // de ancho negativo, con un minimo de 3 px por barra
  const gap = w < 300 ? 2 : GAP;
  const n = Math.max(6, Math.min(BARS, Math.floor((w + gap) / (3 + gap))));
  return { ctx, w, h, n, gap, bw: (w - gap * (n - 1)) / n };
}

/** colores del visualizador tomados del CSS, para que siga el tema activo */
function paleta(){
  const cs = getComputedStyle(document.documentElement);
  const v = (n, d) => ((cs.getPropertyValue(n) || '').trim() || d);
  return {
    a: v('--viz-a', '#d13438'),
    b: v('--viz-b', '#ffb900'),
    idle: v('--viz-idle', '#c8c6c4')
  };
}

function bar(ctx, x, mid, bw, bh, live, p){
  const g = ctx.createLinearGradient(0, mid - bh / 2, 0, mid + bh / 2);
  g.addColorStop(0,   live ? p.a : p.idle);
  g.addColorStop(0.5, live ? p.b : p.idle);
  g.addColorStop(1,   live ? p.a : p.idle);
  ctx.fillStyle = g;
  ctx.beginPath();
  const r = Math.max(0, Math.min(bw / 2, 3));   // canvas muy angosto: bw puede ser negativo
  if (ctx.roundRect) ctx.roundRect(x, mid - bh / 2, bw, bh, r);
  else ctx.rect(x, mid - bh / 2, bw, bh);
  ctx.fill();
}

/** barras planas en reposo, para que el recuadro no se vea vacío */
function drawIdle(){
  const { ctx, w, h, n, gap, bw } = vizGeom();
  const p = paleta();
  ctx.clearRect(0, 0, w, h);
  for (let i = 0; i < n; i++) bar(ctx, i * (bw + gap), h / 2, bw, 2, false, p);
}

function startViz(){
  const { ctx, w, h, n, gap, bw } = vizGeom();
  const p = paleta();
  const bins = new Uint8Array(S.analyser.frequencyBinCount);
  const margen = h > 60 ? 18 : 4;

  const draw = () => {
    S.raf = requestAnimationFrame(draw);
    ctx.clearRect(0, 0, w, h);
    const live = S.rec && S.rec.state === 'recording';
    if (live) S.analyser.getByteFrequencyData(bins); else bins.fill(0);

    const mid = h / 2, step = Math.max(1, Math.floor(bins.length * 0.65 / n));
    for (let i = 0; i < n; i++){
      let sum = 0;
      for (let j = 0; j < step; j++) sum += bins[i * step + j] || 0;
      const v = (sum / step) / 255;
      bar(ctx, i * (bw + gap), mid, bw, Math.max(2, v * (h - margen)), live, p);
    }
  };
  cancelAnimationFrame(S.raf); draw();
}
function stopViz(){ cancelAnimationFrame(S.raf); S.raf = 0; drawIdle(); }

/* ---------- grabación ---------- */
function pickMime(){
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const c of cands){
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

async function startRec(){
  banner('');
  try {
    const devId = micSeleccionado();
    S.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: devId ? { exact: devId } : undefined,
        echoCancellation: true, noiseSuppression: true, autoGainControl: true
      }
    });
  } catch (e){
    S.rec = null;
    S.micOk = false;
    avisarErrorMic(e);
    return;
  }

  S.ac = new (window.AudioContext || window.webkitAudioContext)();
  if (S.ac.state === 'suspended') await S.ac.resume();
  S.srcNode  = S.ac.createMediaStreamSource(S.stream);
  S.analyser = S.ac.createAnalyser();
  S.analyser.fftSize = 1024;
  S.analyser.smoothingTimeConstant = 0.75;
  S.srcNode.connect(S.analyser);

  S.mime = pickMime();
  S.rec = new MediaRecorder(S.stream, S.mime ? { mimeType: S.mime, audioBitsPerSecond: 96000 } : undefined);
  S.chunks = [];
  S.rec.ondataavailable = (e) => { if (e.data && e.data.size) S.chunks.push(e.data); };
  S.rec.onstop  = onStopped;
  S.rec.onerror = (e) => banner('Error de MediaRecorder: ' + (e.error && e.error.name));
  S.rec.start(1000);

  S.accMs = 0; S.t0 = performance.now();
  S.tick = setInterval(updTimer, 200);
  startViz();

  $('recDot').classList.remove('hidden');
  $('vizmsg').textContent = 'Grabando...';
  $('btnRec').disabled = true;
  $('btnPause').disabled = false; $('btnStop').disabled = false;
  $('micSel').disabled = true; $('btnIdEdit').disabled = true;
  $('s2state').textContent = 'Grabando'; $('s2state').className = 'pill live';
  $('step3').classList.add('disabled');
}

function elapsed(){
  return S.accMs + (S.rec && S.rec.state === 'recording' ? performance.now() - S.t0 : 0);
}
function updTimer(){
  const t = fmtTime(elapsed());
  $('timer').textContent = t;
  if (MODO_SIMPLE) $('simpleTimer').textContent = t;
}

function togglePause(){
  if (!S.rec) return;
  if (S.rec.state === 'recording'){
    S.rec.pause(); S.accMs += performance.now() - S.t0;
    $('btnPause').textContent = 'Continuar';
    $('vizmsg').textContent = 'En pausa';
    $('recDot').classList.add('hidden');
    $('s2state').textContent = 'En pausa';
  } else if (S.rec.state === 'paused'){
    S.rec.resume(); S.t0 = performance.now();
    $('btnPause').textContent = 'Pausar';
    $('vizmsg').textContent = 'Grabando...';
    $('recDot').classList.remove('hidden');
    $('s2state').textContent = 'Grabando';
  }
}

function stopRec(){
  if (!S.rec || S.rec.state === 'inactive') return;
  if (S.rec.state === 'recording') S.accMs += performance.now() - S.t0;
  S.durMs = S.accMs;
  S.rec.stop();
  clearInterval(S.tick);
  $('btnPause').disabled = true; $('btnStop').disabled = true;
  $('btnPause').textContent = 'Pausar';
  $('recDot').classList.add('hidden');
  $('vizmsg').textContent = 'Procesando...';
}

const extFor = (t) => /ogg/.test(t) ? 'ogg' : /mp4|aac/.test(t) ? 'm4a' : /wav/.test(t) ? 'wav' : 'webm';

async function onStopped(){
  stopViz();
  S.stream.getTracks().forEach((t) => t.stop());
  try { await S.ac.close(); } catch (e) {}
  $('micSel').disabled = false;
  $('btnRec').disabled = false;
  $('s2state').textContent = 'Listo'; $('s2state').className = 'pill ok';
  $('vizmsg').textContent = 'Grabación finalizada';

  let blob = new Blob(S.chunks, { type: S.mime || 'audio/webm' });
  let ext = extFor(blob.type);

  if (S.cfg.format === 'wav'){
    $('vizmsg').textContent = 'Convirtiendo a WAV 16 kHz...';
    try {
      const r = await toWav16k(blob);
      blob = r.blob; ext = 'wav'; S.durMs = Math.round(r.durationSec * 1000);
    } catch (e){
      banner('No se pudo convertir a WAV (' + e.message + '). Se subirá el formato nativo.');
      ext = extFor(blob.type);
    }
    $('vizmsg').textContent = 'Grabación finalizada';
  }

  S.blob = blob;
  S.blobName = S.id + '/' + stamp(new Date()) + '-' + rand4() + '.' + ext;

  $('player').src = URL.createObjectURL(blob);
  $('mDur').textContent  = 'Duración: ' + fmtTime(S.durMs);
  $('mSize').textContent = 'Tamaño: ' + fmtSize(blob.size);
  $('mType').textContent = 'Tipo: ' + (blob.type || 'n/d');
  $('mName').textContent = 'Blob: ' + S.blobName;

  $('step3').classList.remove('disabled');
  $('s3state').textContent = 'Pendiente de subida'; $('s3state').className = 'pill';
  $('btnDl').disabled = false; $('btnReset').disabled = false;
  setMsg($('upMsg'), '');
  $('progWrap').classList.add('hidden');
  refreshUploadBtn();

  if (MODO_SIMPLE) continuarSimple();
}

/* ---------- conversión a WAV PCM 16 kHz mono ---------- */
async function toWav16k(blob){
  const buf = await blob.arrayBuffer();
  const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await tmpCtx.decodeAudioData(buf);
  try { await tmpCtx.close(); } catch (e) {}

  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_SR));
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const off = new OAC(1, frames, TARGET_SR);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return { blob: encodeWav(rendered.getChannelData(0), TARGET_SR), durationSec: decoded.duration };
}

function encodeWav(samples, sr){
  const n = samples.length;
  const ab = new ArrayBuffer(44 + n * 2);
  const v = new DataView(ab);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');  v.setUint32(4, 36 + n * 2, true);  str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);        // PCM
  v.setUint16(22, 1, true);        // mono
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);   // byte rate
  v.setUint16(32, 2, true);        // block align
  v.setUint16(34, 16, true);       // bits per sample
  str(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++, o += 2){
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([ab], { type: 'audio/wav' });
}

/* ---------- subida a Azure ---------- */
function refreshUploadBtn(){
  $('btnUp').disabled = !(S.blob && S.id && cfgReady());
  if (S.blob && !cfgReady()){
    setMsg($('upMsg'), 'Falta configurar el destino en Azure (botón Configuración).', 'bad');
  }
}

async function resolveTarget(){
  const contentType = S.blob.type || 'application/octet-stream';

  if (S.cfg.mode === 'sas'){
    const u = new URL(S.cfg.sasUrl);                     // https://cuenta.blob.core.windows.net/contenedor?sv=...
    const base = u.origin + u.pathname.replace(/\/+$/, '');
    const path = S.blobName.split('/').map(encodeURIComponent).join('/');
    return { uploadUrl: base + '/' + path + u.search, blobUrl: base + '/' + path,
             blobName: S.blobName, contentType };
  }

  let url = S.cfg.fnUrl;
  if (S.cfg.fnKey) url += (url.includes('?') ? '&' : '?') + 'code=' + encodeURIComponent(S.cfg.fnKey);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recordId: S.id, ext: S.blobName.split('.').pop(),
      contentType: contentType, durationMs: S.durMs
    })
  });
  if (!res.ok) throw new Error('La Function respondió ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  if (!j.uploadUrl) throw new Error('La Function no devolvió uploadUrl.');
  return { uploadUrl: j.uploadUrl, blobUrl: j.blobUrl || j.uploadUrl.split('?')[0],
           blobName: j.blobName || S.blobName, contentType };
}

function putBlob(t){
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', t.uploadUrl, true);
    xhr.setRequestHeader('x-ms-blob-type', 'BlockBlob');
    xhr.setRequestHeader('Content-Type', t.contentType);
    xhr.setRequestHeader('x-ms-blob-content-type', t.contentType);
    xhr.setRequestHeader('x-ms-meta-recordid', asciiMeta(S.id));
    xhr.setRequestHeader('x-ms-meta-durationms', String(S.durMs));
    xhr.setRequestHeader('x-ms-meta-createdat', new Date().toISOString());
    xhr.setRequestHeader('x-ms-meta-source', 'web-recorder');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const p = Math.round(e.loaded / e.total * 100);
      $('progBar').style.width = 'calc(' + p + '% - ' + (p * 0.52) + 'px)';
      $('progTxt').textContent = p + '%';
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300)
      ? resolve()
      : reject(new Error('HTTP ' + xhr.status + ' ' + String(xhr.responseText).slice(0, 300)));
    xhr.onerror = () => reject(new Error('Fallo de red o CORS. Verifique la regla CORS del Storage Account.'));
    xhr.send(S.blob);
  });
}

async function upload(){
  $('btnUp').disabled = true;
  $('progWrap').classList.remove('hidden');
  $('progBar').style.width = '0'; $('progTxt').textContent = '0%';
  setMsg($('upMsg'), 'Subiendo...');
  try {
    const t = await resolveTarget();
    await putBlob(t);
    setMsg($('upMsg'), 'Subida correcta: ' + t.blobName, 'ok');
    $('s3state').textContent = 'Subido'; $('s3state').className = 'pill ok';
    S.uploaded = t;
    addHist({ id: S.id, blobName: t.blobName, blobUrl: t.blobUrl,
              durMs: S.durMs, at: new Date().toISOString() });
    $('step4').classList.remove('disabled');
    $('s4state').textContent = 'Pendiente'; $('s4state').className = 'pill';
    refreshTrBtn();
  } catch (e){
    setMsg($('upMsg'), 'Error al subir: ' + e.message, 'bad');
    $('btnUp').disabled = false;
  }
}

/* ---------- Paso 4: transcripción ---------- */
function refreshTrBtn(){
  const listo = !!(S.uploaded && trEndpoint());
  $('btnTr').disabled = !listo;
  if (S.uploaded && !trEndpoint()){
    setMsg($('trMsg'), 'Falta el endpoint de transcripción en Configuración.', 'bad');
  }
}

/** normaliza la respuesta de Fast Transcription a una forma estable para la UI */
function normalizePhrases(data){
  const raw = data.phrases || data.segments || [];
  return raw.map((p) => ({
    offsetMs: p.offsetMs != null ? p.offsetMs : (p.offsetMilliseconds || 0),
    durationMs: p.durationMs != null ? p.durationMs : (p.durationMilliseconds || 0),
    speaker: p.speaker != null ? p.speaker : null,
    text: (p.text || '').trim(),
    confidence: p.confidence != null ? p.confidence : null
  })).filter((p) => p.text);
}

async function transcribe(){
  const url = trEndpoint();
  $('btnTr').disabled = true;
  $('trMock').classList.add('hidden');
  $('trWrap').classList.add('hidden');
  $('trMsg').innerHTML = '<span class="spin"></span>Transcribiendo, puede tardar según la duración del audio…';
  $('trMsg').className = 'msg';
  $('s4state').textContent = 'En proceso'; $('s4state').className = 'pill live';

  const body = {
    blobName: S.uploaded.blobName,
    blobUrl: S.uploaded.blobUrl,
    locales: [S.cfg.locale],
    diarize: Number(S.cfg.diarize) || 0
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const txt = await res.text();
    let data;
    try { data = JSON.parse(txt); }
    catch (e) { throw new Error('Respuesta no es JSON: ' + txt.slice(0, 200)); }
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status) +
                                 (data.detail ? ' — ' + String(data.detail).slice(0, 300) : ''));

    const phrases = normalizePhrases(data);
    const full = (data.text || phrases.map((p) => p.text).join(' ')).trim();
    if (!full) throw new Error('Azure no devolvió texto. ¿El audio quedó en silencio?');

    S.tr = { text: full, phrases: phrases, mock: !!data.mock, raw: data,
             locale: S.cfg.locale, blobName: S.uploaded.blobName };
    renderTr();
    const enviado = avisarAlPadre(S.tr);
    setMsg($('trMsg'), enviado
      ? 'Transcripción lista y enviada a la descripción del caso.'
      : 'Transcripción lista.', 'ok');
    $('s4state').textContent = 'Listo'; $('s4state').className = 'pill ok';
  } catch (e){
    setMsg($('trMsg'), 'Error al transcribir: ' + e.message, 'bad');
    $('s4state').textContent = 'Error'; $('s4state').className = 'pill';
  }
  $('btnTr').disabled = false;
}

function renderTr(){
  const t = S.tr;
  $('trMock').classList.toggle('hidden', !t.mock);
  $('trFull').textContent = t.text;

  const speakers = new Set(t.phrases.map((p) => p.speaker).filter((s) => s != null));
  const palabras = t.text.split(/\s+/).filter(Boolean).length;
  $('trStats').textContent =
    [palabras + ' palabras', t.phrases.length + ' segmentos',
     speakers.size ? speakers.size + ' interlocutores' : 'sin diarización',
     'idioma ' + t.locale].join(' · ');

  const ol = $('trSegs');
  ol.innerHTML = '';
  S.segEls = []; S.activeSeg = -1;
  t.phrases.forEach((p, i) => {
    const li = document.createElement('li');
    li.dataset.start = p.offsetMs;

    const ts = document.createElement('span');
    ts.className = 'ts'; ts.textContent = fmtTime(p.offsetMs);
    li.appendChild(ts);

    if (p.speaker != null){
      const sp = document.createElement('span');
      sp.className = 'spk s' + ((Number(p.speaker) - 1) % 4 + 1);
      sp.textContent = 'Hablante ' + p.speaker;
      li.appendChild(sp);
    }

    const tx = document.createElement('span');
    tx.className = 'txt'; tx.textContent = p.text;
    li.appendChild(tx);

    if (p.confidence != null){
      const cf = document.createElement('span');
      cf.className = 'cf'; cf.textContent = Math.round(p.confidence * 100) + '%';
      cf.title = 'Confianza del reconocimiento';
      li.appendChild(cf);
    }

    li.onclick = () => {
      const pl = $('player');
      pl.currentTime = p.offsetMs / 1000;
      pl.play().catch(() => {});
    };
    ol.appendChild(li);
    S.segEls.push(li);
  });

  $('trWrap').classList.remove('hidden');
  ['btnTrCopy', 'btnTrTxt', 'btnTrJson'].forEach((k) => { $(k).disabled = false; });
}

/** resalta el segmento que corresponde al instante de reproducción */
function syncSeg(){
  if (!S.tr || !S.segEls.length) return;
  const ms = $('player').currentTime * 1000;
  let idx = -1;
  for (let i = 0; i < S.tr.phrases.length; i++){
    if (S.tr.phrases[i].offsetMs <= ms) idx = i; else break;
  }
  if (idx === S.activeSeg) return;
  if (S.activeSeg >= 0) S.segEls[S.activeSeg].classList.remove('active');
  if (idx >= 0){
    S.segEls[idx].classList.add('active');
    S.segEls[idx].scrollIntoView({ block: 'nearest' });
  }
  S.activeSeg = idx;
}

function trAsText(){
  const t = S.tr;
  const cab = ['ID: ' + S.id, 'Blob: ' + t.blobName, 'Idioma: ' + t.locale,
               'Generado: ' + new Date().toLocaleString('es-CL')];
  if (t.mock) cab.push('AVISO: transcripción simulada, no proviene de Azure AI Speech.');
  const cuerpo = t.phrases.map((p) =>
    '[' + fmtTime(p.offsetMs) + ']' + (p.speaker != null ? ' Hablante ' + p.speaker + ':' : '') +
    ' ' + p.text);
  return cab.join('\n') + '\n\n' + cuerpo.join('\n') + '\n\n--- Texto continuo ---\n' + t.text + '\n';
}

function saveAs(content, mime, name){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name;
  a.click(); URL.revokeObjectURL(a.href);
}

function resetTr(){
  S.tr = null; S.segEls = []; S.activeSeg = -1;
  $('trWrap').classList.add('hidden');
  $('trMock').classList.add('hidden');
  $('trSegs').innerHTML = ''; $('trFull').textContent = '';
  setMsg($('trMsg'), '');
  ['btnTrCopy', 'btnTrTxt', 'btnTrJson'].forEach((k) => { $(k).disabled = true; });
}

/* ---------- historial local ---------- */
function getHist(){
  try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch (e) { return []; }
}
function addHist(r){
  const h = getHist(); h.unshift(r);
  localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, 50)));
  renderHist();
}
function renderHist(){
  const tb = $('histBody'), h = getHist();
  tb.innerHTML = '';
  if (!h.length){
    tb.innerHTML = '<tr class="empty"><td colspan="5">Sin registros aún.</td></tr>';
    return;
  }
  h.forEach((r) => {
    const tr = document.createElement('tr');
    [r.id, r.blobName, fmtTime(r.durMs), new Date(r.at).toLocaleString('es-CL')].forEach((c) => {
      const td = document.createElement('td'); td.textContent = c; tr.appendChild(td);
    });
    const td = document.createElement('td');
    const b = document.createElement('button');
    b.className = 'ghost small'; b.type = 'button'; b.textContent = 'Copiar URL';
    b.onclick = () => navigator.clipboard.writeText(r.blobUrl)
      .then(() => { b.textContent = 'Copiado'; });
    td.appendChild(b); tr.appendChild(td);
    tb.appendChild(tr);
  });
}

/* ---------- reset / descarga ---------- */
function resetTake(){
  S.blob = null; S.chunks = []; S.durMs = 0; S.uploaded = null;
  $('player').removeAttribute('src');
  ['mDur', 'mSize', 'mType', 'mName'].forEach((k) => { $(k).textContent = '--'; });
  $('step3').classList.add('disabled');
  $('s3state').textContent = 'Bloqueado'; $('s3state').className = 'pill';
  $('btnUp').disabled = true; $('btnDl').disabled = true; $('btnReset').disabled = true;
  $('progWrap').classList.add('hidden'); setMsg($('upMsg'), '');
  $('timer').textContent = '00:00'; $('vizmsg').textContent = 'Listo para grabar';
  $('btnIdEdit').disabled = false;
  $('step4').classList.add('disabled');
  $('s4state').textContent = 'Bloqueado'; $('s4state').className = 'pill';
  $('btnTr').disabled = true;
  resetTr();
}

/* ---------- Interfaz simplificada ---------- */

function simpleEstado(texto, ocupado){
  $('simpleEstado').textContent = texto;
  $('simpleProg').classList.toggle('hidden', !ocupado);
}

function simpleError(texto){
  setMsg($('simpleErr'), texto, 'bad');
  simpleEstado('Se detuvo por un error', false);
  $('simpleRec').disabled = false;
  $('simpleStop').disabled = true;
}

/** Cuántas personas hablan -> configuración de diarización. */
function simpleDiarize(){
  const n = Number($('simplePers').value) || 1;
  return n > 1 ? String(n) : '0';
}

async function simpleGrabar(){
  setMsg($('simpleErr'), '');
  $('simpleOut').classList.add('hidden');
  S.cfg.diarize = simpleDiarize();

  // el permiso se pide en el primer intento, no antes
  if (!S.micOk){
    simpleEstado('Solicitando acceso al micrófono…', true);
    if (!(await askPermission())){
      // askPermission ya dejo el motivo concreto (a veces con enlace)
      simpleEstado('Sin acceso al micrófono', false);
      return;
    }
  }

  simpleEstado('Grabando…', false);
  $('simpleDot').classList.remove('hidden');
  setTimeout(drawIdle, 0);
  $('simpleRec').disabled = true;
  $('simpleStop').disabled = false;
  $('simplePers').disabled = true;
  $('simpleMic').disabled = true;
  await startRec();
  if (!S.rec || S.rec.state !== 'recording'){
    // startRec ya explico el motivo; se deja la pantalla lista para reintentar
    $('simpleDot').classList.add('hidden');
    $('simpleRec').disabled = false;
    $('simpleStop').disabled = true;
    $('simplePers').disabled = false;
    $('simpleMic').disabled = !micSeleccionado();
    simpleEstado('Sin acceso al micrófono', false);
    return;
  }
  if (MODO_VIVO) vivoIniciar();
}

function simpleDetener(){
  $('simpleStop').disabled = true;
  $('simpleDot').classList.add('hidden');
  simpleEstado('Procesando el audio…', true);
  if (MODO_VIVO) vivoDetener();
  stopRec();                       // al terminar dispara continuarSimple()
}

/** Encadena subida y transcripción sin intervención del usuario. */
async function continuarSimple(){
  $('simplePers').disabled = false;
  if ($('simpleMic').options.length && $('simpleMic').options[0].value){
    $('simpleMic').disabled = false;
  }

  if (!cfgReady()){
    simpleError('Falta configurar el destino en Azure.');
    return;
  }

  simpleEstado('Guardando la grabación…', true);
  await upload();
  if (!S.uploaded){
    simpleError($('upMsg').textContent || 'No se pudo guardar la grabación.');
    return;
  }

  simpleEstado('Transcribiendo con Azure AI Speech…', true);
  await transcribe();
  if (!S.tr){
    simpleError($('trMsg').textContent || 'No se pudo transcribir.');
    return;
  }

  simpleEstado('Listo', false);
  $('simpleRec').disabled = false;
  renderSimple(S.tr);
  // en vivo la conversacion queda a la vista; la transcripcion final por
  // hablante aparece debajo, junto a la revision del guion
}

/** Muestra la transcripción como una conversación, por hablante. */
function renderSimple(t){
  $('simpleAviso').classList.toggle('hidden', !t.mock);
  if (t.mock){
    $('simpleAviso').textContent = 'Transcripción simulada: no proviene de Azure AI Speech.';
  }

  const frases = t.phrases || [];
  const hablantes = new Set(frases.map((p) => p.speaker).filter((x) => x != null));

  $('simpleStats').innerHTML = '';
  const sp = document.createElement('span');
  sp.textContent = [
    String(t.text).split(/\s+/).filter(Boolean).length + ' palabras',
    hablantes.size ? hablantes.size + ' hablantes identificados' : 'sin separación de hablantes',
    frases.length + ' intervenciones'
  ].join(' · ');
  $('simpleStats').appendChild(sp);

  const ol = $('simpleSegs');
  ol.className = 'conv';
  ol.innerHTML = '';

  if (!frases.length){
    const li = document.createElement('li');
    li.className = 'izq';
    const b = document.createElement('div');
    b.className = 'conv-burbuja'; b.textContent = t.text;
    li.appendChild(b); ol.appendChild(li);
  } else {
    // los hablantes se alternan a izquierda y derecha para leerse como un diálogo
    const lados = {};
    let siguiente = 0;
    frases.forEach((p) => {
      const n = p.speaker != null ? Number(p.speaker) : 0;
      if (!(n in lados)){ lados[n] = siguiente % 2 === 0 ? 'izq' : 'der'; siguiente++; }

      const li = document.createElement('li');
      li.className = lados[n] + (n ? ' s' + ((n - 1) % 4 + 1) : '');

      const meta = document.createElement('div');
      meta.className = 'conv-meta';

      if (p.speaker != null){
        const chip = document.createElement('span');
        chip.className = 'spk s' + ((n - 1) % 4 + 1);
        chip.textContent = 'Hablante ' + p.speaker;
        meta.appendChild(chip);
      }

      const ts = document.createElement('span');
      ts.textContent = fmtTime(p.offsetMs);
      meta.appendChild(ts);

      if (p.confidence != null){
        const cf = document.createElement('span');
        const pct = Math.round(p.confidence * 100);
        cf.className = 'conv-conf' + (pct < 70 ? ' baja' : '');
        cf.textContent = pct + '%';
        cf.title = 'Confianza del reconocimiento del texto, no de la asignación de hablante';
        meta.appendChild(cf);
      }

      li.appendChild(meta);

      const b = document.createElement('div');
      b.className = 'conv-burbuja'; b.textContent = p.text;
      li.appendChild(b);

      ol.appendChild(li);
    });
  }

  // El porcentaje es de reconocimiento del texto. Azure no entrega una
  // confianza de atribucion de hablante, y rotularlo como tal seria presentar
  // un dato como si midiera algo que no mide.
  const nota = $('simpleNota');
  if (frases.some((p) => p.confidence != null)){
    nota.textContent = 'El porcentaje indica la confianza de Azure en el texto reconocido. ' +
      'La asignación de hablante no trae puntaje: Azure la entrega o la omite.';
    nota.classList.remove('hidden');
  } else {
    nota.classList.add('hidden');
  }

  pintarCriterios(null);
  setMsg($('evalMsg'), '');
  $('evalAviso').classList.add('hidden');
  $('simpleOut').classList.remove('hidden');
}

/**
 * Un caso con grabación queda en modo consulta: se escucha y se lee, no se
 * vuelve a grabar. Evita duplicar la conversación del mismo caso por error.
 */
function bloquearSimplePorExistente(bloquear){
  ['simpleRec', 'simpleStop', 'simpleMic', 'simplePers'].forEach((k) => {
    const el = $(k);
    if (el) el.disabled = bloquear;
  });
  // un boton que no hace nada confunde mas que no estar
  const otra = $('simpleOtra');
  if (otra) otra.classList.toggle('hidden', bloquear);
  // en un caso ya grabado no hay nada que escuchar en vivo
  if (MODO_VIVO) $('vivo').classList.toggle('hidden', bloquear);
}

/** Al abrir el caso, si ya hay grabación se muestra para escuchar y leer. */
function simpleMostrarPrevia(d){
  const audios = (d.items || []).filter((it) => !esClip(it));
  if (!audios.length){
    bloquearSimplePorExistente(false);
    $('simplePrevia').classList.add('hidden');
    return;
  }

  const it = audios[0];                       // el listado llega del mas reciente al mas antiguo
  S.previa = it;

  const src = it.url || it.audioUrl;
  if (src) $('simpleAudio').src = src;

  $('simplePreviaMeta').innerHTML = '';
  [
    it.createdAt ? new Date(it.createdAt).toLocaleString('es-CL') : null,
    it.durationMs ? 'Duración: ' + fmtTime(it.durationMs) : null,
    it.sizeBytes ? fmtSize(it.sizeBytes) : null
  ].filter(Boolean).forEach((x) => {
    const sp = document.createElement('span'); sp.textContent = x;
    $('simplePreviaMeta').appendChild(sp);
  });
  $('simplePrevia').classList.remove('hidden');

  bloquearSimplePorExistente(true);
  simpleEstado('Ya existe una grabación para este caso: solo lectura', false);

  const t = it.transcript;
  if (t && t.text){
    $('simpleTr').classList.add('hidden');
    // se registra en el estado: el panel de revision y el boton de copiar
    // trabajan sobre S.tr, no sobre lo que haya en pantalla
    S.tr = { text: t.text, phrases: normalizePhrases(t), mock: !!t.mock,
             locale: (t.locales && t.locales[0]) || S.cfg.locale,
             blobName: it.blobName };
    renderSimple(S.tr);
  } else {
    $('simpleOut').classList.add('hidden');
    $('simpleTr').classList.remove('hidden');
    $('simpleTr').disabled = false;
    setMsg($('simpleErr'), 'La grabación está guardada pero todavía no tiene transcripción.');
  }
}

/** Transcribe la grabación ya existente, sin volver a grabarla. */
async function simpleTranscribirPrevia(){
  if (!S.previa) return;
  const btn = $('simpleTr');
  btn.disabled = true;
  setMsg($('simpleErr'), '');
  simpleEstado('Transcribiendo con Azure AI Speech…', true);
  try {
    const res = await fetch(trEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blobName: S.previa.blobName, locales: [S.cfg.locale],
        diarize: Number(simpleDiarize()) || 0
      })
    });
    const txt = await res.text();
    let d;
    try { d = JSON.parse(txt); }
    catch (e){ throw new Error('respuesta no es JSON: ' + txt.slice(0, 150)); }
    if (!res.ok) throw new Error(d.error || ('HTTP ' + res.status));
    if (!d.text) throw new Error('Azure no devolvió texto. ¿El audio quedó en silencio?');

    S.tr = { text: d.text, phrases: normalizePhrases(d), mock: !!d.mock,
             locale: S.cfg.locale, blobName: S.previa.blobName };
    renderSimple(S.tr);
    avisarAlPadre(S.tr);
    btn.classList.add('hidden');
    simpleEstado('Ya existe una grabación para este caso: solo lectura', false);
  } catch (e){
    btn.disabled = false;
    setMsg($('simpleErr'), 'Error al transcribir: ' + e.message, 'bad');
    simpleEstado('Ya existe una grabación para este caso: solo lectura', false);
  }
}
function download(){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(S.blob);
  a.download = S.blobName.replace(/\//g, '_');
  a.click(); URL.revokeObjectURL(a.href);
}

/* ---------- arranque ---------- */
/**
 * Marca de version en el encabezado. Antes iba fija al pie de la ventana,
 * pero dentro del iframe de Dynamics el pie queda fuera de lo visible sin
 * hacer scroll dentro del propio iframe: nadie la veia.
 */
function pintarVersion(){
  const b = document.createElement('span');
  b.className = 'verbadge';
  b.textContent = 'v' + VERSION;
  b.title = 'Versión de la página. Si no coincide con la esperada, recargue con Ctrl+F5.';

  const destino = (MODO_SIMPLE && $('simpleCaso') && $('simpleCaso').parentNode)
               || document.querySelector('.hdr')
               || document.body;
  destino.appendChild(b);
  console.log('Grabador W-IT: versión ' + VERSION);
}

function init(){
  pintarVersion();
  // incrustada en un formulario: sin encabezado propio, sin marco y siempre
  // en claro, para no verse como una isla ajena dentro de Dynamics
  if (EN_IFRAME){
    document.documentElement.classList.add('embed');
    document.body.classList.add('embed');
  }

  loadCfg(); renderHist(); drawIdle();
  window.addEventListener('resize', () => {
    if (!S.rec || S.rec.state === 'inactive') drawIdle();
  });

  if (!window.isSecureContext){
    banner('La página no está en un contexto seguro. getUserMedia solo funciona con HTTPS o en localhost.');
  } else if (!navigator.mediaDevices || !window.MediaRecorder){
    banner('Este navegador no soporta MediaRecorder / mediaDevices. Use Edge o Chrome actualizado.');
  } else if (EN_IFRAME && marcoBloqueaMic() === true){
    // se avisa antes de que el usuario pierda tiempo intentando grabar
    banner(AVISO_MARCO, true);
  }

  if (SOLO_CLIP){
    document.body.classList.add('solo-clip');
    document.title = 'Clip de evidencia';
  }
  if (SOLO_PERMISO){
    document.body.classList.add('solo-permiso');
    document.title = 'Autorizar cámara';
  }
  if (MODO_SIMPLE){
    document.body.classList.add('modo-simple');
    document.title = 'Grabación';
  }
  if (MODO_VIVO){
    escucharRespuestaDynamics();
    pedirContexto();
    cargarCatalogo();
    $('clasifC').onchange = () => alCambiarClasif('C');
    $('clasifM').onchange = () => alCambiarClasif('M');
    $('clasifS').onchange = () => alCambiarClasif('S');
    $('clasifProponer').onclick = vivoClasificar;
    $('clasifOk').onclick = confirmarClasif;
    Object.keys(TEXTOS).forEach((id) => {
      $(id + 'Ok').onclick = () => confirmarTexto(id);
      $(id + 'Txt').addEventListener('input', () => {
        const k = V.textos[id];
        if (!k || k.estado === 'confirmado') return;
        k.texto = $(id + 'Txt').value; k.estado = 'editado'; k.error = ''; k.sinContenido = false;
        pintarTexto(id);
      });
    });
    document.querySelectorAll('.pestana').forEach((b) => { b.onclick = () => mostrarPestana(b.dataset.p); });
    document.body.classList.add('modo-vivo');
    document.title = 'Grabación en vivo';
    vivoReiniciar();
    vivoPreparar();
  }

  // dentro de un marco sin cámara delegada, la ventana aparte es el camino:
  // conserva el número de caso y avisa de vuelta al terminar
  if (EN_IFRAME && marcoBloqueaCam() === true){
    setMsg($('clipMsg'), 'La cámara no está autorizada en este contexto. ' +
      'Use «Autorizar cámara»: se abre una ventana donde el navegador pide el permiso.', 'bad');
    $('camHint').textContent = 'Cámara no autorizada.';
    $('btnCam').classList.add('hidden');
    $('btnCamVentana').classList.remove('hidden');
    escucharVentanaPermiso();
    pintarDiagnosticoCam();
  }

  // ?id=XXX prellena el ID y &lock=1 lo fija (útil al abrir desde Dynamics)
  const qs = new URLSearchParams(location.search);
  if (qs.get('id')){
    $('recId').value = sanitizeId(qs.get('id'));
    if (qs.get('lock') === '1'){ confirmId(); $('btnIdEdit').classList.add('hidden'); }
  }

  $('btnCfg').onclick     = () => $('cfgPanel').classList.toggle('hidden');
  $('cfgMode').onchange   = applyModeVisibility;
  $('cfgTrMode').onchange = applyModeVisibility;
  $('cfgSave').onclick    = saveCfg;
  $('cfgClear').onclick   = () => {
    localStorage.removeItem(CFG_KEY);
    S.cfg = Object.assign({}, CFG_DEFAULT);
    loadCfg(); setMsg($('cfgMsg'), 'Configuración restablecida a los valores por defecto.');
    refreshUploadBtn(); refreshTrBtn();
  };
  $('btnId').onclick     = confirmId;
  $('btnIdEdit').onclick = editId;
  $('recId').onkeydown   = (e) => { if (e.key === 'Enter') confirmId(); };
  $('btnPerm').onclick   = askPermission;
  $('btnRec').onclick    = startRec;
  $('btnPause').onclick  = togglePause;
  $('btnStop').onclick   = stopRec;
  $('btnUp').onclick     = upload;
  $('btnDl').onclick     = download;
  $('btnReset').onclick  = resetTake;
  $('histClear').onclick = () => { localStorage.removeItem(HIST_KEY); renderHist(); };
  $('btnOtra').onclick   = () => {
    desbloquearGrabacion();
    setMsg($('buscaMsg'), 'Grabación habilitada manualmente: se agregará otra grabación a este ID.');
  };

  $('btnCam').onclick        = permitirCamara;
  $('simpleMic').onchange   = () => { $('micSel').value = $('simpleMic').value; S.micOk = false; };
  $('simpleRec').onclick    = simpleGrabar;
  $('simplePermitir').onclick = simplePermitir;
  $('simpleStop').onclick   = simpleDetener;
  $('simpleCopiar').onclick = () => navigator.clipboard.writeText(S.tr.text)
    .then(() => { $('simpleCopiar').textContent = 'Copiado'; });
  $('simpleTr').onclick     = simpleTranscribirPrevia;
  $('btnEvaluar').onclick   = evaluarGuion;
  $('simpleOtra').onclick   = () => {
    if (S.previa) return;                 // caso con grabacion: solo lectura
    resetTake();
    $('simpleOut').classList.add('hidden');
    setMsg($('simpleErr'), '');
    $('simpleTimer').textContent = '00:00';
    if (MODO_VIVO){ vivoReiniciar(); vivoPreparar(); }
    simpleEstado('Listo para grabar', false);
    $('simpleRec').disabled = false;
  };

  $('btnCamVentana').onclick = abrirVentanaPermiso;
  $('btnPermitirAqui').onclick  = permitirAqui;
  $('btnCerrarPermiso').onclick = () => window.close();
  $('btnCerrarVentana').onclick = () => { detenerCamara(); window.close(); };
  $('camSel').onchange     = previsualizar;
  $('btnClipRec').onclick  = grabarClip;
  $('btnClipStop').onclick = detenerClip;
  $('btnClipUp').onclick   = subirClip;
  $('btnClipDrop').onclick = descartarClip;

  $('btnTr').onclick     = transcribe;
  $('btnTrCopy').onclick = () => navigator.clipboard.writeText(S.tr.text)
    .then(() => setMsg($('trMsg'), 'Texto copiado al portapapeles.', 'ok'));
  $('btnTrTxt').onclick  = () => saveAs(trAsText(), 'text/plain;charset=utf-8',
                                        S.tr.blobName.replace(/[\/.]/g, '_') + '.txt');
  $('btnTrJson').onclick = () => saveAs(JSON.stringify(S.tr.raw, null, 2),
                                        'application/json;charset=utf-8',
                                        S.tr.blobName.replace(/[\/.]/g, '_') + '.json');
  $('player').addEventListener('timeupdate', syncSeg);

  if (navigator.mediaDevices){
    navigator.mediaDevices.addEventListener('devicechange', () => {
      if (!$('micSel').disabled) listMics();
    });
    // si el permiso ya estaba concedido, poblar la lista sin volver a preguntar
    if (navigator.permissions && navigator.permissions.query){
      navigator.permissions.query({ name: 'microphone' })
        .then((p) => { if (p.state === 'granted') askPermission(); })
        .catch(() => {});
    }
  }

  window.addEventListener('beforeunload', () => detenerCamara());
  window.addEventListener('beforeunload', (e) => {
    if ((S.rec && S.rec.state !== 'inactive') ||
        (S.cam.rec && S.cam.rec.state !== 'inactive')){
      e.preventDefault(); e.returnValue = '';
    }
  });
}
document.addEventListener('DOMContentLoaded', init);
})();
