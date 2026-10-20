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

export async function initEmbedder(base, ortModule) {
  // base - адрес каталога app (со слэшем в конце)
  const v = await (await fetch(base + "model/vocab.json")).json();
  vocabMap = new Map(v.vocab.map((t, i) => [t, i]));
  unkId = vocabMap.get(v.unk);
  ort = ortModule || (await import(base + "vendor/ort/ort.wasm.min.mjs"));
  ort.env.wasm.wasmPaths = base + "vendor/ort/";
  ort.env.wasm.numThreads = 1; // многопоточность требует особых заголовков сервера
  const buf = new Uint8Array(await (await fetch(base + "model/minilm-int8.onnx")).arrayBuffer());
  session = await ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
}

export async function embed(text) {
  const ids = encode(text);
  const n = ids.length;
  const mk = (arr) => new ort.Tensor("int64", BigInt64Array.from(arr, (x) => BigInt(x)), [1, n]);
  const out = await session.run({
    input_ids: mk(ids),
    attention_mask: mk(new Array(n).fill(1)),
    token_type_ids: mk(new Array(n).fill(0)),
  });
  const h = out.last_hidden_state.data; // [1,n,384]
  const v = new Float32Array(384);
  for (let i = 0; i < n; i++) for (let j = 0; j < 384; j++) v[j] += h[i * 384 + j];
  let norm = 0;
  for (let j = 0; j < 384; j++) { v[j] /= n; norm += v[j] * v[j]; }
  norm = Math.sqrt(norm) || 1;
  for (let j = 0; j < 384; j++) v[j] /= norm;
  return v;
}
