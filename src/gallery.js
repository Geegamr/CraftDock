// ═══════════════════════════════════════════════════════════
//  RAIL — MOST PLAYED PACKS
// ═══════════════════════════════════════════════════════════
function renderRailTopPacks(instances) {
  const wrap = document.getElementById('railTopPacks');
  const list = document.getElementById('railTopList');
  if (!wrap || !list) return;
  const top = [...(instances || [])]
    .filter(inst => (Number(inst.totalPlayMinutes) || 0) > 0)
    .sort((a, b) => (Number(b.totalPlayMinutes) || 0) - (Number(a.totalPlayMinutes) || 0)
      || (Number(b.lastPlayed) || 0) - (Number(a.lastPlayed) || 0))
    .slice(0, 3);
  wrap.hidden = !top.length;
  if (!top.length) { list.innerHTML = ''; return; }
  const packIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>';
  list.innerHTML = top.map(inst => {
    const name = inst.name || 'Modpack';
    const icon = inst.iconUrl
      ? `<img src="${escAttr(inst.iconUrl)}" alt="" draggable="false" onerror="this.remove()">`
      : packIcon;
    return `<button class="rail-pack" type="button" aria-label="${escAttr(name)}" onclick="openInstanceFromRail('${escAttr(inst.id)}')">
      <span class="rail-pack-icon">${icon}</span>
    </button>`;
  }).join('');
}

async function refreshRailTopPacks() {
  try { renderRailTopPacks(await InstanceStore.getAll()); } catch {}
}

function openInstanceFromRail(id) {
  switchPage('instances', document.querySelector('.rail-btn[title="Library"]'));
  setTimeout(() => selectInstanceById(id), 40);
}

// ═══════════════════════════════════════════════════════════
//  ALL-INSTANCE SCREENSHOT GALLERY
// ═══════════════════════════════════════════════════════════
let _galleryItems = [];
let _galleryLoading = false;
let _galleryRenderVersion = 0;
let _gallerySignature = null;
let _galleryAutoRefreshTimer = null;
let _galleryViewerIndex = -1;
let _galleryViewerRequest = 0;
const GALLERY_AUTO_REFRESH_MS = 4000;

function galleryPad(value) {
  return String(value).padStart(2, '0');
}

// Minecraft names screenshots YYYY-MM-DD_HH.MM.SS.png. That captured time is
// more reliable than mtime, which can change when a screenshot is copied or a
// launcher updates its files. Files without that name fall back to mtime.
function galleryFileTimestamp(file) {
  const name = String(file?.name || '');
  const match = name.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})\.(\d{2})\.(\d{2})/);
  if (match) {
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
    const captured = new Date(year, month - 1, day, hour, minute, second);
    if (captured.getFullYear() === year && captured.getMonth() === month - 1 && captured.getDate() === day
      && captured.getHours() === hour && captured.getMinutes() === minute && captured.getSeconds() === second) {
      return captured.getTime();
    }
  }
  return Number(file?.mtime) || 0;
}

const GALLERY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function galleryDateLabel(timestamp) {
  const date = new Date(Number(timestamp) || 0);
  if (!Number.isFinite(date.getTime()) || !date.getTime()) return '';
  return `${GALLERY_MONTHS[date.getMonth()]}, ${galleryPad(date.getDate())} ${galleryPad(date.getFullYear() % 100)}`;
}

function galleryTimeLabel(timestamp) {
  const date = new Date(Number(timestamp) || 0);
  if (!Number.isFinite(date.getTime()) || !date.getTime()) return '';
  return `${galleryPad(date.getHours())}:${galleryPad(date.getMinutes())}`;
}

function gallerySizeLabel(bytes) {
  const size = Number(bytes) || 0;
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return size ? `${size} B` : '';
}

function galleryItemsSignature(items) {
  return JSON.stringify((items || []).map(item => [
    item.instance?.id || '',
    item.file?.name || '',
    item.file?.path || '',
    Number(item.file?.size) || 0,
    Number(item.file?.mtime) || 0,
    Number(item.takenAt) || 0,
  ]));
}

function startGalleryAutoRefresh() {
  if (_galleryAutoRefreshTimer !== null) return;
  _galleryAutoRefreshTimer = setInterval(() => {
    const page = document.getElementById('page-gallery');
    if (!page?.classList.contains('active')) return;
    if (document.visibilityState === 'hidden') return;
    if (document.getElementById('galleryViewer')?.classList.contains('open')) return;
    if (document.getElementById('galleryEditor')?.classList.contains('open')) return;
    if (_galleryLoading) return;
    loadGalleryPage({ silent: true });
  }, GALLERY_AUTO_REFRESH_MS);
}

function renderGalleryEmpty(title, sub) {
  const grid = document.getElementById('galleryItems');
  const subEl = document.getElementById('gallerySub');
  _galleryRenderVersion += 1;
  if (subEl) subEl.textContent = 'Every screenshot, newest first.';
  if (!grid) return;
  grid.innerHTML = `<div class="gallery-empty">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21,15 16,10 5,21"/></svg>
    <div class="gallery-empty-title">${escHtml(title)}</div>
    <div class="gallery-empty-sub">${escHtml(sub)}</div>
  </div>`;
}

async function loadGalleryPage(options = {}) {
  const silent = options?.silent === true;
  if (_galleryLoading) return;
  const grid = document.getElementById('galleryItems');
  const subEl = document.getElementById('gallerySub');
  if (!grid) return;
  if (!window.craftdockInstance?.listScreenshots) {
    if (!silent) renderGalleryEmpty('Desktop app required', 'The gallery reads screenshots from CraftDock instance folders.');
    return;
  }
  startGalleryAutoRefresh();
  _galleryLoading = true;
  if (!silent) {
    if (subEl) subEl.textContent = 'Scanning every instance for screenshots…';
    if (!_galleryItems.length) grid.innerHTML = '<div class="gallery-empty"><div class="gallery-empty-title">Loading screenshots…</div></div>';
  }
  try {
    const instances = await InstanceStore.getAll();
    if (!instances.length) {
      const changed = _gallerySignature !== '[]';
      _gallerySignature = '[]';
      _galleryItems = [];
      if (!silent || changed) renderGalleryEmpty('No instances yet', 'Create or browse a modpack first, then take screenshots in-game with F2.');
      return;
    }
    const scanned = await Promise.all(instances.map(async instance => {
      let files = [];
      try { files = await window.craftdockInstance.listScreenshots(instance.id); }
      catch { files = []; }
      files = (Array.isArray(files) ? files : [])
        .filter(file => file && file.name && file.path)
        .map(file => ({ file, takenAt: galleryFileTimestamp(file) }));
      return {
        instance: { id: instance.id, name: instance.name || 'Instance' },
        files,
      };
    }));
    const items = [];
    for (const entry of scanned) {
      for (const { file, takenAt } of entry.files) items.push({ instance: entry.instance, file, takenAt });
    }
    items.sort((a, b) => b.takenAt - a.takenAt
      || a.file.name.localeCompare(b.file.name, undefined, { sensitivity: 'base', numeric: true })
      || a.instance.name.localeCompare(b.instance.name, undefined, { sensitivity: 'base', numeric: true }));
    const signature = galleryItemsSignature(items);
    const changed = signature !== _gallerySignature;
    _galleryItems = items;
    _gallerySignature = signature;
    if (!items.length) {
      if (!silent || changed) {
        if (subEl) subEl.textContent = 'No screenshots found across your instances yet.';
        renderGalleryEmpty('No screenshots yet', 'Take a screenshot in-game with F2 and it will appear here.');
      }
      return;
    }
    if (silent && !changed) return;
    if (subEl) subEl.textContent = `${items.length} screenshot${items.length === 1 ? '' : 's'} · newest first`;
    const scroll = document.getElementById('galleryScroll');
    const scrollTop = scroll ? scroll.scrollTop : 0;
    renderGalleryPage();
    if (silent && scroll) scroll.scrollTop = scrollTop;
  } catch (error) {
    if (!silent) renderGalleryEmpty('Could not load the gallery', error.message || 'Unknown error');
  } finally {
    _galleryLoading = false;
  }
}

function renderGalleryPage() {
  const grid = document.getElementById('galleryItems');
  if (!grid) return;
  const version = ++_galleryRenderVersion;
  const tileIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21,15 16,10 5,21"/></svg>';
  grid.innerHTML = _galleryItems.map((item, index) => {
    const file = item.file;
    return `<div class="gallery-tile" role="button" tabindex="0" data-gallery-index="${index}" aria-label="View ${escAttr(file.name)}"
      onclick="openGalleryViewer(${index})"
      onkeydown="if(event.target===this&&(event.key==='Enter'||event.key===' ')){event.preventDefault();openGalleryViewer(${index})}">
      <div class="gallery-tile-placeholder">${tileIcon}</div>
      <img class="gallery-tile-image" id="galleryThumb-${index}" alt="" decoding="async">
      <button class="gallery-tile-edit" type="button" onclick="event.stopPropagation();editGalleryItem(${index})">Edit</button>
      <div class="gallery-tile-caption"><span class="gallery-tile-name" title="${escAttr(file.name)}">${escHtml(file.name)}</span><span class="gallery-tile-date">${escHtml(galleryDateLabel(item.takenAt))}</span></div>
    </div>`;
  }).join('');
  grid.querySelectorAll('.gallery-tile-image').forEach(image => {
    image.addEventListener('load', () => image.classList.add('loaded'), { once: true });
    image.addEventListener('error', () => image.remove(), { once: true });
  });
  loadGalleryThumbnails(version);
}

function loadGalleryThumbnails(version) {
  const total = _galleryItems.length;
  let next = 0;
  const worker = async () => {
    while (version === _galleryRenderVersion) {
      const index = next++;
      if (index >= total) return;
      await loadGalleryThumb(index, version);
    }
  };
  for (let i = 0; i < Math.min(4, total); i++) worker();
}

async function loadGalleryThumb(index, version) {
  const item = _galleryItems[index];
  const image = document.getElementById(`galleryThumb-${index}`);
  if (!item || !image || image.dataset.loaded === '1') return;
  image.dataset.loaded = '1';
  try {
    let response = await window.craftdockInstance.readScreenshot(item.file.path, { thumbnail: true });
    if (!response?.dataUrl) response = await window.craftdockInstance.readScreenshot(item.file.path);
    if (version !== _galleryRenderVersion) return;
    if (!response?.dataUrl) throw new Error(response?.error || 'Could not load thumbnail');
    image.src = response.dataUrl;
  } catch {
    if (version === _galleryRenderVersion) image.dataset.loaded = '0';
  }
}

function openGalleryViewer(index) {
  const item = _galleryItems[index];
  const viewer = document.getElementById('galleryViewer');
  if (!item || !viewer) return;
  _galleryViewerIndex = index;
  viewer.classList.add('open');
  viewer.setAttribute('aria-hidden', 'false');
  document.getElementById('galleryViewerTitle').textContent = item.file.name;
  document.getElementById('galleryViewerMeta').textContent = [galleryDateLabel(item.takenAt), galleryTimeLabel(item.takenAt), gallerySizeLabel(item.file.size)].filter(Boolean).join(' · ');
  document.getElementById('galleryViewerCount').textContent = `${index + 1} of ${_galleryItems.length} screenshots`;
  document.getElementById('galleryViewerPrev').disabled = index <= 0;
  document.getElementById('galleryViewerNext').disabled = index >= _galleryItems.length - 1;
  loadGalleryViewerImage(index);
}

async function loadGalleryViewerImage(index) {
  const item = _galleryItems[index];
  const image = document.getElementById('galleryViewerImage');
  if (!item || !image) return;
  const request = ++_galleryViewerRequest;
  image.src = '';
  image.style.opacity = '0.35';
  try {
    const response = await window.craftdockInstance.readScreenshot(item.file.path);
    if (request !== _galleryViewerRequest || !document.getElementById('galleryViewer').classList.contains('open')) return;
    if (response?.dataUrl) {
      image.src = response.dataUrl;
      image.style.opacity = '1';
    }
  } catch (error) {
    if (request === _galleryViewerRequest) document.getElementById('galleryViewerCount').textContent = error.message || 'Could not load screenshot';
  }
}

function closeGalleryViewer() {
  _galleryViewerRequest += 1;
  const viewer = document.getElementById('galleryViewer');
  if (viewer) { viewer.classList.remove('open'); viewer.setAttribute('aria-hidden', 'true'); }
  const image = document.getElementById('galleryViewerImage');
  if (image) image.src = '';
}

function galleryViewerNav(direction) {
  const next = _galleryViewerIndex + direction;
  if (next < 0 || next >= _galleryItems.length) return;
  openGalleryViewer(next);
}

function openGalleryViewerExternal() {
  const item = _galleryItems[_galleryViewerIndex];
  if (item && window.craftdock?.openFolder) window.craftdock.openFolder(item.file.path);
}

function editGalleryItem(index) { openGalleryEditor(index); }

function openGalleryEditorFromViewer() {
  const index = _galleryViewerIndex;
  closeGalleryViewer();
  openGalleryEditor(index);
}

// ═══════════════════════════════════════════════════════════
//  SCREENSHOT EDITOR
// ═══════════════════════════════════════════════════════════
const _galleryEditor = {
  item: null, image: null, token: 0, history: [], tool: 'pen', color: '#ff4d4d', size: 8,
  drawing: false, start: null, last: null, snapshot: null, crop: null, ready: false,
};

function galleryEditorCanvas() { return document.getElementById('galleryEditorCanvas'); }
function galleryEditorOverlay() { return document.getElementById('galleryEditorOverlay'); }

function setGalleryEditorTool(tool) {
  if (!['crop', 'pen', 'highlight', 'rect', 'ellipse', 'arrow'].includes(tool)) return;
  _galleryEditor.tool = tool;
  const editor = document.getElementById('galleryEditor');
  if (editor) editor.dataset.tool = tool;
  document.querySelectorAll('[data-gallery-tool]').forEach(button => button.classList.toggle('active', button.dataset.galleryTool === tool));
  if (tool !== 'crop') clearGalleryCrop();
  const status = document.getElementById('galleryEditorStatus');
  if (status && _galleryEditor.ready) {
    const labels = { crop: 'Drag on the image to choose a crop area.', pen: 'Draw freely on the image.', highlight: 'Drag to add a translucent highlight.', rect: 'Drag to draw a rectangle.', ellipse: 'Drag to draw an ellipse.', arrow: 'Drag to draw an arrow.' };
    status.textContent = labels[tool] || 'Drag on the image.';
  }
}

function galleryEditorColorChanged(value) {
  _galleryEditor.color = value || '#ff4d4d';
}

function galleryEditorSizeChanged(value) {
  _galleryEditor.size = Math.max(1, Math.min(40, Number(value) || 1));
  const output = document.getElementById('galleryEditorSizeValue');
  if (output) output.textContent = String(_galleryEditor.size);
}

async function openGalleryEditor(index) {
  const item = _galleryItems[index];
  const editor = document.getElementById('galleryEditor');
  if (!item || !editor) return;
  _galleryEditor.item = item;
  _galleryEditor.ready = false;
  _galleryEditor.history = [];
  _galleryEditor.crop = null;
  _galleryEditor.snapshot = null;
  const token = ++_galleryEditor.token;
  editor.classList.add('open');
  editor.setAttribute('aria-hidden', 'false');
  document.getElementById('galleryEditorLoading').style.display = 'flex';
  document.getElementById('galleryEditorLoading').textContent = 'Loading screenshot…';
  document.getElementById('galleryEditorSub').textContent = item.file.name;
  document.getElementById('galleryEditorStatus').textContent = 'Loading screenshot…';
  document.getElementById('galleryEditorDimensions').textContent = '';
  document.getElementById('galleryEditorSave').disabled = true;
  setGalleryEditorTool('pen');
  clearGalleryCrop();
  const canvas = galleryEditorCanvas();
  const overlay = galleryEditorOverlay();
  canvas.width = 1; canvas.height = 1;
  overlay.width = 1; overlay.height = 1;
  bindGalleryEditorCanvas();
  try {
    const response = await window.craftdockInstance.readScreenshot(item.file.path);
    if (token !== _galleryEditor.token || !response?.dataUrl) throw new Error(response?.error || 'Could not load screenshot');
    const image = new Image();
    image.onload = () => {
      if (token !== _galleryEditor.token) return;
      _galleryEditor.image = image;
      _galleryEditor.ready = true;
      _galleryEditor.history = [];
      _galleryEditor.crop = null;
      setGalleryEditorCanvasSize(image.naturalWidth, image.naturalHeight);
      canvas.getContext('2d').drawImage(image, 0, 0);
      clearGalleryEditorOverlay();
      document.getElementById('galleryEditorLoading').style.display = 'none';
      document.getElementById('galleryEditorSub').textContent = item.file.name;
      document.getElementById('galleryEditorStatus').textContent = 'Choose a tool, then drag on the image.';
      document.getElementById('galleryEditorDimensions').textContent = `${image.naturalWidth} × ${image.naturalHeight}`;
      document.getElementById('galleryEditorSave').disabled = false;
    };
    image.onerror = () => {
      if (token === _galleryEditor.token) {
        document.getElementById('galleryEditorLoading').textContent = 'Could not decode this screenshot.';
        document.getElementById('galleryEditorStatus').textContent = 'Could not decode this screenshot.';
      }
    };
    image.src = response.dataUrl;
  } catch (error) {
    if (token === _galleryEditor.token) {
      document.getElementById('galleryEditorLoading').textContent = error.message || 'Could not load screenshot.';
      document.getElementById('galleryEditorStatus').textContent = error.message || 'Could not load screenshot.';
    }
  }
}

function closeGalleryEditor() {
  _galleryEditor.token += 1;
  _galleryEditor.ready = false;
  _galleryEditor.drawing = false;
  const editor = document.getElementById('galleryEditor');
  if (editor) { editor.classList.remove('open'); editor.setAttribute('aria-hidden', 'true'); }
  const canvas = galleryEditorCanvas();
  const overlay = galleryEditorOverlay();
  if (canvas) { canvas.width = 1; canvas.height = 1; }
  if (overlay) { overlay.width = 1; overlay.height = 1; }
  const loading = document.getElementById('galleryEditorLoading');
  if (loading) { loading.style.display = 'flex'; loading.textContent = 'Loading screenshot…'; }
}

function setGalleryEditorCanvasSize(width, height) {
  const canvas = galleryEditorCanvas();
  const overlay = galleryEditorOverlay();
  canvas.width = width;
  canvas.height = height;
  overlay.width = width;
  overlay.height = height;
  document.getElementById('galleryEditorDimensions').textContent = `${width} × ${height}`;
}

function bindGalleryEditorCanvas() {
  const canvas = galleryEditorCanvas();
  if (!canvas || canvas.dataset.bound === '1') return;
  canvas.dataset.bound = '1';
  canvas.addEventListener('pointerdown', galleryEditorPointerDown);
  canvas.addEventListener('pointermove', galleryEditorPointerMove);
  canvas.addEventListener('pointerup', galleryEditorPointerUp);
  canvas.addEventListener('pointercancel', galleryEditorPointerUp);
}

function galleryEditorPoint(event) {
  const canvas = galleryEditorCanvas();
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * (canvas.width / rect.width))),
    y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * (canvas.height / rect.height))),
  };
}

function galleryEditorPointerDown(event) {
  if (!_galleryEditor.ready || event.button !== 0) return;
  event.preventDefault();
  const point = galleryEditorPoint(event);
  _galleryEditor.drawing = true;
  _galleryEditor.start = point;
  _galleryEditor.last = point;
  _galleryEditor.snapshot = galleryEditorCanvas().toDataURL('image/png');
  galleryEditorCanvas().setPointerCapture?.(event.pointerId);
  if (_galleryEditor.tool === 'pen' || _galleryEditor.tool === 'highlight') {
    const ctx = galleryEditorCanvas().getContext('2d');
    ctx.save();
    ctx.globalAlpha = _galleryEditor.tool === 'highlight' ? 0.32 : 1;
    ctx.fillStyle = _galleryEditor.color;
    ctx.beginPath();
    ctx.arc(point.x, point.y, Math.max(0.5, (_galleryEditor.tool === 'highlight' ? _galleryEditor.size * 3 : _galleryEditor.size) / 2), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else if (_galleryEditor.tool === 'crop') {
    _galleryEditor.crop = { x: point.x, y: point.y, w: 0, h: 0 };
    drawGalleryEditorCrop();
  } else {
    drawGalleryEditorShapePreview(point);
  }
}

function galleryEditorPointerMove(event) {
  if (!_galleryEditor.drawing || !_galleryEditor.ready) return;
  const point = galleryEditorPoint(event);
  if (_galleryEditor.tool === 'pen' || _galleryEditor.tool === 'highlight') {
    const ctx = galleryEditorCanvas().getContext('2d');
    ctx.save();
    ctx.globalAlpha = _galleryEditor.tool === 'highlight' ? 0.32 : 1;
    ctx.strokeStyle = _galleryEditor.color;
    ctx.lineWidth = _galleryEditor.tool === 'highlight' ? Math.max(2, _galleryEditor.size * 3) : _galleryEditor.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(_galleryEditor.last.x, _galleryEditor.last.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    ctx.restore();
    _galleryEditor.last = point;
  } else if (_galleryEditor.tool === 'crop') {
    _galleryEditor.crop = {
      x: Math.min(_galleryEditor.start.x, point.x),
      y: Math.min(_galleryEditor.start.y, point.y),
      w: Math.abs(point.x - _galleryEditor.start.x),
      h: Math.abs(point.y - _galleryEditor.start.y),
    };
    drawGalleryEditorCrop();
  } else {
    drawGalleryEditorShapePreview(point);
  }
}

function galleryEditorPointerUp(event) {
  if (!_galleryEditor.drawing) return;
  const point = galleryEditorPoint(event);
  const tool = _galleryEditor.tool;
  _galleryEditor.drawing = false;
  try { galleryEditorCanvas().releasePointerCapture?.(event.pointerId); } catch {}
  if (tool === 'crop') {
    _galleryEditor.crop = {
      x: Math.min(_galleryEditor.start.x, point.x),
      y: Math.min(_galleryEditor.start.y, point.y),
      w: Math.abs(point.x - _galleryEditor.start.x),
      h: Math.abs(point.y - _galleryEditor.start.y),
    };
    const hasCrop = _galleryEditor.crop.w >= 2 && _galleryEditor.crop.h >= 2;
    document.getElementById('galleryCropApply').disabled = !hasCrop;
    document.getElementById('galleryCropCancel').disabled = !hasCrop;
    drawGalleryEditorCrop();
    _galleryEditor.snapshot = null;
    return;
  }
  if (tool === 'pen' || tool === 'highlight') {
    pushGalleryEditorHistory(_galleryEditor.snapshot);
    _galleryEditor.snapshot = null;
    document.getElementById('galleryEditorStatus').textContent = 'Stroke added. Save a copy when you are happy with it.';
    return;
  }
  if (Math.hypot(point.x - _galleryEditor.start.x, point.y - _galleryEditor.start.y) >= 2) {
    galleryEditorDrawShape(galleryEditorCanvas().getContext('2d'), tool, _galleryEditor.start, point, _galleryEditor.color, _galleryEditor.size);
    pushGalleryEditorHistory(_galleryEditor.snapshot);
    document.getElementById('galleryEditorStatus').textContent = 'Shape added. Save a copy when you are happy with it.';
  }
  _galleryEditor.snapshot = null;
  clearGalleryEditorOverlay();
}

function galleryEditorDrawShape(ctx, tool, start, end, color, size) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (tool === 'rect') {
    const x = Math.min(start.x, end.x); const y = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x); const h = Math.abs(end.y - start.y);
    ctx.globalAlpha = 0.14; ctx.fillRect(x, y, w, h); ctx.globalAlpha = 1; ctx.strokeRect(x, y, w, h);
  } else if (tool === 'ellipse') {
    const cx = (start.x + end.x) / 2; const cy = (start.y + end.y) / 2;
    const rx = Math.abs(end.x - start.x) / 2; const ry = Math.abs(end.y - start.y) / 2;
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.globalAlpha = 0.14; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
  } else if (tool === 'arrow') {
    ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y); ctx.stroke();
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const head = Math.max(10, size * 3);
    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(end.x - head * Math.cos(angle - Math.PI / 6), end.y - head * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(end.x - head * Math.cos(angle + Math.PI / 6), end.y - head * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
  }
  ctx.restore();
}

function drawGalleryEditorShapePreview(point) {
  const overlay = galleryEditorOverlay();
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  galleryEditorDrawShape(ctx, _galleryEditor.tool, _galleryEditor.start, point, _galleryEditor.color, _galleryEditor.size);
}

function drawGalleryEditorCrop() {
  const overlay = galleryEditorOverlay();
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const crop = _galleryEditor.crop;
  if (!crop) return;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,.58)';
  ctx.fillRect(0, 0, overlay.width, overlay.height);
  ctx.clearRect(crop.x, crop.y, crop.w, crop.h);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(1, overlay.width / 700);
  ctx.strokeRect(crop.x, crop.y, crop.w, crop.h);
  ctx.restore();
}

function clearGalleryEditorOverlay() {
  const overlay = galleryEditorOverlay();
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
}

function clearGalleryCrop() {
  _galleryEditor.crop = null;
  clearGalleryEditorOverlay();
  const apply = document.getElementById('galleryCropApply');
  const cancel = document.getElementById('galleryCropCancel');
  if (apply) apply.disabled = true;
  if (cancel) cancel.disabled = true;
}

function pushGalleryEditorHistory(snapshot) {
  if (!snapshot) return;
  _galleryEditor.history.push(snapshot);
  if (_galleryEditor.history.length > 12) _galleryEditor.history.shift();
}

function applyGalleryCrop() {
  const crop = _galleryEditor.crop;
  const canvas = galleryEditorCanvas();
  if (!crop || crop.w < 2 || crop.h < 2) return;
  const snapshot = canvas.toDataURL('image/png');
  const source = document.createElement('canvas');
  source.width = canvas.width; source.height = canvas.height;
  source.getContext('2d').drawImage(canvas, 0, 0);
  const width = Math.max(1, Math.round(crop.w));
  const height = Math.max(1, Math.round(crop.h));
  setGalleryEditorCanvasSize(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, width, height);
  clearGalleryEditorOverlay();
  pushGalleryEditorHistory(snapshot);
  _galleryEditor.crop = null;
  document.getElementById('galleryCropApply').disabled = true;
  document.getElementById('galleryCropCancel').disabled = true;
  document.getElementById('galleryEditorStatus').textContent = 'Cropped. Continue editing or save a copy.';
}

function galleryEditorReset() {
  if (!_galleryEditor.ready || !_galleryEditor.image) return;
  pushGalleryEditorHistory(galleryEditorCanvas().toDataURL('image/png'));
  setGalleryEditorCanvasSize(_galleryEditor.image.naturalWidth, _galleryEditor.image.naturalHeight);
  const ctx = galleryEditorCanvas().getContext('2d');
  ctx.drawImage(_galleryEditor.image, 0, 0);
  clearGalleryCrop();
  document.getElementById('galleryEditorStatus').textContent = 'Reset to the original screenshot.';
}

function galleryEditorUndo() {
  if (!_galleryEditor.ready) return;
  const snapshot = _galleryEditor.history.pop();
  if (!snapshot) return;
  const image = new Image();
  image.onload = () => {
    if (!_galleryEditor.ready) return;
    setGalleryEditorCanvasSize(image.naturalWidth, image.naturalHeight);
    const ctx = galleryEditorCanvas().getContext('2d');
    ctx.drawImage(image, 0, 0);
    clearGalleryCrop();
    document.getElementById('galleryEditorStatus').textContent = 'Undid the last edit.';
  };
  image.src = snapshot;
}

async function saveGalleryEditor() {
  const state = _galleryEditor;
  const button = document.getElementById('galleryEditorSave');
  if (!state.ready || !state.item || !button) return;
  button.disabled = true;
  document.getElementById('galleryEditorStatus').textContent = 'Saving edited copy…';
  try {
    if (!window.craftdockInstance?.saveScreenshotCopy) throw new Error('Saving is only available in the desktop app');
    const response = await window.craftdockInstance.saveScreenshotCopy(state.item.instance.id, state.item.file.path, galleryEditorCanvas().toDataURL('image/png'));
    if (!response?.success) throw new Error(response?.error || 'Could not save edited screenshot');
    showNotif('Screenshot saved', response.name);
    closeGalleryEditor();
    await loadGalleryPage();
  } catch (error) {
    document.getElementById('galleryEditorStatus').textContent = error.message || 'Could not save edited screenshot';
    showNotif('Save failed', error.message || 'Could not save edited screenshot');
    button.disabled = false;
  }
}

document.addEventListener('keydown', e => {
  const editor = document.getElementById('galleryEditor');
  if (editor?.classList.contains('open')) {
    if (e.key === 'Escape') { e.preventDefault(); closeGalleryEditor(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); galleryEditorUndo(); }
    return;
  }
  const viewer = document.getElementById('galleryViewer');
  if (!viewer?.classList.contains('open')) return;
  if (e.key === 'ArrowLeft') galleryViewerNav(-1);
  if (e.key === 'ArrowRight') galleryViewerNav(1);
  if (e.key === 'Escape') closeGalleryViewer();
});
