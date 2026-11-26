const CACHE_NAME = "cadenza-cache-v21.3";
const APP_SHELL = [
  "./",
  "./index.html",
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

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
  );
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

// Ouverture directe de l'application au clic sur la notification
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "./";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
