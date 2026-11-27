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
  document.querySelectorAll("[data-admin-tab]").forEach((b) => {const active=b.dataset.adminTab===tab;b.classList.toggle("active",active);b.setAttribute("aria-selected",String(active));});
  $("admin-panel-publish").classList.toggle("hidden", tab !== "publish");
  $("admin-panel-results").classList.toggle("hidden", tab !== "results");
  $("admin-panel-stats").classList.toggle("hidden", tab !== "stats");
  if (tab === "results") renderAdminResultsPanel();
  if (tab === "stats") renderAdminStatsPanel();
}

export function setAdminPopupType(type) {
  state.adminPopupType = POPUP_TYPE_META[type] ? type : "poll";
  document.querySelectorAll("[data-popup-type]").forEach((b) => {const active=b.dataset.popupType===state.adminPopupType;b.classList.toggle("active",active);b.setAttribute("aria-pressed",String(active));});
  $("admin-fields-poll").classList.toggle("hidden", state.adminPopupType !== "poll");
  $("admin-fields-feedback").classList.toggle("hidden", state.adminPopupType !== "feedback");
  $("admin-fields-message").classList.toggle("hidden", state.adminPopupType !== "message");
  $("admin-fields-update").classList.toggle("hidden", state.adminPopupType !== "update");

  const meta = popupDefaults(state.adminPopupType, editorLanguage);
  for(const [code,d] of Object.entries(languageDrafts)){
    const defaults=popupDefaults(state.adminPopupType,code);
    if(!d.titleTouched)d.title=defaults.title;
    if(!d.badgeTouched)d.version=defaults.version;
  }
  $("admin-ann-version").placeholder = C18.tt`Ex: ${meta.version}`;
  if (!$("admin-ann-version").dataset.touched) $("admin-ann-version").value = meta.version;
  if (!$("admin-ann-title").dataset.touched) $("admin-ann-title").value = meta.title;
  $("lbl-admin-subtitle").textContent = state.adminPopupType === "poll" ? C18.t("Question du sondage") : state.adminPopupType === "feedback" ? C18.t("Question posée aux utilisateurs") : C18.t("Sous-titre (optionnel)");
  $("admin-ann-subtitle").placeholder = meta.subtitle;
  if (state.adminPopupType === "poll") renderAdminPollOptionsBuilder();
  $("admin-popup-secondary-field").classList.toggle("hidden", !["poll","feedback"].includes(state.adminPopupType));
  renderLivePreview();
}

export function renderAdminPollOptionsBuilder() {
  const box = $("admin-poll-options-list");
  box.innerHTML = state.adminPollOptions.map((opt, idx) => C18.h`
    <div class="poll-opt-builder-row">
      <input type="text" class="admin-poll-opt-input" data-opt-idx="${idx}" value="${esc(opt)}" placeholder="${esc(C18.t('Option {0}',idx+1))}" />
      ${state.adminPollOptions.length > 2 ? C18.h`<button type="button" class="btn-remove-opt" data-del-opt="${idx}" aria-label="${esc(C18.t('Retirer cette option'))}">✕</button>` : ""}
    </div>`).join("");
}

// New campaigns are deliberately hidden from legacy clients, which cannot enforce targeting.
const SEEN_QUEUE_KEY = 'cadenza_seen_announcements_v2';
const LANGS=['fr','de','en'];
const LANG_NAMES={fr:'Français',de:'Deutsch',en:'English'};
let adminPublishing=false, popupSubmitting=false, previewQueue=[], scheduleTimer;
const viewWrites=new Set();
function activeAnnouncements(raw=state.latestAnnouncementData) {
  if(!raw)return [];
  const items=[...Object.values(raw.campaigns||{}),...Object.values(raw.multilingualCampaigns||{}),...(raw.active&&raw.id?[...Object.values(raw.queue||{}),raw]:[])];
  return [...new Map(items.filter(a=>a?.active&&a.id).map(({queue,...a})=>[a.id,a])).values()].sort((a,b)=>(a.publishedAt||0)-(b.publishedAt||0));
}
function campaignStatus(a,now=Date.now()){
  if(a.endsAt&&now>=a.endsAt)return 'expired';
  if(a.startsAt&&now<a.startsAt)return 'scheduled';
  return 'live';
}
function campaignLanguages(a){return Array.isArray(a.languages)?a.languages:LANGS;}
function availableAnnouncements(){return activeAnnouncements().filter(a=>campaignStatus(a)!=='expired');}
function userAnnouncements(){return availableAnnouncements().filter(a=>campaignStatus(a)==='live'&&campaignLanguages(a).includes(language)&&(!a.localized||a.localized[language]));}
function localizedCampaign(a,code=language){
  if(!a.localized)return a;
  const actual=a.localized[code]?code:campaignLanguages(a)[0];
  const variant=a.localized[actual];
  if(!variant)return a;
  return {...a,...variant,design:{...a.design,...variant.design},displayLanguage:actual};
}
function canonicalCampaign(a){return activeAnnouncements().find(c=>c.id===a.id)||a;}
function statusLabel(a){return C18.t({expired:'Terminée',scheduled:'Programmée',live:'En diffusion'}[campaignStatus(a)]);}
function formatDate(ts){return ts?new Date(ts).toLocaleString(locale,{dateStyle:'short',timeStyle:'short'}):'';}
function periodLabel(a){return `${a.startsAt?formatDate(a.startsAt):C18.t('Immédiatement')} → ${a.endsAt?formatDate(a.endsAt):C18.t('Sans fin')}`;}
function scheduleRefresh(){
  clearTimeout(scheduleTimer);
  const now=Date.now(), next=activeAnnouncements().flatMap(a=>[a.startsAt,a.endsAt]).filter(x=>x>now).sort((a,b)=>a-b)[0];
  if(next)scheduleTimer=setTimeout(()=>{refreshAdminAnnouncementStatusUI();maybeDisplayLatestAnnouncement();scheduleRefresh();},Math.min(60000,Math.max(25,next-now+25)));
}
// One record per campaign and browser installation; repeated displays cannot inflate the total.
function recordView(a){
  if(!a?.id||!a.trackViews||state.isPreviewingWhatsNew||!eligibleForAnnouncement()||document.visibilityState!=='visible')return;
  const voter=getVoterDeviceId(), key=`cadenza_view_v1:${a.id}:${voter}`;
  if(viewWrites.has(key)||localStorage.getItem(key)==='1')return;
  viewWrites.add(key);
  const pending=localStorage.getItem(key); let impression;
  try{impression=JSON.parse(pending||'null');}catch(_){}
  if(!impression||typeof impression!=='object')impression={language,viewedAt:Date.now()};
  localStorage.setItem(key,JSON.stringify(impression));
  update(ref(db,`app_feedback/${a.id}`),{[`views/${voter}`]:impression,meta:canonicalCampaign(a)})
    .then(()=>localStorage.setItem(key,'1')).catch(err=>console.warn('Campaign impression not saved',err)).finally(()=>viewWrites.delete(key));
}
function seenAnnouncements(){
  const seen=new Set();try{for(const id of JSON.parse(localStorage.getItem(SEEN_QUEUE_KEY)||'[]'))if(typeof id==='string')seen.add(id);}catch(_){}
  const legacy=localStorage.getItem(KEYS.ann);if(legacy)seen.add(legacy);return seen;
}
function markSeen(id){if(!id)return;const seen=seenAnnouncements();seen.add(id);localStorage.setItem(SEEN_QUEUE_KEY,JSON.stringify([...seen]));localStorage.setItem(KEYS.ann,id);}
// Older releases ignore multilingualCampaigns rather than show an untranslated message.
function encodeAnnouncements(items){return {active:false,campaigns:items.filter(a=>!a.localized),multilingualCampaigns:items.filter(a=>a.localized)};}
async function readActiveAnnouncements(){const snap=await get(ref(db,'app_announcements/latest/public'));return activeAnnouncements(snap.exists()?snap.val():null);}
async function saveAnnouncements(items){await set(ref(db,'app_announcements/latest'),{public:encodeAnnouncements(items),auth:{pin:state.verifiedAdminPin}});}
export function refreshAdminAnnouncementStatusUI(){
  const box=$('admin-current-announcement'), retest=$('btn-admin-retest-popup'), clear=$('btn-admin-clear-announcement'),items=availableAnnouncements();
  box.innerHTML=items.length?items.map((a,i)=>{
    const views=state.feedbackPermissionDenied||!a.trackViews?'—':Object.keys(state.allFeedbackCampaigns[a.id]?.views||{}).length;
    return `<div class="admin-queue-item"><span class="admin-queue-number">${i+1}</span><div class="admin-queue-content"><strong>${esc(localizedCampaign(a).title||'Pop-up')}</strong><div class="admin-campaign-meta"><span class="admin-campaign-status ${campaignStatus(a)}">${esc(statusLabel(a))}</span><span>${esc(campaignLanguages(a).map(l=>LANG_NAMES[l]||l).join(' · '))}</span></div><small>${esc(periodLabel(a))}</small><small>${esc(C18.t('{0} consultations uniques',views))}</small></div><button type="button" class="btn-del-subtle btn-xs" data-admin-deactivate="${esc(a.id)}">${esc(C18.t('Désactiver'))}</button></div>`;
  }).join(''):esc(C18.t('Aucune pop-up publiée actuellement.'));
  retest.classList.toggle('hidden',!items.length);clear.classList.toggle('hidden',!items.length);
  $('admin-queue-help').textContent=C18.t('Les campagnes sont affichées dans leur ordre de publication, selon la langue et la période.');
  $('btn-admin-publish').disabled=adminPublishing;
  $('admin-active-count').textContent=String(items.length);
  $('btn-admin-publish').textContent=C18.t($('admin-start-at').value&&new Date($('admin-start-at').value).getTime()>Date.now()?'Programmer la pop-up':'Publier pour les membres');
}

const THEMES=['blue','ink','green','purple','amber','rose'];
const ICONS={none:'',info:'ℹ️',sparkles:'✨',music:'♫',heart:'♥',bell:'🔔',poll:'📊'};
function safeLink(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:'';}catch(_){return '';}}
// Shared visual settings and per-language text drafts. Options are matched by index.
const TEXT_FIELDS={version:'admin-ann-version',title:'admin-ann-title',subtitle:'admin-ann-subtitle',placeholder:'admin-feedback-placeholder',body:'admin-message-body',notes:'admin-ann-notes',primaryLabel:'admin-popup-cta',secondaryLabel:'admin-popup-secondary',linkLabel:'admin-popup-link-label'};
let editorLanguage=language;
const languageDrafts={};
function popupDefaults(type,code){return C18.withLanguage(code,()=>({
  version:C18.t({poll:'Sondage',feedback:'Retour',message:'Info',update:APP_VERSION}[type]),
  title:C18.t({poll:'Votre avis sur Cadenza',feedback:'Vos idées & retours',message:"Message de l'équipe Cadenza",update:'Nouveautés sur Cadenza'}[type]),
  subtitle:C18.t({poll:'Quelle option préférez-vous ?',feedback:'Aidez-nous à améliorer Cadenza :',message:'Information importante :',update:'Découvrez les dernières améliorations :'}[type])
}));}
function newLanguageDraft(code){const d=popupDefaults(state.adminPopupType,code);return {...d,subtitle:'',placeholder:'',body:'',notes:'',primaryLabel:'',secondaryLabel:'',linkLabel:'',options:C18.withLanguage(code,()=>['Oui, tout à fait','Plutôt oui','Non, pas besoin'].map(x=>C18.t(x))),titleTouched:false,badgeTouched:false};}
function selectedLanguages(){return [...document.querySelectorAll('[data-campaign-language]:checked')].map(el=>el.value);}
function saveEditorDraft(){
  const d=languageDrafts[editorLanguage]||newLanguageDraft(editorLanguage);
  for(const [key,id] of Object.entries(TEXT_FIELDS))d[key]=$(id).value;
  d.titleTouched=Boolean($('admin-ann-title').dataset.touched);d.badgeTouched=Boolean($('admin-ann-version').dataset.touched);
  d.options=[...state.adminPollOptions];languageDrafts[editorLanguage]=d;
}
function loadEditorDraft(code){
  editorLanguage=code;const d=languageDrafts[code]||=newLanguageDraft(code);
  for(const [key,id] of Object.entries(TEXT_FIELDS))$(id).value=d[key]||'';
  for(const [id,touched] of [['admin-ann-title',d.titleTouched],['admin-ann-version',d.badgeTouched]]){if(touched)$(id).dataset.touched='1';else delete $(id).dataset.touched;}
  state.adminPollOptions=[...d.options];
  $('admin-ann-subtitle').placeholder=popupDefaults(state.adminPopupType,code).subtitle;
  renderAdminPollOptionsBuilder();renderLanguageTabs();renderLivePreview();
}
function changeEditorLanguage(code){saveEditorDraft();loadEditorDraft(code);}
function renderLanguageTabs(){
  const langs=selectedLanguages();
  const tabs=$('admin-content-language-tabs');
  if([...tabs.children].map(b=>b.dataset.editLanguage).join(',')!==langs.join(','))tabs.innerHTML=langs.map(code=>`<button type="button" role="tab" data-edit-language="${code}" class="admin-content-lang"></button>`).join('');
  for(const b of tabs.children){const code=b.dataset.editLanguage;const active=editorLanguage===code;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));const text=LANG_NAMES[code]+(variantError(languageDrafts[code]||newLanguageDraft(code),state.adminPopupType)?' · ○':' · ✓');if(b.textContent!==text)b.textContent=text;}
  $('admin-editing-language').textContent=LANG_NAMES[editorLanguage];
  $('admin-preview-language').textContent=LANG_NAMES[editorLanguage];
}
function syncSelectedLanguages(){const langs=selectedLanguages();if(langs.length&&!langs.includes(editorLanguage))changeEditorLanguage(langs[0]);else{saveEditorDraft();renderLanguageTabs();renderLivePreview();}}
function variantError(d,type){
  if(!d.title.trim())return 'Indiquez un titre.';
  if(type==='poll'&&(d.options.length<2||d.options.some(o=>!o.trim())))return 'Complétez tous les choix de vote dans cette langue.';
  if(type==='feedback'&&!d.subtitle.trim())return 'Indiquez la question posée aux utilisateurs.';
  if(type==='message'&&!d.body.trim())return 'Écrivez le contenu du message à afficher.';
  if(type==='update'&&!noteItems(d.notes).length)return 'Ajoutez au moins une nouveauté.';
  return '';
}
function noteItems(value){return value.split("\n").map(l=>l.replace(/^[-•*✓]\s*/, '').trim()).filter(Boolean);}
function buildVariant(d,type,code){return C18.withLanguage(code,()=>{
  const defaults=popupDefaults(type,code);
  const design={primaryLabel:d.primaryLabel.trim(),secondaryLabel:d.secondaryLabel.trim(),linkLabel:d.linkLabel.trim()};
  const result={version:d.version.trim()||defaults.version,title:d.title.trim()||defaults.title,subtitle:d.subtitle.trim(),design};
  if(type==='poll'){result.subtitle||=C18.t('Faites votre choix ci-dessous :');result.options=d.options.map((o,i)=>o.trim()||C18.t('Option {0}',i+1));}
  if(type==='feedback')result.placeholder=d.placeholder.trim()||C18.t('Écrivez votre retour ou suggestion ici...');
  if(type==='message'){result.body=d.body.trim()||C18.t('Votre message apparaîtra ici.');result.ctaLabel=design.primaryLabel||C18.t("J'ai compris, fermer");}
  if(type==='update'){result.subtitle||=C18.t('Découvrez les dernières améliorations :');result.items=noteItems(d.notes);if(!result.items.length)result.items=[C18.t('Votre nouveauté apparaîtra ici.')];}
  return result;
});}
function getDesign(){return {theme:$("admin-popup-theme").value,icon:$("admin-popup-icon").value,layout:$("admin-popup-layout").value,showBadge:$("admin-popup-show-badge").checked,showDate:$("admin-popup-show-date").checked,link:safeLink($("admin-popup-link").value.trim())};}
export function buildAdminAnnouncementPayload(id, draft=false) {
  saveEditorDraft();const type=state.adminPopupType,design=getDesign(),languages=selectedLanguages();
  const start=$('admin-start-at').value,end=$('admin-end-at').value;
  const startsAt=start?new Date(start).getTime():null,endsAt=end?new Date(end).getTime():null;
  if(!draft){
    if(!languages.length){showToast(C18.t('Sélectionnez au moins une langue.'));return null;}
    if($('admin-popup-link').value.trim()&&!design.link){showToast(C18.t('Indiquez un lien HTTPS valide.'));return null;}
    if((start&&!Number.isFinite(startsAt))||(end&&!Number.isFinite(endsAt))||(endsAt!==null&&endsAt<=Math.max(Date.now(),startsAt||0))){showToast(C18.t('La fin doit être postérieure au début et à maintenant.'));return null;}
    for(const code of languages){const error=variantError(languageDrafts[code],type);if(error){loadEditorDraft(code);showToast(`${LANG_NAMES[code]} : ${C18.t(error)}`);return null;}}
  }
  const codes=draft?[editorLanguage]:languages;
  const localized=Object.fromEntries(codes.map(code=>[code,buildVariant(languageDrafts[code],type,code)]));
  const primary=localized[codes.includes(language)?language:codes[0]];
  const payload={...primary,design:{...design,...primary.design},id,active:true,type,localized,languages:codes,audience:'ensemble-members',trackViews:true,publishedAt:Date.now(),...(type==='poll'?{allowComment:$('admin-poll-allow-comment').checked}:{}),...(Number.isFinite(startsAt)?{startsAt}:{}),...(Number.isFinite(endsAt)?{endsAt}:{})};
  return draft?localizedCampaign(payload,editorLanguage):payload;
}

// Affichage de la pop-up côté utilisateur (Mise à jour, Sondage, Avis ou Message libre)
export function showWhatsNewModal(ann, isPreview = false) {
  if (!ann || (!isPreview&&!eligibleForAnnouncement())) return;
  ann=ann.displayLanguage?ann:localizedCampaign(ann,language);
  state.isPreviewingWhatsNew = isPreview;
  state.currentRenderedPopupData = ann;
  state.displayedAnnouncementId = ann.id || null;
  state.selectedUserPollOptionIndex = null;

  C18.withLanguage(ann.displayLanguage||language,()=>renderPopupContent(ann, $("modal-whats-new").querySelector('.modal-sheet'), $, isPreview, isPreview?previewQueue:userAnnouncements()));
  $("modal-whats-new").classList.add("open");
  $("modal-whats-new").querySelector(".modal-sheet").scrollTop=0;
  if(!isPreview)recordView(ann);
}

function renderPopupContent(ann,sheet,part,isPreview=false,active=[]){
  const position=active.findIndex(a=>a.id===ann.id), progress=part('whats-new-progress');
  progress.classList.toggle('hidden',active.length<2||position<0);
  progress.textContent=C18.t('Information {0} sur {1}',position+1,active.length);
  part('btn-close-whats-new-top').textContent=C18.t('Fermer');
  const design=ann.design||{};
  const theme=THEMES.includes(design.theme)?design.theme:'blue';
  sheet.dataset.popupTheme=theme; sheet.dataset.popupLayout=design.layout==='center'?'center':'left';
  const icon=part('whats-new-icon'); icon.textContent=Object.hasOwn(ICONS,design.icon)?ICONS[design.icon]:''; icon.classList.toggle('hidden',!icon.textContent);
  part('whats-new-version-badge').classList.toggle('hidden',design.showBadge===false);
  const pType = ann.type || "update";
  part("whats-new-title").textContent = ann.title || "Cadenza";
  part("whats-new-version-badge").textContent = ann.version ? (isPreview ? C18.tt`Aperçu • ${ann.version}` : ann.version) : (isPreview ? C18.t("Aperçu") : C18.t("Information"));

  const subEl = part("whats-new-subtitle");
  if (ann.subtitle) {
    subEl.textContent = ann.subtitle;
    subEl.classList.remove("hidden");
  } else {
    subEl.classList.add("hidden");
  }

  const dEl = part("whats-new-date");
  if (ann.publishedAt && design.showDate!==false) {
    dEl.textContent = new Date(ann.publishedAt).toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
    dEl.classList.remove("hidden");
  } else dEl.classList.add("hidden");

  const bodyEl = part("whats-new-dynamic-body");
  const footerEl = part("whats-new-footer-actions");

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

  const primary=footerEl.querySelector('#btn-submit-user-popup-response')||footerEl.querySelector('#btn-skip-user-popup');
  if(primary&&design.primaryLabel)primary.textContent=design.primaryLabel;
  const secondary=footerEl.querySelector('#btn-submit-user-popup-response')&&footerEl.querySelector('#btn-skip-user-popup');
  if(secondary&&design.secondaryLabel)secondary.textContent=design.secondaryLabel;
  const href=safeLink(design.link);if(href){const a=document.createElement('a');a.href=href;a.target='_blank';a.rel='noopener noreferrer';a.className='popup-extra-link';a.textContent=design.linkLabel||C18.t('En savoir plus');footerEl.append(a);}
}
function renderLivePreview(){
  const box=$('admin-live-preview');if(!box)return;
  const ann=buildAdminAnnouncementPayload('live-preview',true);if(!ann)return;
  const sheet=$('modal-whats-new').querySelector('.modal-sheet').cloneNode(true);
  sheet.classList.add('popup-preview-sheet');
  sheet.querySelectorAll('[id]').forEach(el=>{el.dataset.previewPart=el.id;el.removeAttribute('id');});
  const part=id=>sheet.querySelector(`[data-preview-part="${id}"]`);
  C18.withLanguage(editorLanguage,()=>renderPopupContent(ann,sheet,part,false,[]));
  sheet.querySelectorAll('[id]').forEach(el=>el.removeAttribute('id'));
  sheet.querySelectorAll('[for]').forEach(el=>el.removeAttribute('for'));
  box.replaceChildren(sheet);renderLanguageTabs();
}
function eligibleForAnnouncement(){
  const id=state.session.activeEnsembleId,member=state.session.ensembles[id]?.memberId;
  return Boolean(id&&member&&state.verifiedPopupEnsembleId===id&&state.currentEnsembleData?.members?.[member]&&!$('app-header').classList.contains('hidden')&&$('view-onboarding').classList.contains('hidden')&&$('view-install-tuto').classList.contains('hidden'));
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
  if(!eligibleForAnnouncement()){
    if($('modal-whats-new').classList.contains('open')&&!state.isPreviewingWhatsNew){
      closeModal('modal-whats-new');state.displayedAnnouncementId=null;state.currentRenderedPopupData=null;
    }return;
  }
  if(document.visibilityState!=='visible')return;
  if($('modal-whats-new').classList.contains('open')&&!state.isPreviewingWhatsNew){
    if(popupSubmitting)return;
    if(userAnnouncements().some(a=>a.id===state.displayedAnnouncementId)){recordView(state.currentRenderedPopupData);return;}
    closeModal('modal-whats-new');state.displayedAnnouncementId=null;state.currentRenderedPopupData=null;
  }
  if(adminPublishing||popupSubmitting||document.querySelector('.modal-backdrop.open'))return;
  const seen=seenAnnouncements(), next=userAnnouncements().find(a=>!seen.has(a.id));
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
  for(const a of active)campaignsMap[a.id]={...(campaignsMap[a.id]||{}),meta:a};

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
    const count = Object.keys(c.views || {}).length;
    const tLabel = POPUP_TYPE_META[c.meta.type]?.label || C18.t("Campagne");
    const isCurrent = active.some(a=>a.id===c.meta.id&&campaignStatus(a)!=='expired');
    return `<option value="${esc(c.meta.id)}" ${c.meta.id === state.selectedResultsCampaignId ? "selected" : ""}>[${esc(tLabel)}] ${esc(localizedCampaign(c.meta).title || C18.t("Sans titre"))} · ${esc(C18.t("{0} consultations uniques",c.meta.trackViews?count:"—"))}${isCurrent ? " · "+esc(statusLabel(c.meta)) : ""}</option>`;
  }).join("");

  const activeCamp = campaignsMap[state.selectedResultsCampaignId] || campaigns[0];
  const meta = localizedCampaign(activeCamp.meta || {});
  const responses = Object.values(activeCamp.responses || {}).sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

  $("res-campaign-badge").textContent = `${POPUP_TYPE_META[meta.type]?.label || C18.t("Campagne")}${meta.version ? ` • ${meta.version}` : ""}`;
  $("res-campaign-title").textContent = meta.title || C18.t("Sondage");
  $("res-campaign-subtitle").textContent = meta.subtitle || "";
  $("res-total-count").textContent = C18.t(responses.length === 1 ? "{0} réponse" : "{0} réponses", responses.length);
  const views=Object.values(activeCamp.views||{}), tracked=Boolean(meta.trackViews||views.length), readable=!state.feedbackPermissionDenied;
  $('res-views-total').textContent=tracked&&readable?views.length:'—';
  $('res-views-languages').innerHTML=LANGS.map(l=>`<div><span>${LANG_NAMES[l]}</span><strong>${tracked&&readable?views.filter(v=>v?.language===l).length:'—'}</strong></div>`).join('');
  $('res-views-note').textContent=C18.t(!tracked?'Historique : les consultations n’étaient pas encore mesurées.':'Une consultation par appareil ou navigateur, sans compter les aperçus admin.');
  $('res-campaign-distribution').textContent=`${campaignLanguages(meta).map(l=>LANG_NAMES[l]||l).join(' · ')} | ${periodLabel(meta)}`;
  $('res-comments-card').classList.toggle('hidden',!['poll','feedback'].includes(meta.type));

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

  const search=$('admin-ensemble-search').value.trim().toLocaleLowerCase(locale);
  const sourceList = search?allEnsembles.filter(e=>[e.name,e.id,e.formation,...e.members.map(m=>`${m.name} ${m.instrument||''}`)].some(v=>String(v||'').toLocaleLowerCase(locale).includes(search))):(activeEnsembles.length > 0 ? activeEnsembles : allEnsembles);
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
  }).join("") || `<p class="admin-muted">${esc(C18.t("Aucun résultat."))}</p>`;

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
  for(const code of LANGS)languageDrafts[code]=newLanguageDraft(code);
  loadEditorDraft(editorLanguage);
  $('admin-content-language-tabs').addEventListener('click',e=>{const b=e.target.closest('[data-edit-language]');if(b)changeEditorLanguage(b.dataset.editLanguage);});
  document.querySelectorAll('[data-campaign-language]').forEach(el=>el.addEventListener('change',syncSelectedLanguages));
  $('form-admin-announcement').addEventListener('input',()=>queueMicrotask(renderLivePreview));
  $('form-admin-announcement').addEventListener('change',()=>{queueMicrotask(renderLivePreview);refreshAdminAnnouncementStatusUI();});
  $('admin-select-languages').addEventListener('click',()=>{document.querySelectorAll('[data-campaign-language]').forEach(el=>el.checked=true);syncSelectedLanguages();});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){refreshAdminAnnouncementStatusUI();scheduleRefresh();maybeDisplayLatestAnnouncement();}});
  window.addEventListener('online',maybeDisplayLatestAnnouncement);
  $('admin-ensemble-search').addEventListener('input',()=>{state.showAllRecentEnsembles=false;renderAdminStatsPanel();});
  // Defer announcements until another modal is closed, without interrupting a task.
  const observer=new MutationObserver(()=>maybeDisplayLatestAnnouncement());
  document.querySelectorAll('.modal-backdrop').forEach(el=>observer.observe(el,{attributes:true,attributeFilter:['class']}));
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
    saveEditorDraft();for(const d of Object.values(languageDrafts))d.options.splice(Number(del.dataset.delOpt),1);
    state.adminPollOptions=[...languageDrafts[editorLanguage].options];
    renderAdminPollOptionsBuilder();renderLivePreview();
  });

  $("btn-admin-add-option").addEventListener("click", () => {
    haptic();
    saveEditorDraft();for(const d of Object.values(languageDrafts))d.options.push("");
    state.adminPollOptions=[...languageDrafts[editorLanguage].options];
    renderAdminPollOptionsBuilder();renderLivePreview();
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

    if(!eligibleForAnnouncement()||!userAnnouncements().some(a=>a.id===ann.id))return maybeDisplayLatestAnnouncement();
    submitBtn.disabled = true; popupSubmitting=true;
    const voterId = getVoterDeviceId();
    const optionLabel = pType === "poll" ? (ann.options?.[state.selectedUserPollOptionIndex] || "") : "";

    try {
      await update(ref(db, `app_feedback/${ann.id}`), {
        meta: canonicalCampaign(ann),
        [`responses/${voterId}`]: {
          voterId,
          language,
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
    scheduleRefresh();
    refreshAdminAnnouncementStatusUI();
    if(state.adminActiveTab==="results"&&$("modal-admin-portal").classList.contains("open"))renderAdminResultsPanel();
    maybeDisplayLatestAnnouncement();
  }, () => {});

  onValue(ref(db, "app_feedback"), (snap) => {
    state.feedbackPermissionDenied = false;
    state.allFeedbackCampaigns = snap.exists() ? (snap.val() || {}) : {};
    updateAdminResultsBadge();
    refreshAdminAnnouncementStatusUI();
    if (state.adminActiveTab === "results" && $("modal-admin-portal").classList.contains("open")) {
      renderAdminResultsPanel();
    }
  }, (err) => {
    if (String(err?.message || "").toLowerCase().includes("permission") || err?.code === "PERMISSION_DENIED") {
      state.feedbackPermissionDenied = true;
      refreshAdminAnnouncementStatusUI();
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
    if(availableAnnouncements().some(a=>a.id===state.selectedResultsCampaignId))return showToast(C18.t("Désactivez la campagne avant de supprimer ses résultats."));
    const campId = state.selectedResultsCampaignId;
    openConfirmationModal({
      title: C18.t("Supprimer ces résultats ?"),
      context: $("res-campaign-title").textContent,
      message: C18.t("Les consultations, votes et commentaires de cette campagne seront définitivement effacés."),
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
    const payload = buildAdminAnnouncementPayload("preview",true);
    if (!payload) return;
    previewQueue=[];showWhatsNewModal(payload, true);
  });

  $('form-admin-announcement').addEventListener('submit',async e=>{
    e.preventDefault();haptic();if(adminPublishing)return;
    if(!state.verifiedAdminPin){closeModal('modal-admin-portal');return openAdminPinPrompt();}
    const newId=genId('ann'),payload=buildAdminAnnouncementPayload(newId);if(!payload)return;
    adminPublishing=true;refreshAdminAnnouncementStatusUI();
    try{
      const items=(await readActiveAnnouncements()).filter(a=>campaignStatus(a)!=='expired');
      await saveAnnouncements([...items,payload]);
      // Publisher has already read the new message; preview is available in the portal.
      markSeen(newId);
      state.selectedResultsCampaignId=newId;
      try{await set(ref(db,`app_feedback/${newId}/meta`),payload);showToast(C18.t(campaignStatus(payload)==='scheduled'?'Pop-up programmée !':'Pop-up publiée pour les membres !'));}
      catch(err){showToast(C18.t('Pop-up enregistrée, mais statistiques non accessibles. Vérifiez Firebase.'));}
    }catch(_){$('admin-firebase-warning').classList.remove('hidden');showToast(C18.t('Accès refusé par Firebase.'));}
    finally{adminPublishing=false;refreshAdminAnnouncementStatusUI();maybeDisplayLatestAnnouncement();}
  });
  $('btn-admin-retest-popup').addEventListener('click',()=>{
    previewQueue=availableAnnouncements().map(a=>localizedCampaign(a,campaignLanguages(a).includes(language)?language:campaignLanguages(a)[0]));if(!previewQueue.length)return;
    showWhatsNewModal(previewQueue[0],true);
  });
  const deactivate=async id=>{
    if(adminPublishing)return;haptic();
    if(!state.verifiedAdminPin){closeModal('modal-admin-portal');return openAdminPinPrompt();}
    adminPublishing=true;refreshAdminAnnouncementStatusUI();
    try{const items=(await readActiveAnnouncements()).filter(a=>campaignStatus(a)!=='expired');await saveAnnouncements(id?items.filter(a=>a.id!==id):[]);showToast(C18.t(id?'La pop-up a été désactivée.':'Les pop-up ont été désactivées.'));}
    catch(_){$('admin-firebase-warning').classList.remove('hidden');showToast(C18.t('Accès refusé par Firebase.'));}
    finally{adminPublishing=false;refreshAdminAnnouncementStatusUI();maybeDisplayLatestAnnouncement();}
  };
  $('admin-current-announcement').addEventListener('click',e=>{const b=e.target.closest('[data-admin-deactivate]');if(b)deactivate(b.dataset.adminDeactivate);});
  $('btn-admin-clear-announcement').addEventListener('click',()=>deactivate(null));

  $("btn-close-whats-new-top").addEventListener("click", dismissWhatsNewModal);
}
