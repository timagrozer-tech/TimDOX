// Ярко Плеер: оболочка приложения кэшируется, чтобы плеер открывался без интернета
const CACHE = "yarko-player-v1";
const SHELL = ["index.html", "player.css?v=1", "player.js?v=1", "manifest.webmanifest", "icon-192.png", "icon-512.png", "/static/sounds/notify.mp3"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("yarko-player-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  if (!u.pathname.startsWith("/static/player/") && u.pathname !== "/static/sounds/notify.mp3") return;
  // сначала сеть (чтобы приходили обновления), без сети — из кэша
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: u.pathname.endsWith("/") }).then((r) => r || caches.match("index.html"))));
});
