# tools/generate-manual.py
# Genera el manual en PDF "Escaneo LiDAR de zona de escombros con Scaniverse".
# Documento sencillo, en español, pensado para imprimir o consultar offline.
#
#   python tools/generate-manual.py
#
# Salida: ../manual-scaniverse.pdf (raíz del repo, para enlazar desde la app).

import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    ListFlowable, ListItem, HRFlowable,
)

OUT = os.path.join(os.path.dirname(__file__), "..", "manual-scaniverse.pdf")

# Paleta coherente con la app (sobre fondo blanco para impresión).
BG_DARK = colors.HexColor("#0d1117")
AMBER = colors.HexColor("#b5790a")
RED = colors.HexColor("#c0291f")
DIM = colors.HexColor("#5b6370")
LINE = colors.HexColor("#d0d4da")

styles = getSampleStyleSheet()

h_title = ParagraphStyle(
    "HTitle", parent=styles["Title"], fontSize=20, leading=24,
    textColor=BG_DARK, spaceAfter=2, alignment=TA_LEFT,
)
h_sub = ParagraphStyle(
    "HSub", parent=styles["Normal"], fontSize=11, leading=14,
    textColor=DIM, spaceAfter=10,
)
h2 = ParagraphStyle(
    "H2", parent=styles["Heading2"], fontSize=13, leading=16,
    textColor=AMBER, spaceBefore=12, spaceAfter=4,
)
body = ParagraphStyle(
    "Body", parent=styles["Normal"], fontSize=10.5, leading=14.5,
    textColor=colors.HexColor("#1b1f24"), spaceAfter=4,
)
bullet = ParagraphStyle(
    "Bul", parent=body, spaceAfter=2,
)
note = ParagraphStyle(
    "Note", parent=body, fontSize=10, leading=13.5,
    textColor=colors.HexColor("#5a1410"),
)
small = ParagraphStyle(
    "Small", parent=styles["Normal"], fontSize=8.5, leading=11, textColor=DIM,
)


def ul(items, st=bullet):
    """Lista con viñetas."""
    return ListFlowable(
        [ListItem(Paragraph(t, st), leftIndent=6) for t in items],
        bulletType="bullet", start="•", bulletColor=AMBER,
        leftIndent=12, bulletFontSize=8,
    )


def ol(items, st=bullet):
    """Lista numerada."""
    return ListFlowable(
        [ListItem(Paragraph(t, st), leftIndent=6) for t in items],
        bulletType="1", leftIndent=14, bulletColor=AMBER,
    )


def box(flowable_text, bg, border, txt_style):
    """Recuadro de aviso."""
    t = Table([[Paragraph(flowable_text, txt_style)]], colWidths=[165 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0.8, border),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return t


story = []

# --- Cabecera ---------------------------------------------------
story.append(Paragraph("Manual rápido · Escaneo LiDAR de escombros", h_title))
story.append(Paragraph(
    "Aplicación <b>Scaniverse</b> como complemento visual de <b>EARth</b> "
    "para mapear espacios reducidos en operaciones de rescate.", h_sub))
story.append(HRFlowable(width="100%", thickness=1.2, color=AMBER, spaceAfter=6))

# --- 1. Para qué sirve -----------------------------------------
story.append(Paragraph("1 · ¿Para qué sirve?", h2))
story.append(Paragraph(
    "EARth <b>escucha</b> señales de vida; Scaniverse <b>ve</b> la geometría. "
    "Juntas ayudan a localizar y a planear un acceso seguro:", body))
story.append(ul([
    "Genera un modelo 3D de huecos, aberturas y estructura del espacio reducido.",
    "Permite medir distancias y anchos de paso antes de introducir herramientas o personal.",
    "Documenta la escena y se comparte con el puesto de mando y otros equipos.",
]))

# --- 2. Requisitos ---------------------------------------------
story.append(Paragraph("2 · Requisitos", h2))
story.append(ul([
    "<b>iOS (recomendado):</b> iPhone/iPad Pro con sensor <b>LiDAR</b> (iPhone 12 Pro y "
    "posteriores «Pro»; iPad Pro 2020 en adelante). Mide incluso en oscuridad.",
    "<b>Android:</b> teléfono compatible con Scaniverse; escanea por <b>fotogrametría</b>, "
    "así que necesita buena iluminación y más solape entre pasadas.",
    "App <b>Scaniverse</b> (gratuita) instalada — enlaces (iOS / Android) en la pantalla de EARth.",
    "Foco o linterna: imprescindible para color y textura (en oscuridad total Android no escanea bien).",
    "Recomendado: pértiga / monopié para acercar el dispositivo a los huecos sin exponerse.",
]))

# --- 3. Seguridad primero --------------------------------------
story.append(Paragraph("3 · Antes de escanear — seguridad primero", h2))
story.append(box(
    "<b>ATENCIÓN — No introduzcas el cuerpo ni el brazo en huecos inestables.</b> Usa una "
    "pértiga para acercar el dispositivo. Coordina con el responsable de seguridad. "
    "El escaneo <b>no sustituye</b> la evaluación estructural de un ingeniero.",
    colors.HexColor("#fdecea"), RED, note))
story.append(Spacer(1, 6))

# --- 4. Paso a paso --------------------------------------------
story.append(Paragraph("4 · Cómo escanear (paso a paso)", h2))
story.append(ol([
    "Abre Scaniverse y pulsa el botón rojo <b>«New Scan»</b>.",
    "Elige el <b>tipo</b> de escaneo: <b>«Mesh»</b> (malla). Permite medir distancias y es "
    "el adecuado para rescate; evita «Splat», pensado solo para visualización.",
    "Elige la <b>dimensión</b> y pulsa <b>«Large Object / Area»</b>: cubre toda la zona y los "
    "huecos entre escombros (no «Small Object», que es solo para objetos pequeños).",
    "Apunta a la superficie y <b>muévete despacio</b>, manteniendo entre <b>0,5 y 3 m</b> de distancia.",
    "Cubre con pasadas <b>solapadas</b>: paredes, techo, suelo, aberturas y el interior de los huecos.",
    "Las zonas capturadas se «pintan» en pantalla; rellena los parches que queden sin cubrir.",
    "Pulsa <b>«Done»</b> y luego <b>«Process»</b> para generar el modelo 3D del área.",
]))

# --- 5. Buenas prácticas ---------------------------------------
story.append(Paragraph("5 · Buenas prácticas en espacios reducidos", h2))
story.append(ul([
    "Movimientos suaves y continuos; los giros bruscos hacen perder el seguimiento.",
    "Solapa cada pasada alrededor de un 30 %.",
    "Ilumina de forma difusa; no apuntes la linterna directamente a la cámara.",
    "El cristal, el agua y las superficies muy reflectantes dejan huecos: rodéalas.",
    "Si pierde el seguimiento, vuelve a una zona ya escaneada para reanudar.",
]))

# --- 6. Medir y compartir --------------------------------------
story.append(Paragraph("6 · Medir y compartir", h2))
story.append(ul([
    "Tras procesar, usa la herramienta de <b>medición</b> para distancias y anchos de paso.",
    "Exporta o comparte (<b>«Share»</b>) el modelo o un vídeo con el equipo y el puesto de mando.",
]))

# --- Aviso final -----------------------------------------------
story.append(Spacer(1, 8))
story.append(box(
    "<b>Aviso:</b> herramienta de apoyo para documentar y planear el acceso. "
    "No determina por sí sola la presencia de víctimas ni la seguridad estructural. "
    "Toda decisión debe validarla personal de rescate y estructural cualificado.",
    colors.HexColor("#fdecea"), RED, note))

story.append(Spacer(1, 10))
story.append(HRFlowable(width="100%", thickness=0.6, color=LINE, spaceAfter=4))
story.append(Paragraph(
    "EARth · Documento de consulta offline · Scaniverse es una marca de su propietario; "
    "este manual es una guía de uso independiente.", small))


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(DIM)
    canvas.drawString(20 * mm, 12 * mm, "EARth — Manual de escaneo LiDAR")
    canvas.drawRightString(190 * mm, 12 * mm, "Pág. %d" % doc.page)
    canvas.restoreState()


doc = SimpleDocTemplate(
    OUT, pagesize=A4,
    leftMargin=22 * mm, rightMargin=22 * mm,
    topMargin=18 * mm, bottomMargin=18 * mm,
    title="Manual de escaneo LiDAR de escombros con Scaniverse",
    author="EARth",
)
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print("PDF escrito en", os.path.abspath(OUT))
