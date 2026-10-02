// kalo'switch Service Worker
// Update ausrollen: Dateien ändern + VERSION hochzählen (ks-v1 -> ks-v2) + pushen.
// Alle App-Dateien kommen aus EINEM Versionsstand – nie neues HTML mit altem app.js.
const VERSION = 'ks-v1';
const CDN_CACHE = 'ks-cdn-1'; // versionierte Bibliotheken (Barcode-Leser, Claude-SDK), überlebt App-Updates
const SHELL = [
  './',
  './index.html',
  './app.js',
  './daten.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];
const CDN = 'https://cdn.jsdelivr.net/';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // am HTTP-Cache vorbei, sonst landet evtl. eine ältere Datei im neuen Versionsstand
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== CDN_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // API-POSTs (Claude) nie anfassen
  const url = req.url;
  const sameOrigin = url.startsWith(self.location.origin);

  if (req.mode === 'navigate') {
    e.respondWith(caches.open(VERSION).then((c) => c.match('./index.html')).then((hit) => hit || fetch(req)));
    return;
  }
  if (sameOrigin) {
    e.respondWith(caches.open(VERSION).then((c) => c.match(req, { ignoreSearch: true })).then((hit) => hit || fetch(req)));
    return;
  }
  if (url.startsWith(CDN)) {
    // Versionierte CDN-Dateien sind unveränderlich → Cache zuerst, sonst laden und merken
    e.respondWith(caches.open(CDN_CACHE).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === 'cors') c.put(req, res.clone());
      return res;
    }))));
  }
  // Alles andere (Open Food Facts, Produktbilder) immer live
});
