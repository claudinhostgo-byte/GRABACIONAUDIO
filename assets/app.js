/* Grabador de audio -> Azure Blob Storage
   Prototipo W-IT. Paso 1 ID, Paso 2 grabar, Paso 3 subir. */
(() => {
'use strict';

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
  uploaded: null, tr: null, segEls: [], activeSeg: -1,
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
    sel.innerHTML = '<option>-- sin cámaras detectadas --</option>';
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
}

/** Previsualización en vivo; se rearma al cambiar de cámara. */
async function previsualizar(){
  detenerCamara();
  try {
    const devId = $('camSel').value;
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
async function askPermission(){
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach((t) => t.stop());
    await listMics();
    $('btnPerm').classList.add('hidden');
    $('btnRec').disabled = false;
    $('vizmsg').textContent = 'Listo para grabar';
  } catch (e){
    // dentro de un iframe, NotAllowedError casi siempre es el marco, no el usuario
    if (EN_IFRAME && (e.name === 'NotAllowedError' || e.name === 'SecurityError')){
      banner(AVISO_MARCO, true);
    } else {
      banner('No se pudo acceder al micrófono: ' + e.name + '. ' +
        'Revise el permiso del sitio en el navegador y que la página se sirva por HTTPS o localhost.');
    }
  }
}
async function listMics(){
  const devs = (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === 'audioinput');
  const sel = $('micSel'), prev = sel.value;
  sel.innerHTML = '';
  if (!devs.length){
    sel.innerHTML = '<option>-- sin micrófonos detectados --</option>';
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
}

/* ---------- visualizador ---------- */
const BARS = 56, GAP = 3, VIZ_H = 140;

/** prepara el canvas al ancho actual y devuelve {ctx, w, h, bw} */
function vizGeom(){
  const cv = $('viz'), ctx = cv.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = cv.clientWidth || 900, h = VIZ_H;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h, bw: (w - GAP * (BARS - 1)) / BARS };
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
  const r = Math.min(bw / 2, 3);
  if (ctx.roundRect) ctx.roundRect(x, mid - bh / 2, bw, bh, r);
  else ctx.rect(x, mid - bh / 2, bw, bh);
  ctx.fill();
}

/** barras planas en reposo, para que el recuadro no se vea vacío */
function drawIdle(){
  const { ctx, w, h, bw } = vizGeom();
  const p = paleta();
  ctx.clearRect(0, 0, w, h);
  for (let i = 0; i < BARS; i++) bar(ctx, i * (bw + GAP), h / 2, bw, 2, false, p);
}

function startViz(){
  const { ctx, w, h, bw } = vizGeom();
  const p = paleta();
  const bins = new Uint8Array(S.analyser.frequencyBinCount);

  const draw = () => {
    S.raf = requestAnimationFrame(draw);
    ctx.clearRect(0, 0, w, h);
    const live = S.rec && S.rec.state === 'recording';
    if (live) S.analyser.getByteFrequencyData(bins); else bins.fill(0);

    const mid = h / 2, step = Math.max(1, Math.floor(bins.length * 0.65 / BARS));
    for (let i = 0; i < BARS; i++){
      let sum = 0;
      for (let j = 0; j < step; j++) sum += bins[i * step + j] || 0;
      const v = (sum / step) / 255;
      bar(ctx, i * (bw + GAP), mid, bw, Math.max(2, v * (h - 26)), live, p);
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
    const devId = $('micSel').value;
    S.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: devId ? { exact: devId } : undefined,
        echoCancellation: true, noiseSuppression: true, autoGainControl: true
      }
    });
  } catch (e){
    if (EN_IFRAME && (e.name === 'NotAllowedError' || e.name === 'SecurityError')){
      banner(AVISO_MARCO, true);
    } else {
      banner('No se pudo abrir el micrófono seleccionado: ' + e.name);
    }
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
function updTimer(){ $('timer').textContent = fmtTime(elapsed()); }

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
function download(){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(S.blob);
  a.download = S.blobName.replace(/\//g, '_');
  a.click(); URL.revokeObjectURL(a.href);
}

/* ---------- arranque ---------- */
function init(){
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
