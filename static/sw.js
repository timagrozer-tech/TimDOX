// Сервис-воркер «Круга»: приложение открывается мгновенно и работает без сети (показывает сохранённое).
const VERSION = "krug-v44";
const SHELL = ["/", "/static/css/app.css?v=7", "/static/css/orbit.css?v=36", "/static/js/app.js?v=36", "/static/js/theme-init.js",
  "/static/img/icon-192.png", "/static/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/uploads/")) return; // данные и файлы — всегда из сети
  // страницы: сначала сеть, без сети — сохранённая оболочка приложения
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put("/", copy));
      return res;
    }).catch(() => caches.match("/")));
    return;
  }
  // скрипты, стили, картинки: сначала сеть (чтобы после обновления не смешались старые и новые файлы),
  // без сети — из кэша
  if (url.pathname.startsWith("/static/")) {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req)));
  }
});
