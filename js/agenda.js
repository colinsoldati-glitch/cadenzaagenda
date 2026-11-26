import { locale, language, localizeFormation, localizePeriod } from "./i18n.js";
import * as C18 from "./i18n.js";
import {
  db, ref, set, update, remove,
  state, $, haptic, genId, esc, getEventMeta,
  showToast, handleFirebaseError, formatDateFr
} from "./config.js";
import {
  setEventTypeValue, syncConcertFieldsVisibility, readConcertFields, populateConcertFields,
  openConfirmationModal, openModal, closeModal
} from "./ui.js";

let hooks = {
  publishEnsembleNotification: async () => {},
  switchTab: () => {}
};

export function registerAgendaHooks(h) {
  hooks = { ...hooks, ...h };
}

// Agenda : prochain événement, chronologie par mois, filtres et détails dépliables.
const tr = (key,...args)=>esc(C18.t(key,...args));
let agendaScope=null, agendaFilter='all', agendaPast=false, agendaExpanded=new Set();
const localDate = (d=new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
function agendaTile(iso){const d=new Date(iso+'T12:00:00');return `<div class="smart-date"><span>${esc(d.toLocaleDateString(locale,{weekday:'short'}))}</span><strong>${d.getDate()}</strong><span>${esc(d.toLocaleDateString(locale,{month:'short'}))}</span></div>`;}
function relativeDay(iso,today){const days=Math.round((Date.parse(iso+'T00:00:00Z')-Date.parse(today+'T00:00:00Z'))/86400000);return days===0?C18.t('Aujourd’hui'):days===1?C18.t('Demain'):days>1?C18.t('Dans {0} jours',days):'';}
function agendaCard(r,isNext,isPast,today){
  const meta=getEventMeta(r.eventType), expanded=agendaExpanded.has(r.id), concert=r.eventType==='concert';
  const more=expanded||isNext;
  const details=[concert&&r.soundcheckTime?`<div><strong>${tr('Raccord :')}</strong> ${esc(r.soundcheckTime)}</div>`:'',concert&&r.dressCode?`<div><strong>${tr('Tenue :')}</strong> ${esc(r.dressCode)}</div>`:'',concert&&r.concertFee?`<div><strong>${tr('Cachet / Tarif :')}</strong> ${esc(r.concertFee)}</div>`:''].filter(Boolean).join('');
  return `<article class="card agenda-event ${meta.cardCls} ${isNext?'agenda-next':''} ${isPast?'agenda-past':''}">${isNext?`<div class="agenda-next-label"><span>● ${tr('Prochain événement')}</span><span>${esc(relativeDay(r.date,today))}</span></div>`:''}<div class="agenda-event-main">${agendaTile(r.date)}<div class="agenda-event-info"><div class="agenda-event-type ${meta.badgeCls}">${esc(meta.label)}</div><div class="agenda-location"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg><strong>${esc(C18.localizeLocation(r.location||'Lieu à confirmer'))}</strong></div><strong class="agenda-time">${esc(r.startTime)} – ${esc(r.endTime)}</strong>${!isNext&&r.program?`<small class="agenda-program-preview">${esc(r.program)}</small>`:''}</div><button type="button" class="smart-icon" data-expand-reh="${esc(r.id)}" aria-label="${tr('Détails de l’événement')}" aria-expanded="${expanded}">${expanded?'⌃':'⌄'}</button></div>${more?`<div class="agenda-event-detail">${details?`<div class="concert-details-grid">${details}</div>`:''}${r.program?`<div class="agenda-program program-lines"><strong>${tr('Programme :')}</strong><div>${esc(r.program)}</div></div>`:''}${r.notes?`<div class="agenda-notes">${esc(r.notes)}</div>`:''}${isNext&&!expanded?`<button type="button" class="btn-secondary btn-full" data-ics="${esc(r.id)}">${tr('Ajouter à mon calendrier')}</button>`:''}</div>`:''}${expanded?`<div class="agenda-actions">${!isPast?`<button type="button" class="btn-secondary" data-ics="${esc(r.id)}">${tr('Calendrier (.ics)')}</button>`:''}<button type="button" class="btn-secondary" data-edit-reh="${esc(r.id)}">${tr('Modifier')}</button><button type="button" class="btn-del-subtle" data-del-reh="${esc(r.id)}">${tr(isPast?'Supprimer':'Annuler')}</button></div>`:''}</article>`;
}
function monthGroups(list,isPast,today){const groups=new Map();list.forEach(r=>{const key=r.date.slice(0,7);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);});return [...groups.entries()].map(([key,rs])=>`<section class="agenda-month"><h3>${esc(new Date(key+'-01T12:00:00').toLocaleDateString(locale,{month:'long',year:'numeric'}))}</h3>${rs.map(r=>agendaCard(r,false,isPast,today)).join('')}</section>`).join('');}
export function renderAgenda(){
  if(!state.currentEnsembleData)return;
  if(agendaScope!==state.session.activeEnsembleId){agendaScope=state.session.activeEnsembleId;agendaFilter='all';agendaPast=false;agendaExpanded.clear();}
  const container=$('agenda-list'), controls=$('agenda-controls'), today=localDate(), now=new Date(), time=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const list=Object.values(state.currentEnsembleData.rehearsals||{}).sort((a,b)=>`${a.date}T${a.startTime}`.localeCompare(`${b.date}T${b.startTime}`));
  const upcoming=list.filter(r=>r.date>today||(r.date===today&&(!r.endTime||r.endTime>=time))), past=list.filter(r=>!upcoming.includes(r)).reverse();
  const type=r=>r.eventType||'rehearsal', matches=r=>agendaFilter==='all'||type(r)===agendaFilter;
  const filtered=upcoming.filter(matches), old=past.filter(matches);
  const count=upcoming.length;
  controls.innerHTML=`<div class="agenda-summary"><div><strong>${count}</strong><small>${tr('Événements à venir')}</small></div><div><strong>${upcoming.filter(r=>r.date.slice(0,7)===today.slice(0,7)).length}</strong><small>${tr('Ce mois-ci')}</small></div><button type="button" class="btn-secondary" data-go-avail>${tr('Disponibilités')} →</button></div><div class="agenda-filters" role="group" aria-label="${tr('Type d’événement')}">${[['all','Tous'],['rehearsal','Répétitions'],['cours','Cours'],['concert','Concerts']].map(([k,label])=>`<button type="button" class="filter-pill ${agendaFilter===k?'active':''}" data-agenda-filter="${k}" aria-pressed="${agendaFilter===k}">${tr(label)}</button>`).join('')}</div>`;
  const hero=filtered[0];
  container.innerHTML=(hero?agendaCard(hero,true,false,today)+monthGroups(filtered.slice(1),false,today):`<div class="empty-state"><p>${tr(agendaFilter==='all'?'Aucun événement à venir.':'Aucun événement de ce type à venir.')}</p><button type="button" class="btn-primary" data-go-avail>${tr('Proposer des disponibilités')}</button></div>`)+(old.length?`<section class="agenda-history"><button type="button" class="smart-section-head" data-toggle-past aria-expanded="${agendaPast}"><span>◷</span><strong>${tr('Événements passés')}</strong><span class="smart-count">${old.length}</span><span>${agendaPast?'⌃':'⌄'}</span></button>${agendaPast?monthGroups(old,true,today):''}</section>`:'');
}

export function downloadICS(reh) {
  if (!reh) return;
  haptic();
  const tMeta = getEventMeta(reh.eventType);
  const fmt = (d, t) => `${d.replace(/-/g, "")}T${t.replace(":", "")}00`;
  const icsEscape = value=>String(value??'').replace(/\\/g,"\\\\").replace(/\r\n|\r|\n/g,"\\n").replace(/;/g,"\\;").replace(/,/g,"\\,");
  const desc = [
    reh.soundcheckTime ? C18.tt`Raccord sur place : ${reh.soundcheckTime}` : "",
    reh.dressCode ? C18.tt`Tenue de scène : ${reh.dressCode}` : "",
    reh.concertFee ? C18.tt`Cachet / Billetterie : ${reh.concertFee}` : "",
    reh.program ? C18.tt`Programme : ${reh.program}` : "",
    reh.notes || ""
  ].filter(Boolean).join("\n");
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Cadenza//FR", "BEGIN:VEVENT", `UID:${reh.id}@cadenza.app`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z`, `DTSTART:${fmt(reh.date, reh.startTime)}`, `DTEND:${fmt(reh.date, reh.endTime)}`, `SUMMARY:${icsEscape(tMeta.label+" — "+state.currentEnsembleData.name)}`, `LOCATION:${icsEscape(reh.location)}`, `DESCRIPTION:${icsEscape(desc)}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" })), download: `cadenza-${reh.date}.ics` });
  a.click(); URL.revokeObjectURL(a.href); showToast(C18.t("Fichier calendrier (.ics) téléchargé."));
}

export function initAgendaListeners() {
  $("agenda-controls").addEventListener("click",e=>{const b=e.target.closest('button');if(!b)return;if(b.hasAttribute('data-go-avail'))return hooks.switchTab('avail');if(b.dataset.agendaFilter){agendaFilter=b.dataset.agendaFilter;return renderAgenda();}});
  $("agenda-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if(btn.hasAttribute('data-toggle-past')){agendaPast=!agendaPast;return renderAgenda();}
    if(btn.dataset.expandReh){const id=btn.dataset.expandReh;agendaExpanded.has(id)?agendaExpanded.delete(id):agendaExpanded.add(id);return renderAgenda();}
    if (btn.hasAttribute("data-go-avail")) return hooks.switchTab("avail");
    const rehObj = state.currentEnsembleData?.rehearsals || {};
    if (btn.dataset.ics) return downloadICS(rehObj[btn.dataset.ics]);
    if (btn.dataset.editReh) {
      const r = rehObj[btn.dataset.editReh]; if (!r) return;
      const type = r.eventType || "rehearsal";
      setEventTypeValue($("edit-reh-type-holder"), type, (t) => syncConcertFieldsVisibility("edit-reh", t, "lbl-edit-reh-start", "lbl-edit-reh-end"));
      $("modal-edit-reh-title").textContent = type === "concert" ? C18.t("Modifier le concert") : type === "cours" ? C18.t("Modifier le cours") : C18.t("Modifier la répétition");
      $("edit-reh-id").value = r.id; $("edit-reh-date").value = r.date || "";
      $("edit-reh-start").value = r.startTime || "14:00"; $("edit-reh-end").value = r.endTime || "17:00";
      populateConcertFields("edit-reh", r);
      $("edit-reh-location").value = r.location || ""; $("edit-reh-program").value = r.program || ""; $("edit-reh-notes").value = r.notes || "";
      return openModal("modal-edit-rehearsal");
    }
    if (btn.dataset.delReh) {
      const r = rehObj[btn.dataset.delReh]; if (!r) return;
      const tMeta = getEventMeta(r.eventType);
      openConfirmationModal({
        title: C18.tt`Supprimer ce ${tMeta.label.toLowerCase()} ?`,
        context: `${tMeta.label} • ${formatDateFr(r.date)} • ${r.startTime}–${r.endTime} (${r.location})`,
        message: C18.t("Cet événement sera retiré de l'agenda de tout l'ensemble."),
        confirmLabel: C18.t("Supprimer"),
        onConfirm: async () => {
          try { await remove(ref(db, `ensembles/${state.session.activeEnsembleId}/rehearsals/${r.id}`)); showToast(C18.tt`${tMeta.label} retiré(e) de l'agenda.`); }
          catch (err) { handleFirebaseError(err); }
        }
      });
    }
  });

  $("form-edit-rehearsal").addEventListener("submit", async (e) => {
    e.preventDefault(); haptic();
    const rehId = $("edit-reh-id").value, date = $("edit-reh-date").value, startTime = $("edit-reh-start").value, endTime = $("edit-reh-end").value;
    const eventType = $("edit-reh-type-holder").dataset.value || "rehearsal";
    const concertData = readConcertFields("edit-reh", eventType);
    const location = $("edit-reh-location").value.trim(), program = $("edit-reh-program").value.trim(), notes = $("edit-reh-notes").value.trim();
    if (!rehId || !state.session.activeEnsembleId) return;
    if(!date||!startTime||!endTime||endTime<=startTime||!location)return showToast(C18.t("Vérifiez la date, les horaires et le lieu."));
    try {
      await update(ref(db, `ensembles/${state.session.activeEnsembleId}/rehearsals/${rehId}`), {
        eventType, date, startTime, endTime, ...concertData, location, program, notes, updatedAt: Date.now()
      });
      await hooks.publishEnsembleNotification(C18.localizedMessages(() => [C18.tt`${getEventMeta(eventType).label} modifié(e) — ${state.currentEnsembleData?.name || "Cadenza"}`, `${formatDateFr(date)} • ${startTime}–${endTime} • ${location}`]));
      closeModal("modal-edit-rehearsal"); showToast(C18.t("Agenda mis à jour."));
    } catch (err) { handleFirebaseError(err); }
  });

  $("form-rehearsal").addEventListener("submit", async (e) => {
    e.preventDefault(); haptic();
    const eventType = $("reh-type-holder").dataset.value || "rehearsal";
    const concertData = readConcertFields("reh", eventType);
    const date = $("reh-date").value, startTime = $("reh-start").value, endTime = $("reh-end").value;
    const location = $("reh-location").value.trim(), program = $("reh-program").value.trim(), notes = $("reh-notes").value.trim();
    const tMeta = getEventMeta(eventType);
    if(!date||!startTime||!endTime||endTime<=startTime||!location)return showToast(C18.t("Vérifiez la date, les horaires et le lieu."));
    try {
      const id = genId("reh");
      await set(ref(db, `ensembles/${state.session.activeEnsembleId}/rehearsals/${id}`), {
        id, eventType, date, startTime, endTime, ...concertData, location, program, notes, createdAt: Date.now()
      });
      await hooks.publishEnsembleNotification(C18.localizedMessages(() => [C18.tt`${tMeta.label} ajouté(e) — ${state.currentEnsembleData.name}`, `${formatDateFr(date)} • ${startTime}–${endTime} (${location})`]));
      $("form-rehearsal").reset(); closeModal("modal-rehearsal"); showToast(C18.tt`${tMeta.label} ajouté(e) à l'agenda.`); hooks.switchTab("agenda");
    } catch (err) { handleFirebaseError(err); }
  });

  const renderFormSummary=()=>{
    const a=$('reh-start').value,b=$('reh-end').value,d=$('reh-date').value;
    const mins=t=>{const [h,m]=t.split(':').map(Number);return h*60+m;};
    const valid=!!(a&&b&&b>a), duration=valid?mins(b)-mins(a):0;
    $('reh-duration').textContent=valid?C18.t('Durée : {0} h {1} min',Math.floor(duration/60),duration%60):C18.t('Indiquez une heure de fin postérieure à l’heure de début.');
    $('reh-end').setCustomValidity(valid?'':C18.t('Indiquez une heure de fin postérieure à l’heure de début.'));
    $('reh-form-summary').textContent=d&&valid?formatDateFr(d)+' · '+a+' – '+b:'';
  };
  $('form-rehearsal').addEventListener('input',renderFormSummary);
  $('form-rehearsal').addEventListener('change',renderFormSummary);
  $('form-rehearsal').addEventListener('click',e=>{const btn=e.target.closest('[data-reh-preset]');if(btn){const [a,b]=btn.dataset.rehPreset.split(',');$('reh-start').value=a;$('reh-end').value=b;renderFormSummary();}});
  $("btn-open-rehearsal").addEventListener("click", () => {openModal("modal-rehearsal");renderFormSummary();});
}
