// Ядро поиска: не зависит от браузера, работает поверх любой SQLite с FTS5.
// db.all(sql, params) -> массив объектов.
import { SYNONYMS, JOINERS, STOP } from "./synonyms.js";

export function tokenize(q) {
  let s = q.toLowerCase();
  for (const [re, rep] of JOINERS) s = s.replace(re, rep);
  const toks = s.match(/[a-z0-9]+/g) || [];
  const out = [];
  for (const t of toks) {
    if (STOP.has(t)) continue;
    if (t.length < 2 && !/\d/.test(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function qp(s) { // фраза в кавычках для FTS5
  return '"' + s.replace(/"/g, '""') + '"';
}

const cleanAlt = (a) => a.replace(/[^a-z0-9 \-\/]/gi, " ").replace(/[-\/]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

// Глоссарий сокращений базы: { abbrs: Map(ABBR -> term) }. Дополнительные альтернативы для слов запроса:
//  - слово запроса само является сокращением (vapp) -> добавляем его расшифровку ("approach speed");
//  - все слова расшифровки (из 2+ слов) есть в запросе -> каждое из них получает альтернативу-сокращение.
export function glossaryAlts(toks, gloss) {
  const extra = {};
  if (!gloss || !gloss.size) return extra;
  const add = (t, a) => { (extra[t] = extra[t] || []).includes(a) || extra[t].push(a); };
  const set = new Set(toks);
  if (!gloss.rev) {
    gloss.rev = [];
    for (const [ab, term] of gloss) {
      const words = (term.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOP.has(w));
      if (words.length >= 2) gloss.rev.push({ ab: cleanAlt(ab), words });
    }
  }
  for (const t of toks) {
    const term = gloss.get(t.toUpperCase());
    if (term && t.length >= 3) add(t, cleanAlt(term));
  }
  const hits = gloss.rev.filter((e) => e.ab && e.words.every((w) => set.has(w)));
  hits.sort((a, b) => b.words.length - a.words.length);
  for (const h of hits.slice(0, 4)) for (const w of h.words) add(w, h.ab);
  return extra;
}

// Токен -> группа альтернатив: (token OR "alt phrase" OR ...)
function group(t, extra) {
  const alts = [qp(t)];
  for (const a of [...(SYNONYMS[t] || []), ...((extra && extra[t]) || [])]) {
    const cleaned = a.replace(/[^a-z0-9 \-\/]/gi, " ").replace(/[-\/]/g, " ").trim();
    if (cleaned) alts.push(qp(cleaned));
  }
  return alts.length > 1 ? "(" + alts.join(" OR ") + ")" : alts[0];
}

// Альтернативы токена: сам токен + синонимы, очищенные до одного слова/фразы
function alts(t, extra) {
  const out = [t];
  for (const a of [...(SYNONYMS[t] || []), ...((extra && extra[t]) || [])]) {
    const c = a.replace(/[^a-z0-9 \-\/]/gi, " ").replace(/[-\/]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

// Соседние пары слов как фразы (с синонимами): "cab alt", "cabin altitude" ...
function bigramMatch(toks, extra) {
  const phrases = [];
  for (let i = 0; i + 1 < toks.length; i++) {
    for (const a of alts(toks[i], extra).slice(0, 4)) {
      for (const b of alts(toks[i + 1], extra).slice(0, 4)) phrases.push(qp(a + " " + b));
    }
  }
  return phrases.length ? phrases.join(" OR ") : null;
}

export function buildQueries(q, gloss) {
  const toks = tokenize(q);
  if (!toks.length) return { toks, tiers: [] };
  const extra = glossaryAlts(toks, gloss);
  const groups = toks.map((t) => group(t, extra));
  const tiers = [];
  if (toks.length >= 2) tiers.push({ name: "phrase", match: qp(toks.join(" ")) });
  const bg = toks.length >= 2 ? bigramMatch(toks, extra) : null;
  if (bg) tiers.push({ name: "pair", match: bg });
  if (toks.length >= 2) tiers.push({ name: "all", match: groups.join(" AND ") });
  tiers.push({ name: "any", match: groups.join(" OR ") });
  return { toks, tiers, extra };
}

const HL_A = "\u0001", HL_B = "\u0002";

const TIER_WEIGHT = { phrase: 3.0, all: 2.0, pair: 2.0, any: 1.0 };

const SEM_WEIGHT = 3;

export function search(db, q, { doc = null, docs = null, limit = 20, gloss = null, sem = null } = {}) {
  const list = docs && docs.length ? docs : doc ? [doc] : null;
  const { toks, tiers, extra } = buildQueries(q, gloss);
  // Объединяем уровни по принципу взвешенного rank fusion: страница, найденная
  // несколькими способами (фраза, все слова, пары слов), поднимается выше.
  const fused = new Map(); // "doc#page" -> {row, score}
  for (const tier of tiers) {
    const sql = `SELECT c.id, c.doc, c.page, c.label, c.heading,
                        snippet(fts, 0, '${HL_A}', '${HL_B}', ' … ', 28) AS snip,
                        bm25(fts, 1.0, 3.0) AS score
                 FROM fts JOIN chunks c ON c.id = fts.rowid
                 WHERE fts MATCH ? ${list ? "AND c.doc IN (" + list.map(() => "?").join(",") + ")" : ""}
                 ORDER BY score LIMIT 80`;
    let rows;
    try {
      rows = db.all(sql, list ? [tier.match, ...list] : [tier.match]);
    } catch (e) {
      continue; // некорректный запрос для этого уровня
    }
    const w = TIER_WEIGHT[tier.name] || 1;
    const seenPages = new Set();
    let rank = 0;
    for (const r of rows) {
      const key = r.doc + "#" + r.page;
      if (seenPages.has(key)) continue;
      seenPages.add(key);
      const add = w / (20 + rank);
      rank++;
      const cur = fused.get(key);
      if (!cur) fused.set(key, { row: { ...r, tier: tier.name }, score: add, tiers: [tier.name] });
      else {
        cur.score += add;
        cur.tiers.push(tier.name);
        if (w > (TIER_WEIGHT[cur.row.tier] || 1)) cur.row = { ...r, tier: tier.name };
      }
    }
  }
  // Смысловой слой: страницы, найденные по близости смысла, добавляются в тот же рейтинг.
  if (sem && sem.length) {
    let rank = 0;
    for (const m of sem) {
      const key = m.doc + "#" + m.page;
      const add = SEM_WEIGHT / (20 + rank);
      rank++;
      const cur = fused.get(key);
      if (cur) { cur.score += add; cur.tiers.push("sem"); continue; }
      const r = db.all("SELECT id, doc, page, label, heading, text FROM chunks WHERE id = ?", [m.id])[0];
      if (!r) continue;
      fused.set(key, { row: { id: r.id, doc: r.doc, page: r.page, label: r.label, heading: r.heading,
        snip: plainSnippet(r.text, toks, extra), score: 0, tier: "sem" }, score: add, tiers: ["sem"] });
    }
  }
  const results = [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({ ...x.row, tiers: x.tiers, fscore: x.score }));
  return { toks, results };
}

// Фрагмент без FTS: лучшее окно из ~3 строк по совпадению слов запроса (по началу слова), с маркерами подсветки
export function plainSnippet(text, toks, extra) {
  let lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const di = lines.slice(0, 16).findIndex((l) => /^\d{1,2} [A-Z]{3} \d\d$/.test(l)); // шапка страницы FCOM кончается датой ревизии
  if (di >= 0 && di < lines.length - 1) lines = lines.slice(di + 1);
  const body = lines.filter((l) => !/^(Ident\.:|Applicable to:)/.test(l));
  const stems = [...new Set(toks.map((t) => t.slice(0, Math.max(4, t.length - 2))))];
  for (const t of toks) for (const a of (extra && extra[t]) || []) if (a.length >= 2) stems.push(a.slice(0, Math.max(4, a.length - 2)));
  const hit = (l) => { const low = l.toLowerCase(); let n = 0; for (const s of stems) if (low.includes(s)) n++; return n; };
  let bestI = 0, bestS = -1;
  for (let i = 0; i < body.length; i++) {
    const sc = hit(body[i]) * 2 + (body[i + 1] ? hit(body[i + 1]) : 0) + (body[i + 2] ? hit(body[i + 2]) : 0) * 0.5;
    if (sc > bestS) { bestS = sc; bestI = i; }
  }
  let out = body.slice(bestI, bestI + 3).join(" ").slice(0, 320);
  for (const s of stems) out = out.replace(new RegExp("\\b(" + s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[a-z]*)", "gi"), "\u0001$1\u0002");
  return out;
}

export function pageChunks(db, docName, page) {
  return db.all("SELECT id, page, label, heading, text FROM chunks WHERE doc = ? AND page = ? ORDER BY id", [docName, page]);
}

export function metaOf(db) {
  const m = {};
  try { for (const r of db.all("SELECT key, value FROM meta", [])) m[r.key] = r.value; } catch (e) {}
  return m;
}

export function docList(db) {
  return db.all("SELECT * FROM docs ORDER BY doc", []);
}

export function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Текст с маркерами подсветки -> безопасный HTML
export function snippetHtml(snip) {
  return escapeHtml(snip).replace(/\u0001/g, "<mark>").replace(/\u0002/g, "</mark>");
}

// Подсветка слов запроса в полном тексте чанка
export function highlightFull(text, toks) {
  let html = escapeHtml(text);
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = [];
  for (const t of toks) parts.push("\\b" + esc(t) + "[a-z]*");           // слово и его формы
  for (const t of toks) for (const a of SYNONYMS[t] || []) if (/^[a-z0-9]+$/i.test(a)) parts.push("\\b" + esc(a) + "\\b"); // синонимы - только целиком
  if (!parts.length) return html;
  const re = new RegExp("(" + parts.join("|") + ")", "gi");
  return html.replace(re, (m) => "<mark>" + m + "</mark>");
}
