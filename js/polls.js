import {
  db, ref, set, update, remove,
  state, $, haptic, genId, esc, getEventMeta,
  showToast, handleFirebaseError,
  parseIso, formatDateFr, formatCompactDateFr, formatShortDateFr,
  formatPollTimeLabel, formatVoteLabelFr, getPollSortKey,
  getSlotFingerprint, findArchivedSlotMatch, getUnavailabilityConflictsForDate
} from "./config.js";
import { t } from "./i18n.js";
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
      ? t("poll.archivedSingleToast", { date: formatCompactDateFr(toArchive[0].date) })
      : t("poll.archivedMultiToast", { count: toArchive.length }));
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
    const timeLabel = formatPollTimeLabel(restoredPoll);
    const targetInfo = resetMemberNames.length
      ? t("poll.reopenedNotifTarget", { names: resetMemberNames.join(", ") })
      : t("poll.reopenedNotifGeneral");

    await hooks.publishEnsembleNotification(
      t("poll.reopenedNotifTitle", { type: tMeta.label, ensemble: state.currentEnsembleData?.name || "Cadenza" }),
      t("poll.reopenedNotifBody", {
        member: me?.name || t("common.aMember"),
        date: formatDateFr(restoredPoll.date),
        time: timeLabel ? ` (${timeLabel})` : "",
        targetInfo
      }),
      resetMemberIds.length ? { targetMemberIds: resetMemberIds } : {}
    );

    state.availFilterMode = "all";
    document.querySelectorAll("[data-avail-filter]").forEach((b) => b.classList.toggle("active", b.dataset.availFilter === "all"));
    state.pendingScrollToPollId = restoredPoll.id;
    showToast(t("poll.restoredToast"));
  } catch (err) { handleFirebaseError(err); }
}

export function promptRestoreArchivedPoll(archivedPoll) {
  if (!archivedPoll) return;
  const timeStr = formatPollTimeLabel(archivedPoll), tMeta = getEventMeta(archivedPoll.eventType);
  const unavailNames = archivedPoll.unavailableMembers?.length ? archivedPoll.unavailableMembers.join(", ") : t("poll.unavailableMembersFallback");
  openConfirmationModal({
    title: t("poll.restoreConfirmTitle"),
    context: `${tMeta.label} • ${formatDateFr(archivedPoll.date)}${timeStr ? ` • ${timeStr}` : ""}`,
    message: t("poll.restoreConfirmMsg", { names: unavailNames }),
    confirmLabel: t("poll.restoreConfirmBtn"),
    danger: false,
    onConfirm: () => restoreArchivedPoll(archivedPoll)
  });
}

export function promptDeleteArchivedPoll(archivedPoll) {
  if (!archivedPoll) return;
  const timeStr = formatPollTimeLabel(archivedPoll), tMeta = getEventMeta(archivedPoll.eventType);
  openConfirmationModal({
    title: t("poll.deletePermTitle"),
    context: `${tMeta.label} • ${formatDateFr(archivedPoll.date)}${timeStr ? ` • ${timeStr}` : ""}`,
    message: t("poll.deletePermMsg"),
    confirmLabel: t("common.delete"),
    danger: true,
    onConfirm: async () => {
      try {
        await remove(ref(db, `ensembles/${state.session.activeEnsembleId}/archivedPolls/${archivedPoll.id}`));
        showToast(t("poll.archiveDeletedToast"));
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
      ? { label: t("poll.actionRefineTime"), fn: () => openRefineTimeModal(poll) }
      : { label: t("poll.actionCounterTime"), fn: () => openCounterProposalModal(poll) },
    { label: t("poll.actionValidateAgenda", { yes: yesCount, total: members.length }), fn: () => openConfirmPollModal(poll) },
    ...(missing.length ? [{ label: t("poll.actionRemindMissing", { count: missing.length }), fn: () => sendPollReminder(poll, missing) }] : []),
    { label: t("poll.actionEditSlot"), fn: () => openEditPollModal(poll) },
    ...(votes[myId] ? [{ label: t("poll.actionClearMyVote"), fn: () => promptClearMyVote(poll) }] : []),
    { label: t("poll.actionDeleteSlot"), cls: "danger", fn: () => promptDeletePoll(poll) }
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
  if (!poll || !missing?.length) return showToast(t("poll.allVotedToast"));
  const names = missing.map((m) => m.name).join(", ");
  const tMeta = getEventMeta(poll.eventType);
  try {
    await update(ref(db, `ensembles/${state.session.activeEnsembleId}/polls/${poll.id}`), { lastRemindedAt: Date.now() });
    await hooks.publishEnsembleNotification(
      t("poll.remindNotifTitle", { type: tMeta.label, ensemble: state.currentEnsembleData.name }),
      t("poll.remindNotifBody", { names, date: formatDateFr(poll.date), time: formatPollTimeLabel(poll) }),
      { targetMemberIds: missing.map((m) => m.id) }
    );
    showToast(t("poll.remindSentToast", { names }));
  } catch (err) { handleFirebaseError(err); }
}

export function promptDeletePoll(poll) {
  if (!poll) return;
  const voted = Object.keys(poll.votes || {}).length;
  const timeStr = formatPollTimeLabel(poll), tMeta = getEventMeta(poll.eventType);
  openConfirmationModal({
    title: t("poll.deleteSlotTitle"),
    context: `${tMeta.label} • ${formatDateFr(poll.date)}${timeStr ? ` • ${timeStr}` : ""}${poll.location ? ` (${poll.location})` : ""}`,
    message: voted ? t("poll.deleteSlotMsgVoted", { count: voted }) : t("poll.deleteSlotMsgEmpty"),
    confirmLabel: t("common.delete"),
    onConfirm: async () => {
      try { await remove(ref(db, `ensembles/${state.session.activeEnsembleId}/polls/${poll.id}`)); showToast(t("poll.slotDeletedToast")); }
      catch (err) { handleFirebaseError(err); }
    }
  });
}

export function promptClearMyVote(poll) {
  const myId = state.session.ensembles[state.session.activeEnsembleId]?.memberId;
  const myVote = poll?.votes?.[myId];
  if (!myId || !myVote) return;
  const timeStr = formatPollTimeLabel(poll);
  openConfirmationModal({
    title: t("poll.clearVoteTitle"),
    context: `${formatDateFr(poll.date)}${timeStr ? ` • ${timeStr}` : ""}`,
    message: poll.voteNotes?.[myId]
      ? t("poll.clearVoteMsgWithNote", { vote: formatVoteLabelFr(myVote) })
      : t("poll.clearVoteMsg", { vote: formatVoteLabelFr(myVote) }),
    confirmLabel: t("poll.clearVoteBtn"),
    onConfirm: async () => {
      try {
        state.openNoteEditors.delete(poll.id);
        await Promise.all([
          remove(ref(db, `ensembles/${state.session.activeEnsembleId}/polls/${poll.id}/votes/${myId}`)),
          remove(ref(db, `ensembles/${state.session.activeEnsembleId}/polls/${poll.id}/voteNotes/${myId}`))
        ]);
        showToast(t("poll.voteClearedToast"));
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
      ? t("poll.submitMultiDates", { count: slots.length })
      : slots.length === 1
        ? t("poll.submitSingleDate", { date: formatCompactDateFr(slots[0].date) })
        : t("poll.selectAtLeastOneDate");
  }

  const lockedMatches = [];
  const lockedLines = slots.map((s) => {
    const arch = findArchivedSlotMatch(s);
    if (!arch) return "";
    lockedMatches.push(arch);
    const abs = arch.unavailableMembers?.length ? t("poll.archivedUnavailBy", { names: esc(arch.unavailableMembers.join(", ")) }) : "";
    return t("poll.archivedSlotLine", { date: esc(formatDateFr(s.date)), time: esc(formatPollTimeLabel(s)), abs });
  }).filter(Boolean);

  lockBox.classList.toggle("hidden", !lockedLines.length);
  if (lockedLines.length) {
    const restoreBtnHtml = lockedMatches.length === 1
      ? `<div style="margin-top:8px"><button type="button" class="btn-secondary btn-xs" data-unlock-archived="${esc(lockedMatches[0].id)}">${esc(t("poll.recoverArchivedBtn"))}</button></div>`
      : `<div style="margin-top:8px"><button type="button" class="btn-secondary btn-xs" data-goto-archived-tab>${esc(t("poll.viewArchivesToRecoverBtn"))}</button></div>`;
    lockBox.innerHTML = `<strong>${esc(t("poll.archivedSlotDetectedTitle"))}</strong>${lockedLines.join("<br>")}${esc(t("poll.archivedSlotRecoverHint"))}${restoreBtnHtml}`;
  } else {
    lockBox.innerHTML = "";
  }
  subBtn.disabled = slots.length === 0 || lockedLines.length > 0;

  const conflictLines = [];
  [...new Set(slots.map((s) => s.date))].forEach((d) => {
    getUnavailabilityConflictsForDate(d).forEach((c) => {
      const per = c.startDate === c.endDate
        ? formatShortDateFr(c.startDate)
        : t("unavail.rangeFromTo", { start: formatShortDateFr(c.startDate), end: formatShortDateFr(c.endDate) });
      conflictLines.push(`• <strong>${esc(formatDateFr(d))}</strong> : ${esc(c.memberName)} (${esc(c.instrument)}) ${esc(t("poll.absentTag"))} (${esc(per)}${c.reason ? ` — ${esc(c.reason)}` : ""})`);
    });
  });

  warnBox.classList.toggle("hidden", !conflictLines.length);
  warnBox.innerHTML = conflictLines.length ? `<strong>${esc(t("poll.unavailWarningTitle"))}</strong>${conflictLines.join("<br>")}` : "";
}

export function refreshPollSlotsUI() {
  const rows = $("poll-slots-container").querySelectorAll(".poll-slot-row");
  rows.forEach((r, i) => {
    r.querySelector(".slot-label").textContent = `${state.refiningFixedDate ? t("poll.timeSlotWord") : t("poll.slotWord")} ${i + 1}`;
    r.querySelector(".btn-remove-slot").classList.toggle("hidden", rows.length <= 1);
  });
  $("btn-submit-poll").textContent = state.refiningFixedDate
    ? (rows.length > 1 ? t("poll.submitMultiTimes", { count: rows.length }) : t("poll.submitSingleTime"))
    : (rows.length > 1 ? t("poll.submitMultiSlots", { count: rows.length }) : t("poll.submitSingleSlot"));
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
  row.innerHTML = `
    <div class="poll-slot-head">
      <span class="slot-label" style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">${esc(t("poll.slotWord"))}</span>
      <button type="button" class="btn-secondary btn-xs btn-remove-slot">${esc(t("common.remove"))}</button>
    </div>
    <div class="field" style="margin-bottom:10px"><label>${esc(t("form.date"))}</label><input type="date" class="slot-date" value="${esc(date)}" required /></div>
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
  $("modal-poll-title").textContent = t("modal.proposeDatesTitle");
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
  $("modal-poll-title").textContent = t("poll.refineTitle");
  $("poll-calendar-wrapper").classList.add("hidden");
  $("poll-slots-wrapper").classList.remove("hidden");
  $("poll-refine-banner").classList.remove("hidden");
  $("poll-refine-banner").innerHTML = `<div style="font-weight:600;color:var(--yes-fg);margin-bottom:2px">${esc(tMeta.label)} • ${esc(formatDateFr(poll.date))} (${esc(prev)})</div><div style="color:var(--muted)">${esc(t("poll.refinePrompt"))}</div>`;
  $("poll-replace-row").classList.remove("hidden");
  $("poll-replace-checkbox").checked = true;
  $("poll-replace-label").textContent = t("poll.replaceProposalLabel", { prev });
  $("btn-add-poll-slot").textContent = t("modal.addAnotherTimeSlot");
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
  $("modal-poll-title").textContent = t("poll.counterTitle");
  $("poll-calendar-wrapper").classList.add("hidden");
  $("poll-slots-wrapper").classList.remove("hidden");
  $("poll-refine-banner").classList.add("hidden");
  $("poll-replace-row").classList.add("hidden");
  $("btn-add-poll-slot").textContent = t("modal.addAnotherTimeSlot");
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
  warn.innerHTML = arch ? `<strong>${esc(t("poll.archivedSlotDetectedTitle"))}</strong>${esc(t("poll.editArchivedSlotWarn", { date: formatDateFr(cand.date), time: formatPollTimeLabel(cand) }))}` : "";
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
  if (!state.session.activeEnsembleId || !pollId) return;
  const val = String(rawVal || "").trim();
  const me = state.session.ensembles[state.session.activeEnsembleId];
  try {
    await update(ref(db, `ensembles/${state.session.activeEnsembleId}/polls/${pollId}`), {
      location: val,
      locationSuggestedBy: val ? (me?.name || "") : null,
      updatedAt: Date.now()
    });
    state.openLocationEditors.delete(pollId);
    showToast(val ? t("poll.locationSuggestedToast", { loc: val }) : t("poll.locationRemovedToast"));
  } catch (err) { handleFirebaseError(err); }
}

export async function saveVoteNote(pollId, rawVal) {
  const myId = state.session.ensembles[state.session.activeEnsembleId]?.memberId;
  if (!myId) return;
  const val = String(rawVal || "").trim(), r = ref(db, `ensembles/${state.session.activeEnsembleId}/polls/${pollId}/voteNotes/${myId}`);
  try {
    if (val) { await set(r, val); state.openNoteEditors.add(pollId); showToast(t("poll.noteSavedToast")); }
    else { await remove(r); state.openNoteEditors.delete(pollId); showToast(t("poll.noteRemovedToast")); }
  } catch (err) { handleFirebaseError(err); }
}

export function openConfirmPollModal(poll) {
  if (!poll) return;
  const type = poll.eventType || "rehearsal";
  $("confirm-poll-id").value = poll.id;
  setEventTypeValue($("confirm-poll-type-holder"), type, (tVal) => syncConcertFieldsVisibility("confirm-poll", tVal, "lbl-confirm-poll-start", "lbl-confirm-poll-end"));
  populateConcertFields("confirm-poll", null);
  const timeStr = formatPollTimeLabel(poll), tMeta = getEventMeta(type);
  $("confirm-poll-summary").textContent = `${tMeta.label} • ${formatDateFr(poll.date)}${timeStr ? ` • ${timeStr}` : ""}`;
  const [s, e] = poll.timeMode === "period"
    ? ({ "Matin": ["09:00", "12:00"], "Soir": ["19:30", "22:00"] }[poll.period] || ["14:00", "17:00"])
    : poll.timeMode === "day" ? (type === "concert" ? ["20:00", "22:00"] : ["14:00", "17:00"]) : [poll.startTime || "14:00", poll.endTime || "17:00"];
  $("confirm-poll-start").value = s; $("confirm-poll-end").value = e;
  if (type === "concert") $("confirm-poll-soundcheck").value = "18:30";
  $("confirm-poll-location").value = poll.location || ""; $("confirm-poll-program").value = poll.note || "";
  openModal("modal-confirm-poll");
}

export async function castPollVote(pollId, voteVal, sortedPolls, autoAdvance = false) {
  haptic();
  const myId = state.session.ensembles[state.session.activeEnsembleId]?.memberId;
  if (!myId) return;
  if (voteVal === "maybe") state.openNoteEditors.add(pollId);
  if (autoAdvance) {
    const idx = sortedPolls.findIndex((p) => p.id === pollId);
    let nextId = null;
    for (let o = 1; o < sortedPolls.length; o++) {
      const cand = sortedPolls[(idx + o) % sortedPolls.length];
      if (!cand.votes?.[myId]) { nextId = cand.id; break; }
    }
    state.pendingScrollToPollId = nextId;
    if (!nextId) showToast(t("poll.allCompletedToast"));
  }
  try { await set(ref(db, `ensembles/${state.session.activeEnsembleId}/polls/${pollId}/votes/${myId}`), voteVal); }
  catch (err) { state.pendingScrollToPollId = null; handleFirebaseError(err); }
}

export async function voteAllUnvotedYes(unvotedPolls) {
  const myId = state.session.ensembles[state.session.activeEnsembleId]?.memberId;
  if (!myId || !unvotedPolls.length) return;
  haptic();
  const updates = {};
  unvotedPolls.forEach((p) => { updates[`${p.id}/votes/${myId}`] = "yes"; });
  try {
    await update(ref(db, `ensembles/${state.session.activeEnsembleId}/polls`), updates);
    showToast(t("poll.votedAllYesToast", { count: unvotedPolls.length }));
  } catch (err) { handleFirebaseError(err); }
}

// Rendu Disponibilités (Cartes, Express & Tableau)
export function renderPolls() {
  const container = $("polls-list"), toolbar = $("avail-toolbar"), navBadge = $("nav-avail-badge");
  const pollsObj = state.currentEnsembleData.polls || {}, archList = Object.values(state.currentEnsembleData.archivedPolls || {});
  const members = Object.values(state.currentEnsembleData.members || {}), total = members.length;
  const myId = state.session.ensembles[state.session.activeEnsembleId]?.memberId;

  const activeEl = document.activeElement;
  const activeNote = activeEl?.classList?.contains("vote-note-input") ? { pollId: activeEl.dataset.noteInput, value: activeEl.value, selStart: activeEl.selectionStart } : null;

  const allPolls = smartSortPolls(Object.values(pollsObj).filter((p) => !isPollImpossibleAndComplete(p, members)), members, myId);
  const unvotedPolls = allPolls.filter((p) => !p.votes?.[myId]);
  const unvotedCount = unvotedPolls.length;
  state.lastRenderedUnvotedPolls = unvotedPolls;

  navBadge.textContent = String(unvotedCount);
  navBadge.classList.toggle("hidden", !unvotedCount);
  $("pill-filter-unvoted").textContent = unvotedCount ? t("avail.filterUnvotedCount", { count: unvotedCount }) : t("avail.filterUnvoted");
  $("pill-filter-archived").textContent = archList.length ? t("avail.filterArchivedCount", { count: archList.length }) : t("avail.filterArchived");

  if (!allPolls.length && !archList.length) {
    toolbar.classList.add("hidden");
    container.innerHTML = `<div class="empty-state"><p>${esc(t("poll.emptyNoPolls"))}</p><button type="button" class="btn-primary btn-sm" data-empty-add-poll>${esc(t("poll.emptyProposeBtn"))}</button></div>`;
    return;
  }
  toolbar.classList.remove("hidden");

  const chipHtml = (m, votes, notes) => {
    const v = votes[m.id], n = notes[m.id] || "";
    const sym = { yes: "✓", maybe: "?", no: "✕" }[v] || "○";
    return `<span class="member-chip ${v || ""}">${sym} <span class="chip-name">${esc(m.name)}</span>${n ? ` <span class="chip-note">« ${esc(n)} »</span>` : ""}</span>`;
  };

  if (state.availFilterMode === "archived") {
    if (!archList.length) {
      container.innerHTML = `<div class="empty-state"><p>${esc(t("poll.emptyNoArchives"))}</p><button type="button" class="btn-secondary btn-sm" data-reset-filter>${esc(t("poll.backToActiveBtn"))}</button></div>`;
      return;
    }
    const sortedArch = [...archList].sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
    container.innerHTML = `<div style="font-size:12.5px;color:var(--muted);margin-bottom:10px">${esc(t("poll.archivesIntro"))}</div>` + sortedArch.map((p) => {
      const v = p.votes || {}, yes = members.filter((m) => v[m.id] === "yes").length, tMeta = getEventMeta(p.eventType);
      return `<article class="card archived-card">
        <div class="poll-head-row"><h3 class="card-date">${esc(formatDateFr(p.date))}</h3><span class="consensus-badge archived">✕ ${yes}/${total}</span></div>
        <div class="poll-subline"><span class="event-type-badge ${tMeta.badgeCls}">${esc(tMeta.label)}</span><span class="time-pill ${p.timeMode === "day" ? "day-mode" : ""}">${esc(formatPollTimeLabel(p))}</span>${p.location ? `<strong>${esc(p.location)}</strong>` : ""}</div>
        ${p.note ? `<div class="card-meta">${esc(p.note)}</div>` : ""}
        <div class="member-votes-list">${members.map((m) => chipHtml(m, v, p.voteNotes || {})).join("")}</div>
        <div class="archive-lock-banner">
          <span>🔒 ${esc(t("poll.archivedBadgeLabel"))}</span>
          <div class="archive-actions-group">
            <button type="button" class="btn-primary btn-xs" data-restore-arch="${esc(p.id)}">↻ ${esc(t("poll.recoverBtnShort"))}</button>
            <button type="button" class="btn-del-subtle btn-xs" data-del-arch="${esc(p.id)}" aria-label="${esc(t("poll.deletePermAria"))}">✕</button>
          </div>
        </div>
      </article>`;
    }).join("");
    return;
  }

  if (!allPolls.length) {
    container.innerHTML = `<div class="empty-state"><p>${esc(t("poll.emptyActiveWithArchives", { count: archList.length }))}</p><div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap"><button type="button" class="btn-primary btn-sm" data-empty-add-poll>${esc(t("poll.proposeNewDatesBtn"))}</button><button type="button" class="btn-secondary btn-sm" data-go-arch>${esc(t("poll.viewArchivesCountBtn", { count: archList.length }))}</button></div></div>`;
    return;
  }

  // Bandeau Vote Express dès qu'il y a au moins 2 dates non votées
  let expressBannerHtml = "";
  if (unvotedCount >= 2) {
    const nextP = unvotedPolls[0], tMeta = getEventMeta(nextP.eventType);
    expressBannerHtml = `
      <div class="express-vote-banner">
        <div class="express-top-row">
          <span class="express-badge">${esc(t("poll.expressBadge", { count: unvotedCount }))}</span>
          <button type="button" class="btn-confirm btn-xs" data-vote-all-yes>${esc(t("poll.voteAllYesBtn", { count: unvotedCount }))}</button>
        </div>
        <div class="express-date-title">${esc(formatDateFr(nextP.date))}</div>
        <div class="poll-subline" style="margin-bottom:4px">
          <span class="event-type-badge ${tMeta.badgeCls}">${esc(tMeta.label)}</span>
          <span class="time-pill ${nextP.timeMode === "day" ? "day-mode" : ""}">${esc(formatPollTimeLabel(nextP))}</span>
          ${nextP.location ? `<strong>${esc(nextP.location)}</strong>` : ""}
        </div>
        <div class="express-vote-btns">
          <button type="button" class="vote-btn active-yes" data-express-vote="${esc(nextP.id)}" data-val="yes">${esc(t("vote.yesBtn"))}</button>
          <button type="button" class="vote-btn active-maybe" data-express-vote="${esc(nextP.id)}" data-val="maybe">${esc(t("vote.maybeBtn"))}</button>
          <button type="button" class="vote-btn active-no" data-express-vote="${esc(nextP.id)}" data-val="no">${esc(t("vote.noBtn"))}</button>
        </div>
      </div>`;
  }

  const filtered = allPolls.filter((p) => {
    const v = p.votes || {};
    if (state.availFilterMode === "unvoted") return !v[myId];
    if (state.availFilterMode === "consensus") return total > 0 && members.filter((m) => v[m.id] === "yes").length === total;
    return true;
  });
  state.lastRenderedFilteredPolls = filtered;

  if (!filtered.length) {
    container.innerHTML = expressBannerHtml + `<div class="empty-state"><p>${esc(state.availFilterMode === "unvoted" ? t("poll.emptyFilteredUnvoted") : t("poll.emptyFilteredConsensus"))}</p><button type="button" class="btn-secondary btn-sm" data-reset-filter>${esc(t("poll.showAllActiveBtn", { count: allPolls.length }))}</button></div>`;
    return;
  }

  if (state.availViewMode === "express") return renderPollsExpressList(container, expressBannerHtml, filtered, members, myId);
  if (state.availViewMode === "table") return renderPollsTable(container, expressBannerHtml, filtered, members, myId);

  // Regroupement par date des créneaux proposés le même jour
  const dayGroups = [], groupsByDate = new Map();
  filtered.forEach((p) => {
    if (!groupsByDate.has(p.date)) {
      const grp = { date: p.date, slots: [] };
      groupsByDate.set(p.date, grp);
      dayGroups.push(grp);
    }
    groupsByDate.get(p.date).slots.push(p);
  });

  // Mode Cartes
  container.innerHTML = expressBannerHtml + dayGroups.map((grp) => {
    const sortedSlots = [...grp.slots].sort((a, b) => getPollSortKey(a).localeCompare(getPollSortKey(b)));
    const isMultiSlot = sortedSlots.length > 1;

    let selectedId = state.activeSlotByDate.get(grp.date);
    if (!selectedId || !sortedSlots.some((s) => s.id === selectedId)) {
      const defaultSlot = sortedSlots.find((s) => !s.votes?.[myId])
        || sortedSlots.find((s) => total > 0 && members.filter((m) => s.votes?.[m.id] === "yes").length === total)
        || sortedSlots[0];
      selectedId = defaultSlot.id;
      state.activeSlotByDate.set(grp.date, selectedId);
    }
    const p = sortedSlots.find((s) => s.id === selectedId) || sortedSlots[0];

    const v = p.votes || {}, notes = p.voteNotes || {}, myVote = v[myId] || "", myNote = notes[myId] || "";
    const yes = members.filter((m) => v[m.id] === "yes").length, missing = members.filter((m) => !v[m.id]);
    const full = total > 0 && yes === total, majority = !full && total > 0 && yes >= Math.ceil(total * 0.75);
    const broad = p.timeMode === "day" || p.timeMode === "period";
    const tMeta = getEventMeta(p.eventType);
    const rank = { yes: 1, maybe: 2, no: 3 };
    const topBar = members.map((m) => v[m.id] || "pending").sort((a, b) => (rank[a] || 4) - (rank[b] || 4)).map((st) => `<span class="poll-top-seg ${st}"></span>`).join("");

    const anyUnvotedInGroup = sortedSlots.some((s) => !s.votes?.[myId]);
    const anyFullInGroup = sortedSlots.some((s) => total > 0 && members.filter((m) => s.votes?.[m.id] === "yes").length === total);

    const daySlotsTabsHtml = isMultiSlot ? `
      <div class="day-slots-tabs" role="tablist" aria-label="${esc(t("poll.daySlotsAria"))}">
        ${sortedSlots.map((s) => {
          const sv = s.votes || {};
          const syes = members.filter((m) => sv[m.id] === "yes").length;
          const sfull = total > 0 && syes === total;
          const smy = sv[myId] || "";
          const sym = { yes: "✓", maybe: "?", no: "✕" }[smy] || "○";
          const isAct = s.id === p.id;
          return `<button type="button" class="day-slot-tab ${isAct ? "active" : ""} ${sfull ? "consensus" : ""}" data-select-day-slot="${esc(grp.date)}" data-slot-id="${esc(s.id)}">
            <span>${esc(formatPollTimeLabel(s))}</span>
            <span style="display:inline-flex;align-items:center;gap:4px">
              <span style="font-size:11px;opacity:.85">${sfull ? "★" : `${syes}/${total}`}</span>
              <span class="slot-tab-vote-dot ${smy}">${sym}</span>
            </span>
          </button>`;
        }).join("")}
      </div>` : "";

    const conflicts = getUnavailabilityConflictsForDate(p.date).filter((c) => v[c.memberId] !== "yes");
    const unavailHtml = conflicts.length ? `<div class="unavail-notice">${esc(t("poll.absencePrefix"))} ${conflicts.map((c) => `<strong>${esc(c.memberName)}</strong>${c.reason ? ` (${esc(c.reason)})` : ""}`).join(", ")}</div>` : "";

    const collapse = total > 6 && !state.expandedMemberLists.has(p.id);
    let chips = "";
    if (collapse) {
      const plainYes = members.filter((m) => v[m.id] === "yes" && !notes[m.id]);
      const notable = members.filter((m) => v[m.id] !== "yes" || Boolean(notes[m.id]));
      if (plainYes.length) chips += `<button type="button" class="member-chip yes summary-toggle" data-toggle-members="${esc(p.id)}">✓ ${plainYes.length} ${esc(t("poll.availShort"))} ▾</button>`;
      chips += notable.map((m) => chipHtml(m, v, notes)).join("");
    } else {
      chips = members.map((m) => chipHtml(m, v, notes)).join("") + (total > 6 ? `<button type="button" class="member-chip summary-toggle" data-toggle-members="${esc(p.id)}">${esc(t("poll.collapseBtn"))} ▴</button>` : "");
    }

    const showNote = Boolean(myNote) || state.openNoteEditors.has(p.id) || activeNote?.pollId === p.id;
    const noteHtml = showNote
      ? `<div class="vote-note-bar"><input type="text" class="vote-note-input" data-note-input="${esc(p.id)}" maxlength="90" placeholder="${esc(t("poll.noteInputPlaceholder"))}" value="${esc(myNote)}" /><button type="button" class="btn-secondary btn-xs" data-save-note="${esc(p.id)}">${esc(t("common.ok"))}</button></div>`
      : `<div class="note-trigger-row"><button type="button" class="btn-add-note-link" data-open-note="${esc(p.id)}">+ ${esc(t("poll.addNoteBtn"))}</button></div>`;

    const showLocBar = state.openLocationEditors.has(p.id);
    const locHtml = showLocBar
      ? `<div class="loc-inline-bar"><input type="text" class="loc-inline-input" data-loc-input="${esc(p.id)}" maxlength="70" placeholder="${esc(t("poll.locInputPlaceholder"))}" value="${esc(p.location || "")}" /><button type="button" class="btn-secondary btn-xs" data-save-loc="${esc(p.id)}">${esc(t("common.ok"))}</button><button type="button" class="btn-secondary btn-xs" data-cancel-loc="${esc(p.id)}">✕</button></div>`
      : "";

    const locBadgeHtml = p.location
      ? `<button type="button" class="btn-suggest-loc" data-open-loc="${esc(p.id)}" title="${esc(t("poll.suggestLocTitleAttr"))}">📍 ${esc(p.location)}${p.locationSuggestedBy ? ` (${esc(p.locationSuggestedBy)})` : ""}</button>`
      : `<button type="button" class="btn-suggest-loc" data-open-loc="${esc(p.id)}">+ ${esc(t("poll.suggestLocBtn"))}</button>`;

    const mainBtn = full && broad
      ? `<button type="button" class="btn-confirm btn-sm" data-confirm-poll="${esc(p.id)}">${esc(t("poll.validateChooseTimeBtn"))}</button><button type="button" class="btn-secondary btn-sm" data-refine-poll="${esc(p.id)}">${esc(t("poll.pollTimeBtn"))}</button>`
      : full ? `<button type="button" class="btn-confirm btn-sm" data-confirm-poll="${esc(p.id)}">${esc(t("poll.validateSlotBtn"))}</button>`
      : missing.length ? `<button type="button" class="btn-secondary btn-sm" data-remind-poll="${esc(p.id)}">${esc(t("poll.remindCountBtn", { count: missing.length }))}</button>`
      : `<button type="button" class="btn-secondary btn-sm" data-confirm-poll="${esc(p.id)}">${esc(t("poll.validateBtn"))}</button>`;

    return `<article class="card poll-card ${anyFullInGroup ? "consensus-ready" : ""} ${anyUnvotedInGroup ? "unvoted-highlight" : ""}" data-poll-card="${esc(p.id)}" data-day-card="${esc(grp.date)}">
      <div class="poll-top-bar" aria-hidden="true">${topBar}</div>
      <div class="poll-head-row">
        <h3 class="card-date">${esc(formatDateFr(p.date))}</h3>
        <span class="consensus-badge ${full ? "full" : majority ? "partial-good" : ""}">${full ? `★ ${yes}/${total}` : `${yes}/${total}`}</span>
      </div>
      ${daySlotsTabsHtml}
      <div class="poll-subline">
        <span class="event-type-badge ${tMeta.badgeCls}">${esc(tMeta.label)}</span>
        ${!isMultiSlot ? `<span class="time-pill ${p.timeMode === "day" ? "day-mode" : ""}">${esc(formatPollTimeLabel(p))}</span>` : ""}
        ${locBadgeHtml}
        ${p.note ? `<span>• ${esc(p.note)}</span>` : ""}
      </div>
      ${locHtml}
      ${unavailHtml}
      <div class="vote-group">
        <button type="button" class="vote-btn ${myVote === "yes" ? "active-yes" : ""}" data-vote="${esc(p.id)}" data-val="yes">${esc(t("vote.yesBtn"))}</button>
        <button type="button" class="vote-btn ${myVote === "maybe" ? "active-maybe" : ""}" data-vote="${esc(p.id)}" data-val="maybe">${esc(t("vote.maybeBtn"))}</button>
        <button type="button" class="vote-btn ${myVote === "no" ? "active-no" : ""}" data-vote="${esc(p.id)}" data-val="no">${esc(t("vote.noBtn"))}</button>
      </div>
      ${noteHtml}
      <div class="member-votes-list">${chips}</div>
      <div class="poll-footer"><div class="poll-footer-main">${mainBtn}</div><button type="button" class="btn-secondary btn-more-dots" data-poll-menu="${esc(p.id)}" aria-label="${esc(t("poll.moreOptionsAria"))}">•••</button></div>
    </article>`;
  }).join("");

  if (activeNote) {
    const inp = container.querySelector(`.vote-note-input[data-note-input="${CSS.escape(activeNote.pollId)}"]`);
    if (inp) { inp.value = activeNote.value; inp.focus(); if (typeof activeNote.selStart === "number") inp.setSelectionRange(activeNote.selStart, activeNote.selStart); }
  }
  if (state.pendingScrollToPollId) {
    const targetPoll = filtered.find((x) => x.id === state.pendingScrollToPollId);
    const card = container.querySelector(`[data-poll-card="${CSS.escape(state.pendingScrollToPollId)}"]`)
      || (targetPoll ? container.querySelector(`[data-day-card="${CSS.escape(targetPoll.date)}"]`) : null);
    state.pendingScrollToPollId = null;
    if (card) requestAnimationFrame(() => { card.scrollIntoView({ behavior: "smooth", block: "center" }); card.classList.add("just-focused"); setTimeout(() => card.classList.remove("just-focused"), 1200); });
  }
}

export function renderPollsExpressList(container, expressBannerHtml, filtered, members, myId) {
  const total = members.length;
  const rows = filtered.map((p) => {
    const v = p.votes || {}, myVote = v[myId] || "";
    const yes = members.filter((m) => v[m.id] === "yes").length;
    const full = total > 0 && yes === total;
    const tMeta = getEventMeta(p.eventType);
    return `
      <div class="express-list-row ${full ? "consensus" : ""} ${!myVote ? "unvoted" : ""}">
        <div class="express-row-info">
          <div class="express-row-date">
            <span>${esc(formatCompactDateFr(p.date))}</span>
            <span class="event-type-badge ${tMeta.badgeCls}" style="font-size:10px;padding:1px 5px">${esc(tMeta.label)}</span>
            <span class="consensus-badge ${full ? "full" : ""}" style="font-size:10.5px;padding:1px 6px">${full ? `★ ${yes}/${total}` : `${yes}/${total}`}</span>
          </div>
          <div class="express-row-meta">
            <span>${esc(formatPollTimeLabel(p))}</span>
            ${p.location ? `<span>• ${esc(p.location)}</span>` : ""}
          </div>
        </div>
        <div class="express-row-btns">
          <button type="button" class="mini-vbtn ${myVote === "yes" ? "active-yes" : ""}" data-express-vote="${esc(p.id)}" data-val="yes" aria-label="${esc(t("vote.yesShort"))}">✓</button>
          <button type="button" class="mini-vbtn ${myVote === "maybe" ? "active-maybe" : ""}" data-express-vote="${esc(p.id)}" data-val="maybe" aria-label="${esc(t("vote.maybeShort"))}">?</button>
          <button type="button" class="mini-vbtn ${myVote === "no" ? "active-no" : ""}" data-express-vote="${esc(p.id)}" data-val="no" aria-label="${esc(t("vote.noShort"))}">✕</button>
          <button type="button" class="btn-secondary btn-more-dots" style="height:34px" data-poll-menu="${esc(p.id)}" aria-label="${esc(t("poll.optionsAria"))}">•••</button>
        </div>
      </div>`;
  }).join("");

  container.innerHTML = expressBannerHtml + `<div class="card express-list-card">${rows}</div>`;
}

export function renderPollsTable(container, expressBannerHtml, filtered, members, myId) {
  const total = members.length;
  const ordered = [...members.filter((m) => m.id === myId), ...members.filter((m) => m.id !== myId)];
  const notesList = [];

  const rows = filtered.map((p) => {
    const v = p.votes || {}, notes = p.voteNotes || {}, yes = members.filter((m) => v[m.id] === "yes").length;
    const full = total > 0 && yes === total, broad = p.timeMode === "day" || p.timeMode === "period", timeStr = formatPollTimeLabel(p);
    const tMeta = getEventMeta(p.eventType);
    members.forEach((m) => notes[m.id] && notesList.push({ date: formatCompactDateFr(p.date), time: timeStr, member: m.name, note: notes[m.id] }));
    const conflicts = getUnavailabilityConflictsForDate(p.date).filter((c) => v[c.memberId] !== "yes");

    const cells = ordered.map((m) => {
      const val = v[m.id] || "", sym = { yes: "✓", maybe: "?", no: "✕" }[val] || "○";
      const dot = notes[m.id] ? `<span class="matrix-note-dot" title="${esc(notes[m.id])}"></span>` : "";
      const badge = `<span class="matrix-cell-badge ${val}">${sym}${dot}</span>`;
      return `<td>${m.id === myId ? `<button type="button" class="matrix-cell-btn" data-matrix-vote="${esc(p.id)}" data-cur="${esc(val)}">${badge}</button>` : badge}</td>`;
    }).join("");

    const altBtn = broad
      ? `<button type="button" class="${full ? "btn-confirm" : "btn-secondary"} btn-xs" data-refine-poll="${esc(p.id)}">${esc(t("poll.tableTimesShort"))}</button>`
      : `<button type="button" class="btn-secondary btn-xs" data-counter-poll="${esc(p.id)}">+ ${esc(t("poll.tableTimeShort"))}</button>`;

    return `<tr class="${full ? "row-consensus" : ""}">
      <td>
        <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
          <span style="font-weight:600;text-transform:capitalize">${esc(formatCompactDateFr(p.date))}</span>
          <span class="event-type-badge ${tMeta.badgeCls}" style="font-size:10px;padding:1px 5px">${esc(tMeta.label)}</span>
        </div>
        <div style="font-size:11.5px;color:${p.timeMode === "day" ? "var(--muted)" : "var(--accent-fg)"};font-weight:500">${esc(timeStr)}${p.location ? ` • ${esc(p.location)}` : ""}</div>
        ${conflicts.length ? `<div style="font-size:11px;color:var(--no-fg);font-weight:600">${esc(t("poll.absencePrefix"))} ${esc(conflicts.map((c) => c.memberName).join(", "))}</div>` : ""}
      </td>
      <td style="font-weight:700;color:${full ? "var(--yes-fg)" : "var(--fg)"};white-space:nowrap">${full ? `★ ${yes}/${total}` : `${yes}/${total}`}</td>
      ${cells}
      <td style="white-space:nowrap;text-align:right;padding-right:12px">
        <button type="button" class="btn-secondary btn-xs" data-edit-poll="${esc(p.id)}">${esc(t("poll.tableEditShort"))}</button> ${altBtn}
        <button type="button" class="${full && !broad ? "btn-confirm" : "btn-primary"} btn-xs" data-confirm-poll="${esc(p.id)}">${esc(t("poll.validateBtn"))}</button>
        <button type="button" class="btn-del-subtle btn-xs" data-del-poll="${esc(p.id)}">${esc(t("poll.tableDelShort"))}</button>
      </td>
    </tr>`;
  }).join("");

  container.innerHTML = expressBannerHtml + `
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">${t("poll.tableHintHtml")}</div>
    <div class="card matrix-card"><div class="matrix-scroll"><table class="avail-matrix">
      <thead><tr><th>${esc(t("poll.tableColDateType"))}</th><th>${esc(t("poll.tableColScore"))}</th>${ordered.map((m) => `<th class="${m.id === myId ? "col-me" : ""}"><div>${esc(m.name)}${m.id === myId ? ` ${esc(t("common.youParen"))}` : ""}</div><div style="font-weight:400;font-size:10.5px;color:var(--muted)">${esc(m.instrument)}</div></th>`).join("")}<th style="text-align:right;padding-right:12px">${esc(t("poll.tableColActions"))}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div></div>
    ${notesList.length ? `<div class="card" style="padding:12px 14px"><div class="card-kicker" style="margin-bottom:6px">${esc(t("poll.musicianNotesKicker"))}</div>${notesList.map((n) => `<div style="font-size:13px;padding:3px 0"><strong>${esc(n.member)}</strong> (${esc(n.date)}, ${esc(n.time)}) : <em>« ${esc(n.note)} »</em></div>`).join("")}</div>` : ""}`;
}

export function initPollsListeners() {
  document.querySelectorAll("[data-avail-view]").forEach((btn) => btn.addEventListener("click", () => {
    haptic(); state.availViewMode = btn.dataset.availView;
    document.querySelectorAll("[data-avail-view]").forEach((b) => b.classList.toggle("active", b.dataset.availView === state.availViewMode));
    renderPolls();
  }));

  document.querySelectorAll("[data-avail-filter]").forEach((btn) => btn.addEventListener("click", () => {
    haptic(); state.availFilterMode = btn.dataset.availFilter;
    document.querySelectorAll("[data-avail-filter]").forEach((b) => b.classList.toggle("active", b.dataset.availFilter === state.availFilterMode));
    renderPolls();
  }));

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
    if (!state.session.activeEnsembleId) return showToast(t("poll.noActiveEnsembleToast"));
    if (!pollId || !oldPoll) {
      closeModal("modal-edit-poll");
      return showToast(t("poll.slotNoLongerActiveToast"));
    }

    const dateVal = $("edit-poll-date").value;
    if (!dateVal) return showToast(t("poll.selectDateRequiredToast"));

    const slot = { ...readSlotRow($("edit-poll-mode-holder")), date: dateVal };
    if (slot.timeMode === "exact" && (!slot.startTime || !slot.endTime)) {
      return showToast(t("poll.selectTimesRequiredToast"));
    }
    if (findArchivedSlotMatch(slot)) return showToast(t("poll.alreadyArchivedToast"));

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
        await hooks.publishEnsembleNotification(
          t("poll.slotModifiedNotifTitle", { type: getEventMeta(eventType).label, ensemble: state.currentEnsembleData?.name || "Cadenza" }),
          t("poll.slotModifiedNotifBody", { member: me?.name || t("common.aMember"), date: formatDateFr(slot.date), time: formatPollTimeLabel(slot) })
        );
        showToast(t("poll.slotModifiedToast"));
      } else showToast(t("poll.infoUpdatedToast"));
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
    const location = $("confirm-poll-location").value.trim() || t("form.locationToConfirm"), program = $("confirm-poll-program").value.trim();
    const tMeta = getEventMeta(eventType);
    try {
      const rehId = genId("reh");
      await set(ref(db, `ensembles/${state.session.activeEnsembleId}/rehearsals/${rehId}`), {
        id: rehId, eventType, date: poll.date, startTime, endTime, ...concertData, location, program, notes: "", createdAt: Date.now()
      });
      await remove(ref(db, `ensembles/${state.session.activeEnsembleId}/polls/${pollId}`));
      await hooks.publishEnsembleNotification(
        t("poll.confirmedNotifTitle", { type: tMeta.label, ensemble: state.currentEnsembleData.name }),
        `${formatDateFr(poll.date)} • ${startTime}–${endTime} (${location})`
      );
      closeModal("modal-confirm-poll"); showToast(t("poll.confirmedAddedToast", { type: tMeta.label })); hooks.switchTab("agenda");
    } catch (err) { handleFirebaseError(err); }
  });

  $("form-poll").addEventListener("submit", async (e) => {
    e.preventDefault(); haptic();
    const slots = getPendingProposalSlots();
    if (!slots.length) return showToast(t("poll.selectOneDateToast"));
    const blocked = slots.find(findArchivedSlotMatch);
    if (blocked) { updatePollConflictsWarning(); return showToast(t("poll.blockedArchivedToast", { date: formatCompactDateFr(blocked.date) })); }

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
        wasRefining
          ? t("poll.proposedTimesNotifTitle", { type: tMeta.label, ensemble: ens })
          : slots.length === 1
            ? t("poll.proposedSingleNotifTitle", { type: tMeta.label, ensemble: ens })
            : t("poll.proposedMultiNotifTitle", { count: slots.length, type: tMeta.label, ensemble: ens }),
        wasRefining
          ? (slots.length === 1
            ? t("poll.proposedTimesSingleBody", { member: me.name, time: formatPollTimeLabel(s0), date: formatDateFr(s0.date) })
            : t("poll.proposedTimesMultiBody", { member: me.name, count: slots.length, date: formatDateFr(s0.date) }))
          : slots.length === 1
            ? t("poll.proposedSingleBody", { member: me.name, date: formatDateFr(s0.date), time: formatPollTimeLabel(s0) })
            : t("poll.proposedMultiBody", { member: me.name, count: slots.length, dates: slots.map((s) => formatCompactDateFr(s.date)).join(", ") })
      );
      $("form-poll").reset(); resetPollSlots(); closeModal("modal-poll");
      showToast(wasRefining
        ? t("poll.sentTimesToast")
        : slots.length > 1
          ? t("poll.sentMultiDatesToast", { count: slots.length })
          : t("poll.sentSingleDateToast"));
      hooks.switchTab("avail");
    } catch (err) { handleFirebaseError(err); }
  });

  $("polls-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const pollsObj = state.currentEnsembleData?.polls || {}, archObj = state.currentEnsembleData?.archivedPolls || {};
    const myId = state.session.ensembles[state.session.activeEnsembleId]?.memberId;

    if (btn.hasAttribute("data-empty-add-poll")) { resetPollSlots(); return openModal("modal-poll"); }
    if (btn.hasAttribute("data-vote-all-yes")) return voteAllUnvotedYes(state.lastRenderedUnvotedPolls);
    if (btn.dataset.selectDaySlot) {
      haptic();
      state.activeSlotByDate.set(btn.dataset.selectDaySlot, btn.dataset.slotId);
      return renderPolls();
    }
    if (btn.hasAttribute("data-reset-filter") || btn.hasAttribute("data-go-arch")) {
      state.availFilterMode = btn.hasAttribute("data-go-arch") ? "archived" : "all";
      document.querySelectorAll("[data-avail-filter]").forEach((b) => b.classList.toggle("active", b.dataset.availFilter === state.availFilterMode));
      return renderPolls();
    }
    if (btn.dataset.restoreArch) return promptRestoreArchivedPoll(archObj[btn.dataset.restoreArch]);
    if (btn.dataset.delArch) return promptDeleteArchivedPoll(archObj[btn.dataset.delArch]);
    if (btn.dataset.expressVote) {
      const p = pollsObj[btn.dataset.expressVote];
      return p?.votes?.[myId] === btn.dataset.val
        ? promptClearMyVote(p)
        : castPollVote(btn.dataset.expressVote, btn.dataset.val, state.lastRenderedFilteredPolls, false);
    }
    if (btn.dataset.openLoc) {
      haptic(); const id = btn.dataset.openLoc; state.openLocationEditors.add(id); renderPolls();
      return requestAnimationFrame(() => $("polls-list").querySelector(`.loc-inline-input[data-loc-input="${CSS.escape(id)}"]`)?.focus());
    }
    if (btn.dataset.cancelLoc) {
      haptic(); state.openLocationEditors.delete(btn.dataset.cancelLoc); return renderPolls();
    }
    if (btn.dataset.saveLoc) {
      haptic(); const id = btn.dataset.saveLoc;
      return savePollLocationSuggestion(id, $("polls-list").querySelector(`.loc-inline-input[data-loc-input="${CSS.escape(id)}"]`)?.value || "");
    }
    if (btn.dataset.vote) {
      const p = pollsObj[btn.dataset.vote];
      return p?.votes?.[myId] === btn.dataset.val ? promptClearMyVote(p) : castPollVote(btn.dataset.vote, btn.dataset.val, state.lastRenderedFilteredPolls, true);
    }
    if (btn.dataset.matrixVote) {
      const next = { yes: "maybe", maybe: "no" }[btn.dataset.cur] || "yes";
      return castPollVote(btn.dataset.matrixVote, next, state.lastRenderedFilteredPolls, false);
    }
    if (btn.dataset.openNote) {
      haptic(); const id = btn.dataset.openNote; state.openNoteEditors.add(id); renderPolls();
      return requestAnimationFrame(() => $("polls-list").querySelector(`.vote-note-input[data-note-input="${CSS.escape(id)}"]`)?.focus());
    }
    if (btn.dataset.saveNote) {
      haptic(); const id = btn.dataset.saveNote;
      return saveVoteNote(id, $("polls-list").querySelector(`.vote-note-input[data-note-input="${CSS.escape(id)}"]`)?.value || "");
    }
    if (btn.dataset.toggleMembers) {
      haptic(); const id = btn.dataset.toggleMembers;
      state.expandedMemberLists.has(id) ? state.expandedMemberLists.delete(id) : state.expandedMemberLists.add(id);
      return renderPolls();
    }
    if (btn.dataset.pollMenu) return openPollActionsMenu(pollsObj[btn.dataset.pollMenu]);
    if (btn.dataset.refinePoll) return openRefineTimeModal(pollsObj[btn.dataset.refinePoll]);
    if (btn.dataset.counterPoll) return openCounterProposalModal(pollsObj[btn.dataset.counterPoll]);
    if (btn.dataset.editPoll) return openEditPollModal(pollsObj[btn.dataset.editPoll]);
    if (btn.dataset.confirmPoll) return openConfirmPollModal(pollsObj[btn.dataset.confirmPoll]);
    if (btn.dataset.delPoll) return promptDeletePoll(pollsObj[btn.dataset.delPoll]);
    if (btn.dataset.remindPoll) {
      const p = pollsObj[btn.dataset.remindPoll];
      if (p) sendPollReminder(p, Object.values(state.currentEnsembleData?.members || {}).filter((m) => !p.votes?.[m.id]));
    }
  });

  $("polls-list").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.classList?.contains("vote-note-input")) {
      e.preventDefault(); haptic(); e.target.blur(); saveVoteNote(e.target.dataset.noteInput, e.target.value);
    }
    if (e.key === "Enter" && e.target.classList?.contains("loc-inline-input")) {
      e.preventDefault(); haptic(); e.target.blur(); savePollLocationSuggestion(e.target.dataset.locInput, e.target.value);
    }
  });

  $("btn-open-poll").addEventListener("click", () => { resetPollSlots(); openModal("modal-poll"); });
}
