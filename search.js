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

// Токен -> группа альтернатив: (token OR "alt phrase" OR ...)
function group(t) {
  const alts = [qp(t)];
  for (const a of SYNONYMS[t] || []) {
    const cleaned = a.replace(/[^a-z0-9 \-\/]/gi, " ").replace(/[-\/]/g, " ").trim();
    if (cleaned) alts.push(qp(cleaned));
  }
  return alts.length > 1 ? "(" + alts.join(" OR ") + ")" : alts[0];
}

// Альтернативы токена: сам токен + синонимы, очищенные до одного слова/фразы
function alts(t) {
  const out = [t];
  for (const a of SYNONYMS[t] || []) {
    const c = a.replace(/[^a-z0-9 \-\/]/gi, " ").replace(/[-\/]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

// Соседние пары слов как фразы (с синонимами): "cab alt", "cabin altitude" ...
function bigramMatch(toks) {
  const phrases = [];
  for (let i = 0; i + 1 < toks.length; i++) {
    for (const a of alts(toks[i]).slice(0, 4)) {
      for (const b of alts(toks[i + 1]).slice(0, 4)) phrases.push(qp(a + " " + b));
    }
  }
  return phrases.length ? phrases.join(" OR ") : null;
}

export function buildQueries(q) {
  const toks = tokenize(q);
  if (!toks.length) return { toks, tiers: [] };
  const groups = toks.map(group);
  const tiers = [];
  if (toks.length >= 2) tiers.push({ name: "phrase", match: qp(toks.join(" ")) });
  const bg = toks.length >= 2 ? bigramMatch(toks) : null;
  if (bg) tiers.push({ name: "pair", match: bg });
  if (toks.length >= 2) tiers.push({ name: "all", match: groups.join(" AND ") });
  tiers.push({ name: "any", match: groups.join(" OR ") });
  return { toks, tiers };
}

const HL_A = "\u0001", HL_B = "\u0002";

const TIER_WEIGHT = { phrase: 3.0, all: 2.0, pair: 2.0, any: 1.0 };

export function search(db, q, { doc = null, docs = null, limit = 20 } = {}) {
  const list = docs && docs.length ? docs : doc ? [doc] : null;
  const { toks, tiers } = buildQueries(q);
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
  const results = [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({ ...x.row, tiers: x.tiers, fscore: x.score }));
  return { toks, results };
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
  return db.all("SELECT doc, file, pages, chunks, pdf_date, revision FROM docs ORDER BY doc", []);
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
