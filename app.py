"""
Árbol de Habilidades - Servidor Flask local.
Ejecuta: python app.py  y abre http://localhost:5000
"""
import base64
import io
import sys
import json
import logging
import mimetypes
import os
import re
import time
import traceback
import uuid
import webbrowser
from collections import deque
from datetime import datetime, timezone
from threading import Timer, Lock
from PIL import Image
from flask import Flask, render_template, request, jsonify, g, send_from_directory
from werkzeug.utils import secure_filename

def _get_bundle_dir() -> str:
    if getattr(sys, 'frozen', False):
        return sys._MEIPASS  # type: ignore[attr-defined]
    return os.path.dirname(os.path.abspath(__file__))

def _get_data_dir() -> str:
    if getattr(sys, 'frozen', False):
        if sys.platform == 'darwin':
            d = os.path.expanduser('~/Library/Application Support/Grimorio')
        elif sys.platform == 'win32':
            d = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'Grimorio')
        else:
            d = os.path.expanduser('~/.grimorio')
        os.makedirs(d, exist_ok=True)
        return d
    return os.path.dirname(os.path.abspath(__file__))

_BUNDLE_DIR = _get_bundle_dir()
_DATA_DIR   = _get_data_dir()

app = Flask(
    __name__,
    template_folder=os.path.join(_BUNDLE_DIR, 'templates'),
    static_folder=os.path.join(_BUNDLE_DIR, 'static'),
)

# ── Sistema de logging en memoria ─────────────────────────────────────────────

LOG_CAPACITY = 200  # entradas máximas en el buffer circular

_log_buffer: deque = deque(maxlen=LOG_CAPACITY)
_log_lock = Lock()


def _push_log(level: str, message: str, **extra) -> None:
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "msg": message,
        **extra,
    }
    with _log_lock:
        _log_buffer.append(entry)


class _BufferHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        _push_log(level=record.levelname, message=self.format(record))


_fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s — %(message)s")
_buf_handler = _BufferHandler()
_buf_handler.setFormatter(_fmt)
_stream_handler = logging.StreamHandler()
_stream_handler.setFormatter(_fmt)

for _ln in ("", "werkzeug"):
    _l = logging.getLogger(_ln)
    _l.setLevel(logging.INFO)
    _l.addHandler(_buf_handler)
    _l.addHandler(_stream_handler)

logger = logging.getLogger(__name__)


@app.before_request
def _log_before() -> None:
    g.t0 = time.perf_counter()


@app.after_request
def _log_after(response):
    elapsed_ms = round((time.perf_counter() - g.t0) * 1000, 1)
    _push_log(
        level="REQUEST",
        message=f"{request.method} {request.path} → {response.status_code} ({elapsed_ms} ms)",
        method=request.method,
        path=request.path,
        status=response.status_code,
        ip=request.remote_addr,
        elapsed_ms=elapsed_ms,
    )
    return response


@app.errorhandler(Exception)
def _handle_exception(exc: Exception):
    tb = traceback.format_exc()
    _push_log(
        level="ERROR",
        message=f"Unhandled exception: {exc}",
        traceback=tb,
        path=request.path,
        method=request.method,
    )
    logger.error("Exception on %s %s: %s", request.method, request.path, exc)
    return jsonify({"error": "Internal server error", "detail": str(exc)}), 500


# ── Archivo donde se guarda el árbol ──────────────────────────────────────────
DATA_FILE = os.path.join(_DATA_DIR, "tree_data.json")

# ── Carpeta de imágenes ────────────────────────────────────────────────────────
IMAGES_DIR = os.path.join(_DATA_DIR, "images")
os.makedirs(IMAGES_DIR, exist_ok=True)

ALLOWED_EXTENSIONS = {'jpg', 'jpeg', 'png', 'gif', 'webp', 'ico'}


def _allowed_ext(filename: str) -> bool:
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

# Estructura inicial: un nodo raíz en el centro
DEFAULT_TREE = {
    "nodes": [
        {
            "id": "root",
            "type": "circle",
            "size": 60,
            "x": 0,
            "y": 0,
            "title": "Inicio",
            "icon": "★",
            "content": "# Bienvenido a tu árbol de conocimiento\n\nEste es el nodo raíz. Desde aquí parten todas las ramas de tu conocimiento.\n\nHaz clic derecho en cualquier nodo para añadir uno nuevo conectado a él.",
            "color": "#f5c542"
        }
    ],
    "connections": []
}


def load_tree():
    """Carga el árbol desde disco o crea uno nuevo."""
    if not os.path.exists(DATA_FILE):
        save_tree(DEFAULT_TREE)
        return DEFAULT_TREE
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return DEFAULT_TREE


def save_tree(data):
    """Guarda el árbol en disco."""
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


# ── Exportación HTML autocontenida ────────────────────────────────────────────

_VIEWER_JS = r"""
(() => {
'use strict';

const tree = __TREE__;
const canvas = document.getElementById('tree-canvas');
const ctx = canvas.getContext('2d');

let view = { x: 0, y: 0, scale: 1 };
let hoveredId = null;
let draggingNode = null;
let panning = false;
let panStart = null;
let openPopupId = null;

const BACKGROUNDS = {
  oscuro:    { fill: '#0d0b08', grid: 'rgba(245,197,66,0.04)',  subtitle: '#e8dfc9' },
  abismo:    { fill: '#060c1a', grid: 'rgba(100,150,255,0.05)', subtitle: '#b0c8f0' },
  bosque:    { fill: '#060d06', grid: 'rgba(80,180,100,0.05)',  subtitle: '#b0e0b8' },
  sangre:    { fill: '#130505', grid: 'rgba(200,60,60,0.06)',   subtitle: '#f0b8b8' },
  pergamino: { fill: '#f2ebda', grid: 'rgba(100,70,30,0.08)',   subtitle: '#3a2510' },
  ceniza:    { fill: '#0d0e10', grid: 'rgba(140,150,170,0.06)', subtitle: '#c8ccd8' },
};
const activeBg = (tree.background && BACKGROUNDS[tree.background]) ? tree.background : 'oscuro';

const _imgCache = new Map();

function _ensureImage(node) {
  if (!node.iconImage) { _imgCache.delete(node.id); return; }
  const cached = _imgCache.get(node.id);
  if (cached && cached._src === node.iconImage) return;
  const img = new Image();
  img._src = node.iconImage;
  img.onload = () => render();
  img.src = node.iconImage;
  _imgCache.set(node.id, img);
}

function getNode(id) { return tree.nodes.find(n => n.id === id); }
function isLinkNode(n) { return n.kind === 'link' || (n.kind === undefined && !!n.url); }

function worldToScreen(wx, wy) {
  return {
    x: wx * view.scale + view.x + canvas.width / 2,
    y: wy * view.scale + view.y + canvas.height / 2
  };
}

function findNodeAt(sx, sy) {
  for (let i = tree.nodes.length - 1; i >= 0; i--) {
    const n = tree.nodes[i];
    const p = worldToScreen(n.x, n.y);
    const r = n.size * view.scale;
    const dx = sx - p.x, dy = sy - p.y;
    if (Math.sqrt(dx*dx + dy*dy) <= r) return n;
  }
  return null;
}

function toast(msg, duration = 2000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), duration);
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}
window.addEventListener('resize', resizeCanvas);

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawBackgroundGrid();
  drawConnections();
  drawNodes();
}

function drawBackgroundGrid() {
  const gridSize = 80 * view.scale;
  if (gridSize < 20) return;
  ctx.strokeStyle = 'rgba(245, 197, 66, 0.04)';
  ctx.lineWidth = 1;
  const offsetX = (view.x + canvas.width / 2) % gridSize;
  const offsetY = (view.y + canvas.height / 2) % gridSize;
  ctx.beginPath();
  for (let x = offsetX; x < canvas.width; x += gridSize) {
    ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height);
  }
  for (let y = offsetY; y < canvas.height; y += gridSize) {
    ctx.moveTo(0, y); ctx.lineTo(canvas.width, y);
  }
  ctx.stroke();
}

function drawConnections() {
  for (const c of tree.connections) {
    const a = getNode(c.from), b = getNode(c.to);
    if (!a || !b) continue;
    const pa = worldToScreen(a.x, a.y), pb = worldToScreen(b.x, b.y);
    const grad = ctx.createLinearGradient(pa.x, pa.y, pb.x, pb.y);
    grad.addColorStop(0, a.color || '#f5c542');
    grad.addColorStop(1, b.color || '#f5c542');
    ctx.strokeStyle = grad;
    ctx.globalAlpha = 0.15; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    ctx.globalAlpha = 0.75; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawShape(x, y, r, type) {
  ctx.beginPath();
  if (type === 'circle') {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  } else if (type === 'square') {
    const s = r * 1.7;
    ctx.rect(x - s/2, y - s/2, s, s);
  } else if (type === 'triangle') {
    const h = r * 1.15;
    ctx.moveTo(x, y - h);
    ctx.lineTo(x + h*0.95, y + h*0.7);
    ctx.lineTo(x - h*0.95, y + h*0.7);
    ctx.closePath();
  }
}

function lighten(hex, amount) { return mixColor(hex, '#ffffff', amount); }
function darken(hex, amount)  { return mixColor(hex, '#000000', amount); }
function mixColor(a, b, t) {
  const pa = parseHex(a), pb = parseHex(b);
  return `rgb(${Math.round(pa[0]+(pb[0]-pa[0])*t)},${Math.round(pa[1]+(pb[1]-pa[1])*t)},${Math.round(pa[2]+(pb[2]-pa[2])*t)})`;
}
function parseHex(hex) {
  if (hex.startsWith('rgb')) {
    const m = hex.match(/\d+/g);
    return [parseInt(m[0]), parseInt(m[1]), parseInt(m[2])];
  }
  const h = hex.replace('#', '');
  return [parseInt(h.substring(0,2),16), parseInt(h.substring(2,4),16), parseInt(h.substring(4,6),16)];
}

function drawNodes() {
  for (const n of tree.nodes) {
    const p = worldToScreen(n.x, n.y);
    const r = n.size * view.scale;
    const isHover = hoveredId === n.id;
    const color = n.color || '#f5c542';

    ctx.shadowColor = color;
    ctx.shadowBlur = isHover ? 25 : 12;
    const grad = ctx.createRadialGradient(p.x, p.y - r*0.3, 0, p.x, p.y, r);
    grad.addColorStop(0, lighten(color, 0.3));
    grad.addColorStop(0.6, color);
    grad.addColorStop(1, darken(color, 0.4));
    ctx.fillStyle = grad;
    drawShape(p.x, p.y, r, n.type); ctx.fill();
    ctx.shadowBlur = 0;

    ctx.strokeStyle = isHover ? '#fff8e0' : darken(color, 0.5);
    ctx.lineWidth = isHover ? 2.5 : 1.5;
    drawShape(p.x, p.y, r, n.type); ctx.stroke();

    if (n.size >= 60) {
      ctx.strokeStyle = `rgba(245,197,66,${isHover ? 0.5 : 0.25})`;
      ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
      drawShape(p.x, p.y, r + 8, n.type); ctx.stroke();
      ctx.setLineDash([]);
    }

    if (n.iconImage) {
      _ensureImage(n);
      const img = _imgCache.get(n.id);
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.save();
        drawShape(p.x, p.y, r, n.type); ctx.clip();
        const scale = Math.max((r*2)/img.naturalWidth, (r*2)/img.naturalHeight);
        const sw = img.naturalWidth*scale, sh = img.naturalHeight*scale;
        ctx.drawImage(img, p.x-sw/2, p.y-sh/2, sw, sh);
        const fade = (n.iconFade || 0) / 100;
        if (fade > 0) {
          const [rc,gc,bc] = parseHex(color);
          if (fade >= 1) {
            ctx.fillStyle = color;
          } else {
            const innerR = r*(1-fade), innerR0 = Math.max(0, innerR-0.5);
            const ovl = ctx.createRadialGradient(p.x,p.y,innerR0,p.x,p.y,r);
            ovl.addColorStop(0, `rgba(${rc},${gc},${bc},0)`);
            ovl.addColorStop(0.01, `rgba(${rc},${gc},${bc},1)`);
            ovl.addColorStop(1, `rgba(${rc},${gc},${bc},1)`);
            ctx.fillStyle = ovl;
          }
          ctx.fillRect(p.x-r-1, p.y-r-1, r*2+2, r*2+2);
        }
        ctx.restore();
      }
    } else if (n.title) {
      ctx.fillStyle = '#000000ff';
      ctx.font = `${Math.floor(r*0.32)}px 'Cormorant Garamond', serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(n.title, p.x, p.y + r*0.05, Math.floor(r*1.8));
    }

    if (n.url) {
      const bs = Math.max(10, Math.floor(r*0.38));
      ctx.font = `${bs}px serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 3;
      ctx.fillText('🔗', p.x + r*0.6, p.y + r*0.6);
      ctx.shadowBlur = 0;
    }

    if (n.icon && view.scale > 0.4) {
      ctx.fillStyle = '#e8dfc9';
      ctx.font = `${n.iconBold ? 'bold ' : ''}${Math.max(11, Math.floor(13*Math.min(view.scale,1.2)))}px 'Cinzel', serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 4;
      ctx.fillText(n.icon, p.x, p.y + r + 8);
      ctx.shadowBlur = 0;
    }
  }
}

// === INTERACCIÓN ===
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 2) return;
  const node = findNodeAt(e.clientX, e.clientY);
  if (node) {
    draggingNode = { id: node.id, moved: false };
  } else {
    if (openPopupId) hidePopup();
    panning = true;
    panStart = { x: e.clientX - view.x, y: e.clientY - view.y };
    canvas.classList.add('grabbing');
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (draggingNode) { draggingNode.moved = true; return; }
  if (panning) {
    view.x = e.clientX - panStart.x;
    view.y = e.clientY - panStart.y;
    render(); return;
  }
  const hit = findNodeAt(e.clientX, e.clientY);
  const newHover = hit ? hit.id : null;
  if (newHover !== hoveredId) {
    hoveredId = newHover;
    canvas.style.cursor = hit ? 'pointer' : 'grab';
    render();
  }
});

canvas.addEventListener('mouseup', () => {
  if (draggingNode && !draggingNode.moved) {
    const node = getNode(draggingNode.id);
    if (node) {
      if (isLinkNode(node)) {
        if (node.url) window.open(node.url, '_blank', 'noopener,noreferrer');
      } else if (node.content) {
        if (openPopupId === node.id) hidePopup();
        else showPopup(node);
      }
    }
  }
  draggingNode = null;
  panning = false;
  canvas.classList.remove('grabbing');
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  const newScale = Math.min(3, Math.max(0.2, view.scale * factor));
  const mx = e.clientX - canvas.width/2 - view.x;
  const my = e.clientY - canvas.height/2 - view.y;
  view.x -= mx * (newScale/view.scale - 1);
  view.y -= my * (newScale/view.scale - 1);
  view.scale = newScale;
  document.getElementById('zoom-level').textContent = Math.round(view.scale*100) + '%';
  render();
}, { passive: false });

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function renderContent(text) {
  const e = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return e
    .replace(/^### (.+)$/gm,'<h3 style="margin:.3em 0 .1em;font-size:1em;font-weight:600">$1</h3>')
    .replace(/^## (.+)$/gm,'<h2 style="margin:.4em 0 .15em;font-size:1.1em;font-weight:600">$1</h2>')
    .replace(/^# (.+)$/gm,'<h1 style="margin:.4em 0 .2em;font-size:1.25em;font-weight:700">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,'<em>$1</em>')
    .replace(/`(.+?)`/g,'<code style="background:rgba(255,255,255,.12);padding:.1em .3em;border-radius:3px;font-family:monospace;font-size:.88em">$1</code>')
    .replace(/^- (.+)$/gm,'• $1')
    .replace(/\n/g,'<br>');
}

function showPopup(node) {
  const popup = document.getElementById('node-popup');
  const color = node.color || '#f5c542';
  popup.style.borderColor = color;
  popup.style.boxShadow = '0 4px 32px rgba(0,0,0,.8), 0 0 12px ' + color + '33';

  const titleEl = popup.querySelector('.popup-title');
  const bodyEl  = popup.querySelector('.popup-body');
  titleEl.textContent = node.title || '';
  titleEl.style.color = color;
  bodyEl.innerHTML = renderContent(node.content);

  popup.querySelectorAll('.popup-img').forEach(el => el.remove());
  (node.contentImages || []).forEach(src => {
    const img = document.createElement('img');
    img.src = src;
    img.className = 'popup-img';
    img.style.cssText = 'display:block;width:100%;height:auto;margin-top:.8em;border-radius:3px;';
    popup.appendChild(img);
  });

  const popupW = Math.round(Math.min(Math.max(node.size * 3.5, 220), 500));
  popup.style.width = popupW + 'px';
  popup.style.display = 'block';

  const p  = worldToScreen(node.x, node.y);
  const r  = node.size * view.scale;
  const pw = popup.offsetWidth;
  const ph = popup.offsetHeight;
  const gap = 14;
  const margin = 10;

  let left = p.x - pw / 2;
  let top  = p.y - r - ph - gap;
  if (top < margin) top = p.y + r + gap;

  left = Math.max(margin, Math.min(window.innerWidth  - pw - margin, left));
  top  = Math.max(margin, Math.min(window.innerHeight - ph - margin, top));

  popup.style.left = left + 'px';
  popup.style.top  = top  + 'px';
  openPopupId = node.id;
}

function hidePopup() {
  document.getElementById('node-popup').style.display = 'none';
  openPopupId = null;
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePopup(); });

document.getElementById('btn-center').addEventListener('click', () => {
  view.x = 0; view.y = 0; view.scale = 1;
  document.getElementById('zoom-level').textContent = '100%';
  render();
});

resizeCanvas();
})();
"""


def _build_export_html(tree_json: str, css: str, title: str = 'Grimorio') -> str:
    safe_tree = tree_json.replace('</script>', r'<\/script>')
    viewer_js = _VIEWER_JS.replace('__TREE__', safe_tree)
    return f"""<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;800&family=Cormorant+Garamond:ital,wght@0,400;0,500;1,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
{css}
</style>
</head>
<body>
<div class="vignette"></div>
<div class="grain"></div>
<header class="topbar">
  <div class="brand">
    <span class="brand-mark">✦</span>
    <h1>{title}</h1>
  </div>
  <div class="topbar-actions">
    <button id="btn-center" class="icon-btn" title="Centrar vista">◎</button>
  </div>
</header>
<canvas id="tree-canvas"></canvas>
<div class="zoom-indicator"><span id="zoom-level">100%</span></div>
<div id="toast" class="toast hidden"></div>
<div id="node-popup" style="display:none;position:fixed;z-index:100;box-sizing:border-box;max-width:clamp(220px,32vw,440px);max-height:60vh;overflow-y:auto;background:rgba(13,11,8,.96);border:1.5px solid #f5c542;border-radius:6px;padding:1.2em 1.5em;font-family:'Cormorant Garamond',serif;font-size:1rem;line-height:1.6;color:#e8dfc9;pointer-events:none;">
  <div class="popup-title" style="font-weight:600;font-size:1.1em;margin-bottom:.5em;letter-spacing:.03em"></div>
  <div class="popup-body" style="font-size:.97em"></div>
</div>
<script>{viewer_js}</script>
</body>
</html>"""


@app.route("/api/export-html")
def export_html():
    from flask import Response
    tree = load_tree()

    # Convierte imágenes de fichero a base64 para autocontención
    for node in tree.get('nodes', []):
        img_field = node.get('iconImage', '')
        if img_field and not img_field.startswith('data:'):
            img_path = os.path.join(IMAGES_DIR, secure_filename(img_field))
            if os.path.exists(img_path):
                mime = mimetypes.guess_type(img_path)[0] or 'image/webp'
                with open(img_path, 'rb') as f:
                    b64 = base64.b64encode(f.read()).decode()
                node['iconImage'] = f'data:{mime};base64,{b64}'
        for i, ci in enumerate(node.get('contentImages', [])):
            if ci and not ci.startswith('data:'):
                ci_path = os.path.join(IMAGES_DIR, secure_filename(ci))
                if os.path.exists(ci_path):
                    mime = mimetypes.guess_type(ci_path)[0] or 'image/webp'
                    with open(ci_path, 'rb') as f:
                        b64 = base64.b64encode(f.read()).decode()
                    node['contentImages'][i] = f'data:{mime};base64,{b64}'

    css_path = os.path.join(os.path.dirname(__file__), 'static', 'style.css')
    with open(css_path, 'r', encoding='utf-8') as f:
        css = f.read()

    raw_title = tree.get('title', 'Grimorio')
    safe_name = re.sub(r'[^\w\-]', '_', raw_title).strip('_').lower() or 'grimorio'
    html = _build_export_html(json.dumps(tree), css, title=raw_title)
    filename = f"{safe_name}_{datetime.now().strftime('%Y%m%d')}.html"
    return Response(
        html,
        mimetype='text/html',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'}
    )


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/tree", methods=["GET"])
def get_tree():
    return jsonify(load_tree())


@app.route("/api/tree", methods=["POST"])
def update_tree():
    data = request.get_json()
    if not data or "nodes" not in data or "connections" not in data:
        return jsonify({"error": "Datos inválidos"}), 400
    save_tree(data)
    return jsonify({"status": "ok"})


@app.route("/images/<path:filename>")
def serve_image(filename: str):
    return send_from_directory(IMAGES_DIR, filename)


@app.route("/api/upload-image", methods=["POST"])
def upload_image():
    if 'file' not in request.files:
        return jsonify({"error": "No file"}), 400
    file = request.files['file']
    if not file.filename or not _allowed_ext(file.filename):
        return jsonify({"error": "Tipo de archivo no permitido"}), 400
    try:
        img = Image.open(io.BytesIO(file.read()))
        if img.mode not in ('RGB', 'RGBA'):
            img = img.convert('RGBA')
        filename = f"{uuid.uuid4().hex}.webp"
        img.save(os.path.join(IMAGES_DIR, filename), 'WEBP', quality=82, method=4)
        return jsonify({"filename": filename})
    except Exception as exc:
        logger.error("Error convirtiendo imagen a WebP: %s", exc)
        return jsonify({"error": f"Error procesando imagen: {exc}"}), 400


@app.route("/api/delete-image/<filename>", methods=["DELETE"])
def delete_image(filename: str):
    safe = secure_filename(filename)
    path = os.path.join(IMAGES_DIR, safe)
    if os.path.exists(path):
        os.remove(path)
    return jsonify({"status": "ok"})


@app.route("/api/logs", methods=["GET"])
def get_logs():
    """Devuelve los últimos N logs en memoria (máx. LOG_CAPACITY)."""
    n = min(int(request.args.get("n", LOG_CAPACITY)), LOG_CAPACITY)
    with _log_lock:
        entries = list(_log_buffer)[-n:]
    return jsonify({"count": len(entries), "capacity": LOG_CAPACITY, "logs": entries})


def open_browser():
    webbrowser.open_new("http://localhost:5001")


if __name__ == "__main__":
    host = "127.0.0.1"
    port = int(os.environ.get("PORT", 5001))

    _push_log(
        level="STARTUP",
        message=f"Árbol de Habilidades arrancando en {host}:{port}",
        host=host,
        port=port,
        data_file=DATA_FILE,
        python_pid=os.getpid(),
    )
    logger.info("Árbol de Habilidades arrancando en %s:%s", host, port)

    Timer(1.0, open_browser).start()

    print(f"\n🌳 Árbol de Habilidades iniciado")
    print(f"   → http://localhost:{port}")
    print(f"   Logs en tiempo real: GET /api/logs")
    print("   Presiona Ctrl+C para cerrar\n")
    app.run(host=host, port=port, debug=False)
