/* ============================================================
   EARth · app.js (hilo principal / UI)
   Orquesta: captura de audio del receptor DJI, grafo Web Audio
   (split → filtro pasa-banda 80–2500 Hz → ganancia/solo → merge),
   AudioWorklet de detección, espectrograma en cascada, medidores
   L/R con peak-hold, flash + vibración, Wake Lock y registro del
   Service Worker.
   ============================================================ */

'use strict';

// ---------------------------------------------------------------
// Referencias al DOM
// ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {
  startScreen: $('start-screen'),
  appScreen:   $('app-screen'),
  startBtn:    $('start-btn'),
  startError:  $('start-error'),
  stopBtn:     $('stop-btn'),
  deviceLabel: $('device-label'),
  statusText:  $('status-text'),
  statusDot:   $('status-dot'),

  barL: $('bar-l'), barR: $('bar-r'),
  peakL: $('peak-l'), peakR: $('peak-r'),
  dbL: $('db-l'), dbR: $('db-r'),

  spectro: $('spectrogram'),
  detectBadges: $('detect-badges'),
  ratioVal: $('ratio-val'),
  lastEvent: $('last-event'),
  alertFlash: $('alert-flash'),

  monitorToggle: $('monitor-toggle'),
  bandpassToggle: $('bandpass-toggle'),
  hapticToggle: $('haptic-toggle'),
  wakeToggle: $('wake-toggle'),
  impactsToggle: $('impacts-toggle'),
  sensitivity: $('sensitivity'),
  sensitivityVal: $('sensitivity-val'),
  tonality: $('tonality'),
  tonalityVal: $('tonality-val'),

  // Reanudar audio
  resumeOverlay: $('resume-overlay'),
  resumeBtn: $('resume-btn'),

  // Historial
  historyBtn: $('history-btn'),
  historyCount: $('history-count'),
  historyPanel: $('history-panel'),
  historyClose: $('history-close'),
  historyList: $('history-list'),
  historyEmpty: $('history-empty'),
  historyExport: $('history-export'),
  historyClear: $('history-clear'),
  cntBang: $('cnt-bang'),
  cntVoice: $('cnt-voice'),
  cntWeak: $('cnt-weak'),
  cntBreath: $('cnt-breath'),

  // Resiliencia / red
  offlineStatus: $('offline-status'),
  recacheBtn: $('recache-btn'),
  netPill: $('net-pill'),
};

// ---------------------------------------------------------------
// Estado de la aplicación
// ---------------------------------------------------------------
const state = {
  ctx: null,            // AudioContext
  stream: null,         // MediaStream del receptor DJI
  nodes: {},            // nodos del grafo
  worklet: null,        // AudioWorkletNode
  analyser: null,       // AnalyserNode para el espectrograma
  running: false,
  channelMode: 'stereo',// 'stereo' | 'left' | 'right'
  wakeLock: null,
  raf: 0,
  // Peak-hold de los medidores (con caída lenta).
  peakHold: { l: 0, r: 0 },
  badgeTimers: {},

  // Vigilancia del pipeline de audio (que no se detenga en silencio).
  meterLastTs: 0,     // ts del último mensaje 'meter' recibido del worklet
  watchdog: 0,        // id del setInterval
  recovering: false,  // evita recuperaciones solapadas
  audioConstraints: null, // se reutilizan al reconectar el micrófono
};

// Rango de frecuencias del filtro pasa-banda (Hz).
const BAND_LOW = 80;
const BAND_HIGH = 2500;
const FFT_MAX_HZ = 2800; // tope visible del espectrograma

// Modo Impactos: ensancha el pasa-bajos para preservar el transitorio de un
// golpe seco (banda ancha) y acorta la STA para captar el clic brevísimo.
const IMPACT_LP_HZ = 6000;   // pasa-bajos ampliado en modo impactos
const STA_TAU_NORMAL = 0.040;
const STA_TAU_IMPACT = 0.010;

// ===============================================================
// ARRANQUE
// ===============================================================
els.startBtn.addEventListener('click', start);
els.stopBtn.addEventListener('click', stop);

async function start() {
  els.startError.hidden = true;
  els.startBtn.disabled = true;
  try {
    // 1) AudioContext a 48 kHz. El gesto del usuario lo desbloquea en móvil.
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.ctx = new Ctx({ sampleRate: 48000, latencyHint: 'interactive' });
    // Algunos navegadores arrancan 'suspended'; reanudar tras el gesto.
    if (state.ctx.state === 'suspended') await state.ctx.resume();

    // 2) Captura del receptor DJI. Desactivamos todo el "embellecido"
    //    del navegador: queremos la señal cruda line-level, sin AGC ni
    //    supresión de ruido que destruirían las señales débiles.
    //    Guardamos las constraints para poder RECONECTAR si el DJI se
    //    desenchufa/reenchufa en campo.
    state.audioConstraints = {
      audio: {
        channelCount: 2,
        sampleRate: 48000,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        // @ts-ignore — pistas no estándar, ignoradas si no existen.
        googAutoGainControl: false,
        googNoiseSuppression: false,
      },
      video: false,
    };
    state.stream = await navigator.mediaDevices.getUserMedia(state.audioConstraints);
    attachTrackHandlers();

    // 3) Cargar el módulo del AudioWorklet (cacheado por el SW para offline).
    await state.ctx.audioWorklet.addModule('worklet.js');

    // 4) Construir el grafo y arrancar bucle de render.
    buildGraph();
    await acquireWakeLock();

    state.running = true;
    state.meterLastTs = Date.now();
    state.suspendedTicks = 0;
    hideResume();
    els.startScreen.hidden = true;
    els.appScreen.hidden = false;
    setStatus(true, 'Escuchando');
    updateNetPill();
    startWatchdog();
    // El AudioContext puede suspenderse por interrupciones del SO (llamadas,
    // bloqueo de pantalla). Lo reanudamos automáticamente.
    state.ctx.onstatechange = handleCtxStateChange;
    resizeCanvas();
    renderLoop();
  } catch (err) {
    console.error(err);
    els.startError.hidden = false;
    els.startError.textContent = friendlyError(err);
    setStatus(false, 'Error');
  } finally {
    els.startBtn.disabled = false;
  }
}

function friendlyError(err) {
  if (err && err.name === 'NotAllowedError')
    return 'Permiso de micrófono denegado. Habilítalo en los ajustes del navegador.';
  if (err && err.name === 'NotFoundError')
    return 'No se detectó entrada de audio. Conecta el receptor DJI por USB-C/Lightning.';
  if (location.protocol !== 'https:' && location.hostname !== 'localhost')
    return 'El audio requiere HTTPS. Sirve la app por https:// o localhost.';
  return 'No se pudo iniciar el audio: ' + (err && err.message ? err.message : err);
}

// ===============================================================
// GRAFO DE AUDIO
//
//  source ─► splitter ─┬► [HP 80] ─► [LP 2500] ─► gainL ─┐
//                      │                                  ├► merger ─┬► analyser (espectro)
//                      └► [HP 80] ─► [LP 2500] ─► gainR ─┘          ├► worklet (detección)
//                                                                    └► (monitor) destino
// ===============================================================
function buildGraph() {
  const ctx = state.ctx;
  const src = ctx.createMediaStreamSource(state.stream);
  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);

  // Filtro pasa-banda implementado como cascada Biquad HP+LP por canal:
  // un pasa-altos a 80 Hz elimina retumbe de maquinaria pesada y un
  // pasa-bajos a 2500 Hz elimina viento/siseo electromagnético, dejando
  // el rango humano/animal. (Dos BiquadFilterNode = banda ancha precisa.)
  const chain = [];
  const gains = [];
  for (let c = 0; c < 2; c++) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = BAND_LOW; hp.Q.value = 0.707;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = BAND_HIGH; lp.Q.value = 0.707;
    const g = ctx.createGain(); g.gain.value = 1;

    splitter.connect(hp, c);   // toma el canal c del splitter
    hp.connect(lp);
    lp.connect(g);
    g.connect(merger, 0, c);   // devuelve al canal c del merger
    chain.push({ hp, lp });
    gains.push(g);
  }

  // AudioWorklet de detección: recibe los 2 canales filtrados.
  const worklet = new AudioWorkletNode(ctx, 'life-detector', {
    numberOfInputs: 1, numberOfOutputs: 1,
    channelCount: 2, channelCountMode: 'explicit',
  });
  worklet.port.onmessage = onWorkletMessage;
  worklet.port.postMessage({
    threshold: parseFloat(els.sensitivity.value),
    harmThresh: parseFloat(els.tonality.value),
  });

  // Analyser para el espectrograma (sobre la mezcla filtrada).
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.4;
  analyser.minDecibels = -95;
  analyser.maxDecibels = -20;

  // Nodo de monitor: lo conectamos/desconectamos del destino con el toggle.
  const monitorGain = ctx.createGain();
  monitorGain.gain.value = els.monitorToggle.checked ? 1 : 0;

  // Cableado: merger → analyser, worklet y monitor.
  merger.connect(analyser);
  merger.connect(worklet);
  merger.connect(monitorGain);
  monitorGain.connect(ctx.destination);
  // El worklet no produce audio audible; lo enviamos a un sumidero mudo
  // para mantener su `process()` activo en todos los navegadores.
  const sink = ctx.createGain(); sink.gain.value = 0;
  worklet.connect(sink); sink.connect(ctx.destination);

  // Bypass del filtro: nodos directos source→merger (sin filtrar) que se
  // activan al desmarcar el filtro.
  const bypass = ctx.createGain();
  bypass.gain.value = 0;
  src.connect(bypass); bypass.connect(merger, 0, 0); bypass.connect(merger, 0, 1);

  src.connect(splitter);

  state.nodes = { src, splitter, merger, chain, gains, monitorGain, bypass, sink };
  state.worklet = worklet;
  state.analyser = analyser;

  applyChannelMode();
  applyBandpass();
  applyImpactsMode();
}

// ===============================================================
// MENSAJES DEL WORKLET (medidores + detecciones)
// ===============================================================
function onWorkletMessage(e) {
  const d = e.data;
  if (d.type === 'meter') {
    state.meterLastTs = Date.now(); // señal de vida del pipeline de audio
    updateMeters(d.rms, d.peak, d.ratio);
  } else if (d.type === 'detect') {
    handleDetection(d);
  }
}

// dBFS a partir de un valor RMS lineal [0..1].
function toDb(x) { return x > 1e-7 ? 20 * Math.log10(x) : -Infinity; }

function updateMeters(rms, peak, ratio) {
  // Mapeo dBFS (-60..0) → ancho 0..100%.
  const pct = (db) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  const dbL = toDb(rms[0]), dbR = toDb(rms[1]);
  els.barL.style.width = pct(dbL) + '%';
  els.barR.style.width = pct(dbR) + '%';
  els.dbL.textContent = isFinite(dbL) ? dbL.toFixed(0) + ' dB' : '-∞';
  els.dbR.textContent = isFinite(dbR) ? dbR.toFixed(0) + ' dB' : '-∞';

  // Peak-hold con caída lenta.
  const pkL = pct(toDb(peak[0])), pkR = pct(toDb(peak[1]));
  state.peakHold.l = Math.max(pkL, state.peakHold.l - 1.2);
  state.peakHold.r = Math.max(pkR, state.peakHold.r - 1.2);
  els.peakL.style.left = state.peakHold.l + '%';
  els.peakR.style.left = state.peakHold.r + '%';

  // Ratio STA/LTA mostrado: el mayor de ambos canales.
  const r = Math.max(ratio[0], ratio[1]);
  els.ratioVal.textContent = r.toFixed(1);
  els.ratioVal.style.color = r > parseFloat(els.sensitivity.value) ? 'var(--red)' : 'var(--text)';
}

const KIND_INFO = {
  bang:   { label: 'GOLPE',        cls: 'bang',   flash: '' },
  voice:  { label: 'VOZ/GRITO',    cls: 'voice',  flash: 'voice' },
  weak:   { label: 'VOCALIZACIÓN', cls: 'weak',   flash: 'weak' },
  breath: { label: 'RESPIRACIÓN',  cls: 'breath', flash: 'breath' },
};

function handleDetection(d) {
  const info = KIND_INFO[d.kind] || KIND_INFO.bang;

  // 1) Flash visual de alto contraste.
  fireFlash(info.flash);

  // 2) Vibración háptica (si está disponible y activada).
  if (els.hapticToggle.checked && navigator.vibrate) {
    const pattern = d.kind === 'bang' ? [60]
                  : d.kind === 'voice' ? [40, 30, 40]
                  : d.kind === 'weak' ? [25, 40, 25] // vocalización débil: pulsos suaves
                  : [120, 60, 120]; // respiración: pulso largo
    navigator.vibrate(pattern);
  }

  // 3) Badge sobre el espectrograma.
  showBadge(info);

  // 4) Texto de última detección.
  const ch = d.channel === 0 ? 'L' : d.channel === 1 ? 'R' : '—';
  let txt = info.label;
  if (d.kind === 'breath' && d.bpm) {
    txt += ' · ' + d.bpm.toFixed(0) + ' rpm';
  } else {
    if (d.ratio) txt += ' · ' + ch + ' · ' + d.ratio.toFixed(1) + '×';
    // Para vocalizaciones (clara o débil), mostrar el tono fundamental.
    if ((d.kind === 'voice' || d.kind === 'weak') && d.f0) txt += ' · f0 ' + Math.round(d.f0) + ' Hz';
  }
  els.lastEvent.textContent = txt;

  // 5) Registrar en el historial persistente.
  recordHistory(d);
}

/* ===============================================================
   HISTORIAL DE DETECCIONES
   Agrupa eventos del mismo tipo dentro de una ventana corta para
   evitar cientos de entradas idénticas, y persiste en localStorage
   para sobrevivir a recargas/cierres durante la operación.
   =============================================================== */
const HISTORY_KEY = 'earth.history.v1';
const HISTORY_GROUP_MS = 5000; // fusiona detecciones del mismo tipo dentro de 5 s
const HISTORY_MAX = 250;       // tope de eventos guardados
let history = loadHistory();

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}
function persistHistory() {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (e) {}
}

function recordHistory(d) {
  const now = Date.now();
  const chLabel = d.channel === 0 ? 'L' : d.channel === 1 ? 'R' : null;
  const top = history[0];

  // ¿Continúa un evento del mismo tipo dentro de la ventana? → agrupar.
  if (top && top.kind === d.kind && (now - top.tEnd) < HISTORY_GROUP_MS) {
    top.tEnd = now;
    top.count++;
    if (typeof d.ratio === 'number') top.ratioMax = Math.max(top.ratioMax || 0, d.ratio);
    if (typeof d.bpm === 'number') top.bpm = d.bpm;
    if (typeof d.f0 === 'number' && d.f0) top.f0 = d.f0;
    if (chLabel && top.channels.indexOf(chLabel) === -1) top.channels.push(chLabel);
  } else {
    history.unshift({
      kind: d.kind,
      tStart: now,
      tEnd: now,
      count: 1,
      ratioMax: typeof d.ratio === 'number' ? d.ratio : 0,
      bpm: typeof d.bpm === 'number' ? d.bpm : null,
      f0: typeof d.f0 === 'number' && d.f0 ? d.f0 : null,
      channels: chLabel ? [chLabel] : [],
    });
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  }
  persistHistory();
  renderHistory();
}

function fmtTime(ms) {
  const dt = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return p(dt.getHours()) + ':' + p(dt.getMinutes()) + ':' + p(dt.getSeconds());
}
function fmtDuration(ev) {
  const s = Math.round((ev.tEnd - ev.tStart) / 1000);
  return s >= 1 ? s + ' s' : '';
}

function renderHistory() {
  // Contadores por tipo (suma de repeticiones).
  let nb = 0, nv = 0, nw = 0, nr = 0;
  for (const ev of history) {
    if (ev.kind === 'bang') nb += ev.count;
    else if (ev.kind === 'voice') nv += ev.count;
    else if (ev.kind === 'weak') nw += ev.count;
    else if (ev.kind === 'breath') nr += ev.count;
  }
  els.cntBang.textContent = nb;
  els.cntVoice.textContent = nv;
  els.cntWeak.textContent = nw;
  els.cntBreath.textContent = nr;

  // Insignia del botón = nº de eventos agrupados.
  const total = history.length;
  els.historyCount.textContent = total > 99 ? '99+' : String(total);
  els.historyCount.hidden = total === 0;

  els.historyEmpty.hidden = total !== 0;

  // Reconstruye la lista (recientes arriba). 250 filas máximo: barato.
  const labels = {
    bang: 'Golpe / impacto',
    voice: 'Voz / grito / ladrido',
    weak: 'Vocalización débil',
    breath: 'Respiración',
  };
  const frag = document.createDocumentFragment();
  for (const ev of history) {
    const li = document.createElement('li');
    li.className = 'hp-item';

    const dot = document.createElement('span');
    dot.className = 'hp-dot ' + ev.kind;

    const main = document.createElement('div');
    main.className = 'hp-main';
    const kind = document.createElement('span');
    kind.className = 'hp-kind';
    kind.textContent = labels[ev.kind] || ev.kind;
    if (ev.count > 1) {
      const x = document.createElement('span');
      x.className = 'hp-xcount';
      x.textContent = '×' + ev.count;
      kind.appendChild(x);
    }
    const detail = document.createElement('span');
    detail.className = 'hp-detail';
    detail.textContent = historyDetail(ev);

    main.appendChild(kind);
    main.appendChild(detail);

    const time = document.createElement('span');
    time.className = 'hp-time';
    time.textContent = fmtTime(ev.tStart);

    li.appendChild(dot);
    li.appendChild(main);
    li.appendChild(time);
    frag.appendChild(li);
  }
  els.historyList.replaceChildren(frag);
}

function historyDetail(ev) {
  const parts = [];
  if (ev.channels && ev.channels.length) parts.push('Canal ' + ev.channels.join('+'));
  if (ev.kind === 'breath' && ev.bpm) parts.push(ev.bpm.toFixed(0) + ' rpm');
  else if (ev.ratioMax) parts.push('pico ' + ev.ratioMax.toFixed(1) + '×');
  if ((ev.kind === 'voice' || ev.kind === 'weak') && ev.f0) parts.push('f0 ' + Math.round(ev.f0) + ' Hz');
  const dur = fmtDuration(ev);
  if (dur) parts.push(dur);
  return parts.join(' · ') || '—';
}

// --- Abrir / cerrar panel -------------------------------------
els.historyBtn.addEventListener('click', () => {
  els.historyPanel.hidden = false;
  renderHistory();
});
els.historyClose.addEventListener('click', () => { els.historyPanel.hidden = true; });

// --- Borrar ---------------------------------------------------
els.historyClear.addEventListener('click', () => {
  if (history.length && !confirm('¿Borrar todo el historial de detecciones?')) return;
  history = [];
  persistHistory();
  renderHistory();
});

// --- Exportar CSV (descarga offline vía Blob) -----------------
els.historyExport.addEventListener('click', exportHistoryCSV);
function exportHistoryCSV() {
  if (!history.length) { alert('No hay detecciones que exportar.'); return; }
  const rows = [['inicio_iso', 'fin_iso', 'tipo', 'canales', 'repeticiones', 'ratio_pico', 'rpm', 'f0_hz']];
  // Exporta del más antiguo al más reciente (orden cronológico natural).
  for (let i = history.length - 1; i >= 0; i--) {
    const ev = history[i];
    rows.push([
      new Date(ev.tStart).toISOString(),
      new Date(ev.tEnd).toISOString(),
      ev.kind,
      (ev.channels || []).join('+'),
      ev.count,
      ev.ratioMax ? ev.ratioMax.toFixed(2) : '',
      ev.bpm ? ev.bpm.toFixed(0) : '',
      ev.f0 ? Math.round(ev.f0) : '',
    ]);
  }
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const stamp = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
                pad2(d.getHours()) + pad2(d.getMinutes());
  a.href = url;
  a.download = 'earth-historial-' + stamp + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function pad2(n) { return String(n).padStart(2, '0'); }
function csvCell(v) {
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function fireFlash(variant) {
  const el = els.alertFlash;
  el.className = 'alert-flash'; // reset
  // Forzar reflow para reiniciar la animación aunque dispare seguido.
  void el.offsetWidth;
  el.className = 'alert-flash fire' + (variant ? ' ' + variant : '');
}

function showBadge(info) {
  let badge = els.detectBadges.querySelector('.badge.' + info.cls);
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'badge ' + info.cls;
    badge.textContent = info.label;
    els.detectBadges.appendChild(badge);
  }
  badge.classList.add('on');
  clearTimeout(state.badgeTimers[info.cls]);
  state.badgeTimers[info.cls] = setTimeout(() => badge.classList.remove('on'), 900);
}

// ===============================================================
// ESPECTROGRAMA EN CASCADA (waterfall vertical)
// ===============================================================
let specCtx, freqData, specW, specH, binCount, maxBin;

function resizeCanvas() {
  const cv = els.spectro;
  const rect = cv.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  specW = Math.max(1, Math.floor(rect.width * dpr));
  specH = Math.max(1, Math.floor(rect.height * dpr));
  cv.width = specW; cv.height = specH;
  specCtx = cv.getContext('2d', { alpha: false });
  specCtx.fillStyle = '#05070a';
  specCtx.fillRect(0, 0, specW, specH);

  if (state.analyser) {
    binCount = state.analyser.frequencyBinCount; // 1024
    freqData = new Uint8Array(binCount);
    // Solo dibujamos hasta FFT_MAX_HZ.
    const nyquist = state.ctx.sampleRate / 2;
    maxBin = Math.min(binCount, Math.ceil((FFT_MAX_HZ / nyquist) * binCount));
  }
}
window.addEventListener('resize', () => { if (state.running) resizeCanvas(); });

// Mapa de color tipo "inferno" simplificado: oscuro→púrpura→naranja→blanco.
function heat(v) {
  // v en [0..1]
  const r = Math.min(255, Math.max(0, 255 * Math.min(1, v * 1.7)));
  const g = Math.min(255, Math.max(0, 255 * Math.max(0, v * 1.6 - 0.45)));
  const b = Math.min(255, Math.max(0, 255 * (v < 0.5 ? v * 1.4 : Math.max(0, 1.2 - v * 1.4))));
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function drawSpectrogram() {
  if (!specCtx || !state.analyser) return;
  state.analyser.getByteFrequencyData(freqData);

  // Desplaza todo 1px hacia abajo (cascada vertical: lo nuevo arriba).
  specCtx.drawImage(els.spectro, 0, 1);

  // Dibuja la fila nueva en la parte superior (y=0).
  // Eje X = frecuencia (escala log para resaltar voz/respiración).
  for (let x = 0; x < specW; x++) {
    // x → bin con escala logarítmica entre BAND_LOW y FFT_MAX_HZ.
    const frac = x / specW;
    const hz = BAND_LOW * Math.pow(FFT_MAX_HZ / BAND_LOW, frac);
    const nyquist = state.ctx.sampleRate / 2;
    const bin = Math.min(maxBin - 1, Math.floor((hz / nyquist) * binCount));
    const v = freqData[bin] / 255;
    specCtx.fillStyle = v < 0.06 ? '#05070a' : heat(v);
    specCtx.fillRect(x, 0, 1, 1);
  }
}

// ===============================================================
// BUCLE DE RENDER
// ===============================================================
function renderLoop() {
  if (!state.running) return;
  drawSpectrogram();
  state.raf = requestAnimationFrame(renderLoop);
}

// ===============================================================
// CONTROLES DE CANAL / FILTRO / MONITOR / SENSIBILIDAD
// ===============================================================
document.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.channelMode = btn.dataset.ch;
    applyChannelMode();
  });
});

// Solo/silencio de canales ajustando las ganancias por canal.
// En modo 'left' enviamos L a ambas salidas (mono centrado) y silenciamos R, etc.
function applyChannelMode() {
  if (!state.nodes.gains) return;
  const [gL, gR] = state.nodes.gains;
  const merger = state.nodes.merger;
  // Reconfiguración simple de ganancias.
  if (state.channelMode === 'stereo') {
    gL.gain.value = 1; gR.gain.value = 1;
  } else if (state.channelMode === 'left') {
    gL.gain.value = 1; gR.gain.value = 0;
  } else {
    gL.gain.value = 0; gR.gain.value = 1;
  }
  // Nota: el merger mantiene la separación espacial en estéreo para que
  // el rescatador localice la fuente con auriculares. En modo solo se
  // escucha el mic elegido en su lado original.
}

els.bandpassToggle.addEventListener('change', applyBandpass);
function applyBandpass() {
  if (!state.nodes.gains) return;
  const on = els.bandpassToggle.checked;
  // Activa la cadena filtrada o la derivación (bypass) sin filtrar.
  state.nodes.gains.forEach((g) => { g.gain.value = on ? (g.gain.value || 1) : 0; });
  state.nodes.bypass.gain.value = on ? 0 : 1;
  // Reaplica el modo de canal por si quedó alguna ganancia a 0.
  if (on) applyChannelMode();
}

els.impactsToggle.addEventListener('change', applyImpactsMode);
function applyImpactsMode() {
  const on = els.impactsToggle.checked;
  // (1) Ensancha el pasa-bajos para no "comerse" el transitorio del golpe.
  if (state.nodes.chain) {
    state.nodes.chain.forEach((f) => {
      f.lp.frequency.value = on ? IMPACT_LP_HZ : BAND_HIGH;
    });
  }
  // (2) Acorta la STA en el worklet para captar el clic brevísimo.
  if (state.worklet) {
    state.worklet.port.postMessage({ staTau: on ? STA_TAU_IMPACT : STA_TAU_NORMAL });
  }
  // (3) Aviso visual del estado (solo en ejecución).
  if (state.running) setStatus(true, on ? 'Escuchando · Impactos' : 'Escuchando');
}

els.monitorToggle.addEventListener('change', () => {
  if (state.nodes.monitorGain)
    state.nodes.monitorGain.gain.value = els.monitorToggle.checked ? 1 : 0;
});

els.sensitivity.addEventListener('input', () => {
  const v = parseFloat(els.sensitivity.value);
  els.sensitivityVal.textContent = v.toFixed(1) + '×';
  if (state.worklet) state.worklet.port.postMessage({ threshold: v });
});

els.tonality.addEventListener('input', () => {
  const v = parseFloat(els.tonality.value);
  els.tonalityVal.textContent = v.toFixed(2);
  if (state.worklet) state.worklet.port.postMessage({ harmThresh: v });
});

els.hapticToggle.addEventListener('change', () => {
  // Pequeña vibración de confirmación al activar.
  if (els.hapticToggle.checked && navigator.vibrate) navigator.vibrate(30);
});

els.wakeToggle.addEventListener('change', () => {
  if (els.wakeToggle.checked) acquireWakeLock();
  else releaseWakeLock();
});

// ===============================================================
// SCREEN WAKE LOCK (mantener la pantalla encendida)
// ===============================================================
async function acquireWakeLock() {
  if (!els.wakeToggle.checked) return;
  if (!('wakeLock' in navigator)) return; // no soportado: se ignora
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { /* liberado por el SO */ });
  } catch (e) { /* puede fallar si la pestaña no está visible */ }
}
async function releaseWakeLock() {
  try { if (state.wakeLock) await state.wakeLock.release(); } catch (e) {}
  state.wakeLock = null;
}
// Al volver a primer plano: readquirir wake lock Y reanudar el audio
// (el SO suele suspender el AudioContext al ocultar la app o bloquear).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.running) {
    if (els.wakeToggle.checked) acquireWakeLock();
    resumeAudio('volver-a-primer-plano');
  }
});

// ===============================================================
// PARAR / LIMPIAR
// ===============================================================
async function stop() {
  state.running = false;
  stopWatchdog();
  cancelAnimationFrame(state.raf);
  await releaseWakeLock();
  try { if (state.worklet) state.worklet.port.postMessage({ stop: true }); } catch (e) {}
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  if (state.ctx) { try { state.ctx.onstatechange = null; await state.ctx.close(); } catch (e) {} }
  state.ctx = null; state.stream = null; state.worklet = null; state.analyser = null;
  state.peakHold = { l: 0, r: 0 };
  hideResume();
  els.appScreen.hidden = true;
  els.startScreen.hidden = false;
  setStatus(false, 'Detenido');
  refreshOfflineStatus(); // re-confirma disponibilidad sin conexión
}

function setStatus(active, text) {
  els.statusText.textContent = text;
  els.statusDot.style.background = active ? 'var(--green)' : 'var(--text-dim)';
  els.statusDot.style.boxShadow = active ? '0 0 10px var(--green)' : 'none';
}

// ===============================================================
// RESILIENCIA DEL AUDIO (que NUNCA se detenga en silencio)
//
// En zona de desastre, perder la captación sin avisar es peligroso.
// Vigilamos tres fallos: (a) AudioContext suspendido por el SO,
// (b) el flujo de medidores se congela (pipeline muerto), y
// (c) el receptor DJI se desconecta. Ante cualquiera: avisamos de
// forma muy visible e intentamos recuperar automáticamente.
// ===============================================================

// Manejadores de la pista de audio (desconexión/silencio del DJI).
function attachTrackHandlers() {
  const track = state.stream && state.stream.getAudioTracks()[0];
  if (!track) return;
  els.deviceLabel.textContent = track.label || 'Entrada de audio';
  track.onended = () => {
    // El cable/dispositivo se desconectó. Intentar reconectar.
    setStatus(true, '⚠ Micrófono desconectado');
    reconnectMic();
  };
  track.onmute = () => setStatus(true, '⚠ Señal en silencio');
  track.onunmute = () => setStatus(true, 'Escuchando');
}

// Reanuda el AudioContext si el SO lo suspendió (llamada, bloqueo…).
// Devuelve true si quedó en 'running'.
async function resumeAudio(reason) {
  if (!state.ctx) return false;
  if (state.ctx.state === 'suspended') {
    try { await state.ctx.resume(); } catch (e) { /* requiere gesto: ver overlay */ }
  }
  return state.ctx.state === 'running';
}

function handleCtxStateChange() {
  if (!state.ctx || !state.running) return;
  if (state.ctx.state === 'suspended') {
    setStatus(true, '⏸ Audio pausado — recuperando…');
    resumeAudio('statechange');
  } else if (state.ctx.state === 'running') {
    setStatus(true, 'Escuchando');
    hideResume();
  }
}

// --- Overlay de reanudación manual (gesto requerido, típico iOS) ---
function showResume() {
  if (els.resumeOverlay.hidden) {
    els.resumeOverlay.hidden = false;
    // Vibración de aviso si está disponible (el operador puede no estar mirando).
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }
}
function hideResume() {
  els.resumeOverlay.hidden = true;
  state.suspendedTicks = 0;
}
// El clic SÍ es un gesto de usuario válido para reanudar el audio en iOS.
els.resumeBtn.addEventListener('click', async () => {
  els.resumeBtn.disabled = true;
  try {
    if (state.ctx) await state.ctx.resume();
    // Si además se perdió la pista, reconstruir la captura.
    const track = state.stream && state.stream.getAudioTracks()[0];
    if (!track || track.readyState === 'ended') await reconnectMic();
    if (els.wakeToggle.checked) acquireWakeLock();
    state.meterLastTs = Date.now();
  } catch (e) { /* reintentará el watchdog */ }
  els.resumeBtn.disabled = false;
  if (state.ctx && state.ctx.state === 'running') {
    hideResume();
    setStatus(true, 'Escuchando');
  }
});

// Reconexión del micrófono tras desconexión del DJI.
async function reconnectMic() {
  if (state.recovering || !state.running) return;
  state.recovering = true;
  try {
    // Reintenta obtener el stream varias veces (puede tardar en reaparecer).
    let stream = null;
    for (let i = 0; i < 30 && state.running; i++) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(state.audioConstraints);
        if (stream) break;
      } catch (e) { /* aún no disponible */ }
      await sleep(1000);
    }
    if (!stream) { setStatus(true, '⚠ Reconecta el receptor DJI'); return; }

    // Sustituye la fuente en el grafo sin recrear todo.
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    state.stream = stream;
    attachTrackHandlers();
    if (state.ctx) await resumeAudio('reconnect');
    rebuildSource();
    state.meterLastTs = Date.now();
    setStatus(true, 'Escuchando');
  } finally {
    state.recovering = false;
  }
}

// Reemplaza el nodo fuente (MediaStreamSource) conectándolo al grafo ya creado.
function rebuildSource() {
  if (!state.ctx || !state.nodes || !state.nodes.splitter) return;
  try { if (state.nodes.src) state.nodes.src.disconnect(); } catch (e) {}
  const src = state.ctx.createMediaStreamSource(state.stream);
  src.connect(state.nodes.splitter);
  // Mantén también la derivación de bypass del filtro.
  if (state.nodes.bypass) {
    src.connect(state.nodes.bypass);
  }
  state.nodes.src = src;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Watchdog: revisa el pulso del pipeline cada segundo. -----
function startWatchdog() {
  stopWatchdog();
  state.watchdog = setInterval(() => {
    if (!state.running) return;

    // (a) Contexto suspendido: intentar reanudar; si persiste, pedir gesto.
    if (state.ctx && state.ctx.state === 'suspended') {
      resumeAudio('watchdog');
      state.suspendedTicks = (state.suspendedTicks || 0) + 1;
      setStatus(true, '⏸ Audio pausado — recuperando…');
      // Tras ~2 s sin lograr reanudar solo (iOS exige gesto), muestra el botón.
      if (state.suspendedTicks >= 2) showResume();
      return;
    } else {
      state.suspendedTicks = 0;
    }

    // (b) ¿Se congeló el flujo de medidores? (> 2 s sin datos)
    const silentMs = Date.now() - state.meterLastTs;
    if (silentMs > 2000 && !state.recovering) {
      setStatus(true, '⚠ Audio detenido — recuperando…');
      resumeAudio('watchdog-stall');
      // Si la pista murió, reconstruir la fuente.
      const track = state.stream && state.stream.getAudioTracks()[0];
      if (!track || track.readyState === 'ended') reconnectMic();
    } else if (silentMs <= 2000 && state.ctx && state.ctx.state === 'running') {
      // Todo bien: oculta overlay y refresca etiqueta si venía de aviso.
      hideResume();
      if (els.statusText.textContent.indexOf('⚠') === 0 ||
          els.statusText.textContent.indexOf('⏸') === 0) {
        setStatus(true, 'Escuchando');
      }
    }
  }, 1000);
}
function stopWatchdog() {
  if (state.watchdog) { clearInterval(state.watchdog); state.watchdog = 0; }
}

// ===============================================================
// ESTADO DE RED / DISPONIBILIDAD OFFLINE
//
// La app NO necesita red para operar. Estos indicadores solo
// informan al rescatador y garantizan que el shell quedó cacheado
// ANTES de adentrarse en una zona sin cobertura.
// ===============================================================
function updateNetPill() {
  const online = navigator.onLine;
  els.netPill.classList.toggle('online', online);
  els.netPill.classList.toggle('offline', !online);
  els.netPill.textContent = online ? 'RED OK' : 'SIN RED · OK';
  els.netPill.title = online
    ? 'Con conexión. La app igualmente funciona sin ella.'
    : 'Sin conexión: la app sigue funcionando con normalidad.';
}
window.addEventListener('online', () => { updateNetPill(); refreshOfflineStatus(); });
window.addEventListener('offline', updateNetPill);

// Pregunta al Service Worker si el caché está completo.
function refreshOfflineStatus() {
  if (!('serviceWorker' in navigator)) { showOfflineStatus(false, true); return; }
  navigator.serviceWorker.ready.then((reg) => {
    const sw = reg.active;
    if (!sw) return;
    sw.postMessage({ type: 'check' });
  }).catch(() => {});
}

// Solicita rellenar el caché (cuando vuelve la señal momentáneamente).
els.recacheBtn.addEventListener('click', () => {
  els.recacheBtn.disabled = true;
  els.recacheBtn.textContent = 'Descargando…';
  navigator.serviceWorker.ready.then((reg) => {
    if (reg.active) reg.active.postMessage({ type: 'recache' });
  });
});

function showOfflineStatus(ready, unknown) {
  const box = els.offlineStatus;
  if (!box) return;
  box.classList.remove('ready', 'checking', 'partial');
  const icon = box.querySelector('.os-icon');
  const text = box.querySelector('.os-text');
  if (unknown) {
    box.classList.add('checking');
    icon.textContent = 'ⓘ';
    text.textContent = 'Sin Service Worker: usa HTTPS para garantizar el modo offline.';
    els.recacheBtn.hidden = true;
  } else if (ready) {
    box.classList.add('ready');
    icon.textContent = '✓';
    text.textContent = 'Listo para usar SIN conexión.';
    els.recacheBtn.hidden = true;
  } else {
    box.classList.add('partial');
    icon.textContent = '⚠';
    text.textContent = 'Descarga incompleta. Conéctate un momento y pulsa el botón.';
    els.recacheBtn.hidden = false;
    els.recacheBtn.disabled = false;
    els.recacheBtn.textContent = 'Descargar para uso sin conexión';
  }
}

// ===============================================================
// SERVICE WORKER (offline)
// ===============================================================
if ('serviceWorker' in navigator) {
  // Cuando un Service Worker NUEVO toma el control, recarga UNA vez para que
  // el HTML, el CSS y el JS provengan todos de la misma versión (evita ver,
  // p. ej., el texto nuevo sin sus estilos por servir CSS viejo en caché).
  // No recargamos si hay una sesión de escucha activa (no interrumpir audio).
  let swRefreshing = false;
  // ¿Ya había un SW controlando? Si no, el primer 'controllerchange' es la
  // instalación inicial (no hay que recargar). Solo recargamos en ACTUALIZACIONES.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swRefreshing || !hadController || state.running) return;
    swRefreshing = true;
    location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(() => {
        // Escucha respuestas del SW sobre el estado del caché.
        navigator.serviceWorker.addEventListener('message', (e) => {
          const d = e.data || {};
          if (d.type === 'offline-status') showOfflineStatus(d.ready, false);
        });
        // Consulta inicial (y reintento corto por si el SW aún activa).
        refreshOfflineStatus();
        setTimeout(refreshOfflineStatus, 1500);
      })
      .catch((e) => { console.warn('SW:', e); showOfflineStatus(false, true); });
  });
} else {
  showOfflineStatus(false, true);
}

// Estado de red inicial.
updateNetPill();

// ===============================================================
// PERSISTENCIA DE AJUSTES
// Una recarga accidental a mitad de operación no debe reiniciar la
// configuración (sensibilidad, canal, filtros, vibración, wake lock).
// ===============================================================
const SETTINGS_KEY = 'earth.settings.v1';
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      sensitivity: els.sensitivity.value,
      tonality: els.tonality.value,
      channelMode: state.channelMode,
      monitor: els.monitorToggle.checked,
      bandpass: els.bandpassToggle.checked,
      haptic: els.hapticToggle.checked,
      wake: els.wakeToggle.checked,
      impacts: els.impactsToggle.checked,
    }));
  } catch (e) {}
}
function restoreSettings() {
  let s;
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) { s = null; }
  if (!s) return;
  if (s.sensitivity) {
    els.sensitivity.value = s.sensitivity;
    els.sensitivityVal.textContent = parseFloat(s.sensitivity).toFixed(1) + '×';
  }
  if (s.tonality) {
    els.tonality.value = s.tonality;
    els.tonalityVal.textContent = parseFloat(s.tonality).toFixed(2);
  }
  if (typeof s.monitor === 'boolean') els.monitorToggle.checked = s.monitor;
  if (typeof s.bandpass === 'boolean') els.bandpassToggle.checked = s.bandpass;
  if (typeof s.haptic === 'boolean') els.hapticToggle.checked = s.haptic;
  if (typeof s.wake === 'boolean') els.wakeToggle.checked = s.wake;
  if (typeof s.impacts === 'boolean') els.impactsToggle.checked = s.impacts;
  if (s.channelMode) {
    state.channelMode = s.channelMode;
    document.querySelectorAll('.seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.ch === s.channelMode);
    });
  }
}
// Guarda ante cualquier cambio de control.
['change', 'input'].forEach((ev) =>
  document.querySelectorAll('.seg-btn, #monitor-toggle, #bandpass-toggle, #haptic-toggle, #wake-toggle, #impacts-toggle, #sensitivity, #tonality')
    .forEach((el) => el.addEventListener(ev, saveSettings)));
restoreSettings();

// Pinta el historial guardado al arrancar (refleja la sesión anterior).
renderHistory();

// Evita zoom por doble toque que interferiría con el uso con guantes.
let lastTouch = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (now - lastTouch < 300) e.preventDefault();
  lastTouch = now;
}, { passive: false });
