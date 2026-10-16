// GENESIS: офлайн-режим. Файлы игры кэшируются при установке; при обновлении сайта кэш меняется целиком.
const CACHE = "genesis-777f89da";
const FILES = ["./","./assets/app.css?v=129e79807a","./assets/app.js?v=12f759ebe9","./assets/worker.js?v=5e7e3014f7","./icon-192.png","./icon-512.png","./icon-maskable-512.png","./index.html","./manifest.webmanifest"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("genesis-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
    if (r.ok && new URL(e.request.url).pathname.startsWith(new URL("./", self.registration.scope).pathname)) { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); }
    return r;
  }).catch(() => caches.match("./index.html"))));
});
