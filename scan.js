// Page Saver: injected when the toolbar icon is clicked. Scrolls the page so lazy
// images load, then lists every image (at the biggest size the site offers) and every
// video on the page, and hands the list to the results tab.
(() => {
  if (window.__psActive) return;
  window.__psActive = true;
  const COLOR = '#ea580c';
  const MAX_SCROLL_STEPS = 60;
  const MAX_IMAGES = 4000;
  let stop = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- Progress panel ----------
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    .box{font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#111;color:#fff;border-radius:14px;padding:14px 16px;width:290px;box-shadow:0 8px 30px rgba(0,0,0,.35)}
    .t{font-weight:700;font-size:13px;opacity:.8}
    .n{font-size:22px;font-weight:800;margin:4px 0}
    .s{opacity:.85;min-height:20px}
    button{margin-top:10px;background:${COLOR};color:#fff;border:0;border-radius:999px;padding:8px 14px;font-weight:700;cursor:pointer}`;
  const box = document.createElement('div');
  box.className = 'box';
  const line = (cls, text, tag = 'div') => { const e = document.createElement(tag); e.className = cls; e.textContent = text; box.appendChild(e); return e; };
  line('t', 'Page Saver');
  const $n = line('n', 'Looking...');
  const $s = line('s', 'Starting...');
  let $b = line('', 'Stop scrolling and use what\'s found', 'button');
  $b.onclick = () => { stop = true; $s.textContent = 'Stopping...'; };
  root.append(style, box);
  document.documentElement.appendChild(host);
  const close = () => { host.remove(); window.__psActive = false; };
  const finish = (msg, delay = 4000) => { $s.textContent = msg; if ($b) { $b.remove(); $b = null; } if (delay) setTimeout(close, delay); };

  // ---------- Helpers ----------
  const IMG_EXT = /\.(jpe?g|jfif|png|gif|webp|avif|bmp|tiff?|svg|heic)(?:[?#]|$)/i;
  const VID_EXT = /\.(mp4|webm|mov|m4v|mkv|ogv)(?:[?#]|$)/i;
  const BLOCKED = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|googlevideo\.com|ytimg\.com)$/i;

  function abs(u) {
    if (!u) return null;
    u = String(u).trim();
    if (!u || u.startsWith('#') || /^(javascript|about|blob|chrome|mailto):/i.test(u)) return null;
    if (u.startsWith('data:')) return u.length > 1500 && /^data:image\//i.test(u) ? u : null;
    try {
      const x = new URL(u, document.baseURI);
      if (!/^https?:$/.test(x.protocol) && x.protocol !== 'file:') return null;
      if (BLOCKED.test(x.hostname)) return null;
      return x.href;
    } catch (e) { return null; }
  }

  // srcset: "a.jpg 400w, b.jpg 800w" (URLs can contain commas, so read it token by token)
  function srcset(ss) {
    const out = [];
    if (!ss) return out;
    const toks = String(ss).trim().split(/\s+/);
    for (let i = 0; i < toks.length; i++) {
      let url = toks[i];
      let desc = '';
      if (url.endsWith(',')) url = url.slice(0, -1);
      else if (i + 1 < toks.length && /^[\d.]+[wxh],?$/.test(toks[i + 1])) { desc = toks[++i].replace(/,$/, ''); }
      if (!url) continue;
      const n = parseFloat(desc) || 1;
      out.push({ url, score: desc.endsWith('w') ? n : desc.endsWith('h') ? n : n * 1000 });
    }
    return out.sort((a, b) => b.score - a.score).map((x) => x.url);
  }

  // Well-known ways sites shrink pictures, undone to reach the original.
  function upgrades(u) {
    if (!u || u.startsWith('data:')) return [];
    const out = [];
    let x;
    try { x = new URL(u); } catch (e) { return []; }
    const h = x.hostname, p = x.pathname;
    const add = (v) => { if (v && v !== u && !out.includes(v)) out.push(v); };
    const imgRe = /\.(jpe?g|png|gif|webp|avif)$/i;
    // WordPress: photo-300x200.jpg -> photo.jpg (and photo-scaled.jpg -> photo.jpg)
    if (/-\d{2,5}x\d{2,5}\.(jpe?g|png|gif|webp|avif)$/i.test(p)) { const y = new URL(u); y.pathname = p.replace(/-\d{2,5}x\d{2,5}(\.\w+)$/, '$1'); add(y.href); }
    if (/-scaled\.(jpe?g|png|webp)$/i.test(p)) { const y = new URL(u); y.pathname = p.replace(/-scaled(\.\w+)$/, '$1'); add(y.href); }
    // Wikimedia thumbnails
    const wm = /^(\/wikipedia\/[^/]+)\/thumb\/(.+?)\/[^/]+$/.exec(p);
    if (/(upload|thumb)\.wikimedia\.org$/.test(h) && wm) add(`https://upload.wikimedia.org${wm[1]}/${wm[2]}`);
    // BBC: /news/240/... -> /news/2048/...
    if (/ichef\.bbci\.co\.uk$/.test(h) && /^\/(news|ace\/standard|ace\/ws|images\/ic)\/\d+(x\d+)?\//.test(p)) {
      const y = new URL(u); y.pathname = p.replace(/^\/(news|ace\/standard|ace\/ws|images\/ic)\/\d+(x\d+)?\//, (m, a1, a2) => `/${a1}/${a2 ? '2048x1152' : '2048'}/`); add(y.href);
    }
    // Twitter / X
    if (/pbs\.twimg\.com$/.test(h) && x.searchParams.has('name')) { const y = new URL(u); y.searchParams.set('name', 'orig'); add(y.href); }
    // Pinterest
    if (/i\.pinimg\.com$/.test(h) && /^\/\d+x\d*\//.test(p)) { const y = new URL(u); y.pathname = p.replace(/^\/\d+x\d*\//, '/originals/'); add(y.href); }
    // Reddit previews
    if (/^(preview|external-preview)\.redd\.it$/.test(h) && h.startsWith('preview')) add(`https://i.redd.it${p}`);
    // Google (Blogger, Photos, Play)
    if (/(googleusercontent\.com|ggpht\.com|bp\.blogspot\.com)$/.test(h)) {
      if (/=[swh]\d+[^/]*$/.test(u)) add(u.replace(/=[swh]\d+[^/]*$/, '=s0'));
      if (/\/[swh]\d+(-[a-z0-9-]+)?\/[^/]+$/.test(p)) { const y = new URL(u); y.pathname = p.replace(/\/[swh]\d+(-[a-z0-9-]+)?\/([^/]+)$/, '/s0/$2'); add(y.href); }
    }
    // Shopify: photo_300x300.jpg, photo_small.jpg
    if (/cdn\.shopify\.com$/.test(h) || /\/cdn\/shop\//.test(p)) {
      const y = new URL(u);
      y.pathname = p.replace(/_(\d+x\d*|x\d+|pico|icon|thumb|small|compact|medium|large|grande|\d+x\d+_crop_\w+)(@\dx)?(\.\w+)$/i, '$3');
      ['width', 'height', 'crop'].forEach((k) => y.searchParams.delete(k));
      add(y.href);
    }
    // Amazon: photo._AC_SX300_.jpg -> photo.jpg
    if (/(media-amazon\.com|images-amazon\.com|ssl-images-amazon\.com)$/.test(h) && /\._[^/]+_\.(jpe?g|png|gif|webp)$/i.test(p)) {
      const y = new URL(u); y.pathname = p.replace(/\._[^/]+_(\.\w+)$/, '$1'); add(y.href);
    }
    // eBay
    if (/i\.ebayimg\.com$/.test(h) && /\/s-l\d+\./.test(p)) { const y = new URL(u); y.pathname = p.replace(/\/s-l\d+\./, '/s-l1600.'); add(y.href); }
    // Etsy
    if (/i\.etsystatic\.com$/.test(h) && /il_\d+x\d+\./.test(p)) { const y = new URL(u); y.pathname = p.replace(/il_\d+x\d+\./, 'il_fullxfull.'); add(y.href); }
    // Cloudinary: /image/upload/w_300,c_fill/v123/x.jpg -> /image/upload/v123/x.jpg
    if (/\/image\/upload\/[^/]*\b(w|h|c|q|f|dpr)_[^/]*\//.test(p)) { const y = new URL(u); y.pathname = p.replace(/(\/image\/upload\/)(?:[^/]*\b(?:w|h|c|q|f|dpr)_[^/]*\/)+/, '$1'); add(y.href); }
    // Resize settings in the address (imgix, Unsplash, many CDNs), unless the address is signed.
    // (read the keys by hand: Firefox doesn't let extensions loop over searchParams here)
    const keys = x.search.replace(/^\?/, '').split('&').filter(Boolean).map((kv) => { try { return decodeURIComponent(kv.split('=')[0]); } catch (e) { return kv.split('=')[0]; } });
    const signed = keys.some((k) => /^(s|sig|signature|token|expires|x-amz-signature|hmac|key|policy)$/i.test(k));
    const sizeKeys = keys.filter((k) => /^(w|h|width|height|resize|fit|crop|q|quality|dpr|size|sz|maxwidth|maxheight|mw|mh|scale|thumb|thumbnail|auto)$/i.test(k));
    if (!signed && sizeKeys.length) {
      const y = new URL(u);
      sizeKeys.forEach((k) => y.searchParams.delete(k));
      if (imgRe.test(y.pathname) || /imgix|unsplash|cloudfront|akamai|fastly|images\./i.test(h) || IMG_EXT.test(y.href)) add(y.href);
    }
    return out;
  }

  // ---------- Collecting ----------
  const images = new Map(); // first candidate -> item
  const urlToKey = new Map();
  const videos = new Map();
  const posters = [];

  function addImage(cands, meta) {
    const list = [];
    for (const c of cands) {
      const a = abs(c);
      if (!a) continue;
      for (const up of upgrades(a)) if (!list.includes(up)) list.push(up);
      if (!list.includes(a)) list.push(a);
    }
    if (!list.length) return;
    // Merge with an item we already have that shares any of these addresses.
    let key = null;
    for (const u of list) if (urlToKey.has(u)) { key = urlToKey.get(u); break; }
    if (key) {
      const it = images.get(key);
      for (const u of list) if (!it.cands.includes(u)) it.cands.push(u);
      list.forEach((u) => urlToKey.set(u, key));
      if (!it.alt && meta.alt) it.alt = meta.alt;
      return;
    }
    if (images.size >= MAX_IMAGES) return;
    key = list[0];
    images.set(key, { kind: 'image', cands: list, alt: meta.alt || '', from: meta.from || 'img', order: images.size });
    list.forEach((u) => urlToKey.set(u, key));
  }

  function lazyAttrs(el) {
    const out = [];
    for (const a of ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-url', 'data-full', 'data-full-src', 'data-fullsrc',
      'data-large', 'data-large-src', 'data-hi-res', 'data-hires', 'data-zoom-image', 'data-zoom', 'data-image', 'data-img', 'data-orig-file', 'data-large-file']) {
      const v = el.getAttribute(a);
      if (v && !/^\s*[{[]/.test(v)) out.push(v);
    }
    for (const a of ['data-srcset', 'data-lazy-srcset', 'data-src-set']) out.push(...srcset(el.getAttribute(a)));
    return out;
  }

  function collect() {
    // <img> and <picture>
    for (const img of document.images) {
      const cands = [];
      const link = img.closest('a[href]');
      if (link && IMG_EXT.test(link.getAttribute('href') || '')) cands.push(link.getAttribute('href'));
      const pic = img.parentElement && img.parentElement.tagName === 'PICTURE' ? img.parentElement : null;
      if (pic) for (const s of pic.querySelectorAll('source')) cands.push(...srcset(s.getAttribute('srcset') || s.getAttribute('data-srcset')));
      cands.push(...srcset(img.getAttribute('srcset')), ...lazyAttrs(img));
      if (img.currentSrc) cands.push(img.currentSrc);
      if (img.getAttribute('src')) cands.push(img.getAttribute('src'));
      if (img.naturalWidth && img.naturalWidth <= 2 && img.naturalHeight <= 2 && cands.length <= 1) continue; // tracking pixel
      addImage(cands, { alt: img.alt, from: 'img' });
    }
    // Elements that hold an image address but aren't <img> yet (lazy loaders)
    for (const el of document.querySelectorAll('[data-src],[data-srcset],[data-bg],[data-background],[data-background-image],[data-lazy-src]')) {
      if (el.tagName === 'IMG') continue;
      const c = [...lazyAttrs(el)];
      for (const a of ['data-bg', 'data-background', 'data-background-image']) {
        const v = el.getAttribute(a);
        if (v) { const m = /url\((['"]?)(.*?)\1\)/.exec(v); c.push(m ? m[2] : v); }
      }
      const good = c.filter((u) => IMG_EXT.test(u) || /^data:image/.test(u) || /\/(image|img|photo|media)s?\//i.test(u));
      if (good.length) addImage(good, { from: 'lazy' });
    }
    // Links straight to image files (galleries)
    for (const a of document.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href');
      if (IMG_EXT.test(h || '') && !a.querySelector('img')) addImage([h], { from: 'link' });
      if (VID_EXT.test(h || '')) addVideo(h, { from: 'link' });
    }
    // CSS backgrounds
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    const n = Math.min(all.length, 8000);
    for (let i = 0; i < n; i++) {
      const el = all[i];
      if (el.offsetWidth < 48 || el.offsetHeight < 48) continue;
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === 'none' || !bg.includes('url(')) continue;
      const re = /url\((['"]?)(.*?)\1\)/g;
      let m;
      while ((m = re.exec(bg))) addImage([m[2]], { from: 'css' });
    }
    // Page preview images
    for (const sel of ['meta[property="og:image"]', 'meta[property="og:image:url"]', 'meta[name="twitter:image"]', 'link[rel="image_src"]']) {
      for (const m of document.querySelectorAll(sel)) addImage([m.getAttribute('content') || m.getAttribute('href')], { from: 'meta' });
    }
    // Videos
    for (const v of document.querySelectorAll('video')) {
      const srcs = [v.currentSrc, v.getAttribute('src'), ...[...v.querySelectorAll('source')].map((s) => s.getAttribute('src'))];
      let added = false;
      for (const s of srcs) if (s && !s.startsWith('blob:') && addVideo(s, { poster: v.poster, w: v.videoWidth, h: v.videoHeight, dur: v.duration })) added = true;
      if (v.poster && abs(v.poster) && !posters.includes(abs(v.poster))) posters.push(abs(v.poster));
      void added;
    }
    // Streams the page's player loaded (a second source alongside what the extension saw).
    try {
      for (const e of performance.getEntriesByType('resource')) {
        const u = e.name;
        if (/\.(m3u8|mpd)(\?|$)/i.test(u)) addVideo(u, {});
        else if (e.initiatorType === 'video' && VID_EXT.test(u)) addVideo(u, {});
      }
    } catch (e) { /* not available */ }
    for (const m of document.querySelectorAll('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"]')) {
      const c = m.getAttribute('content');
      if (c && VID_EXT.test(c)) addVideo(c, { from: 'meta' });
    }
    const pics = images.size, vids = videos.size;
    $n.textContent = `${pics} image${pics === 1 ? '' : 's'} · ${vids} video${vids === 1 ? '' : 's'}`;
  }

  function addVideo(u, meta) {
    const a = abs(u);
    if (!a || a.startsWith('data:')) return false;
    const src = /\.m3u8(\?|$)/i.test(a) ? 'hls' : /\.mpd(\?|$)/i.test(a) ? 'dash' : 'file';
    if (!videos.has(a)) videos.set(a, { kind: 'video', src, url: a, poster: abs(meta.poster) || '', w: meta.w || 0, h: meta.h || 0, dur: Number.isFinite(meta.dur) ? meta.dur : 0 });
    return true;
  }

  // ---------- Scrolling ----------
  async function scrollPage() {
    const startY = window.scrollY;
    const el = document.scrollingElement || document.documentElement;
    let idle = 0, lastH = el.scrollHeight;
    for (let i = 0; i < MAX_SCROLL_STEPS && !stop; i++) {
      const before = images.size;
      window.scrollBy(0, Math.round(window.innerHeight * 0.9));
      await sleep(650);
      collect();
      const atBottom = window.innerHeight + window.scrollY >= el.scrollHeight - 40;
      const grew = images.size > before || el.scrollHeight > lastH;
      lastH = el.scrollHeight;
      idle = grew ? 0 : idle + 1;
      $s.textContent = 'Scrolling so every image loads...';
      if (atBottom && idle >= 2) break;
    }
    window.scrollTo(0, startY);
    await sleep(300);
  }

  (async () => {
    try {
      collect();
      $s.textContent = 'Scrolling so every image loads...';
      const scrollable = (document.scrollingElement || document.documentElement).scrollHeight > window.innerHeight * 1.3;
      if (scrollable) await scrollPage();
      collect();
      if ($b) { $b.remove(); $b = null; }
      $s.textContent = 'Opening results...';
      const job = {
        title: document.title || location.hostname,
        source: location.href,
        host: location.hostname,
        images: [...images.values()],
        videos: [...videos.values()],
        posters
      };
      chrome.runtime.sendMessage({ type: 'ps-scan', job }, () => {
        void chrome.runtime.lastError;
        finish(`Done. Sent ${images.size} images and ${videos.size} videos to the results tab. Streamed videos are added there.`);
      });
    } catch (e) {
      finish('Something went wrong reading this page: ' + e.message, 8000);
    }
  })();
})();
