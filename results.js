// Page Saver results page: shows every image and video found, fetches each image at
// its biggest size, and saves the chosen ones as one ZIP (or a single video).
/* global makeZip, resolveStream, saveStream, previewStream */
const qs = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const IMG_CONCURRENCY = 6;
const VID_CONCURRENCY = 3;
const MAX_CANDIDATES = 4;
const NEAR_DUP_DISTANCE = 20;
const NEAR_DUP_PIXEL_DIFF = 1.0;
const NEAR_DUP_MIN_CORRELATION = 0.985;
const ZIP_PART_LIMIT = 1.8e9;
const SETTINGS_KEY = 'ps_settings';
const SISTERS = [
  [/(^|\.)instagram\.com$/, 'Grid Saver', 'https://techygeekshome.info/browser-extensions/grid-saver/', 'a whole Instagram profile'],
  [/(^|\.)tiktok\.com$/, 'Clip Saver', 'https://techygeekshome.info/browser-extensions/clip-saver/', 'a whole TikTok profile'],
  [/(^|\.)pinterest\.[a-z.]+$/, 'Board Saver', 'https://techygeekshome.info/browser-extensions/board-saver/', 'a whole Pinterest board']
];

const state = {
  title: '', source: '', items: [], loaded: 0, total: 0, busy: false, show: 'all',
  settings: { minSide: 100, nearDup: true, showRemoved: false }
};

init();

// ---------- Start ----------
async function init() {
  const help = qs.get('help');
  if (help) return showHelp(help);
  const key = qs.get('job');
  const all = await chrome.storage.local.get(null);
  const old = Object.keys(all).filter((k) => k.startsWith('job_') && k !== key && Date.now() - Number(k.slice(4)) > 86400000);
  if (old.length) chrome.storage.local.remove(old);
  const job = all[key];
  if (!job) return showHelp('expired');
  if (all[SETTINGS_KEY]) Object.assign(state.settings, all[SETTINGS_KEY], { showRemoved: false });

  state.title = job.title || job.host || 'page';
  state.source = job.source;
  document.title = state.title + ' | Page Saver';
  $('title').textContent = state.title;
  $('legal').hidden = false;

  // Downloads from this tab go out with the page as referrer, as the page's own would.
  await new Promise((res) => chrome.runtime.sendMessage({ type: 'ps-referer', source: job.source }, () => { void chrome.runtime.lastError; res(); }));

  const sister = SISTERS.find(([re]) => re.test(job.host || ''));
  if (sister) {
    const t = $('tip');
    t.append(`Saving ${sister[3]}? `);
    const a = document.createElement('a');
    a.href = sister[2]; a.target = '_blank'; a.rel = 'noopener'; a.textContent = sister[1];
    t.append(a, ` from the same makers scrolls the whole thing for you.`);
    t.hidden = false;
  }

  // Videos: from the page itself and from what the tab loaded.
  const vids = new Map();
  for (const v of job.videos || []) vids.set(v.url, { ...v });
  for (const n of job.network || []) {
    if (vids.has(n.url)) { Object.assign(vids.get(n.url), { size: n.size || vids.get(n.url).size }); continue; }
    vids.set(n.url, { kind: 'video', src: n.src, url: n.url, size: n.size || 0, poster: '', w: 0, h: 0, dur: 0 });
  }
  const videoItems = [...vids.values()].map((v, i) => ({ ...v, idx: i, status: 'pending', selected: true, removed: '', hide: false, el: null }));
  const imageItems = (job.images || []).map((p, i) => ({
    ...p, idx: i, status: 'pending', blob: null, url: '', sha: null, hash: null, mini: null,
    w: 0, h: 0, ext: 'jpg', removed: '', selected: true, force: false, el: null
  }));
  // Give stream cards a picture if the page had exactly as many posters as streams.
  const bare = videoItems.filter((v) => !v.poster);
  const posters = job.posters || [];
  if (posters.length && posters.length === bare.length) bare.forEach((v, i) => { v.poster = posters[i]; });

  state.items = [...videoItems, ...imageItems];
  state.total = state.items.length;
  if (!state.total) {
    showHelp('empty');
    return;
  }
  setupControls();
  buildGrid();
  updateStats();
  await Promise.all([
    pool(imageItems, IMG_CONCURRENCY, loadImage),
    pool(videoItems, VID_CONCURRENCY, loadVideo)
  ]);
  hideStreamParts(videoItems);
  applyFilters();
}

function showHelp(kind) {
  const H = {
    youtube: ['YouTube isn\'t supported', 'Page Saver doesn\'t download from YouTube. It works on most other websites: open the page you want, then click the Page Saver icon.'],
    page: ['This page can\'t be read', 'Browsers don\'t let extensions read their own settings pages, the extension stores or some built-in pages. Open a normal web page and click the Page Saver icon again.'],
    access: ['Page Saver needs permission', 'Page Saver needs access to the page you are on to find its images and videos. Click the icon again and choose Allow.'],
    expired: ['This download has expired', 'Click the Page Saver icon on the page again to start a new one.'],
    empty: ['Nothing found on this page', 'Page Saver didn\'t find any images or videos it can save here. If the page was still loading, wait a moment and click the icon again. Videos protected against copying, live broadcasts and YouTube can\'t be saved.']
  };
  const h = H[kind];
  if (h) { $('title').textContent = h[0]; $('helpTitle').textContent = 'What to do'; $('helpText').textContent = h[1]; }
  else $('title').textContent = 'Page Saver';
  $('help').hidden = false;
}

async function pool(list, n, fn) {
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const it = list[next++];
      try { await fn(it); } catch (e) { it.status = 'failed'; it.error = String(e.message || e); }
      state.loaded++;
      updateCard(it);
      updateStats();
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
}

// ---------- Controls ----------
function setupControls() {
  $('controls').hidden = false;
  const s = state.settings;
  $('minSide').value = String(s.minSide);
  $('nearDup').checked = s.nearDup;
  $('showRemoved').checked = s.showRemoved;
  const save = () => chrome.storage.local.set({ [SETTINGS_KEY]: { minSide: s.minSide, nearDup: s.nearDup } });
  $('minSide').onchange = (e) => { s.minSide = Number(e.target.value); save(); applyFilters(); };
  $('nearDup').onchange = (e) => { s.nearDup = e.target.checked; save(); applyFilters(); };
  $('showRemoved').onchange = (e) => { s.showRemoved = e.target.checked; state.items.forEach(updateCard); };
  for (const b of document.querySelectorAll('.seg button')) {
    b.onclick = () => {
      state.show = b.dataset.show;
      document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
      state.items.forEach(updateCard);
    };
  }
  const visible = (i) => !i.hide && (state.show === 'all' || state.show === i.kind) && (!i.removed || state.settings.showRemoved);
  $('all').onclick = () => { state.items.filter(visible).forEach((i) => { if (i.removed) i.force = true; else i.selected = true; updateCard(i); }); updateStats(); };
  $('none').onclick = () => { state.items.filter(visible).forEach((i) => { i.selected = false; i.force = false; updateCard(i); }); updateStats(); };
  $('retry').onclick = retryFailed;
  $('dl').onclick = downloadZip;
}

// ---------- Grid ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function buildGrid() {
  const grid = $('grid');
  const frag = document.createDocumentFragment();
  for (const it of state.items) {
    const card = el('label', 'card');
    const cb = el('input');
    cb.type = 'checkbox';
    const thumb = el('div', 'thumb');
    const meta = el('div', 'meta');
    meta.append(el('span', 'dim', 'Loading'), el('span', 'tag', ''));
    card.append(cb, thumb, meta);
    if (it.kind === 'video') {
      card.append(el('span', 'vid', it.src === 'file' ? 'VIDEO' : 'VIDEO STREAM'));
      const info = el('div', 'vinfo', '');
      const prog = el('div', 'prog'); prog.append(el('div')); prog.hidden = true;
      const bar = el('div', 'vbar');
      const save = el('button', 'ghost', 'Save this video');
      save.disabled = true;
      save.onclick = (e) => { e.preventDefault(); e.stopPropagation(); saveOne(it); };
      bar.append(save);
      card.append(info, prog, bar);
      it.saveBtn = save;
      if (it.poster) { const img = el('img'); img.src = it.poster; img.alt = ''; img.loading = 'lazy'; img.onerror = () => img.remove(); thumb.append(img); }
      else thumb.append(el('span', 'ph', '▶'));
    }
    if (it.alt) card.title = it.alt;
    cb.onchange = () => {
      if (it.removed) it.force = cb.checked; else it.selected = cb.checked;
      updateCard(it);
      updateStats();
    };
    it.el = card;
    frag.appendChild(card);
  }
  grid.appendChild(frag);
}

const usable = (it) => it.status === 'ok';
const included = (it) => usable(it) && !it.hide && (it.removed ? it.force : it.selected);

function fmtTime(s) {
  if (!s || !Number.isFinite(s)) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}
function fmtSize(b) {
  if (!b) return '';
  return b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? Math.round(b / 1e6) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
}

function updateCard(it) {
  const card = it.el;
  if (!card) return;
  const thumb = card.querySelector('.thumb');
  if (it.kind === 'image' && it.thumb && !thumb.firstChild) {
    const img = el('img');
    img.loading = 'lazy';
    img.src = it.thumb;
    img.alt = it.alt || '';
    thumb.append(img);
  }
  if (it.kind === 'video' && it.src === 'file' && it.status === 'ok' && !it.poster && !thumb.querySelector('video')) {
    thumb.textContent = '';
    const v = el('video');
    v.muted = true; v.preload = 'metadata'; v.src = it.url + '#t=1';
    thumb.append(v);
  }
  let dim = 'Loading';
  if (it.status === 'ok') {
    if (it.kind === 'image') dim = it.w ? `${it.w} x ${it.h}` : it.ext.toUpperCase();
    else dim = it.h ? `${it.h}p` : 'Video';
  } else if (it.status === 'failed') dim = '';
  else if (it.status === 'blocked') dim = '';
  card.querySelector('.dim').textContent = dim;
  card.querySelector('.tag').textContent = it.status === 'failed' ? 'Failed' : it.status === 'blocked' ? it.blockReason : it.removed || '';
  if (it.kind === 'video') {
    const bits = [];
    if (it.w && it.h) bits.push(`${it.w} x ${it.h}`);
    if (it.dur) bits.push(fmtTime(it.dur));
    const sz = it.size || (it.bandwidth && it.dur ? (it.bandwidth * it.dur) / 8 : 0);
    if (sz) bits.push((it.size ? '' : 'about ') + fmtSize(sz));
    bits.push(it.src === 'file' ? 'video file' : it.src === 'hls' ? 'HLS stream' : 'DASH stream');
    card.querySelector('.vinfo').textContent = it.status === 'failed' ? (it.error || 'Couldn\'t read this video') : bits.join(' · ');
    if (it.saveBtn && !it.saving) it.saveBtn.disabled = it.status !== 'ok' || state.busy;
  }
  card.classList.toggle('failed', it.status === 'failed');
  card.classList.toggle('blocked', it.status === 'blocked');
  card.classList.toggle('removed', !!it.removed);
  card.classList.toggle('on', included(it));
  const hidden = it.hide || (state.show !== 'all' && state.show !== it.kind) || (!!it.removed && !it.force && !state.settings.showRemoved);
  card.classList.toggle('hidden', hidden);
  const cb = card.querySelector('input');
  cb.checked = included(it);
  cb.disabled = it.status !== 'ok';
}

function updateStats() {
  const vis = state.items.filter((i) => !i.hide);
  const imgs = vis.filter((i) => i.kind === 'image');
  const vids = vis.filter((i) => i.kind === 'video');
  $('nImg').textContent = imgs.filter((i) => usable(i) && (!i.removed || i.force)).length;
  $('nVid').textContent = vids.filter(usable).length;
  const chosen = vis.filter(included);
  const cv = chosen.filter((i) => i.kind === 'video').length;
  const ci = chosen.length - cv;
  const failed = vis.filter((i) => i.status === 'failed').length;
  const removed = imgs.filter((i) => usable(i) && i.removed && !i.force).length;
  const bits = [`${imgs.length} images`, `${vids.length} videos`];
  if (state.loaded < state.total) bits.push(`checking ${state.loaded}/${state.total}`);
  if (removed) bits.push(`${removed} hidden by filters`);
  if (failed) bits.push(`${failed} failed`);
  bits.push(`${chosen.length} selected`);
  $('stats').textContent = bits.join(' · ');
  $('bar').style.width = (state.total ? (state.loaded / state.total) * 100 : 0) + '%';
  $('retry').hidden = !failed || state.loaded < state.total || state.busy;
  const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (!state.busy) $('dl').textContent = `Download ZIP (${[ci ? pl(ci, 'image') : '', cv ? pl(cv, 'video') : ''].filter(Boolean).join(' + ') || 0})`;
  $('dl').disabled = state.busy || !chosen.length || state.loaded < state.total;
}

// ---------- Images ----------
async function decodeSize(blob) {
  try {
    const b = await createImageBitmap(blob);
    const r = { w: b.width, h: b.height, bmp: b };
    return r;
  } catch (e) {
    // SVG and a few others: let an <img> work it out.
    return new Promise((res) => {
      const img = new Image();
      const u = URL.createObjectURL(blob);
      img.onload = () => { res({ w: img.naturalWidth, h: img.naturalHeight, bmp: null }); URL.revokeObjectURL(u); };
      img.onerror = () => { res(null); URL.revokeObjectURL(u); };
      img.src = u;
    });
  }
}

async function fetchImage(url) {
  const r = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const blob = await r.blob();
  if (!blob.size) throw new Error('empty');
  const t = (blob.type || '').toLowerCase();
  if (t && !t.startsWith('image/') && !/octet-stream|binary/.test(t)) throw new Error('not an image');
  return blob;
}

async function loadImage(it) {
  let best = null;
  let tried = 0, worked = 0;
  // Addresses come best first (the original behind a thumbnail, then the largest size
  // the page offers). Compare the first two that work and keep the bigger one.
  for (const url of it.cands) {
    if (tried >= MAX_CANDIDATES || worked >= 2) break;
    tried++;
    try {
      const blob = await fetchImage(url);
      const d = await decodeSize(blob);
      if (!d) continue;
      worked++;
      const area = d.w * d.h;
      if (!best || area > best.area) {
        if (best && best.bmp) best.bmp.close();
        best = { blob, url, w: d.w, h: d.h, area, bmp: d.bmp };
      } else if (d.bmp) d.bmp.close();
    } catch (e) { /* try the next address */ }
  }
  if (!best) { it.status = 'failed'; return; }
  it.blob = best.blob; it.url = best.url; it.w = best.w; it.h = best.h;
  it.ext = extFrom(best.blob.type, best.url);
  it.sha = hex(await crypto.subtle.digest('SHA-256', await best.blob.arrayBuffer()));
  if (best.bmp) {
    try {
      let small;
      try { small = await createImageBitmap(best.bmp, { resizeWidth: 256, resizeHeight: 256, resizeQuality: 'high' }); } catch (e) {
        const c = new OffscreenCanvas(256, 256);
        const cx = c.getContext('2d');
        cx.drawImage(best.bmp, 0, 0, 256, 256);
        small = await createImageBitmap(c);
      }
      it.hash = dhash(small);
      it.mini = miniGray(small);
      small.close();
    } catch (e) { /* no fingerprint: never treated as a duplicate */ }
    best.bmp.close();
  }
  it.thumb = URL.createObjectURL(best.blob);
  it.status = 'ok';
}

function extFrom(type, url) {
  const map = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/tiff': 'tif', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/heic': 'heic' };
  if (map[type]) return map[type];
  const m = /\.(\w{3,4})(?:[?#]|$)/.exec(url.startsWith('data:') ? '' : url);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

const hashCanvas = new OffscreenCanvas(9, 8);
const hashCtx = hashCanvas.getContext('2d', { willReadFrequently: true });
function dhash(bmp) {
  hashCtx.fillStyle = '#fff';
  hashCtx.fillRect(0, 0, 9, 8);
  hashCtx.drawImage(bmp, 0, 0, 9, 8);
  const d = hashCtx.getImageData(0, 0, 9, 8).data;
  let hi = 0, lo = 0, bit = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = (y * 9 + x) * 4, j = i + 4;
      const a = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      const b = d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114;
      if (a > b) { if (bit < 32) hi |= 1 << bit; else lo |= 1 << (bit - 32); }
      bit++;
    }
  }
  return [hi >>> 0, lo >>> 0];
}
const miniCanvas = new OffscreenCanvas(256, 256);
const miniCtx = miniCanvas.getContext('2d', { willReadFrequently: true });
function miniGray(bmp256) {
  miniCtx.fillStyle = '#fff';
  miniCtx.fillRect(0, 0, 256, 256);
  miniCtx.drawImage(bmp256, 0, 0, 256, 256);
  const d = miniCtx.getImageData(0, 0, 256, 256).data;
  const g = new Float32Array(1024);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const i = (y * 256 + x) * 4;
    g[(y >> 3) * 32 + (x >> 3)] += (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 64;
  }
  return g;
}
function looksSame(a, b) {
  let mad = 0, ma = 0, mb = 0;
  for (let i = 0; i < 1024; i++) { mad += Math.abs(a[i] - b[i]); ma += a[i]; mb += b[i]; }
  if (mad / 1024 > NEAR_DUP_PIXEL_DIFF) return false;
  ma /= 1024; mb /= 1024;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < 1024; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  if (!saa || !sbb) return saa === sbb;
  return sab / Math.sqrt(saa * sbb) >= NEAR_DUP_MIN_CORRELATION;
}
function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
const distance = (a, b) => popcount(a[0] ^ b[0]) + popcount(a[1] ^ b[1]);

// ---------- Videos ----------
function probeFile(it) {
  return new Promise((res) => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'metadata';
    const done = () => { v.removeAttribute('src'); v.load(); res(); };
    const t = setTimeout(done, 15000);
    v.onloadedmetadata = () => {
      clearTimeout(t);
      it.w = v.videoWidth || it.w; it.h = v.videoHeight || it.h;
      if (Number.isFinite(v.duration)) it.dur = v.duration;
      done();
    };
    v.onerror = () => { clearTimeout(t); done(); };
    v.src = it.url;
  });
}

async function loadVideo(it) {
  if (it.src === 'file') {
    await probeFile(it);
    if (!it.w && !it.h && !it.size) {
      // Not something this browser can play, but it may still be a real file.
      const r = await fetch(it.url, { method: 'HEAD', credentials: 'include', signal: AbortSignal.timeout(20000) }).catch(() => null);
      if (r && r.ok) it.size = Number(r.headers.get('content-length') || 0);
      if (!r || !r.ok) throw new Error('This video couldn\'t be reached');
    }
    if (it.w && it.w < 120 && it.h < 120) it.hide = true; // a tiny animated decoration
    it.status = 'ok';
    return;
  }
  const info = await resolveStream(it);
  it.info = info;
  it.w = info.width || it.w; it.h = info.height || it.h; it.dur = info.duration || it.dur;
  it.bandwidth = info.bandwidth;
  it.covers = new Set(info.covers);
  if (info.protected) { it.status = 'blocked'; it.blockReason = 'Protected, can\'t be saved'; it.selected = false; return; }
  if (info.live) { it.status = 'blocked'; it.blockReason = 'Live stream'; it.selected = false; return; }
  it.status = 'ok';
  // A real picture from the stream itself (a few seconds of it).
  previewStream(info).then((blob) => {
    if (!blob || !it.el) return;
    const thumb = it.el.querySelector('.thumb');
    const v = el('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true;
    v.onloadeddata = () => { thumb.textContent = ''; thumb.append(v); };
    v.src = URL.createObjectURL(blob) + '#t=0.5';
  }).catch(() => {});
}

// The same video often shows up as a master playlist plus its parts: keep the master.
function hideStreamParts(videos) {
  const streams = videos.filter((v) => v.covers);
  for (const v of videos) {
    for (const s of streams) {
      if (s !== v && s.covers.has(v.url) && !(v.covers && v.covers.has(s.url))) { v.hide = true; v.selected = false; break; }
    }
  }
  // Two different playlists for the same video (HLS and DASH): keep the first.
  const ok = videos.filter((v) => !v.hide && v.info);
  for (let i = 0; i < ok.length; i++) for (let j = i + 1; j < ok.length; j++) {
    const a = ok[i], b = ok[j];
    if (b.hide || !a.dur || Math.abs(a.dur - b.dur) > 1 || a.h !== b.h) continue;
    const ap = a.info.video.parts.length, bp = b.info.video.parts.length;
    if (ap && ap === bp && a.info.kind !== b.info.kind) { b.hide = true; b.selected = false; }
  }
  state.items.forEach(updateCard);
}

async function videoBlob(it, onProgress) {
  if (it.src === 'file') {
    const r = await fetch(it.url, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const total = Number(r.headers.get('content-length') || it.size || 0);
    if (!r.body || !total) return r.blob();
    const reader = r.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      onProgress(got, total);
    }
    return new Blob(parts, { type: r.headers.get('content-type') || 'video/mp4' });
  }
  const res = await saveStream(it.info, onProgress);
  return res.blob;
}

function videoName(it, n) {
  const ext = it.src === 'file' ? (/\.(webm|mov|mkv|ogv|m4v)(?:[?#]|$)/i.exec(it.url) || [0, 'mp4'])[1].toLowerCase() : 'mp4';
  const base = safeName(state.title);
  return `${base}${n ? '_' + n : ''}${it.h ? '_' + it.h + 'p' : ''}.${ext}`;
}

function setProgress(it, frac) {
  const p = it.el && it.el.querySelector('.prog');
  if (!p) return;
  p.hidden = frac == null;
  if (frac != null) p.firstChild.style.width = Math.round(frac * 100) + '%';
}

async function saveOne(it) {
  if (it.saving) return;
  it.saving = true;
  const btn = it.saveBtn;
  btn.disabled = true;
  try {
    btn.textContent = 'Saving...';
    const blob = await videoBlob(it, (a, b) => { setProgress(it, b ? a / b : null); btn.textContent = b ? `Saving ${Math.round((a / b) * 100)}%` : 'Saving...'; });
    await chrome.downloads.download({ url: URL.createObjectURL(blob), filename: videoName(it, 0), saveAs: false });
    btn.textContent = 'Saved';
  } catch (e) {
    console.error(e);
    btn.textContent = 'Failed, try again';
  } finally {
    setProgress(it, null);
    it.saving = false;
    setTimeout(() => { btn.textContent = 'Save this video'; btn.disabled = it.status !== 'ok'; }, 4000);
  }
}

// ---------- Filters ----------
function applyFilters() {
  const s = state.settings;
  const ok = state.items.filter((i) => i.kind === 'image' && i.status === 'ok');
  ok.forEach((i) => { i.removed = ''; });
  const bySha = new Map();
  for (const it of ok) { if (bySha.has(it.sha)) it.removed = 'Duplicate'; else bySha.set(it.sha, it); }
  if (s.nearDup) {
    const pool = ok.filter((i) => !i.removed && i.hash && i.w && i.h).sort((a, b) => b.w * b.h - a.w * a.h);
    const kept = [];
    for (const it of pool) {
      const ar = it.w / it.h;
      const twin = kept.find((k) => Math.abs(k.w / k.h - ar) / ar < 0.05 && distance(k.hash, it.hash) <= NEAR_DUP_DISTANCE && (!k.mini || !it.mini || looksSame(k.mini, it.mini)));
      if (twin) it.removed = 'Smaller copy'; else kept.push(it);
    }
  }
  if (s.minSide > 0) for (const it of ok) if (!it.removed && it.w && Math.min(it.w, it.h) < s.minSide) it.removed = 'Too small';
  // Failed tiny images (spacers, broken links) aren't worth showing.
  state.items.forEach(updateCard);
  updateStats();
}

async function retryFailed() {
  const failed = state.items.filter((i) => i.status === 'failed' && !i.hide);
  state.loaded -= failed.length;
  failed.forEach((i) => { i.status = 'pending'; updateCard(i); });
  updateStats();
  await Promise.all([
    pool(failed.filter((i) => i.kind === 'image'), IMG_CONCURRENCY, loadImage),
    pool(failed.filter((i) => i.kind === 'video'), VID_CONCURRENCY, loadVideo)
  ]);
  applyFilters();
}

// ---------- Download ----------
function safeName(s) {
  return (String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80)) || 'page';
}
function imageName(it, n, pad) {
  let base = '';
  if (!it.url.startsWith('data:')) {
    try {
      const seg = decodeURIComponent(new URL(it.url).pathname.split('/').filter(Boolean).pop() || '');
      base = seg.replace(/\.[a-z0-9]{2,5}$/i, '');
    } catch (e) { /* no name */ }
  }
  base = safeName(base).slice(0, 60);
  return `${String(n).padStart(pad, '0')}${base && base !== 'page' ? '_' + base : ''}.${it.ext}`;
}

async function downloadZip() {
  const list = state.items.filter(included);
  if (!list.length) return;
  state.busy = true;
  updateStats();
  state.items.forEach(updateCard);
  const dl = $('dl');
  const pad = Math.max(3, String(list.length).length);
  const files = [];
  let failed = 0, n = 0, vn = 0;
  try {
    const vids = list.filter((i) => i.kind === 'video');
    for (const it of vids) {
      vn++;
      dl.textContent = `Saving video ${vn}/${vids.length}...`;
      try {
        const blob = await videoBlob(it, (a, b) => { setProgress(it, b ? a / b : null); dl.textContent = `Saving video ${vn}/${vids.length}${b ? ' (' + Math.round((a / b) * 100) + '%)' : ''}...`; });
        files.push({ name: 'videos/' + videoName(it, vids.length > 1 ? vn : 0), blob });
      } catch (e) { console.error(e); failed++; }
      setProgress(it, null);
    }
    const imgs = list.filter((i) => i.kind === 'image');
    for (const it of imgs) files.push({ name: (vids.length ? 'images/' : '') + imageName(it, ++n, pad), blob: it.blob });
    if (!files.length) throw new Error('none of the selected files could be downloaded');

    const groups = [];
    let cur = [], size = 0;
    for (const f of files) {
      if (cur.length && size + f.blob.size > ZIP_PART_LIMIT) { groups.push(cur); cur = []; size = 0; }
      cur.push(f); size += f.blob.size;
    }
    if (cur.length) groups.push(cur);
    for (let g = 0; g < groups.length; g++) {
      const label = groups.length > 1 ? ` part ${g + 1}/${groups.length}` : '';
      const zip = await makeZip(groups[g], (i, t) => { dl.textContent = `Zipping${label} ${i}/${t}...`; });
      await chrome.downloads.download({ url: URL.createObjectURL(zip), filename: safeName(state.title) + (groups.length > 1 ? `-part${g + 1}` : '') + '.zip', saveAs: false });
    }
    dl.textContent = failed ? `Downloaded (${failed} video${failed > 1 ? 's' : ''} failed)` : 'Downloaded';
  } catch (e) {
    console.error(e);
    dl.textContent = 'Download failed: ' + e.message;
  }
  setTimeout(() => { state.busy = false; updateStats(); state.items.forEach(updateCard); }, 3500);
}
