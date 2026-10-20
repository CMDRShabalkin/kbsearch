// Векторный поиск по таблице emb (int8, 384 числа на фрагмент). Всё считается в браузере.
const DIM = 384;
const cache = new WeakMap();

export function hasSem(g) {
  try { g.kb.all("SELECT 1 FROM emb LIMIT 1", []); return true; } catch (e) { return false; }
}

function load(g) {
  let s = cache.get(g);
  if (s) return s;
  const rows = g.kb.all("SELECT e.chunk_id AS id, c.doc AS doc, c.page AS page, e.vec AS vec FROM emb e JOIN chunks c ON c.id = e.chunk_id", []);
  const n = rows.length;
  const mat = new Int8Array(n * DIM), ids = new Int32Array(n), pages = new Int32Array(n), docNo = new Uint16Array(n);
  const names = [], idx = new Map();
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    mat.set(new Int8Array(r.vec.buffer, r.vec.byteOffset, DIM), i * DIM);
    ids[i] = r.id; pages[i] = r.page;
    let d = idx.get(r.doc);
    if (d === undefined) { d = names.length; names.push(r.doc); idx.set(r.doc, d); }
    docNo[i] = d;
  }
  s = { n, mat, ids, pages, docNo, names };
  cache.set(g, s);
  return s;
}

// Лучшие страницы по смыслу: [{id, doc, page, score}], не больше k, одна запись на (doc,page)
export function topPages(g, qvec, allowedDocs, k = 60) {
  const s = load(g);
  const ok = allowedDocs ? s.names.map((d) => allowedDocs.has(d)) : null;
  const best = new Map();
  const q = qvec;
  for (let i = 0; i < s.n; i++) {
    if (ok && !ok[s.docNo[i]]) continue;
    let dot = 0, o = i * DIM;
    for (let j = 0; j < DIM; j++) dot += q[j] * s.mat[o + j];
    dot /= 127;
    const key = s.docNo[i] * 1000003 + s.pages[i];
    const cur = best.get(key);
    if (!cur || dot > cur.score) best.set(key, { id: s.ids[i], doc: s.names[s.docNo[i]], page: s.pages[i], score: dot });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, k);
}
