const CACHE_PREFIX = "senderi-app";
const CACHE_VERSION = "v1";
const APP_CACHE = `${CACHE_PREFIX}-${CACHE_VERSION}`;
const APP_SHELL = ["/", "/index.html", "/manifest.webmanifest", "/senderi-mark.svg", "/senderi-maskable.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== APP_CACHE)
        .map((key) => caches.delete(key)),
    )),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/socket.io/")
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(APP_CACHE).then((cache) => cache.put("/index.html", copy));
          }
          return response;
        })
        .catch(async () => (
          await caches.match("/index.html") ?? await caches.match("/") ?? Response.error()
        )),
    );
    return;
  }

  if (["style", "script", "image", "font"].includes(request.destination)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const update = fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(APP_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        });
        return cached ?? update;
      }),
    );
  }
});
