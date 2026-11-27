const CACHE_NAME = "cadenza-cache-v22.1.4";
const APP_SHELL = [
  "./",
  "./index.html",
  "./app/",
  "./app/index.html",
  "./de/",
  "./en/",
  "./site/site.css",
  "./site/site.js",
  "./site/route.js",
  "./site/logo.svg",
  "./favicon.png",
  "./site/founder.webp",
  "./styles.css",
  "./manifest.json",
  "./manifest.de.json",
  "./manifest.en.json",
  "./manifest.dev.fr.json",
  "./manifest.dev.de.json",
  "./manifest.dev.en.json",
  "./icons/dev.svg",
  "./icons/dev-180.png",
  "./icons/dev-192.png",
  "./icons/dev-512.png",
  "./js/config.js",
  "./js/i18n.js",
  "./js/translations.js",
  "./js/ui.js",
  "./js/admin.js",
  "./js/polls.js",
  "./js/agenda.js",
  "./js/ensemble.js",
  "./js/app.js"
];

// Installation et mise en cache de l'interface
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Nettoyage des anciens caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith("cadenza-cache-") && k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Stratégie Network-First avec repli hors-ligne
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Keep the existing root registration and push subscription. Do not cache
  // personalized navigation URLs (invitations / profile transfers).
  if (event.request.mode === "navigate") {
    const root = new URL(self.registration.scope);
    const rel = url.pathname.slice(root.pathname.length);
    const app = /^(app)(\/|$)/.test(rel) || url.searchParams.has("ensemble") || url.searchParams.has("member");
    const fallback = app ? "./app/" : /^de(\/|$)/.test(rel) ? "./de/" : /^en(\/|$)/.test(rel) ? "./en/" : "./";
    if (app && !/^app(\/|$)/.test(rel)) {
      const target = new URL("app/", root); target.search = url.search; target.hash = url.hash;
      event.respondWith(Promise.resolve(Response.redirect(target.href, 302))); return;
    }
    event.respondWith(fetch(event.request).catch(async () => (await caches.match(fallback)) || Response.error()));
    return;
  }
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy))); }
    return response;
  }).catch(async () => (await caches.match(event.request)) || Response.error()));
});

// Preference de langue locale, même lorsque la PWA est fermée.
const LANGUAGE_CACHE = "cadenza-preferences-v1";
const LANGUAGE_URL = new URL("./__cadenza_language", self.location.href).href;
self.addEventListener("message", event => {
  const lang = event.data?.language;
  if (event.data?.type === "CADENZA_LANGUAGE" && ["fr", "de", "en"].includes(lang)) {
    event.waitUntil(caches.open(LANGUAGE_CACHE).then(cache => cache.put(LANGUAGE_URL, new Response(lang))));
  }
});
async function getLanguage() {
  try { const response = await (await caches.open(LANGUAGE_CACHE)).match(LANGUAGE_URL); return response ? await response.text() : "fr"; }
  catch (_) { return "fr"; }
}
// Réception des notifications Push serveur (FCM / Web Push) même app fermée
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const lang = await getLanguage();
    let title = "Cadenza";
    let body = ({ fr: "Nouvelle activité dans votre ensemble.", de: "Neue Aktivität in Ihrem Ensemble.", en: "New activity in your ensemble." })[lang] || "Nouvelle activité dans votre ensemble.";
    let url = "./";
    if (event.data) {
      try {
        const payload = event.data.json();
        let variants = payload.localized || payload.data?.localized;
        if (typeof variants === "string") { try { variants = JSON.parse(variants); } catch (_) { variants = null; } }
        const localized = variants?.[lang];
        title = localized?.title || payload.notification?.title || payload.data?.title || title;
        body = localized?.body || payload.notification?.body || payload.data?.body || body;
        url = payload.data?.url || "./";
      } catch (_) { body = event.data.text(); }
    }
    await self.registration.showNotification(title, { body, tag: "cadenza-push", renotify: true, data: { url } });
  })());
});

// Notification links from older releases may still target the root.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const root = new URL(self.registration.scope);
  const app = new URL("app/", root);
  let target = new URL(app);
  try {
    const requested = new URL(event.notification.data?.url || "./", root);
    if (requested.origin === root.origin) { target.search = requested.search; target.hash = requested.hash; }
  } catch (_) {}
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    // Prefer a matching ensemble or app window; never focus the public landing.
    const exact = windows.find(c => c.url === target.href);
    if (exact) return exact.focus();
    const existing = windows.find(c => new URL(c.url).pathname.startsWith(app.pathname));
    if (existing && !target.search) return existing.focus();
    if (existing && "navigate" in existing) { try { const moved = await existing.navigate(target.href); if (moved) return moved.focus(); } catch (_) {} }
    if (clients.openWindow) return clients.openWindow(target.href);
  })());
});
