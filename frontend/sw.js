/**
 * PhantomChat — Service Worker
 * Cache-first strategy for the app shell.
 */

const CACHE_NAME = "phantom-v3";
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/css/style.css",
  "/js/crypto.js",
  "/js/ui.js",
  "/js/app.js",
  "/manifest.json",
];

// Pre-cache the app shell on install
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// Clean old caches on activate
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      )
    )
  );
  self.clients.claim();
});

// Cache-first for shell, network-first for API/WS
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip API and WebSocket requests
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/ws")) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache successful GET responses
        if (response.ok && event.request.method === "GET") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    }).catch(() => caches.match("/index.html"))
  );
});
