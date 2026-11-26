import { translations, htmlPatterns } from './translations.js';

export const LANGUAGE_KEY = 'cadenza_language_v1';
export const SUPPORTED_LANGUAGES = ['fr', 'de', 'en'];
const locales = { fr: 'fr-FR', de: 'de-CH', en: 'en-GB' };
function detectLanguage() {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    if (SUPPORTED_LANGUAGES.includes(saved)) return saved;
  } catch (_) {}
  for (const candidate of navigator.languages || [navigator.language]) {
    const code = String(candidate || '').toLowerCase().split('-')[0];
    if (SUPPORTED_LANGUAGES.includes(code)) return code;
  }
  return 'fr';
}
export let language = detectLanguage();
export let locale = locales[language];
const getVariant = (dict, key) => language === 'fr' || !Object.hasOwn(dict, key) ? key : dict[key][language === 'de' ? 0 : 1];
export function t(key, ...values) {
  const value = getVariant(translations, key);
  return values.length ? value.replace(/\{(\d+)\}/g, (match, i) => Number(i) < values.length ? String(values[Number(i)]) : match) : value;
}
function pattern(strings, marker) {
  return strings.reduce((out, part, i) => out + (i ? marker(i - 1) : '') + part, '');
}
export function tt(strings, ...values) {
  if (language === 'fr') return strings.reduce((out, part, i) => out + (i ? String(values[i - 1]) : '') + part, '');
  return t(pattern(strings, i => `{${i}}`), ...values);
}
// Only fixed source markup is translated, never dynamic values supplied by users.
export function h(strings, ...values) {
  const source = pattern(strings, i => `§${i}§`);
  const translated = getVariant(htmlPatterns, source);
  return translated.replace(/§(\d+)§/g, (match, i) => Number(i) < values.length ? String(values[Number(i)]) : match);
}
export function htmlLiteral(source) { return getVariant(htmlPatterns, source); }
const formations = new Set(['Duo','Trio','Quatuor','Quintette','Sextuor / Octuor','Ensemble de chambre','Ensemble']);
const periods = new Set(['Matin','Après-midi','Soir']);
export const localizeFormation = value => formations.has(value) ? t(value) : value;
export const localizePeriod = value => periods.has(value) ? t(value) : value;
export const localizeLocation = value => value === 'Lieu à confirmer' ? t(value) : value;

// Synchronously generate recipient-specific variants without changing the user's preference.
export function localizedMessages(build) {
  const previousLanguage = language, previousLocale = locale;
  const result = {};
  try {
    for (const code of SUPPORTED_LANGUAGES) {
      language = code; locale = locales[code];
      const [title, body] = build(); result[code] = { title, body };
    }
  } finally { language = previousLanguage; locale = previousLocale; }
  return result;
}
export function notificationFor(payload) {
  let variants = payload?.localized || payload?.data?.localized;
  if (typeof variants === 'string') { try { variants = JSON.parse(variants); } catch (_) { variants = null; } }
  return variants?.[language] || { title: payload?.notification?.title || payload?.data?.title || payload?.title || 'Cadenza', body: payload?.notification?.body || payload?.data?.body || payload?.body || t('Nouvelle activité dans votre ensemble.') };
}

function translateWhitespace(value) {
  if (!value || !value.trim()) return value;
  const key = value.trim();
  return value.slice(0, value.indexOf(key)) + t(key) + value.slice(value.indexOf(key) + key.length);
}
export function initLanguage() {
  document.documentElement.lang = language;
  const manifest = document.querySelector('link[rel="manifest"]');
  if (manifest) manifest.setAttribute('href', language === 'fr' ? './manifest.json' : `./manifest.${language}.json`);
  // This runs once, before the app renders or receives any Firebase data.
  document.querySelectorAll('option').forEach(el => {
    if (!el.hasAttribute('value')) el.setAttribute('value', el.value);
  });
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) { return node.parentElement?.closest('script, style, code, pre, svg, [data-no-translate]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
  });
  while (walker.nextNode()) {
    const node = walker.currentNode;
    node.nodeValue = translateWhitespace(node.nodeValue);
  }
  for (const el of document.querySelectorAll('[placeholder], [title], [aria-label], [data-label]')) {
    for (const attr of ['placeholder','title','aria-label','data-label']) {
      if (el.hasAttribute(attr)) el.setAttribute(attr, translateWhitespace(el.getAttribute(attr)));
    }
  }
  for (const id of ['admin-ann-title','admin-feedback-placeholder','admin-message-cta']) {
    const el = document.getElementById(id);
    if (el) el.defaultValue = t(el.defaultValue);
  }
  const description = document.querySelector('meta[name="description"]');
  if (description) description.content = t(description.content);
  for (const select of document.querySelectorAll('[data-language-select]')) {
    select.value = language;
    select.addEventListener('change', () => {
      if (!SUPPORTED_LANGUAGES.includes(select.value) || select.value === language) return;
      try { localStorage.setItem(LANGUAGE_KEY, select.value); }
      catch (_) { select.value = language; return; }
      // Reinitialise all modules and dynamic components in the selected language.
      // The existing Cadenza session and ensemble data remain untouched.
      location.reload();
    });
  }
  syncServiceWorkerLanguage();
}
export function syncServiceWorkerLanguage() {
  if (!('serviceWorker' in navigator)) return;
  const send = () => navigator.serviceWorker.ready.then(reg => reg.active?.postMessage({ type: 'CADENZA_LANGUAGE', language })).catch(() => {});
  send();
  navigator.serviceWorker.addEventListener('controllerchange', send);
}
