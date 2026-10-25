'use strict';
// Редактор «Чужой сын». Без сервера: главы и заметки лежат в закрытом
// репозитории GitHub, телефон держит копию у себя и отправляет очередь,
// по кнопке «Синхронизировать» и один раз при открытии. Формат данных описан в редактор/README.md репозитория.

const API = 'https://api.github.com';
const branch = () => cfg.branch || 'main';   // другая ветка — только для проверки редактора
const MANIFEST = 'редактор/главы.json';
const PROPOSALS = 'редактор/предложения.json';
const notesPath = id => `редактор/заметки/${id}.json`;
const conflictPath = (id, stamp) => `редактор/конфликты/${id}-${stamp}.md`;

const KEY = { cfg: 'cs.cfg', data: 'cs.data', queue: 'cs.queue', ui: 'cs.ui', draft: id => 'cs.draft.' + id };

// ---------- хранилище ----------
const load = (k, def) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } };
const save = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; }
  catch { alert('Не удалось сохранить на телефоне. Не закрывайте редактор: скопируйте текст и освободите память.'); return false; }
};

const APP_VERSION = 18; // совпадает с номером CACHE в sw.js
let cfg = load(KEY.cfg, { owner: 'Aas-951', repo: 'chuzhoy-syn-vaal', token: '' });
let data = load(KEY.data, { files: {}, syncedAt: null });   // files[path] = { sha, text }
let queue = load(KEY.queue, []);
let ui = load(KEY.ui, { size: 19 });
let route = { screen: 'chapters', chapter: null, tab: 'read' };
let syncing = false, syncError = null;
const saveData = () => save(KEY.data, data);
const saveQueue = () => save(KEY.queue, queue);

// ---------- утилиты ----------
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toLF = s => s.replace(/\r\n?/g, '\n');
const fmtDate = iso => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
const uid = p => `${p}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 8)}`;
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const words = s => (s.match(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu) || []).length;

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const encPath = p => p.split('/').map(encodeURIComponent).join('/');

// ---------- GitHub ----------
async function gh(path, opts = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: 'Bearer ' + cfg.token };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch(API + path, { ...opts, headers, cache: 'no-store' });
  if (!r.ok) {
    const e = new Error(`GitHub ${r.status}`); e.status = r.status;
    try { e.detail = (await r.json()).message; } catch {}
    throw e;
  }
  return r.status === 204 ? null : r.json();
}
const repoPath = () => `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;

async function getFile(path, ref = branch()) {
  try {
    const j = await gh(`${repoPath()}/contents/${encPath(path)}?ref=${encodeURIComponent(ref)}`);
    return { sha: j.sha, text: b64decode(j.content) };
  } catch (e) { if (e.status === 404) return null; throw e; }
}
async function putFile(path, text, sha, message) {
  const body = { message, content: b64encode(text), branch: branch() };
  if (sha) body.sha = sha;
  const j = await gh(`${repoPath()}/contents/${encPath(path)}`, { method: 'PUT', body: JSON.stringify(body) });
  data.files[path] = { sha: j.content.sha, text };
  if (!saveData()) throw new Error('Отправлено в GitHub, но не сохранено на телефоне. Не закрывайте редактор.');
  return j.content.sha;
}
async function getBlob(sha) { return b64decode((await gh(`${repoPath()}/git/blobs/${sha}`)).content); }

// ---------- модель ----------
const parseJSON = (text, def) => { try { return JSON.parse(text); } catch { return def; } };
const manifest = () => parseJSON(data.files[MANIFEST]?.text || '', { chapters: [] });
const chapters = () => manifest().chapters || [];
const chapterById = id => chapters().find(c => c.id === id);
const editions = () => manifest().editions || [{ id: 'vaal', title: 'Адриан Ваал' }];
const editionOf = ch => ch.edition || 'vaal';
function selectedEdition() {
  return editions().some(e => e.id === ui.edition) ? ui.edition : editions()[0].id;
}
const eolOf = raw => (raw && raw.includes('\r\n')) ? '\r\n' : '\n';
const withEol = (lf, eol) => eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;

function serverChapter(ch) { const f = data.files[ch.file]; return f ? toLF(f.text) : null; }
function pendingEdit(id) { return queue.find(o => o.type === 'edit' && o.chapter === id); }
function pendingAccept(id) { return queue.find(o => o.type === 'decide' && o.chapter === id && o.decision === 'accepted'); }
function chapterText(ch) {
  const ed = pendingEdit(ch.id); if (ed) return ed.text;
  const acc = pendingAccept(ch.id); if (acc) return acc.text;
  return serverChapter(ch);
}

function applyNoteOps(notes, chapterId) {
  const list = JSON.parse(JSON.stringify(notes));
  for (const op of queue) {
    if (op.chapter !== chapterId) continue;
    if (op.type === 'note-add' && !list.some(n => n.id === op.note.id)) list.push(JSON.parse(JSON.stringify(op.note)));
    if (op.type === 'note-set') { const n = list.find(n => n.id === op.id); if (n) Object.assign(n, op.fields); }
    if (op.type === 'note-reply') { const n = list.find(n => n.id === op.id); if (n) { n.replies = n.replies || []; if (!n.replies.some(r => r.id === op.reply.id)) n.replies.push(op.reply); } }
  }
  return list.filter(n => !n.deleted);
}
const serverNotes = id => parseJSON(data.files[notesPath(id)]?.text || '', { notes: [] }).notes || [];
const notesOf = id => applyNoteOps(serverNotes(id), id);
const openNotes = id => notesOf(id).filter(n => n.status === 'open');

const proposalsAll = () => parseJSON(data.files[PROPOSALS]?.text || '', { proposals: [] }).proposals || [];
function proposalsOf(id) {
  return proposalsAll().filter(p => p.chapter === id).map(p => {
    const op = queue.find(o => o.type === 'decide' && o.id === p.id);
    return op ? { ...p, status: op.decision, local: true, ...(op.parts ? { acceptedParts: op.parts, partsTotal: op.total, editedParts: op.edited } : {}) } : p;
  });
}

// ---------- очередь ----------
function enqueue(op) {
  rememberReading();
  const before = queue;
  op.at = new Date().toISOString();
  op.operationId = uid('op');
  if (op.type === 'edit') {
    const prev = pendingEdit(op.chapter);
    queue = prev ? queue.map(item => item === prev ? { ...prev, text: op.text, at: op.at, operationId: op.operationId } : item) : [...queue, op];
  } else queue = [...queue, op];
  if (!saveQueue()) { queue = before; return false; }
  render(); return true;
}

// ---------- синхронизация ----------

async function sync() {
  if (syncing || !cfg.token || !navigator.onLine) { renderStatus(); return; }
  syncing = true; syncError = null; renderStatus();
  try {
    await pushQueue();
    await pull();
    data.syncedAt = new Date().toISOString(); saveData();
  } catch (e) {
    syncError = e.status === 401 ? 'Ключ GitHub не подходит или истёк — откройте «Настройки».'
      : e.status === 403 || e.status === 404 ? 'Нет доступа к репозиторию — проверьте «Настройки».'
      : (navigator.onLine ? 'Не получилось синхронизировать: ' + (e.detail || e.message) : null);
  } finally {
    syncing = false;
    // Do not replace an editor or a note dialog while the author is typing.
    if (route.tab === 'edit' && route.screen === 'chapter' || $('#sheet').open || route.screen === 'settings') renderStatus();
    else render();
  }
}

async function pushQueue() {
  // 1. Правки глав
  for (const op of queue.filter(o => o.type === 'edit')) {
    const ch = chapterById(op.chapter);
    if (!ch) throw new Error('Глава недоступна. Правка сохранена в очереди на телефоне.');
    const cur = await getFile(ch.file);
    const eol = eolOf(cur ? cur.text : data.files[ch.file]?.text);
    if (cur && toLF(cur.text) === toLF(op.text)) {
      // A previous PUT may have succeeded even when its response was lost.
      data.files[ch.file] = cur;
      rebaseNewerEdit(op, cur.sha);
    } else if (!cur || cur.sha !== op.base) {
      // Глава изменилась на сервере, пока вы правили без сети: ничего не затираем.
      const path = conflictPath(ch.id, op.operationId || op.at.replace(/[^a-zA-Z0-9-]/g, '-'));
      const existing = await getFile(path);
      if (existing && toLF(existing.text) !== toLF(op.text)) throw new Error('Конфликт уже сохранён с другим текстом. Очередь сохранена.');
      if (!existing) await putFile(path, withEol(op.text, eol), null, `Конфликт: правка с телефона сохранена отдельно (${ch.title})`);
      addConflict({ chapter: ch.id, path, at: new Date().toISOString() });
    } else {
      const sha = await putFile(ch.file, withEol(op.text, eol), cur.sha, `Правка с телефона: ${ch.title}`);
      rebaseNewerEdit(op, sha);
    }
    drop(op);
  }
  // 2. Решения по предложениям
  for (const op of queue.filter(o => o.type === 'decide')) {
    const ch = chapterById(op.chapter);
    if (!ch) throw new Error('Глава предложения недоступна. Решение остаётся на телефоне.');
    const currentProposals = await getFile(PROPOSALS);
    const proposal = JSON.parse(currentProposals?.text || '{"proposals":[]}').proposals.find(p => p.id === op.id);
    // The status PUT may have succeeded before the connection dropped. An exact
    // operation receipt proves completion even if the author edited the chapter later.
    if (proposal?.chapter === op.chapter && (op.operationId && proposal.decisionOperationId === op.operationId ||
        !proposal.decisionOperationId && proposal.decidedAt === op.at &&
        (proposal.status === op.decision || op.decision === 'accepted' && proposal.status === 'stale'))) {
      data.files[PROPOSALS] = currentProposals;
      if (!saveData()) throw new Error('Не удалось сохранить подтверждение решения.');
      drop(op); continue;
    }
    if (!proposal || proposal.chapter !== op.chapter || !['pending', op.decision].includes(proposal.status)) throw new Error('Предложение уже изменилось. Решение остаётся на телефоне.');
    if (op.decision === 'accepted' && proposal.base !== op.base) throw new Error('Основа предложения изменилась. Решение остаётся на телефоне.');
    let decision = op.decision;
    if (decision === 'accepted' && ch) {
      const cur = await getFile(ch.file);
      if (cur && toLF(cur.text) === toLF(op.text)) { data.files[ch.file] = cur; }
      else if (!cur || cur.sha !== op.base) decision = 'stale';
      else await putFile(ch.file, withEol(op.text, eolOf(cur.text)), cur.sha, `${op.parts ? `Частично (${op.parts.length} из ${op.total}) принято` : 'Принято'} предложение ${op.id}: ${ch.title}`);
    }
    if (decision === 'stale' && op.edited?.length) {
      // This text contains the author's own wording, not just the agent's
      // proposal. A stale base must never make that wording disappear.
      const path = conflictPath(ch.id, 'proposal-' + (op.operationId || op.at.replace(/[^a-zA-Z0-9-]/g, '-')));
      const existing = await getFile(path);
      if (existing && toLF(existing.text) !== toLF(op.text)) throw new Error('Ваш вариант уже сохранён с другим текстом. Решение остаётся в очереди.');
      if (!existing) await putFile(path, op.text, null, `Вариант автора из устаревшего предложения ${op.id}: ${ch.title}`);
      addConflict({ chapter: ch.id, path, proposal: op.id, at: op.at });
    }
    await updateJSON(PROPOSALS, { proposals: [] }, j => {
      const p = (j.proposals || []).find(p => p.id === op.id);
      if (!p) throw new Error('Предложение не найдено. Решение сохранено в очереди.');
      if (p.status !== 'pending' && p.status !== decision) throw new Error('Решение по предложению уже изменилось. Обновите редактор.');
      p.status = decision; p.decidedAt = op.at; p.decisionOperationId = op.operationId;
      if (decision === 'accepted' && op.parts) { p.acceptedParts = op.parts; p.partsTotal = op.total; }
      if (decision === 'accepted' && op.edited) p.editedParts = op.edited;
    }, `Решение по предложению ${op.id}: ${decision}${op.parts && decision === 'accepted' ? ` (правки ${op.parts.join(', ')} из ${op.total})` : ''}`);
    if (decision === 'stale') banner('Глава изменилась после того, как агент подготовил предложение. Предложение не применено — попросите агента обновить его.', true);
    drop(op);
  }
  // 3. Заметки — одним сохранением на главу
  const byChapter = [...new Set(queue.filter(o => o.type.startsWith('note-')).map(o => o.chapter))];
  for (const id of byChapter) {
    const ops = queue.filter(o => o.chapter === id && o.type.startsWith('note-'));
    await updateJSON(notesPath(id), { chapter: id, notes: [] }, j => {
      j.notes = j.notes || [];
      // A note written over an unsent edit belongs to the version that edit just created.
      const sha = !queue.some(o => o.chapter === id && (o.type === 'edit' || o.type === 'decide')) && data.files[chapterById(id)?.file]?.sha;
      for (const op of ops) {
        if (op.type === 'note-add' && !j.notes.some(n => n.id === op.note.id)) j.notes.push(sha && !op.note.chapterSha ? { ...op.note, chapterSha: sha } : op.note);
        const n = j.notes.find(n => n.id === op.id);
        if (op.type !== 'note-add' && !n) throw new Error('Заметка не найдена. Ответ сохранён в очереди.');
        if (op.type === 'note-set' && n) Object.assign(n, op.fields);
        if (op.type === 'note-reply' && n) { n.replies = n.replies || []; if (!n.replies.some(r => r.id === op.reply.id)) n.replies.push(op.reply); }
      }
    }, `Заметки с телефона: ${chapterById(id)?.title || id}`);
    ops.forEach(drop);
  }
}
function rebaseNewerEdit(sent, sha) {
  queue = queue.map(op => op !== sent && op.type === 'edit' && op.chapter === sent.chapter && op.base === sent.base ? { ...op, base: sha } : op);
  if (!saveQueue()) throw new Error('Не удалось сохранить очередь. Не закрывайте редактор.');
}
function drop(op) {
  const before = queue;
  queue = queue.filter(o => o !== op);
  if (!saveQueue()) { queue = before; throw new Error('Не удалось сохранить очередь.'); }
}

async function updateJSON(path, def, mutate, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await getFile(path);
    const j = cur ? JSON.parse(toLF(cur.text)) : JSON.parse(JSON.stringify(def));
    mutate(j);
    try { return await putFile(path, JSON.stringify(j, null, 2) + '\n', cur?.sha, message); }
    catch (e) { if (e.status !== 409 && e.status !== 422) throw e; }
  }
  throw new Error('файл постоянно меняется, попробуйте позже');
}

async function pull() {
  const tree = await gh(`${repoPath()}/git/trees/${encodeURIComponent(branch())}?recursive=1`);
  if (tree.truncated) throw new Error('GitHub вернул неполный список файлов. Сохранённая копия не изменена.');
  const staged = { ...data.files };
  const sha = new Map(tree.tree.filter(t => t.type === 'blob').map(t => [t.path, t.sha]));
  const fetchIfChanged = async path => {
    const s = sha.get(path);
    if (!s) { delete staged[path]; return; }
    if (staged[path]?.sha === s) return;
    staged[path] = { sha: s, text: await getBlob(s) };
  };
  await fetchIfChanged(MANIFEST);
  await fetchIfChanged(PROPOSALS);
  const want = new Set([MANIFEST, PROPOSALS]);
  const nextManifest = JSON.parse(staged[MANIFEST]?.text || '{"chapters":[]}');
  const nextProposals = JSON.parse(staged[PROPOSALS]?.text || '{"proposals":[]}');
  if (!Array.isArray(nextManifest.chapters) || !Array.isArray(nextProposals.proposals)) throw new Error('Повреждён список глав или предложений.');
  for (const ch of nextManifest.chapters) { want.add(ch.file); want.add(notesPath(ch.id)); }
  for (const p of nextProposals.proposals) if (p.status === 'pending' || p.id === route.proposal) want.add(p.file);
  for (const c of data.conflicts || []) want.add(c.path);
  for (const path of want) await fetchIfChanged(path);
  for (const path of Object.keys(staged)) if (!want.has(path)) delete staged[path];
  const before = data;
  data = { ...data, files: staged };
  if (!saveData()) { data = before; throw new Error('Не хватило памяти для загрузки глав.'); }
}

function addConflict(c) {
  data.conflicts = data.conflicts || [];
  if (!data.conflicts.some(item => item.path === c.path)) data.conflicts.push(c);
  if (!saveData()) throw new Error('Не удалось сохранить сведения о конфликте.');
}

// ---------- интерфейс ----------
function banner(html, bad) {
  const b = $('#banner'); if (!html) { b.hidden = true; return; }
  b.innerHTML = html; b.className = 'banner' + (bad ? ' bad' : ''); b.hidden = false;
}

// Кнопка показывает одно из двух: «Синхронизировать» — на телефоне есть
// неотправленное; «✓ Синхронизировано» — всё отправлено и загружено.
function renderStatus() {
  const dot = $('#dot'), t = $('#syncText'), b = $('#sync');
  const n = queue.length;
  b.classList.remove('need', 'done');
  b.title = data.syncedAt ? 'Последняя синхронизация: ' + fmtDate(data.syncedAt) : '';
  if (syncing) { dot.className = 'dot busy'; t.textContent = 'Синхронизация…'; return; }
  if (!cfg.token) { dot.className = 'dot err'; t.textContent = 'Настройки'; return; }
  if (syncError) { dot.className = 'dot err'; t.textContent = n ? `Ошибка · не отправлено: ${n}` : 'Ошибка — повторить'; return; }
  if (n) {
    dot.className = navigator.onLine ? 'dot need' : 'dot off'; b.classList.add('need');
    t.textContent = navigator.onLine ? `Синхронизировать · ${n}` : `Без сети · не отправлено: ${n}`; return;
  }
  if (!data.syncedAt) { dot.className = navigator.onLine ? 'dot need' : 'dot off'; b.classList.add('need'); t.textContent = navigator.onLine ? 'Загрузить главы' : 'Без сети'; return; }
  dot.className = 'dot on'; b.classList.add('done'); t.textContent = '✓ Синхронизировано';
}

let notice = '';
let updateAvailable = false;
let waitingWorker = null, applyingUpdate = false;
function requestAppUpdate(worker = null) {
  updateAvailable = true;
  if (worker) waitingWorker = worker;
  // A service-worker update must not interrupt typing or reset a proposal review.
  if (!syncing && !$('#sheet').open && route.screen === 'chapters') return applyAppUpdate();
  renderBanner();
}
function applyAppUpdate() {
  if (syncing || $('#sheet').open) return alert('Сначала сохраните или закройте открытое окно и дождитесь синхронизации.');
  if (waitingWorker) {
    applyingUpdate = true;
    waitingWorker.postMessage({ type: 'ACTIVATE_UPDATE' });
    waitingWorker = null;
    return;
  }
  location.reload();
}
async function checkAppUpdate() {
  if (!navigator.onLine) { notice = 'Для проверки обновления нужен Интернет.'; return renderBanner(); }
  try {
    if (!navigator.serviceWorker) throw Error('Обновите страницу в браузере.');
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) throw Error('Закройте редактор и откройте его снова через браузер.');
    await reg.update();
    if (reg.waiting) return requestAppUpdate(reg.waiting);
    notice = reg.installing ? 'Обновление загружается. Дождитесь кнопки «Обновить».' : `Проверка завершена. Открыта версия ${APP_VERSION}.`;
  } catch (e) { notice = esc(e.message || 'Не удалось проверить обновление.'); }
  renderBanner();
}
function appInfoHtml() {
  return `<div class="app-info"><span>Редактор · версия ${APP_VERSION}</span><button class="btn" data-check-update>Проверить обновление</button></div>`;
}
const headerBottom = () => $('.top')?.getBoundingClientRect().bottom || 0;
function rememberReading() {
  if (route.screen !== 'chapter' || !['read', 'edit'].includes(route.tab) || route.rawEdit) return;
  const blocks = [...document.querySelectorAll('#article p, #article h1, #article h2, #article h3')];
  const line = headerBottom() + 12;
  const index = blocks.findIndex(el => el.getBoundingClientRect().bottom > line);
  if (index < 0) return;
  ui.positions = ui.positions || {};
  ui.positions[route.chapter] = { index, top: blocks[index].getBoundingClientRect().top };
  ui.lastChapter = route.chapter; save(KEY.ui, ui);
}
function restoreReading(ch) {
  const pos = ui.positions?.[ch.id]; if (!pos) return;
  const el = document.querySelectorAll('#article p, #article h1, #article h2, #article h3')[pos.index];
  if (el) window.scrollBy(0, el.getBoundingClientRect().top - pos.top);
}
function go(r, msg = '') { rememberReading(); notice = msg; route = { ...route, ...r }; window.scrollTo(0, 0); render(); }

function renderBanner() {
  const msgs = [];
  if (syncError) msgs.push(esc(syncError));
  const conflicts = data.conflicts || [];
  for (const c of conflicts) {
    const ch = chapterById(c.chapter);
    msgs.push(`Конфликт в «${esc(ch?.title || c.chapter)}»: глава успела измениться. Ваш вариант сохранён отдельно. <button data-conflict="${esc(c.path)}">Открыть</button>`);
  }
  if (notice) msgs.push(notice);
  if (updateAvailable) msgs.push('Готово обновление редактора. <button data-update>Обновить</button> — после сохранения работы.');
  banner(msgs.join('<br>'), !!syncError || conflicts.length > 0);
  document.querySelectorAll('[data-conflict]').forEach(b => b.onclick = () => openConflict(b.dataset.conflict));
  document.querySelectorAll('[data-home]').forEach(b => b.onclick = () => go({ screen: 'chapters', chapter: null }));
  document.querySelectorAll('[data-update]').forEach(b => b.onclick = applyAppUpdate);
}

function render() {
  renderStatus();
  renderBanner();

  const inChapter = route.screen === 'chapter' && chapterById(route.chapter);
  $('#tabs').hidden = !inChapter;
  $('#back').hidden = route.screen === 'chapters';
  $('#addNote').hidden = true;
  $('#nextNote').hidden = true;
  if (route.screen === 'settings') return renderSettings();
  if (!cfg.token) return renderSettings();
  if (!inChapter) return renderChapters();
  const ch = chapterById(route.chapter);
  $('#title').textContent = ch.title;
  $('#notesCount').textContent = openNotes(ch.id).length || '';
  $('#propCount').textContent = proposalsOf(ch.id).filter(p => p.status === 'pending').length || '';
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === route.tab));
  ({ read: renderRead, edit: renderEdit, notes: renderNotes, proposals: renderProposals, history: renderHistory })[route.tab](ch);
}

function renderChapters() {
  $('#title').textContent = 'Чужой сын';
  const edition = selectedEdition();
  const list = chapters().filter(ch => editionOf(ch) === edition);
  const v = $('#view');
  if (!list.length) {
    v.innerHTML = `${appInfoHtml()}<div class="empty">${data.syncedAt ? 'В репозитории нет файла редактор/главы.json.' : 'Нажмите «Синхронизировать», чтобы загрузить главы. Нужен Интернет.'}</div>
      <div class="row end"><button class="btn" id="toSettings">Настройки</button></div>`;
    $('#toSettings').onclick = () => go({ screen: 'settings' });
    v.querySelectorAll('[data-check-update]').forEach(b => b.onclick = checkAppUpdate);
    return;
  }
  const todo = inbox().filter(it => it.kind === 'proposal');
  v.innerHTML = `${appInfoHtml()}${chapterById(ui.lastChapter) ? `<button class="item" data-ch="${esc(ui.lastChapter)}"><div class="t">Продолжить чтение</div><div class="s">${esc(chapterById(ui.lastChapter).title)}</div></button>` : ''}${inboxHtml(todo)}
  <div class="editions" aria-label="Редакция романа">${editions().map(e => {
    const n = todo.filter(it => editionOf(it.ch) === e.id).length;
    return `<button class="btn ${e.id === edition ? 'primary' : ''}" data-edition="${esc(e.id)}" aria-pressed="${e.id === edition}">${esc(e.title)} <span class="count">${n || ''}</span></button>`;
  }).join('')}</div>
  <div class="list">${list.map(ch => {
    const text = chapterText(ch);
    const on = openNotes(ch.id).length, pr = proposalsOf(ch.id).filter(p => p.status === 'pending').length;
    const answered = 0;
    const badges = [
      ch.status ? `<span class="badge ${ch.status === 'черновик' ? 'draft' : ''}">${esc(ch.status)}</span>` : '',
      pendingEdit(ch.id) ? '<span class="badge pending">не отправлено</span>' : '',
      pr ? '<span class="badge todo">предложение</span>' : '',
      answered ? '<span class="badge todo">ответ агента</span>' : '',
    ].join('');
    const info = [text ? `${words(text).toLocaleString('ru-RU')} слов` : 'не загружена', on ? `заметок: ${on}` : '', pr ? `предложений: ${pr}` : ''].filter(Boolean).join(' · ');
    return `<button class="item" data-ch="${esc(ch.id)}"><div class="t">${esc(ch.title)}${badges}</div><div class="s">${info}</div></button>`;
  }).join('')}</div>
  <p class="hint">${data.syncedAt ? 'Обновлено: ' + fmtDate(data.syncedAt) : ''}</p>
  <div class="row end"><button class="btn" id="toSettings">Настройки</button></div>`;
  v.querySelectorAll('[data-ch]').forEach(b => b.onclick = () => go({ screen: 'chapter', chapter: b.dataset.ch, tab: 'read', proposal: null, version: null }));
  v.querySelectorAll('[data-edition]').forEach(b => b.onclick = () => { ui.edition = b.dataset.edition; save(KEY.ui, ui); go({ screen: 'chapters', chapter: null }); });
  v.querySelectorAll('[data-inbox]').forEach(b => b.onclick = () => openInboxItem(todo[+b.dataset.inbox]));
  $('#toSettings').onclick = () => go({ screen: 'settings' });
  v.querySelectorAll('[data-check-update]').forEach(b => b.onclick = checkAppUpdate);
}

// Что ждёт автора: предложения и ответы агентов во всех редакциях.
const AGENT_NAMES = ['GPT', 'Claude'];
const agentAnswered = id => openNotes(id).filter(n => AGENT_NAMES.includes(n.replies?.at(-1)?.by));
const editionTitle = ch => editions().find(e => e.id === editionOf(ch))?.title || editionOf(ch);
function inbox() {
  const items = [];
  for (const ch of chapters()) {
    for (const p of proposalsOf(ch.id)) if (p.status === 'pending') items.push({ kind: 'proposal', ch, p, at: p.at || '' });
    const answered = agentAnswered(ch.id);
    if (answered.length) items.push({ kind: 'replies', ch, n: answered.length, at: answered.map(n => n.replies.at(-1).at || '').sort().at(-1) });
  }
  return items.sort((a, b) => b.at.localeCompare(a.at));
}
function inboxHtml(items) {
  if (!items.length) return '<p class="hint">Новых предложений нет.</p>';
  return `<section class="inbox"><h2>Ждёт вас: ${items.length}</h2><div class="list">${items.map((it, i) => `<button class="item todo" data-inbox="${i}">
      <div class="t">${it.kind === 'proposal' ? `Предложение правок от ${esc(it.p.by || 'агента')}` : `Агент ответил на заметки: ${it.n}`}</div>
      <div class="where">${esc(it.ch.title)} · ${esc(editionTitle(it.ch))}</div>
      <div class="s">${it.kind === 'proposal' ? esc((it.p.summary || '').slice(0, 220)) : 'Прочитайте ответы, затем закройте заметку или ответьте.'}</div></button>`).join('')}</div></section>`;
}
function openInboxItem(it) {
  if (!it) return;
  ui.edition = editionOf(it.ch); save(KEY.ui, ui);
  if (it.kind === 'proposal') go({ screen: 'chapter', chapter: it.ch.id, tab: 'proposals', proposal: it.p.id, version: null, clean: false });
  else go({ screen: 'chapter', chapter: it.ch.id, tab: 'notes', noteFilter: 'open', proposal: null, version: null });
}
function afterDecision(word) {
  const left = inbox().length;
  return `${word} ${left ? `Ещё ждут вас: ${left}. <button data-home>Показать</button>` : 'Больше ничего не ждёт.'}`;
}

// --- чтение ---
function mdToHtml(text) {
  const inline = s => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  return toLF(text).split(/\n{2,}/).map(b => b.trim()).filter(Boolean).map(b => {
    if (/^\*\s*\*\s*\*$|^-{3,}$/.test(b)) return '<div class="sep">* * *</div>';
    const h = b.match(/^(#{1,3})\s+(.*)$/);
    if (h) return `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
    return `<p>${inline(b).replace(/\n/g, '<br>')}</p>`;
  }).join('');
}

function readSize() {
  const set = () => document.documentElement.style.setProperty('--read-size', ui.size + 'px');
  set();
  $('#smaller').onclick = () => { ui.size = Math.max(14, ui.size - 1); save(KEY.ui, ui); set(); };
  $('#bigger').onclick = () => { ui.size = Math.min(28, ui.size + 1); save(KEY.ui, ui); set(); };
}
function renderRead(ch) {
  const editing = route.tab === 'edit';
  const text = chapterText(ch);
  const v = $('#view');
  if (text == null) { v.innerHTML = '<div class="empty">Глава ещё не загружена — нужен Интернет.</div>'; return; }
  ui.lastChapter = ch.id; save(KEY.ui, ui);
  const waiting = proposalsOf(ch.id).filter(p => p.status === 'pending' && data.files[p.file]).sort((a, b) => (b.at || '').localeCompare(a.at || ''))[0];
  v.innerHTML = `<div class="readbar"><button id="smaller">А−</button><button id="bigger">А+</button><button id="theme">Тема</button></div>
    ${pendingEdit(ch.id) ? '<p class="hint">Показана ваша правка — она ещё не отправлена.</p>' : ''}
    ${waiting ? `<div class="row"><span class="hint grow">Это текст до правок. Есть предложение от ${esc(waiting.by || 'агента')}.</span><button class="btn" id="readNew">Читать с правками</button></div>` : ''}
    ${editing ? '<p class="hint">Нажмите на абзац, чтобы написать заметку или дописать её. «Заметка ↓» — к следующей заметке.</p><button class="btn" id="rawEdit">Править весь текст</button>' : ''}
    ${editing && loadNoteDraft(ch.id) ? '<button class="btn" id="resumeNote">Продолжить недописанную заметку</button>' : ''}
    <article class="article" id="article">${mdToHtml(text)}</article>`;
  readSize();
  if (waiting) $('#readNew').onclick = () => go({ tab: 'proposals', proposal: waiting.id, clean: true });
  $('#theme').onclick = () => { ui.theme = ui.theme === 'dark' ? 'light' : 'dark'; save(KEY.ui, ui); document.documentElement.dataset.theme = ui.theme; };
  if (editing) { annotateRead(ch); $('#rawEdit').onclick = () => go({ rawEdit: true }); }
  if (editing && loadNoteDraft(ch.id)) $('#resumeNote').onclick = () => noteSheet(ch, {});
  if (editing) highlightNotes(ch); else window.CSS?.highlights?.delete('note');
  if (route.scrollTo) { const id = route.scrollTo; route.scrollTo = null; scrollToNote(ch, id); } else restoreReading(ch);
}

const norm = s => s.replace(/\s+/g, ' ').trim();
// Map normalized whitespace back to original DOM offsets. Never choose the first
// occurrence of an ambiguous quote, including legacy notes with little context.
function normalizedText(text) {
  let flat = ''; const offsets = [];
  for (let i = 0; i < text.length; i++) {
    const c = /\s/.test(text[i]) ? ' ' : text[i];
    if (c === ' ' && (!flat || flat.endsWith(' '))) continue;
    offsets.push(i); flat += c;
  }
  if (flat.endsWith(' ')) { flat = flat.slice(0, -1); offsets.pop(); }
  return { flat, offsets };
}
function locateQuote(blocks, note) {
  const q = norm(note.quote || ''); if (!q) return null;
  const candidates = [];
  blocks.forEach((text, block) => {
    const { flat, offsets } = normalizedText(text);
    for (let at = flat.indexOf(q); at >= 0; at = flat.indexOf(q, at + 1)) {
      const before = flat.slice(0, at), after = flat.slice(at + q.length);
      const matches = (!note.prefix || before.trimEnd().endsWith(norm(note.prefix))) &&
        (!note.suffix || after.trimStart().startsWith(norm(note.suffix)));
      candidates.push({ block, start: offsets[at], end: offsets[at + q.length - 1] + 1, matches });
    }
  });
  const exact = candidates.filter(c => c.matches);
  return exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : null;
}
function rangeForNote(root, note) {
  const blocks = [...root.querySelectorAll('p, h1, h2, h3')];
  const match = locateQuote(blocks.map(el => el.textContent), note);
  if (!match) return null;
  const el = blocks[match.block];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = []; let full = '';
    while (walker.nextNode()) { nodes.push({ node: walker.currentNode, start: full.length }); full += walker.currentNode.data; }
    const at = pos => { const n = nodes.findLast(n => n.start <= pos) || nodes[0]; return [n.node, Math.min(pos - n.start, n.node.data.length)]; };
    const r = document.createRange();
    r.setStart(...at(match.start)); r.setEnd(...at(match.end));
    return r;
}
function findRange(root, quote, prefix, suffix = '') { return rangeForNote(root, { quote, prefix, suffix }); }
// В тексте видны только заметки к нынешней версии главы. После принятого
// предложения или другой новой версии прежние заметки остаются во вкладке «Заметки».
const localNoteIds = id => new Set(queue.filter(o => o.chapter === id && o.type === 'note-add').map(o => o.note.id));
function onCurrentText(ch, n) {
  const local = localNoteIds(ch.id).has(n.id);
  if (pendingEdit(ch.id) || pendingAccept(ch.id)) return local && !n.chapterSha;
  return n.chapterSha ? n.chapterSha === data.files[ch.file]?.sha : local;
}
const liveNotes = ch => openNotes(ch.id).filter(n => !n.proposal && onCurrentText(ch, n));
function annotateRead(ch) {
  const art = $('#article'); if (!art) return;
  const blocks = [...art.querySelectorAll('p, h1, h2, h3')];
  const texts = blocks.map(el => el.textContent);
  const notes = liveNotes(ch).filter(n => norm(n.quote || ''));
  const located = notes.map(note => ({ note, at: locateQuote(texts, note) }));
  blocks.forEach((el, i) => {
    if (el.tagName !== 'P') return;
    const mine = located.filter(({ at }) => at && at.block === i);
    const row = document.createElement('div'); row.className = 'read-row' + (mine.length ? ' noted' : '');
    const body = document.createElement('div');
    el.before(row); body.append(el); row.append(body);
    const actions = document.createElement('div'); actions.className = 'read-actions';
    const add = document.createElement('button'); add.className = 'para-add'; add.textContent = '＋';
    add.setAttribute('aria-label', 'Новая отдельная заметка к абзацу');
    add.onclick = () => noteSheet(ch, { quote: texts[i], prefix: '', suffix: '' }); actions.append(add);
    // Повторное нажатие на абзац открывает уже написанное, чтобы его дописать.
    el.onclick = () => { if (!getSelection().isCollapsed) return; mine.length ? readNoteSheet(ch, mine.at(-1).note) : add.onclick(); };
    mine.forEach(({ note }) => {
      const n = located.findIndex(l => l.note === note) + 1;
      const b = document.createElement('button'); b.className = 'note-marker'; b.textContent = String(n);
      b.setAttribute('aria-label', 'Открыть заметку ' + n); b.onclick = () => readNoteSheet(ch, note); actions.append(b);
      const shown = document.createElement('div'); shown.className = 'pnote'; shown.textContent = note.comment;
      shown.onclick = () => readNoteSheet(ch, note); body.append(shown);
    });
    row.append(actions);
  });
  const detached = located.filter(n => !n.at).length;
  if (detached) {
    const warning = document.createElement('p'); warning.className = 'hint';
    warning.textContent = `Не удалось однозначно найти цитату у заметок: ${detached}. Они сохранены во вкладке «Заметки».`;
    art.before(warning);
  }
  $('#nextNote').hidden = !art.querySelector('.read-row.noted');
}
// «Заметка ↓»: к следующей заметке ниже верха экрана; после последней — снова первая.
function nextNote() {
  const rows = [...document.querySelectorAll('#article .read-row.noted')]; if (!rows.length) return;
  if (notice) { notice = ''; renderBanner(); }
  const line = headerBottom() + 12;
  let next = rows.find(r => r.getBoundingClientRect().top > line);
  if (!next) { next = rows[0]; notice = 'Это была последняя заметка, снова первая.'; renderBanner(); }
  window.scrollBy(0, next.getBoundingClientRect().top - headerBottom() - 8);
  next.classList.add('flash'); setTimeout(() => next.classList.remove('flash'), 1700);
  rememberReading();
}
function readNoteSheet(ch, note) {
  const d = $('#sheet');
  const key = 'cs.noteEdit.' + ch.id + '.' + note.id;
  d.innerHTML = `<h3>Заметка</h3><div class="q">${esc(note.quote || '')}</div>
    <textarea id="noteEdit" aria-label="Заметка"></textarea>
    <div class="row end"><button class="btn danger" id="noteDelete">Удалить</button><button class="btn" id="noteClose">Отмена</button><button class="btn primary" id="noteSave">Сохранить</button></div>`;
  $('#noteEdit').value = load(key, note.comment);
  $('#noteEdit').oninput = () => save(key, $('#noteEdit').value);
  d.showModal();
  const edit = $('#noteEdit'); edit.focus(); edit.setSelectionRange(edit.value.length, edit.value.length);
  $('#noteClose').onclick = () => { localStorage.removeItem(key); d.close(); };
  $('#noteSave').onclick = () => {
    const comment = $('#noteEdit').value.trim(); if (!comment) return;
    if (!enqueue({ type: 'note-set', chapter: ch.id, id: note.id, fields: { comment } })) return;
    localStorage.removeItem(key); d.close();
  };
  $('#noteDelete').onclick = () => {
    if (!enqueue({ type: 'note-set', chapter: ch.id, id: note.id, fields: { deleted: true, status: 'done' } })) return;
    localStorage.removeItem(key);
    d.innerHTML = '<h3>Заметка удалена</h3><div class="row end"><button class="btn" id="undoDelete">Отменить удаление</button><button class="btn" id="doneDelete">Закрыть</button></div>';
    $('#doneDelete').onclick = () => d.close();
    $('#undoDelete').onclick = () => { if (enqueue({ type: 'note-set', chapter: ch.id, id: note.id, fields: { deleted: false, status: note.status } })) readNoteSheet(ch, note); };
  };
}
function highlightNotes(ch) {
  if (!window.CSS?.highlights || typeof Highlight === 'undefined') return;
  const art = $('#article'); if (!art) return;
  const ranges = liveNotes(ch).map(n => findRange(art, n.quote, n.prefix, n.suffix)).filter(Boolean);
  CSS.highlights.set('note', new Highlight(...ranges));
}
function scrollToNote(ch, id) {
  const n = notesOf(ch.id).find(n => n.id === id); const art = $('#article');
  const r = n && !n.proposal && art && findRange(art, n.quote, n.prefix, n.suffix);
  if (!r) { notice = 'Цитата не найдена однозначно в текущей главе. Откройте заметку во вкладке «Заметки».'; renderBanner(); return; }
  const el = r.startContainer.parentElement.closest('p, h1, h2, h3');
  el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1700);
}

// Выделение текста → заметка
let selectionInfo = null;
document.addEventListener('selectionchange', () => {
  const fab = $('#addNote');
  if (route.screen !== 'chapter' || route.tab !== 'edit') { fab.hidden = true; return; }
  const sel = getSelection(), art = $('#article');
  const quote = sel && sel.rangeCount ? sel.toString().trim() : '';
  if (!quote || !art || !art.contains(sel.getRangeAt(0).commonAncestorContainer)) { fab.hidden = true; return; }
  const r = sel.getRangeAt(0);
  const block = r.startContainer.parentElement?.closest('p, h1, h2, h3');
  if (!block || !block.contains(r.endContainer)) { fab.hidden = true; return; }
  const pre = document.createRange(); pre.selectNodeContents(block); pre.setEnd(r.startContainer, r.startOffset);
  const post = document.createRange(); post.selectNodeContents(block); post.setStart(r.endContainer, r.endOffset);
  selectionInfo = { quote, prefix: norm(pre.toString()).slice(-60), suffix: norm(post.toString()).slice(0, 60) };
  fab.hidden = false;
});
$('#addNote').onclick = () => { if (selectionInfo) noteSheet(chapterById(route.chapter), selectionInfo); };
$('#nextNote').onclick = nextNote;

const noteDraftKey = id => 'cs.noteDraft.' + id;
function loadNoteDraft(id) {
  const draft = load(noteDraftKey(id), null);
  return draft && typeof draft.comment === 'string' && typeof draft.quote === 'string' ? draft : null;
}
function noteSheet(ch, anchor) {
  const recovered = loadNoteDraft(ch.id);
  const f = data.files[ch.file];
  const draft = recovered || { quote: anchor.quote || '', prefix: anchor.prefix || '', suffix: anchor.suffix || '',
    chapterSha: pendingEdit(ch.id) || pendingAccept(ch.id) ? null : f?.sha || null, type: 'remark', comment: '' };
  const { quote, prefix, suffix } = draft;
  const d = $('#sheet');
  d.innerHTML = `<h3>Заметка</h3>
    ${quote ? `<div class="q">${esc(quote)}</div>` : ''}
    <textarea id="noteText" aria-label="Заметка" placeholder="Ваша заметка…"></textarea>
    <div class="row end"><button class="btn" id="cancel">Отмена</button><button class="btn primary" id="ok">Сохранить</button></div>`;
  $('#noteText').value = draft.comment;
  const keep = () => {
    draft.comment = $('#noteText').value;
    return save(noteDraftKey(ch.id), draft);
  };
  $('#noteText').oninput = keep;
  d.showModal();
  $('#cancel').onclick = () => {
    localStorage.removeItem(noteDraftKey(ch.id)); d.close(); render();
  };
  $('#ok').onclick = () => {
    const comment = $('#noteText').value.trim(); if (!comment) return $('#noteText').focus();
    if (!enqueue({ type: 'note-add', chapter: ch.id, note: {
      id: uid('n'), type: draft.type || 'remark', status: 'open',
      quote, prefix, suffix, comment, author: 'автор', createdAt: new Date().toISOString(),
      chapterSha: draft.chapterSha, replies: [],
    } })) return;
    localStorage.removeItem(noteDraftKey(ch.id));
    d.close(); getSelection().removeAllRanges(); $('#addNote').hidden = true; render();
  };
}

// --- правка ---
function renderEdit(ch) {
  if (!route.rawEdit) return renderRead(ch);
  const v = $('#view');
  const base = chapterText(ch);
  if (base == null) { v.innerHTML = '<div class="empty">Глава ещё не загружена — нужен Интернет.</div>'; return; }
  if (pendingAccept(ch.id)) { v.innerHTML = '<div class="empty">Вы приняли предложение, оно ещё не отправлено. Править можно после синхронизации.</div>'; return; }
  const rawDraft = load(KEY.draft(ch.id), null);
  const draft = typeof rawDraft === 'string' ? { text: rawDraft, base: data.files[ch.file]?.sha } : rawDraft;
  const editBase = draft?.base ?? pendingEdit(ch.id)?.base ?? data.files[ch.file]?.sha;
  const text = draft?.text ?? base;
  // По умолчанию — по абзацам; весь текст целиком — по кнопке или если есть несохранённый черновик.
  v.innerHTML = `<div class="row"><button class="btn" id="byPara">‹ По абзацам</button></div>
    ${draft != null && draft.text !== base ? '<p class="hint">Восстановлен несохранённый черновик с этого телефона.</p>' : ''}
    <textarea class="editor" id="ed" spellcheck="true"></textarea>
    <p class="hint" id="wc"></p>
    <div class="row end"><button class="btn danger" id="discard">Отменить правки</button><button class="btn primary" id="saveEd">Сохранить</button></div>
    <p class="hint">«Сохранить» записывает правку на телефоне. В GitHub она отправится по кнопке «Синхронизировать».</p>`;
  $('#byPara').onclick = () => {
    if ($('#ed').value !== base && !confirm('Выйти из правки всего текста? Несохранённые изменения пропадут.')) return;
    localStorage.removeItem(KEY.draft(ch.id)); go({ rawEdit: false });
  };
  const ed = $('#ed'); ed.value = text;
  const wc = () => $('#wc').textContent = `${words(ed.value).toLocaleString('ru-RU')} слов`;
  wc();
  ed.oninput = () => { wc(); save(KEY.draft(ch.id), { text: ed.value, base: editBase }); };
  $('#discard').onclick = () => { if (confirm('Отменить несохранённые правки?')) { localStorage.removeItem(KEY.draft(ch.id)); render(); } };
  $('#saveEd').onclick = () => {
    const value = ed.value;
    if (value === base) { localStorage.removeItem(KEY.draft(ch.id)); return go({ tab: 'read' }); }
    const prev = pendingEdit(ch.id);
    if (!enqueue({ type: 'edit', chapter: ch.id, base: prev ? prev.base : editBase, text: value })) return;
    localStorage.removeItem(KEY.draft(ch.id));
    go({ tab: 'read', rawEdit: false });
  };
}

// Глава по абзацам: нажатие на абзац — замечание к нему или правка только этого абзаца.
const splitParas = text => toLF(text).split(/(\n{2,})/);   // чётные — абзацы, нечётные — разделители
function renderParagraphs(ch, text) {
  const v = $('#view');
  const parts = splitParas(text);
  const notes = openNotes(ch.id);
  const html = [];
  for (let i = 0; i < parts.length; i += 2) {
    const p = parts[i]; if (!p.trim()) continue;
    // Заголовки и «* * *» не трогаем: правка и замечания — только к абзацам текста.
    if (/^\s*(#{1,3}\s|\*\s*\*\s*\*\s*$|-{3,}\s*$)/.test(p)) { html.push(mdToHtml(p)); continue; }
    const flat = norm(p);
    const mine = notes.filter(n => n.quote && flat.includes(norm(n.quote)));
    html.push(`<div class="para${mine.length ? ' noted' : ''}" data-para="${i}">${mdToHtml(p)}${mine.map(n =>
      `<div class="pnote"><span class="lbl">${WHO[n.type] || 'Заметка'}${n.replies?.length ? ` · ответов: ${n.replies.length}` : ''}</span>${esc(n.comment)}</div>`).join('')}</div>`);
  }
  v.innerHTML = `<p class="hint">Нажмите на абзац, чтобы оставить к нему замечание или поправить его.</p>
    ${pendingEdit(ch.id) ? '<p class="hint">Показана ваша правка — она ещё не отправлена.</p>' : ''}
    <div class="row end"><button class="btn" id="rawEdit">Править весь текст</button></div>
    <article class="article paras">${html.join('')}</article>`;
  $('#rawEdit').onclick = () => go({ rawEdit: true });
  v.querySelectorAll('[data-para]').forEach(el => el.onclick = () => { if (!getSelection().isCollapsed) return; paraSheet(ch, +el.dataset.para); });
}
function paraSheet(ch, i) {
  const base = chapterText(ch); if (base == null) return;
  const baseSha = pendingEdit(ch.id)?.base || data.files[ch.file]?.sha;
  const parts = splitParas(base), original = parts[i]; if (original == null) return;
  const d = $('#sheet');
  delete d.dataset.conflict;
  d.innerHTML = `<h3>Абзац</h3>
    <textarea id="paraText" class="tall"></textarea>
    <p class="hint">Можно поправить текст абзаца прямо здесь — изменится только он.</p>
    <div class="seg">
      <label><input type="radio" name="type" value="remark" checked>Замечание</label>
      <label><input type="radio" name="type" value="question">Вопрос агенту</label>
    </div>
    <textarea id="paraNote" autofocus placeholder="Ваше замечание к этому абзацу… Агент увидит его, когда вы напишете «посмотри замечания»."></textarea>
    <div class="row end"><button class="btn" id="cancel">Отмена</button><button class="btn primary" id="ok">Сохранить</button></div>`;
  $('#paraText').value = original;
  d.showModal();
  $('#paraNote').focus();
  $('#cancel').onclick = () => d.close();
  $('#ok').onclick = () => {
    const value = toLF($('#paraText').value).trim(), comment = $('#paraNote').value.trim();
    const changed = value !== original.trim();
    if (!changed && !comment) return d.close();
    if (changed) {
      parts[i] = value + (original.match(/\s*$/)[0]);
      if (!enqueue({ type: 'edit', chapter: ch.id, base: baseSha, text: parts.join('') })) return;
    }
    if (comment) {
      const quote = (value || original).replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!enqueue({ type: 'note-add', chapter: ch.id, note: {
        id: uid('n'), type: d.querySelector('input[name=type]:checked').value, status: 'open', quote, prefix: '', comment,
        author: 'автор', createdAt: new Date().toISOString(), chapterSha: changed || pendingEdit(ch.id) ? null : baseSha || null, replies: [],
      } })) return;
    }
    d.close(); render();
  };
}

// --- заметки ---
const WHO = { remark: 'Замечание', question: 'Вопрос' };
const STATUS = { open: 'открыта', done: 'готово', rejected: 'отклонена' };
function renderNotes(ch) {
  const v = $('#view');
  const filter = route.noteFilter || 'open';
  const all = notesOf(ch.id).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const shown = all.filter(n => filter === 'all' || (filter === 'open' ? n.status === 'open' : n.status !== 'open'));
  const pendingIds = new Set(queue.filter(o => o.chapter === ch.id && o.type.startsWith('note-')).map(o => o.note?.id || o.id));
  v.innerHTML = `<div class="filters">
      ${[['open', 'Открытые'], ['closed', 'Закрытые'], ['all', 'Все']].map(([k, l]) => `<button data-f="${k}" class="${k === filter ? 'on' : ''}">${l}</button>`).join('')}
      <span class="grow"></span><button class="btn" id="noteAll">＋ К главе</button>
    </div>
    <div class="row"><button class="btn" id="taskGPT">Задание для GPT</button><button class="btn" id="taskClaude">Задание для Claude</button></div>
    <p class="hint">Сначала нажмите «Синхронизировать», затем скопируйте задание в чат T3. Все обсуждения — в чате.</p>
    ${shown.length ? '' : '<div class="empty">Заметок нет. Нажмите на абзац во вкладке «Править», чтобы оставить заметку.</div>'}
    ${shown.map(n => `<div class="note ${n.status !== 'open' ? 'done' : ''}">
      <div class="row"><span class="type ${n.type}">${WHO[n.type] || n.type}</span><span class="meta">${fmtDate(n.createdAt)} · ${STATUS[n.status] || n.status}${pendingIds.has(n.id) ? ' · не отправлено' : ''}</span></div>
      ${n.legacy?.differentText ? '<p class="hint">Заметка перенесена с прежнего текста. Проверьте её актуальность.</p>' : ''}
      ${!n.proposal && n.status === 'open' && !onCurrentText(ch, n) ? '<p class="hint">К прежней версии текста — в главе не показывается.</p>' : ''}
      ${n.proposal ? `<p class="hint">К предложению ${esc(n.proposal)}, правка ${esc(String(n.part))}</p>` : ''}
      ${n.quote ? `<div class="q" data-goto="${esc(n.id)}">${esc(n.quote)}</div>` : ''}
      <div class="c">${esc(n.comment)}</div>
      ${(n.replies || []).map(r => `<div class="reply"><div class="who">${esc(r.by)} · <span class="meta">${fmtDate(r.at)}</span></div>${esc(r.text)}</div>`).join('')}
      <div class="row end mt">
        <button class="btn" data-modify="${esc(n.id)}">Изменить / удалить</button>
        ${n.status === 'open' ? `<button class="btn" data-close="${esc(n.id)}">Закрыть</button>` : `<button class="btn" data-reopen="${esc(n.id)}">Открыть снова</button>`}
      </div></div>`).join('')}`;
  v.querySelectorAll('[data-f]').forEach(b => b.onclick = () => go({ noteFilter: b.dataset.f }));
  $('#noteAll').onclick = () => noteSheet(ch, { quote: '', prefix: '' });
  $('#taskGPT').onclick = () => copyAgentTask(ch, 'GPT');
  $('#taskClaude').onclick = () => copyAgentTask(ch, 'Claude');
  v.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => go({ tab: 'edit', rawEdit: false, scrollTo: b.dataset.goto }));
  v.querySelectorAll('[data-close]').forEach(b => b.onclick = () => enqueue({ type: 'note-set', chapter: ch.id, id: b.dataset.close, fields: { status: 'done', closedAt: new Date().toISOString() } }));
  v.querySelectorAll('[data-reopen]').forEach(b => b.onclick = () => enqueue({ type: 'note-set', chapter: ch.id, id: b.dataset.reopen, fields: { status: 'open' } }));
  v.querySelectorAll('[data-modify]').forEach(b => b.onclick = () => readNoteSheet(ch, notesOf(ch.id).find(n => n.id === b.dataset.modify)));
}
function replySheet(ch, id) {
  const d = $('#sheet');
  d.innerHTML = `<h3>Ответ</h3><textarea id="rt"></textarea>
    <div class="row end"><button class="btn" id="cancel">Отмена</button><button class="btn primary" id="ok">Сохранить</button></div>`;
  d.showModal();
  $('#cancel').onclick = () => d.close();
  $('#ok').onclick = () => {
    const text = $('#rt').value.trim(); if (!text) return;
    if (!enqueue({ type: 'note-reply', chapter: ch.id, id, reply: { id: uid('r'), by: 'автор', at: new Date().toISOString(), text } })) return;
    d.close();
  };
}

async function copyAgentTask(ch, agent) {
  if (queue.some(op => op.chapter === ch.id)) return alert('Сначала нажмите «Синхронизировать» и дождитесь отправки изменений этой главы.');
  const edition = editions().find(e => e.id === editionOf(ch))?.title || editionOf(ch);
  const text = `Работай с закрытым репозиторием ${cfg.owner}/${cfg.repo}, ветка ${branch()}. Прочитай AGENTS.md и редактор/README.md, получи свежие изменения без перезаписи чужих правок. Редакция: ${edition}. Глава: ${ch.title}, постоянный id: ${ch.id}, файл: ${ch.file}. Обсуди открытые заметки из ${notesPath(ch.id)} со мной в этом чате от имени ${agent}. Не добавляй ответы в replies. Пропускай заметки с deleted: true. По замечаниям подготовь предложение с правками по правилам README, не переписывай главу. Не меняй другую редакцию романа. Если заметка к прежнему тексту, сначала проверь актуальность. Проверь JSON, сохрани только свои изменения, выполни commit и push без force. Коротко сообщи результат.`;
  try { await navigator.clipboard.writeText(text); alert('Задание скопировано. Вставьте его в чат ' + agent + ' в T3.'); }
  catch {
    const d = $('#sheet');
    d.innerHTML = '<h3>Задание для агента</h3><textarea id="agentTask" readonly></textarea><button class="btn" id="closeTask">Закрыть</button>';
    $('#agentTask').value = text; d.showModal(); $('#agentTask').select(); $('#closeTask').onclick = () => d.close();
  }
}

// --- предложения ---
const PSTATUS = { pending: 'ждёт решения', accepted: 'принято', rejected: 'отклонено', stale: 'устарело' };
function proposalStatus(p) {
  if (p.status !== 'accepted' || !p.acceptedParts) return PSTATUS[p.status] || p.status;
  const base = p.acceptedParts.length === p.partsTotal ? 'принято' : `принято частично: ${p.acceptedParts.length} из ${p.partsTotal}`;
  return base + (p.editedParts?.length ? `, с вашими исправлениями: ${p.editedParts.length}` : '');
}
// Keep review choices across browser and service-worker reloads, scoped to the
// exact proposal base and blob so part numbers cannot drift into another text.
const PCHOICES = 'cs.pchoices';
let pchoices = load(PCHOICES, {});
const skips = {};
const skipOf = id => skips[id] ||= new Set(pchoices[id]?.skip || []);
function saveChoices(id) {
  const next = { ...pchoices, [id]: { ...(pchoices[id] || {}), skip: [...skipOf(id)] } };
  if (!save(PCHOICES, next)) return false;
  pchoices = next; return true;
}
function selectPart(id, n, checked) {
  const s = skipOf(id), before = s.has(n);
  checked ? s.delete(n) : s.add(n);
  if (saveChoices(id)) return true;
  before ? s.add(n) : s.delete(n); return false;
}
function prepareChoices(p, notes) {
  const blob = data.files[p.file]?.sha;
  let choice = pchoices[p.id];
  if (choice && (choice.base !== p.base || choice.blob !== blob)) {
    // An agent should never reuse an ID for another proposal; do not apply an
    // old checked-part map to different text if it nevertheless happens.
    choice = null; skips[p.id] = new Set();
  }
  const before = pchoices[p.id];
  pchoices[p.id] = choice || { base: p.base, blob, skip: [...skipOf(p.id)], seenNotes: [] };
  const seen = new Set(pchoices[p.id].seenNotes || []);
  const previousSkip = new Set(skipOf(p.id));
  for (const n of notes) if (n.status === 'open' && !seen.has(n.id)) {
    if (editsOf(p.id)[n.part] == null) skipOf(p.id).add(+n.part);
    seen.add(n.id);
  }
  pchoices[p.id] = { ...pchoices[p.id], seenNotes: [...seen] };
  if (!saveChoices(p.id)) {
    if (before) pchoices[p.id] = before; else delete pchoices[p.id];
    skips[p.id] = previousSkip;
  }
}
// Свой вариант текста правки — хранится на телефоне до решения по предложению.
const PEDIT = 'cs.pedit';
let pedits = load(PEDIT, {});
const editsOf = id => pedits[id] ||= {};
const dropEdits = id => { delete pedits[id]; save(PEDIT, pedits); };
// Правки нумеруются так же, как в diffHtml: подряд идущие изменённые абзацы — одна правка.
function diffParts(oldText, newText) {
  const ops = lcs(toLF(oldText).split(/\n{2,}/), toLF(newText).split(/\n{2,}/));
  const parts = [];
  for (let k = 0; k < ops.length; k++) {
    const [t, x] = ops[k];
    if (t === '=') continue;
    if (k === 0 || ops[k - 1][0] === '=') parts.push({ was: [], now: [] });
    (t === '-' ? parts.at(-1).was : parts.at(-1).now).push(x);
  }
  return parts;
}
function mergeParts(oldText, newText, keep, edits = {}) {
  const ops = lcs(toLF(oldText).split(/\n{2,}/), toLF(newText).split(/\n{2,}/));
  const out = [], done = new Set(); let part = 0;
  for (let k = 0; k < ops.length; k++) {
    const [t, x] = ops[k];
    if (t === '=') { out.push(x); continue; }
    if (k === 0 || ops[k - 1][0] === '=') part++;
    if (keep.has(part) && edits[part] != null) {
      if (!done.has(part)) { done.add(part); if (edits[part].trim()) out.push(toLF(edits[part]).trim()); }
      continue;
    }
    if (keep.has(part) ? t === '+' : t === '-') out.push(x);
  }
  return { text: out.join('\n\n'), total: part };
}
const partNotes = (ch, p) => notesOf(ch.id).filter(n => n.proposal === p.id);
function openPartSheet(n) {
  const ch = chapterById(route.chapter);
  const p = ch && proposalsOf(ch.id).find(p => p.id === route.proposal);
  if (!p || p.status !== 'pending' || !data.files[p.file] || p.base !== data.files[ch.file]?.sha || pendingEdit(ch.id)) return;
  const part = diffParts(chapterText(ch) || '', toLF(data.files[p.file].text))[n - 1]; if (!part) return;
  const edits = editsOf(p.id), original = part.now.join('\n\n');
  const d = $('#sheet');
  delete d.dataset.conflict;
  d.innerHTML = `<h3>Правка ${n}</h3>
    ${part.was.length ? `<p class="hint">Было:</p><div class="q">${esc(part.was.join('\n\n'))}</div>` : ''}
    <p class="hint">Стало — можно исправить прямо здесь${part.now.length ? '' : ' (агент этот текст убрал)'}:</p>
    <textarea id="partText" class="tall"></textarea>
    ${edits[n] != null ? '<div class="row"><button class="btn" id="partReset">Вернуть вариант агента</button></div>' : ''}
    <p class="hint">Ваше замечание к этой правке. Агент увидит его, когда вы напишете в чате «посмотри замечания».</p>
    <textarea id="partNote" placeholder="Например: слишком в лоб; оставь, как было, но убери последнюю фразу…"></textarea>
    <div class="row end"><button class="btn" id="cancel">Отмена</button><button class="btn primary" id="ok">Сохранить</button></div>`;
  $('#partText').value = edits[n] ?? original;
  d.showModal();
  $('#cancel').onclick = () => d.close();
  if ($('#partReset')) $('#partReset').onclick = () => { $('#partText').value = original; };
  $('#ok').onclick = () => {
    const value = toLF($('#partText').value);
    if (value.trim() !== original.trim()) { edits[n] = value; skipOf(p.id).delete(n); } else delete edits[n];
    if (!save(PEDIT, pedits) || !saveChoices(p.id)) return;
    const comment = $('#partNote').value.trim();
    if (comment) {
      if (edits[n] == null && !selectPart(p.id, n, false)) return;
      const quote = (edits[n] ?? original ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!enqueue({ type: 'note-add', chapter: ch.id, note: {
        id: uid('n'), type: 'remark', status: 'open', quote, prefix: '', comment, author: 'автор',
        createdAt: new Date().toISOString(), chapterSha: p.base, replies: [], proposal: p.id, part: n,
      } })) return;
    }
    d.close(); render();
  };
}
async function loadProposal(ch, p) {
  const active = () => route.screen === 'chapter' && route.chapter === ch.id && route.tab === 'proposals' && route.proposal === p.id;
  try {
    const file = await getFile(p.file);
    if (!active()) return;
    if (!file) throw new Error('Файл предложения не найден.');
    data.files[p.file] = file;
    if (!saveData()) return;
    renderProposals(ch);
  } catch (e) {
    if (active()) $('#view').innerHTML = `<div class="empty">Не удалось загрузить предложение: ${esc(e.detail || e.message)}</div><button class="btn" id="pback">‹ Назад</button>`;
    if (active()) $('#pback').onclick = () => go({ proposal: null });
  }
}
function renderProposals(ch) {
  const v = $('#view');
  const list = proposalsOf(ch.id).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  if (route.proposal) {
    const p = list.find(p => p.id === route.proposal);
    const text = p && data.files[p.file] ? toLF(data.files[p.file].text) : null;
    const cur = chapterText(ch);
    if (!p || text == null) {
      v.innerHTML = `<div class="empty">${p && navigator.onLine ? 'Загружаю предложение…' : 'Текст предложения не загружен — нужен Интернет.'}</div><div class="row"><button class="btn" id="pback">‹ Назад</button></div>`;
      $('#pback').onclick = () => go({ proposal: null });
      if (p && navigator.onLine) loadProposal(ch, p);
      return;
    }
    const stale = p.base !== data.files[ch.file]?.sha || !!pendingEdit(ch.id);
    const pending = p.status === 'pending';
    if (pending && !stale) prepareChoices(p, partNotes(ch, p));
    const skip = skipOf(p.id), edits = editsOf(p.id);
    const notesByPart = {};
    for (const n of partNotes(ch, p)) if (n.status === 'open') (notesByPart[n.part] ||= []).push(n);
    // Правка с открытым замечанием по умолчанию не принимается — если автор не вписал свой вариант.
    const total = mergeParts(cur || '', text, new Set()).total;
    const keep = new Set(Array.from({ length: total }, (_, i) => i + 1).filter(n => !skip.has(n)));
    const edited = Object.keys(edits).map(Number).filter(n => keep.has(n));
    // «Читать с правками» — глава целиком, как она станет после принятия отмеченных правок, без пометок.
    const clean = !!route.clean;
    const views = `<div class="filters pviews"><button data-pview="diff" class="${clean ? '' : 'on'}">Правки</button><button data-pview="clean" class="${clean ? 'on' : ''}">${pending ? 'Читать с правками' : 'Текст предложения'}</button></div>`;
    const body = clean
      ? `<div class="readbar"><button id="smaller">А−</button><button id="bigger">А+</button></div>
        ${pending && !stale && keep.size < total ? `<p class="hint">Показаны только отмеченные правки: ${keep.size} из ${total}.</p>` : ''}
        <article class="article">${mdToHtml(pending && !stale ? mergeParts(cur || '', text, keep, edits).text : text)}</article>`
      : `<p class="hint">Красным — что убрано, зелёным — что добавлено. Неизменённые абзацы свёрнуты, серым курсивом — конец абзаца перед правкой. Вид сравнения переключается кнопками ниже.${pending ? ' Снимите галочку у правки, которую не хотите принимать. Нажмите на саму правку, чтобы исправить её или оставить замечание.' : ''}</p>
      <div class="diff">${diffHtml(cur || '', text, undefined, pending && !stale ? { skip, edits, notes: notesByPart } : null)}</div>`;
    v.innerHTML = `<div class="row"><button class="btn" id="pback">‹ Все предложения</button></div>
      <h3>${esc(p.by || 'Агент')} · ${fmtDate(p.at)}</h3>
      <div class="c">${esc(p.summary || '')}</div>
      ${p.status === 'accepted' ? '<p class="hint">Это исходный текст предложения агента. В главу попали только принятые вами правки с вашими исправлениями. Действующий текст — во вкладке «Читать».</p>' : ''}
      ${stale && pending ? '<p class="bad">Глава изменилась после того, как агент подготовил это предложение. Принять нельзя — попросите агента обновить его.</p>' : ''}
      ${views}${body}
      ${pending ? `<div class="row end actbar">
        <button class="btn danger" id="reject">Отклонить всё</button>
        <button class="btn primary" id="accept" ${stale || !keep.size ? 'disabled' : ''}>${keep.size === total ? `Принять все (${total})` : `Принять отмеченные (${keep.size} из ${total})`}</button></div>`
        : `<p class="hint">Статус: ${esc(proposalStatus(p))}</p>`}`;
    $('#pback').onclick = () => go({ proposal: null, clean: false });
    v.querySelectorAll('[data-pview]').forEach(b => b.onclick = () => go({ clean: b.dataset.pview === 'clean' }));
    if (clean) readSize();
    if (pending) {
      $('#reject').onclick = () => { if (confirm('Отклонить всё предложение?') && enqueue({ type: 'decide', chapter: ch.id, id: p.id, decision: 'rejected' })) { dropEdits(p.id); go({ proposal: null }, afterDecision('Предложение отклонено.')); } };
      $('#accept').onclick = () => {
        const all = keep.size === total && !edited.length;
        const yours = edited.length ? ` Из них с вашими исправлениями: ${edited.length}.` : '';
        if (!confirm(keep.size === total ? `Принять все правки?${yours} Текущий текст останется во вкладке «Версии».` : `Принять ${keep.size} из ${total} правок?${yours} Не попадут в главу: ${Array.from({ length: total }, (_, i) => i + 1).filter(n => !keep.has(n)).map(n => `правка ${n}${notesByPart[n] ? ' (с замечанием)' : ''}`).join(', ')}. Текущий текст останется во вкладке «Версии».`)) return;
        const op = { type: 'decide', chapter: ch.id, id: p.id, decision: 'accepted', base: p.base, text };
        if (!all) Object.assign(op, { text: mergeParts(cur || '', text, keep, edits).text, parts: [...keep], total, ...(edited.length ? { edited } : {}) });
        if (enqueue(op)) { dropEdits(p.id); go({ proposal: null, tab: 'read' }, afterDecision(keep.size === total ? 'Предложение принято.' : `Принято правок: ${keep.size} из ${total}.`)); }
      };
    }
    return;
  }
  v.innerHTML = list.length ? `<div class="list">${list.map(p => `<button class="item" data-p="${esc(p.id)}">
      <div class="t">${esc(p.by || 'Агент')}<span class="badge ${p.status === 'pending' ? 'pending' : ''}">${esc(proposalStatus(p))}${p.local ? ', не отправлено' : ''}</span></div>
      <div class="s">${fmtDate(p.at)} — ${esc((p.summary || '').slice(0, 160))}</div></button>`).join('')}</div>`
    : '<div class="empty">Предложений нет. Попросите агента в T3: «обработай заметки к этой главе».</div>';
  v.querySelectorAll('[data-p]').forEach(b => b.onclick = () => go({ proposal: b.dataset.p, clean: false }));
}

// Сравнение: по абзацам, внутри изменённых — по словам.
function lcs(a, b, eq = (x, y) => x === y) {
  const n = a.length, m = b.length, dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = eq(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (eq(a[i], b[j])) { out.push(['=', a[i], b[j]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['-', a[i++]]);
    else out.push(['+', b[j++]]);
  }
  while (i < n) out.push(['-', a[i++]]); while (j < m) out.push(['+', b[j++]]);
  return out;
}
// Одна пара абзацев → три вида: вперемешку, только старый, только новый.
function wordDiff(a, b) {
  const ta = a.split(/(\s+)/), tb = b.split(/(\s+)/);
  if (ta.length * tb.length > 4e6) return { mixed: `<del>${esc(a)}</del> <ins>${esc(b)}</ins>`, was: `<del>${esc(a)}</del>`, now: `<ins>${esc(b)}</ins>` };
  const ops = lcs(ta, tb), part = (keep, tag) => ops.map(([k, x]) => k === '=' ? esc(x) : k === keep ? (/^\s+$/.test(x) ? esc(x) : `<${tag}>${esc(x)}</${tag}>`) : '').join('');
  return {
    mixed: ops.map(([k, x]) => k === '=' ? esc(x) : k === '-' ? `<del>${esc(x)}</del>` : `<ins>${esc(x)}</ins>`).join(''),
    was: part('-', 'del'), now: part('+', 'ins'),
  };
}
const DIFF_MODES = [['split', 'Было → стало'], ['new', 'Только новое'], ['mixed', 'Вперемешку']];
// pick — { skip, edits, notes } для предложения, ждущего решения: галочки, свой вариант, замечания.
function diffHtml(oldText, newText, mode = ui.diffMode || 'split', pick = null) {
  const pa = toLF(oldText).split(/\n{2,}/), pb = toLF(newText).split(/\n{2,}/);
  const ops = lcs(pa, pb);
  const html = []; let same = [], places = 0, was = [], now = [], inPart = false;
  const clip = s => { s = s.replace(/\s+/g, ' ').trim(); return s.length > 160 ? '…' + s.slice(-160) : s; };
  const paras = s => toLF(s).split(/\n{2,}/).map(x => x.trim()).filter(Boolean).map(x => `<p>${esc(x)}</p>`).join('') || '<p class="hint">— (вы убрали этот текст)</p>';
  const flushBlock = () => {
    if (!inPart) return;
    const mine = pick?.edits?.[places];
    if (was.length || now.length || mine != null) {
      if (mine != null) {
        if (mode === 'split') html.push(`<div class="was"><div class="lbl">Было</div>${was.join('') || '<p class="hint">— (новый текст)</p>'}</div>`);
        if (mode === 'mixed') html.push(now.join(''));
        html.push(`<div class="now mine"><div class="lbl">Стало — ваш вариант</div>${paras(mine)}</div>`);
      } else if (mode === 'split') {
        html.push(`<div class="was"><div class="lbl">Было</div>${was.join('') || '<p class="hint">— (новый текст)</p>'}</div>`);
        html.push(`<div class="now"><div class="lbl">Стало</div>${now.join('') || '<p class="hint">— (убрано)</p>'}</div>`);
      } else if (mode === 'new') html.push(now.join('') || '<p class="hint">— (здесь текст убран)</p>');
      else html.push(now.join(''));
    }
    for (const n of pick?.notes?.[places] || []) html.push(`<div class="pnote"><span class="lbl">Ваше замечание${n.replies?.length ? ` · ответов: ${n.replies.length}` : ''}</span>${esc(n.comment)}</div>`);
    was = []; now = [];
  };
  const flushSame = beforeChange => {
    flushBlock();
    if (inPart) { html.push('</div>'); inPart = false; }
    const ctx = beforeChange && same.length ? same.at(-1) : null;
    const hidden = same.length - (ctx == null ? 0 : 1);
    if (hidden) html.push(`<div class="gap">… без изменений: ${hidden} абз. …</div>`);
    if (beforeChange) {
      const n = ++places, off = pick?.skip?.has(n), remarked = !!pick?.notes?.[n]?.length;
      html.push(`<div class="part${off ? ' off' : ''}"${pick ? ` data-open="${n}"` : ''}>`); inPart = true;
      html.push(pick ? `<div class="row"><label class="mark pick"><input type="checkbox" data-part="${n}" ${off ? '' : 'checked'}> Правка ${n}${off ? (remarked ? ' — не принимать, есть замечание' : ' — не принимать') : ''}</label><span class="grow"></span><span class="tap">✎ исправить · замечание</span></div>` : `<div class="mark">Правка ${n}</div>`);
    }
    if (ctx != null) html.push(`<p class="ctx">${esc(clip(ctx))}</p>`);
    same = [];
  };
  for (let k = 0; k < ops.length; k++) {
    const [t, x] = ops[k];
    if (t === '=') { same.push(x); continue; }
    if (k === 0 || ops[k - 1][0] === '=') flushSame(true);
    // В режиме «вперемешку» смешанный абзац копится в now, чтобы выводиться внутри своей правки.
    if (t === '-' && ops[k + 1]?.[0] === '+') {
      const d = wordDiff(x, ops[k + 1][1]); k++;
      if (mode === 'mixed') now.push(`<p>${d.mixed}</p>`); else { was.push(`<p>${d.was}</p>`); now.push(`<p>${d.now}</p>`); }
    } else if (mode === 'mixed') now.push(t === '-' ? `<p><del>${esc(x)}</del></p>` : `<p><ins>${esc(x)}</ins></p>`);
    else if (t === '-') was.push(`<p><del>${esc(x)}</del></p>`);
    else now.push(`<p><ins>${esc(x)}</ins></p>`);
  }
  flushSame(false);
  if (!places) return '<div class="empty">Текст не отличается.</div>';
  const modes = `<div class="filters dmodes">${DIFF_MODES.map(([k, l]) => `<button data-dmode="${k}" class="${k === mode ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  return `${modes}<p class="hint">Мест с правками: ${places}.</p><div class="diff ${mode}">${html.join('')}</div>`;
}

// --- версии ---
let historyRequest = 0;
async function renderHistory(ch) {
  const request = ++historyRequest, version = route.version;
  const active = () => request === historyRequest && route.screen === 'chapter' && route.tab === 'history' &&
    route.chapter === ch.id && route.version?.sha === version?.sha;
  const v = $('#view');
  if (!navigator.onLine) { v.innerHTML = '<div class="empty">Версии доступны только с Интернетом. Каждая сохранённая правка хранится в GitHub.</div>'; return; }
  if (route.version) {
    v.innerHTML = '<div class="empty">Загружаю…</div>';
    try {
      const f = await getFile(ch.file, version.sha);
      if (!active()) return;
      const text = f ? toLF(f.text) : '';
      v.innerHTML = `<div class="row"><button class="btn" id="vback">‹ Все версии</button><span class="grow"></span><button class="btn" id="restore">Вернуть эту версию</button></div>
        <p class="hint">${esc(version.msg)} · ${fmtDate(version.date)}</p>
        <details><summary class="hint">Чем отличается от текущего текста</summary><div class="diff">${diffHtml(chapterText(ch) || '', text)}</div></details>
        <article class="article">${mdToHtml(text)}</article>`;
      $('#vback').onclick = () => go({ version: null });
      $('#restore').onclick = () => {
        if (!confirm('Вернуть главу к этой версии? Текущий текст тоже останется в истории.')) return;
        const prev = pendingEdit(ch.id);
        if (enqueue({ type: 'edit', chapter: ch.id, base: prev ? prev.base : data.files[ch.file]?.sha, text })) go({ version: null, tab: 'read' });
      };
    } catch (e) { if (active()) v.innerHTML = `<div class="empty">Не удалось загрузить: ${esc(e.detail || e.message)}</div>`; }
    return;
  }
  v.innerHTML = '<div class="empty">Загружаю историю…</div>';
  try {
    const list = await gh(`${repoPath()}/commits?path=${encodeURIComponent(ch.file)}&sha=${encodeURIComponent(branch())}&per_page=40`);
    if (!active()) return;
    v.innerHTML = `<div class="list">${list.map(c => `<button class="item" data-v="${esc(c.sha)}" data-msg="${esc(c.commit.message.split('\n')[0])}" data-date="${esc(c.commit.author.date)}">
      <div class="t">${esc(c.commit.message.split('\n')[0])}</div><div class="s">${fmtDate(c.commit.author.date)}</div></button>`).join('')}</div>`;
    v.querySelectorAll('[data-v]').forEach(b => b.onclick = () => go({ version: { sha: b.dataset.v, msg: b.dataset.msg, date: b.dataset.date } }));
  } catch (e) { if (active()) v.innerHTML = `<div class="empty">Не удалось загрузить историю: ${esc(e.detail || e.message)}</div>`; }
}

async function openConflict(path) {
  const c = (data.conflicts || []).find(c => c.path === path); if (!c) return;
  const ch = chapterById(c.chapter);
  const mine = data.files[path] ? toLF(data.files[path].text) : null;
  const d = $('#sheet');
  d.dataset.conflict = path;
  d.innerHTML = `<h3>Конфликт: ${esc(ch?.title || c.chapter)}</h3>
    <p class="hint">Пока вы правили без сети, глава изменилась в GitHub. Ваша версия сохранена в файле ${esc(path)}. Ниже — чем ваша версия отличается от текущей.</p>
    <div class="diff scroll">${mine != null && ch ? diffHtml(serverChapter(ch) || '', mine) : 'Файл ещё не загружен.'}</div>
    <div class="row end mt">
      <button class="btn" id="cl">Закрыть</button>
      <button class="btn" id="keep">Оставить текущую</button>
      <button class="btn primary" id="mine" ${mine == null ? 'disabled' : ''}>Взять мою</button></div>
    <p class="hint">Можно и не решать сейчас — попросите агента свести обе версии.</p>`;
  d.showModal();
  const resolve = () => { data.conflicts = data.conflicts.filter(x => x !== c); saveData(); d.close(); render(); };
  $('#cl').onclick = () => d.close();
  $('#keep').onclick = resolve;
  $('#mine').onclick = () => { if (enqueue({ type: 'edit', chapter: ch.id, base: data.files[ch.file]?.sha, text: mine })) resolve(); };
}

// --- настройки ---
function renderSettings() {
  $('#title').textContent = 'Настройки';
  $('#tabs').hidden = true; $('#back').hidden = !cfg.token;
  const v = $('#view');
  v.innerHTML = `<div class="form">
    <p class="hint">Версия редактора: ${APP_VERSION}</p>${appInfoHtml()}
    <p>Редактор хранит главы на телефоне и синхронизирует их с вашим закрытым репозиторием GitHub. Для этого нужен ключ доступа — один раз.</p>
    <ol class="steps">
      <li>Откройте <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com → новый ключ</a> (войдите в аккаунт).</li>
      <li>Token name: <b>Редактор телефон</b>. Expiration: <b>1 год</b> (или без срока).</li>
      <li>Repository access: <b>Only select repositories</b> → <b>${esc(cfg.repo)}</b>.</li>
      <li>Permissions → Repository → <b>Contents: Read and write</b>.</li>
      <li>Нажмите <b>Generate token</b>, скопируйте ключ и вставьте ниже.</li>
    </ol>
    <label class="f" for="tok">Ключ GitHub</label>
    <input id="tok" type="password" autocomplete="off" placeholder="github_pat_…" value="${esc(cfg.token)}">
    <label class="f" for="own">Владелец</label><input id="own" type="text" value="${esc(cfg.owner)}">
    <label class="f" for="rep">Репозиторий</label><input id="rep" type="text" value="${esc(cfg.repo)}">
    <div class="row end mt">
      ${cfg.token ? '<button class="btn danger" id="logout">Выйти и стереть с телефона</button>' : ''}
      <button class="btn primary" id="check">Сохранить и проверить</button>
    </div>
    <p id="res"></p>
    <p class="hint">Ключ хранится только на этом телефоне и даёт доступ только к одному репозиторию. Если телефон потеряется — удалите ключ на github.com/settings/personal-access-tokens.</p>
  </div>`;
  $('#view').querySelectorAll('[data-check-update]').forEach(b => b.onclick = checkAppUpdate);
  $('#check').onclick = async () => {
    cfg = { ...cfg, owner: $('#own').value.trim(), repo: $('#rep').value.trim(), token: $('#tok').value.trim() };
    save(KEY.cfg, cfg);
    const res = $('#res'); res.className = ''; res.textContent = 'Проверяю…';
    try {
      const r = await gh(repoPath());
      if (!r.permissions?.push) { res.className = 'bad'; res.textContent = 'Ключ даёт только чтение. Включите Contents: Read and write.'; return; }
      res.className = 'ok'; res.textContent = 'Доступ есть. Нажмите «Синхронизировать», чтобы загрузить главы.';
      syncError = null; go({ screen: 'chapters' });
    } catch (e) {
      res.className = 'bad';
      res.textContent = !navigator.onLine ? 'Нет Интернета.' : e.status === 401 ? 'Ключ не подходит.' : e.status === 404 ? 'Репозиторий не найден или ключ не даёт к нему доступ.' : 'Ошибка: ' + (e.detail || e.message);
    }
  };
  const lo = $('#logout');
  if (lo) lo.onclick = () => {
    const warn = queue.length ? `\n\nВНИМАНИЕ: ${queue.length} изменений ещё не отправлены и пропадут.` : '';
    if (!confirm('Стереть ключ и все главы с этого телефона?' + warn)) return;
    Object.keys(localStorage).filter(k => k.startsWith('cs.')).forEach(k => localStorage.removeItem(k));
    location.reload();
  };
}

// ---------- запуск ----------
$('#back').onclick = () => {
  if (route.screen === 'settings') return go({ screen: route.chapter ? 'chapter' : 'chapters' });
  if (route.proposal) return go({ proposal: null });
  if (route.version) return go({ version: null });
  go({ screen: 'chapters', chapter: null });
};
$('#sync').onclick = () => cfg.token ? sync() : go({ screen: 'settings' });
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => go({ tab: b.dataset.tab, proposal: null, version: null, rawEdit: false, clean: false }));
document.addEventListener('change', e => {
  const c = e.target.closest?.('[data-part]'); if (!c || !route.proposal) return;
  const n = +c.dataset.part, y = c.getBoundingClientRect().top;
  if (!selectPart(route.proposal, n, c.checked)) c.checked = !c.checked;
  render();
  const again = document.querySelector(`[data-part="${n}"]`);
  if (again) window.scrollBy(0, again.getBoundingClientRect().top - y);
});
document.addEventListener('click', e => {
  const part = e.target.closest?.('[data-open]');
  if (part && !e.target.closest('.pick') && route.proposal) return openPartSheet(+part.dataset.open);
  const b = e.target.closest?.('[data-dmode]'); if (!b) return;
  const y = b.getBoundingClientRect().top;
  ui.diffMode = b.dataset.dmode; save(KEY.ui, ui);
  if (b.closest('dialog')) { const p = b.closest('dialog').dataset.conflict; b.closest('dialog').close(); return openConflict(p); }
  render();
  const again = document.querySelector(`[data-dmode="${b.dataset.dmode}"]`);
  if (again) window.scrollBy(0, again.getBoundingClientRect().top - y);
});
addEventListener('online', renderStatus);
addEventListener('offline', renderStatus);
addEventListener('scroll', rememberReading, { passive: true });
document.documentElement.dataset.theme = ui.theme || '';

if ('serviceWorker' in navigator) {
  // Reload automatically only on the idle home screen; active forms and proposal
  // reviews get an update button instead of losing unsaved input.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) { if (applyingUpdate) location.reload(); else requestAppUpdate(); }
  });
  navigator.serviceWorker.register('sw.js').then(reg => {
    const ready = () => { if (reg.waiting) requestAppUpdate(reg.waiting); };
    ready();
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => { if (worker.state === 'installed') ready(); });
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
}
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

render();
// При открытии редактора — одна синхронизация, если есть сеть и ключ.
// Возвращение в приложение, появление сети и таймеры её не запускают.
if (cfg.token && navigator.onLine) sync();
