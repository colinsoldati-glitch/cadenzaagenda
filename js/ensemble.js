import { locale, language, localizeFormation, localizePeriod } from "./i18n.js";
import * as C18 from "./i18n.js";
import {
  FIREBASE_VAPID_KEY, PUSH_WORKER_URL, KEYS,
  db, ref, set, update, remove, onValue, get, runTransaction,
  getMessaging, getToken, onMessage, isSupported,
  state, $, saveSession, haptic, genId, esc,
  showToast, handleFirebaseError, formatShortDateFr,
  extractEnsembleCode, getInviteUrl, copyTextReliable, shareOrCopy
} from "./config.js";
import { openConfirmationModal, openModal, closeModal } from "./ui.js";

let hooks = {
  archiveFailedPollsIfNeeded: async () => {},
  renderPolls: () => {},
  renderAgenda: () => {},
  openAdminPinPrompt: () => {},
  maybeDisplayLatestAnnouncement: () => {}
};

// Calendrier d'absences : dates locales, calcul des intervalles en UTC (sans décalage DST).
const absenceISO = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const absenceNext = iso => new Date(Date.parse(iso+'T00:00:00Z')+86400000).toISOString().slice(0,10);
function absencePeriods(values) {
  const result=[];
  for(const iso of [...values].sort()) {
    const last=result[result.length-1];
    if(last && absenceNext(last.endDate)===iso) last.endDate=iso;
    else result.push({startDate:iso,endDate:iso});
  }
  return result;
}
function initAbsenceCalendar() {
  const grid=$('absence-grid'), rangeBtn=$('absence-range'), save=$('absence-save');
  let month=new Date(), selected=new Set(), rangeMode=false, anchor=null, gesture=null, saving=false;
  const currentAbsences=()=>{const myId=state.session.ensembles[state.session.activeEnsembleId]?.memberId;return Object.values(state.currentEnsembleData?.members?.[myId]?.unavailabilities||{});};
  const already=iso=>currentAbsences().some(u=>u.startDate<=iso&&iso<=u.endDate);
  const range=(a,b)=>{const start=a<b?a:b,end=a<b?b:a, result=[];for(let d=start;d<=end;d=absenceNext(d))result.push(d);return result;};
  const preview=()=>gesture?.moved?new Set(range(gesture.start,gesture.end)):new Set();
  const syncDays=()=>{
    const visiting=preview();
    for(const b of grid.querySelectorAll('[data-absence-date]')){
      const d=b.dataset.absenceDate, old=already(d), picked=selected.has(d);
      b.classList.toggle('selected',picked);b.classList.toggle('existing',old);b.classList.toggle('preview',visiting.has(d)&&!old);b.classList.toggle('anchor',d===anchor);
      b.setAttribute('aria-pressed',String(picked));b.setAttribute('aria-disabled',String(old));
    }
  };
  const sync=()=>{
    syncDays();
    $('absence-count').textContent=C18.t('{0} jour(s) sélectionné(s)',selected.size);
    $('absence-periods').innerHTML=absencePeriods(selected).map(({startDate,endDate})=>`<div>${esc(formatShortDateFr(startDate))}${startDate!==endDate?' – '+esc(formatShortDateFr(endDate)):''}</div>`).join('');
    $('absence-clear').disabled=saving||!selected.size; save.disabled=saving||!selected.size;
    rangeBtn.setAttribute('aria-pressed',String(rangeMode));rangeBtn.classList.toggle('active',rangeMode);
    $('absence-range-hint').textContent=rangeMode?(anchor?C18.t('Choisissez la dernière date (même dans un autre mois).'):C18.t('Choisissez la première date.')):'';
  };
  const render=()=>{
    $('absence-month').textContent=month.toLocaleDateString(locale,{month:'long',year:'numeric'});
    $('absence-weekdays').innerHTML=Array.from({length:7},(_,i)=>`<span>${esc(new Date(2024,0,1+i).toLocaleDateString(locale,{weekday:'short'}))}</span>`).join('');
    const y=month.getFullYear(),m=month.getMonth(), offset=(new Date(y,m,1).getDay()+6)%7, count=new Date(y,m+1,0).getDate(),today=absenceISO(new Date());
    grid.innerHTML='<span aria-hidden="true"></span>'.repeat(offset)+Array.from({length:count},(_,i)=>{const d=new Date(y,m,i+1), iso=absenceISO(d);return `<button type="button" class="absence-day${iso===today?' today':''}" data-absence-date="${iso}" aria-label="${esc(d.toLocaleDateString(locale,{dateStyle:'full'}))}">${i+1}</button>`;}).join('');sync();
  };
  const addRange=(a,b)=>{for(const d of range(a,b))if(!already(d))selected.add(d);};
  const pick=iso=>{
    if(rangeMode){if(!anchor)anchor=iso;else{addRange(anchor,iso);anchor=null;rangeMode=false;}}
    else if(!already(iso)){selected.has(iso)?selected.delete(iso):selected.add(iso);}
    sync();
  };
  $('absence-prev').addEventListener('click',()=>{month=new Date(month.getFullYear(),month.getMonth()-1,1);render();});
  $('absence-next').addEventListener('click',()=>{month=new Date(month.getFullYear(),month.getMonth()+1,1);render();});
  $('absence-today').addEventListener('click',()=>{month=new Date();render();});
  $('absence-clear').addEventListener('click',()=>{selected.clear();anchor=null;sync();});
  rangeBtn.addEventListener('click',()=>{rangeMode=!rangeMode;anchor=null;sync();});
  grid.addEventListener('pointerdown',e=>{
    const b=e.target.closest('[data-absence-date]');if(!b||saving||!e.isPrimary||e.button!==0)return;
    gesture={id:e.pointerId,start:b.dataset.absenceDate,end:b.dataset.absenceDate,moved:false};grid.setPointerCapture(e.pointerId);
  });
  grid.addEventListener('pointermove',e=>{
    if(!gesture||gesture.id!==e.pointerId)return;
    const b=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-absence-date]');
    if(b&&grid.contains(b)){gesture.end=b.dataset.absenceDate;if(gesture.end!==gesture.start)gesture.moved=true;syncDays();}
  });
  grid.addEventListener('pointerup',e=>{
    if(!gesture||gesture.id!==e.pointerId)return;
    const g=gesture;gesture=null;
    if(g.moved){addRange(g.start,g.end);anchor=null;rangeMode=false;sync();}else pick(g.start);
  });
  grid.addEventListener('pointercancel',()=>{gesture=null;sync();});
  grid.addEventListener('lostpointercapture',()=>{if(gesture){gesture=null;sync();}});
  // Keyboard/assistive technology click (pointer interactions handled above).
  grid.addEventListener('click',e=>{const b=e.target.closest('[data-absence-date]');if(b&&e.detail===0&&!saving)pick(b.dataset.absenceDate);});
  $('btn-open-unavail').addEventListener('click',()=>{
    if(saving)return;month=new Date();selected=new Set();anchor=null;rangeMode=false;gesture=null;$('form-unavailability').reset();render();openModal('modal-unavailability');$('modal-unavailability').querySelector('.modal-sheet').scrollTop=0;
  });
  $('form-unavailability').addEventListener('submit',async e=>{
    e.preventDefault();if(saving||!selected.size)return;
    const ens=state.session.activeEnsembleId,myId=state.session.ensembles[ens]?.memberId;
    if(!ens||!myId)return;
    const periods=absencePeriods([...selected].filter(d=>!already(d)));
    if(!periods.length){showToast(C18.t('Ces dates sont déjà déclarées.'));return;}
    const reason=$('unavail-reason').value.trim(),createdAt=Date.now(),writes={};
    for(const period of periods){const id=genId('una');writes[id]={id,...period,reason,createdAt};}
    saving=true;sync();haptic();
    try{await update(ref(db,`ensembles/${ens}/members/${myId}/unavailabilities`),writes);selected.clear();$('form-unavailability').reset();closeModal('modal-unavailability');showToast(C18.t('Indisponibilité enregistrée.'));}
    catch(err){handleFirebaseError(err);}finally{saving=false;sync();}
  });
}

export function registerEnsembleHooks(h) {
  hooks = { ...hooks, ...h };
}

// Service Worker & Notifications Push
export async function initServiceWorkerAndPush() {
  if (!("serviceWorker" in navigator)) return;
  try {
    state.swRegistration = await navigator.serviceWorker.register(new URL("../sw.js", import.meta.url), { scope: new URL("../", import.meta.url).href });
    if (await isSupported().catch(() => false)) {
      state.messagingInstance = getMessaging();
      onMessage(state.messagingInstance, (p) => {
        if (isEnsemblePushActive()) { const msg = C18.notificationFor(p); triggerLocalSystemNotification(msg.title, msg.body); }
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
  catch (_) { return null; }
}

export async function togglePushForEnsemble() {
  haptic();
  const ensId = state.session.activeEnsembleId, mbrId = state.session.ensembles[ensId]?.memberId;
  const ensName = state.currentEnsembleData?.name || C18.t("cet ensemble");

  if (isEnsemblePushActive()) {
    if (!ensId || !mbrId) return;
    try {
      await update(ref(db, `ensembles/${ensId}/members/${mbrId}`), { pushEnabled: false, fcmToken: null });
      updatePushUI(); showToast(C18.tt`Notifications désactivées pour ${ensName}.`);
    } catch (err) { handleFirebaseError(err); }
    return;
  }

  if (!("Notification" in window)) return showToast(C18.t("Notifications non supportées sur ce navigateur."));
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
  if (isIOS && !isStandalone) return showToast(C18.t("Sur iPhone/iPad : Partager > Sur l'écran d'accueil d'abord."));

  if ((await Notification.requestPermission()) !== "granted") {
    updatePushUI(); return showToast(C18.t("Autorisation refusée dans les réglages du navigateur."));
  }

  const fcmToken = await fetchFcmTokenSafe();
  if (ensId && mbrId) {
    try {
      await update(ref(db, `ensembles/${ensId}/members/${mbrId}`), { pushEnabled: true, ...(fcmToken ? { fcmToken } : {}) });
    } catch (err) { return handleFirebaseError(err); }
  }
  updatePushUI();
  showToast(C18.tt`Notifications activées pour ${ensName}.`);
  await triggerLocalSystemNotification(`Cadenza — ${ensName}`, C18.t("Les alertes de l'ensemble sont activées."));
}

export function updatePushUI() {
  const dot = $("notif-status-dot"), msg = $("push-status-msg"), toggle = $("btn-toggle-push"), test = $("btn-test-push");
  if (!("Notification" in window)) {
    dot.classList.add("off"); msg.textContent = C18.t("Navigateur non compatible."); toggle.disabled = true; return;
  }
  const active = isEnsemblePushActive(), ensName = state.currentEnsembleData?.name || C18.t("cet ensemble");
  dot.classList.toggle("off", !active);
  toggle.textContent = active ? C18.t("Désactiver pour cet ensemble") : C18.t("Activer les notifications");
  toggle.className = `${active ? "btn-del-subtle" : "btn-primary"} btn-sm`;
  test.classList.toggle("hidden", !active);
  msg.textContent = active
    ? C18.tt`Statut : Actives pour « ${ensName} ».`
    : Notification.permission === "denied"
      ? C18.t("Statut : Bloquées dans les réglages de votre navigateur.")
      : C18.tt`Statut : Désactivées pour « ${ensName} ».`;
}

export async function triggerNativeInstall() {
  if (!state.deferredInstallPrompt) return;
  state.deferredInstallPrompt.prompt(); await state.deferredInstallPrompt.userChoice; state.deferredInstallPrompt = null;
  $("install-banner").classList.add("hidden"); $("tuto-direct-install-card").classList.add("hidden");
}

// Navigation entre vues
export function switchTab(tab) {
  haptic();
  ["agenda", "avail", "ensemble"].forEach((t) => $(`view-${t}`).classList.toggle("hidden", t !== tab));
  document.querySelectorAll(".tab-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
}

// Tutoriel & Onboarding
export function showInstallTutorial() {
  state.verifiedPopupEnsembleId=null; hooks.maybeDisplayLatestAnnouncement();
  ["app-header", "app-nav", "view-agenda", "view-avail", "view-ensemble", "view-onboarding", "install-banner"].forEach((id) => $(id).classList.add("hidden"));
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  $("tuto-ios-card").classList.toggle("featured", isIOS);
  $("tuto-android-card").classList.toggle("featured", !isIOS);
  $("view-install-tuto").classList.remove("hidden");
}

export function renderClaimableMembers(ensId, data) {
  const box = $("join-existing-members-box"), list = $("join-existing-members-list"), kicker = $("join-new-member-kicker");
  const members = data?.members ? Object.values(data.members) : [];
  if (!data || !members.length) { box.classList.add("hidden"); list.innerHTML = ""; kicker.classList.add("hidden"); return; }
  kicker.classList.remove("hidden"); box.classList.remove("hidden");
  list.innerHTML = members.map((m) => C18.h`<button type="button" class="btn-secondary btn-sm btn-full" style="justify-content:space-between" data-claim="${esc(m.id)}"><span><strong>${esc(m.name)}</strong> • ${esc(m.instrument)}</span><span style="font-size:12px;color:var(--muted)">Reprendre →</span></button>`).join("");
  list.onclick = async (e) => {
    const b = e.target.closest("[data-claim]");
    if (!b) return;
    haptic();
    const m = data.members[b.dataset.claim];
    if (!m) return;
    state.session.ensembles[ensId] = { memberId: m.id, name: m.name, instrument: m.instrument, ensembleName: data.name };
    state.session.activeEnsembleId = ensId; saveSession();
    if (m.pushEnabled && Notification.permission === "granted") {
      const tok = await fetchFcmTokenSafe();
      if (tok) update(ref(db, `ensembles/${ensId}/members/${m.id}`), { fcmToken: tok }).catch(() => {});
    }
    window.history.replaceState({}, "", window.location.pathname);
    showToast(C18.tt`Profil de ${m.name} restauré.`); enterEnsemble(ensId);
  };
}

export async function proceedAfterTutorial() {
  const params = new URLSearchParams(window.location.search);
  let pending = null;
  try { pending = JSON.parse(localStorage.getItem(KEYS.invite) || "null"); } catch (_) {}
  const ensId = params.get("ensemble") || pending?.ensembleId || null;
  const mbrId = params.get("member") || pending?.memberId || null;

  if (ensId) {
    localStorage.removeItem(KEYS.invite);
    if (mbrId) {
      try {
        const snap = await get(ref(db, `ensembles/${ensId}`));
        const d = snap.exists() ? snap.val() : null;
        const target = d?.members?.[mbrId];
        if (target) {
          state.session.ensembles[ensId] = { memberId: target.id, name: target.name, instrument: target.instrument, ensembleName: d.name };
          state.session.activeEnsembleId = ensId; saveSession();
          window.history.replaceState({}, "", window.location.pathname);
          showToast(C18.tt`Profil de ${target.name} restauré.`);
          return enterEnsemble(ensId);
        }
      } catch (err) { handleFirebaseError(err); }
    }
    if (state.session.ensembles[ensId]) {
      state.session.activeEnsembleId = ensId; saveSession();
      window.history.replaceState({}, "", window.location.pathname);
      return enterEnsemble(ensId);
    }
    $("join-code").value = ensId; $("join-card").classList.add("featured");
    try {
      const snap = await get(ref(db, `ensembles/${ensId}`));
      if (snap.exists()) {
        const d = snap.val();
        $("join-kicker").textContent = C18.tt`Invitation — ${localizeFormation(d.formation || "Ensemble")}`;
        $("join-ensemble-title").textContent = C18.tt`Rejoindre « ${d.name} »`;
        ["join-code-field", "create-card", "onboarding-divider"].forEach((id) => $(id).classList.add("hidden"));
        renderClaimableMembers(ensId, d);
      } else showToast(C18.t("Cet ensemble est introuvable."));
    } catch (err) { handleFirebaseError(err); }
    return showOnboarding();
  }
  state.session.activeEnsembleId && state.session.ensembles[state.session.activeEnsembleId] ? enterEnsemble(state.session.activeEnsembleId) : showOnboarding();
}

export function showOnboarding() {
  state.verifiedPopupEnsembleId=null; state.currentEnsembleData=null;
  state.unsubscribeEnsemble?.(); state.unsubscribeEnsemble=null; hooks.maybeDisplayLatestAnnouncement();
  ["view-install-tuto", "app-header", "app-nav", "view-agenda", "view-avail", "view-ensemble"].forEach((id) => $(id).classList.add("hidden"));
  $("view-onboarding").classList.remove("hidden");
}

export function enterEnsemble(ensembleId) {
  state.verifiedPopupEnsembleId=null; state.currentEnsembleData=null; hooks.maybeDisplayLatestAnnouncement();
  ["view-install-tuto", "view-onboarding"].forEach((id) => $(id).classList.add("hidden"));
  ["app-header", "app-nav"].forEach((id) => $(id).classList.remove("hidden"));
  $("header-ensemble-name").textContent = state.session.ensembles[ensembleId]?.ensembleName || ensembleId;
  switchTab("agenda");

  if (state.unsubscribeEnsemble) state.unsubscribeEnsemble();
  state.unsubscribeEnsemble = onValue(ref(db, `ensembles/${ensembleId}`), (snap) => {
    if(state.session.activeEnsembleId!==ensembleId)return;
    $("firebase-error-banner").classList.add("hidden");
    if (!snap.exists()) {
      showToast(C18.t("Cet ensemble n'existe plus."));
      delete state.session.ensembles[ensembleId]; state.session.activeEnsembleId = null; saveSession();
      return showOnboarding();
    }
    state.currentEnsembleData = snap.val();
    const mySes = state.session.ensembles[ensembleId];
    if (mySes) {
      mySes.ensembleName = state.currentEnsembleData.name;
      const m = state.currentEnsembleData.members?.[mySes.memberId];
      if (m) { mySes.name = m.name; mySes.instrument = m.instrument; }
      else if(leavingEnsemble!==ensembleId){
        delete state.session.ensembles[ensembleId];state.session.activeEnsembleId=Object.keys(state.session.ensembles)[0]||null;saveSession();
        showToast(C18.t('Vous ne faites plus partie de cet ensemble.'));
        if(state.session.activeEnsembleId)enterEnsemble(state.session.activeEnsembleId);else{state.unsubscribeEnsemble?.();showOnboarding();}return;
      }
      saveSession();
    }

    const myId = mySes?.memberId, evt = state.currentEnsembleData.lastEvent;
    const targeted = !Array.isArray(evt?.targetMemberIds) || evt.targetMemberIds.includes(myId);
    if (state.currentEnsembleData.members?.[myId]?.pushEnabled && evt && evt.timestamp > state.lastNotifiedTimestamp && evt.authorId !== myId && targeted) {
      state.lastNotifiedTimestamp = evt.timestamp; localStorage.setItem(KEYS.evtTs, String(state.lastNotifiedTimestamp));
      const msg = C18.notificationFor(evt);
      triggerLocalSystemNotification(msg.title, msg.body);
    }
    hooks.archiveFailedPollsIfNeeded();
    renderAll();
    state.verifiedPopupEnsembleId=state.currentEnsembleData?.members?.[myId]?ensembleId:null;
    hooks.maybeDisplayLatestAnnouncement();
  }, err=>{state.verifiedPopupEnsembleId=null;hooks.maybeDisplayLatestAnnouncement();handleFirebaseError(err);});
}

export async function publishEnsembleNotification(localized, options = {}) {
  // French fallback keeps older clients and the existing worker compatible.
  const { title, body } = localized.fr;
  if (!state.session.activeEnsembleId) return;
  const authorId = state.session.ensembles[state.session.activeEnsembleId]?.memberId, ts = Date.now();
  state.lastNotifiedTimestamp = ts; localStorage.setItem(KEYS.evtTs, String(ts));
  const targetMemberIds = Array.isArray(options.targetMemberIds) ? options.targetMemberIds : null;
  try {
    const ensembleRef = ref(db, `ensembles/${state.session.activeEnsembleId}`);
    const lastEvent = { title, body, timestamp: ts, authorId, ...(targetMemberIds ? { targetMemberIds } : {}) };
    try { await update(ensembleRef, { lastEvent: { ...lastEvent, localized } }); }
    catch (error) {
      if (!/permission|denied/i.test(String(error?.code || error?.message || error))) throw error;
      await update(ensembleRef, { lastEvent });
    }
    if (PUSH_WORKER_URL) {
      fetch(PUSH_WORKER_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ensembleId: state.session.activeEnsembleId, title, body, localized, authorId, ...(targetMemberIds ? { targetMemberIds } : {}), url: getInviteUrl(state.session.activeEnsembleId) })
      }).catch(() => {});
    }
  } catch (err) { handleFirebaseError(err); }
}

export function renderAll() {
  if (!state.currentEnsembleData) return;
  $("header-ensemble-name").textContent = `${state.currentEnsembleData.name} • ${localizeFormation(state.currentEnsembleData.formation || "")}`;
  updatePushUI();
  hooks.renderAgenda();
  hooks.renderPolls();
  renderEnsembleInfo();
}

// Cooperative member-management policy. Profiles are not authenticated by Firebase.
function managerId(data){const id=data?.memberManagerId;return id&&data.members?.[id]?id:null;}
function canManage(data,actor,target){return !!data?.members?.[actor]&&!!data?.members?.[target]&&(actor===target||!managerId(data)||managerId(data)===actor);}
function canAssign(data,actor){return !!data?.members?.[actor]&&(!managerId(data)||managerId(data)===actor);}
let managerContext=null, editMemberContext=null, leavingEnsemble=null;
// Navigation locale, sans modifier les données ni les droits Firebase.
function setEnsembleSection(section, focus = false) {
  for (const tab of document.querySelectorAll('[data-ensemble-section]')) {
    const active = tab.dataset.ensembleSection === section;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    $(tab.getAttribute('aria-controls')).classList.toggle('hidden', !active);
    if (active && focus) tab.focus();
  }
}
let renderedEnsembleId = null;
const initials = name => String(name || '?').trim().split(/\s+/).slice(0,2).map(w => Array.from(w)[0] || '').join('').toLocaleUpperCase(locale) || '?';
const searchText = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase(locale);
function filterEnsembleMembers() {
  const query = searchText($('ensemble-member-search').value.trim());
  let visible = 0;
  for (const row of $('members-list').querySelectorAll('[data-member-search]')) {
    const matches = query.split(/\s+/).every(word => row.dataset.memberSearch.includes(word));
    row.classList.toggle('hidden', !matches);
    if (matches) visible++;
  }
  $('ensemble-no-results')?.classList.toggle('hidden', visible > 0);
}
function absenceRow(u) {
  const dates = u.startDate === u.endDate ? C18.tt`Le ${formatShortDateFr(u.startDate)}` : C18.tt`Du ${formatShortDateFr(u.startDate)} au ${formatShortDateFr(u.endDate)}`;
  return `<div class="member-row ensemble-absence-row"><div class="member-identity"><strong>${esc(dates)}</strong>${u.reason ? `<div class="member-meta">${esc(u.reason)}</div>` : ''}</div><button type="button" class="btn-secondary" data-del-unavail="${esc(u.id)}">${esc(C18.t('Supprimer'))}</button></div>`;
}
export function renderEnsembleInfo() {
  const data = state.currentEnsembleData, membersObj = data.members || {}, members = Object.values(membersObj);
  const myId = state.session.ensembles[state.session.activeEnsembleId]?.memberId, today = absenceISO(new Date());
  const newEnsemble = renderedEnsembleId !== state.session.activeEnsembleId;
  const opened = newEnsemble ? [] : [...$('members-list').querySelectorAll('details[open]')].map(d => d.dataset.memberActions);
  if (newEnsemble) {
    renderedEnsembleId = state.session.activeEnsembleId;
    $('ensemble-member-search').value = '';
    $('ensemble-switcher').open = false;
    $('ensemble-past-absences').open = false;
    setEnsembleSection('members');
  }
  const manager = managerId(data), me = membersObj[myId];
  members.sort((a,b) => Number(b.id === myId) - Number(a.id === myId) || String(a.name || '').localeCompare(String(b.name || ''),locale));
  $('info-formation').textContent = localizeFormation(data.formation || 'Ensemble');
  $('info-name').textContent = data.name;
  $('info-code').textContent = state.session.activeEnsembleId;
  $('members-count').textContent = members.length;
  $('saved-ensembles-count').textContent = Object.keys(state.session.ensembles).length;
  $('toggle-auto-remind-eve').checked = data.autoRemindEve !== false;

  $('ensemble-manager-panel').innerHTML = `<div><strong>${esc(C18.t(manager?'Responsable de l’ensemble':'Gestion partagée'))}</strong><small>${esc(manager?membersObj[manager].name:C18.t('Tous les membres peuvent gérer les profils.'))}</small></div>${canAssign(data,myId)?`<button type="button" class="btn-secondary" data-manager-settings>${esc(C18.t(manager?'Modifier':'Nommer'))}</button>`:''}<p>${esc(C18.t('Restriction dans l’application uniquement. Les profils ne sont pas authentifiés.'))}</p>`;
  $('members-list').innerHTML = members.map(m => {
    const isMe = m.id === myId, abs = Object.values(m.unavailabilities || {}).filter(u => u.endDate >= today).length;
    const role = manager === m.id ? `<span class="manager-label">${esc(C18.t('Responsable'))}</span>` : '';
    return `<article class="ensemble-member${isMe?' ensemble-member-me':''}" data-member-search="${esc(searchText(`${m.name || ''} ${m.instrument || ''}`))}"><div class="ensemble-member-main"><div class="ensemble-avatar" aria-hidden="true">${esc(initials(m.name))}</div><div class="member-identity"><div class="ensemble-member-name"><strong>${esc(m.name || '')}</strong>${isMe ? `<span class="ensemble-you">${esc(C18.t('(Vous)'))}</span>` : ''}${role}</div><div class="member-meta">${esc(m.instrument || '')}</div><div class="ensemble-member-status"><span class="ensemble-alert-status${m.pushEnabled?' is-on':''}">${esc(C18.t(m.pushEnabled?'Alertes actives':'Sans alerte'))}</span>${abs?`<span>${esc(C18.t('{0} absence(s)',abs))}</span>`:''}</div></div></div>${canManage(data,myId,m.id)?`<details class="ensemble-member-actions" data-member-actions="${esc(m.id)}"${opened.includes(m.id)?' open':''}><summary aria-label="${esc(C18.t('Actions pour {0}',m.name))}"><span>${esc(C18.t('Actions'))}</span></summary><div class="ensemble-member-action-buttons"><button type="button" class="btn-secondary" data-edit-member="${esc(m.id)}">${esc(C18.t('Modifier'))}</button><button type="button" class="btn-del-subtle" data-remove-member="${esc(m.id)}">${esc(C18.t(isMe?'Quitter':'Retirer'))}</button></div></details>`:''}</article>`;
  }).join('')+`<p id="ensemble-no-results" class="ensemble-empty hidden">${esc(C18.t('Aucun musicien trouvé.'))}</p>`;
  $('ensemble-member-search-wrap').classList.toggle('hidden',members.length < 7);
  if (members.length < 7) $('ensemble-member-search').value = '';
  filterEnsembleMembers();
  $('ensemble-my-profile').innerHTML = me ? `<div class="member-row ensemble-profile-row"><div class="ensemble-avatar" aria-hidden="true">${esc(initials(me.name))}</div><div class="member-identity"><strong>${esc(me.name || '')}</strong><div class="member-meta">${esc(me.instrument || '')}</div></div><button type="button" class="btn-secondary" data-edit-member="${esc(myId)}">${esc(C18.t('Modifier'))}</button></div>` : '';

  const absences = Object.values(me?.unavailabilities || {}).sort((a,b) => (a.startDate || '').localeCompare(b.startDate || ''));
  const upcoming = absences.filter(u => u.endDate >= today), past = absences.filter(u => u.endDate < today).reverse();
  $('ensemble-absence-count').textContent = upcoming.length;
  $('my-unavailabilities-list').innerHTML = upcoming.length ? upcoming.map(absenceRow).join('') : `<p class="ensemble-empty">${esc(C18.t('Aucune absence en cours ou à venir.'))}</p>`;
  $('ensemble-past-absences').classList.toggle('hidden', !past.length);
  $('ensemble-past-count').textContent = past.length;
  $('ensemble-past-list').innerHTML = past.map(absenceRow).join('');

  $('saved-ensembles-list').innerHTML = Object.keys(state.session.ensembles).sort((a,b) => Number(b === state.session.activeEnsembleId)-Number(a === state.session.activeEnsembleId)).map(id => {
    const it = state.session.ensembles[id], cur = id === state.session.activeEnsembleId;
    return `<div class="member-row ensemble-saved-row"><div class="member-identity"><strong>${esc(it.ensembleName || id)}</strong><div class="member-meta">${esc(it.name || '')} • ${esc(it.instrument || '')}</div></div>${cur?`<span class="ensemble-active-label">${esc(C18.t('Actif'))}</span>`:`<button type="button" class="btn-secondary" data-switch-ens="${esc(id)}">${esc(C18.t('Ouvrir'))}</button>`}</div>`;
  }).join('');
}

export function initEnsembleListeners() {
  $('ensemble-member-search').addEventListener('input', filterEnsembleMembers);
  document.querySelector('.ensemble-tabs').addEventListener('click', e => {
    const tab = e.target.closest('[data-ensemble-section]');
    if (tab) setEnsembleSection(tab.dataset.ensembleSection);
  });
  document.querySelector('.ensemble-tabs').addEventListener('keydown', e => {
    const tabs = [...document.querySelectorAll('[data-ensemble-section]')], index = tabs.indexOf(document.activeElement);
    if (index < 0 || !['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    setEnsembleSection(tabs[next].dataset.ensembleSection, true);
  });
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); state.deferredInstallPrompt = e;
    $("install-banner").classList.remove("hidden"); $("tuto-direct-install-card").classList.remove("hidden");
  });

  $("btn-install-pwa").addEventListener("click", triggerNativeInstall);
  $("btn-tuto-direct-install").addEventListener("click", triggerNativeInstall);

  document.querySelectorAll(".tab-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      switchTab(tab);
      if (tab === "ensemble") {
        state.ensembleTapCount++;
        clearTimeout(state.ensembleTapTimer);
        if (state.ensembleTapCount >= 4) { state.ensembleTapCount = 0; return hooks.openAdminPinPrompt(); }
        state.ensembleTapTimer = setTimeout(() => { state.ensembleTapCount = 0; }, 1500);
      } else { state.ensembleTapCount = 0; clearTimeout(state.ensembleTapTimer); }
    });
  });

  $("btn-finish-tuto").addEventListener("click", async () => {
    haptic(); localStorage.setItem(KEYS.tuto, "1");
    $("view-install-tuto").classList.add("hidden");
    await proceedAfterTutorial(); hooks.maybeDisplayLatestAnnouncement();
  });
  $("btn-reopen-tuto").addEventListener("click", () => { haptic(); showInstallTutorial(); });

  let codeLookupTimer = null;
  $("join-code").addEventListener("input", () => {
    clearTimeout(codeLookupTimer);
    const code = extractEnsembleCode($("join-code").value);
    if (code.length < 6) return renderClaimableMembers(null, null);
    codeLookupTimer = setTimeout(async () => {
      try {
        const snap = await get(ref(db, `ensembles/${code}`));
        if (snap.exists()) {
          const d = snap.val();
          $("join-kicker").textContent = C18.tt`Ensemble trouvé — ${localizeFormation(d.formation || "Ensemble")}`;
          $("join-ensemble-title").textContent = d.name;
          renderClaimableMembers(code, d);
        } else renderClaimableMembers(null, null);
      } catch (_) {}
    }, 300);
  });

  $("form-create").addEventListener("submit", async (e) => {
    e.preventDefault(); haptic();
    const btn = $("btn-submit-create"); btn.disabled = true;
    try {
      const ensembleName = $("create-ensemble-name").value.trim(), formation = $("create-formation").value;
      const memberName = $("create-member-name").value.trim(), instrument = $("create-member-instrument").value.trim();
      const ensembleId = genId("ens"), memberId = genId("mbr");
      const pushEnabled = "Notification" in window && Notification.permission === "granted";
      const fcmToken = pushEnabled ? await fetchFcmTokenSafe() : null;

      await set(ref(db, `ensembles/${ensembleId}`), {
        id: ensembleId, name: ensembleName, formation, autoRemindEve: true, createdAt: Date.now(),
        ...($("create-manager").checked?{memberManagerId:memberId}:{}),
        members: { [memberId]: { id: memberId, name: memberName, instrument, pushEnabled, ...(fcmToken ? { fcmToken } : {}), joinedAt: Date.now() } }
      });
      $("firebase-error-banner").classList.add("hidden");
      state.session.ensembles[ensembleId] = { memberId, name: memberName, instrument, ensembleName };
      state.session.activeEnsembleId = ensembleId; saveSession();
      enterEnsemble(ensembleId); openModal("modal-invite");
    } catch (err) { handleFirebaseError(err); }
    finally { btn.disabled = false; }
  });

  $("form-join").addEventListener("submit", async (e) => {
    e.preventDefault(); haptic();
    const btn = $("btn-submit-join"); btn.disabled = true;
    try {
      const code = extractEnsembleCode($("join-code").value), name = $("join-name").value.trim(), instrument = $("join-instrument").value.trim();
      const snap = await get(ref(db, `ensembles/${code}`));
      $("firebase-error-banner").classList.add("hidden");
      if (!snap.exists()) { showToast(C18.t("Ensemble introuvable.")); return; }

      const d = snap.val();
      const dup = Object.values(d.members || {}).find((m) => m.name?.trim().toLowerCase() === name.toLowerCase());
      const finalizeJoin = async (memberId, finalName, isRestore) => {
        const pushEnabled = isRestore ? Boolean(dup.pushEnabled) : ("Notification" in window && Notification.permission === "granted");
        const fcmToken = (pushEnabled && Notification.permission === "granted") ? await fetchFcmTokenSafe() : null;
        if (isRestore) {
          await update(ref(db, `ensembles/${code}/members/${memberId}`), { instrument, ...(fcmToken ? { fcmToken } : {}) });
        } else {
          await set(ref(db, `ensembles/${code}/members/${memberId}`), { id: memberId, name: finalName, instrument, pushEnabled, ...(fcmToken ? { fcmToken } : {}), joinedAt: Date.now() });
        }
        state.session.ensembles[code] = { memberId, name: finalName, instrument, ensembleName: d.name };
        state.session.activeEnsembleId = code; saveSession();
        window.history.replaceState({}, "", window.location.pathname);
        showToast(isRestore ? C18.tt`Profil de ${finalName} restauré.` : C18.tt`Bienvenue dans ${d.name}.`);
        enterEnsemble(code);
      };

      if (dup) {
        openConfirmationModal({
          title: C18.t("Profil existant détecté"),
          context: `${dup.name} • ${dup.instrument}`,
          message: C18.tt`Un membre nommé « ${dup.name} » existe déjà. Voulez-vous restaurer ce profil et ses votes plutôt que d'en créer un nouveau ?`,
          confirmLabel: C18.t("Restaurer ce profil"),
          danger: false,
          onConfirm: () => finalizeJoin(dup.id, dup.name, true)
        });
      } else {
        await finalizeJoin(genId("mbr"), name, false);
      }
    } catch (err) { handleFirebaseError(err); }
    finally { btn.disabled = false; }
  });

  $("view-ensemble").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const membersObj = state.currentEnsembleData?.members || {}, myId = state.session.ensembles[state.session.activeEnsembleId]?.memberId;

    if(btn.hasAttribute('data-manager-settings')){
      if(!canAssign(state.currentEnsembleData,myId))return;
      managerContext={ens:state.session.activeEnsembleId,actor:myId};
      $('manager-select').innerHTML=`<option value="">${esc(C18.t('Aucun responsable (gestion partagée)'))}</option>`+Object.values(membersObj).map(m=>`<option value="${esc(m.id)}">${esc(m.name)} · ${esc(m.instrument)}</option>`).join('');
      $('manager-select').value=managerId(state.currentEnsembleData)||'';
      return openModal('modal-ensemble-manager');
    }
    if (btn.dataset.editMember) {
      const m = membersObj[btn.dataset.editMember]; if (!m||!canManage(state.currentEnsembleData,myId,m.id)) return;
      editMemberContext={ens:state.session.activeEnsembleId,actor:myId};
      $("edit-member-id").value = m.id; $("edit-member-name").value = m.name || ""; $("edit-member-instrument").value = m.instrument || "";
      return openModal("modal-edit-member");
    }
    if (btn.dataset.removeMember) {
      const tid = btn.dataset.removeMember, m = membersObj[tid]; if (!m||!canManage(state.currentEnsembleData,myId,tid)) return;
      const isMe = tid === myId, ensId=state.session.activeEnsembleId;
      if(isMe&&managerId(state.currentEnsembleData)===tid&&Object.keys(membersObj).length>1)return showToast(C18.t('Transférez ou désactivez votre rôle avant de quitter.'));
      return openConfirmationModal({
        title: isMe ? C18.t("Quitter cet ensemble ?") : C18.tt`Retirer ${m.name} ?`,
        context: `${m.name} • ${m.instrument}`,
        message: isMe ? C18.tt`Vous quitterez « ${state.currentEnsembleData.name} » et vos votes seront retirés.` : C18.tt`${m.name} sera retiré de l'ensemble ainsi que ses votes.`,
        confirmLabel: isMe ? C18.t("Quitter") : C18.t("Retirer"),
        onConfirm: async () => {
          try {
            if(ensId!==state.session.activeEnsembleId)return;
            if(isMe)leavingEnsemble=ensId;
            const result=await runTransaction(ref(db,`ensembles/${ensId}`),data=>{
              if(!canManage(data,myId,tid))return;
              if(managerId(data)===tid&&Object.keys(data.members).length>1)return;
              delete data.members[tid];
              if(data.memberManagerId===tid)delete data.memberManagerId;
              for(const poll of Object.values(data.polls||{})){if(poll.votes)delete poll.votes[tid];if(poll.voteNotes)delete poll.voteNotes[tid];}
              return data;
            },{applyLocally:false});
            if(!result.committed)return showToast(C18.t('Action refusée : vérifiez les droits de gestion.'));
            if (isMe) {
              delete state.session.ensembles[ensId];
              state.session.activeEnsembleId = Object.keys(state.session.ensembles)[0] || null;
              saveSession(); showToast(C18.t("Vous avez quitté l'ensemble."));
              state.session.activeEnsembleId ? enterEnsemble(state.session.activeEnsembleId) : (state.unsubscribeEnsemble?.(), showOnboarding());
            } else showToast(C18.tt`${m.name} a été retiré.`);
          } catch (err) { handleFirebaseError(err); } finally { leavingEnsemble=null; }
        }
      });
    }
    if (btn.dataset.delUnavail) {
      const u = membersObj[myId]?.unavailabilities?.[btn.dataset.delUnavail]; if (!u) return;
      const rTxt = u.startDate === u.endDate ? C18.tt`Le ${formatShortDateFr(u.startDate)}` : C18.tt`Du ${formatShortDateFr(u.startDate)} au ${formatShortDateFr(u.endDate)}`;
      return openConfirmationModal({
        title: C18.t("Supprimer cette absence ?"), context: `${rTxt}${u.reason ? ` — ${u.reason}` : ""}`,
        message: C18.t("Cette période ne sera plus signalée."), confirmLabel: C18.t("Supprimer"),
        onConfirm: async () => {
          try { await remove(ref(db, `ensembles/${state.session.activeEnsembleId}/members/${myId}/unavailabilities/${u.id}`)); showToast(C18.t("Absence supprimée.")); }
          catch (err) { handleFirebaseError(err); }
        }
      });
    }
    if (btn.dataset.switchEns) {
      state.session.activeEnsembleId = btn.dataset.switchEns; saveSession(); enterEnsemble(state.session.activeEnsembleId);
    }
  });

  initAbsenceCalendar();

  $("toggle-auto-remind-eve").addEventListener("change", async (e) => {
    haptic(); if (!state.session.activeEnsembleId) return;
    try {
      await update(ref(db, `ensembles/${state.session.activeEnsembleId}`), { autoRemindEve: e.target.checked });
      showToast(e.target.checked ? C18.t("Rappel automatique la veille à 19h00 activé.") : C18.t("Rappel automatique désactivé."));
    } catch (err) { handleFirebaseError(err); }
  });

  $("form-edit-ensemble").addEventListener("submit", async (e) => {
    e.preventDefault(); haptic();
    const name = $("edit-ensemble-name").value.trim(), formation = $("edit-ensemble-formation").value;
    if (!name || !state.session.activeEnsembleId) return;
    try {
      await update(ref(db, `ensembles/${state.session.activeEnsembleId}`), { name, formation });
      state.session.ensembles[state.session.activeEnsembleId].ensembleName = name; saveSession();
      closeModal("modal-edit-ensemble"); showToast(C18.t("Ensemble mis à jour."));
    } catch (err) { handleFirebaseError(err); }
  });

  $('form-ensemble-manager').addEventListener('submit',async e=>{
    e.preventDefault();const ctx=managerContext, target=$('manager-select').value,btn=e.target.querySelector('button[type="submit"]');
    if(!ctx||ctx.ens!==state.session.activeEnsembleId||btn.disabled)return;
    btn.disabled=true;
    try{const result=await runTransaction(ref(db,`ensembles/${ctx.ens}`),data=>{if(!canAssign(data,ctx.actor)||(target&&!data.members?.[target]))return;if(target)data.memberManagerId=target;else delete data.memberManagerId;return data;},{applyLocally:false});if(!result.committed)return showToast(C18.t('Action refusée : vérifiez les droits de gestion.'));closeModal('modal-ensemble-manager');showToast(C18.t('Gestion des membres mise à jour.'));}catch(err){handleFirebaseError(err);}finally{btn.disabled=false;}
  });
  $("form-edit-member").addEventListener("submit", async (e) => {
    e.preventDefault(); haptic();
    const id = $("edit-member-id").value, name = $("edit-member-name").value.trim(), instrument = $("edit-member-instrument").value.trim();
    if (!id || !name || !instrument || !state.session.activeEnsembleId || editMemberContext?.ens!==state.session.activeEnsembleId) return;
    try {
      const result=await runTransaction(ref(db,`ensembles/${editMemberContext.ens}`),data=>{if(!canManage(data,editMemberContext.actor,id))return;Object.assign(data.members[id],{name,instrument});return data;},{applyLocally:false});
      if(!result.committed)return showToast(C18.t('Action refusée : vérifiez les droits de gestion.'));
      const mySes = state.session.ensembles[state.session.activeEnsembleId];
      if (mySes?.memberId === id) { mySes.name = name; mySes.instrument = instrument; saveSession(); }
      closeModal("modal-edit-member"); showToast(C18.t("Profil mis à jour."));
    } catch (err) { handleFirebaseError(err); }
  });

  $("btn-open-edit-ensemble").addEventListener("click", () => openModal("modal-edit-ensemble"));
  $("btn-open-transfer").addEventListener("click", () => openModal("modal-transfer-device"));
  $("btn-invite-top").addEventListener("click", () => openModal("modal-invite"));
  $("btn-notif-top").addEventListener("click", togglePushForEnsemble);
  $("btn-toggle-push").addEventListener("click", togglePushForEnsemble);
  $("btn-test-push").addEventListener("click", async () => {
    haptic();
    if (!isEnsemblePushActive()) return showToast(C18.t("Activez d'abord les notifications."));
    await triggerLocalSystemNotification(`Cadenza — ${state.currentEnsembleData?.name || "Ensemble"}`, C18.t("Test réussi : vos notifications fonctionnent."));
    showToast(C18.t("Notification de test envoyée."));
  });

  $("btn-share-invite").addEventListener("click", () => shareOrCopy(getInviteUrl(state.session.activeEnsembleId), `Cadenza — ${state.currentEnsembleData.name}`, C18.tt`Rejoignez l'agenda de ${state.currentEnsembleData.name} sur Cadenza :`, C18.t("Lien d'invitation copié.")));
  $("btn-copy-invite").addEventListener("click", async () => { haptic(); showToast((await copyTextReliable(getInviteUrl(state.session.activeEnsembleId))) ? C18.t("Lien d'invitation copié.") : C18.t("Copiez le lien affiché.")); });
  $("btn-native-share").addEventListener("click", () => shareOrCopy(getInviteUrl(state.session.activeEnsembleId), `Cadenza — ${state.currentEnsembleData.name}`, C18.tt`Rejoignez notre ensemble ${state.currentEnsembleData.name} sur Cadenza :`, C18.t("Lien d'invitation copié.")));
  $("btn-copy-transfer").addEventListener("click", async () => { haptic(); showToast((await copyTextReliable($("transfer-link-display").textContent)) ? C18.t("Lien personnel copié.") : C18.t("Copiez le lien affiché.")); });
  $("btn-share-transfer").addEventListener("click", () => shareOrCopy($("transfer-link-display").textContent, C18.tt`Cadenza — Profil de ${state.session.ensembles[state.session.activeEnsembleId]?.name || C18.t("Musicien")}`, C18.t("Ouvrez ce lien sur votre appareil pour retrouver votre profil Cadenza :"), C18.t("Lien personnel copié.")));
  $("btn-switch-onboarding").addEventListener("click", () => { haptic(); state.unsubscribeEnsemble?.(); showOnboarding(); });
}
