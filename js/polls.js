import { locale, language, localizeFormation, localizePeriod } from "./i18n.js";
import * as C18 from "./i18n.js";
import {
  db, ref, set, update, remove, runTransaction,
  state, $, haptic, genId, esc, getEventMeta,
  showToast, handleFirebaseError,
  parseIso, formatDateFr, formatCompactDateFr, formatShortDateFr,
  formatPollTimeLabel, formatVoteLabelFr, getPollSortKey,
  getSlotFingerprint, findArchivedSlotMatch, getUnavailabilityConflictsForDate
} from "./config.js";
import {
  setEventTypeValue, syncConcertFieldsVisibility, readConcertFields, populateConcertFields,
  buildModeSelectorHtml, applyModeState, bindModeSelector, renderMultiCalendar,
  openConfirmationModal, openModal, closeModal
} from "./ui.js";

let hooks = {
  publishEnsembleNotification: async () => {},
  switchTab: () => {}
};

export function registerPollsHooks(h) {
  hooks = { ...hooks, ...h };
}

// Archivage automatique, récupération & tri intelligent
export function isPollImpossibleAndComplete(poll, members) {
  if (!poll || !members?.length) return false;
  const v = poll.votes || {};
  return members.every((m) => Boolean(v[m.id])) && members.some((m) => v[m.id] === "no");
}

export async function archiveFailedPollsIfNeeded() {
  if (!state.session.activeEnsembleId || !state.currentEnsembleData || state.isAutoArchivingPolls) return;
  const members = Object.values(state.currentEnsembleData.members || {});
  const toArchive = Object.values(state.currentEnsembleData.polls || {}).filter((p) => isPollImpossibleAndComplete(p, members));
  if (!toArchive.length) return;

  state.isAutoArchivingPolls = true;
  try {
    const updates = {}, now = Date.now();
    toArchive.forEach((p) => {
      updates[`archivedPolls/${p.id}`] = {
        ...p, archivedAt: now, archiveReason: "complete_with_unavailability",
        unavailableMembers: members.filter((m) => p.votes?.[m.id] === "no").map((m) => m.name),
        slotFingerprint: getSlotFingerprint(p), lockedFromRelauch: true
      };
      updates[`polls/${p.id}`] = null;
    });
    await update(ref(db, `ensembles/${state.session.activeEnsembleId}`), updates);
    showToast(toArchive.length === 1
      ? C18.tt`Créneau du ${formatCompactDateFr(toArchive[0].date)} archivé (au moins une indisponibilité).`
      : C18.tt`${toArchive.length} créneaux avec indisponibilité archivés.`);
  } catch (e) { console.warn("Auto-archive:", e); }
  finally { state.isAutoArchivingPolls = false; }
}

export async function restoreArchivedPoll(archivedPoll) {
  if (!archivedPoll || !state.session.activeEnsembleId) return;
  const ensId = state.session.activeEnsembleId;
  const members = Object.values(state.currentEnsembleData?.members || {});
  const me = state.session.ensembles[ensId];
  const oldVotes = archivedPoll.votes || {};
  const oldNotes = archivedPoll.voteNotes || {};

  const keptVotes = {}, keptNotes = {}, resetMemberIds = [], resetMemberNames = [];
  members.forEach((m) => {
    const v = oldVotes[m.id];
    if (v === "yes" || v === "maybe") {
      keptVotes[m.id] = v;
      if (oldNotes[m.id]) keptNotes[m.id] = oldNotes[m.id];
    } else if (v === "no") {
      resetMemberIds.push(m.id);
      resetMemberNames.push(m.name);
    }
  });

  const restoredPoll = {
    id: archivedPoll.id,
    eventType: archivedPoll.eventType || "rehearsal",
    date: archivedPoll.date,
    timeMode: archivedPoll.timeMode || "day",
    period: archivedPoll.period || "",
    startTime: archivedPoll.startTime || "",
    endTime: archivedPoll.endTime || "",
    location: archivedPoll.location || "",
    note: archivedPoll.note || "",
    createdBy: archivedPoll.createdBy || me?.name || "",
    restoredAt: Date.now(),
    restoredBy: me?.name || "",
    ...(Object.keys(keptVotes).length ? { votes: keptVotes } : {}),
    ...(Object.keys(keptNotes).length ? { voteNotes: keptNotes } : {})
  };

  try {
    await update(ref(db, `ensembles/${ensId}`), {
      [`polls/${archivedPoll.id}`]: restoredPoll,
      [`archivedPolls/${archivedPoll.id}`]: null
    });

    const tMeta = getEventMeta(restoredPoll.eventType);
    const targetInfo = () => resetMemberNames.length
      ? C18.tt`${resetMemberNames.join(", ")} : le sondage est rouvert pour mettre à jour votre disponibilité.`
      : C18.t("Le créneau a été remis en sondage actif.");

    await hooks.publishEnsembleNotification(
      C18.localizedMessages(() => [C18.tt`Sondage rouvert (${tMeta.label}) — ${state.currentEnsembleData?.name || "Cadenza"}`, C18.tt`${me?.name || C18.t("Un membre")} a récupéré le ${formatDateFr(restoredPoll.date)}${formatPollTimeLabel(restoredPoll) ? ` (${formatPollTimeLabel(restoredPoll)})` : ""}. ${targetInfo()}`]),
      resetMemberIds.length ? { targetMemberIds: resetMemberIds } : {}
    );

    state.availFilterMode = "all";
    document.querySelectorAll("[data-avail-filter]").forEach((b) => b.classList.toggle("active", b.dataset.availFilter === "all"));
    state.pendingScrollToPollId = restoredPoll.id;
    collapsed.delete("todo"); collapsed.delete("waiting"); collapsed.delete("blocked"); renderPolls();
    showToast(C18.t("Créneau récupéré et remis en sondage actif."));
  } catch (err) { handleFirebaseError(err); }
}

export function promptRestoreArchivedPoll(archivedPoll) {
  if (!archivedPoll) return;
  const t = formatPollTimeLabel(archivedPoll), tMeta = getEventMeta(archivedPoll.eventType);
  const unavailNames = archivedPoll.unavailableMembers?.length ? archivedPoll.unavailableMembers.join(", ") : C18.t("les membres indisponibles");
  openConfirmationModal({
    title: C18.t("Récupérer ce créneau ?"),
    context: `${tMeta.label} • ${formatDateFr(archivedPoll.date)}${t ? ` • ${t}` : ""}`,
    message: C18.tt`Ce créneau sera remis dans les sondages actifs. Les réponses « Oui » et « Peut-être » seront conservées, tandis que les « Non » (${unavailNames}) seront réinitialisés pour permettre un nouveau vote.`,
    confirmLabel: C18.t("Remettre en sondage"),
    danger: false,
    onConfirm: () => restoreArchivedPoll(archivedPoll)
  });
}

export function promptDeleteArchivedPoll(archivedPoll) {
  if (!archivedPoll) return;
  const t = formatPollTimeLabel(archivedPoll), tMeta = getEventMeta(archivedPoll.eventType);
  openConfirmationModal({
    title: C18.t("Supprimer définitivement ?"),
    context: `${tMeta.label} • ${formatDateFr(archivedPoll.date)}${t ? ` • ${t}` : ""}`,
    message: C18.t("Cette archive sera définitivement effacée (et le créneau ne sera plus bloqué)."),
    confirmLabel: C18.t("Supprimer"),
    danger: true,
    onConfirm: async () => {
      try {
        await remove(ref(db, `ensembles/${state.session.activeEnsembleId}/archivedPolls/${archivedPoll.id}`));
        showToast(C18.t("Archive supprimée."));
      } catch (err) { handleFirebaseError(err); }
    }
  });
}

export function smartSortPolls(polls, members, myId) {
  const total = members.length;
  const metrics = (p) => {
    const v = p.votes || {};
    let yes = 0, maybe = 0, no = 0;
    members.forEach((m) => { if (v[m.id] === "yes") yes++; else if (v[m.id] === "maybe") maybe++; else if (v[m.id] === "no") no++; });
    const full = total > 0 && yes === total;
    return { bucket: full ? 1 : no > 0 ? 3 : 2, unvoted: v[myId] ? 1 : 0, score: yes * 2 + maybe - no * 3, yes };
  };
  return [...polls].sort((a, b) => {
    const ma = metrics(a), mb = metrics(b);
    return (ma.bucket - mb.bucket) || (ma.bucket === 2 ? ma.unvoted - mb.unvoted : 0) || (mb.score - ma.score) || (mb.yes - ma.yes) || getPollSortKey(a).localeCompare(getPollSortKey(b));
  });
}

// Actions sur un créneau
export function openPollActionsMenu(poll) {
  if (!poll || !state.session.activeEnsembleId) return;
  haptic();
  const members = Object.values(state.currentEnsembleData?.members || {});
  const votes = poll.votes || {};
  const yesCount = members.filter((m) => votes[m.id] === "yes").length;
  const missing = members.filter((m) => !votes[m.id]);
  const myId = state.session.ensembles[state.session.activeEnsembleId]?.memberId;
  const isBroad = poll.timeMode === "day" || poll.timeMode === "period";
  const timeLabel = formatPollTimeLabel(poll);
  const tMeta = getEventMeta(poll.eventType);

  $("poll-actions-subtitle").textContent = `${tMeta.label} • ${formatDateFr(poll.date)}${timeLabel ? ` • ${timeLabel}` : ""}`;

  const actions = [
    isBroad
      ? { label: C18.t("🕒 Préciser / proposer des horaires"), fn: () => openRefineTimeModal(poll) }
      : { label: C18.t("🕒 Proposer un autre horaire ce jour"), fn: () => openCounterProposalModal(poll) },
    { label: C18.tt`✓ Valider dans l'agenda (${yesCount}/${members.length})`, fn: () => openConfirmPollModal(poll) },
    ...(missing.length ? [{ label: C18.tt`🔔 Relancer les absents au vote (${missing.length})`, fn: () => sendPollReminder(poll, missing) }] : []),
    { label: C18.t("✎ Modifier le type, la date, l'horaire ou le lieu"), fn: () => openEditPollModal(poll) },
    ...(votes[myId] ? [{ label: C18.t("↩ Retirer mon vote"), fn: () => promptClearMyVote(poll) }] : []),
    { label: C18.t("✕ Supprimer ce créneau"), cls: "danger", fn: () => promptDeletePoll(poll) }
  ];

  const listEl = $("poll-actions-list");
  listEl.innerHTML = actions.map((a, i) => `<button type="button" class="action-sheet-btn ${a.cls || ""}" data-act="${i}">${esc(a.label)}</button>`).join("");
  listEl.onclick = (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    closeModal("modal-poll-actions");
    actions[Number(b.dataset.act)]?.fn();
  };
  $("modal-poll-actions").classList.add("open");
}

export async function sendPollReminder(poll, missing) {
  if (!poll || !missing?.length) return showToast(C18.t("Tous les membres ont déjà répondu."));
  const names = missing.map((m) => m.name).join(", ");
  const tMeta = getEventMeta(poll.eventType);
  try {
    await update(ref(db, `ensembles/${state.session.activeEnsembleId}/polls/${poll.id}`), { lastRemindedAt: Date.now() });
    await hooks.publishEnsembleNotification(
      C18.localizedMessages(() => [C18.tt`Rappel disponibilités (${tMeta.label}) — ${state.currentEnsembleData.name}`, C18.tt`${names} : merci d'indiquer votre disponibilité pour le ${formatDateFr(poll.date)} (${formatPollTimeLabel(poll)}).`]),
      { targetMemberIds: missing.map((m) => m.id) }
    );
    showToast(C18.tt`Relance envoyée à ${names}.`);
  } catch (err) { handleFirebaseError(err); }
}

export function promptDeletePoll(poll) {
  if (!poll) return;
  const voted = Object.keys(poll.votes || {}).length;
  const t = formatPollTimeLabel(poll), tMeta = getEventMeta(poll.eventType);
  openConfirmationModal({
    title: C18.t("Supprimer ce créneau ?"),
    context: `${tMeta.label} • ${formatDateFr(poll.date)}${t ? ` • ${t}` : ""}${poll.location ? ` (${poll.location})` : ""}`,
    message: voted ? C18.tt`${voted} musicien(s) ont déjà répondu. Le créneau et tous les votes seront supprimés.` : C18.t("Ce créneau proposé sera retiré pour tout l'ensemble."),
    confirmLabel: C18.t("Supprimer"),
    onConfirm: async () => {
      try { await remove(ref(db, `ensembles/${state.session.activeEnsembleId}/polls/${poll.id}`)); showToast(C18.t("Créneau supprimé.")); }
      catch (err) { handleFirebaseError(err); }
    }
  });
}

export function promptClearMyVote(poll) {
  const myId = state.session.ensembles[state.session.activeEnsembleId]?.memberId;
  const myVote = poll?.votes?.[myId];
  if (!myId || !myVote) return;
  const t = formatPollTimeLabel(poll);
  openConfirmationModal({
    title: C18.t("Retirer votre vote ?"),
    context: `${formatDateFr(poll.date)}${t ? ` • ${t}` : ""}`,
    message: C18.tt`Votre réponse (« ${formatVoteLabelFr(myVote)} »)${poll.voteNotes?.[myId] ? C18.t(" et votre note seront effacées") : C18.t(" sera effacée")}.`,
    confirmLabel: C18.t("Retirer le vote"),
    onConfirm: async () => {
      try {
        state.openNoteEditors.delete(poll.id);
        await Promise.all([
          remove(ref(db, `ensembles/${state.session.activeEnsembleId}/polls/${poll.id}/votes/${myId}`)),
          remove(ref(db, `ensembles/${state.session.activeEnsembleId}/polls/${poll.id}/voteNotes/${myId}`))
        ]);
        showToast(C18.t("Votre vote a été retiré."));
      } catch (err) { handleFirebaseError(err); }
    }
  });
}

// Gestion des créneaux proposés & modale de proposition
export function readSlotRow(row) {
  const mode = row.dataset.mode || "day", period = row.dataset.period || "";
  const dateInp = row.querySelector(".slot-date");
  return {
    ...(dateInp ? { date: dateInp.value } : {}),
    timeMode: mode,
    period: mode === "period" ? period : "",
    startTime: mode === "exact" ? row.querySelector(".slot-start").value : "",
    endTime: mode === "exact" ? row.querySelector(".slot-end").value : ""
  };
}

export function getPendingProposalSlots() {
  if (state.refiningFixedDate) {
    return Array.from($("poll-slots-container").querySelectorAll(".poll-slot-row"))
      .map(readSlotRow)
      .filter((s) => s.date && (s.timeMode !== "exact" || (s.startTime && s.endTime)));
  }
  const globalTiming = readSlotRow($("poll-global-mode-holder"));
  return [...state.selectedCalDates].sort().map((date) => ({ ...globalTiming, date }));
}

export function updatePollConflictsWarning() {
  const warnBox = $("poll-unavail-warning"), lockBox = $("poll-archive-lock-warning"), subBtn = $("btn-submit-poll");
  const slots = getPendingProposalSlots();

  if (!state.refiningFixedDate) {
    subBtn.textContent = slots.length > 1
      ? C18.tt`Soumettre ces ${slots.length} dates aux membres`
      : slots.length === 1
        ? C18.tt`Soumettre le ${formatCompactDateFr(slots[0].date)} aux membres`
        : C18.t("Sélectionnez au moins une date");
  }

  const lockedMatches = [];
  const lockedLines = slots.map((s) => {
    const arch = findArchivedSlotMatch(s);
    if (!arch) return "";
    lockedMatches.push(arch);
    const abs = arch.unavailableMembers?.length ? C18.tt` (indisponibilité de ${esc(arch.unavailableMembers.join(", "))})` : "";
    return C18.h`• <strong>${esc(formatDateFr(s.date))} (${esc(formatPollTimeLabel(s))})</strong> : sondage déjà effectué et archivé${abs}.`;
  }).filter(Boolean);

  lockBox.classList.toggle("hidden", !lockedLines.length);
  if (lockedLines.length) {
    const restoreBtnHtml = lockedMatches.length === 1
      ? C18.h`<div style="margin-top:8px"><button type="button" class="btn-secondary btn-xs" data-unlock-archived="${esc(lockedMatches[0].id)}">↻ Récupérer ce sondage archivé</button></div>`
      : C18.htmlLiteral("<div style=\"margin-top:8px\"><button type=\"button\" class=\"btn-secondary btn-xs\" data-goto-archived-tab>Voir les archives pour récupérer</button></div>");
    lockBox.innerHTML = C18.h`<strong>Créneau archivé détecté</strong>${lockedLines.join("<br>")}Récupérez-le depuis les archives si un membre est finalement disponible.${restoreBtnHtml}`;
  } else {
    lockBox.innerHTML = "";
  }
  subBtn.disabled = slots.length === 0 || lockedLines.length > 0;

  const conflictLines = [];
  [...new Set(slots.map((s) => s.date))].forEach((d) => {
    getUnavailabilityConflictsForDate(d).forEach((c) => {
      const per = c.startDate === c.endDate ? formatShortDateFr(c.startDate) : C18.tt`du ${formatShortDateFr(c.startDate)} au ${formatShortDateFr(c.endDate)}`;
      conflictLines.push(C18.h`• <strong>${esc(formatDateFr(d))}</strong> : ${esc(c.memberName)} (${esc(c.instrument)}) absent (${per}${c.reason ? ` — ${esc(c.reason)}` : ""})`);
    });
  });

  warnBox.classList.toggle("hidden", !conflictLines.length);
  warnBox.innerHTML = conflictLines.length ? C18.h`<strong>Indisponibilité signalée sur ces dates</strong>${conflictLines.join("<br>")}` : "";
}

export function refreshPollSlotsUI() {
  const rows = $("poll-slots-container").querySelectorAll(".poll-slot-row");
  rows.forEach((r, i) => {
    r.querySelector(".slot-label").textContent = `${state.refiningFixedDate ? C18.t("Horaire") : C18.t("Créneau")} ${i + 1}`;
    r.querySelector(".btn-remove-slot").classList.toggle("hidden", rows.length <= 1);
  });
  $("btn-submit-poll").textContent = state.refiningFixedDate
    ? (rows.length > 1 ? C18.tt`Soumettre ces ${rows.length} horaires aux membres` : C18.t("Soumettre cet horaire aux membres"))
    : (rows.length > 1 ? C18.tt`Soumettre ces ${rows.length} créneaux aux membres` : C18.t("Soumettre ce créneau aux membres"));
  updatePollConflictsWarning();
}

export function addPollSlot(defDate = "", defMode = "", defPeriod = "", defStart = "", defEnd = "") {
  const container = $("poll-slots-container"), rows = container.querySelectorAll(".poll-slot-row"), last = rows[rows.length - 1];
  const today = new Date().toISOString().split("T")[0];
  const mode = defMode || (last ? last.dataset.mode : "day");
  const period = defPeriod || (last ? last.dataset.period : "Après-midi");
  let start = defStart || (last ? last.querySelector(".slot-start").value : "14:00");
  let end = defEnd || (last ? last.querySelector(".slot-end").value : "17:00");
  let date = defDate || state.refiningFixedDate || today;

  if (!defDate && !state.refiningFixedDate && last?.querySelector(".slot-date").value) {
    const d = parseIso(last.querySelector(".slot-date").value); d.setDate(d.getDate() + 1);
    date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  } else if (!defDate && state.refiningFixedDate && last && mode === "exact") {
    const ps = last.querySelector(".slot-start").value;
    [start, end] = ps < "12:30" ? ["14:00", "17:00"] : ps < "17:30" ? ["18:30", "21:00"] : ["09:30", "12:00"];
  }

  const row = document.createElement("div");
  row.className = "poll-slot-row";
  row.innerHTML = C18.h`
    <div class="poll-slot-head">
      <span class="slot-label" style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Créneau</span>
      <button type="button" class="btn-secondary btn-xs btn-remove-slot">Retirer</button>
    </div>
    <div class="field" style="margin-bottom:10px"><label>Date</label><input type="date" class="slot-date" value="${esc(date)}" required /></div>
    ${buildModeSelectorHtml(start, end)}
  `;
  row.querySelector(".slot-date").addEventListener("change", updatePollConflictsWarning);
  bindModeSelector(row, updatePollConflictsWarning);
  row.querySelector(".btn-remove-slot").addEventListener("click", () => { haptic(); row.remove(); refreshPollSlotsUI(); });
  container.appendChild(row);
  applyModeState(row, mode, period, refreshPollSlotsUI);
}

export function resetPollSlots() {
  state.refiningPollId = state.refiningFixedDate = null;
  setEventTypeValue($("poll-type-holder"), "rehearsal");
  $("modal-poll-title").textContent = C18.t("Proposer des dates");
  $("poll-refine-banner").classList.add("hidden");
  $("poll-replace-row").classList.add("hidden");
  $("poll-calendar-wrapper").classList.remove("hidden");
  $("poll-slots-wrapper").classList.add("hidden");
  $("poll-slots-container").innerHTML = "";

  const now = new Date();
  state.calYear = now.getFullYear();
  state.calMonth = now.getMonth();
  state.selectedCalDates.clear();
  applyModeState($("poll-global-mode-holder"), "day", "Après-midi");
  renderMultiCalendar();
}

export function openRefineTimeModal(poll) {
  if (!poll) return;
  haptic(); state.refiningPollId = poll.id; state.refiningFixedDate = poll.date;
  setEventTypeValue($("poll-type-holder"), poll.eventType || "rehearsal");
  const prev = formatPollTimeLabel(poll), tMeta = getEventMeta(poll.eventType);
  $("modal-poll-title").textContent = C18.t("Préciser les horaires");
  $("poll-calendar-wrapper").classList.add("hidden");
  $("poll-slots-wrapper").classList.remove("hidden");
  $("poll-refine-banner").classList.remove("hidden");
  $("poll-refine-banner").innerHTML = C18.h`<div style="font-weight:600;color:var(--yes-fg);margin-bottom:2px">${esc(tMeta.label)} • ${esc(formatDateFr(poll.date))} (${esc(prev)})</div><div style="color:var(--muted)">Proposez un ou plusieurs créneaux horaires pour cette journée :</div>`;
  $("poll-replace-row").classList.remove("hidden");
  $("poll-replace-checkbox").checked = true;
  $("poll-replace-label").textContent = C18.tt`Remplacer la proposition « ${prev} » par ces créneaux horaires`;
  $("btn-add-poll-slot").textContent = C18.t("+ Ajouter un autre horaire ce jour");
  const [s, e] = poll.period === "Matin" ? ["09:30", "12:00"] : poll.period === "Soir" ? ["19:30", "22:00"] : ["14:00", "17:00"];
  $("poll-slots-container").innerHTML = "";
  addPollSlot(poll.date, "exact", "", s, e);
  $("poll-location").value = poll.location || "";
  $("poll-note").value = poll.note || "";
  $("modal-poll").classList.add("open");
}

export function openCounterProposalModal(poll) {
  if (!poll) return;
  haptic(); state.refiningPollId = null; state.refiningFixedDate = poll.date;
  setEventTypeValue($("poll-type-holder"), poll.eventType || "rehearsal");
  $("modal-poll-title").textContent = C18.t("Autre horaire ce jour");
  $("poll-calendar-wrapper").classList.add("hidden");
  $("poll-slots-wrapper").classList.remove("hidden");
  $("poll-refine-banner").classList.add("hidden");
  $("poll-replace-row").classList.add("hidden");
  $("btn-add-poll-slot").textContent = C18.t("+ Ajouter un autre horaire ce jour");
  $("poll-slots-container").innerHTML = "";
  const [s, e] = poll.startTime && poll.startTime < "12:30" ? ["14:00", "17:00"] : ["18:30", "21:00"];
  addPollSlot(poll.date, "exact", "", s, e);
  $("poll-location").value = poll.location || "";
  $("poll-note").value = poll.note || "";
  $("modal-poll").classList.add("open");
}

// Édition d'un créneau
export function checkEditPollArchiveLock() {
  const holder = $("edit-poll-mode-holder"), warn = $("edit-poll-archive-warning"), btn = $("btn-submit-edit-poll");
  const cand = { ...readSlotRow(holder), date: $("edit-poll-date").value };
  const arch = cand.date ? findArchivedSlotMatch(cand) : null;
  warn.classList.toggle("hidden", !arch);
  warn.innerHTML = arch ? C18.h`<strong>Créneau archivé détecté</strong>Ce créneau (${esc(formatDateFr(cand.date))} • ${esc(formatPollTimeLabel(cand))}) est dans les archives. Vous pouvez le récupérer depuis l'onglet <em>Archives</em>.` : "";
  btn.disabled = Boolean(arch);
}

export function openEditPollModal(poll) {
  if (!poll) return;
  haptic();
  const holder = $("edit-poll-mode-holder");
  setEventTypeValue($("edit-poll-type-holder"), poll.eventType || "rehearsal");
  $("edit-poll-id").value = poll.id;
  $("edit-poll-date").value = poll.date || "";
  holder.querySelector(".slot-start").value = poll.startTime || "14:00";
  holder.querySelector(".slot-end").value = poll.endTime || "17:00";
  $("edit-poll-location").value = poll.location || "";
  $("edit-poll-note").value = poll.note || "";
  applyModeState(holder, poll.timeMode || "day", poll.period || "Après-midi", checkEditPollArchiveLock);
  $("modal-edit-poll").classList.add("open");
}

// Suggestions de lieu, notes de vote & validation vers Agenda
export async function savePollLocationSuggestion(pollId, rawVal) {
  const ens=state.session.activeEnsembleId;if(!ens||!state.currentEnsembleData?.polls?.[pollId])return false;
  const val=String(rawVal||'').trim(),me=state.session.ensembles[ens];
  try{const result=await runTransaction(ref(db,`ensembles/${ens}/polls/${pollId}`),p=>{if(!p)return;p.location=val;if(val)p.locationSuggestedBy=me?.name||'';else delete p.locationSuggestedBy;p.updatedAt=Date.now();return p;},{applyLocally:false});if(!result.committed){showToast(C18.t('Ce créneau n’est plus actif.'));return false;}state.openLocationEditors.delete(pollId);showToast(val?C18.tt`Lieu suggéré : ${val}`:C18.t('Lieu retiré.'));return true;}catch(err){handleFirebaseError(err);return false;}
}

export async function saveVoteNote(pollId, rawVal) {
  const ens=state.session.activeEnsembleId,myId=state.session.ensembles[ens]?.memberId;if(!myId||!state.currentEnsembleData?.polls?.[pollId])return false;
  const val=String(rawVal||'').trim();
  try{const result=await runTransaction(ref(db,`ensembles/${ens}/polls/${pollId}`),p=>{if(!p)return;p.voteNotes={...(p.voteNotes||{})};if(val)p.voteNotes[myId]=val;else delete p.voteNotes[myId];return p;},{applyLocally:false});if(!result.committed){showToast(C18.t('Ce créneau n’est plus actif.'));return false;}showToast(C18.t(val?'Note enregistrée.':'Note retirée.'));return true;}catch(err){handleFirebaseError(err);return false;}
}

export function openConfirmPollModal(poll) {
  if (!poll) return;
  const type = poll.eventType || "rehearsal";
  $("confirm-poll-id").value = poll.id;
  setEventTypeValue($("confirm-poll-type-holder"), type, (t) => syncConcertFieldsVisibility("confirm-poll", t, "lbl-confirm-poll-start", "lbl-confirm-poll-end"));
  populateConcertFields("confirm-poll", null);
  const t = formatPollTimeLabel(poll), tMeta = getEventMeta(type);
  const members=Object.values(state.currentEnsembleData?.members||{}),yes=members.filter(m=>poll.votes?.[m.id]==='yes').length;
  $("confirm-poll-summary").textContent = `${tMeta.label} • ${formatDateFr(poll.date)}${t ? ` • ${t}` : ""} · ${C18.t('{0} disponible(s) sur {1}',yes,members.length)}`;
  const [s, e] = poll.timeMode === "period"
    ? ({ "Matin": ["09:00", "12:00"], "Soir": ["19:30", "22:00"] }[poll.period] || ["14:00", "17:00"])
    : poll.timeMode === "day" ? (type === "concert" ? ["20:00", "22:00"] : ["14:00", "17:00"]) : [poll.startTime || "14:00", poll.endTime || "17:00"];
  $("confirm-poll-start").value = s; $("confirm-poll-end").value = e;
  if (type === "concert") $("confirm-poll-soundcheck").value = "18:30";
  $("confirm-poll-location").value = poll.location || ""; $("confirm-poll-program").value = poll.note || "";
  openModal("modal-confirm-poll");
}

// Interface intelligente : les écritures Firebase et les actions existantes restent partagées.
const tr = (key, ...args) => esc(C18.t(key, ...args));
const symbols = { yes: '✓', maybe: '?', no: '×' };
const voteKeys = { yes: 'Oui', maybe: 'Peut-être', no: 'Non' };
let uiEnsemble = null, selectionMode = false, selected = new Set(), collapsed = new Set(['waiting', 'blocked']);
let detailId = null, lastVote = null, quick = null, busy = false, tableSort = 'score';
const draftValues = new Map();
const currentMember = () => state.session.ensembles[state.session.activeEnsembleId]?.memberId;
const metrics = (p, members) => {
  const counts = {yes:0, maybe:0, no:0, missing:0};
  members.forEach(m => { const v = p.votes?.[m.id]; counts[voteKeys[v] ? v : 'missing']++; });
  return {...counts, full: members.length > 0 && counts.yes === members.length};
};
function resetSmartScope() {
  if (uiEnsemble === state.session.activeEnsembleId) return;
  uiEnsemble = state.session.activeEnsembleId; selectionMode = false; selected.clear();
  collapsed = new Set(['waiting', 'blocked']); detailId = null; quick = null; lastVote = null; draftValues.clear();
  state.expandedMemberLists.clear(); state.openNoteEditors.clear(); state.openLocationEditors.clear();
  state.availFilterMode = 'all'; closeModal('modal-poll-detail'); closeModal('modal-quick-vote');
}
function dateTile(date) {
  const d = parseIso(date);
  return `<div class="smart-date"><span>${esc(d.toLocaleDateString(locale,{weekday:'short'}))}</span><strong>${d.getDate()}</strong><span>${esc(d.toLocaleDateString(locale,{month:'short'}))}</span></div>`;
}
function voteButtons(p, myId, prefix = 'vote') {
  return `<div class="smart-vote-group" role="group" aria-label="${tr('Votre réponse')}">${Object.keys(voteKeys).map(v => `<button type="button" class="smart-vote ${v} ${p.votes?.[myId] === v ? 'chosen' : ''}" data-${prefix}="${esc(p.id)}" data-val="${v}" aria-pressed="${p.votes?.[myId] === v}"><span aria-hidden="true">${symbols[v]}</span> ${tr(voteKeys[v])}</button>`).join('')}</div>`;
}
function consensusBar(p, members) {
  const m = metrics(p,members);
  const colors = ['yes','maybe','no','missing'];
  const desc = `${m.yes} ${C18.t('Disponibles')} · ${m.maybe} ${C18.t('Incertains')} · ${m.no} ${C18.t('Indisponibles')} · ${m.missing} ${C18.t('Sans réponse')}`;
  return `<div class="smart-score"><div class="smart-meter" role="img" aria-label="${esc(desc)}" title="${esc(desc)}">${members.length <= 12 ? members.map(member=>{const v=p.votes?.[member.id];return `<i class="${voteKeys[v]?v:'missing'}" style="flex:1"></i>`;}).join('') : colors.filter(v=>m[v]).map(v=>`<i class="${v}" style="flex:${m[v]}"></i>`).join('')}</div><strong class="${m.full?'all-yes':''}">${m.yes}/${members.length}</strong></div>`;
}
function pollDetails(p, members, myId) {
  const v=p.votes||{}, notes=p.voteNotes||{}, m=metrics(p,members), broad=p.timeMode==='day'||p.timeMode==='period';
  const conflicts=getUnavailabilityConflictsForDate(p.date).filter(c=>v[c.memberId]!=='yes');
  const note=draftValues.get(`note:${p.id}`) ?? notes[myId] ?? '';
  const loc=draftValues.get(`loc:${p.id}`) ?? p.location ?? '';
  return `<div class="smart-detail">
    ${p.note?`<p class="smart-description">${esc(p.note)}</p>`:''}
    ${conflicts.length?`<div class="unavail-notice">${tr('Absence :')} ${conflicts.map(c=>esc(c.memberName)+(c.reason?' ('+esc(c.reason)+')':'')).join(', ')}</div>`:''}
    <div class="smart-member-list">${members.map(member=>{const val=v[member.id], key=voteKeys[val];return `<div class="smart-member"><span class="smart-person ${key?val:'missing'}">${symbols[val]||'○'}</span><div><strong>${esc(member.name)}${member.id===myId?' · '+tr('Vous'):''}</strong><small>${esc(member.instrument)}${notes[member.id]?' · '+esc(notes[member.id]):''}</small></div><span class="smart-member-state ${key?val:'missing'}">${tr(key||'Sans réponse')}</span></div>`;}).join('')}</div>
    <div class="smart-detail-edit"><label>${tr('Votre précision')}</label><div class="vote-note-bar"><input type="text" class="vote-note-input" data-note-input="${esc(p.id)}" maxlength="90" aria-label="${tr('Votre précision')}" value="${esc(note)}" placeholder="${tr('Ex. disponible dès 15h')}"/><button type="button" class="btn-secondary btn-sm" data-save-note="${esc(p.id)}">${tr('Enregistrer')}</button></div></div>
    <div class="smart-detail-edit"><label>${tr('Lieu envisagé')}</label><div class="loc-inline-bar"><input type="text" class="loc-inline-input" data-loc-input="${esc(p.id)}" maxlength="70" aria-label="${tr('Lieu envisagé')}" value="${esc(loc)}"/><button type="button" class="btn-secondary btn-sm" data-save-loc="${esc(p.id)}">${tr('Enregistrer')}</button></div>${p.locationSuggestedBy?`<small>${tr('Lieu suggéré par {0}',p.locationSuggestedBy)}</small>`:''}</div>
    <div class="smart-detail-actions">${m.missing?`<button type="button" class="btn-secondary btn-sm" data-remind-poll="${esc(p.id)}">${tr('Relancer ({0})',m.missing)}</button>`:''}<button type="button" class="btn-secondary btn-sm" data-${broad?'refine':'counter'}-poll="${esc(p.id)}">${tr(broad?'Préciser les horaires':'Proposer un autre horaire')}</button><button type="button" class="btn-secondary btn-sm" data-confirm-poll="${esc(p.id)}">${tr('Valider dans l’agenda')}</button></div>
  </div>`;
}
function pollRow(p,members,myId) {
  const m=metrics(p,members), open=state.expandedMemberLists.has(p.id), broad=p.timeMode==='day'||p.timeMode==='period';
  return `<div class="smart-slot ${m.full?'smart-full':''}" data-poll-card="${esc(p.id)}">
    <div class="smart-slot-main"><div class="smart-slot-info"><strong class="smart-time">${esc(formatPollTimeLabel(p)||'—')}</strong>${p.location?`<small>${esc(C18.localizeLocation(p.location))}</small>`:''}${consensusBar(p,members)}<small>${m.full?tr('Tous disponibles'):[m.no?tr('{0} indisponible(s)',m.no):'',m.missing?tr('{0} réponse(s) manquante(s)',m.missing):'',m.maybe?tr('{0} réponse(s) incertaine(s)',m.maybe):''].filter(Boolean).join(' · ')}</small></div>
      ${selectionMode&&!p.votes?.[myId]?`<button type="button" class="btn-secondary smart-select ${selected.has(p.id)?'selected':''}" data-select-poll="${esc(p.id)}" aria-pressed="${selected.has(p.id)}" aria-label="${tr('Sélectionner ce créneau')}">${selected.has(p.id)?'✓':'○'}</button>`:''}
      <button type="button" class="smart-icon" data-toggle-members="${esc(p.id)}" aria-expanded="${open}" aria-label="${tr('Détails du créneau')}">${open?'⌃':'⌄'}</button><button type="button" class="smart-icon" data-poll-menu="${esc(p.id)}" aria-label="${tr("Plus d'options")}">⋯</button>
    </div>
    ${!p.votes?.[myId]||open?voteButtons(p,myId):`<button type="button" class="smart-my-vote ${p.votes[myId]}" data-toggle-members="${esc(p.id)}" aria-label="${tr('Modifier mon vote')}"><span>${symbols[p.votes[myId]]||'○'} ${tr(voteKeys[p.votes[myId]]||'Sans réponse')}</span><small>${tr('Modifier mon vote')}</small></button>`}
    ${m.full?`<div class="smart-ready-actions"><button type="button" class="btn-confirm btn-full" data-confirm-poll="${esc(p.id)}">${tr(broad?'Planifier (choisir l’heure)':'Ajouter à l’agenda')}</button>${broad?`<button type="button" class="btn-secondary" data-refine-poll="${esc(p.id)}">${tr('Préciser les horaires')}</button>`:''}</div>`:''}
    ${open?pollDetails(p,members,myId):''}</div>`;
}
function sectionHtml(key,label,items,members,myId) {
  if (!items.length) return '';
  const closed=collapsed.has(key), groups=new Map();
  [...items].sort((a,b)=>getPollSortKey(a).localeCompare(getPollSortKey(b))).forEach(p=>{const k=p.date+'|'+(p.eventType||'rehearsal');if(!groups.has(k))groups.set(k,[]);groups.get(k).push(p);});
  return `<section class="smart-section" data-section="${key}"><button type="button" class="smart-section-head" data-toggle-section="${key}" aria-expanded="${!closed}"><span class="section-symbol ${key}">${{ready:'✓',todo:'●',waiting:'◷',blocked:'×'}[key]}</span><strong>${tr(label)}</strong><span class="smart-count">${items.length}</span><span aria-hidden="true">${closed?'⌄':'⌃'}</span></button>${closed?'':[...groups.values()].map(g=>`<article class="card smart-day ${getEventMeta(g[0].eventType).cardCls}"><div class="smart-day-head">${dateTile(g[0].date)}<div><strong>${esc(getEventMeta(g[0].eventType).label)}</strong><small>${esc(formatDateFr(g[0].date))}${g.length>1?' · '+tr('{0} créneaux',g.length):''}</small></div></div>${g.map(p=>pollRow(p,members,myId)).join('')}</article>`).join('')}</section>`;
}
function archiveHtml(archList,members) {
  return `<div class="smart-archive-intro">${tr('Créneaux clos avec au moins une indisponibilité. Récupérez un créneau si un membre est finalement libre.')}</div>${archList.length?[...archList].sort((a,b)=>(b.archivedAt||0)-(a.archivedAt||0)).map(p=>`<article class="card smart-day archived-card"><div class="smart-day-head">${dateTile(p.date)}<div><strong>${esc(getEventMeta(p.eventType).label)} · ${esc(formatPollTimeLabel(p))}</strong><small>${esc(C18.localizeLocation(p.location||''))}</small>${consensusBar(p,members)}</div></div>${p.note?`<p>${esc(p.note)}</p>`:''}<div class="member-votes-list">${members.map(m=>{const v=p.votes?.[m.id];return `<span class="member-chip ${voteKeys[v]?v:''}">${symbols[v]||'○'} ${esc(m.name)}${p.voteNotes?.[m.id]?' · '+esc(p.voteNotes[m.id]):''}</span>`;}).join('')}</div><div class="archive-lock-banner"><span>${tr('Sondage archivé')}</span><div class="archive-actions-group"><button type="button" class="btn-secondary" data-restore-arch="${esc(p.id)}">↻ ${tr('Récupérer')}</button><button type="button" class="btn-del-subtle" data-del-arch="${esc(p.id)}">${tr('Supprimer')}</button></div></div></article>`).join(''):`<div class="empty-state">${tr('Aucun créneau archivé.')}</div>`}`;
}
function tableHtml(polls,members,myId) {
  const ordered=[...members.filter(m=>m.id===myId),...members.filter(m=>m.id!==myId)];
  const rows=tableSort==='date'?[...polls].sort((a,b)=>getPollSortKey(a).localeCompare(getPollSortKey(b))):smartSortPolls(polls,members,myId);
  return `<div class="matrix-legend"><span class="yes">✓ ${tr('Oui')}</span><span class="maybe">? ${tr('Peut-être')}</span><span class="no">× ${tr('Non')}</span><span>○ ${tr('Sans réponse')}</span></div><p class="smart-hint">${tr('Touchez un créneau pour voir ses détails. Touchez votre case pour choisir votre réponse.')}</p><div class="card matrix-card smart-matrix"><div class="matrix-scroll"><table class="avail-matrix"><thead><tr><th scope="col">${tr('Créneau')}</th>${ordered.map(m=>`<th scope="col" class="${m.id===myId?'col-me':''}">${esc(m.name)}${m.id===myId?'<br>'+tr('Vous'):''}</th>`).join('')}<th scope="col">${tr('Total')}</th></tr></thead><tbody>${rows.map(p=>{const m=metrics(p,members);return `<tr class="${m.full?'row-consensus':''}" data-poll-card="${esc(p.id)}"><td><button class="matrix-date-btn" type="button" data-detail-poll="${esc(p.id)}"><strong class="matrix-date-line"><span>${esc(formatCompactDateFr(p.date))}</span><span class="${m.full?'all-yes':''}">${m.yes}/${members.length}</span></strong><small>${esc(formatPollTimeLabel(p))}</small><small>${esc(getEventMeta(p.eventType).label)}${p.location?' · '+esc(C18.localizeLocation(p.location)):''}</small></button></td>${ordered.map(member=>{const val=p.votes?.[member.id],key=voteKeys[val],note=p.voteNotes?.[member.id],label=esc(member.name+' : '+C18.t(key||'Sans réponse')+(note?' — '+note:''));const badge=`<span class="matrix-cell-badge ${key?val:''}" title="${label}" aria-label="${label}">${symbols[val]||'○'}${note?'<i class="matrix-note-dot"></i>':''}</span>`;return `<td>${member.id===myId?`<button type="button" class="matrix-cell-btn" data-detail-poll="${esc(p.id)}" aria-label="${label}">${badge}</button>`:badge}</td>`;}).join('')}<td class="${m.full?'all-yes':''}"><strong>${m.yes}/${members.length}</strong></td></tr>`;}).join('')}</tbody></table></div></div>`;
}
function captureEditor() {
  const el=document.activeElement; if(!el?.matches?.('.vote-note-input,.loc-inline-input'))return null;
  const key=el.dataset.noteInput?'note':'loc', id=el.dataset.noteInput||el.dataset.locInput;
  draftValues.set(`${key}:${id}`,el.value);return {key,id,start:el.selectionStart,end:el.selectionEnd,modal:!!el.closest('#modal-poll-detail')};
}
function restoreEditor(saved) { if(!saved)return; const root=saved.modal?$('poll-detail-content'):$('polls-list');const el=root.querySelector(`[data-${saved.key}-input="${CSS.escape(saved.id)}"]`);if(el){el.focus({preventScroll:true});el.setSelectionRange(saved.start,saved.end);} }
export function renderPolls() {
  if(!state.currentEnsembleData)return;
  resetSmartScope(); const saved=captureEditor(), container=$('polls-list'), toolbar=$('avail-toolbar'), myId=currentMember(), members=Object.values(state.currentEnsembleData.members||{});
  const anchors = !$('view-avail').classList.contains('hidden') ? [...container.querySelectorAll('[data-poll-card]')].map(el=>({id:el.dataset.pollCard,section:el.closest('[data-section]')?.dataset.section,top:el.getBoundingClientRect().top})).filter(x=>x.top>=55&&x.top<innerHeight-75) : [];
  const oldScroll=container.querySelector('.matrix-scroll')?.scrollLeft||0;
  const active=Object.values(state.currentEnsembleData.polls||{}).filter(p=>!isPollImpossibleAndComplete(p,members));
  const arch=Object.values(state.currentEnsembleData.archivedPolls||{}), todo=active.filter(p=>!p.votes?.[myId]), ready=active.filter(p=>metrics(p,members).full), waiting=active.filter(p=>p.votes?.[myId]&&!metrics(p,members).full&&!metrics(p,members).no), blocked=active.filter(p=>p.votes?.[myId]&&metrics(p,members).no);
  state.lastRenderedUnvotedPolls=todo;state.lastRenderedFilteredPolls=active;
  selected=new Set([...selected].filter(id=>todo.some(p=>p.id===id)));
  const archived=state.availFilterMode==='archived', comparing=state.availViewMode==='table';
  $('nav-avail-badge').textContent=todo.length;$('nav-avail-badge').classList.toggle('hidden',!todo.length);
  toolbar.classList.remove('hidden');
  document.querySelectorAll('[data-avail-view]').forEach(b=>{const on=!archived&&b.dataset.availView===state.availViewMode;b.classList.toggle('active',on);b.setAttribute('aria-pressed',on);});
  $('btn-avail-archives').textContent=archived?C18.t('Retour aux dates'):C18.t('Archives')+(arch.length?` (${arch.length})`:'');$('btn-avail-archives').setAttribute('aria-pressed',archived);
  const done=active.length-todo.length;
  $('avail-overview').innerHTML=`<div class="smart-overview"><div class="smart-progress-head"><strong>${tr('Mes réponses')}</strong><span>${done}/${active.length}</span></div><div class="smart-personal-progress" role="progressbar" aria-label="${tr('Mes réponses')}" aria-valuemin="0" aria-valuemax="${Math.max(1,active.length)}" aria-valuenow="${done}"><i style="width:${active.length?done/active.length*100:0}%"></i></div><div class="smart-overview-stats"><div><strong>${todo.length}</strong><small>${tr('À répondre')}</small></div><div><strong class="all-yes">${ready.length}</strong><small>${tr('À planifier')}</small></div><div><strong>${waiting.length+blocked.length}</strong><small>${tr('En attente')}</small></div></div>${todo.length&&!archived?`<button type="button" class="btn-primary btn-full" data-start-quick>⚡ ${tr('Vote rapide')} · ${todo.length}</button>`:`<small class="smart-hint">${archived?'':tr(active.length?'Toutes vos réponses sont à jour.':'Aucun vote en attente.')}</small>`}</div>`;
  const canUndo=lastVote&&active.some(p=>p.id===lastVote.id&&p.votes?.[myId]===lastVote.value)&&!busy;
  $('avail-tools').innerHTML=archived?'':`<div class="smart-tools">${comparing?`<button type="button" class="btn-secondary" data-sort-table>${tr(tableSort==='score'?'Tri : meilleurs créneaux':'Tri : chronologique')} ↕</button>`:todo.length?`<button type="button" class="btn-secondary" data-bulk-toggle>${tr(selectionMode?'Quitter la sélection':'Sélection multiple')}</button>`:''}${canUndo?`<button type="button" class="btn-secondary" data-undo-vote>↶ ${tr('Annuler le dernier vote')}</button>`:''}</div>${selectionMode&&!comparing?`<div class="smart-bulk"><div class="smart-tools"><strong>${tr('{0} sélectionné(s)',selected.size)}</strong><button type="button" class="btn-secondary" data-select-all>${tr(selected.size===todo.length?'Tout désélectionner':'Tout sélectionner')}</button></div><div class="smart-vote-group">${Object.keys(voteKeys).map(v=>`<button type="button" class="smart-vote ${v}" data-bulk-vote="${v}" ${selected.size&&!busy?'':'disabled'}>${symbols[v]} ${tr(voteKeys[v])}</button>`).join('')}</div></div>`:''}`;
  if(archived)container.innerHTML=archiveHtml(arch,members);
  else if(!active.length)container.innerHTML=`<div class="empty-state"><p>${tr('Aucune date en cours de sondage.')}</p><button type="button" class="btn-primary" data-empty-add-poll>${tr('Proposer des dates aux membres')}</button></div>`;
  else if(comparing)container.innerHTML=tableHtml(active,members,myId);
  else container.innerHTML=sectionHtml('ready','Prêtes à planifier',ready,members,myId)+sectionHtml('todo','À vous de répondre',todo,members,myId)+sectionHtml('waiting','En attente des autres',waiting,members,myId)+sectionHtml('blocked','Créneaux avec indisponibilité',blocked,members,myId);
  const scroll=container.querySelector('.matrix-scroll');if(scroll){const first=scroll.querySelector('th:first-child');if(first.getBoundingClientRect().width>0)scroll.style.setProperty('--matrix-date-width',`${first.getBoundingClientRect().width}px`);scroll.scrollLeft=oldScroll;}
  if(detailId&&$('modal-poll-detail').classList.contains('open'))renderDetail();
  if(quick&&!busy&&$('modal-quick-vote').classList.contains('open'))renderQuick();
  restoreEditor(saved);
  if(!saved&&!state.pendingScrollToPollId){for(const anchor of anchors){const el=container.querySelector(`[data-poll-card="${CSS.escape(anchor.id)}"]`);if(el&&el.closest('[data-section]')?.dataset.section===anchor.section){const delta=el.getBoundingClientRect().top-anchor.top;if(Math.abs(delta)>2&&Math.abs(delta)<innerHeight)window.scrollBy(0,delta);break;}}}
  if(state.pendingScrollToPollId){const id=state.pendingScrollToPollId;state.pendingScrollToPollId=null;const el=container.querySelector(`[data-poll-card="${CSS.escape(id)}"]`);if(el)requestAnimationFrame(()=>el.scrollIntoView({block:'center',behavior:'smooth'}));}
}
function renderDetail(){const p=state.currentEnsembleData?.polls?.[detailId], members=Object.values(state.currentEnsembleData?.members||{});if(!p||isPollImpossibleAndComplete(p,members)){ $('poll-detail-content').innerHTML=`<p>${tr('Ce créneau n’est plus actif.')}</p>`;return;} $('poll-detail-content').innerHTML=`<div class="smart-day-head">${dateTile(p.date)}<div><strong>${esc(getEventMeta(p.eventType).label)}</strong><small>${esc(formatDateFr(p.date))} · ${esc(formatPollTimeLabel(p))}</small>${consensusBar(p,members)}</div></div>${voteButtons(p,currentMember())}${pollDetails(p,members,currentMember())}<button type="button" class="btn-secondary btn-full" data-poll-menu="${esc(p.id)}">${tr("Plus d'options")}</button>`;}
function startQuick(){if(busy)return;quick={ids:[...state.lastRenderedUnvotedPolls].sort((a,b)=>getPollSortKey(a).localeCompare(getPollSortKey(b))).map(p=>p.id), index:0, note:'', skipped:new Set(), answered:new Set()};openModal('modal-quick-vote');renderQuick();$('quick-vote-content').querySelector('button:not([disabled])')?.focus({preventScroll:true});}
function renderQuick(){if(!quick)return; const root=$('quick-vote-content'), myId=currentMember(), members=Object.values(state.currentEnsembleData?.members||{});while(quick.index<quick.ids.length){const p=state.currentEnsembleData?.polls?.[quick.ids[quick.index]];if(p&&!isPollImpossibleAndComplete(p,members)&&!p.votes?.[myId])break;if(p?.votes?.[myId]||quick.answered.has(quick.ids[quick.index]))quick.answered.add(quick.ids[quick.index]);else quick.skipped.add(quick.ids[quick.index]);quick.index++;quick.note='';}
  const focusedNote=document.activeElement?.id==='quick-note', notePos=focusedNote?document.activeElement.selectionStart:null;
  const total=quick.ids.length, p=state.currentEnsembleData?.polls?.[quick.ids[quick.index]];
  const undo=lastVote&&quick.ids.includes(lastVote.id)&&state.currentEnsembleData?.polls?.[lastVote.id]?.votes?.[myId]===lastVote.value&&!isPollImpossibleAndComplete(state.currentEnsembleData.polls[lastVote.id],members)&&!busy;
  root.innerHTML=`<div class="quick-progress"><span>${tr('{0} sur {1}',Math.min(quick.index+1,total),total)}</span><span>${tr('{0} répondu(s)',quick.answered.size)}</span></div><div class="smart-personal-progress"><i style="width:${total?quick.index/total*100:100}%"></i></div>${p&&quick.index<total?`<div class="quick-date"><small>${esc(getEventMeta(p.eventType).label)}${p.location?' · '+esc(C18.localizeLocation(p.location)):''}</small><h3>${esc(formatDateFr(p.date))}</h3><strong>${esc(formatPollTimeLabel(p))}</strong><p>${tr('Êtes-vous disponible ?')}</p></div><label for="quick-note">${tr('Précision facultative')}</label><input id="quick-note" maxlength="90" value="${esc(quick.note)}" placeholder="${tr('Ex. disponible dès 15h')}"/>${voteButtons(p,myId,'quick-vote')}<div class="smart-tools"><button type="button" class="btn-secondary" data-quick-prev ${busy||!quick.ids.slice(0,quick.index).some(id=>state.currentEnsembleData?.polls?.[id]&&!state.currentEnsembleData.polls[id].votes?.[myId])?'disabled':''}>← ${tr('Précédent')}</button><button type="button" class="btn-secondary" data-quick-skip ${busy?'disabled':''}>${tr('Passer')} →</button></div>`:`<div class="quick-date"><h3>${tr('Parcours terminé')}</h3><p>${tr('{0} réponse(s) enregistrée(s)',quick.answered.size)}</p><p>${tr('{0} créneau(x) restant(s) à répondre',state.lastRenderedUnvotedPolls.length)}</p></div><button type="button" class="btn-primary btn-full" data-close="modal-quick-vote">${tr('Terminer')}</button>`}${undo?`<button type="button" class="btn-secondary btn-full" data-undo-vote>↶ ${tr('Annuler le dernier vote')}</button>`:''}`;
  if(busy)root.querySelectorAll('button:not([data-close])').forEach(b=>b.disabled=true);
  if(focusedNote&&$('quick-note')){$('quick-note').focus({preventScroll:true});$('quick-note').setSelectionRange(notePos,notePos);}
}
async function writeVote(id,value,note=undefined){
  if(busy)return false;const ens=state.session.activeEnsembleId,myId=currentMember(),p=state.currentEnsembleData?.polls?.[id];if(!p||!myId||!voteKeys[value]||p.votes?.[myId]===value)return false;
  busy=true;const old=p.votes?.[myId]||null,oldNote=p.voteNotes?.[myId]||null;
  if($('modal-quick-vote').classList.contains('open'))$('quick-vote-content').querySelectorAll('button:not([data-close])').forEach(b=>b.disabled=true);
  try{haptic();const result=await runTransaction(ref(db,`ensembles/${ens}/polls/${id}`),current=>{
    if(!current||(current.votes?.[myId]||null)!==old)return;
    current.votes={...(current.votes||{}),[myId]:value};
    if(note!==undefined){current.voteNotes={...(current.voteNotes||{})};if(note.trim())current.voteNotes[myId]=note.trim();else delete current.voteNotes[myId];}
    return current;
  },{applyLocally:false});if(!result.committed){showToast(C18.t('Ce créneau n’est plus actif.'));return false;}
  if(ens===state.session.activeEnsembleId){lastVote={id,value,old,oldNote,newNote:note===undefined?undefined:note.trim()||null,noteChanged:note!==undefined};if(value==='maybe'&&note===undefined){state.expandedMemberLists.add(id);collapsed.delete('waiting');collapsed.delete('blocked');}if(isPollImpossibleAndComplete(result.snapshot.val(),Object.values(state.currentEnsembleData?.members||{})))showToast(C18.t('Ce vote a entraîné l’archivage du créneau. Il peut être récupéré dans les archives.'));}return true;
  }catch(err){handleFirebaseError(err);return false;}finally{busy=false;renderPolls();}
}
async function undoVote(){if(busy||!lastVote)return;const ens=state.session.activeEnsembleId,myId=currentMember(),v=lastVote,p=state.currentEnsembleData?.polls?.[v.id];if(!p||p.votes?.[myId]!==v.value||isPollImpossibleAndComplete(p,Object.values(state.currentEnsembleData.members||{})))return showToast(C18.t('Ce créneau n’est plus actif.'));busy=true;
  try{const result=await runTransaction(ref(db,`ensembles/${ens}/polls/${v.id}`),current=>{if(!current||current.votes?.[myId]!==v.value)return;current.votes={...current.votes};if(v.old)current.votes[myId]=v.old;else delete current.votes[myId];if(v.noteChanged&&(current.voteNotes?.[myId]||null)===v.newNote){current.voteNotes={...(current.voteNotes||{})};if(v.oldNote)current.voteNotes[myId]=v.oldNote;else delete current.voteNotes[myId];}return current;},{applyLocally:false});if(!result.committed)return showToast(C18.t('Ce créneau n’est plus actif.'));if(ens===state.session.activeEnsembleId){lastVote=null;if(quick){quick.answered.delete(v.id);const i=quick.ids.indexOf(v.id);if(i>=0){quick.index=i;quick.note='';}}}showToast(C18.t('Dernier vote annulé.'));}catch(err){handleFirebaseError(err);}finally{busy=false;renderPolls();}}
function bulkVote(value){const ids=[...selected],ens=state.session.activeEnsembleId,myId=currentMember();if(!ids.length||busy||!voteKeys[value])return;openConfirmationModal({title:C18.t('Confirmer le vote groupé ?'),context:C18.t('{0} créneaux',ids.length)+' · '+C18.t(voteKeys[value]),message:C18.t('Cette réponse sera appliquée aux créneaux sélectionnés qui attendent encore votre vote.'),confirmLabel:C18.t('Confirmer'),danger:false,onConfirm:async()=>{if(ens!==state.session.activeEnsembleId||busy)return;const updates={};ids.forEach(id=>{const p=state.currentEnsembleData?.polls?.[id];if(p&&!p.votes?.[myId])updates[`${id}/votes/${myId}`]=value;});if(!Object.keys(updates).length)return;busy=true;try{const result=await runTransaction(ref(db,`ensembles/${ens}/polls`),current=>{if(!current)return;let changed=false;ids.forEach(id=>{const p=current[id];if(p&&!p.votes?.[myId]){p.votes={...(p.votes||{}),[myId]:value};changed=true;}});return changed?current:undefined;},{applyLocally:false});if(!result.committed)return;selected.clear();selectionMode=false;lastVote=null;showToast(C18.t('Votes groupés enregistrés.'));}catch(err){handleFirebaseError(err);}finally{busy=false;renderPolls();}}});}

export function initPollsListeners() {
  if(typeof ResizeObserver!=='undefined')new ResizeObserver(()=>{const sc=$('polls-list').querySelector('.matrix-scroll'),w=sc?.querySelector('th:first-child')?.getBoundingClientRect().width;if(w>0)sc.style.setProperty('--matrix-date-width',`${w}px`);}).observe($('polls-list'));
  document.querySelectorAll("[data-avail-view]").forEach(btn=>btn.addEventListener('click',()=>{haptic();state.availViewMode=btn.dataset.availView;state.availFilterMode='all';try{localStorage.setItem('cadenza_avail_view_v1',state.availViewMode);}catch(_){}renderPolls();}));
  $('btn-avail-archives').addEventListener('click',()=>{state.availFilterMode=state.availFilterMode==='archived'?'all':'archived';renderPolls();});
  $('avail-toolbar').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.hasAttribute('data-start-quick'))return startQuick();if(b.hasAttribute('data-sort-table')){tableSort=tableSort==='score'?'date':'score';return renderPolls();}if(b.hasAttribute('data-undo-vote'))return undoVote();if(b.hasAttribute('data-bulk-toggle')){selectionMode=!selectionMode;selected.clear();if(selectionMode)collapsed.delete('todo');return renderPolls();}if(b.hasAttribute('data-select-all')){selected=selected.size===state.lastRenderedUnvotedPolls.length?new Set():new Set(state.lastRenderedUnvotedPolls.map(p=>p.id));return renderPolls();}if(b.dataset.bulkVote)return bulkVote(b.dataset.bulkVote);});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){for(const id of ['modal-poll-detail','modal-quick-vote'])if($(id).classList.contains('open')){closeModal(id);break;}}});
  $('quick-vote-content').addEventListener('input',e=>{if(e.target.id==='quick-note'&&quick)quick.note=e.target.value;});
  $('quick-vote-content').addEventListener('click',async e=>{const b=e.target.closest('button');if(!b||!quick||busy)return;if(b.hasAttribute('data-undo-vote'))return undoVote();if(b.hasAttribute('data-quick-skip')){quick.skipped.add(quick.ids[quick.index]);quick.index++;quick.note='';return renderQuick();}if(b.hasAttribute('data-quick-prev')){let i=quick.index-1;while(i>=0&&(!state.currentEnsembleData?.polls?.[quick.ids[i]]||state.currentEnsembleData.polls[quick.ids[i]].votes?.[currentMember()]))i--;if(i>=0){quick.index=i;quick.note='';}return renderQuick();}if(b.dataset.quickVote){const q=quick,id=b.dataset.quickVote;const note=q.note;const ok=await writeVote(id,b.dataset.val,note||undefined);if(ok&&q===quick){q.answered.add(id);q.skipped.delete(id);q.index=Math.max(q.index,q.ids.indexOf(id)+1);q.note='';renderQuick();}}});
  $("poll-archive-lock-warning").addEventListener("click", (e) => {
    const unlockBtn = e.target.closest("[data-unlock-archived]");
    if (unlockBtn) {
      const arch = state.currentEnsembleData?.archivedPolls?.[unlockBtn.dataset.unlockArchived];
      closeModal("modal-poll");
      if (arch) promptRestoreArchivedPoll(arch);
      return;
    }
    if (e.target.closest("[data-goto-archived-tab]")) {
      closeModal("modal-poll");
      state.availFilterMode = "archived";
      document.querySelectorAll("[data-avail-filter]").forEach((b) => b.classList.toggle("active", b.dataset.availFilter === "archived"));
      renderPolls();
    }
  });

  $("btn-add-poll-slot").addEventListener("click", () => { haptic(); addPollSlot(); });
  $("edit-poll-date").addEventListener("change", checkEditPollArchiveLock);

  $("form-edit-poll").addEventListener("submit", async (e) => {
    e.preventDefault(); haptic();
    const pollId = $("edit-poll-id").value;
    const oldPoll = state.currentEnsembleData?.polls?.[pollId];
    if (!state.session.activeEnsembleId) return showToast(C18.t("Aucun ensemble actif."));
    if (!pollId || !oldPoll) {
      closeModal("modal-edit-poll");
      return showToast(C18.t("Ce créneau n'est plus actif (peut-être déjà archivé ou validé)."));
    }

    const dateVal = $("edit-poll-date").value;
    if (!dateVal) return showToast(C18.t("Veuillez sélectionner une date."));

    const slot = { ...readSlotRow($("edit-poll-mode-holder")), date: dateVal };
    if (slot.timeMode === "exact" && (!slot.startTime || !slot.endTime)) {
      return showToast(C18.t("Veuillez renseigner l'heure de début et de fin."));
    }
    if (findArchivedSlotMatch(slot)) return showToast(C18.t("Ce créneau a déjà été archivé."));

    const eventType = $("edit-poll-type-holder").dataset.value || "rehearsal";
    const changed = getSlotFingerprint(oldPoll) !== getSlotFingerprint(slot);
    const me = state.session.ensembles[state.session.activeEnsembleId];
    const submitBtn = $("btn-submit-edit-poll");
    submitBtn.disabled = true;

    try {
      await update(ref(db, `ensembles/${state.session.activeEnsembleId}/polls/${pollId}`), {
        ...slot,
        eventType,
        location: $("edit-poll-location").value.trim(),
        note: $("edit-poll-note").value.trim(),
        updatedAt: Date.now(),
        ...(changed ? { votes: me?.memberId ? { [me.memberId]: "yes" } : null, voteNotes: null } : {})
      });
      if (changed) {
        await hooks.publishEnsembleNotification(C18.localizedMessages(() => [C18.tt`Créneau modifié (${getEventMeta(eventType).label}) — ${state.currentEnsembleData?.name || "Cadenza"}`, C18.tt`${me?.name || C18.t("Un membre")} a modifié la proposition au ${formatDateFr(slot.date)} (${formatPollTimeLabel(slot)}). Merci de re-voter.`]));
        showToast(C18.t("Créneau modifié et votes réinitialisés."));
      } else showToast(C18.t("Informations mises à jour."));
      closeModal("modal-edit-poll");
    } catch (err) {
      handleFirebaseError(err);
    } finally {
      submitBtn.disabled = false;
    }
  });

  $("form-confirm-poll").addEventListener("submit", async (e) => {
    e.preventDefault(); haptic();
    const pollId = $("confirm-poll-id").value, poll = state.currentEnsembleData?.polls?.[pollId];
    if (!poll || !state.session.activeEnsembleId) return;
    const eventType = $("confirm-poll-type-holder").dataset.value || "rehearsal";
    const concertData = readConcertFields("confirm-poll", eventType);
    const startTime = $("confirm-poll-start").value, endTime = $("confirm-poll-end").value;
    const location = $("confirm-poll-location").value.trim() || "Lieu à confirmer", program = $("confirm-poll-program").value.trim();
    const tMeta = getEventMeta(eventType);
    try {
      const rehId = genId("reh");
      await update(ref(db, `ensembles/${state.session.activeEnsembleId}`), {
        [`rehearsals/${rehId}`]: { id: rehId, eventType, date: poll.date, startTime, endTime, ...concertData, location, program, notes: "", createdAt: Date.now() },
        [`polls/${pollId}`]: null
      });
      await hooks.publishEnsembleNotification(C18.localizedMessages(() => [C18.tt`${tMeta.label} confirmé(e) — ${state.currentEnsembleData.name}`, `${formatDateFr(poll.date)} • ${startTime}–${endTime} (${location})`]));
      closeModal("modal-confirm-poll"); showToast(C18.tt`${tMeta.label} ajouté(e) à l'agenda.`); hooks.switchTab("agenda");
    } catch (err) { handleFirebaseError(err); }
  });

  $("form-poll").addEventListener("submit", async (e) => {
    e.preventDefault(); haptic();
    const slots = getPendingProposalSlots();
    if (!slots.length) return showToast(C18.t("Veuillez sélectionner au moins une date."));
    const blocked = slots.find(findArchivedSlotMatch);
    if (blocked) { updatePollConflictsWarning(); return showToast(C18.tt`Le ${formatCompactDateFr(blocked.date)} est dans les archives : récupérez-le pour le rouvrir.`); }

    const eventType = $("poll-type-holder").dataset.value || "rehearsal";
    const location = $("poll-location").value.trim(), note = $("poll-note").value.trim(), me = state.session.ensembles[state.session.activeEnsembleId];
    const replaceId = state.refiningPollId && $("poll-replace-checkbox").checked ? state.refiningPollId : null, wasRefining = Boolean(state.refiningPollId);
    const tMeta = getEventMeta(eventType);
    try {
      const updates = {};
      slots.forEach((s) => {
        const id = genId("pol");
        updates[id] = { id, eventType, ...s, location, note, createdBy: me.name, votes: { [me.memberId]: "yes" } };
      });
      if (replaceId) updates[replaceId] = null;
      await update(ref(db, `ensembles/${state.session.activeEnsembleId}/polls`), updates);

      const ens = state.currentEnsembleData?.name || "Cadenza", s0 = slots[0];
      await hooks.publishEnsembleNotification(
        C18.localizedMessages(() => [wasRefining ? C18.tt`Horaires proposés (${tMeta.label}) — ${ens}` : slots.length === 1 ? C18.tt`Nouvelle date proposée (${tMeta.label}) — ${ens}` : C18.tt`${slots.length} dates proposées (${tMeta.label}) — ${ens}`, wasRefining ? C18.tt`${me.name} propose ${slots.length === 1 ? formatPollTimeLabel(s0) : C18.tt`${slots.length} horaires`} pour le ${formatDateFr(s0.date)}.`
          : slots.length === 1 ? C18.tt`${me.name} propose le ${formatDateFr(s0.date)} (${formatPollTimeLabel(s0)}).`
          : C18.tt`${me.name} a proposé ${slots.length} dates (${slots.map((s) => formatCompactDateFr(s.date)).join(", ")}).`])
      );
      $("form-poll").reset(); resetPollSlots(); closeModal("modal-poll");
      showToast(wasRefining ? C18.t("Horaires envoyés aux membres.") : slots.length > 1 ? C18.tt`${slots.length} dates envoyées aux membres.` : C18.t("Date envoyée aux membres."));
      state.availFilterMode = "all"; renderPolls(); hooks.switchTab("avail");
    } catch (err) { handleFirebaseError(err); }
  });

  const handlePollClick=async e=>{
    const btn=e.target.closest('button');if(!btn)return;const d=btn.dataset,polls=state.currentEnsembleData?.polls||{},arch=state.currentEnsembleData?.archivedPolls||{};
    if(btn.hasAttribute('data-empty-add-poll')){resetPollSlots();return openModal('modal-poll');}
    if(d.toggleSection){collapsed.has(d.toggleSection)?collapsed.delete(d.toggleSection):collapsed.add(d.toggleSection);return renderPolls();}
    if(d.selectPoll){selected.has(d.selectPoll)?selected.delete(d.selectPoll):selected.add(d.selectPoll);return renderPolls();}
    if(d.detailPoll){detailId=d.detailPoll;openModal('modal-poll-detail');renderDetail();$('poll-detail-content').querySelector('button')?.focus({preventScroll:true});return;}
    if(d.restoreArch)return promptRestoreArchivedPoll(arch[d.restoreArch]);if(d.delArch)return promptDeleteArchivedPoll(arch[d.delArch]);
    if(d.vote){const p=polls[d.vote];if(p?.votes?.[currentMember()]===d.val){if(btn.closest('#poll-detail-content'))closeModal('modal-poll-detail');return promptClearMyVote(p);}return writeVote(d.vote,d.val);}
    if(d.toggleMembers){state.expandedMemberLists.has(d.toggleMembers)?state.expandedMemberLists.delete(d.toggleMembers):state.expandedMemberLists.add(d.toggleMembers);return renderPolls();}
    const root=btn.closest('#poll-detail-content')||$('polls-list');
    if(d.saveNote||d.saveLoc){const key=d.saveNote?'note':'loc',id=d.saveNote||d.saveLoc,el=root.querySelector(`[data-${key}-input="${CSS.escape(id)}"]`);if(!el)return;const val=el.value;el.blur();const ok=key==='note'?await saveVoteNote(id,val):await savePollLocationSuggestion(id,val);if(ok&&draftValues.get(`${key}:${id}`)===val)draftValues.delete(`${key}:${id}`);return renderPolls();}
    if(d.pollMenu||d.refinePoll||d.counterPoll||d.confirmPoll||d.editPoll){if(btn.closest('#poll-detail-content'))closeModal('modal-poll-detail');if(d.pollMenu)return openPollActionsMenu(polls[d.pollMenu]);if(d.refinePoll)return openRefineTimeModal(polls[d.refinePoll]);if(d.counterPoll)return openCounterProposalModal(polls[d.counterPoll]);if(d.confirmPoll)return openConfirmPollModal(polls[d.confirmPoll]);if(d.editPoll)return openEditPollModal(polls[d.editPoll]);}
    if(d.remindPoll){const p=polls[d.remindPoll];if(p)return sendPollReminder(p,Object.values(state.currentEnsembleData.members||{}).filter(m=>!p.votes?.[m.id]));}
  };
  for(const root of [$('polls-list'),$('poll-detail-content')]){root.addEventListener('click',handlePollClick);root.addEventListener('input',e=>{const el=e.target;if(el.dataset.noteInput)draftValues.set(`note:${el.dataset.noteInput}`,el.value);if(el.dataset.locInput)draftValues.set(`loc:${el.dataset.locInput}`,el.value);});root.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches('.vote-note-input,.loc-inline-input')){e.preventDefault();e.target.parentElement.querySelector('button')?.click();}});}

  $("btn-open-poll").addEventListener("click", () => { resetPollSlots(); openModal("modal-poll"); });
}
