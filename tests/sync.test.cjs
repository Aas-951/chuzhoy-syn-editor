const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8').split('// ---------- запуск ----------')[0];
const manifestPath = 'редактор/главы.json', proposalsPath = 'редактор/предложения.json';
const notesPath = 'редактор/заметки/gpt17.json';
const chapter = { id: 'gpt17', edition: 'gpt', title: '17. Глава Codex', file: 'codex/главы/17.md' };
const vaal = { id: 'ch03', edition: 'vaal', title: '3. Глава Ваала', file: 'vaal.md' };
const sha = text => crypto.createHash('sha1').update('blob ' + Buffer.byteLength(text) + '\0').update(text).digest('hex');

function harness() {
  const files = new Map(), storage = new Map(), elements = new Map();
  const put = (path, text) => files.set(path, { text, sha: sha(text) });
  put(manifestPath, JSON.stringify({ editions: [{ id: 'gpt', title: 'Codex · 17 глав' }, { id: 'vaal', title: 'Адриан Ваал' }], chapters: [vaal, chapter] }));
  put(proposalsPath, '{"proposals":[]}'); put(chapter.file, 'Исходный текст'); put(vaal.file, 'Ваал');
  let onRequest = null, failStorage = false, calls = 0;
  const node = () => ({ innerHTML: '', textContent: '', hidden: false, open: false, classList: { toggle() {} }, querySelectorAll() { return []; } });
  const ctx = vm.createContext({ console, TextEncoder, TextDecoder, Uint8Array, URL, Date,
    atob: x => Buffer.from(x, 'base64').toString('binary'), btoa: x => Buffer.from(x, 'binary').toString('base64'),
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() {}, alert() {}, confirm() { return true; },
    navigator: { onLine: true }, window: { scrollTo() {} },
    localStorage: { getItem: k => storage.get(k) || null, setItem(k, v) { if (failStorage) throw Error('quota'); storage.set(k, v); }, removeItem: k => storage.delete(k) },
    document: { querySelector(s) { if (!elements.has(s)) elements.set(s, node()); return elements.get(s); }, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { style: { setProperty() {} } } },
    async fetch(url, options = {}) {
      calls++;
      const u = new URL(url), method = options.method || 'GET';
      const path = decodeURIComponent(u.pathname.split('/contents/')[1] || '');
      if (onRequest) { const result = await onRequest({ path, method, options, put, files }); if (result) return result; }
      const response = (status, value) => ({ ok: status < 400, status, json: async () => value });
      if (u.pathname.includes('/git/trees/')) return response(200, { tree: [...files].map(([path, f]) => ({ path, sha: f.sha, type: 'blob' })) });
      if (u.pathname.includes('/git/blobs/')) { const f = [...files.values()].find(f => f.sha === u.pathname.split('/').at(-1)); return response(200, { content: Buffer.from(f.text).toString('base64') }); }
      if (method === 'GET') { const f = files.get(path); return f ? response(200, { sha: f.sha, content: Buffer.from(f.text).toString('base64') }) : response(404, {}); }
      assert.equal(method, 'PUT');
      const body = JSON.parse(options.body), current = files.get(path);
      if (current ? body.sha !== current.sha : !!body.sha) return response(409, { message: 'sha changed' });
      put(path, Buffer.from(body.content, 'base64').toString('utf8'));
      return response(200, { content: { sha: files.get(path).sha } });
    },
  });
  vm.runInContext(source, ctx);
  const run = code => vm.runInContext(code, ctx);
  run('cfg = { owner: "test", repo: "private", token: "test-only" }; render = () => {};');
  const cache = Object.fromEntries(files);
  run('data.files = ' + JSON.stringify(cache));
  return { run, files, storage, elements, put, ctx, hook: f => { onRequest = f; }, quota: value => { failStorage = value; }, calls: () => calls };
}

test('offline edit survives in persisted queue; no network attempted', async () => {
  const h = harness(); h.run('navigator.onLine = false; enqueue({type:"edit",chapter:"gpt17",base:data.files["codex/главы/17.md"].sha,text:"Моя правка"})');
  await h.run('sync()'); assert.equal(h.calls(), 0);
  assert.equal(JSON.parse(h.storage.get('cs.queue'))[0].text, 'Моя правка');
});

test('lost PUT response retries without a false conflict', async () => {
  const h = harness(); h.run('enqueue({type:"edit",chapter:"gpt17",base:data.files["codex/главы/17.md"].sha,text:"Правка"})');
  let fail = true;
  h.hook(({path, method, options, put}) => { if (method === 'PUT' && path === chapter.file && fail) { fail = false; put(path, Buffer.from(JSON.parse(options.body).content,'base64').toString()); throw Error('lost response'); } });
  await assert.rejects(h.run('pushQueue()')); await h.run('pushQueue()');
  assert.equal(h.run('queue.length'), 0); assert.equal([...h.files.keys()].filter(p => p.includes('конфликты')).length, 0);
});

test('conflicting author edit keeps both versions', async () => {
  const h = harness(); h.run('enqueue({type:"edit",chapter:"gpt17",base:data.files["codex/главы/17.md"].sha,text:"С телефона"})');
  h.put(chapter.file, 'Изменено агентом'); await h.run('pushQueue()');
  assert.equal(h.files.get(chapter.file).text, 'Изменено агентом');
  assert.equal([...h.files].find(([p]) => p.includes('конфликты'))[1].text, 'С телефона');
});

test('typing during a save stays queued and is rebased on own saved text', async () => {
  const h = harness(); h.run('enqueue({type:"edit",chapter:"gpt17",base:data.files["codex/главы/17.md"].sha,text:"Первая"})');
  let once = true;
  h.hook(({path, method}) => { if (path === chapter.file && method === 'PUT' && once) { once = false; h.run('enqueue({type:"edit",chapter:"gpt17",text:"Вторая"})'); } });
  await h.run('pushQueue()'); assert.equal(h.run('queue.length'), 1);
  assert.equal(h.run('queue[0].base'), h.files.get(chapter.file).sha);
  await h.run('pushQueue()'); assert.equal(h.files.get(chapter.file).text, 'Вторая'); assert.equal(h.run('queue.length'), 0);
});

test('note save retries CAS while keeping both agent and author replies', async () => {
  const h = harness(); h.put(notesPath, JSON.stringify({chapter:'gpt17',notes:[{id:'n1',replies:[{id:'gpt',by:'GPT',text:'Ответ GPT'}]}]}));
  h.run('enqueue({type:"note-reply",chapter:"gpt17",id:"n1",reply:{id:"author",by:"автор",text:"Спасибо"}})');
  let once = true;
  h.hook(({path,method,files,put}) => { if (path === notesPath && method === 'PUT' && once) { once = false; const j=JSON.parse(files.get(path).text);j.notes[0].replies.push({id:'claude',by:'Claude',text:'Ответ Claude'});put(path,JSON.stringify(j)); } });
  await h.run('pushQueue()'); const replies=JSON.parse(h.files.get(notesPath).text).notes[0].replies;
  assert.deepEqual(replies.map(r=>r.id), ['gpt','claude','author']);
});

function proposal(h, base = h.files.get(chapter.file).sha, status='pending') {
  h.put(proposalsPath, JSON.stringify({ proposals:[{id:'p1',chapter:'gpt17',base,status,file:'proposal.md'}] }));
  h.run('enqueue('+JSON.stringify({type:'decide',chapter:'gpt17',id:'p1',decision:'accepted',base,text:'Предложение'})+')');
}

test('acceptance recovers if chapter save succeeded and status save was interrupted', async () => {
  const h=harness();proposal(h);let once=true;
  h.hook(({path,method})=>{if(path===proposalsPath&&method==='PUT'&&once){once=false;throw Error('connection lost');}});
  await assert.rejects(h.run('pushQueue()'));assert.equal(h.files.get(chapter.file).text,'Предложение');
  await h.run('pushQueue()');assert.equal(JSON.parse(h.files.get(proposalsPath).text).proposals[0].status,'accepted');
});

test('stale proposal does not replace a changed chapter', async () => {
  const h=harness();proposal(h);h.put(chapter.file,'Новый авторский текст');await h.run('pushQueue()');
  assert.equal(h.files.get(chapter.file).text,'Новый авторский текст');assert.equal(JSON.parse(h.files.get(proposalsPath).text).proposals[0].status,'stale');
});

test('rejected proposal is checked before modifying chapter', async () => {
  const h=harness();proposal(h,undefined,'rejected');await assert.rejects(h.run('pushQueue()'));
  assert.equal(h.files.get(chapter.file).text,'Исходный текст');assert.equal(h.run('queue.length'),1);
});

test('invalid note JSON is never replaced by an empty document', async () => {
  const h=harness();h.put(notesPath,'{broken');h.run('enqueue({type:"note-reply",chapter:"gpt17",id:"n1",reply:{id:"r1",text:"Ответ"}})');
  await assert.rejects(h.run('pushQueue()'));assert.equal(h.files.get(notesPath).text,'{broken');assert.equal(h.run('queue.length'),1);
});

test('failed pull keeps complete previous offline snapshot', async () => {
  const h=harness();const before=h.run('JSON.stringify(data.files)');h.put(chapter.file,'Новый текст');h.put(vaal.file,'Новый Ваал');let blobs=0;
  h.hook(({path,method,options})=>{if(!path&&method==='GET'&&++blobs===3)throw Error('offline');});
  await assert.rejects(h.run('pull()'));assert.equal(h.run('JSON.stringify(data.files)'),before);
});

test('edition choice shows only matching chapters and preserves stable ids', () => {
  const h=harness();h.run('renderChapters()');let html=h.elements.get('#view').innerHTML;
  assert.match(html,/data-ch="gpt17"/);assert.doesNotMatch(html,/data-ch="ch03"/);assert.match(html,/data-edition="vaal"/);
  h.run('ui.edition="vaal";renderChapters()');html=h.elements.get('#view').innerHTML;
  assert.match(html,/data-ch="ch03"/);assert.doesNotMatch(html,/data-ch="gpt17"/);
});

test('quota error does not pretend a new edit is saved', () => {
  const h=harness();h.quota(true);assert.equal(h.run('enqueue({type:"edit",chapter:"gpt17",text:"Не потерять"})'),false);assert.equal(h.run('queue.length'),0);
});

test('unknown chapter is not silently dropped from queue', async () => {
  const h=harness();h.run('enqueue({type:"edit",chapter:"unknown",text:"Важная правка"})');await assert.rejects(h.run('pushQueue()'));assert.equal(h.run('queue.length'),1);
});

test('missing reply target remains in queue', async () => {
  const h=harness();h.run('enqueue({type:"note-reply",chapter:"gpt17",id:"missing",reply:{id:"r1",text:"Ответ"}})');await assert.rejects(h.run('pushQueue()'));assert.equal(h.run('queue.length'),1);
});

test('inbox lists pending proposals of every edition and hides decided ones', () => {
  const h=harness();h.put(proposalsPath,JSON.stringify({proposals:[{id:'pv',chapter:'ch03',status:'pending',by:'Claude',summary:'Правка Ваала',file:'p.md'},{id:'pd',chapter:'gpt17',status:'accepted',file:'q.md'}]}));
  h.run('data.files['+JSON.stringify(proposalsPath)+']='+JSON.stringify({text:h.files.get(proposalsPath).text})+';renderChapters()');
  const html=h.elements.get('#view').innerHTML;
  assert.match(html,/Ждёт вас: 1/);assert.match(html,/Правка Ваала/);assert.match(html,/3\. Глава Ваала · Адриан Ваал/);
  assert.doesNotMatch(html,/data-ch="ch03"/);
  assert.equal(h.run('inbox()[0].p.id'),'pv');
});

test('diff marks each changed place and shows preceding context', () => {
  const h=harness();const html=h.run('diffHtml(' + JSON.stringify('А\n\nБ\n\nВ\n\nГ') + ',' + JSON.stringify('А\n\nБ2\n\nВ\n\nГ2') + ')');
  assert.match(html,/Мест с правками: 2/);assert.match(html,/Правка 2/);assert.match(html,/class="ctx">А</);
});

test('diff modes: split shows old and new separately, new shows only additions', () => {
  const h=harness();const a=JSON.stringify('А\n\nстарое слово'),b=JSON.stringify('А\n\nновое слово');
  const split=h.run('diffHtml('+a+','+b+',"split")');assert.match(split,/class="was"[\s\S]*<del>старое<\/del>[\s\S]*class="now"[\s\S]*<ins>новое<\/ins>/);
  const only=h.run('diffHtml('+a+','+b+',"new")');assert.doesNotMatch(only,/<del>/);assert.match(only,/<ins>новое<\/ins>/);
  const mixed=h.run('diffHtml('+a+','+b+',"mixed")');assert.match(mixed,/<del>старое<\/del><ins>новое<\/ins>/);
});

test('partial acceptance keeps only checked changes and records them', async () => {
  const h=harness();const base=h.files.get(chapter.file).sha;
  const oldT='А\n\nБ\n\nВ\n\nГ', newT='А\n\nБ2\n\nВ\n\nГ2';
  assert.equal(h.run('mergeParts('+JSON.stringify(oldT)+','+JSON.stringify(newT)+',new Set([2])).text'),'А\n\nБ\n\nВ\n\nГ2');
  assert.equal(h.run('mergeParts('+JSON.stringify(oldT)+','+JSON.stringify(newT)+',new Set()).total'),2);
  h.put(proposalsPath,JSON.stringify({proposals:[{id:'p1',chapter:'gpt17',base,status:'pending',file:'proposal.md'}]}));
  h.run('enqueue('+JSON.stringify({type:'decide',chapter:'gpt17',id:'p1',decision:'accepted',base,text:'Частично',parts:[2],total:2})+')');
  await h.run('pushQueue()');
  assert.equal(h.files.get(chapter.file).text,'Частично');
  const p=JSON.parse(h.files.get(proposalsPath).text).proposals[0];
  assert.equal(p.status,'accepted');assert.deepEqual(p.acceptedParts,[2]);assert.equal(p.partsTotal,2);
});

test('diff with skip set shows checkboxes and marks skipped part', () => {
  const h=harness();const html=h.run('diffHtml('+JSON.stringify('А\n\nБ\n\nВ\n\nГ')+','+JSON.stringify('А\n\nБ2\n\nВ\n\nГ2')+',"split",{skip:new Set([1])})');
  assert.match(html,/data-part="1" >/);assert.match(html,/data-part="2" checked/);assert.match(html,/part off/);
});

test('author edit of a change replaces that change on acceptance; empty edit removes it', () => {
  const h=harness();const o=JSON.stringify('А\n\nБ\n\nВ\n\nГ'),n=JSON.stringify('А\n\nБ2\n\nВ\n\nГ2');
  assert.equal(h.run('mergeParts('+o+','+n+',new Set([1,2]),{1:"Б мой"}).text'),'А\n\nБ мой\n\nВ\n\nГ2');
  assert.equal(h.run('mergeParts('+o+','+n+',new Set([1,2]),{2:"  "}).text'),'А\n\nБ2\n\nВ');
  assert.equal(h.run('mergeParts('+o+','+n+',new Set([2]),{1:"не важно"}).text'),'А\n\nБ\n\nВ\n\nГ2');
  assert.deepEqual(h.run('JSON.stringify(diffParts('+o+','+n+'))'),JSON.stringify([{was:['Б'],now:['Б2']},{was:['Г'],now:['Г2']}]));
});

test('diff shows author variant and part remarks', () => {
  const h=harness();const html=h.run('diffHtml('+JSON.stringify('А\n\nБ')+','+JSON.stringify('А\n\nБ2')+',"split",{skip:new Set(),edits:{1:"Мой вариант"},notes:{1:[{comment:"Слишком в лоб"}]}})');
  assert.match(html,/Стало — ваш вариант[\s\S]*Мой вариант/);assert.match(html,/Ваше замечание[\s\S]*Слишком в лоб/);assert.match(html,/data-open="1"/);
});
