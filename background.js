// Page Saver background script.
// 1. Notes the video files and streams each tab loads (so streamed video can be found
//    even when the page only shows a "blob:" player).
// 2. On a toolbar click, looks through the page for images and videos.
// 3. Opens the results tab and makes its downloads look like they come from the page
//    (some sites refuse pictures and videos requested from anywhere else).

const BLOCKED = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|googlevideo\.com|ytimg\.com)$/i;
const MAX_PER_TAB = 300;
const media = new Map(); // tabId -> Map(url -> record)
const pageStart = new Map(); // tabId -> time the current page started loading
const loaded = new Set(); // tabs restored from session storage

function hostOf(u) { try { return new URL(u).hostname; } catch (e) { return ''; } }

async function tabMedia(tabId) {
  if (!media.has(tabId)) media.set(tabId, new Map());
  if (!loaded.has(tabId)) {
    loaded.add(tabId);
    try {
      const k = 'm' + tabId;
      const saved = (await chrome.storage.session.get(k))[k] || [];
      const m = media.get(tabId);
      for (const r of saved) if (!m.has(r.url)) m.set(r.url, r);
    } catch (e) { /* session storage not available */ }
  }
  return media.get(tabId);
}

const saveTimers = new Map();
function persist(tabId) {
  clearTimeout(saveTimers.get(tabId));
  saveTimers.set(tabId, setTimeout(() => {
    const m = media.get(tabId);
    if (!m) return;
    chrome.storage.session.set({ ['m' + tabId]: [...m.values()] }).catch(() => {});
  }, 500));
}

function classify(d) {
  if (d.tabId < 0 || !/^https?:/.test(d.url)) return null;
  if (d.statusCode && (d.statusCode < 200 || d.statusCode > 299)) return null;
  let u;
  try { u = new URL(d.url); } catch (e) { return null; }
  if (BLOCKED.test(u.hostname)) return null;
  const h = {};
  for (const x of d.responseHeaders || []) h[x.name.toLowerCase()] = x.value || '';
  const ct = (h['content-type'] || '').toLowerCase().split(';')[0].trim();
  const path = u.pathname.toLowerCase();
  if (/mpegurl/.test(ct) || /\.m3u8$/.test(path)) return { src: 'hls' };
  if (ct === 'application/dash+xml' || /\.mpd$/.test(path)) return { src: 'dash' };
  if (/\.(ts|m4s|m4a|aac|mp3|vtt|webvtt|srt|key|cmfv|cmfa)$/.test(path) || ct === 'video/mp2t' || ct.startsWith('audio/')) return null;
  const isVid = ct.startsWith('video/') || (/\.(mp4|webm|mov|m4v|mkv|ogv)$/.test(path) && (!ct || /octet-stream/.test(ct)));
  if (!isVid) return null;
  let size = 0;
  const cr = /\/(\d+)\s*$/.exec(h['content-range'] || '');
  if (cr) size = Number(cr[1]);
  else if (h['content-length']) size = Number(h['content-length']);
  if (size && size < 120000) return null; // too small to be a real video (often a stream piece)
  return { src: 'file', size, mime: ct };
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    const c = classify(d);
    if (!c) return;
    tabMedia(d.tabId).then((m) => {
      // Events can arrive out of order: ignore anything from before the current page.
      if (d.timeStamp < (pageStart.get(d.tabId) || 0)) return;
      const key = d.url;
      const old = m.get(key);
      if (old) { if (c.size > (old.size || 0)) old.size = c.size; return; }
      if (m.size >= MAX_PER_TAB) return;
      m.set(key, { url: d.url, ...c, seen: d.timeStamp, frame: d.frameId });
      persist(d.tabId);
    });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object', 'sub_frame'] },
  ['responseHeaders']
);

// A new page in the tab starts a fresh list.
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0) return;
    if (d.timeStamp < (pageStart.get(d.tabId) || 0)) return;
    pageStart.set(d.tabId, d.timeStamp);
    // Drop what the previous page loaded (but keep anything this page already loaded).
    tabMedia(d.tabId).then((m) => {
      for (const [k, rec] of m) if (!(rec.seen >= d.timeStamp)) m.delete(k);
      persist(d.tabId);
    });
  },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  media.delete(tabId);
  pageStart.delete(tabId);
  chrome.storage.session.remove('m' + tabId).catch(() => {});
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] }).catch(() => {});
});

async function openHelp(kind, tab) {
  await chrome.tabs.create({ url: chrome.runtime.getURL('results.html?help=' + kind), index: tab ? tab.index + 1 : undefined });
}

chrome.action.onClicked.addListener(async (tab) => {
  // Firefox lets people switch off site access, so ask for it again if needed.
  try {
    const ok = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    if (!ok) {
      const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
      if (!granted) return openHelp('access', tab);
    }
  } catch (e) { /* not supported: nothing to ask */ }
  const host = hostOf(tab.url || '');
  if (BLOCKED.test(host)) return openHelp('youtube', tab);
  if (!/^https?:/.test(tab.url || '') && !/^file:/.test(tab.url || '')) return openHelp('page', tab);
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['scan.js'] });
  } catch (e) {
    console.error('Page Saver: could not read this page', e);
    openHelp('page', tab);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return;
  if (msg.type === 'ps-scan') {
    const tab = sender.tab;
    (async () => {
      const m = await tabMedia(tab.id);
      const id = 'job_' + Date.now();
      const job = { ...msg.job, network: [...m.values()], tabId: tab.id, created: Date.now() };
      await chrome.storage.local.set({ [id]: job });
      await chrome.tabs.create({ url: chrome.runtime.getURL('results.html?job=' + id), index: tab.index + 1 });
      reply({ ok: true });
    })().catch((e) => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'ps-referer') {
    // Requests from this results tab carry the original page as referrer and origin.
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) { reply({ ok: false }); return; }
    let origin = '';
    try { origin = new URL(msg.source).origin; } catch (e) { /* leave blank */ }
    const headers = [{ header: 'referer', operation: 'set', value: msg.source }];
    if (origin && origin !== 'null') headers.push({ header: 'origin', operation: 'set', value: origin });
    chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [tabId],
      addRules: [{
        id: tabId, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: headers },
        condition: { tabIds: [tabId], resourceTypes: ['xmlhttprequest', 'media', 'image', 'other'] }
      }]
    }).then(() => reply({ ok: true }), (e) => reply({ ok: false, error: String(e) }));
    return true;
  }
});
