// The deploy workflow stamps BUILD with the commit, so every push changes this
// file's bytes. That is what makes browsers install the new worker: no version
// to bump by hand.
//
// Network first, cache as the fallback: online you always get the latest
// deploy, offline the app still opens. Data lives in IndexedDB, never here.
const BUILD = '__BUILD__';
const CACHE = `financetracker-${BUILD}`;
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './css/app.css',
  './js/app.js', './js/analyzer.js', './js/categorizer.js', './js/csv.js',
  './js/storage.js', './js/sync.js', './js/version.js', './js/insights.js', './js/demo.js', './js/watch.js', './js/links.js',
  './js/tax.js', './js/income.js', './js/plaid.js',
  './vendor/chart.umd.min.js', './vendor/fonts/jetbrains-mono.woff2',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  // cache: 'reload' skips the HTTP cache, or a fresh worker could precache files
  // GitHub Pages let the browser keep for 10 minutes.
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('financetracker-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Files shared to the installed app (Android: Share > FinanceTracker) arrive as
// a form post. They wait in a small cache until the page opens and reads them.
const INBOX = 'ft-inbox';
async function receiveShare(request) {
  try {
    const form = await request.formData();
    const files = [];
    for (const f of form.getAll('files')) if (f && f.text) files.push({ name: f.name, text: await f.text() });
    if (files.length) {
      const cache = await caches.open(INBOX);
      await cache.put(`./__inbox/${Date.now()}`, new Response(JSON.stringify(files), { headers: { 'Content-Type': 'application/json' } }));
    }
  } catch {}
  return Response.redirect('./', 303);
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // GitHub API goes straight out
  e.respondWith(
    // 'no-cache' revalidates with the server (a cheap 304 when nothing changed),
    // so a deploy shows up on the next load rather than ten minutes later.
    fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' })
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })
        .then(hit => hit || (e.request.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});
