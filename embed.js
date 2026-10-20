// Смысловые эмбеддинги в браузере: токенизатор BERT WordPiece + all-MiniLM-L6-v2 (int8) через onnxruntime-web.
// Работает полностью офлайн: модель и библиотека лежат в app/model и app/vendor/ort.
let vocabMap = null, unkId = 100, tok = null, session = null, ort = null;

function isPunct(ch) {
  const c = ch.codePointAt(0);
  if ((c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)) return true;
  return /\p{P}/u.test(ch);
}

// Как BertNormalizer(lowercase=true, strip_accents) + BertPreTokenizer
export function basicTokens(text) {
  let s = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  s = s.replace(/[\u0000�]/g, "");
  let out = [], cur = "";
  for (const ch of s) {
    if (/\s/.test(ch)) { if (cur) out.push(cur); cur = ""; }
    else if (isPunct(ch) || /\p{Script=Han}/u.test(ch)) { if (cur) out.push(cur); cur = ""; out.push(ch); }
    else if (/\p{C}/u.test(ch)) { /* управляющие символы выбрасываем */ }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export function wordpiece(word) {
  if (word.length > 100) return [unkId];
  const ids = [];
  let start = 0;
  const chars = Array.from(word);
  while (start < chars.length) {
    let end = chars.length, found = null;
    while (start < end) {
      let sub = chars.slice(start, end).join("");
      if (start > 0) sub = "##" + sub;
      if (vocabMap.has(sub)) { found = vocabMap.get(sub); break; }
      end--;
    }
    if (found === null) return [unkId];
    ids.push(found);
    start = end;
  }
  return ids;
}

export function encode(text, maxLen = 256) {
  const ids = [101];
  for (const w of basicTokens(text)) {
    for (const id of wordpiece(w)) ids.push(id);
    if (ids.length >= maxLen - 1) break;
  }
  if (ids.length > maxLen - 1) ids.length = maxLen - 1;
  ids.push(102);
  return ids;
}

const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const parts = (n) => Array.from({ length: n }, (_, i) => i + 1);
let rerankSession = null;

async function fetchModel(base, name, nParts) {
  // Большие модели лежат кусками (лимит 25 МБ на файл при загрузке на GitHub): name.part1, name.part2 ...
  if (!nParts) return new Uint8Array(await (await fetch(base + "model/" + name)).arrayBuffer());
  const bufs = [];
  for (const i of parts(nParts)) bufs.push(new Uint8Array(await (await fetch(base + "model/" + name + ".part" + i)).arrayBuffer()));
  const out = new Uint8Array(bufs.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const b of bufs) { out.set(b, o); o += b.length; }
  return out;
}

async function loadOrt(base, ortModule) {
  if (ort) return;
  ort = ortModule || (await import(base + "vendor/ort/ort.wasm.min.mjs"));
  ort.env.wasm.wasmPaths = base + "vendor/ort/";
  ort.env.wasm.numThreads = 1; // многопоточность требует особых заголовков сервера
}

export async function initEmbedder(base, ortModule) {
  // base - адрес каталога app (со слэшем в конце)
  const v = await (await fetch(base + "model/vocab.json")).json();
  vocabMap = new Map(v.vocab.map((t, i) => [t, i]));
  unkId = vocabMap.get(v.unk);
  await loadOrt(base, ortModule);
  session = await ort.InferenceSession.create(await fetchModel(base, "bge-small-q8.onnx", 5), { executionProviders: ["wasm"] });
}

const mkT = (arr, n, b = 1) => new ort.Tensor("int64", BigInt64Array.from(arr, (x) => BigInt(x)), [b, n]);

// isQuery: для вопроса BGE добавляет инструкцию; для текста страниц - нет
export async function embed(text, isQuery = true) {
  const ids = encode((isQuery ? QUERY_PREFIX : "") + text);
  const n = ids.length;
  const out = await session.run({
    input_ids: mkT(ids, n),
    attention_mask: mkT(new Array(n).fill(1), n),
    token_type_ids: mkT(new Array(n).fill(0), n),
  });
  const h = out.last_hidden_state.data; // [1,n,384]; BGE берёт вектор первого токена [CLS]
  const v = new Float32Array(384);
  let norm = 0;
  for (let j = 0; j < 384; j++) { v[j] = h[j]; norm += v[j] * v[j]; }
  norm = Math.sqrt(norm) || 1;
  for (let j = 0; j < 384; j++) v[j] /= norm;
  return v;
}

// ---------- Переранжирование: cross-encoder ms-marco-MiniLM-L-6 (int8) ----------
export function encodePair(q, p, maxLen = 384) {
  const a = [101];
  for (const w of basicTokens(q)) for (const id of wordpiece(w)) a.push(id);
  if (a.length > 96) a.length = 96;
  a.push(102);
  const b = [];
  for (const w of basicTokens(p)) { for (const id of wordpiece(w)) b.push(id); if (a.length + b.length >= maxLen - 1) break; }
  if (a.length + b.length > maxLen - 1) b.length = maxLen - 1 - a.length;
  b.push(102);
  return { ids: a.concat(b), types: a.map(() => 0).concat(b.map(() => 1)) };
}

export async function initReranker(base) {
  if (rerankSession) return;
  await loadOrt(base);
  if (!vocabMap) {
    const v = await (await fetch(base + "model/vocab.json")).json();
    vocabMap = new Map(v.vocab.map((t, i) => [t, i]));
    unkId = vocabMap.get(v.unk);
  }
  rerankSession = await ort.InferenceSession.create(await fetchModel(base, "marco-l6-q8.onnx", 3), { executionProviders: ["wasm"] });
}

// Оценки релевантности (логиты) пар (вопрос, текст). Чем больше, тем лучше.
export async function rerankScores(query, passages, batch = 6) {
  const out = new Array(passages.length).fill(0);
  const enc = passages.map((p) => encodePair(query, p));
  const order = enc.map((_, i) => i).sort((x, y) => enc[x].ids.length - enc[y].ids.length);
  for (let s = 0; s < order.length; s += batch) {
    const idx = order.slice(s, s + batch);
    const L = Math.max(...idx.map((i) => enc[i].ids.length));
    const ids = new Array(idx.length * L).fill(0), am = new Array(idx.length * L).fill(0), tt = new Array(idx.length * L).fill(0);
    idx.forEach((i, r) => enc[i].ids.forEach((x, c) => { ids[r * L + c] = x; am[r * L + c] = 1; tt[r * L + c] = enc[i].types[c]; }));
    const res = await rerankSession.run({ input_ids: mkT(ids, L, idx.length), attention_mask: mkT(am, L, idx.length), token_type_ids: mkT(tt, L, idx.length) });
    const lg = res.logits.data;
    idx.forEach((i, r) => { out[i] = lg[r]; });
  }
  return out;
}
