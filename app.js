import sqlite3InitModule from "./vendor/sqlite3.mjs";
import { search, pageChunks, docList, metaOf, snippetHtml, highlightFull, tokenize, escapeHtml } from "./search.js";
import { initEmbedder, embed } from "./embed.js";
import { hasSem, topPages } from "./sem.js";
import { symbolsToWords, makeQueryExpander } from "./textnorm.js";
import { setUserEquiv, equivExpand, EQUIV } from "./synonyms.js";

const APP_VERSION = "1.3.4";
const $ = (id) => document.getElementById(id);
const IDB_NAME = "kbapp", IDB_STORE = "files", KEY_PREFIX = "kb:";

// ---------- IndexedDB ----------
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbReq(mode, fn) {
  const d = await idb();
  return new Promise((res, rej) => {
    const tx = d.transaction(IDB_STORE, mode);
    const out = fn(tx.objectStore(IDB_STORE));
    tx.oncomplete = () => res(out && "result" in out ? out.result : undefined);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error("Запись прервана (возможно, не хватает места)"));
  });
}
const idbGet = (k) => idbReq("readonly", (s) => s.get(k));
const idbPut = (k, v) => idbReq("readwrite", (s) => s.put(v, k));
const idbDel = (k) => idbReq("readwrite", (s) => s.delete(k));
const idbKeys = () => idbReq("readonly", (s) => s.getAllKeys());

// ---------- SQLite ----------
let S = null;
const dbs = []; // { id, title, priority, raw, kb, docs, info }

async function initSqlite() {
  if (!S) S = await sqlite3InitModule({ print() {}, printErr() {} });
  return S;
}

async function openBlob(blob, fallbackId) {
  await initSqlite();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const p = S.wasm.allocFromTypedArray(bytes);
  const raw = new S.oo1.DB();
  const flags = S.capi.SQLITE_DESERIALIZE_FREEONCLOSE | S.capi.SQLITE_DESERIALIZE_RESIZEABLE;
  const rc = S.capi.sqlite3_deserialize(raw.pointer, "main", p, bytes.length, bytes.length, flags);
  if (rc) { raw.close(); throw new Error("Не удалось открыть файл базы (код " + rc + ")"); }
  const kb = { all: (sql, params) => raw.exec({ sql, bind: params && params.length ? params : undefined, rowMode: "object", returnValue: "resultRows" }) };
  try {
    kb.all("SELECT count(*) AS n FROM chunks", []);
    kb.all("SELECT 1 FROM fts LIMIT 1", []);
  } catch (e) { raw.close(); throw new Error("Это не база KB Search (нет таблиц chunks/fts)"); }
  const m = metaOf(kb);
  const id = m.group_id || fallbackId || "docs";
  const gloss = new Map();
  try { for (const r of kb.all("SELECT abbr, term FROM abbr", [])) gloss.set(r.abbr, r.term); } catch (e) {}
  const entry = { id, title: m.title || id, priority: parseInt(m.priority || "1", 10) || 1, raw, kb, docs: docList(kb), gloss };
  entry.sem = hasSem(entry);
  return entry;
}

function setDb(entry) {
  window.__dbs = dbs;
  const i = dbs.findIndex((d) => d.id === entry.id);
  if (i >= 0) { try { dbs[i].raw.close(); } catch (e) {} dbs.splice(i, 1); }
  dbs.push(entry);
  dbs.sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));
}

// ---------- UI helpers ----------
const fmtMB = (b) => (b / 1048576).toFixed(b > 1e9 ? 0 : 1) + " МБ";
const show = (id, on = true) => $(id).classList.toggle("hidden", !on);
const totalPages = () => dbs.reduce((a, d) => a + d.docs.reduce((x, y) => x + (y.pages || 0), 0), 0);
const totalDocs = () => dbs.reduce((a, d) => a + d.docs.length, 0);
const multi = () => dbs.length > 1;

function updateNet() {
  const el = $("net");
  if (navigator.onLine) { el.textContent = "онлайн"; el.className = "chip"; }
  else { el.textContent = "офлайн"; el.className = "chip ok"; }
}
window.addEventListener("online", updateNet);
window.addEventListener("offline", updateNet);

const docLabel = (d) => (d.revision ? `${d.doc} (${d.revision})` : d.doc);

// ---------- Выбор документов (галочки) ----------
// Выбор хранится только пока приложение открыто; после перезапуска по умолчанию выбраны все документы.
const selected = new Set();   // "groupId|doc"
const known = new Set();
const key = (g, d) => g.id + "|" + d.doc;

function syncSelection() {
  const live = new Set();
  for (const g of dbs) for (const d of g.docs) {
    const k = key(g, d); live.add(k);
    if (!known.has(k)) { known.add(k); selected.add(k); } // новые документы выбраны сразу
  }
  for (const k of [...selected]) if (!live.has(k)) selected.delete(k);
  for (const k of [...known]) if (!live.has(k)) known.delete(k);
}

function updateScopeButton() {
  const total = totalDocs(), n = selected.size;
  const btn = $("btnScope");
  btn.innerHTML = `<span>Документы</span><small>${n === total ? "все (" + total + ")" : n + " из " + total}</small>`;
}

function renderScope() {
  const filt = ($("scopeFilter").value || "").trim().toLowerCase();
  const box = $("scopeList"); box.innerHTML = "";
  for (const g of dbs) {
    const docsShown = g.docs.filter((d) => !filt || docLabel(d).toLowerCase().includes(filt) || (d.file || "").toLowerCase().includes(filt));
    if (!docsShown.length) continue;
    const head = document.createElement("label"); head.className = "grp";
    const gc = document.createElement("input"); gc.type = "checkbox"; gc.style.cssText = "width:24px;height:24px;accent-color:var(--accent)";
    const cnt = g.docs.filter((d) => selected.has(key(g, d))).length;
    gc.checked = cnt === g.docs.length; gc.indeterminate = cnt > 0 && cnt < g.docs.length;
    gc.onchange = () => { for (const d of g.docs) { if (gc.checked) selected.add(key(g, d)); else selected.delete(key(g, d)); } renderScope(); updateScopeButton(); };
    head.appendChild(gc);
    head.appendChild(document.createTextNode(`${g.title} (${cnt}/${g.docs.length})`));
    box.appendChild(head);
    const subs = [...new Set(docsShown.map((d) => d.sub || ""))].sort((x, y) => x.localeCompare(y));
    const useSubs = subs.some((s) => s);
    const addRow = (d, indent) => {
      const row = document.createElement("label"); row.className = "chk"; if (indent) row.style.paddingLeft = "28px";
      const c = document.createElement("input"); c.type = "checkbox"; c.checked = selected.has(key(g, d));
      c.onchange = () => { if (c.checked) selected.add(key(g, d)); else selected.delete(key(g, d)); renderScope(); updateScopeButton(); };
      const t = document.createElement("span"); t.className = "nm";
      t.innerHTML = `${escapeHtml(d.doc)}<span class="sub">${escapeHtml(d.revision || "ревизия не определена")} · ${d.pages} стр.</span>`;
      row.appendChild(c); row.appendChild(t); box.appendChild(row);
    };
    for (const s of subs) {
      const inSub = docsShown.filter((d) => (d.sub || "") === s);
      if (useSubs) {
        const all = g.docs.filter((d) => (d.sub || "") === s);
        const n = all.filter((d) => selected.has(key(g, d))).length;
        const sh = document.createElement("label"); sh.className = "grp"; sh.style.cssText = "margin:12px 0 2px 14px;font-size:15px;font-weight:600";
        const sc = document.createElement("input"); sc.type = "checkbox"; sc.style.cssText = "width:22px;height:22px;accent-color:var(--accent)";
        sc.checked = n === all.length; sc.indeterminate = n > 0 && n < all.length;
        sc.onchange = () => { for (const d of all) { if (sc.checked) selected.add(key(g, d)); else selected.delete(key(g, d)); } renderScope(); updateScopeButton(); };
        sh.appendChild(sc); sh.appendChild(document.createTextNode(`${s || "Без подгруппы"} (${n}/${all.length})`));
        box.appendChild(sh);
      }
      for (const d of inSub) addRow(d, useSubs);
    }
  }
  if (!box.children.length) box.innerHTML = '<p class="note">Ничего не найдено в списке.</p>';
}

async function renderLibrary() {
  let h = "";
  for (const g of dbs) {
    const info = await idbGet(KEY_PREFIX + g.id);
    h += `<h3 style="margin:12px 0 4px">${escapeHtml(g.title)} <span class="note">· приоритет ${g.priority}${info ? " · " + fmtMB(info.size) : ""}</span></h3>`;
    h += "<table><tr><th>Документ</th><th>Ревизия</th><th>Стр.</th></tr>";
    for (const d of g.docs) h += `<tr><td>${escapeHtml(d.doc)}<br><span class="note">${escapeHtml(d.file || "")}</span></td><td>${escapeHtml(d.revision || "—")}</td><td>${d.pages}</td></tr>`;
    h += `</table><div class="tools"><button data-del="${escapeHtml(g.id)}" class="ghost">Удалить группу «${escapeHtml(g.title)}»</button></div>`;
  }
  $("libTable").innerHTML = h || '<p class="note">База не загружена.</p>';
  $("ver").textContent = `Версия приложения ${APP_VERSION}`;
}

async function renderStorage() {
  let t = "";
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      t += `Занято: ${fmtMB(e.usage || 0)}; доступная квота по оценке браузера: ${e.quota ? fmtMB(e.quota) : "?"}. `;
    }
    if (navigator.storage && navigator.storage.persisted) {
      const p = await navigator.storage.persisted();
      t += p ? "Постоянное хранилище: да." : "Постоянное хранилище: не подтверждено.";
    }
  } catch (e) { t = "Нет данных о хранилище."; }
  $("stor").textContent = t || "Нет данных о хранилище.";
}

// ---------- Import ----------
async function importFiles(files) {
  const bar = $("impBar"), fill = bar.firstElementChild, log = $("impLog");
  show("impBar", true); log.textContent = "";
  let ok = 0, i = 0;
  for (const file of files) {
    i++;
    fill.style.width = Math.round(((i - 1) / files.length) * 100 + 10) + "%";
    log.textContent += `Читаю ${file.name} (${fmtMB(file.size)})…\n`;
    try {
      const fallback = file.name.replace(/\.(sqlite3?|db)$/i, "").replace(/^kb_/, "");
      const entry = await openBlob(file, fallback);
      await idbPut(KEY_PREFIX + entry.id, { blob: file, name: file.name, size: file.size, imported: Date.now() });
      entry.info = { name: file.name, size: file.size };
      setDb(entry);
      log.textContent += `  ✓ группа «${entry.title}»: ${entry.docs.length} док., ${entry.docs.reduce((a, d) => a + d.pages, 0)} стр.\n`;
      ok++;
    } catch (e) {
      log.textContent += `  ✗ ${file.name}: ${e && e.message ? e.message : e}\n`;
    }
  }
  fill.style.width = "100%";
  if (ok) {
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
    await enterSearchMode();
  }
}

async function enterSearchMode() {
  syncSelection(); renderScope(); updateScopeButton();
  await renderLibrary();
  show("importBox", !dbs.length); show("libBox", false); show("scopeBox", false); show("searchBox", dbs.length > 0);
  renderRecent();
  $("meta").textContent = dbs.length ? `База: ${dbs.length} гр., ${totalDocs()} док., ${totalPages()} стр.` : "";
  if (dbs.length) $("q").focus({ preventScroll: true });
}

// ---------- Search UI ----------
function recentGet() { try { return JSON.parse(localStorage.getItem("recent") || "[]"); } catch (e) { return []; } }
function recentAdd(q) {
  try { const r = recentGet().filter((x) => x !== q); r.unshift(q); localStorage.setItem("recent", JSON.stringify(r.slice(0, 8))); } catch (e) {}
}
function renderRecent() {
  const box = $("recent"); box.innerHTML = "";
  if ($("q").value.trim()) return;
  for (const q of recentGet()) {
    const b = document.createElement("button"); b.className = "ghost"; b.textContent = q;
    b.onclick = () => { $("q").value = q; runSearch(true); };
    box.appendChild(b);
  }
}

const citation = (r) => {
  const d = r.g.docs.find((x) => x.doc === r.doc);
  const rev = d && d.revision ? ` (${d.revision})` : "";
  return `${r.doc}${rev}, PDF p.${r.page}${r.label ? " / printed " + r.label : ""}${r.heading ? ", " + r.heading : ""}`;
};

// ---------- Смысловой поиск: модель загружается один раз, офлайн ----------
let semState = "idle"; // idle | loading | ready | error
let semError = "";
let semPromise = null;
function ensureSem() {
  if (semPromise || !dbs.some((d) => d.sem)) return semPromise;
  semState = "loading";
  semPromise = initEmbedder(new URL("./", location.href).href)
    .then(() => { semState = "ready"; })
    .catch((e) => { semState = "error"; semError = String(e && e.message || e); console.error(e); });
  return semPromise;
}
function mergedGloss() {
  const m = new Map();
  for (const g of dbs) for (const [k, v] of g.gloss) if (!m.has(k)) m.set(k, v);
  return m;
}
let searchSeq = 0;

async function runSearch(save) {
  const mySeq = ++searchSeq;
  const q = $("q").value.trim();
  const res = $("results"), meta = $("meta"), empty = $("empty");
  res.innerHTML = ""; show("empty", false); renderRecent();
  if (!dbs.length) return;
  if (!q) { meta.textContent = `База: ${dbs.length} гр., ${totalDocs()} док., ${totalPages()} стр.`; return; }
  if (!tokenize(q).length) { meta.textContent = ""; empty.textContent = "Введите значимые слова."; show("empty", true); return; }
  const t0 = performance.now();
  if (selected.size === 0) { meta.textContent = ""; empty.textContent = "Не выбран ни один документ. Нажмите «Документы» и отметьте нужные."; show("empty", true); return; }
  let all = [], toks = [], qvec = null;
  const glossAll = mergedGloss();
  if (dbs.some((d) => d.sem) && !/nosem/.test(location.search)) {
    ensureSem();
    if (semState === "loading") meta.textContent = "Загружается смысловая модель…";
    await semPromise;
    if (mySeq !== searchSeq) return;
    if (semState === "ready") {
      try { qvec = await embed(equivExpand(makeQueryExpander(glossAll)(symbolsToWords(q)))); } catch (e) { semState = "error"; semError = String(e && e.message || e); }
    }
    if (mySeq !== searchSeq) return;
  }
  try {
    for (const g of dbs) {
      const chosen = g.docs.filter((d) => selected.has(key(g, d)));
      if (!chosen.length) continue;
      const allOfGroup = chosen.length === g.docs.length;
      const allowed = allOfGroup ? null : new Set(chosen.map((d) => d.doc));
      const sem = qvec && g.sem ? topPages(g, qvec, allowed, 60) : null;
      const out = search(g.kb, q, { docs: allOfGroup ? null : chosen.map((d) => d.doc), limit: 20, gloss: glossAll, sem });
      toks = out.toks;
      // группы с меньшим приоритетом (большим номером) слегка понижаются
      const mult = Math.pow(0.88, g.priority - 1);
      const wOf = new Map(g.docs.map((d) => [d.doc, d.weight == null ? 1 : d.weight])); // вес документа (подгруппа): справочные ниже
      for (const r of out.results) all.push({ ...r, g, rank: r.fscore * mult * (wOf.get(r.doc) ?? 1) });
    }
  } catch (e) { meta.textContent = ""; empty.textContent = "Ошибка поиска: " + e.message; show("empty", true); return; }
  all.sort((a, b) => b.rank - a.rank);
  all = all.slice(0, 20);
  const ms = Math.round(performance.now() - t0);
  if (save) recentAdd(q);
  const scopeNote = selected.size === totalDocs() ? "" : ` · документов: ${selected.size} из ${totalDocs()}`;
  const semNote = !dbs.some((d) => d.sem) ? " · смысл: нет в базе" : semState === "ready" ? " · смысл: да" : " · смысл: ошибка";
  meta.textContent = `${all.length} стр. · ${ms} мс · слова: ${toks.join(" ")}${scopeNote}${semNote}`;
  if (!all.length) { empty.textContent = "Ничего не найдено. Попробуйте другие слова или сокращения (например, cab alt)."; show("empty", true); return; }
  for (const r of all) res.appendChild(makeCard(r, toks));
}

function makeCard(r, toks) {
  const card = document.createElement("div"); card.className = "card";
  const d = r.g.docs.find((x) => x.doc === r.doc);
  const pg = `стр. PDF ${r.page}` + (r.label ? ` · печ. ${escapeHtml(r.label)}` : "");
  card.innerHTML = `<div class="top">${multi() ? `<span class="badge">${escapeHtml(r.g.title)}</span>` : ""}<span class="doc">${escapeHtml(r.doc)}</span><span>${d && d.revision ? escapeHtml(d.revision) : ""}</span><span class="pg">${pg}</span></div>` +
    (r.heading ? `<div class="head">${escapeHtml(r.heading)}</div>` : "") +
    `<div class="snip">${snippetHtml(r.snip)}</div><div class="tools"><button data-a="open">Открыть страницу</button><button data-a="copy" class="ghost">Копировать ссылку</button></div><div class="pagebox"></div>`;
  const box = card.querySelector(".pagebox");
  let curPage = r.page;
  const renderPage = (p) => {
    const chunks = pageChunks(r.g.kb, r.doc, p);
    curPage = p;
    const body = chunks.length ? chunks.map((c) => `<div class="full">${highlightFull(c.text, toks)}</div>`).join("") : `<div class="full">Нет текста на этой странице базы.</div>`;
    const lab = chunks.length && chunks[0].label ? ` · печ. ${escapeHtml(chunks[0].label)}` : "";
    box.innerHTML = `<div class="meta">${escapeHtml(r.doc)} · стр. PDF ${p}${lab}</div>${body}<div class="tools"><button data-a="prev">‹ стр. ${p - 1}</button><button data-a="next">стр. ${p + 1} ›</button><button data-a="close" class="ghost">Свернуть</button></div>`;
  };
  card.addEventListener("click", async (ev) => {
    const a = ev.target && ev.target.dataset && ev.target.dataset.a;
    if (!a) return;
    if (a === "open") renderPage(r.page);
    else if (a === "prev") renderPage(Math.max(1, curPage - 1));
    else if (a === "next") renderPage(curPage + 1);
    else if (a === "close") box.innerHTML = "";
    else if (a === "copy") {
      const text = citation(r);
      try { await navigator.clipboard.writeText(text); ev.target.textContent = "Скопировано"; }
      catch (e) { ev.target.textContent = text; }
    }
  });
  return card;
}

// ---------- Storage test ----------
async function storageTest() {
  const target = parseInt($("stTarget").value, 10) * 1048576;
  const bar = $("stBar"), fill = bar.firstElementChild, log = $("stLog");
  const btn = $("btnStorTest"); btn.disabled = true; show("stBar", true); fill.style.width = "0";
  log.textContent = "Пишу тестовые данные в память приложения. Не закрывайте приложение…";
  const mkPiece = () => { const p = new Uint8Array(16 * 1048576); for (let i = 0; i < p.length; i += 65536) crypto.getRandomValues(p.subarray(i, Math.min(i + 65536, p.length))); return p; };
  const keys = []; let written = 0; let err = null;
  const t0 = performance.now();
  try {
    while (written < target) {
      const key = "test" + keys.length;
      await idbPut(key, new Blob([mkPiece(), mkPiece(), mkPiece(), mkPiece()])); // 64 МБ, каждый раз разные данные
      keys.push(key); written += 64 * 1048576;
      fill.style.width = Math.min(100, Math.round(written / target * 100)) + "%";
      log.textContent = `Записано ${fmtMB(written)} из ${fmtMB(target)}…`;
    }
  } catch (e) { err = e; }
  const sec = ((performance.now() - t0) / 1000).toFixed(1);
  for (const k of keys) { try { await idbDel(k); } catch (e) {} }
  log.textContent = err
    ? `Остановилось на ${fmtMB(written)}: ${err.name || ""} ${err.message || err}. Тестовые данные удалены.`
    : `Записано и удалено ${fmtMB(written)} за ${sec} с. Ограничений не обнаружено.`;
  btn.disabled = false; renderStorage();
}

// ---------- Init ----------
async function main() {
  updateNet();
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("sw.js"); } catch (e) { console.warn("SW", e); }
  }
  $("btnLib").onclick = async () => { const on = $("libBox").classList.contains("hidden"); show("libBox", on); if (on) { show("scopeBox", false); await renderLibrary(); renderStorage(); } };
  $("btnAdd").onclick = () => { show("importBox", true); show("libBox", false); };
  $("libTable").addEventListener("click", async (ev) => {
    const id = ev.target && ev.target.dataset && ev.target.dataset.del;
    if (!id) return;
    if (!confirm("Удалить эту группу из приложения? Файл базы придётся загрузить заново.")) return;
    await idbDel(KEY_PREFIX + id);
    const i = dbs.findIndex((d) => d.id === id);
    if (i >= 0) { try { dbs[i].raw.close(); } catch (e) {} dbs.splice(i, 1); }
    await enterSearchMode(); show("libBox", true);
  });
  $("btnStorTest").onclick = storageTest;
  $("btnSynSave").onclick = async () => {
    const text = $("synText").value;
    try { const n = setUserEquiv(text); await idbPut("synonyms", text); $("synInfo").textContent = ` Сохранено групп: ${n}. Встроенных: ${EQUIV.length}.`; runSearch(false); }
    catch (e) { $("synInfo").textContent = " Ошибка: " + (e && e.message ? e.message : e); }
  };
  $("file").onchange = (e) => { const fs = [...(e.target.files || [])]; if (fs.length) importFiles(fs); e.target.value = ""; };
  let timer = null;
  $("q").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => runSearch(false), 250); });
  $("q").addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(timer); runSearch(true); $("q").blur(); } });
  $("btnScope").onclick = () => { const on = $("scopeBox").classList.contains("hidden"); show("scopeBox", on); if (on) { show("libBox", false); $("scopeFilter").value = ""; renderScope(); window.scrollTo({ top: 0 }); } };
  $("btnScopeDone").onclick = () => { show("scopeBox", false); runSearch(false); };
  $("btnScopeAll").onclick = () => { for (const g of dbs) for (const d of g.docs) selected.add(key(g, d)); renderScope(); updateScopeButton(); };
  $("btnScopeNone").onclick = () => { selected.clear(); renderScope(); updateScopeButton(); };
  $("scopeFilter").addEventListener("input", renderScope);

  try {
    // совместимость с версией 1.0: ключ "kb" -> группа "docs"
    try { const syn = await idbGet("synonyms"); if (typeof syn === "string") { $("synText").value = syn; setUserEquiv(syn); } } catch (e) {}
    const old = await idbGet("kb");
    if (old && old.blob) { await idbPut(KEY_PREFIX + "docs", old); await idbDel("kb"); }
    const keys = (await idbKeys()).filter((k) => typeof k === "string" && k.startsWith(KEY_PREFIX));
    for (const k of keys) {
      const saved = await idbGet(k);
      if (!saved || !saved.blob) continue;
      try { const e = await openBlob(saved.blob, k.slice(KEY_PREFIX.length)); e.info = { name: saved.name, size: saved.size }; setDb(e); }
      catch (err) { $("impLog").textContent += `Не удалось открыть ${saved.name}: ${err.message}\n`; }
    }
  } catch (e) {
    $("impLog").textContent = "Не удалось прочитать сохранённые данные: " + (e && e.message ? e.message : e);
  }
  await enterSearchMode();
  ensureSem(); // прогреваем смысловую модель в фоне
}
main();
