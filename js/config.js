import { locale, language, localizeFormation, localizePeriod } from "./i18n.js";
import * as C18 from "./i18n.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-analytics.js";
import { getDatabase, ref, set, update, remove, onValue, get, runTransaction } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-database.js";
import { getMessaging, getToken, onMessage, isSupported } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-messaging.js";

export const APP_VERSION = "v22.1.0";
export const FIREBASE_VAPID_KEY = "BKIqxDVW3gHqeRavAYDAd3E7W-3r6117dL6wKeCL_9FnxqFUHSG6Dsask_aTKQOvOAYR-GfAqUBfudVE8MKThPQ";
export const CALENDAR_SERVICE_URL = "https://cal.cadenzaapp.ch";
export const PUSH_WORKER_URL = "https://cadenza-notifications.colinsoldati.workers.dev/";

export const KEYS = {
  session: "cadenza_session_v1",
  invite: "cadenza_pending_invite_v2",
  tuto: "cadenza_install_tuto_seen_v1",
  ann: "cadenza_seen_announcement_id_v1",
  evtTs: "cadenza_last_event_ts",
  voter: "cadenza_voter_device_id_v1"
};

export const EVENT_TYPES = {
  rehearsal: { get label() { return C18.t("Répétition"); }, badgeCls: "", cardCls: "", get nextLabel() { return C18.t("Prochaine répétition"); } },
  cours: { get label() { return C18.t("Cours"); }, badgeCls: "cours", cardCls: "cours-card", get nextLabel() { return C18.t("Prochain cours"); } },
  concert: { get label() { return C18.t("Concert"); }, badgeCls: "concert", cardCls: "concert-card", get nextLabel() { return C18.t("Prochain concert"); } }
};
export const getEventMeta = (t) => EVENT_TYPES[t] || EVENT_TYPES.rehearsal;

const app = initializeApp({
  apiKey: "AIzaSyCFt-CleI7BurUN70TbjA8R97NFBRyXM1A",
  authDomain: "cadenza-dad79.firebaseapp.com",
  databaseURL: "https://cadenza-dad79-default-rtdb.firebaseio.com",
  projectId: "cadenza-dad79",
  storageBucket: "cadenza-dad79.firebasestorage.app",
  messagingSenderId: "298490556921",
  appId: "1:298490556921:web:0f83dc2d107ee4eae8cd28",
  measurementId: "G-PT9W1RCJJR"
});
try { getAnalytics(app); } catch (_) {}

export const db = getDatabase(app);
export { ref, set, update, remove, onValue, get, runTransaction, getMessaging, getToken, onMessage, isSupported };

// État partagé de l'application
export const state = {
  session: JSON.parse(localStorage.getItem(KEYS.session) || "null") || { activeEnsembleId: null, ensembles: {} },
  currentEnsembleData: null,
  unsubscribeEnsemble: null,
  swRegistration: null,
  messagingInstance: null,
  lastNotifiedTimestamp: Number(localStorage.getItem(KEYS.evtTs) || Date.now()),
  deferredInstallPrompt: null,
  availViewMode: localStorage.getItem("cadenza_avail_view_v1") === "table" ? "table" : "cards",
  availFilterMode: "all",
  pendingScrollToPollId: null,
  pendingDeleteCallback: null,
  isAutoArchivingPolls: false,
  refiningPollId: null,
  refiningFixedDate: null,
  calYear: new Date().getFullYear(),
  calMonth: new Date().getMonth(),
  selectedCalDates: new Set(),
  ensembleTapCount: 0,
  ensembleTapTimer: null,
  verifiedAdminPin: null,
  latestAnnouncementData: null,
  displayedAnnouncementId: null,
  isPreviewingWhatsNew: false,
  adminActiveTab: "publish",
  adminPopupType: "poll",
  adminPollOptions: [C18.t("Oui, tout à fait"), C18.t("Plutôt oui"), C18.t("Non, pas besoin")],
  selectedUserPollOptionIndex: null,
  currentRenderedPopupData: null,
  allFeedbackCampaigns: {},
  selectedResultsCampaignId: null,
  feedbackPermissionDenied: false,
  allAdminEnsembles: [],
  adminEnsemblesLoaded: false,
  ensemblesPermissionDenied: false,
  unsubscribeAdminEnsembles: null,
  showAllRecentEnsembles: false,
  openNoteEditors: new Set(),
  openLocationEditors: new Set(),
  expandedMemberLists: new Set(),
  activeSlotByDate: new Map(),
  lastRenderedFilteredPolls: [],
  lastRenderedUnvotedPolls: []
};

// Utilitaires DOM & Système
export const $ = (id) => document.getElementById(id);
export const saveSession = () => localStorage.setItem(KEYS.session, JSON.stringify(state.session));
export const haptic = () => navigator.vibrate && navigator.vibrate(10);
export const genId = (p) => `${p}-${Array.from({ length: 6 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("")}`;
export const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));

export function getVoterDeviceId() {
  let id = localStorage.getItem(KEYS.voter);
  if (!id) { id = genId("usr"); localStorage.setItem(KEYS.voter, id); }
  return id;
}

export function getCurrentRespondentLabel() {
  const ses = state.session.activeEnsembleId ? state.session.ensembles[state.session.activeEnsembleId] : null;
  if (!ses?.name) return C18.t("Utilisateur Cadenza");
  const details = [ses.instrument, ses.ensembleName].filter(Boolean).join(" — ");
  return details ? `${ses.name} (${details})` : ses.name;
}

export function showToast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 3400);
}

export function handleFirebaseError(err) {
  console.error("Firebase error:", err);
  const msg = String(err?.message || err || "");
  $("firebase-error-text").textContent = (msg.toLowerCase().includes("permission") || err?.code === "PERMISSION_DENIED")
    ? C18.t("Accès refusé par Firebase : autorisez .read et .write sur \"ensembles\".")
    : C18.tt`Erreur de synchronisation Firebase : ${msg}`;
  $("firebase-error-banner").classList.remove("hidden");
  showToast(C18.t("Erreur de connexion à la base de données."));
}

// Formatage des dates & créneaux
export const parseIso = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
export const formatDateFr = (iso) => iso ? parseIso(iso).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "";
export const formatCompactDateFr = (iso) => iso ? parseIso(iso).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" }) : "";
export const formatShortDateFr = (iso) => iso ? parseIso(iso).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" }) : "";
export const formatPollTimeLabel = (p) => p.timeMode === "day" ? C18.t("Journée entière") : p.timeMode === "period" && p.period ? localizePeriod(p.period) : p.startTime && p.endTime ? `${p.startTime} – ${p.endTime}` : (p.startTime || localizePeriod(p.period) || "");
export const formatVoteLabelFr = (v) => ({ yes: C18.t("Oui (Disponible)"), maybe: C18.t("Peut-être (Incertain)"), no: C18.t("Non (Indisponible)") }[v] || "");

export function getPollSortKey(p) {
  if (p.timeMode === "day") return `${p.date}T00:00`;
  if (p.timeMode === "period") return `${p.date}T${{ "Matin": "09:00", "Après-midi": "14:00", "Soir": "19:00" }[p.period] || "12:00"}`;
  return `${p.date}T${p.startTime || "00:01"}`;
}

export function getSlotFingerprint(s) {
  const d = String(s.date || "").trim(), m = s.timeMode || "day";
  if (m === "day") return `${d}|day`;
  if (m === "period") return `${d}|period|${String(s.period || "").trim()}`;
  return `${d}|exact|${String(s.startTime || "").trim()}-${String(s.endTime || "").trim()}`;
}

export function findArchivedSlotMatch(slot) {
  const fp = getSlotFingerprint(slot);
  return Object.values(state.currentEnsembleData?.archivedPolls || {}).find((a) => a.slotFingerprint === fp || getSlotFingerprint(a) === fp) || null;
}

export function extractEnsembleCode(raw) {
  let c = String(raw || "").trim();
  if (c.includes("ensemble=")) {
    try { c = new URL(c).searchParams.get("ensemble") || c; } catch (_) { c = c.split("ensemble=")[1].split("&")[0]; }
  }
  return c;
}

export const getAppUrl = (params) => `${new URL("../app/", import.meta.url).href}?${new URLSearchParams(params)}`;
export const getInviteUrl = (ensId) => getAppUrl({ ensemble: ensId });
export const getTransferUrl = (ensId, mbrId) => getAppUrl({ ensemble: ensId, member: mbrId });

export async function copyTextReliable(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
  }
  try {
    const t = Object.assign(document.createElement("textarea"), { value: text, style: "position:fixed;opacity:0" });
    document.body.appendChild(t); t.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(t);
    return ok;
  } catch (_) { return false; }
}

export async function shareOrCopy(url, title, text, copiedMsg) {
  haptic();
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return; } catch (e) { if (e?.name === "AbortError") return; }
  }
  showToast((await copyTextReliable(url)) ? copiedMsg : C18.t("Copiez le lien affiché ci-dessus."));
}

export function getUnavailabilityConflictsForDate(iso) {
  if (!iso || !state.currentEnsembleData?.members) return [];
  const out = [];
  Object.values(state.currentEnsembleData.members).forEach((m) => {
    Object.values(m.unavailabilities || {}).forEach((u) => {
      if (u.startDate && u.endDate && iso >= u.startDate && iso <= u.endDate) {
        out.push({ memberId: m.id, memberName: m.name, instrument: m.instrument, startDate: u.startDate, endDate: u.endDate, reason: u.reason || "" });
      }
    });
  });
  return out;
}
