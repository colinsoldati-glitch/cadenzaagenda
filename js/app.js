import { APP_VERSION, KEYS, state, $, haptic, showToast } from "./config.js";
import { applyDomTranslations, setLang, onLanguageChange } from "./i18n.js";
import {
  registerUiHooks, initFormSelectors, initCalendarControls, initModalGlobalListeners,
  renderMultiCalendar
} from "./ui.js";
import {
  registerAdminHooks, initAdminListeners,
  openAdminPinPrompt, dismissWhatsNewModal, maybeDisplayLatestAnnouncement
} from "./admin.js";
import {
  registerPollsHooks, initPollsListeners,
  archiveFailedPollsIfNeeded, updatePollConflictsWarning, checkEditPollArchiveLock,
  resetPollSlots, renderPolls
} from "./polls.js";
import {
  registerAgendaHooks, initAgendaListeners, renderAgenda
} from "./agenda.js";
import {
  registerEnsembleHooks, initEnsembleListeners, initServiceWorkerAndPush,
  publishEnsembleNotification, showTutorialScreen, proceedAfterTutorial,
  switchTab, renderAll, updatePushUI
} from "./ensemble.js";

// Enregistrement des hooks inter-modules pour éviter toute dépendance circulaire
registerUiHooks({
  updatePollConflictsWarning,
  checkEditPollArchiveLock,
  resetPollSlots,
  dismissWhatsNewModal
});

registerAdminHooks({
  publishEnsembleNotification
});

registerPollsHooks({
  publishEnsembleNotification,
  switchTab
});

registerAgendaHooks({
  publishEnsembleNotification,
  switchTab
});

registerEnsembleHooks({
  archiveFailedPollsIfNeeded,
  renderPolls,
  renderAgenda,
  openAdminPinPrompt,
  maybeDisplayLatestAnnouncement
});

// Mise à jour dynamique lors d'un changement de langue
onLanguageChange(() => {
  initFormSelectors();
  renderMultiCalendar();
  if (state.currentEnsembleData) {
    renderAll();
    updatePushUI();
  }
});

// Écouteurs de changement de langue (FR / DE / EN)
document.addEventListener("click", (e) => {
  const langBtn = e.target.closest("[data-set-lang]");
  if (!langBtn) return;
  haptic();
  const toastMsg = setLang(langBtn.dataset.setLang, { notify: true });
  if (toastMsg) showToast(toastMsg);
});

// Installation PWA
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); state.deferredInstallPrompt = e;
  $("install-banner").classList.remove("hidden"); $("tuto-direct-install-card")?.classList.remove("hidden");
});
const triggerInstallPrompt = async () => {
  if (!state.deferredInstallPrompt) return;
  state.deferredInstallPrompt.prompt();
  await state.deferredInstallPrompt.userChoice;
  state.deferredInstallPrompt = null; $("install-banner").classList.add("hidden"); $("tuto-direct-install-card")?.classList.add("hidden");
};
$("btn-install-pwa").addEventListener("click", triggerInstallPrompt);
$("btn-tuto-direct-install").addEventListener("click", triggerInstallPrompt);
window.addEventListener("appinstalled", () => { $("install-banner").classList.add("hidden"); $("tuto-direct-install-card")?.classList.add("hidden"); });

// Initialisation globale
$("app-version-label").textContent = APP_VERSION;
applyDomTranslations();
initFormSelectors();
initCalendarControls();
initModalGlobalListeners();
initPollsListeners();
initAgendaListeners();
initEnsembleListeners();
initAdminListeners();
initServiceWorkerAndPush();

const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
if (!isStandalone && !localStorage.getItem(KEYS.tuto)) {
  showTutorialScreen();
} else {
  proceedAfterTutorial();
}
