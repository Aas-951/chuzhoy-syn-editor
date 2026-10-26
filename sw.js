// Кэширует только сам редактор (без текста романа), чтобы он открывался без сети.
// Главы и заметки хранятся в памяти браузера телефона, а не здесь.
const CACHE = 'chuzhoy-syn-editor-v21';
const SHELL = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  // Existing version 10 reloads immediately on controllerchange. Let the new
  // page activate this worker at a safe moment; never interrupt an old form.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener('message', e => {
  if (e.data?.type === 'ACTIVATE_UPDATE') e.waitUntil(self.skipWaiting());
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
  // Сначала из сети, чтобы обновление приходило сразу; без сети или при медленной сети (4 с) — из кэша.
  const fresh = caches.open(CACHE).then(async cache => {
    const response = await fetch(e.request, { cache: 'no-cache' });
    if (response.ok) await cache.put(e.request, response.clone());
    return response.ok ? response : null;
  }).catch(() => null);
  e.waitUntil(fresh);
  const slow = new Promise(r => setTimeout(r, 4000));
  e.respondWith(caches.open(CACHE).then(async cache => {
    const fromCache = () => cache.match(e.request, { ignoreSearch: true });
    const first = await Promise.race([fresh, slow.then(() => 'slow')]);
    if (first && first !== 'slow') return first;
    return (await fromCache()) || (await fresh) || cache.match('index.html');
  }));
});
