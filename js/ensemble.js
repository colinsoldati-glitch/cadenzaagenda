import {
  FIREBASE_VAPID_KEY, PUSH_WORKER_URL, KEYS,
  db, ref, set, update, remove, onValue, get,
  getMessaging, getToken, onMessage, isSupported,
  state, $, saveSession, haptic, genId, esc,
  showToast, handleFirebaseError, formatShortDateFr,
  extractEnsembleCode, getInviteUrl, copyTextReliable, shareOrCopy
} from "./config.js";
import { t, translateFormation } from "./i18n.js";
import { openConfirmationModal, openModal, closeModal } from "./ui.js";

let hooks = {
  archiveFailedPollsIfNeeded: async () => {},
  renderPolls: () => {},
  renderAgenda: () => {},
  openAdminPinPrompt: () => {},
  maybeDisplayLatestAnnouncement: () => {}
};

export function registerEnsembleHooks(h) {
  hooks = { ...hooks, ...h };
}

// Service Worker & Notifications Push
export async function initServiceWorkerAndPush() {
  if (!("serviceWorker" in navigator)) return;
  try {
    state.swRegistration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    if (await isSupported().catch(() => false)) {
      state.messagingInstance = getMessaging();
      onMessage(state.messagingInstance, (p) => {
        if (isEnsemblePushActive()) triggerLocalSystemNotification(p.notification?.title || p.data?.title || "Cadenza", p.notification?.body || p.data?.body || t("push.defaultUpdate"));
      });
    }
  } catch (e) { console.warn("SW init:", e); }
  updatePushUI();
}

export function isEnsemblePushActive() {
  if (!("Notification" in window) || Notification.permission !== "granted" || !state.session.activeEnsembleId) return false;
  const myId = state.session.ensembles[state.session.activeEnsembleId]?.memberId;
  return Boolean(myId && state.currentEnsembleData?.members?.[myId]?.pushEnabled === true);
}

export async function triggerLocalSystemNotification(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const opts = { body, tag: "cadenza-update", renotify: true, data: { url: window.location.href } };
  if (state.swRegistration?.showNotification) await state.swRegistration.showNotification(title, opts);
  else new Notification(title, opts);
}

export async function fetchFcmTokenSafe() {
  if (!state.messagingInstance || !state.swRegistration) return null;
  try { await navigator.serviceWorker.ready; return await getToken(state.messagingInstance, { vapidKey: FIREBASE_VAPID_KEY, serviceWorkerRegistration: state.swRegistration }); }
  catch (e) { console.warn("FCM token:", e); return null; }
}

export async function saveMemberPushPreferences(ensId, memberId, active, token) {
  if (!ensId || !memberId) return;
  try {
    await update(ref(db, `ensembles/${ensId}/members/${memberId}`), {
      pushEnabled: Boolean(active), fcmToken: active && token ? token : null, pushUpdatedAt: Date.now()
    });
  } catch (e) { console.warn("Save push prefs:", e); }
}

export async function togglePushForEnsemble() {
  haptic();
  const ensId = state.session.activeEnsembleId, myId = ensId ? state.session.ensembles[ensId]?.memberId : null;
  if (!ensId || !myId) return;
  const ensName = state.currentEnsembleData?.name || "Cadenza";

  if (isEnsemblePushActive()) {
    await saveMemberPushPreferences(ensId, myId, false, null);
    updatePushUI();
    return showToast(t("push.disabledToast", { ensemble: ensName }));
  }
  if (!("Notification" in window)) return showToast(t("push.unsupportedToast"));
  if (/iPad|iPhone|iPod/.test(navigator.userAgent) && !window.matchMedia("(display-mode: standalone)").matches) {
    return showToast(t("push.iosInstallFirstToast"));
  }
  const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (perm !== "granted") { updatePushUI(); return showToast(t("push.deniedToast")); }

  const token = await fetchFcmTokenSafe();
  await saveMemberPushPreferences(ensId, myId, true, token);
  updatePushUI();
  showToast(t("push.enabledToast", { ensemble: ensName }));
  await triggerLocalSystemNotification(`Cadenza • ${ensName}`, t("push.enabledNotifBody"));
}

export async function syncExistingPushPermissionSilently() {
  const ensId = state.session.activeEnsembleId, myId = ensId ? state.session.ensembles[ensId]?.memberId : null;
  const member = myId ? state.currentEnsembleData?.members?.[myId] : null;
  if (!ensId || !myId || !member || !("Notification" in window) || Notification.permission !== "granted") return updatePushUI();
  if (member.pushEnabled === true && !member.fcmToken) {
    const token = await fetchFcmTokenSafe();
    if (token) await saveMemberPushPreferences(ensId, myId, true, token);
  }
  updatePushUI();
}

export function updatePushUI() {
  const msg = $("push-status-msg"), toggle = $("btn-toggle-push"), test = $("btn-test-push");
  if (!msg || !toggle) return;
  const ensName = state.currentEnsembleData?.name || "Cadenza";
  const supported = "Notification" in window;
  const active = isEnsemblePushActive();

  msg.textContent = !supported
    ? t("push.statusUnsupported")
    : active
      ? t("push.statusActive", { ensemble: ensName })
      : Notification.permission === "denied"
        ? t("push.statusDenied")
        : t("push.statusInactive", { ensemble: ensName });

  toggle.textContent = active ? t("ensemble.pushDisableBtn") : t("ensemble.pushEnableBtn");
  toggle.className = active ? "btn-secondary btn-sm" : "btn-primary btn-sm";
  test.classList.toggle("hidden", !active);

  const remToggle = $("toggle-auto-remind-eve");
  if (remToggle && state.currentEnsembleData) {
    remToggle.checked = state.currentEnsembleData.autoRemindEve !== false;
  }
}

export async function publishEnsembleNotification(title, body, options = {}) {
  const ensId = state.session.activeEnsembleId;
  if (!ensId) return;
  const senderId = state.session.ensembles[ensId]?.memberId || "";
  const targetMemberIds = Array.isArray(options.targetMemberIds) ? options.targetMemberIds.filter(Boolean) : [];
  const evt = { title, body, senderId, timestamp: Date.now(), ...(targetMemberIds.length ? { targetMemberIds } : {}) };
  try { await set(ref(db, `ensembles/${ensId}/lastEvent`), evt); } catch (e) { console.warn("lastEvent:", e); }
  if (!PUSH_WORKER_URL || !state.currentEnsembleData?.members) return;

  const recipients = Object.values(state.currentEnsembleData.members).filter((m) =>
    m.id !== senderId && m.pushEnabled === true && m.fcmToken && (!targetMemberIds.length || targetMemberIds.includes(m.id))
  );
  const tokens = [...new Set(recipients.map((m) => m.fcmToken))];
  if (!tokens.length) return;
  try {
    await fetch(PUSH_WORKER_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, tokens, ensembleId: ensId, url: getInviteUrl(ensId) })
    });
  } catch (e) { console.warn("Worker push:", e); }
}

// Tutoriel, Onboarding & Multi-Ensembles
export function showTutorialScreen() {
  ["app-header", "app-nav", "view-onboarding", "view-agenda", "view-avail", "view-ensemble"].forEach((id) => $(id).classList.add("hidden"));
  $("view-install-tuto").classList.remove("hidden");
  $("tuto-direct-install-card").classList.toggle("hidden", !state.deferredInstallPrompt);
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
  $("tuto-ios-card").style.order = isIos ? "1" : "2";
  $("tuto-android-card").style.order = isIos ? "2" : "1";
}

export function completeTutorial() {
  localStorage.setItem(KEYS.tuto, "true");
  $("view-install-tuto").classList.add("hidden");
  proceedAfterTutorial();
}

export function renderClaimableMembers(ensId, ensData) {
  const box = $("join-existing-members-box"), list = $("join-existing-members-list"), kicker = $("join-new-member-kicker");
  const members = Object.values(ensData?.members || {});
  if (!members.length) {
    box.classList.add("hidden"); kicker.classList.add("hidden"); list.innerHTML = "";
    return;
  }
  box.classList.remove("hidden"); kicker.classList.remove("hidden");
  list.innerHTML = members.map((m) => `
    <div class="claim-member-row">
      <div>
        <div class="member-name">${esc(m.name)}</div>
        <div class="member-role">${esc(m.instrument)}</div>
      </div>
      <button type="button" class="btn-secondary btn-xs" data-claim-member="${esc(m.id)}">${esc(t("onboarding.reclaimBtn"))}</button>
    </div>`).join("");

  list.onclick = (e) => {
    const btn = e.target.closest("[data-claim-member]");
    if (!btn) return;
    const m = ensData.members?.[btn.dataset.claimMember];
    if (!m) return;
    haptic();
    state.session.ensembles[ensId] = { memberId: m.id, name: m.name, instrument: m.instrument, ensembleName: ensData.name };
    state.session.activeEnsembleId = ensId;
    saveSession();
    localStorage.removeItem(KEYS.invite);
    enterEnsemble(ensId);
    showToast(t("onboarding.profileRestoredToast", { name: m.name }));
  };
}

export async function proceedAfterTutorial() {
  const params = new URLSearchParams(window.location.search);
  const urlEnsemble = params.get("ensemble"), urlMember = params.get("member");
  const invitedId = urlEnsemble || localStorage.getItem(KEYS.invite);

  if (urlEnsemble || urlMember) window.history.replaceState({}, document.title, window.location.pathname);

  if (invitedId) {
    localStorage.setItem(KEYS.invite, invitedId);
    try {
      const snap = await get(ref(db, `ensembles/${invitedId}`));
      if (snap.exists()) {
        const d = snap.val();
        if (urlMember && d.members?.[urlMember]) {
          const target = d.members[urlMember];
          state.session.ensembles[invitedId] = { memberId: target.id, name: target.name, instrument: target.instrument, ensembleName: d.name };
          state.session.activeEnsembleId = invitedId;
          saveSession(); localStorage.removeItem(KEYS.invite);
          return enterEnsemble(invitedId, () => showToast(t("onboarding.profileRestoredToast", { name: target.name })));
        }
        if (state.session.ensembles[invitedId]) {
          state.session.activeEnsembleId = invitedId; saveSession(); localStorage.removeItem(KEYS.invite);
          return enterEnsemble(invitedId);
        }
        showOnboardingScreen();
        $("join-code").value = invitedId;
        $("join-kicker").textContent = t("onboarding.inviteKicker", { formation: translateFormation(d.formation) || t("ensemble.defaultFormation") });
        $("join-ensemble-title").textContent = t("onboarding.inviteJoinTitle", { name: d.name });
        renderClaimableMembers(invitedId, d);
        $("create-card").classList.add("hidden"); $("onboarding-divider").classList.add("hidden");
        return;
      } else {
        localStorage.removeItem(KEYS.invite);
        showToast(t("onboarding.ensembleNotFoundToast"));
      }
    } catch (err) { handleFirebaseError(err); }
  }

  if (state.session.activeEnsembleId && state.session.ensembles[state.session.activeEnsembleId]) {
    enterEnsemble(state.session.activeEnsembleId);
  } else {
    showOnboardingScreen();
  }
}

export function showOnboardingScreen() {
  if (state.unsubscribeEnsemble) { state.unsubscribeEnsemble(); state.unsubscribeEnsemble = null; }
  state.currentEnsembleData = null;
  ["app-header", "app-nav", "view-install-tuto", "view-agenda", "view-avail", "view-ensemble"].forEach((id) => $(id).classList.add("hidden"));
  $("view-onboarding").classList.remove("hidden");
  $("create-card").classList.remove("hidden");
  $("onboarding-divider").classList.remove("hidden");
  $("join-kicker").textContent = t("onboarding.joinKicker");
  $("join-ensemble-title").textContent = t("onboarding.joinTitle");
  $("join-existing-members-box").classList.add("hidden");
  $("join-new-member-kicker").classList.add("hidden");
  $("join-existing-members-list").innerHTML = "";
}

export function enterEnsemble(ensId, onReady) {
  if (state.unsubscribeEnsemble) { state.unsubscribeEnsemble(); state.unsubscribeEnsemble = null; }
  ["view-install-tuto", "view-onboarding"].forEach((id) => $(id).classList.add("hidden"));
  ["app-header", "app-nav"].forEach((id) => $(id).classList.remove("hidden"));
  switchTab("agenda");

  state.unsubscribeEnsemble = onValue(ref(db, `ensembles/${ensId}`), (snap) => {
    $("firebase-error-banner").classList.add("hidden");
    if (!snap.exists()) {
      delete state.session.ensembles[ensId];
      state.session.activeEnsembleId = Object.keys(state.session.ensembles)[0] || null;
      saveSession();
      showToast(t("ensemble.deletedEnsembleToast"));
      return state.session.activeEnsembleId ? enterEnsemble(state.session.activeEnsembleId) : showOnboardingScreen();
    }
    state.currentEnsembleData = snap.val();
    const myInfo = state.session.ensembles[ensId];
    if (myInfo && state.currentEnsembleData.members?.[myInfo.memberId]) {
      const m = state.currentEnsembleData.members[myInfo.memberId];
      myInfo.name = m.name; myInfo.instrument = m.instrument; myInfo.ensembleName = state.currentEnsembleData.name;
      saveSession();
    }
    const evt = state.currentEnsembleData.lastEvent;
    if (evt && evt.timestamp > state.lastNotifiedTimestamp) {
      state.lastNotifiedTimestamp = evt.timestamp;
      localStorage.setItem(KEYS.evtTs, String(state.lastNotifiedTimestamp));
      const targets = Array.isArray(evt.targetMemberIds) ? evt.targetMemberIds : [];
      const isTargeted = !targets.length || (myInfo?.memberId && targets.includes(myInfo.memberId));
      if (myInfo && evt.senderId !== myInfo.memberId && isTargeted && isEnsemblePushActive()) {
        triggerLocalSystemNotification(evt.title, evt.body);
      }
    }
    renderAll();
    hooks.archiveFailedPollsIfNeeded();
    syncExistingPushPermissionSilently();
    hooks.maybeDisplayLatestAnnouncement();
    if (onReady) { const fn = onReady; onReady = null; fn(); }
  }, handleFirebaseError);
}

export function switchTab(tab) {
  haptic();
  ["agenda", "avail", "ensemble"].forEach((tName) => {
    $(`view-${tName}`).classList.toggle("hidden", tName !== tab);
    document.querySelector(`.nav-btn[data-tab="${tName}"]`).classList.toggle("active", tName === tab);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

export function renderAll() {
  if (!state.currentEnsembleData) return;
  $("header-ensemble-name").textContent = `${state.currentEnsembleData.name}${state.currentEnsembleData.formation ? ` • ${translateFormation(state.currentEnsembleData.formation)}` : ""}`;
  hooks.renderAgenda();
  hooks.renderPolls();
  renderEnsembleInfo();
}

export function renderEnsembleInfo() {
  const members = Object.values(state.currentEnsembleData.members || {});
  const myId = state.session.ensembles[state.session.activeEnsembleId]?.memberId;
  $("info-ensemble-name").textContent = state.currentEnsembleData.name;
  $("info-formation").textContent = translateFormation(state.currentEnsembleData.formation) || t("ensemble.defaultFormation");
  $("info-code").textContent = state.session.activeEnsembleId;
  $("members-count").textContent = String(members.length);

  $("members-list").innerHTML = members.map((m) => {
    const abs = Object.keys(m.unavailabilities || {}).length, isMe = m.id === myId;
    return `<div class="member-row">
      <div style="min-width:0;flex:1">
        <div class="member-name">${esc(m.name)}${isMe ? ` ${esc(t("common.youParen"))}` : ""}</div>
        <div class="member-role">${esc(m.instrument)} • ${esc(m.pushEnabled ? t("ensemble.memberPushOn") : t("ensemble.memberPushOff"))}${abs ? ` • ${esc(t("ensemble.memberAbsencesCount", { count: abs }))}` : ""}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button type="button" class="btn-secondary btn-xs" data-edit-member="${esc(m.id)}">${esc(t("common.edit"))}</button>
        <button type="button" class="btn-del-subtle btn-xs" data-remove-member="${esc(m.id)}">${esc(isMe ? t("ensemble.leaveBtn") : t("ensemble.removeBtn"))}</button>
      </div>
    </div>`;
  }).join("");

  const myUnav = Object.values(state.currentEnsembleData.members?.[myId]?.unavailabilities || {}).sort((a, b) => a.startDate.localeCompare(b.startDate));
  $("my-unavailabilities-list").innerHTML = myUnav.length
    ? myUnav.map((u) => `<div class="unavail-item"><div><div style="font-weight:600;font-size:13.5px">${esc(u.startDate === u.endDate ? t("unavail.onSingleDate", { date: formatShortDateFr(u.startDate) }) : t("unavail.rangeFromToCap", { start: formatShortDateFr(u.startDate), end: formatShortDateFr(u.endDate) }))}</div>${u.reason ? `<div style="font-size:12.5px;color:var(--muted)">${esc(u.reason)}</div>` : ""}</div><button type="button" class="btn-secondary btn-xs" data-del-unavail="${esc(u.id)}">${esc(t("common.delete"))}</button></div>`).join("")
    : `<p style="font-size:13px;color:var(--muted);margin-bottom:4px">${esc(t("ensemble.noUnavailRecorded"))}</p>`;

  $("saved-ensembles-list").innerHTML = Object.entries(state.session.ensembles).map(([id, info]) => {
    const cur = id === state.session.activeEnsembleId;
    return `<div class="ensemble-switch-row ${cur ? "active-ens" : ""}"><div><div style="font-weight:600;font-size:14px">${esc(info.ensembleName || id)}</div><div style="font-size:12px;color:var(--muted)">${esc(info.name)} (${esc(info.instrument)})</div></div><button type="button" class="btn-secondary btn-xs" data-switch-ens="${esc(id)}" ${cur ? "disabled" : ""}>${esc(cur ? t("ensemble.activeBadge") : t("ensemble.openBtn"))}</button></div>`;
  }).join("");
}

export function initEnsembleListeners() {
  document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.tab === "ensemble") {
      state.ensembleTapCount++;
      clearTimeout(state.ensembleTapTimer);
      state.ensembleTapTimer = setTimeout(() => { state.ensembleTapCount = 0; }, 1400);
      if (state.ensembleTapCount >= 5) {
        state.ensembleTapCount = 0;
        hooks.openAdminPinPrompt();
      }
    } else {
      state.ensembleTapCount = 0;
    }
    switchTab(b.dataset.tab);
  }));

  let joinLookupTimer = null;
  $("join-code").addEventListener("input", () => {
    clearTimeout(joinLookupTimer);
    joinLookupTimer = setTimeout(async () => {
      const code = extractEnsembleCode($("join-code").value);
      if (!code.startsWith("ens-") || code.length < 8) {
        $("join-existing-members-box").classList.add("hidden");
        $("join-new-member-kicker").classList.add("hidden");
        return;
      }
      try {
        const snap = await get(ref(db, `ensembles/${code}`));
        if (snap.exists()) {
          const d = snap.val();
          $("join-kicker").textContent = t("onboarding.ensembleFoundKicker", { formation: translateFormation(d.formation) || t("ensemble.defaultFormation") });
          $("join-ensemble-title").textContent = t("onboarding.inviteJoinTitle", { name: d.name });
          renderClaimableMembers(code, d);
        }
      } catch (_) {}
    }, 350);
  });

  $("form-join").addEventListener("submit", async (e) => {
    e.preventDefault(); haptic();
    const code = extractEnsembleCode($("join-code").value);
    const name = $("join-name").value.trim(), instrument = $("join-instrument").value.trim();
    const btn = $("btn-submit-join"); btn.disabled = true;
    try {
      const snap = await get(ref(db, `ensembles/${code}`));
      if (!snap.exists()) return showToast(t("onboarding.ensembleNotFoundToast"));
      const d = snap.val();

      const dup = Object.values(d.members || {}).find((m) => m.name.trim().toLowerCase() === name.toLowerCase());
      if (dup) {
        return openConfirmationModal({
          title: t("onboarding.dupTitle"),
          context: `${dup.name} (${dup.instrument}) — ${d.name}`,
          message: t("onboarding.dupMsg", { name: dup.name }),
          confirmLabel: t("onboarding.dupConfirmBtn"),
          danger: false,
          onConfirm: () => {
            state.session.ensembles[code] = { memberId: dup.id, name: dup.name, instrument: dup.instrument, ensembleName: d.name };
            state.session.activeEnsembleId = code;
            saveSession(); localStorage.removeItem(KEYS.invite);
            $("form-join").reset();
            enterEnsemble(code);
            showToast(t("onboarding.profileRestoredToast", { name: dup.name }));
          }
        });
      }

      const memberId = genId("mbr");
      await set(ref(db, `ensembles/${code}/members/${memberId}`), { id: memberId, name, instrument, pushEnabled: false });
      state.session.ensembles[code] = { memberId, name, instrument, ensembleName: d.name };
      state.session.activeEnsembleId = code; saveSession(); localStorage.removeItem(KEYS.invite);
      $("form-join").reset(); enterEnsemble(code); showToast(t("onboarding.welcomeEnsembleToast", { name: d.name }));
    } catch (err) { handleFirebaseError(err); }
    finally { btn.disabled = false; }
  });

  $("form-create").addEventListener("submit", async (e) => {
    e.preventDefault(); haptic();
    const ensembleName = $("create-ensemble-name").value.trim(), formation = $("create-formation").value;
    const memberName = $("create-member-name").value.trim(), instrument = $("create-member-instrument").value.trim();
    const btn = $("btn-submit-create"); btn.disabled = true;
    try {
      const ensId = genId("ens"), memberId = genId("mbr");
      await set(ref(db, `ensembles/${ensId}`), {
        id: ensId, name: ensembleName, formation, createdAt: Date.now(), autoRemindEve: true,
        members: { [memberId]: { id: memberId, name: memberName, instrument, pushEnabled: false } }
      });
      state.session.ensembles[ensId] = { memberId, name: memberName, instrument, ensembleName };
      state.session.activeEnsembleId = ensId; saveSession(); localStorage.removeItem(KEYS.invite);
      $("form-create").reset(); enterEnsemble(ensId, () => openModal("modal-invite"));
    } catch (err) { handleFirebaseError(err); }
    finally { btn.disabled = false; }
  });

  $("view-ensemble").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const ensId = state.session.activeEnsembleId;
    const myId = state.session.ensembles[ensId]?.memberId;

    if (btn.dataset.editMember) {
      const m = state.currentEnsembleData?.members?.[btn.dataset.editMember];
      if (!m) return;
      $("edit-member-id").value = m.id;
      $("edit-member-name").value = m.name || "";
      $("edit-member-instrument").value = m.instrument || "";
      return openModal("modal-edit-member");
    }
    if (btn.dataset.removeMember) {
      const targetId = btn.dataset.removeMember;
      const m = state.currentEnsembleData?.members?.[targetId];
      if (!m) return;
      const isMe = targetId === myId;
      return openConfirmationModal({
        title: isMe ? t("ensemble.leaveConfirmTitle") : t("ensemble.removeConfirmTitle", { name: m.name }),
        context: `${m.name} (${m.instrument})`,
        message: isMe
          ? t("ensemble.leaveConfirmMsg", { ensemble: state.currentEnsembleData.name })
          : t("ensemble.removeConfirmMsg", { name: m.name }),
        confirmLabel: isMe ? t("ensemble.leaveBtn") : t("ensemble.removeBtn"),
        onConfirm: async () => {
          try {
            const updates = { [`members/${targetId}`]: null };
            Object.values(state.currentEnsembleData.polls || {}).forEach((p) => {
              if (p.votes?.[targetId]) updates[`polls/${p.id}/votes/${targetId}`] = null;
              if (p.voteNotes?.[targetId]) updates[`polls/${p.id}/voteNotes/${targetId}`] = null;
            });
            await update(ref(db, `ensembles/${ensId}`), updates);
            if (isMe) {
              delete state.session.ensembles[ensId];
              state.session.activeEnsembleId = Object.keys(state.session.ensembles)[0] || null;
              saveSession();
              showToast(t("ensemble.leftEnsembleToast"));
              state.session.activeEnsembleId ? enterEnsemble(state.session.activeEnsembleId) : showOnboardingScreen();
            } else {
              showToast(t("ensemble.removedMemberToast", { name: m.name }));
            }
          } catch (err) { handleFirebaseError(err); }
        }
      });
    }
    if (btn.dataset.delUnavail) {
      const u = state.currentEnsembleData?.members?.[myId]?.unavailabilities?.[btn.dataset.delUnavail];
      if (!u) return;
      openConfirmationModal({
        title: t("unavail.deleteConfirmTitle"),
        context: u.startDate === u.endDate
          ? t("unavail.onSingleDate", { date: formatShortDateFr(u.startDate) })
          : t("unavail.rangeFromToCap", { start: formatShortDateFr(u.startDate), end: formatShortDateFr(u.endDate) }),
        message: t("unavail.deleteConfirmMsg"),
        confirmLabel: t("common.delete"),
        onConfirm: async () => {
          try {
            await remove(ref(db, `ensembles/${ensId}/members/${myId}/unavailabilities/${u.id}`));
            showToast(t("unavail.deletedToast"));
          } catch (err) { handleFirebaseError(err); }
        }
      });
    }
    if (btn.dataset.switchEns) {
      state.session.activeEnsembleId = btn.dataset.switchEns; saveSession(); enterEnsemble(btn.dataset.switchEns);
    }
  });

  $("form-unavailability").addEventListener("submit", async (e) => {
    e.preventDefault(); haptic();
    const startDate = $("unavail-start").value, endDate = $("unavail-end").value, reason = $("unavail-reason").value.trim();
    if (endDate < startDate) return showToast(t("unavail.endBeforeStartToast"));
    const ensId = state.session.activeEnsembleId, myId = state.session.ensembles[ensId]?.memberId;
    if (!ensId || !myId) return;
    try {
      const id = genId("una");
      await set(ref(db, `ensembles/${ensId}/members/${myId}/unavailabilities/${id}`), { id, startDate, endDate, reason, createdAt: Date.now() });
      $("form-unavailability").reset(); closeModal("modal-unavailability"); showToast(t("unavail.savedToast"));
    } catch (err) { handleFirebaseError(err); }
  });

  $("toggle-auto-remind-eve").addEventListener("change", async (e) => {
    if (!state.session.activeEnsembleId) return;
    haptic();
    const enabled = Boolean(e.target.checked);
    try {
      await update(ref(db, `ensembles/${state.session.activeEnsembleId}`), { autoRemindEve: enabled });
      showToast(enabled ? t("push.autoRemindOnToast") : t("push.autoRemindOffToast"));
    } catch (err) { handleFirebaseError(err); }
  });

  $("form-edit-ensemble").addEventListener("submit", async (e) => {
    e.preventDefault(); haptic();
    const ensId = state.session.activeEnsembleId;
    const name = $("edit-ensemble-name").value.trim();
    const formation = $("edit-ensemble-formation").value;
    if (!ensId || !name) return;
    try {
      await update(ref(db, `ensembles/${ensId}`), { name, formation, updatedAt: Date.now() });
      if (state.session.ensembles[ensId]) {
        state.session.ensembles[ensId].ensembleName = name;
        saveSession();
      }
      closeModal("modal-edit-ensemble");
      showToast(t("ensemble.updatedToast"));
    } catch (err) { handleFirebaseError(err); }
  });

  $("form-edit-member").addEventListener("submit", async (e) => {
    e.preventDefault(); haptic();
    const ensId = state.session.activeEnsembleId;
    const memberId = $("edit-member-id").value;
    const name = $("edit-member-name").value.trim();
    const instrument = $("edit-member-instrument").value.trim();
    if (!ensId || !memberId || !name || !instrument) return;
    try {
      await update(ref(db, `ensembles/${ensId}/members/${memberId}`), { name, instrument });
      if (state.session.ensembles[ensId]?.memberId === memberId) {
        state.session.ensembles[ensId].name = name;
        state.session.ensembles[ensId].instrument = instrument;
        saveSession();
      }
      closeModal("modal-edit-member");
      showToast(t("ensemble.memberUpdatedToast"));
    } catch (err) { handleFirebaseError(err); }
  });

  $("btn-toggle-push").addEventListener("click", togglePushForEnsemble);
  $("btn-test-push").addEventListener("click", async () => {
    haptic();
    if (!isEnsemblePushActive()) return showToast(t("push.enableFirstToast"));
    await triggerLocalSystemNotification(`Cadenza • ${state.currentEnsembleData?.name || "Test"}`, t("push.testNotifBody"));
    showToast(t("push.testSentToast"));
  });

  $("btn-invite-top").addEventListener("click", () => openModal("modal-invite"));
  $("btn-notif-top").addEventListener("click", () => { switchTab("ensemble"); setTimeout(() => $("push-settings-card").scrollIntoView({ behavior: "smooth" }), 80); });
  $("btn-open-edit-ensemble").addEventListener("click", () => openModal("modal-edit-ensemble"));
  $("btn-open-unavail").addEventListener("click", () => openModal("modal-unavailability"));
  $("btn-open-transfer").addEventListener("click", () => openModal("modal-transfer-device"));
  $("btn-switch-onboarding").addEventListener("click", showOnboardingScreen);
  $("btn-reopen-tuto").addEventListener("click", showTutorialScreen);
  $("btn-finish-tuto").addEventListener("click", completeTutorial);

  const shareInvite = () => shareOrCopy(
    $("invite-link-display").textContent,
    `Cadenza — ${state.currentEnsembleData?.name || "Ensemble"}`,
    t("modal.inviteShareText", { ensemble: state.currentEnsembleData?.name || "Cadenza" }),
    t("modal.inviteCopiedToast")
  );
  $("btn-share-invite").addEventListener("click", () => { openModal("modal-invite"); shareInvite(); });
  $("btn-copy-invite").addEventListener("click", async () => { haptic(); showToast((await copyTextReliable($("invite-link-display").textContent)) ? t("modal.inviteCopiedToast") : t("common.copiedFallback")); });
  $("btn-native-share").addEventListener("click", shareInvite);

  const shareTransfer = () => {
    const me = state.session.ensembles[state.session.activeEnsembleId];
    return shareOrCopy(
      $("transfer-link-display").textContent,
      t("modal.transferShareTitle", { name: me?.name || "Cadenza" }),
      t("modal.transferShareText"),
      t("modal.transferCopiedToast")
    );
  };
  $("btn-copy-transfer").addEventListener("click", async () => { haptic(); showToast((await copyTextReliable($("transfer-link-display").textContent)) ? t("modal.transferCopiedToast") : t("common.copiedFallback")); });
  $("btn-share-transfer").addEventListener("click", shareTransfer);
}
