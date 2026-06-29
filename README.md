# EARth · Detector acústico de señales de vida

PWA estática (sin frameworks ni build) para operaciones de rescate sísmico.
Procesa audio en tiempo real desde micrófonos externos USB‑C / Lightning
(optimizada para **DJI Mic / DJI Mic 2** a nivel de línea) y detecta indicios
de vida bajo escombros: golpes rítmicos, gritos/ladridos y respiración débil.

Funciona **100 % offline** una vez cargada.

## Características

- **Captura 48 kHz estéreo** del receptor DJI, sin AGC/supresión de ruido del navegador.
- **Filtro pasa‑banda 80–2500 Hz** (cascada Biquad HP+LP) que elimina retumbe de
  maquinaria y siseo de viento/EM.
- **STA/LTA** (medias corta/larga) para impactos y vocalizaciones explosivas.
- **Clasificación tonal** del evento por autocorrelación (f0 + armonicidad +
  decaimiento): distingue **golpe**, **voz/grito/ladrido** y **vocalización
  débil** (gemido/quejido). Umbral de tonalidad ajustable en la UI.
- **Seguidor de micro‑energía** con autocorrelación de la envolvente para
  detectar respiración periódica cerca del ruido de fondo.
- **Modo Impactos**: opción que ensancha el filtro y acorta la ventana STA
  para captar **golpes secos** (transitorios muy breves de banda ancha).
- **Resiliencia**: watchdog del pipeline, auto‑reanudación del audio,
  reconexión del DJI, botón de **Reanudar** manual (iOS) y disponibilidad
  offline verificada antes de perder la señal.
- **AudioWorklet**: todo el análisis corre fuera del hilo de UI.
- **Espectrograma en cascada** (Canvas), medidores **L/R con peak‑hold**,
  **flash** de alto contraste y **vibración háptica** al cruzar el umbral.
- **Selección de canal**: estéreo binaural / Solo L (Mic 1) / Solo R (Mic 2).
- **Screen Wake Lock** para que la pantalla no se apague durante la búsqueda.
- **Service Worker** + **manifest** → instalable y offline.

## Uso

1. Conecta el receptor **DJI Mic** por USB‑C/Lightning y ponte auriculares.
2. Abre la app (HTTPS o `localhost`), pulsa **EMPEZAR A ESCUCHAR** y concede el micrófono.
3. Ajusta la **sensibilidad** y usa **Solo L/R** para localizar la fuente espacialmente.

## Despliegue

Es estática: copia todos los archivos a la raíz del hosting.

- **GitHub Pages**: sube el repo, activa Pages sobre la rama `main` (carpeta raíz).
  El archivo `.nojekyll` evita que Jekyll ignore archivos.
- **Vercel / Netlify**: arrastra la carpeta o conecta el repo. Sin build command.

> El audio del navegador requiere **HTTPS** (los tres hosts lo dan por defecto).

## Probar en local

```bash
# Cualquier servidor estático sirve. Por ejemplo:
npx serve .
# o
python -m http.server 8080
```

Luego abre `http://localhost:8080`.

## Archivos

| Archivo | Rol |
|---|---|
| `index.html` | Estructura y metadatos PWA/iOS |
| `styles.css` | UI de alto contraste, modo oscuro |
| `app.js` | Grafo Web Audio, espectrograma, medidores, Wake Lock, SW |
| `worklet.js` | AudioWorkletProcessor: STA/LTA + envolvente/respiración |
| `sw.js` | Service Worker (cache‑first, offline) |
| `manifest.json` | Manifiesto PWA |
| `icon-*.png`, `apple-touch-icon.png` | Iconos (generables con `tools/generate-icons.js`) |

## Notas de campo

- Usa **auriculares** para evitar realimentación; el **Monitor** se puede silenciar.
- El **modo Solo L/R** ayuda a triangular: mueve el receptor y compara niveles.
- Lleva batería externa; el Wake Lock mantiene la pantalla activa y consume.

## Limitaciones

Herramienta de **asistencia**, no sustituye equipos certificados de búsqueda
(geófonos/cámaras térmicas) ni el criterio del personal de rescate.
