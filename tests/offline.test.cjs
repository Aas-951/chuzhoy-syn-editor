const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function worker() {
  const current = fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8').match(/CACHE = '([^']+)'/)[1];
  const handlers = {}, entries = new Map(), deleted = [], names = ['unrelated-cache', 'chuzhoy-syn-editor-v1', current];
  let online = true;
  const response = text => ({ ok: true, text, clone() { return response(text); } });
  const root = 'https://example.test/chuzhoy-syn-editor/';
  const key = req => new URL(typeof req === 'string' ? req : req.url, root).pathname;
  const cache = { async addAll(files) { for (const file of files) entries.set(key(file), response('cached ' + file)); }, async match(req) { return entries.get(key(req)); }, async put(req, value) { entries.set(key(req), value); } };
  const ctx = vm.createContext({ URL, setTimeout: (f, ms) => setTimeout(f, ms).unref(), location: { origin: 'https://example.test' }, self: { registration: { scope: root }, clients: { claim: async () => {} }, skipWaiting: async () => {}, addEventListener(name, handler) { handlers[name] = handler; } },
    caches: { open: async () => cache, keys: async () => names, delete: async name => { deleted.push(name); } },
    fetch: async () => { if (!online) throw Error('offline'); return response('fresh'); },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8'), ctx);
  const event = (url, method = 'GET') => {
    let answer; const waits = [];
    const e = { request: { url, method }, waitUntil(p) { waits.push(p); }, respondWith(p) { answer = p; } };
    handlers.fetch(e); return { answer, waits };
  };
  return { handlers, entries, deleted, event, offline() { online = false; }, root };
}

test('installed app shell reopens without internet', async () => {
  const w = worker();let install;w.handlers.install({waitUntil(p){install=p;}});await install;w.offline();
  const e=w.event(w.root);assert.match((await e.answer).text,/cached/);await Promise.all(e.waits);
  assert.ok(w.entries.has('/chuzhoy-syn-editor/app.js'));
});

test('service worker never intercepts GitHub or unrelated paths', () => {
  const w=worker();assert.equal(w.event('https://api.github.com/repos/private').answer,undefined);
  assert.equal(w.event('https://example.test/another-app/').answer,undefined);
  assert.equal(w.event(w.root+'app.js','POST').answer,undefined);
});

test('upgrade removes only editor-owned obsolete shell caches', async () => {
  const w=worker();let activate;w.handlers.activate({waitUntil(p){activate=p;}});await activate;
  assert.deepEqual(w.deleted,['chuzhoy-syn-editor-v1']);
});

test('refresh remains part of service worker event lifetime', async () => {
  const w=worker();const e=w.event(w.root+'app.js');assert.equal(e.waits.length,1);await Promise.all(e.waits);
  assert.equal((await e.answer).text,'fresh');
});

test('online the fresh app is served first, and the shown version matches the cache name', async () => {
  const w=worker();let install;w.handlers.install({waitUntil(p){install=p;}});await install;
  assert.equal((await w.event(w.root+'app.js').answer).text,'fresh');
  const sw=fs.readFileSync(path.join(__dirname,'../sw.js'),'utf8'),app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
  assert.equal(app.match(/APP_VERSION = (\d+)/)[1],sw.match(/editor-v(\d+)/)[1]);
});
