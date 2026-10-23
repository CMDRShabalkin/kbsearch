// Service worker: кэширует оболочку приложения, чтобы оно открывалось без интернета.
// При изменении любого файла приложения увеличьте номер версии.
const VERSION = "kbsearch-v1.4.5";
const SHELL = [
  "./", "index.html", "app.js", "search.js", "synonyms.js", "embed.js", "sem.js", "textnorm.js", "answer.js", "manifest.webmanifest",
  "icon-180.png", "icon-192.png", "icon-512.png",
  "vendor/sqlite3.mjs", "vendor/sqlite3.wasm",
  "vendor/ort/ort.wasm.min.mjs", "vendor/ort/ort-wasm-simd-threaded.mjs", "vendor/ort/ort-wasm-simd-threaded.wasm",
  "model/vocab.json", "model/bge-small-q8.onnx.part1", "model/bge-small-q8.onnx.part2", "model/bge-small-q8.onnx.part3", "model/bge-small-q8.onnx.part4", "model/bge-small-q8.onnx.part5", "model/marco-l6-q8.onnx.part1", "model/marco-l6-q8.onnx.part2", "model/marco-l6-q8.onnx.part3",
];

// Сообщения странице: ход загрузки ({type:"sw-progress", done, total, mb}) и готовность ({type:"sw-ready"}).
async function notify(msg) {
  const list = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const c of list) c.postMessage({ version: VERSION.replace("kbsearch-v", ""), ...msg });
}

// Файлы качаются по одному (а не addAll), чтобы показывать ход загрузки. Любая ошибка — установка отменяется, остаётся старая версия.
async function install() {
  const cache = await caches.open(VERSION);
  let bytes = 0;
  for (let i = 0; i < SHELL.length; i++) {
    const resp = await fetch(SHELL[i], { cache: "reload" });
    if (!resp.ok) throw new Error(SHELL[i] + ": " + resp.status);
    const body = await resp.clone().blob();
    bytes += body.size;
    await cache.put(SHELL[i], resp);
    await notify({ type: "sw-progress", done: i + 1, total: SHELL.length, mb: Math.round(bytes / 1048576) });
  }
}

self.addEventListener("install", (e) => {
  e.waitUntil(install().then(() => self.skipWaiting()).catch((err) => { notify({ type: "sw-error", error: String(err) }); throw err; }));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => notify({ type: "sw-ready" }))
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((resp) => {
        if (resp && resp.ok) { const copy = resp.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return resp;
      }).catch(() => (req.mode === "navigate" ? caches.match("index.html") : Response.error()));
    })
  );
});
