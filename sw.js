/* ============================================================
   EARth · Service Worker
   Objetivo crítico: la app debe seguir funcionando AUNQUE no haya
   señal celular en una zona de colapso. Para ello:

   1) Precachea todo el "app shell" de forma TOLERANTE a fallos de
      red intermitente (cachea asset por asset con reintentos), en
      lugar de abortar todo si una descarga falla.
   2) Expone al hilo principal si el caché está COMPLETO ('check')
      para que la UI avise "listo para usar sin conexión".
   3) Permite "rellenar" el caché ('recache') cuando vuelve la señal
      un instante, sin recargar la app.
   4) Sirve siempre desde caché primero; la red es solo un extra.

   Sube CACHE_VERSION al desplegar cambios para invalidar el caché.
   ============================================================ */

const CACHE_VERSION = 'earth-v1.4.0';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './worklet.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
];

/* Cachea un asset con varios reintentos (señal intermitente). */
async function cacheWithRetry(cache, url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      // cache:'reload' evita usar el caché HTTP del navegador (queremos la copia fresca).
      const res = await fetch(url, { cache: 'reload' });
      if (res && (res.ok || res.type === 'opaque')) {
        await cache.put(url, res.clone());
        return true;
      }
    } catch (e) { /* reintenta */ }
  }
  return false;
}

/* Intenta cachear todo lo que falte. Devuelve la lista de los que faltan. */
async function precache() {
  const cache = await caches.open(CACHE_VERSION);
  const missing = [];
  for (const url of ASSETS) {
    const already = await cache.match(url);
    if (already) continue;
    const ok = await cacheWithRetry(cache, url);
    if (!ok) missing.push(url);
  }
  return missing;
}

/* ¿Está completo el caché? Devuelve los assets ausentes. */
async function missingAssets() {
  const cache = await caches.open(CACHE_VERSION);
  const missing = [];
  for (const url of ASSETS) {
    if (!(await cache.match(url))) missing.push(url);
  }
  return missing;
}

// --- Instalación: precarga tolerante a fallos. ----------------
self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

// --- Activación: borra cachés antiguos y toma control. --------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// --- Mensajería con el hilo principal -------------------------
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  const reply = (data) => { if (event.source) event.source.postMessage(data); };

  if (msg.type === 'check') {
    missingAssets().then((missing) =>
      reply({ type: 'offline-status', ready: missing.length === 0, missing }));
  } else if (msg.type === 'recache') {
    precache().then((missing) =>
      reply({ type: 'offline-status', ready: missing.length === 0, missing }));
  } else if (msg.type === 'skipWaiting') {
    self.skipWaiting();
  }
});

// --- Fetch: cache-first con respaldo a red. -------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Navegaciones: caché primero (clave sin señal), luego red.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then((cached) =>
        cached || fetch(req).catch(() => caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached); // sin red y sin caché: undefined (se maneja arriba)
    })
  );
});
