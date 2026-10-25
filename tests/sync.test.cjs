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

function harness(savedStorage = []) {
  const files = new Map(), storage = new Map(savedStorage), elements = new Map();
  const put = (path, text) => files.set(path, { text, sha: sha(text) });
  put(manifestPath, JSON.stringify({ editions: [{ id: 'gpt', title: 'Codex · 17 глав' }, { id: 'vaal', title: 'Адриан Ваал' }], chapters: [vaal, chapter] }));
  put(proposalsPath, '{"proposals":[]}'); put(chapter.file, 'Исходный текст'); put(vaal.file, 'Ваал');
  let onRequest = null, failStorage = false, calls = 0;
  const node = () => ({ innerHTML: '', textContent: '', value: '', dataset: {}, hidden: false, open: false, classList: { _s: new Set(), toggle() {}, add(...c) { c.forEach(x => this._s.add(x)); }, remove(...c) { c.forEach(x => this._s.delete(x)); }, contains(c) { return this._s.has(c); } }, querySelectorAll() { return []; }, querySelector() { return { value: 'remark' }; }, showModal() { this.open = true; }, close() { this.open = false; }, focus() {} });
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

test('saving online persists locally without scheduling network work', () => {
  const h = harness(); let timers = 0;
  h.ctx.setTimeout = () => { timers++; };
  h.run('enqueue({type:"note-add",chapter:"gpt17",note:{id:"local",status:"open",comment:"Draft"}})');
  assert.equal(h.calls(), 0); assert.equal(timers, 0);
  assert.equal(JSON.parse(h.storage.get('cs.queue'))[0].note.id, 'local');
  h.run('enqueue({type:"note-set",chapter:"gpt17",id:"local",fields:{status:"done",deleted:true}});notesOf("gpt17")');
  assert.equal(h.run('queue[0].note.status'), 'open');
});

test('deleting and restoring notes survives reload and sync without losing replies', async () => {
  const h = harness();
  h.put(notesPath, JSON.stringify({notes:[{id:'n1',status:'open',comment:'Keep',replies:[{id:'r1',text:'Archive'}]}]}));
  h.run('data.files='+JSON.stringify(Object.fromEntries(h.files)));
  h.run('enqueue({type:"note-set",chapter:"gpt17",id:"n1",fields:{deleted:true}})');
  assert.equal(h.run('notesOf("gpt17").length'), 0);
  const reloaded = harness([...h.storage]);
  assert.equal(reloaded.run('queue[0].fields.deleted'), true);
  await h.run('pushQueue()');
  assert.equal(h.run('notesOf("gpt17").length'), 0);
  h.run('enqueue({type:"note-set",chapter:"gpt17",id:"n1",fields:{deleted:false}})');
  await h.run('pushQueue()');
  assert.equal(h.run('notesOf("gpt17")[0].replies[0].text'), 'Archive');
});

test('reading mode has no note controls and remembers the last chapter', () => {
  const h = harness();
  h.run('route={screen:"chapter",chapter:"gpt17",tab:"read"};renderRead(chapterById("gpt17"))');
  const html = h.elements.get('#view').innerHTML;
  assert.doesNotMatch(html, /id="rawEdit"|id="resumeNote"|para-add/);
  assert.match(html, /id="theme"/);
  assert.equal(JSON.parse(h.storage.get('cs.ui')).lastChapter, 'gpt17');
});

test('quote relocation uses both contexts across paragraphs and refuses ambiguous matches', () => {
  const h = harness();
  h.ctx.blocks = ['Первый берег далеко.', 'Другой берег близко.'];
  assert.equal(h.run('locateQuote(blocks,{quote:"берег"})'), null);
  assert.equal(h.run('locateQuote(blocks,{quote:"берег",prefix:"Другой",suffix:"близко."}).block'), 1);
  assert.equal(h.run('locateQuote(blocks,{quote:"исчезло"})'), null);
  assert.equal(h.run('locateQuote(["Один берег."],{quote:"берег",prefix:"старое"}).start'), 5);
});

test('normalized quotation preserves DOM offsets around repeated spaces and Unicode', () => {
  const h = harness();
  h.ctx.qaText = '  Айгүл:  тихая\n  вода 🌊.';
  const at = h.run('locateQuote([qaText],{quote:"тихая вода 🌊"})');
  assert.equal(h.ctx.qaText.slice(at.start, at.end), 'тихая\n  вода 🌊');
});

test('unfinished note survives restart with its quotation and original chapter SHA', () => {
  const h = harness(); h.ctx.getSelection = () => ({ removeAllRanges() {} });
  const base = h.files.get(chapter.file).sha;
  h.run('noteSheet(chapterById("gpt17"),{quote:"Исходный",prefix:"",suffix:"текст"});$("#noteText").value="Мой вопрос";$("#noteText").oninput()');
  const recovered = harness([...h.storage]); recovered.ctx.getSelection = () => ({ removeAllRanges() {} });
  recovered.run('data.files["codex/главы/17.md"]={sha:"new-agent-sha",text:"Свежая глава"};noteSheet(chapterById("gpt17"),{quote:"Другая цитата"})');
  assert.equal(recovered.elements.get('#noteText').value, 'Мой вопрос');
  assert.doesNotMatch(recovered.elements.get('#sheet').innerHTML, /name="type"|draftState|discardNote/);
  recovered.run('$("#ok").onclick()');
  assert.equal(recovered.run('queue[0].note.chapterSha'), base);
  assert.equal(recovered.run('queue[0].note.quote'), 'Исходный');
  assert.equal(recovered.run('queue[0].note.suffix'), 'текст');
  assert.equal(recovered.storage.has('cs.noteDraft.gpt17'), false);
});

test('note save failure keeps the dialog and recovery draft; other edition has its own draft', () => {
  const h = harness();
  h.run('noteSheet(chapterById("gpt17"),{quote:"цитата"});$("#noteText").value="Не потерять";$("#noteText").oninput()');
  h.quota(true); h.run('$("#ok").onclick()');
  assert.equal(h.elements.get('#sheet').open, true);
  assert.equal(h.run('queue.length'), 0);
  assert.equal(JSON.parse(h.storage.get('cs.noteDraft.gpt17')).comment, 'Не потерять');
  h.quota(false); h.run('$("#sheet").close();noteSheet(chapterById("ch03"),{quote:"Ваал"})');
  assert.equal(h.elements.get('#noteText').value, '');
  assert.equal(h.run('loadNoteDraft("gpt17").comment'), 'Не потерять');
  h.run('noteSheet(chapterById("gpt17"),{});$("#cancel").onclick()');
  assert.equal(h.run('loadNoteDraft("gpt17")'), null);
  assert.equal(h.run('queue.length'), 0);
});

test('proposal notes are not highlighted as notes of the current chapter', () => {
  const h = harness();
  h.run('data.files='+JSON.stringify(Object.fromEntries(h.files)));
  const cur = h.run('data.files[chapterById("gpt17").file].sha');
  h.run('data.files[notesPath("gpt17")]={text:JSON.stringify({notes:[{id:"live",status:"open",quote:"текст",chapterSha:'+JSON.stringify(cur)+'},{id:"p",status:"open",quote:"текст",proposal:"pp",part:1,chapterSha:'+JSON.stringify(cur)+'}]})}');
  assert.equal(h.run('liveNotes(chapterById("gpt17")).length'), 1);
});

test('notes to an earlier version are hidden in the text but kept in the list', () => {
  const h = harness();
  h.run('data.files='+JSON.stringify(Object.fromEntries(h.files)));
  h.run('data.files[notesPath("gpt17")]={text:JSON.stringify({notes:[{id:"old",status:"open",quote:"текст",chapterSha:"older-sha"},{id:"legacy",status:"open",quote:"текст"}]})}');
  assert.equal(h.run('liveNotes(chapterById("gpt17")).length'), 0);
  assert.equal(h.run('openNotes("gpt17").length'), 2);
});

test('a note written over an unsent edit is shown and gets the new version on sync', async () => {
  const h = harness();
  await h.run('sync()');
  h.run('enqueue({type:"edit",chapter:"gpt17",base:data.files[chapterById("gpt17").file].sha,text:"Новый текст главы"})');
  h.run('enqueue({type:"note-add",chapter:"gpt17",note:{id:"n1",status:"open",quote:"Новый",comment:"к",chapterSha:null,replies:[]}})');
  assert.equal(h.run('liveNotes(chapterById("gpt17")).length'), 1);
  await h.run('sync()');
  assert.equal(h.run('queue.length'), 0);
  const sha = h.run('data.files[chapterById("gpt17").file].sha');
  assert.equal(h.run('notesOf("gpt17")[0].chapterSha'), sha);
  assert.equal(h.run('liveNotes(chapterById("gpt17")).length'), 1);
});

test('manual update check reports offline and activates an available worker', async () => {
  const h = harness(); h.run('navigator.onLine=false'); await h.run('checkAppUpdate()');
  assert.match(h.elements.get('#banner').innerHTML, /нужен Интернет/);
  let updates=0, activations=0;
  h.ctx.navigator.serviceWorker={getRegistration:async()=>({update:async()=>updates++,waiting:{postMessage(){activations++;}}})};
  h.run('navigator.onLine=true'); await h.run('checkAppUpdate()');
  assert.equal(updates,1); assert.equal(activations,1);
  h.run('renderChapters()'); assert.match(h.elements.get('#view').innerHTML,new RegExp('Редактор · версия ' + h.run('APP_VERSION')));
});

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

test('part with an open remark starts unchecked unless the author wrote own variant', () => {
  const h=harness();const base=h.files.get(chapter.file).sha;
  h.put(chapter.file,'А\n\nБ\n\nВ\n\nГ');h.put('p.md','А\n\nБ2\n\nВ\n\nГ2');
  h.put(proposalsPath,JSON.stringify({proposals:[{id:'pp',chapter:'gpt17',base:h.files.get(chapter.file).sha,status:'pending',file:'p.md'}]}));
  h.put(notesPath,JSON.stringify({notes:[{id:'n1',status:'open',comment:'Не так',proposal:'pp',part:2,replies:[]}]}));
  h.run('data.files='+JSON.stringify(Object.fromEntries(h.files))+';route={screen:"chapter",chapter:"gpt17",tab:"proposals",proposal:"pp"};renderProposals(chapterById("gpt17"))');
  const html=h.elements.get('#view').innerHTML;
  assert.match(html,/data-part="2" >/);assert.match(html,/data-part="1" checked/);assert.match(html,/есть замечание/);assert.match(html,/Принять отмеченные \(1 из 2\)/);
});

test('proposal can be read as clean text with checked changes; reader links to it', () => {
  const h=harness();
  h.put(chapter.file,'А\n\nБ\n\nВ\n\nГ');h.put('p.md','А\n\nБ2\n\nВ\n\nГ2');
  h.put(proposalsPath,JSON.stringify({proposals:[{id:'pp',chapter:'gpt17',by:'Claude',base:h.files.get(chapter.file).sha,status:'pending',file:'p.md'}]}));
  h.run('data.files='+JSON.stringify(Object.fromEntries(h.files))+';skipOf("pp").add(1);route={screen:"chapter",chapter:"gpt17",tab:"proposals",proposal:"pp",clean:true};renderProposals(chapterById("gpt17"))');
  let html=h.elements.get('#view').innerHTML;
  assert.match(html,/<article class="article"><p>А<\/p><p>Б<\/p><p>В<\/p><p>Г2<\/p><\/article>/);assert.doesNotMatch(html,/<ins>|<del>/);
  assert.match(html,/отмеченные правки: 1 из 2/);assert.match(html,/Принять отмеченные \(1 из 2\)/);
  h.run('route={screen:"chapter",chapter:"gpt17",tab:"read"};renderRead(chapterById("gpt17"))');
  html=h.elements.get('#view').innerHTML;assert.match(html,/id="readNew"/);
});

test('legacy paragraph view remains readable; raw editor on explicit request', () => {
  const h=harness();h.put(chapter.file,'## Глава\n\nПервый абзац.\n\nВторой абзац тут.\n');
  h.put(notesPath,JSON.stringify({notes:[{id:'n1',type:'remark',status:'open',quote:'Второй абзац',comment:'Сократить',replies:[]}]}));
  h.run('data.files='+JSON.stringify(Object.fromEntries(h.files))+';route={screen:"chapter",chapter:"gpt17",tab:"edit"};renderParagraphs(chapterById("gpt17"),chapterText(chapterById("gpt17")))');
  let html=h.elements.get('#view').innerHTML;
  assert.match(html,/data-para="4"/);assert.match(html,/para noted[^>]*data-para="4"[\s\S]*Сократить/);assert.doesNotMatch(html,/textarea class="editor"/);
  h.run('route.rawEdit=true;renderEdit(chapterById("gpt17"))');html=h.elements.get('#view').innerHTML;
  assert.match(html,/textarea class="editor"/);
  assert.equal(h.run('JSON.stringify(splitParas('+JSON.stringify('а\n\nб\n')+'))'),JSON.stringify(['а','\n\n','б\n']));
});

test('paragraph opened before sync keeps its original base and cannot overwrite a newer chapter', async () => {
  const h = harness();
  h.put(chapter.file, 'Первый абзац.\n\nВторой абзац.');
  h.run('data.files=' + JSON.stringify(Object.fromEntries(h.files)) + ';paraSheet(chapterById("gpt17"),0)');
  h.elements.get('#paraText').value = 'Моя правка первого.';
  h.elements.get('#paraNote').value = '';
  h.put(chapter.file, 'Первый абзац.\n\nНовая правка второго от агента.');
  await h.run('pull()');
  h.elements.get('#ok').onclick();
  await h.run('pushQueue()');
  assert.equal(h.files.get(chapter.file).text, 'Первый абзац.\n\nНовая правка второго от агента.');
  assert.equal([...h.files].find(([path]) => path.includes('конфликты'))[1].text, 'Моя правка первого.\n\nВторой абзац.');
});

test('failed author-variant save leaves the edit dialog open', () => {
  const h=harness();
  h.put('p.md','Новый абзац.');
  h.put(proposalsPath,JSON.stringify({proposals:[{id:'p1',chapter:'gpt17',base:h.files.get(chapter.file).sha,status:'pending',file:'p.md'}]}));
  h.run('data.files='+JSON.stringify(Object.fromEntries(h.files))+';route={chapter:"gpt17",proposal:"p1"};openPartSheet(1)');
  h.elements.get('#partText').value='Мой вариант, который нельзя потерять.';
  h.run('$("#partNote").value=""');h.quota(true);
  h.elements.get('#ok').onclick();
  assert.equal(h.elements.get('#sheet').open,true);
});

test('stale decision whose status response was lost can leave the queue on retry', async () => {
  const h=harness();proposal(h);h.put(chapter.file,'Новый текст автора.');let fail=true;
  h.hook(({path,method,options,put})=>{if(path===proposalsPath&&method==='PUT'&&fail){fail=false;put(path,Buffer.from(JSON.parse(options.body).content,'base64').toString());throw Error('response lost');}});
  await assert.rejects(h.run('pushQueue()'));
  await h.run('pushQueue()');
  assert.equal(h.run('queue.length'),0);assert.equal(h.files.get(chapter.file).text,'Новый текст автора.');
});

test('confirmed accepted decision does not try to overwrite later author changes on retry', async () => {
  const h=harness();proposal(h);let fail=true;
  h.hook(({path,method,options,put})=>{if(path===proposalsPath&&method==='PUT'&&fail){fail=false;put(path,Buffer.from(JSON.parse(options.body).content,'base64').toString());throw Error('response lost');}});
  await assert.rejects(h.run('pushQueue()'));h.put(chapter.file,'Правка автора после принятия.');
  await h.run('pushQueue()');assert.equal(h.run('queue.length'),0);
  assert.equal(h.files.get(chapter.file).text,'Правка автора после принятия.');
});

test('unchecked proposal parts survive reloading the editor', () => {
  const h=harness();h.run('selectPart("p1",2,false)');
  const reopened=harness(h.storage);
  assert.equal(reopened.run('skipOf("p1").has(2)'),true);
});

test('a new remark arriving during review unchecks its part; explicit recheck is respected', () => {
  const h=harness();
  h.put(chapter.file,'А\n\nБ\n\nВ\n\nГ');h.put('p.md','А\n\nБ2\n\nВ\n\nГ2');
  h.put(proposalsPath,JSON.stringify({proposals:[{id:'pp',chapter:'gpt17',base:h.files.get(chapter.file).sha,status:'pending',file:'p.md'}]}));
  h.run('data.files='+JSON.stringify(Object.fromEntries(h.files))+';route={screen:"chapter",chapter:"gpt17",tab:"proposals",proposal:"pp"};renderProposals(chapterById("gpt17"))');
  h.put(notesPath,JSON.stringify({notes:[{id:'n-arrived',status:'open',comment:'Не принимать это место',proposal:'pp',part:2,replies:[]}]}));
  h.run('data.files='+JSON.stringify(Object.fromEntries(h.files))+';renderProposals(chapterById("gpt17"))');
  assert.equal(h.run('skipOf("pp").has(2)'),true);
  h.run('selectPart("pp",2,true);renderProposals(chapterById("gpt17"))');
  assert.equal(h.run('skipOf("pp").has(2)'),false);
});

test('service worker update leaves an active note dialog and typed text intact', () => {
  const h=harness();let reloads=0;h.ctx.location={reload(){reloads++}};
  h.run('route={screen:"chapter",tab:"notes",chapter:"gpt17"};$("#sheet").open=true;$("#noteText").value="Ещё не сохранённая заметка";requestAppUpdate()');
  assert.equal(reloads,0);assert.equal(h.elements.get('#noteText').value,'Ещё не сохранённая заметка');
  assert.equal(h.elements.get('#sheet').open,true);assert.match(h.elements.get('#banner').innerHTML,/Готово обновление/);
  h.run('applyAppUpdate()');assert.equal(reloads,0);
});

test('service worker update does not restart a proposal review', () => {
  const h=harness();let reloads=0;h.ctx.location={reload(){reloads++}};
  h.run('route={screen:"chapter",tab:"proposals",chapter:"gpt17"};requestAppUpdate()');assert.equal(reloads,0);
  h.run('applyAppUpdate()');assert.equal(reloads,1);
});

test('service worker may update automatically on the idle home screen', () => {
  const h=harness();let reloads=0;h.ctx.location={reload(){reloads++}};
  h.run('requestAppUpdate()');assert.equal(reloads,1);
});

test('a waiting update stays inactive until the active form is saved', () => {
  const h=harness();let activations=0,reloads=0;h.ctx.location={reload(){reloads++}};
  h.ctx.qaWorker={postMessage(message){assert.equal(message.type,'ACTIVATE_UPDATE');activations++}};
  h.run('route={screen:"chapter",tab:"notes",chapter:"gpt17"};$("#sheet").open=true;requestAppUpdate(qaWorker)');
  assert.equal(activations,0);assert.equal(reloads,0);
  h.run('$("#sheet").open=false;applyAppUpdate()');assert.equal(activations,1);assert.equal(reloads,0);
});

test('old queued operation without operation id is not mistaken for a completed decision', async () => {
  const h=harness();proposal(h);h.run('delete queue[0].operationId');await h.run('pushQueue()');
  assert.equal(h.files.get(chapter.file).text,'Предложение');assert.equal(h.run('queue.length'),0);
});

test('author wording is preserved separately when proposal acceptance becomes stale', async () => {
  const h=harness();proposal(h);h.run('queue[0].text="Свой вариант автора";queue[0].edited=[1];queue[0].parts=[1];queue[0].total=1');
  h.put(chapter.file,'Новый независимый текст');await h.run('pushQueue()');
  assert.equal(h.files.get(chapter.file).text,'Новый независимый текст');
  const saved=[...h.files].find(([p])=>p.includes('конфликты'));
  assert.ok(saved,'custom author wording must survive stale acceptance');
  assert.equal(saved[1].text,'Свой вариант автора');
});

test('slow history request cannot overwrite a chapter opened later', async () => {
  const h=harness();let release;
  h.hook(({path,method})=>!path&&method==='GET'?new Promise(resolve=>{release=()=>resolve({ok:true,status:200,json:async()=>[{sha:'v1',commit:{message:'Тестовая версия',author:{date:'2026-10-22T00:00:00Z'}}}]})}):null);
  const history=h.run('route={screen:"chapter",tab:"history",chapter:"gpt17"};renderHistory(chapterById("gpt17"))');
  h.run('route={screen:"chapter",tab:"read",chapter:"ch03"};renderRead(chapterById("ch03"))');
  const expected=h.elements.get('#view').innerHTML;release();await history;
  assert.equal(h.elements.get('#view').innerHTML,expected);
});

test('accepted proposal can be fetched after synchronization removed its cached file', async () => {
  const h=harness();h.put('p.md','Полный исходный вариант агента');
  const p={id:'accepted',chapter:'gpt17',file:'p.md',status:'accepted',acceptedParts:[1],partsTotal:2};
  h.put(proposalsPath,JSON.stringify({proposals:[p]}));
  h.run('data.files='+JSON.stringify(Object.fromEntries(h.files))+';delete data.files["p.md"];route={screen:"chapter",tab:"proposals",chapter:"gpt17",proposal:"accepted",clean:true}');
  await h.run('loadProposal(chapterById("gpt17"),proposalsOf("gpt17")[0])');
  assert.equal(h.run('data.files["p.md"].text'),'Полный исходный вариант агента');
  const html=h.elements.get('#view').innerHTML;
  assert.match(html,/Это исходный текст предложения агента/);assert.match(html,/Текст предложения/);
  assert.match(html,/принято частично: 1 из 2/);
});

test('sync button says what to do: synchronize when something is unsent, synchronized when done', async () => {
  const h = harness();
  const label = () => h.elements.get('#syncText').textContent;
  await h.run('sync()'); h.run('renderStatus()');
  assert.equal(label(), '✓ Синхронизировано');
  h.run('enqueue({type:"note-add",chapter:"gpt17",note:{id:"s1",status:"open",quote:"",comment:"к",replies:[]}});renderStatus()');
  assert.equal(label(), 'Синхронизировать · 1');
  await h.run('sync()');
  assert.equal(h.run('queue.length'), 0); h.run('renderStatus()');
  assert.equal(label(), '✓ Синхронизировано');
});
