// App-shell cache; API calls always go to the network.
const CACHE = "sampler-v10";
const SHELL = ["./", "app.js?v=10", "style.css?v=10", "icons/icon-192.png?v=9", "icons/icon-512.png?v=9"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.pathname.includes("/api/") || u.origin !== location.origin
      || u.pathname.endsWith("config.json")) {
    return; // network only
  }
  e.respondWith(caches.match(e.request).then((c) => c || fetch(e.request)));
});
