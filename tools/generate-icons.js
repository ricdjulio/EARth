// tools/generate-icons.js
// Generador de iconos PNG sin dependencias externas (solo el módulo `zlib` de Node).
// Dibuja en un búfer de píxeles RGBA y codifica un PNG válido a mano.
// Produce: icon-192.png, icon-512.png, icon-512-maskable.png, apple-touch-icon.png
//
// Diseño: fondo oscuro, anillos concéntricos ámbar (ondas de sonido) y un punto
// central rojo. Estética coherente con la UI de alto contraste de la app.

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// --- CRC32 (requerido por cada chunk PNG) -------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- Empaquetado de chunks ----------------------------------------------
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // profundidad de bits
  ihdr[9] = 6;  // tipo de color: RGBA
  ihdr[10] = 0; // compresión
  ihdr[11] = 0; // filtro
  ihdr[12] = 0; // entrelazado
  // Cada scanline va precedida por 1 byte de filtro (0 = none).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Dibujo del icono ----------------------------------------------------
function drawIcon(size, maskable) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  // Margen seguro: los iconos "maskable" pueden recortarse en círculo,
  // así que mantenemos el grafismo dentro del 80% central.
  const safe = maskable ? 0.62 : 0.78;

  const bg = [13, 17, 23];        // #0d1117 fondo
  const ring = [255, 176, 0];     // #ffb000 ámbar
  const core = [255, 59, 48];     // #ff3b30 rojo alerta

  const maxR = (size / 2) * safe;
  // Tres anillos a fracciones del radio máximo.
  const rings = [0.40, 0.68, 1.0].map((f) => maxR * f);
  const ringW = Math.max(2, size * 0.022);
  const coreR = maxR * 0.16;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      let r = bg[0], g = bg[1], b = bg[2];

      // Punto central.
      if (d <= coreR) {
        r = core[0]; g = core[1]; b = core[2];
      } else {
        // Anillos: solo el semicírculo derecho (estilo "señal emitida"),
        // pero dibujamos completos para legibilidad como icono.
        for (const rad of rings) {
          if (Math.abs(d - rad) <= ringW / 2) {
            // Atenuación de los anillos exteriores.
            const fade = 1 - (rad / maxR) * 0.35;
            r = Math.round(ring[0] * fade + bg[0] * (1 - fade));
            g = Math.round(ring[1] * fade + bg[1] * (1 - fade));
            b = Math.round(ring[2] * fade + bg[2] * (1 - fade));
            break;
          }
        }
      }
      const i = (y * size + x) * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
    }
  }
  return encodePNG(size, size, rgba);
}

const outDir = path.resolve(__dirname, '..');
const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-512-maskable.png', 512, true],
  ['apple-touch-icon.png', 180, false],
];
for (const [name, size, maskable] of targets) {
  fs.writeFileSync(path.join(outDir, name), drawIcon(size, maskable));
  console.log('escrito', name, size + 'x' + size);
}
