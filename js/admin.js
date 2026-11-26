import { locale, language, localizeFormation, localizePeriod } from "./i18n.js";
import * as C18 from "./i18n.js";
import {
  APP_VERSION, KEYS, db, ref, set, update, remove, onValue, get,
  state, $, haptic, genId, esc, getVoterDeviceId, getCurrentRespondentLabel,
  showToast, handleFirebaseError, copyTextReliable
} from "./config.js";
import { openConfirmationModal, closeModal } from "./ui.js";

export const POPUP_TYPE_META = {
  poll: { label: C18.t("Sondage"), defaultBadge: C18.t("Sondage"), defaultTitle: C18.t("Votre avis sur Cadenza"), defaultSub: C18.t("Quelle option préférez-vous ?") },
  feedback: { label: C18.t("Demande d'avis"), defaultBadge: C18.t("Retour"), defaultTitle: C18.t("Vos idées & retours"), defaultSub: C18.t("Aidez-nous à améliorer Cadenza :") },
  message: { label: C18.t("Message"), defaultBadge: "Info", defaultTitle: C18.t("Message de l'équipe Cadenza"), defaultSub: C18.t("Information importante :") },
  update: { label: C18.t("Mise à jour"), defaultBadge: APP_VERSION, defaultTitle: C18.t("Nouveautés sur Cadenza"), defaultSub: C18.t("Découvrez les dernières améliorations :") }
};

export function openAdminPinPrompt() {
  haptic();
  $("admin-pin-input").value = "";
  $("admin-pin-error").classList.add("hidden");
  $("modal-admin-pin").classList.add("open");
  setTimeout(() => $("admin-pin-input").focus(), 80);
}

export function switchAdminPortalTab(tab) {
  state.adminActiveTab = tab;
  document.querySelectorAll("[data-admin-tab]").forEach((b) => b.classList.toggle("active", b.dataset.adminTab === tab));
  $("admin-panel-publish").classList.toggle("hidden", tab !== "publish");
  $("admin-panel-results").classList.toggle("hidden", tab !== "results");
  $("admin-panel-stats").classList.toggle("hidden", tab !== "stats");
  if (tab === "results") renderAdminResultsPanel();
  if (tab === "stats") renderAdminStatsPanel();
}

export function setAdminPopupType(type) {
  state.adminPopupType = POPUP_TYPE_META[type] ? type : "poll";
  document.querySelectorAll("[data-popup-type]").forEach((b) => b.classList.toggle("active", b.dataset.popupType === state.adminPopupType));
  $("admin-fields-poll").classList.toggle("hidden", state.adminPopupType !== "poll");
  $("admin-fields-feedback").classList.toggle("hidden", state.adminPopupType !== "feedback");
  $("admin-fields-message").classList.toggle("hidden", state.adminPopupType !== "message");
  $("admin-fields-update").classList.toggle("hidden", state.adminPopupType !== "update");

  const meta = POPUP_TYPE_META[state.adminPopupType];
  $("admin-ann-version").placeholder = C18.tt`Ex: ${meta.defaultBadge}`;
  if (!$("admin-ann-version").dataset.touched) $("admin-ann-version").value = meta.defaultBadge;
  if (!$("admin-ann-title").dataset.touched) $("admin-ann-title").value = meta.defaultTitle;
  $("lbl-admin-subtitle").textContent = state.adminPopupType === "poll" ? C18.t("Question du sondage") : state.adminPopupType === "feedback" ? C18.t("Question posée aux utilisateurs") : C18.t("Sous-titre (optionnel)");
  $("admin-ann-subtitle").placeholder = meta.defaultSub;
  if (state.adminPopupType === "poll") renderAdminPollOptionsBuilder();
}

export function renderAdminPollOptionsBuilder() {
  const box = $("admin-poll-options-list");
  box.innerHTML = state.adminPollOptions.map((opt, idx) => C18.h`
    <div class="poll-opt-builder-row">
      <input type="text" class="admin-poll-opt-input" data-opt-idx="${idx}" value="${esc(opt)}" placeholder="Option ${idx + 1} (ex: Oui, Non...)" />
      ${state.adminPollOptions.length > 2 ? C18.h`<button type="button" class="btn-remove-opt" data-del-opt="${idx}" aria-label="Retirer cette option">✕</button>` : ""}
    </div>`).join("");
}

// Latest stays a legacy-compatible payload. The preceding active item is stored in queue.
const SEEN_QUEUE_KEY = 'cadenza_seen_announcements_v2';
let adminPublishing=false, popupSubmitting=false, previewQueue=[];
function activeAnnouncements(raw=state.latestAnnouncementData) {
  if(!raw?.active||!raw.id)return [];
  const previous=Object.values(raw.queue||{}).filter(a=>a?.active&&a.id&&a.id!==raw.id);
  const items=[...previous,{...raw}].map(({queue,...a})=>a);
  return [...new Map(items.map(a=>[a.id,a])).values()].slice(-2);
}
function seenAnnouncements(){
  const seen=new Set();try{for(const id of JSON.parse(localStorage.getItem(SEEN_QUEUE_KEY)||'[]'))if(typeof id==='string')seen.add(id);}catch(_){}
  const legacy=localStorage.getItem(KEYS.ann);if(legacy)seen.add(legacy);return seen;
}
function markSeen(id){if(!id)return;const seen=seenAnnouncements();seen.add(id);localStorage.setItem(SEEN_QUEUE_KEY,JSON.stringify([...seen]));localStorage.setItem(KEYS.ann,id);}
function encodeAnnouncements(items){
  if(!items.length)return {active:false};
  const last=items[items.length-1];return items.length>1?{...last,queue:items.slice(0,-1)}:{...last};
}
async function readActiveAnnouncements(){const snap=await get(ref(db,'app_announcements/latest/public'));return activeAnnouncements(snap.exists()?snap.val():null);}
async function saveAnnouncements(items){await set(ref(db,'app_announcements/latest'),{public:encodeAnnouncements(items),auth:{pin:state.verifiedAdminPin}});}
export function refreshAdminAnnouncementStatusUI(){
  const box=$('admin-current-announcement'), retest=$('btn-admin-retest-popup'), clear=$('btn-admin-clear-announcement'),items=activeAnnouncements();
  box.innerHTML=items.length?items.map((a,i)=>`<div class="admin-queue-item"><span class="admin-queue-number">${i+1}</span><div class="admin-queue-content"><strong>${esc(a.title||'Pop-up')}</strong><small>${esc(POPUP_TYPE_META[a.type]?.label||C18.t('Annonce'))}${a.version?' · '+esc(a.version):''}</small></div><button type="button" class="btn-del-subtle btn-xs" data-admin-deactivate="${esc(a.id)}">${esc(C18.t('Désactiver'))}</button></div>`).join(''):esc(C18.t('Aucune pop-up publiée actuellement.'));
  retest.classList.toggle('hidden',!items.length);clear.classList.toggle('hidden',!items.length);
  $('admin-queue-help').textContent=C18.t(items.length===2?'Deux pop-up sont actives. Désactivez-en une pour en publier une autre.':items.length===1?'La prochaine pop-up sera affichée après la première.':'Publiez une première pop-up, puis éventuellement une seconde.');
  $('btn-admin-publish').disabled=adminPublishing||items.length>=2;
  $('btn-admin-publish').textContent=C18.t(items.length===1?'Publier en deuxième position':'Publier pour tous les utilisateurs');
}

export function buildAdminAnnouncementPayload(id) {
  const type = state.adminPopupType;
  const version = $("admin-ann-version").value.trim() || POPUP_TYPE_META[type].defaultBadge;
  const title = $("admin-ann-title").value.trim() || POPUP_TYPE_META[type].defaultTitle;
  const subtitle = $("admin-ann-subtitle").value.trim();

  if (type === "poll") {
    const cleanOpts = state.adminPollOptions.map((o) => String(o || "").trim()).filter(Boolean);
    if (cleanOpts.length < 2) {
      showToast(C18.t("Ajoutez au moins 2 choix de vote."));
      return null;
    }
    return {
      id, active: true, type: "poll", version, title,
      subtitle: subtitle || C18.t("Faites votre choix ci-dessous :"),
      options: cleanOpts,
      allowComment: $("admin-poll-allow-comment").checked,
      publishedAt: Date.now()
    };
  }

  if (type === "feedback") {
    const ph = $("admin-feedback-placeholder").value.trim() || C18.t("Écrivez votre retour ou suggestion ici...");
    if (!subtitle) {
      showToast(C18.t("Indiquez la question posée aux utilisateurs."));
      return null;
    }
    return {
      id, active: true, type: "feedback", version, title, subtitle,
      placeholder: ph, publishedAt: Date.now()
    };
  }

  if (type === "message") {
    const body = $("admin-message-body").value.trim();
    if (!body) {
      showToast(C18.t("Écrivez le contenu du message à afficher."));
      return null;
    }
    return {
      id, active: true, type: "message", version, title, subtitle,
      body, ctaLabel: $("admin-message-cta").value.trim() || C18.t("J'ai compris, fermer"),
      publishedAt: Date.now()
    };
  }

  const items = $("admin-ann-notes").value.split("\n").map((l) => l.replace(/^[-•*✓]\s*/, "").trim()).filter(Boolean);
  if (!items.length) {
    showToast(C18.t("Ajoutez au moins une nouveauté."));
    return null;
  }
  return {
    id, active: true, type: "update", version, title,
    subtitle: subtitle || C18.t("Découvrez les dernières améliorations :"),
    items, publishedAt: Date.now()
  };
}

// Affichage de la pop-up côté utilisateur (Mise à jour, Sondage, Avis ou Message libre)
export function showWhatsNewModal(ann, isPreview = false) {
  if (!ann) return;
  state.isPreviewingWhatsNew = isPreview;
  state.currentRenderedPopupData = ann;
  state.displayedAnnouncementId = ann.id || null;
  state.selectedUserPollOptionIndex = null;

  const active=isPreview?previewQueue:activeAnnouncements();
  const position=active.findIndex(a=>a.id===ann.id), progress=$('whats-new-progress');
  progress.classList.toggle('hidden',active.length<2||position<0);
  progress.textContent=C18.t('Information {0} sur {1}',position+1,active.length);
  const pType = ann.type || "update";
  $("whats-new-title").textContent = ann.title || "Cadenza";
  $("whats-new-version-badge").textContent = ann.version ? (isPreview ? C18.tt`Aperçu • ${ann.version}` : ann.version) : (isPreview ? C18.t("Aperçu") : C18.t("Information"));

  const subEl = $("whats-new-subtitle");
  if (ann.subtitle) {
    subEl.textContent = ann.subtitle;
    subEl.classList.remove("hidden");
  } else {
    subEl.classList.add("hidden");
  }

  const dEl = $("whats-new-date");
  if (ann.publishedAt) {
    dEl.textContent = new Date(ann.publishedAt).toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
    dEl.classList.remove("hidden");
  } else dEl.classList.add("hidden");

  const bodyEl = $("whats-new-dynamic-body");
  const footerEl = $("whats-new-footer-actions");

  if (pType === "poll") {
    const opts = Array.isArray(ann.options) ? ann.options : [];
    bodyEl.innerHTML = `
      <div class="user-poll-options-list" id="user-poll-options-list">
        ${opts.map((opt, idx) => `
          <button type="button" class="user-poll-option-btn" data-user-poll-opt="${idx}">
            <span class="poll-radio-circle"></span>
            <span>${esc(opt)}</span>
          </button>`).join("")}
      </div>
      ${ann.allowComment ? C18.htmlLiteral("\n        <div class=\"field\" style=\"margin-bottom: 14px;\">\n          <label for=\"user-popup-comment-input\">Commentaire ou précision (facultatif)</label>\n          <textarea id=\"user-popup-comment-input\" rows=\"2\" maxlength=\"400\" placeholder=\"Ajoutez une remarque si vous le souhaitez...\"></textarea>\n        </div>") : ""}`;

    footerEl.innerHTML = C18.htmlLiteral("\n      <button type=\"button\" id=\"btn-submit-user-popup-response\" class=\"btn-confirm btn-full\">Envoyer mon vote</button>\n      <button type=\"button\" id=\"btn-skip-user-popup\" class=\"btn-secondary btn-sm btn-full\">Fermer sans voter</button>");
  } else if (pType === "feedback") {
    bodyEl.innerHTML = C18.h`
      <div class="field" style="margin-bottom: 14px;">
        <label for="user-popup-comment-input">Votre réponse</label>
        <textarea id="user-popup-comment-input" rows="4" maxlength="600" placeholder="${esc(ann.placeholder || C18.t("Écrivez votre retour ici..."))}"></textarea>
      </div>`;

    footerEl.innerHTML = C18.htmlLiteral("\n      <button type=\"button\" id=\"btn-submit-user-popup-response\" class=\"btn-confirm btn-full\">Envoyer mon retour</button>\n      <button type=\"button\" id=\"btn-skip-user-popup\" class=\"btn-secondary btn-sm btn-full\">Fermer sans répondre</button>");
  } else if (pType === "message") {
    bodyEl.innerHTML = `<div class="message-free-box">${esc(ann.body || ann.message || "")}</div>`;
    footerEl.innerHTML = `<button type="button" id="btn-skip-user-popup" class="btn-primary btn-full">${esc(ann.ctaLabel || C18.t("J'ai compris, fermer"))}</button>`;
  } else {
    const lines = Array.isArray(ann.items) ? ann.items : String(ann.message || "").split("\n").map((l) => l.replace(/^[-•*✓]\s*/, "").trim()).filter(Boolean);
    bodyEl.innerHTML = `<ul class="release-notes-list">${lines.map((l) => `<li><span class="release-notes-check">✓</span><span>${esc(l)}</span></li>`).join("")}</ul>`;
    footerEl.innerHTML = C18.htmlLiteral("<button type=\"button\" id=\"btn-skip-user-popup\" class=\"btn-primary btn-full\">J'ai compris, fermer</button>");
  }

  $("modal-whats-new").classList.add("open");
  $("modal-whats-new").querySelector(".modal-sheet").scrollTop=0;
}

export function dismissWhatsNewModal() {
  if(popupSubmitting)return;
  haptic();
  const preview=state.isPreviewingWhatsNew;
  if(!preview&&state.displayedAnnouncementId)markSeen(state.displayedAnnouncementId);
  if(preview&&previewQueue.length){
    const i=previewQueue.findIndex(a=>a.id===state.displayedAnnouncementId);
    if(i>=0&&i+1<previewQueue.length)return showWhatsNewModal(previewQueue[i+1],true);
  }
  previewQueue=[];state.isPreviewingWhatsNew=false;state.displayedAnnouncementId=null;state.currentRenderedPopupData=null;
  closeModal('modal-whats-new');maybeDisplayLatestAnnouncement();
}
export function maybeDisplayLatestAnnouncement() {
  if(adminPublishing||popupSubmitting||$('modal-whats-new').classList.contains('open')||!$('view-install-tuto').classList.contains('hidden'))return;
  const seen=seenAnnouncements(), next=activeAnnouncements().find(a=>!seen.has(a.id));
  if(next)showWhatsNewModal(next,false);
}

export function updateAdminResultsBadge() {
  const badge = $("admin-results-badge");
  let totalResponses = 0;
  Object.values(state.allFeedbackCampaigns).forEach((camp) => {
    totalResponses += Object.keys(camp?.responses || {}).length;
  });
  badge.textContent = String(totalResponses);
  badge.classList.toggle("hidden", totalResponses === 0);
}

export function renderAdminResultsPanel() {
  $("admin-feedback-rules-warning").classList.toggle("hidden", !state.feedbackPermissionDenied);

  const campaignsMap = { ...state.allFeedbackCampaigns };
  const latest = state.latestAnnouncementData;
  const active=activeAnnouncements();
  for(const a of active)if((a.type==='poll'||a.type==='feedback')&&!campaignsMap[a.id])campaignsMap[a.id]={meta:a,responses:{}};

  const campaigns = Object.values(campaignsMap)
    .filter((c) => c?.meta)
    .sort((a, b) => (b.meta.publishedAt || 0) - (a.meta.publishedAt || 0));

  if (!campaigns.length) {
    $("admin-results-empty").classList.remove("hidden");
    $("admin-results-content").classList.add("hidden");
    return;
  }

  $("admin-results-empty").classList.add("hidden");
  $("admin-results-content").classList.remove("hidden");

  const select = $("admin-results-campaign-select");
  if (!state.selectedResultsCampaignId || !campaignsMap[state.selectedResultsCampaignId]) {
    state.selectedResultsCampaignId = (latest?.id && campaignsMap[latest.id]) ? latest.id : campaigns[0].meta.id;
  }

  select.innerHTML = campaigns.map((c) => {
    const count = Object.keys(c.responses || {}).length;
    const tLabel = POPUP_TYPE_META[c.meta.type]?.label || C18.t("Campagne");
    const isCurrent = active.some(a=>a.id===c.meta.id);
    return C18.h`<option value="${esc(c.meta.id)}" ${c.meta.id === state.selectedResultsCampaignId ? "selected" : ""}>[${tLabel}] ${esc(c.meta.title || C18.t("Sans titre"))} (${count} rép.)${isCurrent ? C18.t(" — Actif") : ""}</option>`;
  }).join("");

  const activeCamp = campaignsMap[state.selectedResultsCampaignId] || campaigns[0];
  const meta = activeCamp.meta || {};
  const responses = Object.values(activeCamp.responses || {}).sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

  $("res-campaign-badge").textContent = `${POPUP_TYPE_META[meta.type]?.label || C18.t("Campagne")}${meta.version ? ` • ${meta.version}` : ""}`;
  $("res-campaign-title").textContent = meta.title || C18.t("Sondage");
  $("res-campaign-subtitle").textContent = meta.subtitle || "";
  $("res-total-count").textContent = C18.t(responses.length === 1 ? "{0} réponse" : "{0} réponses", responses.length);

  const barsBox = $("res-poll-bars-container");
  if (meta.type === "poll" && Array.isArray(meta.options) && meta.options.length) {
    barsBox.classList.remove("hidden");
    const counts = meta.options.map((_, idx) => responses.filter((r) => r.optionIndex === idx).length);
    const maxCount = Math.max(...counts, 0);

    barsBox.innerHTML = meta.options.map((opt, idx) => {
      const c = counts[idx];
      const pct = responses.length > 0 ? Math.round((c / responses.length) * 100) : 0;
      const isWinner = maxCount > 0 && c === maxCount;
      return `
        <div class="result-stat-row">
          <div class="result-stat-head">
            <span style="font-weight:${isWinner ? "700" : "500"}">${esc(opt)}</span>
            <span style="font-weight:700;color:${isWinner ? "var(--yes-fg)" : "var(--muted)"}">${c} (${pct}%)</span>
          </div>
          <div class="result-bar-track">
            <div class="result-bar-fill ${isWinner ? "winner" : ""}" style="width:${pct}%"></div>
          </div>
        </div>`;
    }).join("");
  } else {
    barsBox.classList.add("hidden");
    barsBox.innerHTML = "";
  }

  const comments = responses.filter((r) => Boolean(r.comment));
  $("res-comments-count").textContent = String(comments.length);
  $("res-comments-list").innerHTML = comments.length
    ? comments.map((r) => {
        const dStr = r.submittedAt ? new Date(r.submittedAt).toLocaleDateString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
        return `
          <div class="feedback-response-card">
            <div class="feedback-response-meta">
              <strong>${esc(r.respondent || C18.t("Utilisateur"))}</strong>
              <span>${esc(dStr)}</span>
            </div>
            ${r.optionLabel ? C18.h`<div style="font-size:11.5px;color:var(--accent-fg);font-weight:600;margin-bottom:3px">Vote : ${esc(r.optionLabel)}</div>` : ""}
            <div style="white-space:pre-line;color:var(--fg)">${esc(r.comment)}</div>
          </div>`;
      }).join("")
    : C18.htmlLiteral("<div style=\"font-size:13px;color:var(--muted)\">Aucun commentaire écrit pour le moment.</div>");
}

// Extraction de l'horodatage de création d'un ensemble (avec repli sur le 1er membre)
function getEnsembleTimestamp(ens) {
  if (!ens || typeof ens !== "object") return 0;
  if (typeof ens.createdAt === "number" && ens.createdAt > 0) return ens.createdAt;
  if (typeof ens.createdAt === "string") {
    const parsed = Date.parse(ens.createdAt);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const memberTimes = Object.values(ens.members || {})
    .map((m) => {
      if (!m || typeof m !== "object") return 0;
      if (typeof m.joinedAt === "number") return m.joinedAt;
      if (typeof m.createdAt === "number") return m.createdAt;
      return 0;
    })
    .filter((t) => t > 0);
  if (memberTimes.length) return Math.min(...memberTimes);
  return 0;
}

function formatEnsembleRegistrationDate(ts) {
  if (!ts) return C18.t("Inscription récente");
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return C18.t("Inscription récente");
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfToday - startOfDay) / 86400000);
  const timeStr = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (diffDays === 0) return C18.tt`Aujourd'hui à ${timeStr}`;
  if (diffDays === 1) return C18.tt`Hier à ${timeStr}`;
  if (diffDays > 1 && diffDays < 7) return C18.tt`Il y a ${diffDays} jours`;
  return d.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}

function ensureAdminEnsemblesListener() {
  if (state.unsubscribeAdminEnsembles) return;
  state.adminEnsemblesLoaded = false;
  state.unsubscribeAdminEnsembles = onValue(ref(db, "ensembles"), (snap) => {
    state.ensemblesPermissionDenied = false;
    state.adminEnsemblesLoaded = true;
    const list = [];
    let idx = 0;
    snap.forEach((childSnap) => {
      const val = childSnap.val();
      if (val && typeof val === "object") {
        const membersList = Object.values(val.members || {}).filter((m) => m && typeof m === "object" && m.name);
        list.push({
          id: val.id || childSnap.key,
          name: val.name || C18.t("Ensemble sans nom"),
          formation: val.formation || "Ensemble",
          members: membersList,
          memberCount: membersList.length,
          timestamp: getEnsembleTimestamp(val),
          orderIndex: idx++
        });
      }
    });
    list.sort((a, b) => (b.timestamp !== a.timestamp ? b.timestamp - a.timestamp : b.orderIndex - a.orderIndex));
    state.allAdminEnsembles = list;
    if (state.adminActiveTab === "stats" && $("modal-admin-portal").classList.contains("open")) {
      renderAdminStatsPanel();
    }
  }, (err) => {
    state.adminEnsemblesLoaded = true;
    if (String(err?.message || "").toLowerCase().includes("permission") || err?.code === "PERMISSION_DENIED") {
      state.ensemblesPermissionDenied = true;
    }
    if (state.adminActiveTab === "stats" && $("modal-admin-portal").classList.contains("open")) {
      renderAdminStatsPanel();
    }
  });
}

export function renderAdminStatsPanel() {
  $("admin-stats-rules-warning").classList.toggle("hidden", !state.ensemblesPermissionDenied);

  if (state.ensemblesPermissionDenied) {
    $("admin-stats-loading").classList.add("hidden");
    $("admin-stats-empty").classList.add("hidden");
    $("admin-stats-content").classList.add("hidden");
    return;
  }

  if (!state.adminEnsemblesLoaded) {
    $("admin-stats-loading").classList.remove("hidden");
    $("admin-stats-empty").classList.add("hidden");
    $("admin-stats-content").classList.add("hidden");
    return;
  }

  $("admin-stats-loading").classList.add("hidden");

  const allEnsembles = state.allAdminEnsembles || [];
  if (!allEnsembles.length) {
    $("admin-stats-empty").classList.remove("hidden");
    $("admin-stats-content").classList.add("hidden");
    return;
  }

  $("admin-stats-empty").classList.add("hidden");
  $("admin-stats-content").classList.remove("hidden");

  const activeEnsembles = allEnsembles.filter((e) => e.memberCount > 0);
  const totalMusicians = allEnsembles.reduce((sum, e) => sum + e.memberCount, 0);
  const avgMusicians = activeEnsembles.length > 0 ? (totalMusicians / activeEnsembles.length).toFixed(1).replace(".", ",") : "0";

  $("stat-active-ensembles").textContent = String(activeEnsembles.length);
  $("stat-active-ensembles-sub").textContent = allEnsembles.length > activeEnsembles.length
    ? C18.tt`sur ${allEnsembles.length} créés au total`
    : `${activeEnsembles.length > 1 ? C18.t("espaces actifs") : C18.t("espace actif")}`;

  $("stat-total-musicians").textContent = String(totalMusicians);
  $("stat-total-musicians-sub").textContent = C18.tt`moy. ${avgMusicians} / ensemble`;

  const sourceList = activeEnsembles.length > 0 ? activeEnsembles : allEnsembles;
  const limit = 10;
  const visibleList = state.showAllRecentEnsembles ? sourceList : sourceList.slice(0, limit);

  $("stat-recent-count-badge").textContent = String(sourceList.length);

  $("stat-recent-ensembles-list").innerHTML = visibleList.map((ens) => {
    const membersPreview = ens.members
      .slice(0, 5)
      .map((m) => (m.instrument ? `${m.name} (${m.instrument})` : m.name))
      .join(", ") + (ens.memberCount > 5 ? ` +${ens.memberCount - 5}` : "");
    const dateLabel = formatEnsembleRegistrationDate(ens.timestamp);
    return C18.h`
      <div class="admin-stat-ensemble-row">
        <div class="admin-stat-ens-top">
          <div style="min-width: 0;">
            <span class="admin-stat-ens-name">${esc(ens.name)}</span>
            <span class="event-type-badge" style="margin-left: 6px;">${esc(localizeFormation(ens.formation))}</span>
          </div>
          <span class="consensus-badge partial-good">${ens.memberCount} musicien${ens.memberCount > 1 ? "s" : ""}</span>
        </div>
        <div class="admin-stat-ens-meta">
          <span>${esc(dateLabel)}</span>
          <span>•</span>
          <code style="font-size: 11px;">${esc(ens.id)}</code>
        </div>
        ${membersPreview ? `<div class="admin-stat-ens-members">${esc(membersPreview)}</div>` : ""}
      </div>`;
  }).join("");

  const toggleBtn = $("btn-toggle-all-recent-ensembles");
  if (sourceList.length > limit) {
    toggleBtn.classList.remove("hidden");
    toggleBtn.textContent = state.showAllRecentEnsembles
      ? C18.t("Afficher uniquement les 10 derniers")
      : C18.tt`Afficher tous les ensembles (${sourceList.length})`;
  } else {
    toggleBtn.classList.add("hidden");
  }
}

export function initAdminListeners() {
  document.querySelectorAll("[data-admin-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      haptic();
      switchAdminPortalTab(btn.dataset.adminTab);
    });
  });

  ["admin-ann-version", "admin-ann-title"].forEach((id) => {
    $(id).addEventListener("input", () => { $(id).dataset.touched = "1"; });
  });

  document.querySelectorAll("[data-popup-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      haptic();
      setAdminPopupType(btn.dataset.popupType);
    });
  });

  $("admin-poll-options-list").addEventListener("input", (e) => {
    const inp = e.target.closest(".admin-poll-opt-input");
    if (inp) state.adminPollOptions[Number(inp.dataset.optIdx)] = inp.value;
  });

  $("admin-poll-options-list").addEventListener("click", (e) => {
    const del = e.target.closest("[data-del-opt]");
    if (!del || state.adminPollOptions.length <= 2) return;
    haptic();
    state.adminPollOptions.splice(Number(del.dataset.delOpt), 1);
    renderAdminPollOptionsBuilder();
  });

  $("btn-admin-add-option").addEventListener("click", () => {
    haptic();
    state.adminPollOptions.push("");
    renderAdminPollOptionsBuilder();
    const inputs = $("admin-poll-options-list").querySelectorAll(".admin-poll-opt-input");
    inputs[inputs.length - 1]?.focus();
  });

  $("whats-new-dynamic-body").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-user-poll-opt]");
    if (!btn) return;
    haptic();
    state.selectedUserPollOptionIndex = Number(btn.dataset.userPollOpt);
    $("whats-new-dynamic-body").querySelectorAll(".user-poll-option-btn").forEach((b) => {
      const isSel = Number(b.dataset.userPollOpt) === state.selectedUserPollOptionIndex;
      b.classList.toggle("selected", isSel);
      b.querySelector(".poll-radio-circle").textContent = isSel ? "✓" : "";
    });
  });

  $("whats-new-footer-actions").addEventListener("click", async (e) => {
    if (e.target.closest("#btn-skip-user-popup")) {
      return dismissWhatsNewModal();
    }
    const submitBtn = e.target.closest("#btn-submit-user-popup-response");
    if (!submitBtn || !state.currentRenderedPopupData) return;
    haptic();

    const ann = state.currentRenderedPopupData;
    const pType = ann.type || "update";
    const commentVal = $("user-popup-comment-input")?.value.trim() || "";

    if (pType === "poll" && state.selectedUserPollOptionIndex === null) {
      return showToast(C18.t("Sélectionnez une option avant d'envoyer votre vote."));
    }
    if (pType === "feedback" && !commentVal) {
      return showToast(C18.t("Écrivez un message avant d'envoyer votre retour."));
    }

    if (state.isPreviewingWhatsNew) {
      showToast(C18.t("Aperçu : votre réponse a bien été simulée."));
      return dismissWhatsNewModal();
    }

    submitBtn.disabled = true; popupSubmitting=true;
    const voterId = getVoterDeviceId();
    const optionLabel = pType === "poll" ? (ann.options?.[state.selectedUserPollOptionIndex] || "") : "";

    try {
      await update(ref(db, `app_feedback/${ann.id}`), {
        meta: {
          id: ann.id,
          type: pType,
          version: ann.version || "",
          title: ann.title || "",
          subtitle: ann.subtitle || "",
          options: ann.options || null,
          publishedAt: ann.publishedAt || Date.now()
        },
        [`responses/${voterId}`]: {
          voterId,
          respondent: getCurrentRespondentLabel(),
          optionIndex: pType === "poll" ? state.selectedUserPollOptionIndex : null,
          optionLabel,
          comment: commentVal,
          submittedAt: Date.now()
        }
      });
      showToast(pType === "poll" ? C18.t("Merci ! Votre vote a été enregistré.") : C18.t("Merci ! Votre retour a été envoyé."));
      popupSubmitting=false; dismissWhatsNewModal();
    } catch (err) {
      console.warn("Feedback write error:", err);
      showToast(C18.t("Impossible d'enregistrer la réponse (vérifiez les règles Firebase)."));
    } finally {
      popupSubmitting=false;submitBtn.disabled = false;
    }
  });

  // Écoute Firebase des annonces & retours
  onValue(ref(db, "app_announcements/latest/public"), (snap) => {
    state.latestAnnouncementData = snap.exists() ? snap.val() : null;
    refreshAdminAnnouncementStatusUI();
    if(state.adminActiveTab==="results"&&$("modal-admin-portal").classList.contains("open"))renderAdminResultsPanel();
    maybeDisplayLatestAnnouncement();
  }, () => {});

  onValue(ref(db, "app_feedback"), (snap) => {
    state.feedbackPermissionDenied = false;
    state.allFeedbackCampaigns = snap.exists() ? (snap.val() || {}) : {};
    updateAdminResultsBadge();
    if (state.adminActiveTab === "results" && $("modal-admin-portal").classList.contains("open")) {
      renderAdminResultsPanel();
    }
  }, (err) => {
    if (String(err?.message || "").toLowerCase().includes("permission") || err?.code === "PERMISSION_DENIED") {
      state.feedbackPermissionDenied = true;
      if (state.adminActiveTab === "results" && $("modal-admin-portal").classList.contains("open")) {
        renderAdminResultsPanel();
      }
    }
  });

  $("admin-results-campaign-select").addEventListener("change", (e) => {
    state.selectedResultsCampaignId = e.target.value;
    renderAdminResultsPanel();
  });

  $("btn-copy-fb-rule").addEventListener("click", async () => {
    haptic();
    const ok = await copyTextReliable($("firebase-feedback-rule-snippet").textContent);
    showToast(ok ? C18.t("Règle Firebase copiée.") : C18.t("Copiez la règle affichée."));
  });

  $("btn-copy-ensembles-rule").addEventListener("click", async () => {
    haptic();
    const ok = await copyTextReliable($("firebase-ensembles-rule-snippet").textContent);
    showToast(ok ? C18.t("Règle Firebase copiée.") : C18.t("Copiez la règle affichée."));
  });

  $("btn-toggle-all-recent-ensembles").addEventListener("click", () => {
    haptic();
    state.showAllRecentEnsembles = !state.showAllRecentEnsembles;
    renderAdminStatsPanel();
  });

  $("btn-admin-delete-campaign-results").addEventListener("click", () => {
    if (!state.selectedResultsCampaignId || !state.verifiedAdminPin) return;
    const campId = state.selectedResultsCampaignId;
    openConfirmationModal({
      title: C18.t("Supprimer ces résultats ?"),
      context: $("res-campaign-title").textContent,
      message: C18.t("Tous les votes et commentaires associés à cette campagne seront définitivement effacés."),
      confirmLabel: C18.t("Supprimer les résultats"),
      onConfirm: async () => {
        try {
          await remove(ref(db, `app_feedback/${campId}`));
          state.selectedResultsCampaignId = null;
          showToast(C18.t("Résultats supprimés."));
        } catch (err) {
          handleFirebaseError(err);
        }
      }
    });
  });

  $("form-admin-pin").addEventListener("submit", async (e) => {
    e.preventDefault(); haptic();
    const entered = $("admin-pin-input").value.trim();
    const btn = $("btn-submit-admin-pin");
    btn.disabled = true; $("admin-pin-error").classList.add("hidden");
    try {
      await set(ref(db, "admin_sessions/last_check"), { pin: entered, ts: Date.now() });
      state.verifiedAdminPin = entered;
      state.showAllRecentEnsembles = false;
      ensureAdminEnsemblesListener();
      closeModal("modal-admin-pin");
      $("admin-firebase-warning").classList.add("hidden");
      delete $("admin-ann-version").dataset.touched;
      delete $("admin-ann-title").dataset.touched;
      setAdminPopupType(state.adminPopupType);
      switchAdminPortalTab("publish");
      refreshAdminAnnouncementStatusUI();
      $("modal-admin-portal").classList.add("open");
    } catch (_) {
      state.verifiedAdminPin = null;
      $("admin-pin-error").classList.remove("hidden");
      $("admin-pin-input").value = ""; $("admin-pin-input").focus();
    } finally { btn.disabled = false; }
  });

  $("btn-admin-preview").addEventListener("click", () => {
    haptic();
    const payload = buildAdminAnnouncementPayload("preview");
    if (!payload) return;
    previewQueue=[];showWhatsNewModal(payload, true);
  });

  $('form-admin-announcement').addEventListener('submit',async e=>{
    e.preventDefault();haptic();if(adminPublishing)return;
    if(!state.verifiedAdminPin){closeModal('modal-admin-portal');return openAdminPinPrompt();}
    const newId=genId('ann'),payload=buildAdminAnnouncementPayload(newId);if(!payload)return;
    adminPublishing=true;refreshAdminAnnouncementStatusUI();
    try{
      const items=await readActiveAnnouncements();
      if(items.length>=2){showToast(C18.t('Deux pop-up sont actives. Désactivez-en une pour en publier une autre.'));return;}
      await saveAnnouncements([...items,payload]);
      // Publisher has already read the new message; preview is available in the portal.
      markSeen(newId);
      if(payload.type==='poll'||payload.type==='feedback'){
        set(ref(db,`app_feedback/${newId}/meta`),payload).catch(()=>{});state.selectedResultsCampaignId=newId;
      }
      closeModal('modal-admin-portal');showToast(C18.t('Pop-up publiée pour tous les utilisateurs !'));
    }catch(_){$('admin-firebase-warning').classList.remove('hidden');showToast(C18.t('Accès refusé par Firebase.'));}
    finally{adminPublishing=false;refreshAdminAnnouncementStatusUI();}
  });
  $('btn-admin-retest-popup').addEventListener('click',()=>{
    previewQueue=activeAnnouncements();if(!previewQueue.length)return;
    closeModal('modal-admin-portal');showWhatsNewModal(previewQueue[0],true);
  });
  const deactivate=async id=>{
    if(adminPublishing)return;haptic();
    if(!state.verifiedAdminPin){closeModal('modal-admin-portal');return openAdminPinPrompt();}
    adminPublishing=true;refreshAdminAnnouncementStatusUI();
    try{const items=await readActiveAnnouncements();await saveAnnouncements(id?items.filter(a=>a.id!==id):[]);showToast(C18.t(id?'La pop-up a été désactivée.':'Les pop-up ont été désactivées.'));}
    catch(_){$('admin-firebase-warning').classList.remove('hidden');showToast(C18.t('Accès refusé par Firebase.'));}
    finally{adminPublishing=false;refreshAdminAnnouncementStatusUI();}
  };
  $('admin-current-announcement').addEventListener('click',e=>{const b=e.target.closest('[data-admin-deactivate]');if(b)deactivate(b.dataset.adminDeactivate);});
  $('btn-admin-clear-announcement').addEventListener('click',()=>deactivate(null));

  $("btn-close-whats-new-top").addEventListener("click", dismissWhatsNewModal);
}
