import {
  state, $, haptic, esc, EVENT_TYPES,
  formatCompactDateFr, getInviteUrl, getTransferUrl, getUnavailabilityConflictsForDate
} from "./config.js";
import { t, getDateLocale } from "./i18n.js";

let hooks = {
  updatePollConflictsWarning: () => {},
  checkEditPollArchiveLock: () => {},
  resetPollSlots: () => {},
  dismissWhatsNewModal: () => {}
};

export function registerUiHooks(h) {
  hooks = { ...hooks, ...h };
}

// Composants réutilisables : Sélecteur de type d'événement & champs Concert
export function buildTypeSelectorHtml(label = "") {
  const resolvedLabel = label || t("form.eventNature");
  return `
    <div class="field" style="margin-bottom: 10px;">
      <label>${esc(resolvedLabel)}</label>
      <div class="type-selector-group">
        <button type="button" class="type-btn active" data-etype="rehearsal">${esc(t("eventType.rehearsal"))}</button>
        <button type="button" class="type-btn" data-etype="cours">${esc(t("eventType.cours"))}</button>
        <button type="button" class="type-btn" data-etype="concert">${esc(t("eventType.concert"))}</button>
      </div>
    </div>`;
}

export function buildConcertFieldsHtml(prefix) {
  return `
    <div id="${prefix}-concert-box" class="concert-fields-box hidden">
      <div class="concert-box-title">${esc(t("concert.infoTitle"))}</div>
      <div class="row-2" style="margin-bottom: 10px;">
        <div class="field" style="margin-bottom: 0;">
          <label for="${prefix}-soundcheck">${esc(t("concert.soundcheck"))}</label>
          <input type="time" id="${prefix}-soundcheck" />
        </div>
        <div class="field" style="margin-bottom: 0;">
          <label for="${prefix}-fee">${esc(t("concert.fee"))}</label>
          <input type="text" id="${prefix}-fee" placeholder="${esc(t("concert.feePlaceholder"))}" />
        </div>
      </div>
      <div class="field" style="margin-bottom: 0;">
        <label for="${prefix}-dresscode">${esc(t("concert.dressCode"))}</label>
        <input type="text" id="${prefix}-dresscode" placeholder="${esc(t("concert.dressCodePlaceholder"))}" />
      </div>
    </div>`;
}

export function bindTypeSelector(holder, onChange) {
  const currentVal = holder.dataset.value || "rehearsal";
  holder.innerHTML = buildTypeSelectorHtml(holder.dataset.label || "");
  holder.dataset.value = currentVal;
  holder.querySelectorAll(".type-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.etype === currentVal);
    btn.addEventListener("click", () => {
      haptic();
      setEventTypeValue(holder, btn.dataset.etype, onChange);
    });
  });
}

export function setEventTypeValue(holder, type, onChange) {
  const valid = EVENT_TYPES[type] ? type : "rehearsal";
  holder.dataset.value = valid;
  holder.querySelectorAll(".type-btn").forEach((b) => b.classList.toggle("active", b.dataset.etype === valid));
  if (onChange) onChange(valid);
}

export function syncConcertFieldsVisibility(prefix, type, startLabelId, endLabelId) {
  const box = $(`${prefix}-concert-box`);
  const isConcert = type === "concert";
  if (box) box.classList.toggle("hidden", !isConcert);
  if (startLabelId && $(startLabelId)) $(startLabelId).textContent = isConcert ? t("concert.startConcert") : t("form.start");
  if (endLabelId && $(endLabelId)) $(endLabelId).textContent = isConcert ? t("concert.endEstimated") : t("form.end");
}

export function readConcertFields(prefix, type) {
  if (type !== "concert") return { soundcheckTime: "", dressCode: "", concertFee: "" };
  return {
    soundcheckTime: $(`${prefix}-soundcheck`)?.value || "",
    dressCode: $(`${prefix}-dresscode`)?.value.trim() || "",
    concertFee: $(`${prefix}-fee`)?.value.trim() || ""
  };
}

export function populateConcertFields(prefix, item) {
  if ($(`${prefix}-soundcheck`)) $(`${prefix}-soundcheck`).value = item?.soundcheckTime || "";
  if ($(`${prefix}-dresscode`)) $(`${prefix}-dresscode`).value = item?.dressCode || "";
  if ($(`${prefix}-fee`)) $(`${prefix}-fee`).value = item?.concertFee || "";
}

// Composant réutilisable : sélecteur de mode horaire
export function buildModeSelectorHtml(startVal = "14:00", endVal = "17:00") {
  return `
    <div class="field" style="margin-bottom: 10px;">
      <label>${esc(t("form.timeOrPeriod"))}</label>
      <div class="slot-mode-group">
        <button type="button" class="slot-mode-btn span-full" data-mode="day" data-period="">${esc(t("time.fullDayNoTime"))}</button>
        <button type="button" class="slot-mode-btn" data-mode="period" data-period="Matin">${esc(t("time.morning"))}</button>
        <button type="button" class="slot-mode-btn" data-mode="period" data-period="Après-midi">${esc(t("time.afternoon"))}</button>
        <button type="button" class="slot-mode-btn" data-mode="period" data-period="Soir">${esc(t("time.evening"))}</button>
        <button type="button" class="slot-mode-btn span-full" data-mode="exact" data-period="">${esc(t("time.exactTime"))}</button>
      </div>
    </div>
    <div class="row-2 slot-exact-times" style="margin-bottom: 12px;">
      <div class="field" style="margin-bottom: 0;"><label>${esc(t("form.start"))}</label><input type="time" class="slot-start" value="${esc(startVal)}" /></div>
      <div class="field" style="margin-bottom: 0;"><label>${esc(t("form.end"))}</label><input type="time" class="slot-end" value="${esc(endVal)}" /></div>
    </div>`;
}

export function applyModeState(host, mode, period, onChange) {
  host.dataset.mode = mode;
  host.dataset.period = mode === "period" ? period : "";
  const exactBox = host.querySelector(".slot-exact-times");
  const sInp = host.querySelector(".slot-start"), eInp = host.querySelector(".slot-end");
  const isExact = mode === "exact";
  exactBox.classList.toggle("hidden", !isExact);
  sInp.required = eInp.required = isExact;
  sInp.disabled = eInp.disabled = !isExact;
  if (isExact) {
    if (!sInp.value) sInp.value = "14:00";
    if (!eInp.value) eInp.value = "17:00";
  }
  host.querySelectorAll(".slot-mode-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode && (mode !== "period" || b.dataset.period === period));
  });
  if (onChange) onChange();
}

export function bindModeSelector(host, onChange) {
  host.querySelectorAll(".slot-mode-btn").forEach((b) => {
    b.addEventListener("click", () => {
      haptic();
      applyModeState(host, b.dataset.mode, b.dataset.period || "Après-midi", onChange);
    });
  });
  host.querySelector(".slot-start").addEventListener("change", () => onChange && onChange());
  host.querySelector(".slot-end").addEventListener("change", () => onChange && onChange());
}

export function initFormSelectors() {
  $("reh-concert-fields").innerHTML = buildConcertFieldsHtml("reh");
  $("edit-reh-concert-fields").innerHTML = buildConcertFieldsHtml("edit-reh");
  $("confirm-poll-concert-fields").innerHTML = buildConcertFieldsHtml("confirm-poll");

  bindTypeSelector($("reh-type-holder"), (tVal) => {
    syncConcertFieldsVisibility("reh", tVal, "lbl-reh-start", "lbl-reh-end");
    $("modal-reh-title").textContent = tVal === "concert" ? t("modal.planConcertTitle") : tVal === "cours" ? t("modal.planCoursTitle") : t("modal.planRehearsalTitle");
    if (tVal === "concert" && $("reh-start").value === "14:00") { $("reh-start").value = "20:00"; $("reh-end").value = "22:00"; $("reh-soundcheck").value = "18:30"; }
  });

  bindTypeSelector($("edit-reh-type-holder"), (tVal) => {
    syncConcertFieldsVisibility("edit-reh", tVal, "lbl-edit-reh-start", "lbl-edit-reh-end");
    $("modal-edit-reh-title").textContent = tVal === "concert" ? t("modal.editConcertTitle") : tVal === "cours" ? t("modal.editCoursTitle") : t("modal.editRehearsalTitle");
  });

  bindTypeSelector($("confirm-poll-type-holder"), (tVal) => {
    syncConcertFieldsVisibility("confirm-poll", tVal, "lbl-confirm-poll-start", "lbl-confirm-poll-end");
  });

  bindTypeSelector($("poll-type-holder"), () => {});
  bindTypeSelector($("edit-poll-type-holder"), () => {});

  const editModeHolder = $("edit-poll-mode-holder");
  const prevEditMode = editModeHolder.dataset.mode || "day";
  const prevEditPeriod = editModeHolder.dataset.period || "Après-midi";
  editModeHolder.innerHTML = buildModeSelectorHtml();
  bindModeSelector(editModeHolder, () => hooks.checkEditPollArchiveLock());
  applyModeState(editModeHolder, prevEditMode, prevEditPeriod);

  const globalModeHolder = $("poll-global-mode-holder");
  const prevGlobalMode = globalModeHolder.dataset.mode || "day";
  const prevGlobalPeriod = globalModeHolder.dataset.period || "Après-midi";
  globalModeHolder.innerHTML = buildModeSelectorHtml("14:00", "17:00");
  bindModeSelector(globalModeHolder, () => hooks.updatePollConflictsWarning());
  applyModeState(globalModeHolder, prevGlobalMode, prevGlobalPeriod);
}

// Calendrier Multi-Sélection Tap-Tap-Tap
const toIsoDate = (y, m, d) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

export function renderMultiCalendar() {
  const grid = $("multi-cal-grid"), label = $("cal-month-label"), pills = $("cal-selected-pills");
  if (!grid) return;
  const firstDay = new Date(state.calYear, state.calMonth, 1);
  label.textContent = firstDay.toLocaleDateString(getDateLocale(), { month: "long", year: "numeric" });

  const startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(state.calYear, state.calMonth + 1, 0).getDate();
  const prevMonthDays = new Date(state.calYear, state.calMonth, 0).getDate();
  const todayIso = new Date().toISOString().split("T")[0];

  const cells = [];
  for (let i = startOffset - 1; i >= 0; i--) {
    const d = prevMonthDays - i;
    const pm = state.calMonth === 0 ? 11 : state.calMonth - 1, py = state.calMonth === 0 ? state.calYear - 1 : state.calYear;
    cells.push({ iso: toIsoDate(py, pm, d), day: d, other: true });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ iso: toIsoDate(state.calYear, state.calMonth, d), day: d, other: false });
  }
  while (cells.length % 7 !== 0) {
    const d = cells.length - (startOffset + daysInMonth) + 1;
    const nm = state.calMonth === 11 ? 0 : state.calMonth + 1, ny = state.calMonth === 11 ? state.calYear + 1 : state.calYear;
    cells.push({ iso: toIsoDate(ny, nm, d), day: d, other: true });
  }

  grid.innerHTML = cells.map((c) => {
    const isSel = state.selectedCalDates.has(c.iso);
    const hasAbs = getUnavailabilityConflictsForDate(c.iso).length > 0;
    const cls = ["cal-day-btn", c.other ? "other-month" : "", c.iso === todayIso ? "today" : "", hasAbs ? "has-absence" : "", isSel ? "selected" : ""].filter(Boolean).join(" ");
    return `<button type="button" class="${cls}" data-cal-iso="${c.iso}"><span>${c.day}</span>${hasAbs ? '<span class="cal-day-dot"></span>' : ""}</button>`;
  }).join("");

  const sorted = [...state.selectedCalDates].sort();
  pills.innerHTML = sorted.length
    ? sorted.map((iso) => `<span class="selected-date-pill">${esc(formatCompactDateFr(iso))}<button type="button" data-unselect-iso="${iso}" aria-label="${esc(t("common.remove"))}">×</button></span>`).join("")
    : `<span style="font-size:12px;color:var(--muted)">${esc(t("cal.noDateSelected"))}</span>`;
  hooks.updatePollConflictsWarning();
}

export function initCalendarControls() {
  $("multi-cal-grid").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cal-iso]");
    if (!btn) return;
    haptic();
    const iso = btn.dataset.calIso;
    state.selectedCalDates.has(iso) ? state.selectedCalDates.delete(iso) : state.selectedCalDates.add(iso);
    renderMultiCalendar();
  });

  $("cal-selected-pills").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-unselect-iso]");
    if (!btn) return;
    haptic();
    state.selectedCalDates.delete(btn.dataset.unselectIso);
    renderMultiCalendar();
  });

  $("btn-cal-prev").addEventListener("click", () => {
    haptic();
    if (state.calMonth === 0) { state.calMonth = 11; state.calYear--; } else state.calMonth--;
    renderMultiCalendar();
  });

  $("btn-cal-next").addEventListener("click", () => {
    haptic();
    if (state.calMonth === 11) { state.calMonth = 0; state.calYear++; } else state.calMonth++;
    renderMultiCalendar();
  });
}

// Suggestions de lieux connus
export function getKnownLocations() {
  if (!state.currentEnsembleData) return [];
  const counts = new Map();
  const addLoc = (raw) => {
    const s = String(raw || "").trim();
    if (s) counts.set(s, (counts.get(s) || 0) + 1);
  };
  Object.values(state.currentEnsembleData.rehearsals || {}).forEach((r) => addLoc(r.location));
  Object.values(state.currentEnsembleData.polls || {}).forEach((p) => addLoc(p.location));
  Object.values(state.currentEnsembleData.archivedPolls || {}).forEach((a) => addLoc(a.location));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([loc]) => loc).slice(0, 6);
}

export function renderLocationSuggestions(containerId, inputId) {
  const box = $(containerId), inp = $(inputId);
  if (!box || !inp) return;
  const locs = getKnownLocations();
  if (!locs.length) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  box.innerHTML = locs.map((l) => `<button type="button" class="loc-chip" data-pick-loc="${esc(l)}">📍 ${esc(l)}</button>`).join("");
  box.onclick = (e) => {
    const b = e.target.closest("[data-pick-loc]");
    if (!b) return;
    haptic();
    inp.value = b.dataset.pickLoc;
  };
}

// Modale de confirmation universelle & gestion des modales
export function openConfirmationModal({ title, context, message, confirmLabel, danger = true, onConfirm }) {
  haptic();
  $("confirm-delete-title").textContent = title || t("common.confirm");
  const ctxEl = $("confirm-delete-context");
  ctxEl.textContent = context || "";
  ctxEl.classList.toggle("hidden", !context);
  $("confirm-delete-message").textContent = message || "";
  const btn = $("btn-execute-delete");
  btn.textContent = confirmLabel || t("common.confirm");
  btn.className = `${danger ? "btn-danger" : "btn-primary"} btn-full`;
  btn.disabled = false;
  state.pendingDeleteCallback = onConfirm;
  $("modal-confirm-delete").classList.add("open");
}

export function openModal(id) {
  haptic();
  const today = new Date().toISOString().split("T")[0];
  if (id === "modal-poll") {
    if (!state.refiningFixedDate && !state.selectedCalDates.size) hooks.resetPollSlots();
    renderLocationSuggestions("poll-location-suggestions", "poll-location");
  }
  if (id === "modal-rehearsal") {
    setEventTypeValue($("reh-type-holder"), "rehearsal", (tVal) => syncConcertFieldsVisibility("reh", tVal, "lbl-reh-start", "lbl-reh-end"));
    $("modal-reh-title").textContent = t("modal.planEventTitle");
    populateConcertFields("reh", null);
    if (!$("reh-date").value) $("reh-date").value = today;
  }
  if (id === "modal-unavailability") {
    if (!$("unavail-start").value) $("unavail-start").value = today;
    if (!$("unavail-end").value) $("unavail-end").value = $("unavail-start").value;
  }
  if (id === "modal-invite" && state.session.activeEnsembleId) {
    $("invite-link-display").textContent = getInviteUrl(state.session.activeEnsembleId);
    $("invite-code-display").textContent = state.session.activeEnsembleId;
  }
  if (id === "modal-transfer-device" && state.session.activeEnsembleId) {
    $("transfer-link-display").textContent = getTransferUrl(state.session.activeEnsembleId, state.session.ensembles[state.session.activeEnsembleId]?.memberId || "");
    $("transfer-code-display").textContent = state.session.activeEnsembleId;
  }
  if (id === "modal-edit-ensemble" && state.currentEnsembleData) {
    $("edit-ensemble-name").value = state.currentEnsembleData.name || "";
    $("edit-ensemble-formation").value = state.currentEnsembleData.formation || "Quatuor";
  }
  $(id).classList.add("open");
}

export function closeModal(id) {
  if (id === "modal-confirm-delete") state.pendingDeleteCallback = null;
  if (id === "modal-poll") state.refiningPollId = state.refiningFixedDate = null;
  $(id).classList.remove("open");
}

export function initModalGlobalListeners() {
  $("btn-execute-delete").addEventListener("click", async () => {
    if (!state.pendingDeleteCallback) return;
    haptic();
    const btn = $("btn-execute-delete"), fn = state.pendingDeleteCallback;
    btn.disabled = true; state.pendingDeleteCallback = null;
    try { await fn(); } finally { btn.disabled = false; closeModal("modal-confirm-delete"); }
  });

  document.addEventListener("click", (e) => {
    const closeBtn = e.target.closest("[data-close]");
    if (closeBtn) return closeModal(closeBtn.dataset.close);
    if (e.target.classList?.contains("modal-backdrop")) {
      e.target.id === "modal-whats-new" ? hooks.dismissWhatsNewModal() : closeModal(e.target.id);
    }
  });

  $("unavail-start").addEventListener("change", () => {
    if ($("unavail-start").value && (!$("unavail-end").value || $("unavail-end").value < $("unavail-start").value)) {
      $("unavail-end").value = $("unavail-start").value;
    }
  });
}
