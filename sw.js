// Кэширует только сам редактор (без текста романа), чтобы он открывался без сети.
// Главы и заметки хранятся в памяти браузера телефона, а не здесь.
const CACHE = 'chuzhoy-syn-editor-v9';
const SHELL = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('chuzhoy-syn-editor-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const shellUrls = SHELL.map(path => new URL(path, self.registration.scope).pathname);
  if (!shellUrls.includes(url.pathname)) return;
  // Сначала из кэша (работает без сети), параллельно обновляем кэш из сети.
  const fresh = caches.open(CACHE).then(async cache => {
    const response = await fetch(e.request);
    if (response.ok) await cache.put(e.request, response.clone());
    return response;
  }).catch(() => null);
  e.waitUntil(fresh);
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    return cached || (await fresh) || cache.match('index.html');
  }));
});
