import {
  db, ref, set, update, remove,
  state, $, haptic, genId, esc, getEventMeta,
  showToast, handleFirebaseError, formatDateFr
} from "./config.js";
import { t, getLang } from "./i18n.js";
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

// Rendu Agenda (Répétitions, Cours & Concerts)
export function renderAgenda() {
  const container = $("agenda-list"), rehObj = state.currentEnsembleData.rehearsals || {};
  const list = Object.values(rehObj).sort((a, b) => `${a.date}T${a.startTime}`.localeCompare(`${b.date}T${b.startTime}`));
  if (!list.length) {
    container.innerHTML = `<div class="empty-state"><p>${esc(t("agenda.empty"))}</p><button type="button" class="btn-secondary btn-sm" data-go-avail>${esc(t("agenda.emptyProposeBtn"))}</button></div>`;
    return;
  }
  const today = new Date().toISOString().split("T")[0];
  const upcoming = list.filter((r) => r.date >= today), past = list.filter((r) => r.date < today).reverse();

  const cardHtml = (r, isNext, isPast) => {
    const tMeta = getEventMeta(r.eventType);
    const isConcert = r.eventType === "concert";
    const concertInfos = [];
    if (isConcert && r.soundcheckTime) concertInfos.push(`<span class="concert-detail-item"><strong>${esc(t("concert.soundcheckShort"))} :</strong> ${esc(r.soundcheckTime)}</span>`);
    if (isConcert && r.dressCode) concertInfos.push(`<span class="concert-detail-item"><strong>${esc(t("concert.dressCodeShort"))} :</strong> ${esc(r.dressCode)}</span>`);
    if (isConcert && r.concertFee) concertInfos.push(`<span class="concert-detail-item"><strong>${esc(t("concert.feeShort"))} :</strong> ${esc(r.concertFee)}</span>`);

    const kickerHtml = isNext
      ? `<div class="card-kicker ${isConcert ? "concert" : r.eventType === "cours" ? "cours" : "emerald"}">${esc(tMeta.nextLabel)}</div>`
      : "";

    return `
    <article class="card ${isNext ? "featured" : ""} ${tMeta.cardCls}" ${isPast ? 'style="opacity:.72"' : ""}>
      ${kickerHtml}
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
        <h3 class="card-date" ${isPast ? 'style="font-size:16px"' : ""}>${esc(formatDateFr(r.date))}</h3>
        <span class="event-type-badge ${tMeta.badgeCls}">${esc(tMeta.label)}</span>
      </div>
      <div class="card-meta" style="margin-top:4px">${isPast ? `${esc(r.startTime)} – ${esc(r.endTime)} • ${esc(r.location)}` : `<span class="time-pill">${esc(r.startTime)} – ${esc(r.endTime)}</span> <strong>${esc(r.location)}</strong>`}</div>
      ${concertInfos.length ? `<div class="concert-details-grid">${concertInfos.join(" • ")}</div>` : ""}
      ${r.program ? `<div class="${isPast ? "card-meta" : "card-program"}">${isPast ? "" : `<strong>${esc(t("form.program"))} :</strong> `}${esc(r.program)}</div>` : ""}
      ${!isPast && r.notes ? `<div class="card-meta" style="margin-top:6px">${esc(r.notes)}</div>` : ""}
      <div class="card-actions">
        ${isPast ? "" : `<button type="button" class="btn-secondary btn-sm" data-ics="${esc(r.id)}">${esc(t("agenda.icsBtn"))}</button>`}
        <button type="button" class="btn-secondary ${isPast ? "btn-xs" : "btn-sm"}" data-edit-reh="${esc(r.id)}">${esc(t("common.edit"))}</button>
        <button type="button" class="btn-secondary ${isPast ? "btn-xs" : "btn-sm"}" data-del-reh="${esc(r.id)}">${esc(isPast ? t("common.delete") : t("common.cancel"))}</button>
      </div>
    </article>`;
  };

  container.innerHTML = upcoming.map((r, i) => cardHtml(r, i === 0, false)).join("")
    + (past.length ? `<div class="divider">${esc(t("agenda.pastDivider", { count: past.length }))}</div>${past.map((r) => cardHtml(r, false, true)).join("")}` : "");
}

export function downloadICS(reh) {
  if (!reh) return;
  haptic();
  const tMeta = getEventMeta(reh.eventType);
  const fmt = (d, tm) => `${d.replace(/-/g, "")}T${tm.replace(":", "")}00`;
  const desc = [
    reh.soundcheckTime ? `${t("concert.soundcheck")}: ${reh.soundcheckTime}` : "",
    reh.dressCode ? `${t("concert.dressCode")}: ${reh.dressCode}` : "",
    reh.concertFee ? `${t("concert.fee")}: ${reh.concertFee}` : "",
    reh.program ? `${t("form.program")}: ${reh.program}` : "",
    reh.notes || ""
  ].filter(Boolean).join("\\n");
  const langUpper = getLang().toUpperCase();
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:-//Cadenza//${langUpper}`, "BEGIN:VEVENT", `UID:${reh.id}@cadenza.app`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z`, `DTSTART:${fmt(reh.date, reh.startTime)}`, `DTEND:${fmt(reh.date, reh.endTime)}`, `SUMMARY:${tMeta.label} — ${state.currentEnsembleData.name}`, `LOCATION:${reh.location || ""}`, `DESCRIPTION:${desc}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" })), download: `cadenza-${reh.date}.ics` });
  a.click(); URL.revokeObjectURL(a.href); showToast(t("agenda.icsDownloadedToast"));
}

export function initAgendaListeners() {
  $("agenda-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.hasAttribute("data-go-avail")) return hooks.switchTab("avail");
    const rehObj = state.currentEnsembleData?.rehearsals || {};
    if (btn.dataset.ics) return downloadICS(rehObj[btn.dataset.ics]);
    if (btn.dataset.editReh) {
      const r = rehObj[btn.dataset.editReh]; if (!r) return;
      const type = r.eventType || "rehearsal";
      setEventTypeValue($("edit-reh-type-holder"), type, (tVal) => syncConcertFieldsVisibility("edit-reh", tVal, "lbl-edit-reh-start", "lbl-edit-reh-end"));
      $("modal-edit-reh-title").textContent = type === "concert" ? t("modal.editConcertTitle") : type === "cours" ? t("modal.editCoursTitle") : t("modal.editRehearsalTitle");
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
        title: t("agenda.deleteConfirmTitle", { type: tMeta.label.toLowerCase() }),
        context: `${tMeta.label} • ${formatDateFr(r.date)} • ${r.startTime}–${r.endTime} (${r.location})`,
        message: t("agenda.deleteConfirmMsg"),
        confirmLabel: t("common.delete"),
        onConfirm: async () => {
          try {
            await remove(ref(db, `ensembles/${state.session.activeEnsembleId}/rehearsals/${r.id}`));
            showToast(t("agenda.deletedToast", { type: tMeta.label }));
          } catch (err) { handleFirebaseError(err); }
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
    try {
      await update(ref(db, `ensembles/${state.session.activeEnsembleId}/rehearsals/${rehId}`), {
        eventType, date, startTime, endTime, ...concertData, location, program, notes, updatedAt: Date.now()
      });
      await hooks.publishEnsembleNotification(
        t("agenda.notifUpdatedTitle", { type: getEventMeta(eventType).label, ensemble: state.currentEnsembleData?.name || "Cadenza" }),
        `${formatDateFr(date)} • ${startTime}–${endTime} • ${location}`
      );
      closeModal("modal-edit-rehearsal"); showToast(t("agenda.updatedToast"));
    } catch (err) { handleFirebaseError(err); }
  });

  $("form-rehearsal").addEventListener("submit", async (e) => {
    e.preventDefault(); haptic();
    const eventType = $("reh-type-holder").dataset.value || "rehearsal";
    const concertData = readConcertFields("reh", eventType);
    const date = $("reh-date").value, startTime = $("reh-start").value, endTime = $("reh-end").value;
    const location = $("reh-location").value.trim(), program = $("reh-program").value.trim(), notes = $("reh-notes").value.trim();
    const tMeta = getEventMeta(eventType);
    try {
      const id = genId("reh");
      await set(ref(db, `ensembles/${state.session.activeEnsembleId}/rehearsals/${id}`), {
        id, eventType, date, startTime, endTime, ...concertData, location, program, notes, createdAt: Date.now()
      });
      await hooks.publishEnsembleNotification(
        t("agenda.notifAddedTitle", { type: tMeta.label, ensemble: state.currentEnsembleData.name }),
        `${formatDateFr(date)} • ${startTime}–${endTime} (${location})`
      );
      $("form-rehearsal").reset(); closeModal("modal-rehearsal");
      showToast(t("agenda.addedToast", { type: tMeta.label }));
      hooks.switchTab("agenda");
    } catch (err) { handleFirebaseError(err); }
  });

  $("btn-open-rehearsal").addEventListener("click", () => openModal("modal-rehearsal"));
}
