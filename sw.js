// Service worker: кэширует оболочку приложения, чтобы оно открывалось без интернета.
// При изменении любого файла приложения увеличьте номер версии.
const VERSION = "kbsearch-v1.3.4";
const SHELL = [
  "./", "index.html", "app.js", "search.js", "synonyms.js", "embed.js", "sem.js", "textnorm.js", "manifest.webmanifest",
  "icon-180.png", "icon-192.png", "icon-512.png",
  "vendor/sqlite3.mjs", "vendor/sqlite3.wasm",
  "vendor/ort/ort.wasm.min.mjs", "vendor/ort/ort-wasm-simd-threaded.mjs", "vendor/ort/ort-wasm-simd-threaded.wasm",
  "model/vocab.json", "model/minilm-int8.onnx",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
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
