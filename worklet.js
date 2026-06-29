/* ============================================================
   EARth · AudioWorkletProcessor
   Corre en el hilo de audio en tiempo real (NO en el hilo de UI),
   por lo que el análisis intensivo nunca bloquea la interfaz.

   Recibe bloques de 128 muestras por canal a 48 kHz e implementa:
     1) STA/LTA  → impactos rítmicos (golpes/toques) y vocalizaciones
                   explosivas (gritos/ladridos).
     2) Envolvente / micro-energía → variaciones periódicas de baja
                   amplitud (respiración, gemidos) apenas por encima
                   del ruido de fondo, mediante autocorrelación de la
                   envolvente decimada.

   El procesador NO toca el audio (lo deja pasar intacto para el
   monitor); solo mide y envía mensajes al hilo principal por el port.
   ============================================================ */

class LifeDetectorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() { return []; }

  constructor(options) {
    super();
    const sr = sampleRate; // global del AudioWorkletGlobalScope (≈48000)
    this.sr = sr;

    // --- Parámetros STA/LTA (ajustables desde la UI) ----------------
    // STA corta (≈40 ms) reacciona a transitorios; LTA larga (≈1.5 s)
    // estima el ruido de fondo. Usamos medias móviles exponenciales
    // sobre la energía instantánea (x²) para no guardar buffers largos.
    this.staTau = 0.040;
    this.ltaTau = 1.500;
    this.staCoef = Math.exp(-1 / (this.staTau * sr));
    this.ltaCoef = Math.exp(-1 / (this.ltaTau * sr));
    this.threshold = 3.5;     // ratio de disparo
    this.retrigger = 0.250;   // s mínimos entre disparos del mismo tipo

    // Estado por canal (0 = L/Mic1, 1 = R/Mic2).
    this.ch = [this._newChannelState(), this._newChannelState()];

    // --- Envolvente para respiración --------------------------------
    // Decimamos la envolvente a ~100 Hz (1 muestra cada `envStep`).
    this.envRate = 100;
    this.envStep = Math.round(sr / this.envRate);
    this.envCount = 0;
    this.envAccum = 0;        // acumulador |x| del canal mezcla
    this.envN = 0;
    // Buffer circular de ~8 s de envolvente para autocorrelación.
    this.envLen = this.envRate * 8;
    this.envBuf = new Float32Array(this.envLen);
    this.envPos = 0;
    this.envFilled = 0;
    this.breathCheckEvery = this.envRate * 0.5; // analiza cada 0.5 s
    this.breathTick = 0;

    // --- Ventana de análisis para clasificar el evento -------------
    // Buffer circular de la mezcla mono (~43 ms a 48 kHz). Sobre esta
    // ventana se calcula el ZCR fiable, el tono (f0) por autocorrelación
    // y el decaimiento de energía para distinguir VOZ/GRITO/LADRIDO de
    // un GOLPE. Se rellena en cada bloque ANTES del análisis STA/LTA,
    // así en el instante del disparo ya contiene el onset.
    this.anaLen = 2048;
    this.anaBuf = new Float32Array(this.anaLen);
    this.anaPos = 0;
    this.fMinVoc = 150;     // f0 mínimo de banda vocal/animal (Hz)
    this.fMaxVoc = 1400;    // f0 máximo (grito agudo / ladrido) (Hz)
    this.harmThresh = 0.42; // armonicidad mínima para considerar "tonal"

    // --- Cadencia de envío de medidores ----------------------------
    // ~50 fps de metering (cada ~960 muestras) para no saturar el port.
    this.meterStep = Math.round(sr / 50);
    this.meterCount = 0;
    this.meterPeak = [0, 0];
    this.meterSumSq = [0, 0];
    this.meterN = 0;

    this.frame = 0;

    // Recepción de cambios de parámetros desde el hilo principal.
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.threshold === 'number') this.threshold = d.threshold;
      if (typeof d.harmThresh === 'number') this.harmThresh = d.harmThresh;
      if (typeof d.staTau === 'number') {
        this.staTau = d.staTau; this.staCoef = Math.exp(-1 / (d.staTau * sr));
      }
      if (typeof d.ltaTau === 'number') {
        this.ltaTau = d.ltaTau; this.ltaCoef = Math.exp(-1 / (d.ltaTau * sr));
      }
    };
  }

  _newChannelState() {
    return { sta: 0, lta: 1e-6, lastFire: -1, ratio: 0 };
  }

  /* Clasifica el evento que acaba de disparar el STA/LTA analizando la
     ventana rodante (~43 ms). Distingue VOZ/GRITO/LADRIDO de un GOLPE
     combinando tres rasgos:
       · armonicidad + f0 por autocorrelación (las vocalizaciones tienen
         un fundamental fuerte; los impactos son inarmónicos),
       · decaimiento de energía (los golpes caen rápido; las voces se
         sostienen),
       · ZCR fiable medido sobre toda la ventana (no sobre 128 muestras).
     Devuelve {kind, f0, harm, zcr, decay}. */
  _classifyEvent() {
    const n = this.anaLen;
    const x = new Float32Array(n);
    // Desenrolla el buffer circular (más antiguo → más nuevo).
    for (let i = 0; i < n; i++) x[i] = this.anaBuf[(this.anaPos + i) % n];

    // Quita la componente DC y mide energía total y por mitades.
    let mean = 0;
    for (let i = 0; i < n; i++) mean += x[i];
    mean /= n;
    const half = n >> 1;
    let energy = 0, e1 = 0, e2 = 0;
    for (let i = 0; i < n; i++) {
      x[i] -= mean;
      const e = x[i] * x[i];
      energy += e;
      if (i < half) e1 += e; else e2 += e;
    }
    if (energy < 1e-9) return { kind: 'bang', f0: 0, harm: 0, zcr: 0, decay: 0 };

    // ZCR fiable sobre toda la ventana (cruces por segundo).
    let z = 0;
    for (let i = 1; i < n; i++) {
      if ((x[i - 1] < 0 && x[i] >= 0) || (x[i - 1] >= 0 && x[i] < 0)) z++;
    }
    const zcr = z / (n / this.sr);

    // Decaimiento: 2ª mitad / 1ª mitad. Un impacto cae rápido (≪1);
    // una vocalización sostenida se mantiene (≈1 o mayor).
    const decay = e2 / (e1 + 1e-9);

    // Autocorrelación normalizada en banda vocal → f0 y armonicidad.
    // CLAVE: solo contamos un pico DESPUÉS de que la autocorrelación se
    // haya hecho negativa al menos una vez (la señal se "decorrela"). Un
    // tono grave suave o el ruido de banda ancha dan correlación alta a
    // lags cortos pero SIN un pico tras decorrelarse, así que no fingen un
    // fundamental → no se clasifican como voz.
    const lagMin = Math.max(2, Math.floor(this.sr / this.fMaxVoc));
    const lagMax = Math.min(n - 1, Math.floor(this.sr / this.fMinVoc));
    let bestLag = -1, bestCorr = 0, decorrelated = false;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let c = 0;
      const lim = n - lag;
      for (let i = 0; i < lim; i++) c += x[i] * x[i + lag];
      c /= energy; // normalizado ~[-1,1]
      if (!decorrelated && c < 0) decorrelated = true;
      if (decorrelated && c > bestCorr) { bestCorr = c; bestLag = lag; }
    }
    const f0 = bestLag > 0 ? this.sr / bestLag : 0;
    const harm = bestCorr;

    // Decisión (tres niveles tonales + golpe).
    //   voice → vocalización clara (grito/ladrido/llanto): muy periódica.
    //   weak  → vocalización DÉBIL (gemido/quejido/lloriqueo): tonal pero
    //           con menos armonicidad o más ruido; señal intermedia entre
    //           "golpe" y "voz" que conviene resaltar para no perderla.
    //   bang  → impacto inarmónico o ruido de banda ancha.
    const harmWeak = this.harmThresh * 0.55; // banda débil ligada al umbral
    let kind;
    if (decay < 0.25) {
      // Transitorio de caída rápida: golpe/impacto o resonancia metálica.
      // Una vocalización real no decae a <25 % en 43 ms.
      kind = 'bang';
    } else if (harm >= this.harmThresh && f0 >= this.fMinVoc && f0 <= this.fMaxVoc) {
      kind = 'voice';            // periódica y con f0 en rango vocal/animal
    } else if (harm >= 0.60) {
      kind = 'voice';            // muy periódica aunque f0 quede al borde
    } else if (harm >= harmWeak && f0 >= this.fMinVoc && f0 <= this.fMaxVoc) {
      kind = 'weak';             // vocalización débil / poco tonal
    } else {
      kind = 'bang';             // no tonal → impacto/ruido de banda ancha
    }
    return { kind, f0, harm, zcr, decay };
  }

  /* Autocorrelación de la envolvente para detectar periodicidad lenta.
     Respiración humana ≈ 0.16–0.5 Hz (10–30 resp/min) → periodo 2–6 s.
     Devuelve {detected, periodSec, strength}. */
  _detectBreathing() {
    if (this.envFilled < this.envLen) return null;
    // Copia ordenada del buffer circular.
    const n = this.envLen;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = this.envBuf[(this.envPos + i) % n];

    // Quita la media (DC) para medir solo la modulación.
    let mean = 0;
    for (let i = 0; i < n; i++) mean += x[i];
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) { x[i] -= mean; energy += x[i] * x[i]; }
    if (energy < 1e-9) return null;

    // Rango de lags correspondiente a 2–6 s.
    const lagMin = Math.floor(2.0 * this.envRate);
    const lagMax = Math.floor(6.0 * this.envRate);
    let bestLag = -1, bestCorr = 0;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let c = 0;
      for (let i = 0; i + lag < n; i++) c += x[i] * x[i + lag];
      c /= energy; // normalizado [-1,1]
      if (c > bestCorr) { bestCorr = c; bestLag = lag; }
    }
    // Umbral de periodicidad: correlación clara y sostenida.
    if (bestCorr > 0.30 && bestLag > 0) {
      return {
        detected: true,
        periodSec: bestLag / this.envRate,
        bpm: (this.envRate / bestLag) * 60, // respiraciones por minuto
        strength: bestCorr,
      };
    }
    return null;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const left = input[0];
    const right = input.length > 1 ? input[1] : input[0];
    const blockLen = left.length; // normalmente 128
    if (blockLen === 0) return true;

    const channels = [left, right];

    // ---- Ventana de análisis (mezcla mono) -------------------------
    // Se llena ANTES del STA/LTA para que el clasificador vea el onset.
    for (let i = 0; i < blockLen; i++) {
      this.anaBuf[this.anaPos] = (left[i] + right[i]) * 0.5;
      this.anaPos = (this.anaPos + 1) % this.anaLen;
    }

    // ---- STA/LTA por canal + acumulación de medidores --------------
    for (let c = 0; c < 2; c++) {
      const buf = channels[c];
      const st = this.ch[c];
      let peak = this.meterPeak[c];
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const s = buf[i];
        const e = s * s;                 // energía instantánea
        // Medias móviles exponenciales muestra a muestra.
        st.sta = this.staCoef * st.sta + (1 - this.staCoef) * e;
        st.lta = this.ltaCoef * st.lta + (1 - this.ltaCoef) * e;
        sumSq += e;
        const a = s < 0 ? -s : s;
        if (a > peak) peak = a;
      }
      this.meterPeak[c] = peak;
      this.meterSumSq[c] += sumSq;

      const ratio = st.sta / (st.lta + 1e-9);
      st.ratio = ratio;

      // Disparo STA/LTA con anti-rebote.
      const tNow = currentTime;
      if (ratio > this.threshold && (tNow - st.lastFire) > this.retrigger) {
        st.lastFire = tNow;
        // Clasificación por tono/armonicidad/decaimiento sobre la ventana.
        const cl = this._classifyEvent();
        this.port.postMessage({
          type: 'detect', kind: cl.kind, channel: c, ratio,
          f0: cl.f0, harm: cl.harm, zcr: cl.zcr, t: tNow,
        });
      }
    }
    this.meterN += blockLen;

    // ---- Envolvente decimada (canal mezcla) ------------------------
    for (let i = 0; i < blockLen; i++) {
      const mix = (left[i] + right[i]) * 0.5;
      this.envAccum += mix < 0 ? -mix : mix;
      this.envN++;
      if (++this.envCount >= this.envStep) {
        const envVal = this.envAccum / this.envN;
        this.envBuf[this.envPos] = envVal;
        this.envPos = (this.envPos + 1) % this.envLen;
        if (this.envFilled < this.envLen) this.envFilled++;
        this.envAccum = 0; this.envN = 0; this.envCount = 0;

        // Comprueba respiración periódicamente.
        if (++this.breathTick >= this.breathCheckEvery) {
          this.breathTick = 0;
          const b = this._detectBreathing();
          if (b) {
            this.port.postMessage({
              type: 'detect', kind: 'breath',
              bpm: b.bpm, periodSec: b.periodSec, strength: b.strength,
              t: currentTime,
            });
          }
        }
      }
    }

    // ---- Envío de medidores a ~50 fps ------------------------------
    this.meterCount += blockLen;
    if (this.meterCount >= this.meterStep) {
      const n = this.meterN || 1;
      const rmsL = Math.sqrt(this.meterSumSq[0] / n);
      const rmsR = Math.sqrt(this.meterSumSq[1] / n);
      this.port.postMessage({
        type: 'meter',
        rms: [rmsL, rmsR],
        peak: [this.meterPeak[0], this.meterPeak[1]],
        ratio: [this.ch[0].ratio, this.ch[1].ratio],
      });
      // Reinicia acumuladores de medición.
      this.meterCount = 0; this.meterN = 0;
      this.meterSumSq[0] = 0; this.meterSumSq[1] = 0;
      this.meterPeak[0] = 0; this.meterPeak[1] = 0;
    }

    return true; // mantener vivo el procesador
  }
}

registerProcessor('life-detector', LifeDetectorProcessor);
