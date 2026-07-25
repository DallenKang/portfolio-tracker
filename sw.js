// Service Worker — 永远先拿网络最新版（不会有旧版卡住的问题），断网时才用上次的缓存
const CACHE = "inner-circle-ptracker-v1"; // 改名字会让旧快取失效，等于强制大家拿新版
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
