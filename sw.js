// Service Worker
// 【重要】アプリのファイルを変更したら必ず CACHE_VERSION を上げること。
// 上げ忘れると、iPhone 側に古い画面がキャッシュされたまま更新されない。
const CACHE_VERSION = "v2.0.0";
const CACHE_NAME = `health-tracker-${CACHE_VERSION}`;

const PRECACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./vendor/chart.umd.min.js",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 更新バーの「更新」ボタンから呼ばれる
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // api.github.com など別オリジンへの通信には一切介入しない
  if (url.origin !== self.location.origin) return;

  // ?mode=view など、クエリ付きで開いてもキャッシュ済みの index.html を返す
  const matchOptions = { ignoreSearch: request.mode === "navigate" };

  event.respondWith(
    caches.match(request, matchOptions).then((cached) => {
      if (cached) {
        // キャッシュを返しつつ裏で更新しておく（次回起動時に新しくなる）
        fetch(request)
          .then((res) => {
            if (res && res.ok) caches.open(CACHE_NAME).then((c) => c.put(request, res.clone()));
          })
          .catch(() => {});
        return cached;
      }
      return fetch(request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match("./index.html"));
    })
  );
});
