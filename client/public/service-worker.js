const CACHE_PREFIX = "senderi-app";
const CACHE_VERSION = "v7";
const APP_CACHE = `${CACHE_PREFIX}-${CACHE_VERSION}`;
const APP_SHELL = ["/", "/index.html", "/manifest.webmanifest", "/senderi-logo.png", "/senderi-symbol.png", "/senderi-maskable.png", "/senderi-mark.svg", "/senderi-maskable.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
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

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const openWindows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (openWindows.some((client) => client.visibilityState === "visible" && client.focused)) return;

    let payload = {};
    try {
      payload = event.data?.json() ?? {};
    } catch {
      payload = { body: event.data?.text() ?? "You have a new notification." };
    }

    const title = typeof payload.title === "string" ? payload.title : "Senderi";
    const body = typeof payload.body === "string" ? payload.body : "You have a new notification.";
    const url = typeof payload.url === "string" ? payload.url : "/";
    const safeUrl = new URL(url, self.location.origin);
    await self.registration.showNotification(title, {
      body,
      icon: "/senderi-symbol.png",
      badge: "/senderi-symbol.png",
      tag: typeof payload.tag === "string" ? payload.tag : "senderi-notification",
      data: { url: safeUrl.origin === self.location.origin ? `${safeUrl.pathname}${safeUrl.search}${safeUrl.hash}` : "/" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const requestedUrl = typeof event.notification.data?.url === "string" ? event.notification.data.url : "/";
    const target = new URL(requestedUrl, self.location.origin);
    const safeTarget = target.origin === self.location.origin ? target.href : `${self.location.origin}/`;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin)) {
        await client.navigate(safeTarget);
        return client.focus();
      }
    }
    return self.clients.openWindow(safeTarget);
  })());
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
