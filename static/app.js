/* ==========================================================
   GRIMORIO — Lógica del árbol de conocimiento
   Canvas 2D interactivo con pan, zoom, drag, formas y conexiones.
   ========================================================== */

(() => {
'use strict';

// ===================== ESTADO =====================
const canvas = document.getElementById('tree-canvas');
const ctx = canvas.getContext('2d');

let tree = { nodes: [], connections: [] };
let view = { x: 0, y: 0, scale: 1 };      // transformación de vista (pan/zoom)
let hoveredId = null;
let selectedId = null;
let draggingNode = null;                   // id del nodo que se arrastra
let panning = false;
let panStart = null;
let linkingFrom = null;                    // para modo conectar
let lastMouse = { x: 0, y: 0 };            // en coordenadas de pantalla
let saveTimer = null;
let activeBg = 'oscuro';

const BACKGROUNDS = {
  oscuro:    { fill: '#0d0b08', grid: 'rgba(245,197,66,0.04)',   subtitle: '#e8dfc9', swatch: '#1c1a16' },
  abismo:    { fill: '#5c670eff', grid: 'rgba(100,150,255,0.05)',  subtitle: '#b0c8f0', swatch: '#abd30aff' },
  bosque:    { fill: '#0e360aff', grid: 'rgba(80,180,100,0.05)',   subtitle: '#b0e0b8', swatch: '#00e900ff' },
  sangre:    { fill: '#451010ff', grid: 'rgba(0, 0, 0, 0.06)',    subtitle: '#ffffffff', swatch: '#ff0000ff' },
  pergamino: { fill: '#f2ebda', grid: 'rgba(100,70,30,0.08)',    subtitle: '#3a2510', swatch: '#e8dfc9' },
  ceniza:    { fill: '#0e343dff', grid: 'rgba(42, 220, 14, 0.06)',  subtitle: '#c8ccd8', swatch: '#0053f9ff' },
};

function applyBackground(id) {
  activeBg = BACKGROUNDS[id] ? id : 'oscuro';
  tree.background = activeBg;
  document.querySelectorAll('.bg-swatch-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.bg === activeBg);
  });
  render();
  scheduleSave();
}

// ===================== UTILIDADES =====================
function uid() {
  return 'n_' + Math.random().toString(36).slice(2, 10);
}

function worldToScreen(wx, wy) {
  return {
    x: wx * view.scale + view.x + canvas.width / 2,
    y: wy * view.scale + view.y + canvas.height / 2
  };
}

function screenToWorld(sx, sy) {
  return {
    x: (sx - canvas.width / 2 - view.x) / view.scale,
    y: (sy - canvas.height / 2 - view.y) / view.scale
  };
}

function findNodeAt(sx, sy) {
  // Recorre en orden inverso (los últimos están "encima")
  for (let i = tree.nodes.length - 1; i >= 0; i--) {
    const n = tree.nodes[i];
    const p = worldToScreen(n.x, n.y);
    const r = n.size * view.scale;
    const dx = sx - p.x, dy = sy - p.y;
    if (Math.sqrt(dx * dx + dy * dy) <= r) return n;
  }
  return null;
}

function getNode(id) {
  return tree.nodes.find(n => n.id === id);
}

// ===================== ADJACENCY LIST =====================
// nodeId → Set of connected nodeIds (bidirectional)
const _adj = new Map();

function buildAdjacency() {
  _adj.clear();
  for (const n of tree.nodes) _adj.set(n.id, new Set());
  for (const c of tree.connections) {
    if (!_adj.has(c.from)) _adj.set(c.from, new Set());
    if (!_adj.has(c.to))   _adj.set(c.to,   new Set());
    _adj.get(c.from).add(c.to);
    _adj.get(c.to).add(c.from);
  }
}

function adjAdd(fromId, toId) {
  if (!_adj.has(fromId)) _adj.set(fromId, new Set());
  if (!_adj.has(toId))   _adj.set(toId,   new Set());
  _adj.get(fromId).add(toId);
  _adj.get(toId).add(fromId);
}

function adjRemove(id) {
  const neighbors = _adj.get(id);
  if (neighbors) neighbors.forEach(nid => _adj.get(nid)?.delete(id));
  _adj.delete(id);
}

function getNeighbors(id) {
  return Array.from(_adj.get(id) || []).map(getNode).filter(Boolean);
}

function isLinkNode(n) {
  return n.kind === 'link' || (n.kind === undefined && !!n.url);
}

function toast(msg, duration = 2000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), duration);
}

// ===================== IMAGE CACHE =====================
const _imgCache = new Map(); // nodeId → HTMLImageElement

// ===================== COLOR CACHE =====================
const _colorCache = new Map(); // hex string → {light30, dark40, dark50, rgb}

function getColorVariants(color) {
  if (_colorCache.has(color)) return _colorCache.get(color);
  const rgb = parseHex(color);
  const v = {
    light30: lighten(color, 0.3),
    dark40:  darken(color, 0.4),
    dark50:  darken(color, 0.5),
    rgb,
  };
  _colorCache.set(color, v);
  return v;
}

// ===================== FONT CACHE =====================
const _fontCache = new Map(); // key → font string

function getFont(size, bold, family) {
  const key = `${bold ? 'b' : ''}${size}${family}`;
  if (_fontCache.has(key)) return _fontCache.get(key);
  const f = `${bold ? 'bold ' : ''}${size}px '${family}', serif`;
  _fontCache.set(key, f);
  return f;
}

function _ensureImage(node) {
  if (!node.iconImage) { _imgCache.delete(node.id); return; }
  const src = node.iconImage.startsWith('data:') ? node.iconImage : `/images/${node.iconImage}`;
  const cached = _imgCache.get(node.id);
  if (cached && cached._src === src) return; // ya cargada
  const img = new Image();
  img._src = src;
  img.onload = () => render();
  img.src = src;
  _imgCache.set(node.id, img);
}

// Redimensiona un File a máx 512px y lo sube al servidor; devuelve filename via cb
function _uploadImage(file, cb) {
  const MAX = 512;
  const reader = new FileReader();
  reader.onerror = () => toast('Error leyendo el archivo', 3000);
  reader.onload = (ev) => {
    const tmp = new Image();
    tmp.onerror = () => toast('Formato de imagen no soportado', 3000);
    tmp.onload = () => {
      let w = tmp.naturalWidth, h = tmp.naturalHeight;
      if (w > MAX || h > MAX) {
        const ratio = Math.min(MAX / w, MAX / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(tmp, 0, 0, w, h);
      cv.toBlob((blob) => {
        const form = new FormData();
        form.append('file', blob, 'image.png');
        fetch('/api/upload-image', { method: 'POST', body: form })
          .then(r => r.json())
          .then(data => {
            if (data.filename) cb(data.filename);
            else toast('Error subiendo imagen', 3000);
          })
          .catch(() => toast('Error de red al subir imagen', 3000));
      }, 'image/png');
    };
    tmp.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

// ===================== CANVAS SETUP =====================
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

// ===================== RENDER =====================
let _rafPending = false;

function render() {
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(_renderFrame);
}

function _renderFrame() {
  _rafPending = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  drawBackgroundGrid();
  drawConnections();

  // Línea temporal en modo conectar
  if (linkingFrom) {
    const from = getNode(linkingFrom);
    if (from) {
      const a = worldToScreen(from.x, from.y);
      ctx.strokeStyle = 'rgba(245, 197, 66, 0.7)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(lastMouse.x, lastMouse.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  drawNodes();
}

function drawBackgroundGrid() {
  const bg = BACKGROUNDS[activeBg] || BACKGROUNDS.oscuro;

  // Fill canvas with theme background color
  ctx.fillStyle = bg.fill;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Grid sutil que se mueve con el pan
  const gridSize = 80 * view.scale;
  if (gridSize < 20) return;

  ctx.strokeStyle = bg.grid;
  ctx.lineWidth = 1;

  const offsetX = (view.x + canvas.width / 2) % gridSize;
  const offsetY = (view.y + canvas.height / 2) % gridSize;

  ctx.beginPath();
  for (let x = offsetX; x < canvas.width; x += gridSize) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
  }
  for (let y = offsetY; y < canvas.height; y += gridSize) {
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
  }
  ctx.stroke();
}

function drawConnections() {
  const W = canvas.width, H = canvas.height;
  for (const c of tree.connections) {
    const a = getNode(c.from);
    const b = getNode(c.to);
    if (!a || !b) continue;

    const pa = worldToScreen(a.x, a.y);
    const pb = worldToScreen(b.x, b.y);

    // Viewport cull — skip if both endpoints are off-screen
    const aOff = pa.x < 0 || pa.x > W || pa.y < 0 || pa.y > H;
    const bOff = pb.x < 0 || pb.x > W || pb.y < 0 || pb.y > H;
    if (aOff && bOff) continue;

    const ca = a.color || '#f5c542', cb = b.color || '#f5c542';
    const grad = ctx.createLinearGradient(pa.x, pa.y, pb.x, pb.y);
    grad.addColorStop(0, ca);
    grad.addColorStop(1, cb);
    ctx.strokeStyle = grad;

    // Halo exterior
    ctx.globalAlpha = 0.15;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();

    // Línea principal
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();

    ctx.globalAlpha = 1;
  }
}

function drawNodes() {
  const W = canvas.width, H = canvas.height;
  for (const n of tree.nodes) {
    const p = worldToScreen(n.x, n.y);
    const r = n.size * view.scale;

    // Viewport cull
    if (p.x + r < 0 || p.x - r > W || p.y + r < 0 || p.y - r > H) continue;

    const isHover = hoveredId === n.id;
    const isSelected = selectedId === n.id;
    const color = n.color || '#f5c542';
    const cv = getColorVariants(color);

    // Glow
    ctx.shadowColor = color;
    ctx.shadowBlur = isHover || isSelected ? 25 : 12;

    // Relleno con gradiente radial
    const grad = ctx.createRadialGradient(p.x, p.y - r * 0.3, 0, p.x, p.y, r);
    grad.addColorStop(0, cv.light30);
    grad.addColorStop(0.6, color);
    grad.addColorStop(1, cv.dark40);
    ctx.fillStyle = grad;
    drawShape(p.x, p.y, r, n.type);
    ctx.fill();

    ctx.shadowBlur = 0;

    // Borde
    ctx.strokeStyle = (isHover || isSelected) ? '#fff8e0' : (n.borderColor || cv.dark50);
    ctx.lineWidth = (isHover || isSelected) ? Math.max(2.5, n.borderWidth || 1.5) : (n.borderWidth || 1.5);
    drawShape(p.x, p.y, r, n.type);
    ctx.stroke();

    // Anillo exterior decorativo para nodos grandes
    if (n.size >= 60) {
      ctx.strokeStyle = `rgba(245, 197, 66, ${isHover ? 0.5 : 0.25})`;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      drawShape(p.x, p.y, r + 8, n.type);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Imagen (si tiene) o título dentro del nodo
    if (n.iconImage) {
      _ensureImage(n);
      const img = _imgCache.get(n.id);
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.save();
        drawShape(p.x, p.y, r, n.type);
        ctx.clip();
        const scale = Math.max((r * 2) / img.naturalWidth, (r * 2) / img.naturalHeight);
        const sw = img.naturalWidth * scale, sh = img.naturalHeight * scale;
        ctx.drawImage(img, p.x - sw / 2, p.y - sh / 2, sw, sh);
        const fade = (n.iconFade || 0) / 100;
        if (fade > 0) {
          const [rc, gc, bc] = cv.rgb;
          if (fade >= 1) {
            ctx.fillStyle = color;
          } else {
            const innerR = r * (1 - fade);
            const innerR0 = Math.max(0, innerR - 0.5);
            const ovl = ctx.createRadialGradient(p.x, p.y, innerR0, p.x, p.y, r);
            ovl.addColorStop(0, `rgba(${rc},${gc},${bc},0)`);
            ovl.addColorStop(0.01, `rgba(${rc},${gc},${bc},1)`);
            ovl.addColorStop(1, `rgba(${rc},${gc},${bc},1)`);
            ctx.fillStyle = ovl;
          }
          ctx.fillRect(p.x - r - 1, p.y - r - 1, r * 2 + 2, r * 2 + 2);
        }
        ctx.restore();
      }
    } else if (n.title) {
      ctx.fillStyle = n.titleColor || '#000000';
      const titleFont = n.titleFont || 'Cormorant Garamond';
      ctx.font = getFont(Math.floor(r * 0.32), false, titleFont);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(n.title, p.x, p.y + r * 0.05, Math.floor(r * 1.8));
    }

    // Indicador de enlace
    if (n.url) {
      const badgeSize = Math.max(10, Math.floor(r * 0.38));
      ctx.font = `${badgeSize}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = 3;
      ctx.fillText('🔗', p.x + r * 0.6, p.y + r * 0.6);
      ctx.shadowBlur = 0;
    }

    // Subtítulo debajo del nodo
    if (n.icon && view.scale > 0.4) {
      ctx.fillStyle = (BACKGROUNDS[activeBg] || BACKGROUNDS.oscuro).subtitle;
      const iconFont = n.iconFont || 'Cinzel';
      const iconSize = n.iconSize || 13;
      ctx.font = getFont(Math.max(iconSize, Math.floor(iconSize * Math.min(view.scale, 1.2))), n.iconBold, iconFont);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 4;
      ctx.fillText(n.icon, p.x, p.y + r + 8);
      ctx.shadowBlur = 0;
    }
  }
}

// Pre-computed unit points for trig-heavy shapes (cos/sin at draw time eliminated)
const _HEX_PTS = Array.from({length: 6}, (_, i) => {
  const a = (Math.PI / 3) * i - Math.PI / 6;
  return [Math.cos(a), Math.sin(a)];
});
const _STAR_PTS = Array.from({length: 10}, (_, i) => {
  const a = (Math.PI / 5) * i - Math.PI / 2;
  const ri = i % 2 === 0 ? 1 : 0.42;
  return [ri * Math.cos(a), ri * Math.sin(a)];
});

function drawShape(x, y, r, type) {
  ctx.beginPath();
  if (type === 'circle') {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  } else if (type === 'square') {
    const s = r * 1.7;
    ctx.rect(x - s / 2, y - s / 2, s, s);
  } else if (type === 'triangle') {
    const h = r * 1.15;
    ctx.moveTo(x, y - h);
    ctx.lineTo(x + h * 0.95, y + h * 0.7);
    ctx.lineTo(x - h * 0.95, y + h * 0.7);
    ctx.closePath();
  } else if (type === 'diamond') {
    ctx.moveTo(x, y - r * 1.3);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r * 1.3);
    ctx.lineTo(x - r, y);
    ctx.closePath();
  } else if (type === 'hexagon') {
    ctx.moveTo(x + r * _HEX_PTS[0][0], y + r * _HEX_PTS[0][1]);
    for (let i = 1; i < 6; i++) ctx.lineTo(x + r * _HEX_PTS[i][0], y + r * _HEX_PTS[i][1]);
    ctx.closePath();
  } else if (type === 'star') {
    ctx.moveTo(x + r * _STAR_PTS[0][0], y + r * _STAR_PTS[0][1]);
    for (let i = 1; i < 10; i++) ctx.lineTo(x + r * _STAR_PTS[i][0], y + r * _STAR_PTS[i][1]);
    ctx.closePath();
  } else {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}

function lighten(hex, amount) {
  return mixColor(hex, '#ffffff', amount);
}

function darken(hex, amount) {
  return mixColor(hex, '#000000', amount);
}

function mixColor(a, b, t) {
  const pa = parseHex(a), pb = parseHex(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

function parseHex(hex) {
  if (hex.startsWith('rgb')) {
    const m = hex.match(/\d+/g);
    return [parseInt(m[0]), parseInt(m[1]), parseInt(m[2])];
  }
  const h = hex.replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16)
  ];
}

// ===================== INTERACCIÓN =====================
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 2) return; // click derecho se maneja en contextmenu
  const node = findNodeAt(e.clientX, e.clientY);

  if (linkingFrom) {
    if (node && node.id !== linkingFrom) {
      createConnection(linkingFrom, node.id);
      toast(`Conectado: ${getNode(linkingFrom).title} → ${node.title}`);
    }
    stopLinking();
    return;
  }

  if (node) {
    draggingNode = { id: node.id, startX: e.clientX, startY: e.clientY, moved: false };
    selectedId = node.id;
  } else {
    panning = true;
    panStart = { x: e.clientX - view.x, y: e.clientY - view.y };
    canvas.classList.add('grabbing');
    hideContextMenu();
  }
  render();
});

canvas.addEventListener('mousemove', (e) => {
  lastMouse.x = e.clientX;
  lastMouse.y = e.clientY;

  if (draggingNode) {
    const node = getNode(draggingNode.id);
    if (node) {
      const totalDx = e.clientX - draggingNode.startX;
      const totalDy = e.clientY - draggingNode.startY;
      if (draggingNode.moved || Math.sqrt(totalDx * totalDx + totalDy * totalDy) > 5) {
        const dx = e.movementX / view.scale;
        const dy = e.movementY / view.scale;
        node.x += dx;
        node.y += dy;
        draggingNode.moved = true;
        scheduleSave();
        render();
      }
    }
    return;
  }

  if (panning) {
    view.x = e.clientX - panStart.x;
    view.y = e.clientY - panStart.y;
    render();
    return;
  }

  const hit = findNodeAt(e.clientX, e.clientY);
  const newHover = hit ? hit.id : null;
  if (newHover !== hoveredId) {
    hoveredId = newHover;
    canvas.style.cursor = hit ? 'pointer' : (linkingFrom ? 'crosshair' : 'grab');
    render();
  }

  if (linkingFrom) render();
});

canvas.addEventListener('mouseup', (e) => {
  if (draggingNode && !draggingNode.moved) {
    const node = getNode(draggingNode.id);
    if (node && isLinkNode(node) && node.url) {
      window.open(node.url, '_blank', 'noopener,noreferrer');
    }
    if (node && !panel.classList.contains('hidden')) {
      openEditPanel(node.id);
    }
  }
  draggingNode = null;
  panning = false;
  canvas.classList.remove('grabbing');
});

canvas.addEventListener('dblclick', (e) => {
  const node = findNodeAt(e.clientX, e.clientY);
  if (node) openEditPanel(node.id);
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  const newScale = Math.min(3, Math.max(0.2, view.scale * factor));

  // zoom hacia el cursor
  const mx = e.clientX - canvas.width / 2 - view.x;
  const my = e.clientY - canvas.height / 2 - view.y;
  view.x -= mx * (newScale / view.scale - 1);
  view.y -= my * (newScale / view.scale - 1);
  view.scale = newScale;

  document.getElementById('zoom-level').textContent = Math.round(view.scale * 100) + '%';
  render();
}, { passive: false });

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const node = findNodeAt(e.clientX, e.clientY);
  if (node) {
    selectedId = node.id;
    showContextMenu(e.clientX, e.clientY, node);
    render();
  } else {
    hideContextMenu();
  }
});

// Cierra menú/panel al hacer clic fuera
document.addEventListener('mousedown', (e) => {
  const menu = document.getElementById('context-menu');
  if (!menu.classList.contains('hidden') && !menu.contains(e.target)) {
    hideContextMenu();
  }
});

// Escape cancela acciones
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    stopLinking();
    hideContextMenu();
    closeEditPanel();
    document.getElementById('help-modal').classList.add('hidden');
  }
});

// ===================== MENÚ CONTEXTUAL =====================
function showContextMenu(x, y, node) {
  const menu = document.getElementById('context-menu');
  document.getElementById('ctx-title-name').textContent = node.title;

  // Evita que se salga de la pantalla
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  const posX = Math.min(x, window.innerWidth - rect.width - 10);
  const posY = Math.min(y, window.innerHeight - rect.height - 10);
  menu.style.left = posX + 'px';
  menu.style.top = posY + 'px';

  // Deshabilita "Eliminar" para el root
  const deleteBtn = menu.querySelector('[data-action="delete"]');
  if (node.id === 'root') {
    deleteBtn.style.opacity = '0.3';
    deleteBtn.style.pointerEvents = 'none';
  } else {
    deleteBtn.style.opacity = '1';
    deleteBtn.style.pointerEvents = 'auto';
  }
}

function hideContextMenu() {
  document.getElementById('context-menu').classList.add('hidden');
}

document.getElementById('context-menu').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const action = btn.dataset.action;
  const node = getNode(selectedId);
  if (!node) return;

  if (action === 'add-circle') addConnectedNode(node, 'circle');
  else if (action === 'add-square') addConnectedNode(node, 'square');
  else if (action === 'add-triangle') addConnectedNode(node, 'triangle');
  else if (action === 'add-link') addLinkNode(node);
  else if (action === 'edit') openEditPanel(node.id);
  else if (action === 'connect') startLinking(node.id);
  else if (action === 'delete') deleteNode(node.id);

  hideContextMenu();
});

// ===================== ACCIONES =====================
function addConnectedNode(parent, type) {
  const children = getNeighbors(parent.id);
  const usedAngles = children.map(ch => Math.atan2(ch.y - parent.y, ch.x - parent.x));
  const angle = findFreeAngle(usedAngles);
  const distance = parent.size + 120;

  const newNode = {
    id: uid(),
    type: type,
    kind: 'node',
    size: 50,
    x: parent.x + Math.cos(angle) * distance,
    y: parent.y + Math.sin(angle) * distance,
    title: 'Nuevo nodo',
    icon: '✦',
    content: '',
    color: parent.color || '#f5c542'
  };

  tree.nodes.push(newNode);
  tree.connections.push({ from: parent.id, to: newNode.id });
  adjAdd(parent.id, newNode.id);
  _adj.set(newNode.id, new Set([parent.id]));
  selectedId = newNode.id;
  scheduleSave();
  render();
  openEditPanel(newNode.id);
}

function addLinkNode(parent) {
  const children = getNeighbors(parent.id);
  const usedAngles = children.map(ch => Math.atan2(ch.y - parent.y, ch.x - parent.x));
  const angle = findFreeAngle(usedAngles);
  const distance = parent.size + 120;

  const newNode = {
    id: uid(),
    type: 'circle',
    kind: 'link',
    size: 50,
    x: parent.x + Math.cos(angle) * distance,
    y: parent.y + Math.sin(angle) * distance,
    title: 'Enlace',
    icon: '🔗',
    url: '',
    color: parent.color || '#f5c542'
  };

  tree.nodes.push(newNode);
  tree.connections.push({ from: parent.id, to: newNode.id });
  adjAdd(parent.id, newNode.id);
  _adj.set(newNode.id, new Set([parent.id]));
  selectedId = newNode.id;
  scheduleSave();
  render();
  openEditPanel(newNode.id);
}

function findFreeAngle(usedAngles) {
  if (usedAngles.length === 0) return -Math.PI / 2; // arriba
  // Busca el mayor hueco angular
  const sorted = [...usedAngles].sort((a, b) => a - b);
  let bestGap = 0;
  let bestAngle = -Math.PI / 2;
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[(i + 1) % sorted.length];
    let gap = b - a;
    if (gap <= 0) gap += Math.PI * 2;
    if (gap > bestGap) {
      bestGap = gap;
      bestAngle = a + gap / 2;
    }
  }
  return bestAngle;
}

function createConnection(fromId, toId) {
  // Evita duplicados
  const exists = tree.connections.some(c =>
    (c.from === fromId && c.to === toId) || (c.from === toId && c.to === fromId)
  );
  if (exists) {
    toast('Ya están conectados');
    return;
  }
  tree.connections.push({ from: fromId, to: toId });
  adjAdd(fromId, toId);
  scheduleSave();
  render();
}

function deleteNode(id) {
  if (id === 'root') return;
  if (!confirm(`¿Eliminar "${getNode(id).title}" y sus conexiones?`)) return;
  tree.nodes = tree.nodes.filter(n => n.id !== id);
  tree.connections = tree.connections.filter(c => c.from !== id && c.to !== id);
  adjRemove(id);
  if (selectedId === id) selectedId = null;
  scheduleSave();
  render();
  toast('Nodo eliminado');
}

function startLinking(fromId) {
  linkingFrom = fromId;
  canvas.classList.add('linking');
  // banner informativo
  let banner = document.getElementById('linking-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'linking-banner';
    banner.className = 'linking-banner';
    banner.textContent = 'Haz clic en otro nodo para conectar (Esc para cancelar)';
    document.body.appendChild(banner);
  }
}

function stopLinking() {
  linkingFrom = null;
  canvas.classList.remove('linking');
  const banner = document.getElementById('linking-banner');
  if (banner) banner.remove();
  render();
}

// ===================== PANEL DE EDICIÓN =====================
const panel = document.getElementById('edit-panel');

function openEditPanel(id) {
  const node = getNode(id);
  if (!node) return;
  selectedId = id;
  panel.dataset.nodeId = id;

  document.getElementById('edit-title').value = node.title || '';
  document.getElementById('edit-url').value = node.url || '';
  document.getElementById('edit-icon').value = node.icon || '';
  document.getElementById('edit-icon-bold').checked = node.iconBold || false;
  document.getElementById('edit-type').value = node.type || 'circle';

  const preview = document.getElementById('icon-preview');
  const _imgSrc = node.iconImage
    ? (node.iconImage.startsWith('data:') ? node.iconImage : `/images/${node.iconImage}`)
    : '';
  preview.style.backgroundImage = _imgSrc ? `url(${_imgSrc})` : '';
  preview.classList.toggle('has-image', !!node.iconImage);
  document.getElementById('icon-fade').value = String(node.iconFade || 0);
  document.getElementById('icon-fade-display').textContent = node.iconFade || 0;
  document.getElementById('edit-size').value = String(node.size || 50);
  document.getElementById('size-value-display').textContent = node.size || 50;
  document.getElementById('edit-content').value = node.content || '';
  renderContentImageThumbs(node);

  document.getElementById('edit-border-color').value = node.borderColor || '';
  document.getElementById('edit-border-width').value = String(node.borderWidth || 1);
  document.getElementById('border-width-display').textContent = node.borderWidth || 1;
  document.getElementById('edit-title-color').value = node.titleColor || '';
  document.getElementById('edit-title-font').value = node.titleFont || 'Cormorant Garamond';
  document.getElementById('edit-icon-font').value = node.iconFont || 'Cinzel';
  document.getElementById('edit-icon-size').value = String(node.iconSize || 13);
  document.getElementById('icon-size-display').textContent = node.iconSize || 13;

  setPickerColor(node.color || '#f5c542');

  const isLink = isLinkNode(node);
  document.getElementById('link-url-field').style.display = isLink ? '' : 'none';
  document.getElementById('content-field').style.display = isLink ? 'none' : '';

  panel.classList.remove('hidden');
  render();
}

function renderContentImageThumbs(node) {
  const container = document.getElementById('content-img-thumbs');
  container.innerHTML = '';
  (node.contentImages || []).forEach((src, idx) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;display:inline-block';
    const img = document.createElement('img');
    img.src = src.startsWith('data:') ? src : `/images/${src}`;
    img.style.cssText = 'width:60px;height:60px;object-fit:cover;border-radius:4px;border:1px solid rgba(245,197,66,.3)';
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = 'Eliminar imagen';
    del.style.cssText = 'position:absolute;top:-4px;right:-4px;width:16px;height:16px;border-radius:50%;background:#c0392b;border:none;color:#fff;font-size:10px;cursor:pointer;padding:0;line-height:16px';
    del.addEventListener('click', () => {
      if (!src.startsWith('data:')) {
        fetch(`/api/delete-image/${src}`, { method: 'DELETE' }).catch(() => {});
      }
      node.contentImages.splice(idx, 1);
      scheduleSave();
      renderContentImageThumbs(node);
    });
    wrap.appendChild(img);
    wrap.appendChild(del);
    container.appendChild(wrap);
  });
}

function closeEditPanel() {
  panel.classList.add('hidden');
}

document.getElementById('panel-close').addEventListener('click', closeEditPanel);
document.getElementById('edit-icon-bold').addEventListener('change', (e) => applyLiveEdit('iconBold', e.target.checked));

// Aplica un cambio de campo al nodo activo y persiste con debounce
function applyLiveEdit(field, value) {
  const node = getNode(panel.dataset.nodeId);
  if (!node) return;
  node[field] = value;
  scheduleSave();
  render();
}

document.getElementById('edit-title').addEventListener('input', (e) => applyLiveEdit('title', e.target.value));
document.getElementById('edit-url').addEventListener('input', (e) => applyLiveEdit('url', e.target.value));
document.getElementById('edit-icon').addEventListener('input', (e) => applyLiveEdit('icon', e.target.value));
document.getElementById('edit-type').addEventListener('change', (e) => applyLiveEdit('type', e.target.value));
document.getElementById('edit-content').addEventListener('input', (e) => applyLiveEdit('content', e.target.value));

document.getElementById('edit-title-color').addEventListener('input', (e) => {
  const val = e.target.value.trim();
  const hex = /^#/.test(val) ? val : '#' + val;
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) applyLiveEdit('titleColor', hex);
});
document.getElementById('edit-title-font').addEventListener('change', (e) => applyLiveEdit('titleFont', e.target.value));
document.getElementById('edit-border-color').addEventListener('input', (e) => {
  const val = e.target.value.trim();
  const hex = /^#/.test(val) ? val : '#' + val;
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) applyLiveEdit('borderColor', hex);
  else if (val === '') applyLiveEdit('borderColor', '');
});
document.getElementById('edit-border-width').addEventListener('input', (e) => {
  document.getElementById('border-width-display').textContent = e.target.value;
  applyLiveEdit('borderWidth', parseFloat(e.target.value));
});
document.getElementById('edit-icon-font').addEventListener('change', (e) => applyLiveEdit('iconFont', e.target.value));
document.getElementById('edit-icon-size').addEventListener('input', (e) => {
  document.getElementById('icon-size-display').textContent = e.target.value;
  applyLiveEdit('iconSize', parseInt(e.target.value, 10));
});

// Slider de tamaño
document.getElementById('edit-size').addEventListener('input', (e) => {
  document.getElementById('size-value-display').textContent = e.target.value;
  applyLiveEdit('size', parseInt(e.target.value, 10));
});


// Carga de imagen
document.getElementById('icon-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  _uploadImage(file, (filename) => {
    const node = getNode(panel.dataset.nodeId);
    if (!node) return;
    // Si había imagen anterior en servidor, borrarla
    if (node.iconImage && !node.iconImage.startsWith('data:')) {
      fetch(`/api/delete-image/${node.iconImage}`, { method: 'DELETE' }).catch(() => {});
    }
    node.iconImage = filename;
    _imgCache.delete(node.id);
    const preview = document.getElementById('icon-preview');
    preview.style.backgroundImage = `url(/images/${filename})`;
    preview.classList.add('has-image');
    scheduleSave();
    render();
    e.target.value = '';
  });
});

// Carga de imágenes al contenido del nodo
document.getElementById('content-img-file').addEventListener('change', (e) => {
  const node = getNode(panel.dataset.nodeId);
  if (!node) return;
  if (!node.contentImages) node.contentImages = [];
  Array.from(e.target.files).forEach(file => {
    _uploadImage(file, (filename) => {
      node.contentImages.push(filename);
      scheduleSave();
      renderContentImageThumbs(node);
    });
  });
  e.target.value = '';
});

// Borrar imagen
document.getElementById('btn-delete-image').addEventListener('click', () => {
  const node = getNode(panel.dataset.nodeId);
  if (!node || !node.iconImage) return;
  if (!node.iconImage.startsWith('data:')) {
    fetch(`/api/delete-image/${node.iconImage}`, { method: 'DELETE' }).catch(() => {});
  }
  node.iconImage = '';
  _imgCache.delete(node.id);
  const preview = document.getElementById('icon-preview');
  preview.style.backgroundImage = '';
  preview.classList.remove('has-image');
  scheduleSave();
  render();
});

// Slider de fusión imagen/color
document.getElementById('icon-fade').addEventListener('input', (e) => {
  document.getElementById('icon-fade-display').textContent = e.target.value;
  applyLiveEdit('iconFade', parseInt(e.target.value, 10));
});

// ===================== COLOR PICKER =====================
const WHEEL_R = 88; // radio en px (canvas 180×180, centro en 90,90)
let _wL = 50, _wH = 45, _wS = 88;   // lightness, hue, sat actuales
let _wcX = 90, _wcY = 90;            // cursor en coords de canvas
let _wDrag = false;

function _hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0)*255), Math.round(f(8)*255), Math.round(f(4)*255)];
}

function _rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r)      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else                h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s * 100, l * 100];
}

function _rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

function _drawWheel() {
  const canvas = document.getElementById('color-wheel');
  if (!canvas) return;
  const wctx = canvas.getContext('2d');
  const size = 180, cx = 90, cy = 90;
  const img = wctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx*dx + dy*dy);
      const i = (y*size + x) * 4;
      if (dist > WHEEL_R) { d[i+3] = 0; continue; }
      const hue = ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
      const sat = (dist / WHEEL_R) * 100;
      const [r, g, b] = _hslToRgb(hue, sat, _wL);
      const fade = 1.5;
      const alpha = dist > WHEEL_R - fade ? Math.round(Math.max(0, WHEEL_R - dist) / fade * 255) : 255;
      d[i]=r; d[i+1]=g; d[i+2]=b; d[i+3]=alpha;
    }
  }
  wctx.putImageData(img, 0, 0);
}

function _updateSliderTrack() {
  const slider = document.getElementById('color-lightness');
  if (!slider) return;
  const dark  = _rgbToHex(..._hslToRgb(_wH, _wS, 5));
  const light = _rgbToHex(..._hslToRgb(_wH, _wS, 95));
  slider.style.background = `linear-gradient(to right, ${dark}, ${light})`;
}

function _syncFromCursor() {
  const dx = _wcX - 90, dy = _wcY - 90;
  _wH = ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
  _wS = Math.min(Math.sqrt(dx*dx + dy*dy) / WHEEL_R * 100, 100);
  const hex = _rgbToHex(..._hslToRgb(_wH, _wS, _wL));
  const swatch = document.getElementById('color-swatch');
  if (swatch) swatch.style.background = hex;
  const hexEl = document.getElementById('color-hex');
  if (hexEl) hexEl.value = hex;
  _updateSliderTrack();
  applyLiveEdit('color', hex);
}

function _updateCursorEl() {
  const el = document.getElementById('color-cursor');
  if (el) { el.style.left = _wcX + 'px'; el.style.top = _wcY + 'px'; }
}

function setPickerColor(hex) {
  if (!hex || !/^#[0-9a-fA-F]{6}$/i.test(hex)) return;
  const [r, g, b] = parseHex(hex);
  [_wH, _wS, _wL] = _rgbToHsl(r, g, b);
  _wL = Math.max(5, Math.min(95, Math.round(_wL)));
  const angle = _wH * Math.PI / 180;
  const dist = (_wS / 100) * WHEEL_R;
  _wcX = 90 + dist * Math.cos(angle);
  _wcY = 90 + dist * Math.sin(angle);
  _drawWheel();
  _updateCursorEl();
  const slider = document.getElementById('color-lightness');
  if (slider) slider.value = _wL;
  const swatch = document.getElementById('color-swatch');
  if (swatch) swatch.style.background = hex;
  const hexEl = document.getElementById('color-hex');
  if (hexEl) hexEl.value = hex;
  _updateSliderTrack();
}

function _onWheelPointer(e) {
  const canvas = document.getElementById('color-wheel');
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const dx = x - 90, dy = y - 90;
  const dist = Math.sqrt(dx*dx + dy*dy);
  if (dist > WHEEL_R + 6) return;
  const angle = Math.atan2(dy, dx);
  const clamped = Math.min(dist, WHEEL_R);
  _wcX = 90 + clamped * Math.cos(angle);
  _wcY = 90 + clamped * Math.sin(angle);
  _updateCursorEl();
  _syncFromCursor();
}

function initColorPicker() {
  _drawWheel();
  setPickerColor('#f5c542');

  const canvas = document.getElementById('color-wheel');
  canvas.addEventListener('mousedown', (e) => { e.preventDefault(); _wDrag = true; _onWheelPointer(e); });
  canvas.addEventListener('mousemove', (e) => { if (_wDrag) _onWheelPointer(e); });
  window.addEventListener('mouseup', () => { _wDrag = false; });

  document.getElementById('color-lightness').addEventListener('input', (e) => {
    _wL = parseInt(e.target.value);
    _drawWheel();
    _syncFromCursor();
  });

  document.getElementById('color-hex').addEventListener('input', (e) => {
    const val = e.target.value.trim();
    const hex = /^#/.test(val) ? val : '#' + val;
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
      setPickerColor(hex);
      applyLiveEdit('color', hex);
    }
  });
}

// ===================== PERSISTENCIA =====================
async function loadFromServer() {
  try {
    const r = await fetch('/api/tree');
    tree = await r.json();
    buildAdjacency();
    document.getElementById('tree-title').textContent = tree.title || 'Grimorio';
    if (tree.background && BACKGROUNDS[tree.background]) {
      activeBg = tree.background;
    }
    render();
  } catch (e) {
    console.error('Error cargando:', e);
    toast('Error al cargar el árbol');
  }
}

async function saveToServer() {
  try {
    await fetch('/api/tree', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tree)
    });
  } catch (e) {
    console.error('Error guardando:', e);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveToServer, 400);
}

// ===================== BOTONES TOPBAR =====================
document.getElementById('btn-save').addEventListener('click', async () => {
  await saveToServer();
  toast('Guardado');
});

document.getElementById('btn-center').addEventListener('click', () => {
  view.x = 0;
  view.y = 0;
  view.scale = 1;
  document.getElementById('zoom-level').textContent = '100%';
  render();
});

document.getElementById('btn-help').addEventListener('click', () => {
  document.getElementById('help-modal').classList.remove('hidden');
});

document.querySelector('#help-modal .modal-close').addEventListener('click', () => {
  document.getElementById('help-modal').classList.add('hidden');
});

document.getElementById('help-modal').addEventListener('click', (e) => {
  if (e.target.id === 'help-modal') {
    document.getElementById('help-modal').classList.add('hidden');
  }
});

// Título editable del árbol
const _titleEl = document.getElementById('tree-title');
_titleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); _titleEl.blur(); }
});
_titleEl.addEventListener('blur', () => {
  const val = _titleEl.textContent.trim();
  _titleEl.textContent = val || 'Grimorio';
  tree.title = _titleEl.textContent;
  scheduleSave();
});
_titleEl.addEventListener('input', () => {
  tree.title = _titleEl.textContent.trim() || 'Grimorio';
  scheduleSave();
});

document.getElementById('btn-export-html').addEventListener('click', () => {
  window.location.href = '/api/export-html';
  toast('Generando HTML…', 2500);
});

document.getElementById('btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(tree, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `grimorio_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Exportado');
});

document.getElementById('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const imported = JSON.parse(text);
    if (!imported.nodes || !imported.connections) throw new Error('Formato inválido');
    if (!confirm('Esto reemplazará tu árbol actual. ¿Continuar?')) return;
    tree = imported;
    buildAdjacency();
    await saveToServer();
    render();
    toast('Importado correctamente');
  } catch (err) {
    toast('Archivo inválido: ' + err.message, 3000);
  }
  e.target.value = '';
});

// ===================== BACKGROUND PICKER =====================
function initBgPicker() {
  const container = document.getElementById('bg-swatches');
  Object.entries(BACKGROUNDS).forEach(([id, bg]) => {
    const btn = document.createElement('button');
    btn.className = 'bg-swatch-btn' + (id === activeBg ? ' active' : '');
    btn.dataset.bg = id;
    btn.style.background = bg.swatch;
    btn.title = id.charAt(0).toUpperCase() + id.slice(1);
    btn.addEventListener('click', () => applyBackground(id));
    container.appendChild(btn);
  });

  document.getElementById('btn-bg').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('bg-panel').classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    const panel = document.getElementById('bg-panel');
    if (!panel.classList.contains('hidden') && !panel.contains(e.target)) {
      panel.classList.add('hidden');
    }
  });
}

// ===================== ARRANQUE =====================
resizeCanvas();
loadFromServer();
initColorPicker();
initBgPicker();

// Guardado al cerrar la pestaña (por si acaso)
window.addEventListener('beforeunload', () => {
  navigator.sendBeacon && navigator.sendBeacon(
    '/api/tree',
    new Blob([JSON.stringify(tree)], { type: 'application/json' })
  );
});

})();
