/* Weekly Training Card (HA-style, tablet-friendly, responsive).
 *
 * Focus retention strategy:
 * - Avoid re-rendering on every keystroke (keeps native focus/cursor stable).
 * - Persist to backend only on explicit Save (or Generate).
 */

class WeeklyTrainingCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("ha-form");
  }

  static getStubConfig() {
    return { type: "custom:weekly-training-card", title: "Weekly Training" };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;

    this._loading = true;
    this._saving = false;
    this._error = "";

    this._entryId = "";
    this._state = null; // backend state
    this._activePerson = null;
    this._weekOffset = 0;
    this._selectedWeekday = null; // 0..6
	    this._draft = {
	      planning_mode: "auto",
	      intensity: "normal", // easy | normal | hard
	      duration_minutes: 45,
	      preferred_exercises: "",
      // Manual picks:
      session_overrides: {
        a_lower: "",
        a_push: "",
        a_pull: "",
        b_lower: "",
        b_push: "",
        b_pull: "",
        c_lower: "",
        c_push: "",
        c_pull: "",
      },
    };

    this._newPerson = {
      name: "",
      gender: "male",
      units: "kg",
      duration_minutes: 45,
      preferred_exercises: "",
      equipment: "bodyweight, dumbbell, barbell, band",
      max_squat: 100,
      max_deadlift: 120,
      max_bench: 80,
      color: "#475569",
    };

    this._focusKey = "";
    this._focusSelStart = null;
    this._focusSelEnd = null;

    // UI state (purely client-side).
	    this._ui = {
	      showPeople: false, // person editor modal
	      editPersonId: "",
	      showSettings: false,
	      settingsQuery: "",
	      showCyclePlanner: false,
	      cycleDraft: null,
	      showEditWorkout: false,
	      editWorkout: null,
	      confirmDelete: null, // { kind, person_id, week_start, date, series_start, weekday, weeks }
	      showWorkout: false,
	      workoutDay: null, // 0..6
	      selectedDay: null, // 0..6
	      workoutPersonId: "",
	      swipeX: 0,
	      swipeY: 0,
	      longPress: { timer: 0, fired: false },
	      toast: null, // { message, action, undo }
	      showHistory: false,
	      history: null,
	      historyWeek: "",
	    };

    // Cached exercise library payload (from backend).
    this._library = null;
    this._settingsDraft = null;

    this._renderedOnce = false;
  }

  setConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Invalid card config");
    this._config = {
      title: config.title || "Weekly Training",
      entry_id: config.entry_id || "",
      max_width: config.max_width || "",
    };
    this._entryId = this._config.entry_id || "";
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._state) this._load();
    // Avoid re-rendering on every hass update (keeps focus stable on tablets).
    if (!this._renderedOnce) {
      this._render();
      this._renderedOnce = true;
    }
  }

  getCardSize() {
    return 8;
  }

	  async _callWS(payload, _retried) {
	    if (!this._hass) throw new Error("No hass");
	    const p = { ...(payload || {}) };
	    const t = String(p.type || "");
	    const mutating = t && t !== "weekly_training/get_state" && t !== "weekly_training/get_plan" && t !== "weekly_training/list_entries" && t !== "weekly_training/get_library" && t !== "weekly_training/get_history";
	    if (mutating && this._state && this._state.rev != null && p.expected_rev == null) {
	      p.expected_rev = Number(this._state.rev || 1);
	    }
	    try {
	      return await this._hass.callWS(p);
	    } catch (e) {
	      const code = String((e && e.code) || "");
	      const msg = String((e && e.message) || e);
	      if ((code === "conflict" || msg.toLowerCase().includes("expected rev")) && !_retried) {
	        // Auto-heal: reload state and retry once. Avoids noisy "reload" prompts in the UI.
	        try {
	          await this._reloadState();
	          return await this._callWS(payload, true);
	        } catch (_) {
	          // Fall through to throw the original error.
	        }
	      }
	      throw e;
	    }
	  }

  _applyState(nextState) {
    if (!nextState || typeof nextState !== "object") return;
    // Some WS responses may omit runtime; keep last known runtime to avoid UI flicker.
    const prevRt = this._state && this._state.runtime ? this._state.runtime : null;
    if (!nextState.runtime && prevRt) nextState.runtime = prevRt;
    this._state = nextState;
    this._applyStateToDraft();
  }

  _captureFocus() {
    const el = this.shadowRoot ? this.shadowRoot.activeElement : null;
    if (!el) return;
    const key = (typeof el.getAttribute === "function" && el.getAttribute("data-focus-key")) || "";
    if (!key) return;
    this._focusKey = key;
    try {
      this._focusSelStart = typeof el.selectionStart === "number" ? el.selectionStart : null;
      this._focusSelEnd = typeof el.selectionEnd === "number" ? el.selectionEnd : null;
    } catch (_) {
      this._focusSelStart = null;
      this._focusSelEnd = null;
    }
  }

  _restoreFocus() {
    if (!this._focusKey) return;
    const el = this.shadowRoot ? this.shadowRoot.querySelector(`[data-focus-key="${this._focusKey}"]`) : null;
    if (!el) return;
    // Don't steal focus if user clicked elsewhere outside the card.
    const rn = this.getRootNode ? this.getRootNode() : null;
    const active = rn && rn.activeElement ? rn.activeElement : null;
    if (active && active !== this && active !== document.body && active !== document.documentElement) return;
    try {
      el.focus();
      if (this._focusSelStart != null && this._focusSelEnd != null && typeof el.setSelectionRange === "function") {
        el.setSelectionRange(this._focusSelStart, this._focusSelEnd);
      }
    } catch (_) {}
  }

  async _load() {
    this._loading = true;
    this._error = "";
    this._render();
    try {
      if (!this._entryId) {
        // Auto-resolve if exactly one entry exists
        const res = await this._callWS({ type: "weekly_training/list_entries" });
        const entries = res && Array.isArray(res.entries) ? res.entries : [];
        if (entries.length === 1) this._entryId = entries[0].entry_id;
      }
      if (!this._entryId) throw new Error("Set entry_id in card config (or keep only one entry).");
      const res = await this._callWS({ type: "weekly_training/get_state", entry_id: this._entryId });
      this._applyState((res && res.state) || {});
    } catch (e) {
      this._error = String((e && e.message) || e);
    } finally {
      this._loading = false;
      this._render();
    }
  }

  _showToast(message, action, undo) {
    const msg = String(message || "").trim();
    if (!msg) return;
    this._ui.toast = { message: msg, action: action ? String(action) : "", undo: undo || null };
    // Auto-dismiss to keep UI clean on tablet.
    try {
      if (this._ui._toastTimer) window.clearTimeout(this._ui._toastTimer);
      this._ui._toastTimer = window.setTimeout(() => {
        this._ui.toast = null;
        this._render();
      }, 8000);
    } catch (_) {}
  }

	  async _reloadState() {
	    if (!this._entryId) return;
	    try {
	      const res = await this._callWS({ type: "weekly_training/get_state", entry_id: this._entryId }, true);
	      this._applyState((res && res.state) || {});
	    } catch (e) {
	      this._error = String((e && e.message) || e);
	    } finally {
	      this._render();
	    }
	  }

  async _openHistoryModal() {
    if (!this._entryId) return;
    try {
      const res = await this._callWS({ type: "weekly_training/get_history", entry_id: this._entryId });
      this._ui.history = res && Array.isArray(res.history) ? res.history : [];
      if (!this._ui.historyWeek && this._ui.history && this._ui.history[0] && this._ui.history[0].week_start) {
        this._ui.historyWeek = String(this._ui.history[0].week_start || "");
      }
      this._ui.showHistory = true;
      this._render();
    } catch (e) {
      this._error = String((e && e.message) || e);
      this._render();
    }
  }

  async _upsertWorkout(personId, weekStart, workout) {
    const pid = String(personId || "");
    const wk = String(weekStart || "");
    if (!pid || !wk || !workout) return;
    const res = await this._callWS({
      type: "weekly_training/upsert_workout",
      entry_id: this._entryId,
      person_id: pid,
      week_start: wk,
      workout: workout,
    });
    this._applyState((res && res.state) || this._state);
  }

  _applyStateToDraft() {
    const st = this._state || {};
    const overrides = st.overrides || {};
    this._weekOffset = Number(overrides.week_offset != null ? overrides.week_offset : 0);
    this._selectedWeekday = overrides.selected_weekday != null ? overrides.selected_weekday : null;
    this._draft.planning_mode = String(overrides.planning_mode || "auto");
    this._draft.intensity = String(overrides.intensity || "normal");
    this._draft.duration_minutes = Number(overrides.duration_minutes != null ? overrides.duration_minutes : 45);
    this._draft.preferred_exercises = String(overrides.preferred_exercises || "");
    this._draft.progression = (overrides.progression && typeof overrides.progression === "object") ? { ...overrides.progression } : { enabled: true, step_pct: 2.5 };
    this._draft.cycle = (overrides.cycle && typeof overrides.cycle === "object") ? { ...overrides.cycle } : { enabled: false, preset: "strength", start_week_start: "", training_weekdays: [0, 2, 4], step_pct: 2.5, deload_pct: 10, deload_volume: 0.65 };
    this._draft.session_overrides = { ...this._draft.session_overrides, ...(overrides.session_overrides || {}) };

    const people = Array.isArray(st.people) ? st.people : [];
    const activeId = String(st.active_person_id || "");
    this._activePerson = people.find((p) => String((p && p.id) || "") === activeId) || people[0] || null;
  }

  _people() {
    return this._state && Array.isArray(this._state.people) ? this._state.people : [];
  }

  _personById(personId) {
    const id = String(personId || "");
    if (!id) return null;
    const people = this._people();
    return people.find((p) => String((p && p.id) || "") === id) || null;
  }

  _defaultPersonId() {
    const people = this._people();
    const byName = people.find((p) => String((p && p.name) || "").trim().toLowerCase() === "nikolaj");
    if (byName && byName.id) return String(byName.id);
    const activeId = this._activePersonId();
    if (activeId) return activeId;
    return people[0] && people[0].id ? String(people[0].id) : "";
  }

  _personColor(person) {
    const c = person && person.color ? String(person.color).trim() : "";
    if (c) return c;
    const pid = person && person.id ? String(person.id) : "";
    return this._colorFor(pid || "default");
  }

  _clampWeekOffset(value) {
    const v = Number(value);
    if (!Number.isFinite(v)) return 0;
    return Math.max(-3, Math.min(3, Math.trunc(v)));
  }

  _selectedWeekStartIso(runtime) {
    const currentWeekStart = String((runtime && runtime.current_week_start) || "");
    if (!currentWeekStart) return "";
    try {
      const ws = new Date(currentWeekStart + "T00:00:00Z");
      ws.setUTCDate(ws.getUTCDate() + (this._clampWeekOffset(this._weekOffset) * 7));
      return ws.toISOString().slice(0, 10);
    } catch (_) {
      return currentWeekStart.slice(0, 10);
    }
  }

  _isoWeekNumberFromWeekStart(weekStartIso) {
    const iso = String(weekStartIso || "").slice(0, 10);
    if (!iso) return 0;
    try {
      // ISO week number algorithm (UTC).
      const d0 = new Date(iso + "T00:00:00Z");
      const d = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate()));
      // Thursday in current week decides the year.
      d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
      const week1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
      return 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);
    } catch (_) {
      return 0;
    }
  }

  _cycleDisplayName(preset) {
    const p = String(preset || "").toLowerCase();
    if (p === "hypertrophy") return "Hypertrophy-ish";
    if (p === "minimalist") return "Minimalist";
    return "Strength-ish";
  }

  _cycleIndexForWeekStart(cycle, weekStartIso) {
    if (!cycle || typeof cycle !== "object") return { enabled: false, index: 0, is_deload: false };
    if (!cycle.enabled) return { enabled: false, index: 0, is_deload: false };
    const start = String(cycle.start_week_start || "").slice(0, 10);
    const wk = String(weekStartIso || "").slice(0, 10);
    if (!wk) return { enabled: true, index: 0, is_deload: false };
    try {
      const startIso = start || wk;
      const a = new Date(startIso + "T00:00:00Z");
      const b = new Date(wk + "T00:00:00Z");
      const weeks = Math.round((b.getTime() - a.getTime()) / (7 * 24 * 3600 * 1000));
      const idx = ((weeks % 4) + 4) % 4;
      return { enabled: true, index: idx, is_deload: idx === 3 };
    } catch (_) {
      return { enabled: true, index: 0, is_deload: false };
    }
  }

  _applyCyclePreset(preset) {
    const p = String(preset || "strength").toLowerCase();
    if (!this._draft.cycle || typeof this._draft.cycle !== "object") this._draft.cycle = {};
    this._draft.cycle.preset = p;
    if (p === "hypertrophy") {
      this._draft.cycle.step_pct = 2.5;
      this._draft.cycle.deload_pct = 12.5;
      this._draft.cycle.deload_volume = 0.75;
      return;
    }
    if (p === "minimalist") {
      this._draft.cycle.step_pct = 2.0;
      this._draft.cycle.deload_pct = 15.0;
      this._draft.cycle.deload_volume = 0.80;
      return;
    }
    // strength default
    this._draft.cycle.step_pct = 3.0;
    this._draft.cycle.deload_pct = 10.0;
    this._draft.cycle.deload_volume = 0.65;
  }

  _planForPerson(personId) {
    const plans = this._state && this._state.plans && typeof this._state.plans === "object" ? this._state.plans : {};
    const id = String(personId || "");
    const personPlans = (id && plans[id] && typeof plans[id] === "object") ? plans[id] : {};
    const runtime = (this._state && this._state.runtime) || {};
    const selectedWeekStart = this._selectedWeekStartIso(runtime);
    if (!selectedWeekStart) return null;
    const key = selectedWeekStart.slice(0, 10);
    return personPlans[key] || null;
  }

  _activePersonId() {
    return String((this._state && this._state.active_person_id) || "");
  }

  _activePlan() {
    const plans = this._state && this._state.plans && typeof this._state.plans === "object" ? this._state.plans : {};
    const id = this._activePersonId();
    const personPlans = (id && plans[id] && typeof plans[id] === "object") ? plans[id] : {};
    const runtime = (this._state && this._state.runtime) || {};
    const currentWeekStart = String(runtime.current_week_start || "");
    // Compute selected week start from currentWeekStart + offset.
    if (!currentWeekStart) return null;
    const ws = new Date(currentWeekStart + "T00:00:00Z");
    ws.setUTCDate(ws.getUTCDate() + (Number(this._weekOffset || 0) * 7));
    const key = ws.toISOString().slice(0, 10);
    return personPlans[key] || null;
  }

  async _saveOverrides() {
    this._captureFocus();
    this._saving = true;
    this._error = "";
    this._render();
    try {
      const payload = {
        type: "weekly_training/set_overrides",
        entry_id: this._entryId,
	        overrides: {
	          week_offset: Number(this._weekOffset || 0),
	          selected_weekday: this._selectedWeekday,
	          planning_mode: this._draft.planning_mode,
	          intensity: String(this._draft.intensity || "normal"),
	          duration_minutes: Number(this._draft.duration_minutes || 45),
	          preferred_exercises: String(this._draft.preferred_exercises || ""),
	          progression: this._draft.progression || undefined,
	          cycle: this._draft.cycle || undefined,
	          session_overrides: this._draft.session_overrides || {},
	        },
	      };
      const res = await this._callWS(payload);
      this._applyState((res && res.state) || this._state);
    } catch (e) {
      this._error = String((e && e.message) || e);
    } finally {
      this._saving = false;
      this._render();
    }
  }

  async _setWeekOffset(newOffset) {
    this._captureFocus();
    const next = this._clampWeekOffset(newOffset);
    if (next === this._clampWeekOffset(this._weekOffset)) return;

    // Update UI selection to something sensible when browsing other weeks.
    const runtime = (this._state && this._state.runtime) || {};
    const todayIso = String(runtime.today || "");
    const todayW = todayIso ? new Date(todayIso + "T00:00:00Z").getUTCDay() : null;
    const todayWeekday = todayW == null ? 0 : ((todayW + 6) % 7);
    const defaultDay = next === 0 ? Number(todayWeekday) : 0; // Monday for non-current weeks
    this._ui.selectedDay = defaultDay;
    this._selectedWeekday = defaultDay;
    this._weekOffset = next;

    this._saving = true;
    this._error = "";
    this._render();
    try {
      const res = await this._callWS({
        type: "weekly_training/set_overrides",
        entry_id: this._entryId,
        overrides: { week_offset: Number(next), selected_weekday: this._selectedWeekday },
      });
      this._applyState((res && res.state) || this._state);
    } catch (e) {
      this._error = String((e && e.message) || e);
    } finally {
      this._saving = false;
      this._render();
    }
  }

  _openCyclePlanner() {
    const people = this._people();
    const pid = String(this._activePersonId() || this._defaultPersonId() || "");
    const rt = (this._state && this._state.runtime) || {};
    const startWeek = this._selectedWeekStartIso(rt);
    const cur = (this._draft && this._draft.cycle && typeof this._draft.cycle === "object") ? this._draft.cycle : {};
    const preset = String(cur.preset || "strength");
    const tdays = Array.isArray(cur.training_weekdays) ? cur.training_weekdays.map((x) => Number(x)).filter((x) => Number.isFinite(x)) : [0, 2, 4];
    const stepPct = cur.step_pct != null ? Number(cur.step_pct) : 3.0;
    const deloadPct = cur.deload_pct != null ? Number(cur.deload_pct) : 10.0;
    const deloadVol = cur.deload_volume != null ? Number(cur.deload_volume) : 0.65;
    this._ui.cycleDraft = {
      person_id: pid || (people[0] && people[0].id ? String(people[0].id) : ""),
      start_week_start: String(startWeek || ""),
      weeks: 4,
      preset,
      training_weekdays: Array.from(new Set(tdays)).sort((a, b) => a - b),
      step_pct: stepPct,
      deload_pct: deloadPct,
      deload_volume: deloadVol,
    };
    this._ui.showCyclePlanner = true;
    this._render();
  }

  async _planCycle() {
    const d = this._ui && this._ui.cycleDraft ? this._ui.cycleDraft : null;
    if (!d) return;
    const personId = String(d.person_id || "");
    const startWeekStart = String(d.start_week_start || "").slice(0, 10);
    const weeks = Number(d.weeks || 4);
    const weekdays = Array.isArray(d.training_weekdays) ? d.training_weekdays : [];
    if (!personId || !startWeekStart || !weekdays.length) return;

    this._saving = true;
    this._error = "";
    this._render();
    try {
      // Persist cycle config (calendar-driven) so planned highlights stay stable.
      const cycle = {
        enabled: true,
        preset: String(d.preset || "strength"),
        start_week_start: startWeekStart,
        training_weekdays: weekdays,
        step_pct: Number(d.step_pct || 0),
        deload_pct: Number(d.deload_pct || 0),
        deload_volume: Number(d.deload_volume || 0.65),
      };
      await this._callWS({
        type: "weekly_training/set_overrides",
        entry_id: this._entryId,
        overrides: { cycle },
      });

      const res = await this._callWS({
        type: "weekly_training/generate_cycle",
        entry_id: this._entryId,
        person_id: personId,
        start_week_start: startWeekStart,
        weeks: weeks,
        weekdays: weekdays,
      });
      this._applyState((res && res.state) || this._state);
      this._ui.showCyclePlanner = false;
      this._ui.cycleDraft = null;
      this._showToast("Planned 4-week cycle", "", null);
    } catch (e) {
      this._error = String((e && e.message) || e);
    } finally {
      this._saving = false;
      this._render();
    }
  }

  _openEditWorkoutModal(personId, weekStartIso, workout) {
    const pid = String(personId || "");
    const wk = String(weekStartIso || "").slice(0, 10);
    if (!pid || !wk || !workout || typeof workout !== "object") return;
    const snap = JSON.parse(JSON.stringify(workout));
    this._ui.editWorkout = { person_id: pid, week_start: wk, workout: snap };
    this._ui.showEditWorkout = true;
    this._render();
  }

  async _saveEditedWorkout() {
    const d = this._ui && this._ui.editWorkout ? this._ui.editWorkout : null;
    if (!d) return;
    const pid = String(d.person_id || "");
    const wk = String(d.week_start || "").slice(0, 10);
    const w = d.workout && typeof d.workout === "object" ? d.workout : null;
    if (!pid || !wk || !w) return;
    this._saving = true;
    this._error = "";
    this._render();
    try {
      await this._upsertWorkout(pid, wk, w);
      this._ui.showEditWorkout = false;
      this._ui.editWorkout = null;
    } catch (e) {
      this._error = String((e && e.message) || e);
    } finally {
      this._saving = false;
      this._render();
    }
  }

  async _deleteEditedWorkout() {
    const d = this._ui && this._ui.editWorkout ? this._ui.editWorkout : null;
    if (!d) return;
    const pid = String(d.person_id || "");
    const wk = String(d.week_start || "").slice(0, 10);
    const dateIso = String(d.workout && d.workout.date ? d.workout.date : "");
    if (!pid || !wk || !dateIso) return;
    const ok = window.confirm("Delete this workout?");
    if (!ok) return;
    this._saving = true;
    this._error = "";
    this._render();
    try {
      await this._deleteWorkout(pid, wk, dateIso);
      this._ui.showEditWorkout = false;
      this._ui.editWorkout = null;
    } catch (e) {
      this._error = String((e && e.message) || e);
    } finally {
      this._saving = false;
      this._render();
    }
  }

  _openDeleteChoiceForWorkout(personId, weekStartIso, workout) {
    const pid = String(personId || "");
    const wk = String(weekStartIso || "").slice(0, 10);
    const w = workout && typeof workout === "object" ? workout : null;
    const dateIso = w ? String(w.date || "") : "";
    if (!pid || !wk || !dateIso) return;

    const cy = w && w.cycle && typeof w.cycle === "object" ? w.cycle : null;
    const isSeries = Boolean(cy && cy.enabled);
    const weekIndex = cy && Number.isFinite(Number(cy.week_index)) ? Number(cy.week_index) : null;
    const seriesStart = (() => {
      // Prefer inference from the workout itself (robust if overrides were changed later).
      if (weekIndex != null) {
        try {
          const d0 = new Date(wk + "T00:00:00Z");
          d0.setUTCDate(d0.getUTCDate() - (Number(weekIndex) * 7));
          return d0.toISOString().slice(0, 10);
        } catch (_) {}
      }
      // Fall back to current cycle config if available.
      const cur = this._draft && this._draft.cycle && typeof this._draft.cycle === "object" ? this._draft.cycle : null;
      const s = cur ? String(cur.start_week_start || "") : "";
      return s ? s.slice(0, 10) : wk;
    })();

    const wd = w && w.weekday != null ? Number(w.weekday) : null;
    const weekday = wd != null && Number.isFinite(wd) ? wd : 0;

    this._ui.confirmDelete = {
      kind: "workout_delete",
      person_id: pid,
      week_start: wk,
      date: dateIso,
      series_start: String(seriesStart || wk).slice(0, 10),
      weekday: Number(weekday),
      weeks: 4,
      is_series: isSeries,
    };
    this._render();
  }

  async _deleteWorkoutSeries(personId, seriesStartIso, weekday, weeks) {
    this._saving = true;
    this._error = "";
    this._render();
    try {
      const res = await this._callWS({
        type: "weekly_training/delete_workout_series",
        entry_id: this._entryId,
        person_id: String(personId || ""),
        start_week_start: String(seriesStartIso || ""),
        weekday: Number(weekday || 0),
        weeks: Number(weeks || 4),
      });
      this._applyState((res && res.state) || this._state);
    } catch (e) {
      this._error = String((e && e.message) || e);
    } finally {
      this._saving = false;
      this._render();
    }
  }

  async _setActivePerson(personId) {
    this._captureFocus();
    this._saving = true;
    this._error = "";
    this._render();
    try {
      const res = await this._callWS({ type: "weekly_training/set_active_person", entry_id: this._entryId, person_id: String(personId || "") });
      this._applyState((res && res.state) || this._state);
    } catch (e) {
      this._error = String((e && e.message) || e);
    } finally {
      this._saving = false;
      this._render();
    }
  }

  async _setWorkoutCompleted(personId, weekStart, dateIso, completed) {
    this._saving = true;
    this._error = "";
    this._render();
    try {
      const res = await this._callWS({
        type: "weekly_training/set_workout_completed",
        entry_id: this._entryId,
        person_id: String(personId || ""),
        week_start: String(weekStart || ""),
        date: String(dateIso || ""),
        completed: Boolean(completed),
      });
      this._applyState((res && res.state) || this._state);
    } catch (e) {
      this._error = String((e && e.message) || e);
    } finally {
      this._saving = false;
      this._render();
    }
  }

  async _deleteWorkout(personId, weekStart, dateIso) {
    this._saving = true;
    this._error = "";
    this._render();
    try {
      const res = await this._callWS({
        type: "weekly_training/delete_workout",
        entry_id: this._entryId,
        person_id: String(personId || ""),
        week_start: String(weekStart || ""),
        date: String(dateIso || ""),
      });
      this._applyState((res && res.state) || this._state);
    } catch (e) {
      this._error = String((e && e.message) || e);
    } finally {
      this._saving = false;
      this._render();
    }
  }

  async _generate(personId) {
    this._captureFocus();
    this._saving = true;
    this._error = "";
    this._render();
    try {
      // Persist draft first so generation uses latest values
      await this._saveOverrides();
      const pid = personId ? String(personId) : "";
      await this._callWS({ type: "weekly_training/generate_plan", entry_id: this._entryId, ...(pid ? { person_id: pid } : {}) });
      // Refresh state after generation
      const st = await this._callWS({ type: "weekly_training/get_state", entry_id: this._entryId });
      this._applyState((st && st.state) || this._state);
    } catch (e) {
      this._error = String((e && e.message) || e);
    } finally {
      this._saving = false;
      this._render();
    }
  }

  async _addPerson() {
    this._captureFocus();
    const name = String(this._newPerson.name || "").trim();
    if (!name) return;
    const editId = String(this._ui.editPersonId || "").trim();
    this._saving = true;
    this._error = "";
    this._render();
    try {
      const res = await this._callWS({
        type: "weekly_training/add_person",
        entry_id: this._entryId,
        person: {
          ...(editId ? { id: editId } : {}),
          name,
          color: String(this._newPerson.color || "").trim(),
          gender: String(this._newPerson.gender || "male"),
          units: String(this._newPerson.units || "kg"),
          duration_minutes: Number(this._newPerson.duration_minutes || 45),
          preferred_exercises: String(this._newPerson.preferred_exercises || ""),
          equipment: String(this._newPerson.equipment || ""),
          maxes: {
            squat: Number(this._newPerson.max_squat || 0),
            deadlift: Number(this._newPerson.max_deadlift || 0),
            bench: Number(this._newPerson.max_bench || 0),
          },
        },
      });
      this._applyState((res && res.state) || this._state);
      this._newPerson.name = "";
      this._ui.editPersonId = "";
      this._ui.showPeople = false;
    } catch (e) {
      this._error = String((e && e.message) || e);
    } finally {
      this._saving = false;
      this._render();
    }
  }

  _openPersonModal(personId) {
    const pid = String(personId || "");
    const people = this._people();
    const p = people.find((x) => String((x && x.id) || "") === pid) || null;
    if (p) {
      const maxes = p.maxes || {};
      const c0 = String(p.color || "").trim();
      const c = c0 && c0.charAt(0) === "#" ? c0 : "#475569";
      this._ui.editPersonId = pid;
      this._newPerson = {
        name: String(p.name || ""),
        color: c,
        gender: String(p.gender || "male"),
        units: String(p.units || "kg"),
        duration_minutes: Number(p.duration_minutes || 45),
        preferred_exercises: String(p.preferred_exercises || ""),
        equipment: String(p.equipment || "bodyweight, dumbbell, barbell, band"),
        max_squat: Number(maxes.squat || 0),
        max_deadlift: Number(maxes.deadlift || 0),
        max_bench: Number(maxes.bench || 0),
      };
    } else {
      this._ui.editPersonId = "";
      // keep defaults but clear name
      this._newPerson.name = "";
      this._newPerson.color = "#475569";
    }
    this._ui.showPeople = true;
    this._focusKey = "p_color";
    this._render();
  }

  async _ensureLibrary() {
    if (this._library) return;
    try {
      const res = await this._callWS({ type: "weekly_training/get_library", entry_id: this._entryId });
      this._library = res && Array.isArray(res.exercises) ? res.exercises : [];
    } catch (e) {
      // Non-fatal: settings modal can still render without the list.
      this._library = [];
    }
  }

  async _openSettingsModal() {
    await this._ensureLibrary();
    const cfg = this._state && this._state.exercise_config && typeof this._state.exercise_config === "object" ? this._state.exercise_config : {};
    const disabled = Array.isArray(cfg.disabled_exercises) ? cfg.disabled_exercises : [];
    const custom = Array.isArray(cfg.custom_exercises) ? cfg.custom_exercises : [];
    this._settingsDraft = {
      disabled: new Set(disabled.map((n) => String(n || "").trim()).filter(Boolean)),
      custom: custom.filter((e) => e && typeof e === "object"),
      query: "",
      new_custom: { name: "", group: "Core", tags: "", equipment: "" },
    };
    this._ui.showSettings = true;
    this._render();
  }

  _exercisePrimaryGroup(ex) {
    const grp0 = ex && ex.group != null ? String(ex.group || "").trim() : "";
    if (grp0) {
      const g = grp0.toLowerCase();
      if (g === "lower body" || g === "lower") return "Lower body";
      if (g === "push") return "Push";
      if (g === "pull") return "Pull";
      if (g === "shoulders") return "Shoulders";
      if (g === "core") return "Core";
      if (g === "arms") return "Arms";
      if (g === "other") return "Other";
    }
    const tags = (ex && Array.isArray(ex.tags) ? ex.tags : [])
      .map((t) => String(t || "").trim().toLowerCase())
      .filter(Boolean);
    const name = String((ex && ex.name) || "").toLowerCase();
    const hasAny = (arr) => arr.some((t) => tags.includes(t) || name.includes(t));

    // Prefer specificity, then fall back.
    if (hasAny(["squat", "deadlift", "hinge", "lunge", "quad", "hamstring", "glute", "calf", "single_leg", "lower"])) return "Lower body";
    if (hasAny(["bench", "press", "push", "chest", "dip"])) return "Push";
    if (hasAny(["row", "pull", "back", "lat", "chin", "pullup", "chinup"])) return "Pull";
    if (hasAny(["overhead", "shoulder", "delt"])) return "Shoulders";
    if (hasAny(["core", "abs", "ab", "anti_rotation", "carry"])) return "Core";
    if (hasAny(["bicep", "tricep", "curl", "extension", "arms"])) return "Arms";
    return "Other";
  }

  _groupExercisesForSettings(exercises) {
    const groups = new Map();
    const order = ["Lower body", "Push", "Pull", "Shoulders", "Core", "Arms", "Other"];
    for (const g of order) groups.set(g, []);

    for (const ex of exercises) {
      if (!ex || typeof ex !== "object") continue;
      const name = String(ex.name || "").trim();
      if (!name) continue;
      const g = this._exercisePrimaryGroup(ex);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(ex);
    }

    for (const [g, arr] of groups.entries()) {
      arr.sort((a, b) => String((a && a.name) || "").localeCompare(String((b && b.name) || ""), "en", { sensitivity: "base" }));
    }

    return order
      .map((g) => ({ name: g, items: groups.get(g) || [] }))
      .filter((x) => x.items.length);
  }

  _applySettingsFilter(query) {
    const q = String(query || "").trim().toLowerCase();
    const root = this.shadowRoot ? this.shadowRoot.querySelector("#xsections") : null;
    if (!root) return;

    const tiles = Array.from(root.querySelectorAll(".xtile[data-name]"));
    for (const t of tiles) {
      const name = String(t.getAttribute("data-name") || "");
      const show = !q || name.includes(q);
      t.style.display = show ? "" : "none";
    }

    // Hide empty sections when filtering.
    const secs = Array.from(root.querySelectorAll(".xsec"));
    for (const sec of secs) {
      const anyVisible = Array.from(sec.querySelectorAll(".xtile")).some((t) => t.style.display !== "none");
      sec.style.display = anyVisible ? "" : "none";
    }
  }

  async _saveExerciseConfig() {
    if (!this._settingsDraft) return;
    const disabled = Array.from(this._settingsDraft.disabled || []).filter(Boolean);
    const custom = Array.isArray(this._settingsDraft.custom) ? this._settingsDraft.custom : [];
    this._saving = true;
    this._error = "";
    this._render();
    try {
      const res = await this._callWS({
        type: "weekly_training/set_overrides",
        entry_id: this._entryId,
        overrides: {
          // Persist cycle/progression changes from Settings alongside exercise config.
          cycle: (this._draft && this._draft.cycle && typeof this._draft.cycle === "object") ? this._draft.cycle : undefined,
          progression: (this._draft && this._draft.progression && typeof this._draft.progression === "object") ? this._draft.progression : undefined,
          exercise_config: {
            disabled_exercises: disabled,
            custom_exercises: custom,
          },
        },
      });
      this._applyState((res && res.state) || this._state);
      this._ui.showSettings = false;
      this._settingsDraft = null;
    } catch (e) {
      const code = String((e && e.code) || "");
      if (code === "conflict") {
        // No need to scare the user; just reload and keep the modal open.
        await this._reloadState();
        this._showToast("Reloaded", "", null);
        return;
      }
      this._error = String((e && e.message) || e);
    } finally {
      this._saving = false;
      this._render();
    }
  }

  async _deletePerson(personId) {
    this._captureFocus();
    const pid = String(personId || "");
    if (!pid) return;
    this._saving = true;
    this._error = "";
    this._render();
    try {
      const res = await this._callWS({ type: "weekly_training/delete_person", entry_id: this._entryId, person_id: pid });
      this._applyState((res && res.state) || this._state);
    } catch (e) {
      this._error = String((e && e.message) || e);
    } finally {
      this._saving = false;
      this._render();
    }
  }

  _onChangeDraft(key, value) {
    this._draft[key] = value;
  }

  _onChangeSession(slot, value) {
    const v = String(value || "");
    this._draft.session_overrides = { ...(this._draft.session_overrides || {}), [slot]: v === "Auto" ? "" : v };
  }

  _onNewPersonChange(key, value) {
    this._newPerson[key] = value;
  }

  _render() {
    if (!this.shadowRoot) return;
    // Preserve focus between controlled re-renders (modals, saves, etc.).
    this._captureFocus();
    const title = (this._config && this._config.title) || "Weekly Training";
    const loading = this._loading;
    const saving = this._saving;
    const people = this._people();
    const activeId = this._activePersonId();
    const defaultPersonId = this._defaultPersonId();
    const viewPersonId = String(activeId || defaultPersonId || "");
    const viewPerson = this._personById(viewPersonId);
    const plan = this._planForPerson(viewPersonId);
    const planningMode = String(this._draft.planning_mode || "auto");
    const manual = planningMode === "manual";

    const runtime = (this._state && this._state.runtime) || {};
    const weekOffset = this._clampWeekOffset(this._weekOffset);
    const selectedWeekStartIso = this._selectedWeekStartIso(runtime);
    const selectedWeekNumber = this._isoWeekNumberFromWeekStart(selectedWeekStartIso) || Number(runtime.current_week_number || 0);
    const weekStartIso = String(selectedWeekStartIso || ""); // used throughout render
    const weekLabel = selectedWeekNumber ? `Week ${selectedWeekNumber}` : "Week";
    const weekRange = weekStartIso ? this._formatWeekRange(weekStartIso) : "";
    const weekDelta = weekOffset ? (weekOffset > 0 ? `+${weekOffset}` : `${weekOffset}`) : "";

    const todayIso = String(runtime.today || "");
    const todayW = todayIso ? new Date(todayIso + "T00:00:00Z").getUTCDay() : null;
    const todayWeekday = todayW == null ? 0 : ((todayW + 6) % 7);
    const defaultSelectedDay = weekOffset === 0 ? Number(todayWeekday) : 0;
    const selectedDay = this._ui.selectedDay != null ? Number(this._ui.selectedDay) : defaultSelectedDay;

    const activeName = viewPerson ? String(viewPerson.name || "") : "";

    const cycle = this._draft && this._draft.cycle && typeof this._draft.cycle === "object" ? this._draft.cycle : { enabled: false };
    const cycleInfo = this._cycleIndexForWeekStart(cycle, weekStartIso);
    const trainingDays = Array.isArray(cycle.training_weekdays) ? cycle.training_weekdays.map((x) => Number(x)).filter((x) => Number.isFinite(x)) : [];

	    const workouts = plan && Array.isArray(plan.workouts) ? plan.workouts : [];
	    const workoutsByDay = {};
	    const ws = weekStartIso ? new Date(weekStartIso + "T00:00:00Z") : null;
	    for (const w of workouts) {
      if (!w || typeof w !== "object") continue;
      const dIso = String(w.date || "");
      if (!dIso || !ws) continue;
      const d = new Date(dIso + "T00:00:00Z");
      const diffDays = Math.round((d.getTime() - ws.getTime()) / (24 * 3600 * 1000));
      if (diffDays >= 0 && diffDays <= 6) workoutsByDay[diffDays] = w;
	    }
	    const selectedWorkoutRaw = workoutsByDay[selectedDay] || null;
	    // UX rule: completed workouts should not remain in the big detail panel.
	    // They still exist in storage and appear in the bottom "Completed" bar.
	    const selectedWorkout = selectedWorkoutRaw && selectedWorkoutRaw.completed ? null : selectedWorkoutRaw;

	    // Build a per-day list of workouts across all people (for the day list UI).
	    const allByDay = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
	    const weekKey = weekStartIso ? String(weekStartIso).slice(0, 10) : "";
	    const plansAll = this._state && this._state.plans && typeof this._state.plans === "object" ? this._state.plans : null;
	    if (ws && weekKey && plansAll) {
	      for (let pi = 0; pi < people.length; pi++) {
	        const person = people[pi];
	        const pid = String((person && person.id) || "");
	        if (!pid) continue;
	        const personPlans = plansAll[pid];
	        const plan2 = personPlans && typeof personPlans === "object" ? personPlans[weekKey] : null;
	        const workouts2 = plan2 && Array.isArray(plan2.workouts) ? plan2.workouts : [];
	        for (let wi = 0; wi < workouts2.length; wi++) {
	          const w2 = workouts2[wi];
	          if (!w2 || typeof w2 !== "object") continue;
	          // Completed workouts do not show on the day board.
	          if (w2.completed) continue;
	          const dIso2 = String(w2.date || "");
	          if (!dIso2) continue;
	          const d2 = new Date(dIso2 + "T00:00:00Z");
	          const diffDays2 = Math.round((d2.getTime() - ws.getTime()) / (24 * 3600 * 1000));
	          if (diffDays2 < 0 || diffDays2 > 6) continue;
	          allByDay[diffDays2].push({ person: person, workout: w2 });
	        }
	      }
	      for (let di = 0; di < 7; di++) {
	        allByDay[di].sort((a, b) => String((a.person && a.person.name) || "").localeCompare(String((b.person && b.person.name) || "")));
	      }
	    }

    const daysDa = ["Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag", "L\u00f8rdag", "S\u00f8ndag"];
    const dayDates = (() => {
      try {
        if (!weekStartIso) return [];
        const ws2 = new Date(weekStartIso + "T00:00:00Z");
        const out = [];
        for (let i = 0; i < 7; i++) {
          const d = new Date(ws2.getTime());
          d.setUTCDate(d.getUTCDate() + i);
          const dd = String(d.getUTCDate()).padStart(2, "0");
          const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
          out.push(`${dd}.${mm}`);
        }
        return out;
      } catch (_) {
        return [];
      }
    })();

	    const maxWidthRaw = String((this._config && this._config.max_width) || "").trim();
	    const maxWidthCss = maxWidthRaw ? this._cssSize(maxWidthRaw) : "";
	    const accent = viewPerson ? this._personColor(viewPerson) : "var(--primary-color)";

	    // Premium first-run hint (works even if storage seeded a default "You").
	    const seeded = people.length === 1 && String((people[0] && people[0].name) || "").trim().toLowerCase() === "you";
	    const hasAnyPlans = (() => {
	      const plansAll2 = this._state && this._state.plans && typeof this._state.plans === "object" ? this._state.plans : null;
	      if (!plansAll2) return false;
	      const pid0 = String((people[0] && people[0].id) || "");
	      if (!pid0) return false;
	      const personPlans = plansAll2[pid0];
	      if (!personPlans || typeof personPlans !== "object") return false;
	      const key2 = weekStartIso ? weekStartIso.slice(0, 10) : "";
	      const p2 = key2 ? personPlans[key2] : null;
	      return Boolean(p2 && Array.isArray(p2.workouts) && p2.workouts.length);
	    })();
	    const onboarding = seeded && !hasAnyPlans ? `
	      <div class="onboard">
	        <div>
	          <div class="on-title">Set up your first profile</div>
	          <div class="on-sub">Add people, set 1RM maxes, then tap a day to generate a session.</div>
	        </div>
	        <button class="primary" id="on-people" ${saving ? "disabled" : ""}>People</button>
	      </div>
	    ` : "";

		    const isEditPerson = Boolean(String(this._ui.editPersonId || "").trim());
	    const peopleModal = this._ui.showPeople ? `
	      <div class="modal-backdrop" id="people-backdrop" aria-hidden="false">
	        <div class="modal" role="dialog" aria-label="People">
	          <div class="modal-h">
	            <div class="modal-title">${isEditPerson ? "Edit person" : "Add person"}</div>
	            <button class="icon-btn" id="people-close" title="Close">\u00d7</button>
	          </div>
	          <div class="modal-b">
            <div class="row compact">
              <div>
                <div class="label">Name</div>
                <input data-focus-key="p_name" id="p-name" type="text" placeholder="Name" value="${this._escape(String(this._newPerson.name || ""))}" ${saving ? "disabled" : ""} />
              </div>
              <div>
                <div class="label">Color</div>
                <input data-focus-key="p_color" id="p-color" type="color" value="${this._escape(String(this._newPerson.color || "#475569"))}" ${saving ? "disabled" : ""} />
              </div>
              <div>
                <div class="label">Gender</div>
                <select data-focus-key="p_gender" id="p-gender" ${saving ? "disabled" : ""}>
                  <option value="male" ${String(this._newPerson.gender || "male") === "male" ? "selected" : ""}>Male</option>
                  <option value="female" ${String(this._newPerson.gender || "male") === "female" ? "selected" : ""}>Female</option>
                </select>
              </div>
              <div>
                <div class="label">Units</div>
                <select data-focus-key="p_units" id="p-units" ${saving ? "disabled" : ""}>
                  <option value="kg" ${String(this._newPerson.units || "kg") === "kg" ? "selected" : ""}>kg</option>
                  <option value="lb" ${String(this._newPerson.units || "kg") === "lb" ? "selected" : ""}>lb</option>
                </select>
              </div>
            </div>

            <div class="row compact">
              <div>
                <div class="label">Default session minutes</div>
                <input data-focus-key="p_minutes" id="p-minutes" type="number" min="20" max="120" step="5" value="${this._escape(String(this._newPerson.duration_minutes || 45))}" ${saving ? "disabled" : ""} />
              </div>
              <div>
                <div class="label">Equipment (CSV)</div>
                <input data-focus-key="p_equipment" id="p-equipment" type="text" placeholder="bodyweight, barbell, dumbbell, band" value="${this._escape(String(this._newPerson.equipment || ""))}" ${saving ? "disabled" : ""} />
              </div>
            </div>

            <div>
              <div class="label">Preferred exercises/tags (CSV)</div>
              <input data-focus-key="p_pref" id="p-pref" type="text" placeholder="e.g. squat, pullup, overhead_press" value="${this._escape(String(this._newPerson.preferred_exercises || ""))}" ${saving ? "disabled" : ""} />
            </div>

            <div class="row compact" style="margin-top:10px">
              <div>
                <div class="label">1RM SQ</div>
                <input data-focus-key="p_sq" id="p-sq" type="number" min="10" max="500" step="1" value="${this._escape(String(this._newPerson.max_squat != null ? this._newPerson.max_squat : 100))}" ${saving ? "disabled" : ""} />
              </div>
              <div>
                <div class="label">1RM DL</div>
                <input data-focus-key="p_dl" id="p-dl" type="number" min="10" max="600" step="1" value="${this._escape(String(this._newPerson.max_deadlift != null ? this._newPerson.max_deadlift : 120))}" ${saving ? "disabled" : ""} />
              </div>
              <div>
                <div class="label">1RM BP</div>
                <input data-focus-key="p_bp" id="p-bp" type="number" min="5" max="400" step="1" value="${this._escape(String(this._newPerson.max_bench != null ? this._newPerson.max_bench : 80))}" ${saving ? "disabled" : ""} />
              </div>
            </div>

	          </div>
	          <div class="modal-f">
	            ${isEditPerson ? `<button class="danger" id="p-delete" ${saving ? "disabled" : ""}>Delete</button>` : `<span></span>`}
	            <div class="actions" style="margin:0">
	              ${isEditPerson && String(this._ui.editPersonId || "") !== String(activeId || "") ? `<button id="p-set-active" ${saving ? "disabled" : ""}>Set active</button>` : ``}
	              <button class="primary" id="p-save" ${saving || !String(this._newPerson.name || "").trim() ? "disabled" : ""}>Save</button>
	            </div>
	          </div>
	        </div>
	      </div>
	    ` : "";

	    const workoutPersonId = String(this._ui.workoutPersonId || viewPersonId || defaultPersonId || "");
	    const workoutModal = this._ui.showWorkout ? `
	      <div class="modal-backdrop" id="workout-backdrop" aria-hidden="false">
	        <div class="modal" role="dialog" aria-label="Workout">
	          <div class="modal-h">
	            <div class="modal-title">${this._escape(daysDa[selectedDay] || "Day")}</div>
	            <button class="icon-btn" id="workout-close" title="Close">\u00d7</button>
	          </div>
	          <div class="modal-b">
            <div class="hint">V\u00e6lg detaljer og gener\u00e9r dagens tr\u00e6ningspas. Hvis der allerede findes et pas p\u00e5 dagen, bliver det erstattet.</div>
            ${cycleInfo.enabled ? `
              <div class="hint" style="margin-top:8px">
                Cycle: <b>${this._escape(this._cycleDisplayName(cycle.preset))}</b> \u2022 Week ${this._escape(String((cycleInfo.index || 0) + 1))}/4${cycleInfo.is_deload ? " \u2022 Deload" : ""}
              </div>
            ` : ``}
            ${cycleInfo.enabled && !trainingDays.includes(selectedDay) ? `
              <div class="hint" style="margin-top:8px; color: var(--warning-color, var(--error-color)); font-weight:700">
                This is not a planned training day.
              </div>
            ` : ``}
            <div class="row compact" style="margin-top:10px">
              <div>
                <div class="label">Person</div>
                <select data-focus-key="w_person" id="w-person" ${saving ? "disabled" : ""}>
                  ${people.map((p) => {
                    const pid = String((p && p.id) || "");
                    const nm = String((p && p.name) || pid);
                    if (!pid) return "";
                    return `<option value="${this._escape(pid)}" ${pid === workoutPersonId ? "selected" : ""}>${this._escape(nm)}</option>`;
                  }).join("")}
                </select>
              </div>
              <div>
                <div class="label">Planning mode</div>
                <select data-focus-key="w_mode" id="w-mode" ${saving ? "disabled" : ""}>
                  <option value="auto" ${planningMode === "auto" ? "selected" : ""}>Auto</option>
                  <option value="manual" ${planningMode === "manual" ? "selected" : ""}>Manual (choose exercises)</option>
                </select>
              </div>
              <div>
                <div class="label">Session minutes</div>
                <input data-focus-key="w_minutes" id="w-minutes" type="number" min="20" max="120" step="5" value="${this._escape(String(this._draft.duration_minutes != null ? this._draft.duration_minutes : 45))}" ${saving ? "disabled" : ""} />
              </div>
              <div>
                <div class="label">Intensity</div>
                <select data-focus-key="w_intensity" id="w-intensity" ${saving ? "disabled" : ""}>
                  <option value="easy" ${String(this._draft.intensity || "normal") === "easy" ? "selected" : ""}>Easy</option>
                  <option value="normal" ${String(this._draft.intensity || "normal") === "normal" ? "selected" : ""}>Normal</option>
                  <option value="hard" ${String(this._draft.intensity || "normal") === "hard" ? "selected" : ""}>Hard</option>
                </select>
              </div>
            </div>

            <div style="margin-top:10px">
              <div class="label">Preferred exercises/tags (CSV)</div>
              <input data-focus-key="w_pref" id="w-pref" type="text" placeholder="e.g. squat, pullup, overhead_press" value="${this._escape(String(this._draft.preferred_exercises || ""))}" ${saving ? "disabled" : ""} />
            </div>

            <div id="manual-wrap" style="margin-top:10px; ${manual ? "" : "display:none;"}">
              <div class="label">Manual picks (exercise names)</div>
              <div class="hint">Regler: Squat og Deadlift mixes ikke i samme uge. Bench m\u00e5 gerne kombineres.</div>
              <div class="row compact" style="margin-top:8px">
                <div>
                  <div class="label">Lower</div>
                  <input data-focus-key="w_lower" id="w-lower" type="text" placeholder="Auto" value="" ${saving ? "disabled" : ""} />
                </div>
                <div>
                  <div class="label">Push</div>
                  <input data-focus-key="w_push" id="w-push" type="text" placeholder="Auto" value="" ${saving ? "disabled" : ""} />
                </div>
                <div>
                  <div class="label">Pull</div>
                  <input data-focus-key="w_pull" id="w-pull" type="text" placeholder="Auto" value="" ${saving ? "disabled" : ""} />
                </div>
              </div>
            </div>

	          </div>
	          <div class="modal-f">
	            <button id="w-cancel" ${saving ? "disabled" : ""}>Cancel</button>
	            <button class="primary" id="w-generate" ${saving || loading ? "disabled" : ""}>Generate</button>
	          </div>
	        </div>
	      </div>
	    ` : "";

	    const cycleDraft = this._ui && this._ui.cycleDraft && typeof this._ui.cycleDraft === "object" ? this._ui.cycleDraft : null;
	    const cycleModal = this._ui.showCyclePlanner && cycleDraft ? (() => {
	      const wk0 = String(cycleDraft.start_week_start || weekStartIso || "").slice(0, 10);
	      const wkNum = wk0 ? this._isoWeekNumberFromWeekStart(wk0) : 0;
	      const wkLabel = wkNum ? `Week ${wkNum}` : "Week";
	      const wkRange = wk0 ? this._formatWeekRange(wk0) : "";
	      const tds = Array.isArray(cycleDraft.training_weekdays) ? cycleDraft.training_weekdays : [];
	      return `
	        <div class="modal-backdrop" id="cycle-backdrop" aria-hidden="false">
	          <div class="modal" role="dialog" aria-label="Plan 4-week cycle">
	            <div class="modal-h">
	              <div class="modal-title">Plan 4-week cycle</div>
	              <button class="icon-btn" id="cycle-close" title="Close">\u00d7</button>
	            </div>
	            <div class="modal-b">
	              <div class="hint">This will generate workouts for the next <b>${this._escape(String(cycleDraft.weeks || 4))}</b> weeks starting from <b>${this._escape(wkLabel)}</b> (${this._escape(wkRange)}).</div>
	              <div class="row compact" style="margin-top:10px">
	                <div>
	                  <div class="label">Person</div>
	                  <select data-focus-key="cy_person" id="cy-person" ${saving ? "disabled" : ""}>
	                    ${people.map((p) => {
	                      const pid = String((p && p.id) || "");
	                      const nm = String((p && p.name) || pid);
	                      if (!pid) return "";
	                      return `<option value="${this._escape(pid)}" ${pid === String(cycleDraft.person_id || "") ? "selected" : ""}>${this._escape(nm)}</option>`;
	                    }).join("")}
	                  </select>
	                </div>
	                <div>
	                  <div class="label">Preset</div>
	                  <select data-focus-key="cy_preset2" id="cy-preset2" ${saving ? "disabled" : ""}>
	                    ${[
	                      { v: "strength", l: "Strength-ish" },
	                      { v: "hypertrophy", l: "Hypertrophy-ish" },
	                      { v: "minimalist", l: "Minimalist" },
	                    ].map((x) => {
	                      const cur = String(cycleDraft.preset || "strength");
	                      return `<option value="${this._escape(x.v)}" ${cur === x.v ? "selected" : ""}>${this._escape(x.l)}</option>`;
	                    }).join("")}
	                  </select>
	                </div>
	                <div>
	                  <div class="label">Weeks</div>
	                  <input data-focus-key="cy_weeks" id="cy-weeks" type="number" min="1" max="12" step="1" value="${this._escape(String(cycleDraft.weeks || 4))}" ${saving ? "disabled" : ""}/>
	                </div>
	              </div>

	              <div class="row compact" style="margin-top:10px">
	                <div style="grid-column: 1 / -1">
	                  <div class="label">Training weekdays</div>
	                  <div class="hint">Select the days you want to train.</div>
	                  <div class="weekdays" id="cy-weekdays2">
	                    ${daysDa.map((name, idx) => {
	                      const short = String(name || "").slice(0, 3);
	                      const on = tds.includes(idx);
	                      return `<button class="wday ${on ? "on" : "off"}" data-cy-wd="${idx}" ${saving ? "disabled" : ""}>${this._escape(short)}</button>`;
	                    }).join("")}
	                  </div>
	                </div>
	              </div>

	              <div class="divider"></div>
	              <div class="row compact">
	                <div>
	                  <div class="label">Step % (week 2-3)</div>
	                  <input data-focus-key="cy_step2" id="cy-step2" type="number" min="0" max="10" step="0.5" value="${this._escape(String(cycleDraft.step_pct != null ? cycleDraft.step_pct : 3.0))}" ${saving ? "disabled" : ""}/>
	                </div>
	                <div>
	                  <div class="label">Deload % (week 4)</div>
	                  <input data-focus-key="cy_deload2" id="cy-deload2" type="number" min="0" max="30" step="0.5" value="${this._escape(String(cycleDraft.deload_pct != null ? cycleDraft.deload_pct : 10.0))}" ${saving ? "disabled" : ""}/>
	                </div>
	                <div>
	                  <div class="label">Deload volume</div>
	                  <input data-focus-key="cy_vol2" id="cy-vol2" type="number" min="0.3" max="1" step="0.05" value="${this._escape(String(cycleDraft.deload_volume != null ? cycleDraft.deload_volume : 0.65))}" ${saving ? "disabled" : ""}/>
	                </div>
	              </div>
	            </div>
	            <div class="modal-f">
	              <button id="cycle-cancel" ${saving ? "disabled" : ""}>Cancel</button>
	              <button class="primary" id="cycle-plan" ${saving ? "disabled" : ""}>Plan</button>
	            </div>
	          </div>
	        </div>
	      `;
	    })() : "";

	    const editWorkoutModal = this._ui.showEditWorkout && this._ui.editWorkout ? (() => {
	      const d = this._ui.editWorkout || {};
	      const pid = String(d.person_id || "");
	      const wk = String(d.week_start || "").slice(0, 10);
	      const w = d.workout && typeof d.workout === "object" ? d.workout : {};
	      const dateIso = String(w.date || "");
	      const wname = String(w.name || "Workout");
	      const items = Array.isArray(w.items) ? w.items : [];
	      const person = this._personById(pid);
	      const pname = person ? String(person.name || "") : "";
	      const pcolor = person ? this._personColor(person) : "";
	      return `
	        <div class="modal-backdrop" id="editw-backdrop" aria-hidden="false">
	          <div class="modal" role="dialog" aria-label="Edit workout">
	            <div class="modal-h">
	              <div class="modal-title">Workout details</div>
	              <button class="icon-btn" id="editw-close" title="Close">\u00d7</button>
	            </div>
	            <div class="modal-b">
	              <div class="hint">
	                <span class="pcircle" style="background:${this._escape(pcolor)}">${this._escape((pname || "?").slice(0, 1).toUpperCase())}</span>
	                <span style="margin-left:8px; font-weight:800">${this._escape(pname || pid)}</span>
	                <span style="margin-left:8px; color: var(--secondary-text-color)">${this._escape(dateIso)}</span>
	              </div>

	              <div style="margin-top:12px">
	                <div class="label">Name</div>
	                <input data-focus-key="ew_name" id="ew-name" type="text" value="${this._escape(wname)}" ${saving ? "disabled" : ""}/>
	              </div>

	              <div class="divider"></div>
	              <div class="label">Exercises</div>
	              <div class="items" style="margin-top:10px">
	                ${items.map((it, idx) => {
	                  if (!it || typeof it !== "object") return "";
	                  const ex = String(it.exercise || "");
	                  const sr = String(it.sets_reps || "");
	                  const load = it.suggested_load != null ? String(it.suggested_load) : "";
	                  return `
	                    <div class="item" style="display:grid; grid-template-columns: 1fr 140px 140px; gap: 10px; align-items:center">
	                      <div>
	                        <div class="ex">${this._escape(ex)}</div>
	                        <div class="range">${this._escape(String(it.type || ""))}</div>
	                      </div>
	                      <div>
	                        <div class="label" style="font-size:11px">Sets x reps</div>
	                        <input data-focus-key="ew_sr_${idx}" data-ew-sr="${idx}" type="text" value="${this._escape(sr)}" ${saving ? "disabled" : ""}/>
	                      </div>
	                      <div>
	                        <div class="label" style="font-size:11px">Load</div>
	                        <input data-focus-key="ew_ld_${idx}" data-ew-load="${idx}" type="number" step="0.5" value="${this._escape(load)}" ${saving ? "disabled" : ""}/>
	                      </div>
	                    </div>
	                  `;
	                }).join("")}
	              </div>
	            </div>
	            <div class="modal-f">
	              <button class="danger" id="editw-delete" ${saving ? "disabled" : ""}>Delete</button>
	              <div class="actions" style="margin:0">
	                <button id="editw-cancel" ${saving ? "disabled" : ""}>Close</button>
	                <button class="primary" id="editw-save" ${saving ? "disabled" : ""}>Save</button>
	              </div>
	            </div>
	          </div>
	        </div>
	      `;
	    })() : "";

	    const confirmDeleteModal = this._ui && this._ui.confirmDelete && this._ui.confirmDelete.kind === "workout_delete" ? (() => {
	      const d = this._ui.confirmDelete || {};
	      const pid = String(d.person_id || "");
	      const wk = String(d.week_start || "").slice(0, 10);
	      const dateIso = String(d.date || "");
	      const isSeries = Boolean(d.is_series);
	      const person = this._personById(pid);
	      const pname = person ? String(person.name || "") : "";
	      const pcolor = person ? this._personColor(person) : "";
	      return `
	        <div class="modal-backdrop" id="cfd-backdrop" aria-hidden="false">
	          <div class="modal" role="dialog" aria-label="Delete workout">
	            <div class="modal-h">
	              <div class="modal-title">Delete workout</div>
	              <button class="icon-btn" id="cfd-close" title="Close">\u00d7</button>
	            </div>
	            <div class="modal-b">
	              <div class="hint">
	                <span class="pcircle" style="background:${this._escape(pcolor)}">${this._escape((pname || "?").slice(0, 1).toUpperCase())}</span>
	                <span style="margin-left:8px; font-weight:800">${this._escape(pname || pid)}</span>
	                <span style="margin-left:8px; color: var(--secondary-text-color)">${this._escape(dateIso)}</span>
	              </div>
	              <div class="hint" style="margin-top:10px">
	                ${isSeries ? "This workout is part of a 4-week cycle. What do you want to delete?" : "Delete this workout?"}
	              </div>
	            </div>
	            <div class="modal-f">
	              <button id="cfd-cancel" ${saving ? "disabled" : ""}>Cancel</button>
	              <div class="actions" style="margin:0">
	                ${isSeries ? `<button class="danger" id="cfd-series" ${saving ? "disabled" : ""}>Delete series</button>` : ``}
	                <button class="danger" id="cfd-one" ${saving ? "disabled" : ""}>Delete workout</button>
	              </div>
	            </div>
	          </div>
	        </div>
	      `;
	    })() : "";

		    const settingsModal = this._ui.showSettings ? (() => {
	      const draft = this._settingsDraft || { disabled: new Set(), custom: [], query: "", new_custom: { name: "", group: "Core", tags: "", equipment: "" } };
      const base = Array.isArray(this._library) ? this._library : [];
      const customDraft = Array.isArray(draft.custom) ? draft.custom : [];
      // Include custom draft exercises in the grouped grid immediately (no save/reopen needed).
      // De-dupe by name (case-insensitive), prefer custom draft when colliding.
      const merged = (() => {
        const map = new Map();
        for (const ex of base) {
          if (!ex || typeof ex !== "object") continue;
          const nm = String(ex.name || "").trim();
          if (!nm) continue;
          map.set(nm.toLowerCase(), ex);
        }
        for (const ex of customDraft) {
          if (!ex || typeof ex !== "object") continue;
          const nm = String(ex.name || "").trim();
          if (!nm) continue;
          map.set(nm.toLowerCase(), { ...ex, custom: true });
        }
        return Array.from(map.values());
      })();
      const grouped = this._groupExercisesForSettings(merged);

      const custom = customDraft;
      return `
        <div class="modal-backdrop" id="settings-backdrop" aria-hidden="false">
          <div class="modal" role="dialog" aria-label="Exercise settings">
	            <div class="modal-h">
	              <div class="modal-title">Exercise settings</div>
	              <button class="icon-btn" id="settings-close" title="Close">\u00d7</button>
	            </div>
	            <div class="modal-b">
              <div class="hint">Disable exercises you don't want suggested. You can also add your own custom exercises.</div>

              <div style="margin-top:10px">
                <div class="label">Search</div>
                <input data-focus-key="s_query" id="s-query" type="text" placeholder="Search exercise..." value="${this._escape(String(draft.query || ""))}" ${saving ? "disabled" : ""} />
              </div>

              <div class="divider"></div>

              <div class="label">Exercises</div>
              <div class="xsections" id="xsections">
                ${grouped.map((sec) => {
                  return `
                    <div class="xsec" data-sec="${this._escape(sec.name)}">
                      <div class="xsec-h">${this._escape(sec.name)}</div>
                      <div class="xgrid">
                        ${sec.items.map((ex) => {
                          const name = String((ex && ex.name) || "").trim();
                          if (!name) return "";
                          const disabled = draft.disabled && typeof draft.disabled.has === "function" ? draft.disabled.has(name) : false;
                          const tags = ex && Array.isArray(ex.tags) ? ex.tags.slice(0, 4).join(", ") : "";
                          const isCustom = Boolean(ex && ex.custom);
                          const lname = name.toLowerCase();
                          return `
                            <label class="xtile ${disabled ? "off" : "on"}" data-ex="${this._escape(name)}" data-name="${this._escape(lname)}">
                              <div class="xtop">
                                <div class="xname2">${this._escape(name)}</div>
                                <input class="xtoggle" type="checkbox" data-ex="${this._escape(name)}" ${disabled ? "" : "checked"} ${saving ? "disabled" : ""}/>
                              </div>
                              <div class="xtags2">${this._escape(tags)}</div>
                              ${isCustom ? `<div class="xbadge">Custom</div>` : ``}
                            </label>
                          `;
                        }).join("")}
                      </div>
                    </div>
                  `;
                }).join("")}
              </div>

	              <div class="divider"></div>

              <div class="label">Custom exercises</div>
              ${custom.length ? `
                <div class="xlist">
                  ${custom.map((ex, idx) => {
                    const nm = String((ex && ex.name) || "");
                    return `<div class="xcustom"><div>${this._escape(nm)}</div><button class="pillbtn danger" data-custom-del="${idx}" ${saving ? "disabled" : ""}>Delete</button></div>`;
                  }).join("")}
                </div>
              ` : `<div class="muted">No custom exercises yet.</div>`}

	              <div class="row compact" style="margin-top:10px">
	                <div>
	                  <div class="label">Name</div>
	                  <input data-focus-key="c_name" id="c-name" type="text" placeholder="e.g. Ring Row" value="${this._escape(String(draft.new_custom && draft.new_custom.name || ""))}" ${saving ? "disabled" : ""}/>
	                </div>
	                <div>
	                  <div class="label">Category</div>
	                  <select data-focus-key="c_group" id="c-group" ${saving ? "disabled" : ""}>
	                    ${["Lower body", "Push", "Pull", "Shoulders", "Core", "Arms", "Other"].map((g) => {
	                      const cur = String(draft.new_custom && draft.new_custom.group || "Core");
	                      return `<option value="${this._escape(g)}" ${cur === g ? "selected" : ""}>${this._escape(g)}</option>`;
	                    }).join("")}
	                  </select>
	                </div>
	                <div>
	                  <div class="label">Tags (CSV)</div>
	                  <input data-focus-key="c_tags" id="c-tags" type="text" placeholder="pull, row" value="${this._escape(String(draft.new_custom && draft.new_custom.tags || ""))}" ${saving ? "disabled" : ""}/>
	                </div>
	                <div>
	                  <div class="label">Equipment (CSV)</div>
	                  <input data-focus-key="c_eq" id="c-eq" type="text" placeholder="bodyweight, band" value="${this._escape(String(draft.new_custom && draft.new_custom.equipment || ""))}" ${saving ? "disabled" : ""}/>
	                </div>
	              </div>
	              <div class="actions" style="margin-top:10px">
	                <button id="c-add" ${saving ? "disabled" : ""}>Add custom exercise</button>
	              </div>

	              <div class="divider"></div>
	              <div class="label">Import / Export</div>
	              <div class="hint">Backup people + exercises. Plans and history are not included.</div>
	              <div class="actions" style="margin-top:8px">
	                <button id="cfg-export" ${saving ? "disabled" : ""}>Copy export</button>
	                <button id="cfg-import-open" ${saving ? "disabled" : ""}>Import</button>
	                <button id="cfg-history" ${saving ? "disabled" : ""}>History</button>
	              </div>

	            </div>
	            <div class="modal-f">
	              <button id="s-cancel" ${saving ? "disabled" : ""}>Cancel</button>
	              <button class="primary" id="s-save" ${saving ? "disabled" : ""}>Save</button>
	            </div>
	          </div>
	        </div>
	      `;
		    })() : "";

			    const completedModal = this._ui && this._ui.showCompleted ? (() => {
		      const d = this._ui.completedDetail || {};
		      const pname = String(d.person_name || "");
		      const pcolor = String(d.person_color || "");
		      const wname = String(d.workout_name || "Workout");
		      const dateIso = String(d.date || "");
		      const items = Array.isArray(d.items) ? d.items : [];
		      const canDelete = Boolean(d.can_delete);
		      return `
		        <div class="modal-backdrop" id="completed-backdrop" aria-hidden="false">
		          <div class="modal" role="dialog" aria-label="Completed workout">
		            <div class="modal-h">
		              <div class="modal-title">${this._escape(wname)}</div>
		              <button class="icon-btn" id="completed-close" title="Close">\u00d7</button>
		            </div>
		            <div class="modal-b">
		              <div class="hint">
		                <span class="pcircle" style="background:${this._escape(pcolor)}">${this._escape((pname || "?").slice(0, 1).toUpperCase())}</span>
		                <span style="margin-left:8px; font-weight:800">${this._escape(pname)}</span>
		                <span style="margin-left:8px; color: var(--secondary-text-color)">${this._escape(dateIso)}</span>
		              </div>
		              <div class="items" style="margin-top:12px">
		                ${items.map((it) => {
		                  if (!it || typeof it !== "object") return "";
		                  const ex = String(it.exercise || "");
		                  const sr = String(it.sets_reps || "");
		                  const load = it.suggested_load != null ? String(it.suggested_load) : "";
		                  return `<div class="item"><div class="ex">${this._escape(ex)}</div><div class="range">${this._escape(sr)}${load ? ` \u2022 ~${this._escape(load)}` : ""}</div></div>`;
		                }).join("")}
		              </div>
		            </div>
		            <div class="modal-f">
		              ${canDelete ? `<button class="danger" id="completed-delete" ${saving ? "disabled" : ""}>Delete</button>` : `<span></span>`}
		              <button id="completed-ok">Close</button>
		            </div>
		          </div>
		        </div>
		      `;
			    })() : "";

		    const historyModal = this._ui && this._ui.showHistory ? (() => {
		      const hist = Array.isArray(this._ui.history) ? this._ui.history : [];
		      const wk = String(this._ui.historyWeek || (hist[0] && hist[0].week_start) || "");
		      const cur = hist.find((h) => String((h && h.week_start) || "") === wk) || hist[0] || null;
		      const completed = cur && Array.isArray(cur.completed) ? cur.completed : [];
		      return `
		        <div class="modal-backdrop" id="history-backdrop" aria-hidden="false">
		          <div class="modal" role="dialog" aria-label="History">
		            <div class="modal-h">
		              <div class="modal-title">History</div>
		              <button class="icon-btn" id="history-close" title="Close">\u00d7</button>
		            </div>
		            <div class="modal-b">
		              <div class="label">Weeks</div>
		              <div class="hweeks">
		                ${hist.map((h) => {
		                  const w0 = String((h && h.week_start) || "");
		                  if (!w0) return "";
		                  const isA = w0 === wk;
		                  return `<button class="hweek ${isA ? "active" : ""}" data-hweek="${this._escape(w0)}">${this._escape(w0)}</button>`;
		                }).join("")}
		              </div>
		              <div class="divider"></div>
		              ${completed.length ? `
		                <div class="label">Completed workouts</div>
		                <div class="cb-chips">
		                  ${completed.map((c) => {
		                    if (!c || typeof c !== "object") return "";
		                    const pid = String(c.person_id || "");
		                    const dateIso = String(c.date || "");
		                    const w = c.workout || {};
		                    const wname = String((w && w.name) || "Workout");
		                    const pname = String(c.person_name || "");
		                    const pcolor = String(c.person_color || "");
		                    const wweek = String(c.week_start || "");
		                    if (!pid || !dateIso) return "";
		                    return `
		                      <div class="cb-chip" style="border-color:${this._escape(pcolor)}" data-hc-person="${this._escape(pid)}" data-hc-date="${this._escape(dateIso)}" data-hc-week="${this._escape(wweek)}">
		                        <span class="pcircle" style="background:${this._escape(pcolor)}">${this._escape((pname || "?").slice(0, 1).toUpperCase())}</span>
		                        <div class="cbtext">${this._escape(wname)} \u2022 ${this._escape(dateIso)}</div>
		                      </div>
		                    `;
		                  }).join("")}
		                </div>
		              ` : `<div class="muted">No completed workouts archived for this week.</div>`}
		            </div>
		            <div class="modal-f">
		              <span></span>
		              <button id="history-ok">Close</button>
		            </div>
		          </div>
		        </div>
		      `;
		    })() : "";

		    const toast = this._ui && this._ui.toast ? `
		      <div class="snack" role="status" aria-live="polite">
		        <div class="snack-msg">${this._escape(String(this._ui.toast.message || ""))}</div>
		        ${this._ui.toast.action ? `<button class="snack-act" id="snack-act">${this._escape(String(this._ui.toast.action || ""))}</button>` : ""}
		        <button class="snack-x" id="snack-x" title="Dismiss">\u00d7</button>
		      </div>
		    ` : "";

		    this.shadowRoot.innerHTML = `
	      <style>
		        :host {
		          display:block;
		          --accent: ${this._escape(accent)};
		          --wt-radius: 16px;
		          --wt-radius-sm: 12px;
		          --wt-border: var(--divider-color);
		          --wt-surface: var(--card-background-color);
		          --wt-surface2: var(--card-background-color);
		          /* Theme-native "subtle" surface derived from text color (avoids big gray blocks). */
		          --wt-subtle: rgba(var(--rgb-primary-text-color, 0, 0, 0), 0.04);
		          --wt-subtle2: rgba(var(--rgb-primary-text-color, 0, 0, 0), 0.06);
		          --wt-text2: var(--secondary-text-color);
		          --wt-accent: var(--accent, var(--primary-color));
		        }
	        ha-card {
	          overflow: hidden;
	          width: 100%;
	          background: var(--wt-surface);
	          ${maxWidthCss ? `max-width:${this._escape(maxWidthCss)};` : ""}
	        }
		        .wrap { padding: 16px; }
		        .muted { color: var(--wt-text2); }
			        .header { display:flex; flex-direction:column; gap: 12px; }
			        .h-title { font-size: 22px; font-weight: 800; letter-spacing: 0.2px; }
			        .topbar {
			          display:grid;
			          grid-template-columns: auto 1fr auto;
			          gap: 12px;
			          align-items: center;
			        }
			        @media (max-width: 740px) {
			          .topbar { grid-template-columns: 1fr auto; grid-template-areas: "week gear" "people people"; }
			          .weekpill { grid-area: week; min-width: 0; }
			          .toppeople { grid-area: people; }
			          .gearbtn { grid-area: gear; }
			        }
		        .onboard{
		          display:flex;
		          align-items:center;
		          justify-content:space-between;
		          gap: 12px;
		          border: 1px solid var(--wt-border);
		          border-radius: var(--wt-radius);
		          padding: 12px;
		          background: linear-gradient(180deg, rgba(var(--rgb-primary-color, 0,0,0),0.06), transparent);
		        }
		        .on-title{ font-weight: 900; font-size: 14px; }
		        .on-sub{ margin-top:4px; color: var(--wt-text2); font-size: 12px; }
		        .weekpill {
		          border: 1px solid var(--wt-border);
		          border-radius: var(--wt-radius-sm);
		          background: var(--wt-surface);
		          padding: 6px;
		          min-width: 190px;
		          display: grid;
		          grid-template-columns: 40px 1fr 40px;
		          gap: 6px;
		          align-items: center;
		        }
		        .wkbtn, .wkcenter {
		          border: 1px solid var(--wt-border);
		          background: var(--card-background-color);
		          border-radius: 12px;
		          height: 42px;
		          color: var(--primary-text-color);
		        }
		        .wkbtn {
		          display:flex;
		          align-items:center;
		          justify-content:center;
		          cursor: pointer;
		          transition: transform 90ms ease, filter 120ms ease;
		        }
		        .wkbtn:active { transform: scale(0.98); }
		        .wkbtn[disabled] { opacity: 0.55; cursor: default; }
		        .wkbtn ha-icon { color: var(--wt-text2); }
		        .wkcenter {
		          text-align: left;
		          padding: 6px 10px;
		          cursor: pointer;
		        }
		        .wkcenter[disabled] { opacity: 0.8; cursor: default; }
	        .wk { font-size: 13px; font-weight: 800; line-height: 1.1; }
	        .wkdelta { font-size: 12px; color: var(--wt-text2); font-weight: 700; }
	        .range { font-size: 12px; color: var(--wt-text2); margin-top: 3px; }
	        .gearbtn {
	          width: 44px;
	          height: 42px;
	          border-radius: var(--wt-radius-sm);
	          border: 1px solid var(--wt-border);
	          background: var(--wt-surface);
	          color: var(--primary-text-color);
	          cursor: pointer;
	          display: flex;
	          align-items: center;
	          justify-content: center;
	          transition: transform 90ms ease, filter 120ms ease;
	        }
		        .gearbtn:active { transform: scale(0.98); }
		        .gearbtn ha-icon { color: var(--wt-text2); }
	        .gearbtn:focus-visible, .pchip:focus-visible, .day:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible {
		          outline: 2px solid var(--primary-color);
		          outline-offset: 2px;
		        }
		        .toggle { display:flex; align-items:center; gap: 10px; user-select:none; }
		        .toggle input { width: 18px; height: 18px; }
		        .weekdays { display:flex; gap: 8px; flex-wrap:wrap; margin-top: 8px; }
		        .wday {
		          border: 1px solid var(--wt-border);
		          border-radius: 999px;
		          padding: 8px 12px;
		          background: var(--wt-surface);
		          color: var(--primary-text-color);
		          cursor: pointer;
		          font: inherit;
		          transition: transform 90ms ease, box-shadow 120ms ease, border-color 120ms ease;
		        }
		        .wday:active { transform: scale(0.985); }
		        .wday.on { border-color: var(--primary-color); box-shadow: 0 0 0 1px var(--primary-color) inset; }
		        .wday.off { opacity: 0.65; }

			        .peoplebar, .toppeople {
			          border: 1px solid var(--wt-border);
			          border-radius: var(--wt-radius);
			          padding: 10px 12px;
			          display:flex;
			          align-items:center;
			          justify-content:flex-start;
			          gap: 10px;
			          background: var(--wt-surface);
			          min-width: 0;
			        }
	        .peoplelabel {
	          font-size: 11px;
	          font-weight: 900;
	          letter-spacing: 0.08em;
	          text-transform: uppercase;
	          color: var(--wt-text2);
	          flex: 0 0 auto;
	        }
		        .peoplechips { display:flex; gap: 8px; align-items:center; flex-wrap:wrap; justify-content:flex-start; flex: 1 1 auto; min-width:0; }
	        .pchip {
	          border: 1px solid var(--wt-border);
	          border-radius: 999px;
	          background: var(--wt-surface);
	          color: var(--primary-text-color);
	          padding: 7px 10px;
	          display:flex;
	          align-items:center;
	          gap: 8px;
	          cursor: pointer;
	          font: inherit;
	          transition: transform 90ms ease, border-color 120ms ease, box-shadow 120ms ease;
	        }
	        .pchip:active { transform: scale(0.985); }
		        .pchip.active { border-color: var(--wt-accent); box-shadow: 0 0 0 2px rgba(var(--rgb-primary-text-color, 0,0,0), 0.06), 0 0 0 1px var(--wt-accent) inset; }
	        .pcircle {
	          width: 22px;
	          height: 22px;
	          border-radius: 999px;
	          display:inline-flex;
	          align-items:center;
	          justify-content:center;
	          color: #fff;
	          font-size: 12px;
	          font-weight: 900;
	        }
	        .pname { font-size: 13px; font-weight: 700; }
	        .pchip.add { padding: 7px 12px; font-weight: 900; }

	        .layout { display:grid; grid-template-columns: 1fr; gap: 14px; margin-top: 14px; }
	        @media (min-width: 740px) { .layout { grid-template-columns: minmax(300px, 360px) 1fr; } }

			        .days {
			          border: 1px solid var(--wt-border);
			          border-radius: var(--wt-radius);
			          overflow: hidden;
			          background: var(--wt-surface);
			          padding: 10px;
			          display:flex;
			          flex-direction:column;
			          gap: 8px;
			        }
		        .day {
		          width: 100%;
		          display:flex;
		          align-items:center;
		          justify-content:space-between;
		          gap: 10px;
		          font: inherit;
		          border: 1px solid var(--wt-border);
		          border-radius: var(--wt-radius-sm);
		          padding: 10px 10px;
		          background: var(--wt-subtle2);
		          color: var(--primary-text-color);
		          cursor: pointer;
		          text-align: left;
		          touch-action: manipulation;
		          transition: background 120ms ease, box-shadow 120ms ease, border-color 120ms ease, transform 90ms ease;
		        }
		        .day.planned { box-shadow: 0 0 0 1px rgba(var(--rgb-primary-color, 0,0,0), 0.22) inset; }
			        .day:hover { background: var(--wt-subtle); }
			        .day:active { transform: scale(0.995); }
			        .day.active { background: var(--wt-surface); border-color: var(--wt-accent); box-shadow: 0 0 0 1px var(--wt-accent) inset; }
			        .day.today { box-shadow: 0 0 0 2px var(--primary-color) inset; }
		        .day .meta { display:flex; flex-direction:column; gap: 2px; }
		        .day .name { font-weight: 800; font-size: 13px; }
		        .day .hint2 { font-size: 11px; color: var(--wt-text2); }

	        .badge {
	          font-size: 11px;
	          font-weight: 700;
	          border: 1px solid var(--wt-border);
	          border-radius: 999px;
	          padding: 5px 9px;
	          color: var(--wt-text2);
	          background: var(--wt-subtle);
	        }
	        .badge.planned { color: var(--primary-text-color); background: rgba(var(--rgb-primary-color, 0,0,0), 0.06); }
	        .badge.today { border-color: var(--primary-color); color: var(--primary-color); font-weight: 900; background: var(--wt-surface); }
		        .daybadges { display:flex; flex-wrap:wrap; justify-content:flex-end; gap: 6px; max-width: 170px; }
	        .wbadge {
	          font-size: 11px;
	          border: 1px solid var(--wt-border);
	          border-radius: 999px;
	          padding: 5px 9px;
	          color: var(--primary-text-color);
	          background: var(--wt-surface);
	          display:flex;
	          align-items:center;
	          gap: 6px;
	          max-width: 160px;
	        }
	        .wbadge .mini {
	          width: 14px;
	          height: 14px;
	          border-radius: 999px;
	          display:inline-flex;
	          align-items:center;
	          justify-content:center;
	          color: #fff;
	          font-size: 9px;
	          font-weight: 900;
	          flex: 0 0 auto;
	        }
	        .wbadge .wtext { overflow:hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 800; }

		        .main {
		          border: 1px solid var(--wt-accent);
		          box-shadow: 0 0 0 1px var(--wt-accent) inset;
		          border-radius: var(--wt-radius);
		          padding: 14px;
		          background: var(--wt-surface);
		          position: relative;
		        }
		        .busy-overlay{
		          position:absolute;
		          inset: 0;
		          display:flex;
		          flex-direction:column;
		          align-items:center;
		          justify-content:center;
		          gap: 10px;
		          background: rgba(var(--rgb-card-background-color, 255,255,255), 0.72);
		          backdrop-filter: blur(2px);
		          border-radius: var(--wt-radius);
		          z-index: 2;
		        }
		        .spinner{
		          width: 28px;
		          height: 28px;
		          border-radius: 999px;
		          border: 3px solid var(--wt-border);
		          border-top-color: var(--primary-color);
		          animation: spin 900ms linear infinite;
		        }
		        @keyframes spin{ to{ transform: rotate(360deg); } }
	        .mainhead { display:flex; align-items:flex-start; justify-content:space-between; gap: 12px; }
	        .dtitle { font-size: 16px; font-weight: 900; letter-spacing: 0.1px; }
	        .dsub { margin-top: 3px; font-size: 12px; color: var(--wt-text2); }
	        .pill {
	          font-size: 11px;
	          font-weight: 900;
	          border-radius: 999px;
	          padding: 6px 10px;
	          border: 1px solid var(--wt-border);
	          background: var(--wt-subtle);
	          color: var(--wt-text2);
	          white-space: nowrap;
	        }
	        .swipehint { margin-top: 8px; font-size: 12px; color: var(--wt-text2); }

	        .completedbar {
	          margin-top: 14px;
	          border: 1px solid var(--wt-border);
	          border-radius: var(--wt-radius);
	          padding: 10px 12px;
	          background: var(--wt-surface);
	        }
	        .cb-h { display:flex; align-items:center; justify-content:space-between; gap: 10px; }
	        .cb-title { font-size: 11px; font-weight: 900; letter-spacing: 0.08em; text-transform: uppercase; color: var(--wt-text2); }
	        .cb-chips { margin-top: 8px; display:flex; gap: 8px; flex-wrap: wrap; }
		        .cb-chip {
		          border: 1px solid var(--wt-border);
		          border-radius: 999px;
		          padding: 7px 10px;
		          background: var(--wt-surface);
		          color: var(--primary-text-color);
		          display:flex;
		          align-items:center;
		          gap: 8px;
		          font-size: 13px;
		          font-weight: 700;
		        }
		        .hweeks{ display:flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
		        .hweek{
		          font: inherit;
		          border: 1px solid var(--wt-border);
		          border-radius: 999px;
		          padding: 7px 10px;
		          background: var(--wt-surface);
		          cursor:pointer;
		          font-weight: 800;
		          color: var(--primary-text-color);
		        }
		        .hweek.active{ border-color: var(--primary-color); box-shadow: 0 0 0 1px var(--primary-color) inset; }
        .empty-main {
          min-height: 360px;
          display:flex;
          align-items:center;
          justify-content:center;
          padding: 12px;
        }
        .empty-card {
          width: min(460px, 100%);
          border: 1px dashed var(--divider-color);
          border-radius: 14px;
          padding: 18px 16px;
          text-align: center;
          color: var(--secondary-text-color);
          background: var(--card-background-color);
          cursor: pointer;
        }
        .empty-title { font-size: 14px; font-weight: 700; color: var(--primary-text-color); }
        .empty-sub { margin-top: 6px; font-size: 12px; color: var(--secondary-text-color); }
	        .items { margin-top: 12px; display:flex; flex-direction:column; gap: 10px; }
			        .item { border: 1px solid var(--wt-border); border-radius: var(--wt-radius-sm); padding: 12px; background: var(--wt-subtle2); box-shadow: 0 1px 0 rgba(0,0,0,0.02); }
	        .item .ex { font-weight: 900; font-size: 13px; }
	        .swipable { position: relative; overflow: hidden; }
	        .swipe-bg {
	          position: absolute;
	          inset: 0;
	          border-radius: var(--wt-radius-sm);
	          background: transparent;
	          opacity: var(--swipe-p, 0);
	          transform: translateX(0);
	          transition: opacity 90ms ease;
	          pointer-events: none;
	          display:flex;
	          align-items:center;
	          justify-content:center;
	          z-index: 0;
	        }
	        .swipable > .item { position: relative; z-index: 1; }
	        .swipe-bubble {
	          border: 1px solid rgba(var(--rgb-primary-text-color, 0, 0, 0), 0.12);
	          background: rgba(var(--rgb-card-background-color, 255,255,255), 0.75);
	          backdrop-filter: blur(3px);
	          border-radius: 999px;
	          padding: 10px 14px;
	          font-weight: 900;
	          font-size: 13px;
	          color: var(--primary-text-color);
	          box-shadow: 0 8px 24px rgba(0,0,0,0.10);
	          min-width: 180px;
	          text-align: center;
	        }
	        .swipe-bg.right {
	          background: rgba(var(--rgb-success-color, 46, 125, 50), 0.18);
	        }
	        .swipe-bg.left {
	          background: rgba(var(--rgb-error-color, 211, 47, 47), 0.18);
	        }
        .actions { display:flex; gap: 8px; flex-wrap:wrap; }
		        .actions button {
		          font: inherit;
		          border: 1px solid var(--wt-border);
		          border-radius: 999px;
		          padding: 9px 14px;
		          background: var(--wt-surface);
		          color: var(--primary-text-color);
		          cursor: pointer;
		          min-height: 40px;
		        }
	        .actions button.primary {
	          background: var(--primary-color);
	          border-color: var(--primary-color);
	          color: var(--text-primary-color, #fff);
	        }
	        .actions button.danger, button.danger {
	          background: var(--error-color);
	          border-color: var(--error-color);
	          color: var(--text-primary-color, #fff);
	          font-weight: 900;
	        }
	        .actions button:disabled { opacity: 0.6; cursor: not-allowed; }
	        .pillbtn {
	          font: inherit;
	          border: 1px solid var(--wt-border);
	          border-radius: 999px;
	          padding: 7px 12px;
	          background: var(--wt-surface);
	          color: var(--primary-text-color);
	          cursor: pointer;
	          min-height: 34px;
	        }
	        .pillbtn:disabled { opacity: 0.6; cursor: not-allowed; }
	        .pillbtn.danger {
	          background: var(--error-color);
	          border-color: var(--error-color);
	          color: var(--text-primary-color, #fff);
	          font-weight: 900;
	        }
        .label { font-size: 12px; color: var(--secondary-text-color); margin-bottom: 6px; }
	        select, input {
	          width: 100%;
	          box-sizing: border-box;
	          font: inherit;
	          border: 1px solid var(--wt-border);
	          border-radius: var(--wt-radius-sm);
	          padding: 10px;
	          background: var(--wt-surface);
	          color: var(--primary-text-color);
	        }
	        .hint { font-size: 12px; color: var(--secondary-text-color); margin-top: 8px; }
	        .error { color: var(--error-color); font-size: 13px; margin-top: 8px; }
	        .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
        .row > * { min-width: 180px; flex: 1 1 180px; }
        .row.compact > * { min-width: 140px; }
        .chiprow { display:flex; gap: 8px; flex-wrap: wrap; }
        .chip {
          font: inherit;
          border: 1px solid var(--divider-color);
          border-radius: 999px;
          padding: 8px 10px;
          background: var(--card-background-color);
          color: var(--primary-text-color);
          cursor: pointer;
          display:flex;
          align-items:center;
          gap: 8px;
        }
        .chip.active { border-color: var(--primary-color); box-shadow: 0 0 0 1px var(--primary-color) inset; }
        .avatar {
          width: 22px;
          height: 22px;
          border-radius: 999px;
          display:inline-flex;
          align-items:center;
          justify-content:center;
          background: var(--primary-color);
          color: var(--text-primary-color, #fff);
          font-size: 12px;
          font-weight: 700;
        }
        .divider { height: 1px; background: var(--divider-color); margin: 12px 0; }
        .icon-btn { font: inherit; border: 1px solid var(--divider-color); border-radius: 10px; padding: 6px 10px; background: var(--card-background-color); cursor:pointer; }
        .modal-backdrop {
          position: fixed;
          inset: 0;
          /* Use HA/Material scrim color when available (neutral, theme-aware). */
          background: var(--mdc-dialog-scrim-color, rgba(0,0,0,0.35));
          display:flex;
          align-items:center;
          justify-content:center;
          padding: 16px;
          z-index: 999;
        }
	        .modal {
	          width: min(820px, 100%);
	          max-height: min(82vh, 760px);
	          overflow: hidden;
	          background: var(--card-background-color);
	          color: var(--primary-text-color);
	          border: 1px solid var(--divider-color);
	          border-radius: 12px;
	          box-shadow: var(--ha-card-box-shadow, 0 10px 28px rgba(0,0,0,0.22));
	          display:flex;
	          flex-direction: column;
	        }
	        .modal-h { display:flex; align-items:center; justify-content:space-between; gap: 10px; padding: 12px 12px 8px 12px; }
	        .modal-title { font-weight: 700; }
	        .modal-b { padding: 12px; overflow: auto; -webkit-overflow-scrolling: touch; }
	        .modal-f {
	          padding: 10px 12px;
	          border-top: 1px solid var(--divider-color);
	          background: var(--card-background-color);
	          display:flex;
	          align-items:center;
	          justify-content:flex-end;
	          gap: 10px;
	        }
	        .modal-f > span { flex: 1 1 auto; }
	        .modal-f button {
	          font: inherit;
	          border: 1px solid var(--wt-border);
	          border-radius: 999px;
	          padding: 9px 14px;
	          background: var(--wt-surface);
	          color: var(--primary-text-color);
	          cursor: pointer;
	          min-height: 40px;
	          min-width: 96px;
	        }
	        .modal-f button.primary {
	          background: var(--primary-color);
	          border-color: var(--primary-color);
	          color: var(--text-primary-color, #fff);
	          font-weight: 800;
	        }
	        .modal-f button.danger {
	          background: var(--error-color);
	          border-color: var(--error-color);
	          color: var(--text-primary-color, #fff);
	          font-weight: 900;
	        }
	        .modal-f button:disabled { opacity: 0.6; cursor: not-allowed; }
	        .snack{
	          position: sticky;
	          bottom: 12px;
	          left: 0;
	          right: 0;
	          margin-top: 12px;
	          display:flex;
	          align-items:center;
	          justify-content:space-between;
	          gap: 10px;
	          padding: 10px 12px;
	          border-radius: 14px;
	          border: 1px solid var(--wt-border);
	          background: var(--wt-surface);
	          box-shadow: 0 8px 24px rgba(0,0,0,0.12);
	          z-index: 5;
	        }
	        .snack-msg{ font-size: 13px; font-weight: 700; color: var(--primary-text-color); flex: 1 1 auto; }
	        .snack-act{
	          font: inherit;
	          border: 1px solid var(--wt-border);
	          border-radius: 999px;
	          padding: 7px 10px;
	          background: var(--wt-subtle);
	          cursor: pointer;
	          font-weight: 900;
	        }
	        .snack-x{
	          width: 34px;
	          height: 34px;
	          border-radius: 999px;
	          border: 1px solid var(--wt-border);
	          background: var(--wt-surface);
	          cursor:pointer;
	          font-size: 18px;
	          line-height: 0;
	        }
        .xlist { border: 1px solid var(--divider-color); border-radius: 12px; overflow: auto; max-height: 360px; }
        .xrow { display:flex; gap: 10px; align-items:center; padding: 10px; border-bottom: 1px solid var(--divider-color); }
        .xrow:last-child { border-bottom: 0; }
        .xcheck { width: 18px; height: 18px; }
        .xname { font-size: 13px; font-weight: 600; flex: 0 0 auto; }
        .xtags { font-size: 12px; color: var(--secondary-text-color); overflow:hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; }
        .xcustom { display:flex; align-items:center; justify-content:space-between; gap: 10px; padding: 10px; border-bottom: 1px solid var(--divider-color); }
        .xcustom:last-child { border-bottom: 0; }
        .xsections { display:flex; flex-direction:column; gap: 14px; }
        .xsec-h { font-size: 12px; font-weight: 800; letter-spacing: 0.2px; color: var(--primary-text-color); margin: 0 0 8px 0; }
        .xgrid { display:grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; }
        .xtile {
          border: 1px solid var(--divider-color);
          border-radius: 12px;
          padding: 10px;
          background: var(--card-background-color);
          display:flex;
          flex-direction:column;
          gap: 6px;
          cursor: pointer;
          user-select: none;
        }
        .xtile.off { opacity: 0.55; }
        .xtop { display:flex; align-items:flex-start; justify-content:space-between; gap: 10px; }
        .xname2 { font-size: 13px; font-weight: 700; line-height: 1.15; }
        .xtoggle { width: 18px; height: 18px; margin-top: 2px; }
        .xtags2 { font-size: 12px; color: var(--secondary-text-color); min-height: 16px; }
        .xbadge {
          align-self: flex-start;
          font-size: 11px;
          border: 1px solid var(--divider-color);
          border-radius: 999px;
          padding: 3px 8px;
          color: var(--secondary-text-color);
        }
      </style>

	      <ha-card>
	        <div class="wrap">
	          ${this._error ? `<div class="error">${this._escape(this._error)}</div>` : ""}
		          ${loading ? `<div class="muted">Loading\u2026</div>` : ""}

		          <div class="header">
		            <div class="h-title">${this._escape(String(title || ""))}</div>
		            ${onboarding}
		            <div class="topbar" aria-label="Header">
		              <div class="weekpill" aria-label="Week">
		                <button class="wkbtn" id="wk-prev" title="Previous week" ${saving || loading || weekOffset <= -3 ? "disabled" : ""}>
		                  <ha-icon icon="mdi:chevron-left"></ha-icon>
		                </button>
		                <button class="wkcenter" id="wk-reset" title="${weekOffset === 0 ? "Current week" : "Back to current week"}" ${saving || loading ? "disabled" : ""}>
		                  <div class="wk">${this._escape(weekLabel)}${weekDelta ? ` <span class="wkdelta">(${this._escape(weekDelta)})</span>` : ""}</div>
		                  <div class="range">${this._escape(weekRange || "")}</div>
		                </button>
		                <button class="wkbtn" id="wk-next" title="Next week" ${saving || loading || weekOffset >= 3 ? "disabled" : ""}>
		                  <ha-icon icon="mdi:chevron-right"></ha-icon>
		                </button>
		              </div>

		              <div class="toppeople" aria-label="People list">
		                <div class="peoplelabel">People</div>
		                <div class="peoplechips">
		                  ${people.map((p) => {
		                    const pid = String((p && p.id) || "");
		                    const nm = String((p && p.name) || "");
		                    const initial = (nm || "?").slice(0, 1).toUpperCase();
		                    const active = pid === activeId;
		                    const color = this._personColor(p);
		                    return `<button class="pchip ${active ? "active" : ""}" data-person="${this._escape(pid)}" ${saving ? "disabled" : ""}><span class="pcircle" style="background:${this._escape(color)}">${this._escape(initial)}</span><span class="pname">${this._escape(nm || pid)}</span></button>`;
		                  }).join("")}
		                  <button class="pchip add" id="person-add" title="Add person" ${saving ? "disabled" : ""}>+</button>
		                </div>
		              </div>

		              <button class="gearbtn" id="settings" title="Exercise settings" ${saving ? "disabled" : ""}>
		                <ha-icon icon="mdi:tune-variant"></ha-icon>
		              </button>
		            </div>
		          </div>

          <div class="layout">
	            <div class="days" role="list" aria-label="Weekdays">
		              ${daysDa.map((d, idx) => {
		                const w0 = workoutsByDay[idx];
		                const w = w0 && w0.completed ? null : w0;
		                const entries = allByDay[idx] || [];
		                const activeCls = idx === selectedDay ? "active" : "";
		                const isToday = weekOffset === 0 && idx === todayWeekday;
		                const isPlanned = cycleInfo.enabled && trainingDays.includes(idx);
		                const dateShort = dayDates[idx] ? String(dayDates[idx]) : "";
		                const small = w ? (w.completed ? "Completed" : String(w.name || "Session")) : "Tap to add";
		                return `
		                  <button class="day ${activeCls} ${isToday ? "today" : ""} ${isPlanned ? "planned" : ""}" data-day="${idx}" ${saving ? "disabled" : ""}>
		                    <div class="meta">
		                      <div class="name">${this._escape(d)}</div>
		                      <div class="hint2">${dateShort ? this._escape(dateShort) + " \u2022 " : ""}${this._escape(small)}</div>
		                    </div>
		                    <div class="daybadges">
		                      ${isToday ? `<span class="badge today">TODAY</span>` : ``}
		                      ${isPlanned ? `<span class="badge planned">Planned</span>` : ``}
		                      ${entries.length ? entries.map((x) => {
		                        const p = x.person;
		                        const w3 = x.workout;
		                        const nm = String((p && p.name) || "");
		                        const initial = (nm || "?").slice(0, 1).toUpperCase();
		                        const color = this._personColor(p);
		                        const label = "Workout";
		                        return `<span class="wbadge" style="border-color:${this._escape(color)}"><span class="mini" style="background:${this._escape(color)}">${this._escape(initial)}</span><span class="wtext">${this._escape(label)}</span></span>`;
		                      }).join("") : `<span class="badge">Empty</span>`}
		                    </div>
		                  </button>
		                `;
		              }).join("")}
		            </div>

			            <div class="main ${saving ? "busy" : ""}" id="main-panel">
			              ${saving ? `<div class="busy-overlay"><div class="spinner"></div><div class="muted" style="font-weight:800">Working\u2026</div></div>` : ``}
			              <div class="mainhead">
		                <div>
		                  <div class="dtitle">${this._escape(daysDa[selectedDay] || "Day")}</div>
		                  <div class="dsub">
		          ${(() => {
		                      const ds = dayDates[selectedDay] ? String(dayDates[selectedDay]) : "";
		                      if (selectedWorkout) {
		                        return `${this._escape(ds ? ds + " \u2022 " : "")}${this._escape(String(selectedWorkout.name || "Session"))} \u2022 ${this._escape(String(selectedWorkout.date || ""))}`;
		                      }
		                      return `${this._escape(ds ? ds + " \u2022 " : "")}Tap to add`;
		                    })()}
		                  </div>
		                </div>
		                <div class="pill">${selectedWorkout ? "Workout" : "Empty"}</div>
		              </div>
			              ${selectedWorkout ? `
			                <div class="swipehint">Swipe right: completed. Swipe left: delete.</div>
			                <div class="items swipable" id="swipe-zone">
			                  <div class="swipe-bg" id="swipe-bg" aria-hidden="true">
			                    <div class="swipe-bubble" id="swipe-bubble"></div>
			                  </div>
			                  ${(Array.isArray(selectedWorkout.items) ? selectedWorkout.items : []).map((it) => {
			                    if (!it || typeof it !== "object") return "";
			                    const ex = String(it.exercise || "");
			                    const sr = String(it.sets_reps || "");
			                    const load = it.suggested_load != null ? String(it.suggested_load) : "";
		                    return `<div class="item"><div class="ex">${this._escape(ex)}</div><div class="range">${this._escape(sr)}${load ? ` \u2022 ~${this._escape(load)}` : ""}</div></div>`;
		                  }).join("")}
		                </div>
		              ` : `
		                <div class="empty-main">
		                  <div class="empty-card">
		                    <div class="empty-title">Her kommer dit tr\u00e6ningspas</div>
		                    <div class="empty-sub">Tap to add</div>
		                    <div class="actions" style="margin-top:12px; justify-content:center">
		                      <button class="primary" id="open-workout" ${saving ? "disabled" : ""}>Create workout</button>
		                      <button id="open-cycle" ${saving ? "disabled" : ""}>Plan 4-week cycle</button>
		                    </div>
		                  </div>
		                </div>
		              `}
		            </div>
		          </div>

	          ${(() => {
	            const wk = weekStartIso ? String(weekStartIso).slice(0, 10) : "";
	            const out = [];
	            const plans = this._state && this._state.plans && typeof this._state.plans === "object" ? this._state.plans : null;
	            if (wk && plans) {
	              for (let i = 0; i < people.length; i++) {
	                const p = people[i];
	                const pid = String((p && p.id) || "");
	                if (!pid) continue;
	                const personPlans = plans[pid];
	                const plan2 = personPlans && typeof personPlans === "object" ? personPlans[wk] : null;
	                const workouts2 = plan2 && Array.isArray(plan2.workouts) ? plan2.workouts : [];
	                for (let j = 0; j < workouts2.length; j++) {
	                  const w = workouts2[j];
	                  if (!w || typeof w !== "object") continue;
	                  if (!w.completed) continue;
	                  out.push({ person: p, workout: w });
	                }
	              }
	            }
	            out.sort((a, b) => String(a.workout.date || "").localeCompare(String(b.workout.date || "")));
		            const chips = out.map((x) => {
		              const p = x.person;
		              const w = x.workout;
		              const nm = String((p && p.name) || "");
		              const initial = (nm || "?").slice(0, 1).toUpperCase();
		              const color = this._personColor(p);
		              const dateIso = String(w.date || "");
		              const label = String(w.name || "Session");
		              return `<div class="cb-chip" data-cw-person="${this._escape(String((p && p.id) || ""))}" data-cw-date="${this._escape(dateIso)}"><span class="pcircle" style="background:${this._escape(color)}">${this._escape(initial)}</span>${this._escape(label)} \u2022 ${this._escape(dateIso)}</div>`;
		            }).join("");
	            return `
	              <div class="completedbar">
	                <div class="cb-h">
	                  <div class="cb-title">Completed</div>
	                  <div class="muted">${this._escape(String(out.length))}</div>
	                </div>
	                <div class="cb-chips">
	                  ${chips || `<div class="muted">No completed workouts this week.</div>`}
	                </div>
	              </div>
	            `;
		          })()}

		          ${peopleModal}
		          ${workoutModal}
		          ${settingsModal}
		          ${cycleModal}
		          ${editWorkoutModal}
		          ${confirmDeleteModal}
		          ${historyModal}
		          ${completedModal}
		          ${toast}
		        </div>
		      </ha-card>
		    `;

	    // Wire events (header)
		    const qSettings = this.shadowRoot ? this.shadowRoot.querySelector("#settings") : null;
		    if (qSettings) qSettings.addEventListener("click", () => { this._openSettingsModal(); });
	    const qWkPrev = this.shadowRoot ? this.shadowRoot.querySelector("#wk-prev") : null;
	    if (qWkPrev) qWkPrev.addEventListener("click", () => { this._setWeekOffset(this._clampWeekOffset(this._weekOffset) - 1); });
	    const qWkNext = this.shadowRoot ? this.shadowRoot.querySelector("#wk-next") : null;
	    if (qWkNext) qWkNext.addEventListener("click", () => { this._setWeekOffset(this._clampWeekOffset(this._weekOffset) + 1); });
	    const qWkReset = this.shadowRoot ? this.shadowRoot.querySelector("#wk-reset") : null;
	    if (qWkReset) qWkReset.addEventListener("click", () => { if (this._clampWeekOffset(this._weekOffset) !== 0) this._setWeekOffset(0); });
	    const qOnPeople = this.shadowRoot ? this.shadowRoot.querySelector("#on-people") : null;
	    if (qOnPeople) qOnPeople.addEventListener("click", () => { this._openPersonModal(""); });
	    const qPersonAdd = this.shadowRoot ? this.shadowRoot.querySelector("#person-add") : null;
	    if (qPersonAdd) qPersonAdd.addEventListener("click", () => { this._openPersonModal(""); });
    this.shadowRoot.querySelectorAll("button.pchip[data-person]").forEach((btn) => {
      btn.addEventListener("pointerdown", (e) => {
        const pid = String(e.currentTarget.getAttribute("data-person") || "");
        if (!pid) return;
        const lp = this._ui.longPress;
        if (lp && lp.timer) window.clearTimeout(lp.timer);
        if (lp) lp.fired = false;
        if (lp) {
          lp.timer = window.setTimeout(() => {
            lp.fired = true;
            this._openPersonModal(pid);
          }, 520);
        }
      });
      btn.addEventListener("pointerup", () => {
        const lp = this._ui.longPress;
        if (lp && lp.timer) window.clearTimeout(lp.timer);
        if (lp) lp.timer = 0;
      });
      btn.addEventListener("pointercancel", () => {
        const lp = this._ui.longPress;
        if (lp && lp.timer) window.clearTimeout(lp.timer);
        if (lp) lp.timer = 0;
      });
      btn.addEventListener("click", (e) => {
        const pid = String(e.currentTarget.getAttribute("data-person") || "");
        if (!pid) return;
        const lp = this._ui.longPress;
        if (lp && lp.fired) return;
        this._setActivePerson(pid);
      });
    });

    this.shadowRoot.querySelectorAll("button.day[data-day]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const d = Number(e.currentTarget.getAttribute("data-day"));
        if (!Number.isFinite(d)) return;
        this._ui.selectedDay = d;
        this._ui.workoutPersonId = String(this._activePersonId() || this._defaultPersonId() || "");
        this._ui.showWorkout = true;
        this._render();
      });
    });

    const qOpenWorkout = this.shadowRoot ? this.shadowRoot.querySelector("#open-workout") : null;
    if (qOpenWorkout) qOpenWorkout.addEventListener("click", () => {
      this._ui.workoutPersonId = String(this._activePersonId() || this._defaultPersonId() || "");
      this._ui.showWorkout = true;
      this._render();
    });
    const qOpenCycle = this.shadowRoot ? this.shadowRoot.querySelector("#open-cycle") : null;
    if (qOpenCycle) qOpenCycle.addEventListener("click", () => { this._openCyclePlanner(); });

		    // People modal
		    const qPeopleClose = this.shadowRoot ? this.shadowRoot.querySelector("#people-close") : null;
		    if (qPeopleClose) qPeopleClose.addEventListener("click", () => { this._ui.showPeople = false; this._render(); });
    const qPeopleBackdrop = this.shadowRoot ? this.shadowRoot.querySelector("#people-backdrop") : null;
    if (qPeopleBackdrop) qPeopleBackdrop.addEventListener("click", (e) => {
      if (e.target && e.target.id === "people-backdrop") { this._ui.showPeople = false; this._render(); }
    });
    const qPName = this.shadowRoot ? this.shadowRoot.querySelector("#p-name") : null;
    if (qPName) qPName.addEventListener("input", (e) => { this._newPerson.name = String(e.target.value || ""); });
    const qPColor = this.shadowRoot ? this.shadowRoot.querySelector("#p-color") : null;
    if (qPColor) qPColor.addEventListener("input", (e) => { this._newPerson.color = String(e.target.value || ""); });
    const qPGender = this.shadowRoot ? this.shadowRoot.querySelector("#p-gender") : null;
    if (qPGender) qPGender.addEventListener("change", (e) => { this._newPerson.gender = String(e.target.value || "male"); });
    const qPUnits = this.shadowRoot ? this.shadowRoot.querySelector("#p-units") : null;
    if (qPUnits) qPUnits.addEventListener("change", (e) => { this._newPerson.units = String(e.target.value || "kg"); });
    const qPMin = this.shadowRoot ? this.shadowRoot.querySelector("#p-minutes") : null;
    if (qPMin) qPMin.addEventListener("input", (e) => { this._newPerson.duration_minutes = Number(e.target.value || 45); });
    const qPEq = this.shadowRoot ? this.shadowRoot.querySelector("#p-equipment") : null;
    if (qPEq) qPEq.addEventListener("input", (e) => { this._newPerson.equipment = String(e.target.value || ""); });
    const qPPref = this.shadowRoot ? this.shadowRoot.querySelector("#p-pref") : null;
    if (qPPref) qPPref.addEventListener("input", (e) => { this._newPerson.preferred_exercises = String(e.target.value || ""); });
    const qPSq = this.shadowRoot ? this.shadowRoot.querySelector("#p-sq") : null;
    if (qPSq) qPSq.addEventListener("input", (e) => { this._newPerson.max_squat = Number(e.target.value || 0); });
    const qPDl = this.shadowRoot ? this.shadowRoot.querySelector("#p-dl") : null;
    if (qPDl) qPDl.addEventListener("input", (e) => { this._newPerson.max_deadlift = Number(e.target.value || 0); });
    const qPBp = this.shadowRoot ? this.shadowRoot.querySelector("#p-bp") : null;
    if (qPBp) qPBp.addEventListener("input", (e) => { this._newPerson.max_bench = Number(e.target.value || 0); });
    const qPSave = this.shadowRoot ? this.shadowRoot.querySelector("#p-save") : null;
    if (qPSave) qPSave.addEventListener("click", () => this._addPerson());
    const qPSet = this.shadowRoot ? this.shadowRoot.querySelector("#p-set-active") : null;
    if (qPSet) qPSet.addEventListener("click", () => { const pid = String(this._ui.editPersonId || ""); if (pid) this._setActivePerson(pid); });
		    const qPDel = this.shadowRoot ? this.shadowRoot.querySelector("#p-delete") : null;
		    if (qPDel) qPDel.addEventListener("click", () => { const pid = String(this._ui.editPersonId || ""); if (pid) this._deletePerson(pid); });

		    // Workout modal
		    const qWorkoutClose = this.shadowRoot ? this.shadowRoot.querySelector("#workout-close") : null;
		    if (qWorkoutClose) qWorkoutClose.addEventListener("click", () => { this._ui.showWorkout = false; this._render(); });
		    const qWorkoutCancel = this.shadowRoot ? this.shadowRoot.querySelector("#w-cancel") : null;
		    if (qWorkoutCancel) qWorkoutCancel.addEventListener("click", () => { this._ui.showWorkout = false; this._render(); });
    const qWorkoutBackdrop = this.shadowRoot ? this.shadowRoot.querySelector("#workout-backdrop") : null;
    if (qWorkoutBackdrop) qWorkoutBackdrop.addEventListener("click", (e) => {
      if (e.target && e.target.id === "workout-backdrop") { this._ui.showWorkout = false; this._render(); }
    });
    const qWMode = this.shadowRoot ? this.shadowRoot.querySelector("#w-mode") : null;
    if (qWMode) qWMode.addEventListener("change", (e) => {
      this._draft.planning_mode = String(e.target.value || "auto");
      const wrap = this.shadowRoot.querySelector("#manual-wrap");
      if (wrap) wrap.style.display = String(this._draft.planning_mode) === "manual" ? "" : "none";
    });
    const qWPerson = this.shadowRoot ? this.shadowRoot.querySelector("#w-person") : null;
    if (qWPerson) qWPerson.addEventListener("change", (e) => { this._ui.workoutPersonId = String(e.target.value || ""); });
    const qWMinutes = this.shadowRoot ? this.shadowRoot.querySelector("#w-minutes") : null;
    if (qWMinutes) qWMinutes.addEventListener("input", (e) => { this._draft.duration_minutes = Number(e.target.value || 45); });
    const qWIntensity = this.shadowRoot ? this.shadowRoot.querySelector("#w-intensity") : null;
    if (qWIntensity) qWIntensity.addEventListener("change", (e) => { this._draft.intensity = String(e.target.value || "normal"); });
    const qWPref = this.shadowRoot ? this.shadowRoot.querySelector("#w-pref") : null;
    if (qWPref) qWPref.addEventListener("input", (e) => { this._draft.preferred_exercises = String(e.target.value || ""); });
	    const qWGen = this.shadowRoot ? this.shadowRoot.querySelector("#w-generate") : null;
	    if (qWGen) qWGen.addEventListener("click", async () => {
	      const d = Number(this._ui.selectedDay);
	      this._selectedWeekday = Number.isFinite(d) ? d : null;
	      const pid = String(this._ui.workoutPersonId || this._activePersonId() || this._defaultPersonId() || "");
	      // If a 4-week cycle is enabled and the day is not planned, ask for confirmation.
	      try {
	        const cy = this._draft && this._draft.cycle && typeof this._draft.cycle === "object" ? this._draft.cycle : null;
	        const rt = (this._state && this._state.runtime) || {};
	        const wk = this._selectedWeekStartIso(rt);
	        const info = this._cycleIndexForWeekStart(cy, wk);
	        const tds = cy && Array.isArray(cy.training_weekdays) ? cy.training_weekdays : [];
	        const isPlanned = info.enabled && tds.map((x) => Number(x)).includes(d);
	        if (info.enabled && !isPlanned) {
	          const ok = window.confirm("This is not a planned training day. Generate anyway?");
	          if (!ok) return;
	        }
	      } catch (_) {}
	      if (String(this._draft.planning_mode || "auto") === "manual") {
	        const slot = d <= 1 ? "a" : (d <= 3 ? "b" : "c");
	        const qLower = this.shadowRoot ? this.shadowRoot.querySelector("#w-lower") : null;
	        const qPush = this.shadowRoot ? this.shadowRoot.querySelector("#w-push") : null;
	        const qPull = this.shadowRoot ? this.shadowRoot.querySelector("#w-pull") : null;
        const lower = String(qLower ? qLower.value : "").trim();
        const push = String(qPush ? qPush.value : "").trim();
        const pull = String(qPull ? qPull.value : "").trim();
        const next = { ...(this._draft.session_overrides || {}) };
        next[`${slot}_lower`] = lower;
        next[`${slot}_push`] = push;
        next[`${slot}_pull`] = pull;
        this._draft.session_overrides = next;
      }
	      this._ui.showWorkout = false;
	      if (pid) {
	        await this._setActivePerson(pid);
	      }
	      await this._generate(pid);
	    });

	    // Cycle planner modal
	    const qCycleClose = this.shadowRoot ? this.shadowRoot.querySelector("#cycle-close") : null;
	    if (qCycleClose) qCycleClose.addEventListener("click", () => { this._ui.showCyclePlanner = false; this._ui.cycleDraft = null; this._render(); });
	    const qCycleCancel = this.shadowRoot ? this.shadowRoot.querySelector("#cycle-cancel") : null;
	    if (qCycleCancel) qCycleCancel.addEventListener("click", () => { this._ui.showCyclePlanner = false; this._ui.cycleDraft = null; this._render(); });
	    const qCycleBackdrop = this.shadowRoot ? this.shadowRoot.querySelector("#cycle-backdrop") : null;
	    if (qCycleBackdrop) qCycleBackdrop.addEventListener("click", (e) => {
	      if (e.target && e.target.id === "cycle-backdrop") { this._ui.showCyclePlanner = false; this._ui.cycleDraft = null; this._render(); }
	    });
	    const qCyPerson = this.shadowRoot ? this.shadowRoot.querySelector("#cy-person") : null;
	    if (qCyPerson) qCyPerson.addEventListener("change", (e) => { if (this._ui.cycleDraft) this._ui.cycleDraft.person_id = String(e.target.value || ""); });
	    const qCyPreset2 = this.shadowRoot ? this.shadowRoot.querySelector("#cy-preset2") : null;
	    if (qCyPreset2) qCyPreset2.addEventListener("change", (e) => {
	      if (!this._ui.cycleDraft) return;
	      const p = String(e.target.value || "strength");
	      this._ui.cycleDraft.preset = p;
	      // Apply preset defaults into the draft.
	      this._applyCyclePreset(p);
	      // Pull values from draft.cycle (updated by _applyCyclePreset).
	      this._ui.cycleDraft.step_pct = Number(this._draft.cycle && this._draft.cycle.step_pct != null ? this._draft.cycle.step_pct : this._ui.cycleDraft.step_pct);
	      this._ui.cycleDraft.deload_pct = Number(this._draft.cycle && this._draft.cycle.deload_pct != null ? this._draft.cycle.deload_pct : this._ui.cycleDraft.deload_pct);
	      this._ui.cycleDraft.deload_volume = Number(this._draft.cycle && this._draft.cycle.deload_volume != null ? this._draft.cycle.deload_volume : this._ui.cycleDraft.deload_volume);
	      this._render();
	    });
	    const qCyWeeks = this.shadowRoot ? this.shadowRoot.querySelector("#cy-weeks") : null;
	    if (qCyWeeks) qCyWeeks.addEventListener("input", (e) => { if (this._ui.cycleDraft) this._ui.cycleDraft.weeks = Number(e.target.value || 4); });
	    const qCyStep2 = this.shadowRoot ? this.shadowRoot.querySelector("#cy-step2") : null;
	    if (qCyStep2) qCyStep2.addEventListener("input", (e) => { if (this._ui.cycleDraft) this._ui.cycleDraft.step_pct = Number(e.target.value || 0); });
	    const qCyDeload2 = this.shadowRoot ? this.shadowRoot.querySelector("#cy-deload2") : null;
	    if (qCyDeload2) qCyDeload2.addEventListener("input", (e) => { if (this._ui.cycleDraft) this._ui.cycleDraft.deload_pct = Number(e.target.value || 0); });
	    const qCyVol2 = this.shadowRoot ? this.shadowRoot.querySelector("#cy-vol2") : null;
	    if (qCyVol2) qCyVol2.addEventListener("input", (e) => { if (this._ui.cycleDraft) this._ui.cycleDraft.deload_volume = Number(e.target.value || 0.65); });
	    this.shadowRoot && this.shadowRoot.querySelectorAll("button.wday[data-cy-wd]").forEach((btn) => {
	      btn.addEventListener("click", (e) => {
	        if (!this._ui.cycleDraft) return;
	        const wd = Number(e.currentTarget.getAttribute("data-cy-wd"));
	        if (!Number.isFinite(wd)) return;
	        const cur = Array.isArray(this._ui.cycleDraft.training_weekdays) ? this._ui.cycleDraft.training_weekdays.slice() : [];
	        const idx = cur.indexOf(wd);
	        if (idx >= 0) cur.splice(idx, 1);
	        else cur.push(wd);
	        cur.sort((a, b) => a - b);
	        this._ui.cycleDraft.training_weekdays = cur;
	        this._render();
	      });
	    });
	    const qCyclePlan = this.shadowRoot ? this.shadowRoot.querySelector("#cycle-plan") : null;
	    if (qCyclePlan) qCyclePlan.addEventListener("click", () => { this._planCycle(); });

		    // Swipe actions on the generated workout (tablet-first).
		    const swipeZone = this.shadowRoot ? this.shadowRoot.querySelector("#swipe-zone") : null;
			    if (swipeZone && selectedWorkout) {
			      const pid = String(viewPersonId || this._activePersonId() || "");
			      const wk = String(weekStartIso || "").slice(0, 10);
			      const dateIso = String(selectedWorkout.date || "");
			      const bg = this.shadowRoot ? this.shadowRoot.querySelector("#swipe-bg") : null;
			      const bubble = this.shadowRoot ? this.shadowRoot.querySelector("#swipe-bubble") : null;
		      const clearSwipeUI = () => {
		        try {
		          swipeZone.style.setProperty("--swipe-p", "0");
		          if (bg) { bg.classList.remove("left"); bg.classList.remove("right"); }
		          if (bubble) bubble.textContent = "";
		        } catch (_) {}
		      };
			      clearSwipeUI();
			      // Long-press opens the workout details popup (edit/delete).
			      let lpTimer = 0;
			      let lpStartX = 0;
			      let lpStartY = 0;
			      const lpClear = () => { if (lpTimer) window.clearTimeout(lpTimer); lpTimer = 0; };
			      swipeZone.addEventListener("pointerdown", (e) => {
			        try {
			          lpClear();
			          lpStartX = Number(e.clientX) || 0;
			          lpStartY = Number(e.clientY) || 0;
			          lpTimer = window.setTimeout(() => {
			            lpTimer = 0;
			            this._openEditWorkoutModal(pid, wk, selectedWorkout);
			          }, 520);
			        } catch (_) {}
			      });
			      swipeZone.addEventListener("pointermove", (e) => {
			        try {
			          if (!lpTimer) return;
			          const dx = Math.abs((Number(e.clientX) || 0) - lpStartX);
			          const dy = Math.abs((Number(e.clientY) || 0) - lpStartY);
			          if (dx > 10 || dy > 10) lpClear();
			        } catch (_) {}
			      });
			      swipeZone.addEventListener("pointerup", () => { lpClear(); });
			      swipeZone.addEventListener("pointercancel", () => { lpClear(); });
	      swipeZone.addEventListener("touchstart", (e) => {
	        try {
	          const t = e.touches && e.touches[0];
	          if (t) {
	            this._ui.swipeX = Number(t.clientX) || 0;
	            this._ui.swipeY = Number(t.clientY) || 0;
	          }
	        } catch (_) {}
	      }, { passive: true });
	      swipeZone.addEventListener("touchmove", (e) => {
	        try {
	          const t = e.touches && e.touches[0];
	          if (!t) return;
	          const dx = (Number(t.clientX) || 0) - Number(this._ui.swipeX || 0);
	          const dy = (Number(t.clientY) || 0) - Number(this._ui.swipeY || 0);
	          const adx = Math.abs(dx);
	          const ady = Math.abs(dy);
	          // Only treat as swipe when the gesture is clearly horizontal.
	          if (adx < 12 || adx < (ady + 6)) { clearSwipeUI(); return; }
	          const p = Math.max(0, Math.min(1, adx / 110));
	          swipeZone.style.setProperty("--swipe-p", String(p));
	          if (!bg || !bubble) return;
	          if (dx > 0) {
	            bg.classList.add("right");
	            bg.classList.remove("left");
	            bubble.textContent = "Release to complete";
	          } else if (dx < 0) {
	            bg.classList.add("left");
	            bg.classList.remove("right");
	            bubble.textContent = "Release to delete";
	          } else {
	            bg.classList.remove("left");
	            bg.classList.remove("right");
	            bubble.textContent = "";
	          }
	          // Prevent vertical scroll when the user is clearly swiping horizontally.
	          if (typeof e.preventDefault === "function") e.preventDefault();
	        } catch (_) {}
	      }, { passive: false });
	      swipeZone.addEventListener("touchend", async (e) => {
	        try {
	          const t = e.changedTouches && e.changedTouches[0];
	          if (!t) return;
	          const dx = (Number(t.clientX) || 0) - Number(this._ui.swipeX || 0);
	          const dy = (Number(t.clientY) || 0) - Number(this._ui.swipeY || 0);
	          const adx = Math.abs(dx);
	          const ady = Math.abs(dy);
	          if (adx < (ady + 6)) { clearSwipeUI(); return; }
	          const threshold = 80;
	          if (adx < threshold) { clearSwipeUI(); return; }
		          if (!pid || !wk || !dateIso) return;
		          if (dx > 0) {
		            const next = !Boolean(selectedWorkout.completed);
		            await this._setWorkoutCompleted(pid, wk, dateIso, next);
		            if (next) {
		              this._showToast("Marked completed", "Undo", { kind: "toggle_completed", person_id: pid, week_start: wk, date: dateIso, completed: false });
		            }
		          } else {
			            const cy = selectedWorkout && selectedWorkout.cycle && typeof selectedWorkout.cycle === "object" ? selectedWorkout.cycle : null;
			            if (cy && cy.enabled) {
			              // Offer delete single vs series.
			              this._openDeleteChoiceForWorkout(pid, wk, selectedWorkout);
			            } else {
			              const ok = window.confirm("Delete this workout?");
			              if (!ok) return;
			              const snapshot = JSON.parse(JSON.stringify(selectedWorkout));
			              await this._deleteWorkout(pid, wk, dateIso);
			              this._showToast("Workout deleted", "Undo", { kind: "restore_workout", person_id: pid, week_start: wk, workout: snapshot });
			            }
		          }
		          clearSwipeUI();
		        } catch (_) {}
		      }, { passive: true });
		      swipeZone.addEventListener("touchcancel", () => { clearSwipeUI(); }, { passive: true });
		    }

	    // Edit workout modal
	    const qEwClose = this.shadowRoot ? this.shadowRoot.querySelector("#editw-close") : null;
	    if (qEwClose) qEwClose.addEventListener("click", () => { this._ui.showEditWorkout = false; this._ui.editWorkout = null; this._render(); });
	    const qEwCancel = this.shadowRoot ? this.shadowRoot.querySelector("#editw-cancel") : null;
	    if (qEwCancel) qEwCancel.addEventListener("click", () => { this._ui.showEditWorkout = false; this._ui.editWorkout = null; this._render(); });
	    const qEwBackdrop = this.shadowRoot ? this.shadowRoot.querySelector("#editw-backdrop") : null;
	    if (qEwBackdrop) qEwBackdrop.addEventListener("click", (e) => {
	      if (e.target && e.target.id === "editw-backdrop") { this._ui.showEditWorkout = false; this._ui.editWorkout = null; this._render(); }
	    });
	    const qEwName = this.shadowRoot ? this.shadowRoot.querySelector("#ew-name") : null;
	    if (qEwName) qEwName.addEventListener("input", (e) => {
	      if (!this._ui.editWorkout || !this._ui.editWorkout.workout) return;
	      this._ui.editWorkout.workout.name = String(e.target.value || "");
	    });
	    this.shadowRoot && this.shadowRoot.querySelectorAll("input[data-ew-sr]").forEach((el) => {
	      el.addEventListener("input", (e) => {
	        if (!this._ui.editWorkout || !this._ui.editWorkout.workout) return;
	        const idx = Number(e.currentTarget.getAttribute("data-ew-sr"));
	        const items = this._ui.editWorkout.workout.items;
	        if (!Array.isArray(items) || !Number.isFinite(idx) || !items[idx]) return;
	        items[idx].sets_reps = String(e.target.value || "");
	      });
	    });
	    this.shadowRoot && this.shadowRoot.querySelectorAll("input[data-ew-load]").forEach((el) => {
	      el.addEventListener("input", (e) => {
	        if (!this._ui.editWorkout || !this._ui.editWorkout.workout) return;
	        const idx = Number(e.currentTarget.getAttribute("data-ew-load"));
	        const items = this._ui.editWorkout.workout.items;
	        if (!Array.isArray(items) || !Number.isFinite(idx) || !items[idx]) return;
	        const raw = String(e.target.value || "").trim();
	        if (!raw) { delete items[idx].suggested_load; return; }
	        const v = Number(raw);
	        if (Number.isFinite(v)) items[idx].suggested_load = v;
	      });
	    });
	    const qEwSave = this.shadowRoot ? this.shadowRoot.querySelector("#editw-save") : null;
	    if (qEwSave) qEwSave.addEventListener("click", () => { this._saveEditedWorkout(); });
	    const qEwDel = this.shadowRoot ? this.shadowRoot.querySelector("#editw-delete") : null;
	    if (qEwDel) qEwDel.addEventListener("click", () => { this._deleteEditedWorkout(); });

	    // Confirm delete modal (single vs series)
	    const qCfdClose = this.shadowRoot ? this.shadowRoot.querySelector("#cfd-close") : null;
	    if (qCfdClose) qCfdClose.addEventListener("click", () => { this._ui.confirmDelete = null; this._render(); });
	    const qCfdCancel = this.shadowRoot ? this.shadowRoot.querySelector("#cfd-cancel") : null;
	    if (qCfdCancel) qCfdCancel.addEventListener("click", () => { this._ui.confirmDelete = null; this._render(); });
	    const qCfdBackdrop = this.shadowRoot ? this.shadowRoot.querySelector("#cfd-backdrop") : null;
	    if (qCfdBackdrop) qCfdBackdrop.addEventListener("click", (e) => {
	      if (e.target && e.target.id === "cfd-backdrop") { this._ui.confirmDelete = null; this._render(); }
	    });
	    const qCfdOne = this.shadowRoot ? this.shadowRoot.querySelector("#cfd-one") : null;
	    if (qCfdOne) qCfdOne.addEventListener("click", async () => {
	      const d = this._ui.confirmDelete || {};
	      const pid2 = String(d.person_id || "");
	      const wk2 = String(d.week_start || "").slice(0, 10);
	      const date2 = String(d.date || "");
	      if (!pid2 || !wk2 || !date2) return;
	      this._ui.confirmDelete = null;
	      const snapshot = selectedWorkout ? JSON.parse(JSON.stringify(selectedWorkout)) : null;
	      await this._deleteWorkout(pid2, wk2, date2);
	      if (snapshot) this._showToast("Workout deleted", "Undo", { kind: "restore_workout", person_id: pid2, week_start: wk2, workout: snapshot });
	    });
	    const qCfdSeries = this.shadowRoot ? this.shadowRoot.querySelector("#cfd-series") : null;
	    if (qCfdSeries) qCfdSeries.addEventListener("click", async () => {
	      const d = this._ui.confirmDelete || {};
	      const pid2 = String(d.person_id || "");
	      const ss = String(d.series_start || "").slice(0, 10);
	      const wd2 = Number(d.weekday || 0);
	      const weeks2 = Number(d.weeks || 4);
	      if (!pid2 || !ss) return;
	      this._ui.confirmDelete = null;
	      await this._deleteWorkoutSeries(pid2, ss, wd2, weeks2);
	      this._showToast("Series deleted", "", null);
	    });

	    // Settings modal
    const qSettingsClose = this.shadowRoot ? this.shadowRoot.querySelector("#settings-close") : null;
    if (qSettingsClose) qSettingsClose.addEventListener("click", () => { this._ui.showSettings = false; this._settingsDraft = null; this._render(); });
    const qSettingsCancel = this.shadowRoot ? this.shadowRoot.querySelector("#s-cancel") : null;
    if (qSettingsCancel) qSettingsCancel.addEventListener("click", () => { this._ui.showSettings = false; this._settingsDraft = null; this._render(); });
    const qSettingsBackdrop = this.shadowRoot ? this.shadowRoot.querySelector("#settings-backdrop") : null;
    if (qSettingsBackdrop) qSettingsBackdrop.addEventListener("click", (e) => {
      if (e.target && e.target.id === "settings-backdrop") { this._ui.showSettings = false; this._settingsDraft = null; this._render(); }
    });
	    const qSSave = this.shadowRoot ? this.shadowRoot.querySelector("#s-save") : null;
	    if (qSSave) qSSave.addEventListener("click", () => { this._saveExerciseConfig(); });
	    const qCfgHistory = this.shadowRoot ? this.shadowRoot.querySelector("#cfg-history") : null;
	    if (qCfgHistory) qCfgHistory.addEventListener("click", () => {
	      this._ui.showSettings = false;
	      this._settingsDraft = null;
	      this._openHistoryModal();
	    });
	    const qCfgExport = this.shadowRoot ? this.shadowRoot.querySelector("#cfg-export") : null;
	    if (qCfgExport) qCfgExport.addEventListener("click", async () => {
	      try {
	        const res = await this._callWS({ type: "weekly_training/export_config", entry_id: this._entryId });
	        const txt = JSON.stringify((res && res.config) || {}, null, 2);
	        if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
	          await navigator.clipboard.writeText(txt);
	          this._showToast("Export copied", "", null);
	        } else {
	          window.prompt("Copy export JSON", txt);
	        }
	      } catch (e) {
	        this._error = String((e && e.message) || e);
	        this._render();
	      }
	    });
	    const qCfgImport = this.shadowRoot ? this.shadowRoot.querySelector("#cfg-import-open") : null;
	    if (qCfgImport) qCfgImport.addEventListener("click", async () => {
	      try {
	        const raw = window.prompt("Paste export JSON to import");
	        if (!raw) return;
	        const parsed = JSON.parse(String(raw));
	        const res = await this._callWS({ type: "weekly_training/import_config", entry_id: this._entryId, config: parsed });
	        this._applyState((res && res.state) || this._state);
	        this._showToast("Imported", "", null);
	      } catch (e) {
	        this._error = String((e && e.message) || e);
	        this._render();
	      }
	    });
	    const qSQuery = this.shadowRoot ? this.shadowRoot.querySelector("#s-query") : null;
	    if (qSQuery) qSQuery.addEventListener("input", (e) => {
	      if (!this._settingsDraft) return;
	      this._settingsDraft.query = String(e.target.value || "");
      this._applySettingsFilter(this._settingsDraft.query);
    });
    this.shadowRoot.querySelectorAll("input.xtoggle[data-ex]").forEach((el) => {
      el.addEventListener("change", (e) => {
        if (!this._settingsDraft) return;
        const name = String(e.target.getAttribute("data-ex") || "");
        if (!name) return;
        if (e.target.checked) this._settingsDraft.disabled.delete(name);
        else this._settingsDraft.disabled.add(name);
        const tile = e.target && typeof e.target.closest === "function" ? e.target.closest(".xtile") : null;
        if (tile) tile.classList.toggle("off", !e.target.checked);
      });
    });
	    const qCName = this.shadowRoot ? this.shadowRoot.querySelector("#c-name") : null;
	    if (qCName) qCName.addEventListener("input", (e) => { if (this._settingsDraft) this._settingsDraft.new_custom.name = String(e.target.value || ""); });
	    const qCGroup = this.shadowRoot ? this.shadowRoot.querySelector("#c-group") : null;
	    if (qCGroup) qCGroup.addEventListener("change", (e) => { if (this._settingsDraft) this._settingsDraft.new_custom.group = String(e.target.value || "Core"); });
	    const qCTags = this.shadowRoot ? this.shadowRoot.querySelector("#c-tags") : null;
	    if (qCTags) qCTags.addEventListener("input", (e) => { if (this._settingsDraft) this._settingsDraft.new_custom.tags = String(e.target.value || ""); });
	    const qCEq = this.shadowRoot ? this.shadowRoot.querySelector("#c-eq") : null;
	    if (qCEq) qCEq.addEventListener("input", (e) => { if (this._settingsDraft) this._settingsDraft.new_custom.equipment = String(e.target.value || ""); });

	    const qCAdd = this.shadowRoot ? this.shadowRoot.querySelector("#c-add") : null;
	    if (qCAdd) qCAdd.addEventListener("click", () => {
	      if (!this._settingsDraft) return;
	      const name = String(this._settingsDraft.new_custom.name || "").trim();
	      if (!name) return;
	      const csv = (s) => String(s || "").split(",").map((p) => p.trim()).filter(Boolean);
	      const tags = csv(this._settingsDraft.new_custom.tags).map((t) => t.toLowerCase());
	      const equipment = csv(this._settingsDraft.new_custom.equipment).map((t) => t.toLowerCase());
	      const group = String(this._settingsDraft.new_custom.group || "Core");
	      const groupTag = (() => {
	        if (group === "Core") return "core";
	        if (group === "Lower body") return "lower";
	        if (group === "Push") return "push";
	        if (group === "Pull") return "pull";
	        if (group === "Shoulders") return "shoulders";
	        if (group === "Arms") return "arms";
	        return "";
	      })();
	      if (groupTag && tags.indexOf(groupTag) === -1) tags.unshift(groupTag);
	      this._settingsDraft.custom = [...(this._settingsDraft.custom || []), { name, group: group || "Core", tags, equipment }];
	      this._settingsDraft.new_custom = { name: "", group: group || "Core", tags: "", equipment: "" };
	      this._render();
	    });
    this.shadowRoot.querySelectorAll("button[data-custom-del]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        if (!this._settingsDraft) return;
        const idx = Number(e.currentTarget.getAttribute("data-custom-del"));
        if (!Number.isFinite(idx)) return;
        const cur = Array.isArray(this._settingsDraft.custom) ? this._settingsDraft.custom : [];
        this._settingsDraft.custom = cur.filter((_, i) => i !== idx);
        this._render();
      });
    });

	    if (this._ui.showSettings && this._settingsDraft) {
      // Apply any existing query without re-rendering (keeps focus stable).
      this._applySettingsFilter(this._settingsDraft.query);
	    }

		    // Completed modal
		    const qCompletedClose = this.shadowRoot ? this.shadowRoot.querySelector("#completed-close") : null;
		    if (qCompletedClose) qCompletedClose.addEventListener("click", () => { this._ui.showCompleted = false; this._ui.completedDetail = null; this._render(); });
		    const qCompletedOk = this.shadowRoot ? this.shadowRoot.querySelector("#completed-ok") : null;
		    if (qCompletedOk) qCompletedOk.addEventListener("click", () => { this._ui.showCompleted = false; this._ui.completedDetail = null; this._render(); });
		    const qCompletedBackdrop = this.shadowRoot ? this.shadowRoot.querySelector("#completed-backdrop") : null;
		    if (qCompletedBackdrop) qCompletedBackdrop.addEventListener("click", (e) => {
		      if (e.target && e.target.id === "completed-backdrop") { this._ui.showCompleted = false; this._ui.completedDetail = null; this._render(); }
		    });
		    const qCompletedDelete = this.shadowRoot ? this.shadowRoot.querySelector("#completed-delete") : null;
		    if (qCompletedDelete) qCompletedDelete.addEventListener("click", async () => {
		      try {
		        const d = this._ui.completedDetail || {};
		        const pid = String(d.person_id || "");
		        const wk = String(d.week_start || "").slice(0, 10);
		        const dateIso = String(d.date || "");
		        if (!pid || !wk || !dateIso) return;
		        const ok = window.confirm("Delete this completed workout?");
		        if (!ok) return;
		        await this._deleteWorkout(pid, wk, dateIso);
		        this._ui.showCompleted = false;
		        this._ui.completedDetail = null;
		        this._render();
		      } catch (e) {
		        this._error = String((e && e.message) || e);
		        this._render();
		      }
		    });

		    // Long-press chips in Completed bar to view details.
		    this.shadowRoot.querySelectorAll(".cb-chip[data-cw-person][data-cw-date]").forEach((chip) => {
	      chip.addEventListener("pointerdown", (e) => {
	        const pid = String(e.currentTarget.getAttribute("data-cw-person") || "");
	        const dateIso = String(e.currentTarget.getAttribute("data-cw-date") || "");
	        if (!pid || !dateIso) return;
	        const lp = this._ui.longPress;
	        if (lp && lp.timer) window.clearTimeout(lp.timer);
	        if (lp) lp.fired = false;
	        if (lp) {
	          lp.timer = window.setTimeout(() => {
	            lp.fired = true;
	            try {
	              const wk = weekStartIso ? String(weekStartIso).slice(0, 10) : "";
	              const plans = this._state && this._state.plans && typeof this._state.plans === "object" ? this._state.plans : null;
	              const personPlans = plans && plans[pid] ? plans[pid] : null;
	              const plan2 = personPlans && typeof personPlans === "object" ? personPlans[wk] : null;
	              const workouts2 = plan2 && Array.isArray(plan2.workouts) ? plan2.workouts : [];
		              const w = workouts2.find((x) => x && typeof x === "object" && String(x.date || "") === dateIso) || null;
		              const p = this._personById(pid);
		              if (!w || !p) return;
		              this._ui.completedDetail = {
		                person_id: pid,
		                week_start: wk,
		                person_name: String(p.name || ""),
		                person_color: this._personColor(p),
		                workout_name: String(w.name || "Workout"),
		                date: String(w.date || ""),
		                items: Array.isArray(w.items) ? w.items : [],
		                can_delete: true,
		              };
		              this._ui.showCompleted = true;
		              this._render();
	            } catch (_) {}
	          }, 520);
	        }
	      });
	      chip.addEventListener("pointerup", () => {
	        const lp = this._ui.longPress;
	        if (lp && lp.timer) window.clearTimeout(lp.timer);
	        if (lp) lp.timer = 0;
	      });
	      chip.addEventListener("pointercancel", () => {
	        const lp = this._ui.longPress;
	        if (lp && lp.timer) window.clearTimeout(lp.timer);
	        if (lp) lp.timer = 0;
	      });
		    });

		    // History modal
		    const qHistoryClose = this.shadowRoot ? this.shadowRoot.querySelector("#history-close") : null;
		    if (qHistoryClose) qHistoryClose.addEventListener("click", () => { this._ui.showHistory = false; this._render(); });
		    const qHistoryOk = this.shadowRoot ? this.shadowRoot.querySelector("#history-ok") : null;
		    if (qHistoryOk) qHistoryOk.addEventListener("click", () => { this._ui.showHistory = false; this._render(); });
		    const qHistoryBackdrop = this.shadowRoot ? this.shadowRoot.querySelector("#history-backdrop") : null;
		    if (qHistoryBackdrop) qHistoryBackdrop.addEventListener("click", (e) => {
		      if (e.target && e.target.id === "history-backdrop") { this._ui.showHistory = false; this._render(); }
		    });
		    this.shadowRoot.querySelectorAll("button.hweek[data-hweek]").forEach((btn) => {
		      btn.addEventListener("click", (e) => {
		        const wk = String(e.currentTarget.getAttribute("data-hweek") || "");
		        if (!wk) return;
		        this._ui.historyWeek = wk;
		        this._render();
		      });
		    });
		    this.shadowRoot.querySelectorAll(".cb-chip[data-hc-person][data-hc-date][data-hc-week]").forEach((chip) => {
		      chip.addEventListener("click", (e) => {
		        try {
		          const pid = String(e.currentTarget.getAttribute("data-hc-person") || "");
		          const dateIso = String(e.currentTarget.getAttribute("data-hc-date") || "");
		          const wk = String(e.currentTarget.getAttribute("data-hc-week") || "");
		          const hist = Array.isArray(this._ui.history) ? this._ui.history : [];
		          const week = hist.find((h) => String((h && h.week_start) || "") === wk) || null;
		          const arr = week && Array.isArray(week.completed) ? week.completed : [];
		          const entry = arr.find((c) => c && typeof c === "object" && String(c.person_id || "") === pid && String(c.date || "") === dateIso) || null;
		          if (!entry) return;
		          const w = entry.workout || {};
		          this._ui.completedDetail = {
		            person_id: pid,
		            week_start: wk,
		            person_name: String(entry.person_name || ""),
		            person_color: String(entry.person_color || ""),
		            workout_name: String((w && w.name) || "Workout"),
		            date: String((w && w.date) || dateIso),
		            items: Array.isArray(w.items) ? w.items : [],
		            can_delete: false,
		          };
		          this._ui.showCompleted = true;
		          this._render();
		        } catch (_) {}
		      });
		    });

		    // Snackbar / Undo
		    const qSnackX = this.shadowRoot ? this.shadowRoot.querySelector("#snack-x") : null;
		    if (qSnackX) qSnackX.addEventListener("click", () => { this._ui.toast = null; this._render(); });
		    const qSnackAct = this.shadowRoot ? this.shadowRoot.querySelector("#snack-act") : null;
		    if (qSnackAct) qSnackAct.addEventListener("click", async () => {
		      const u = this._ui.toast && this._ui.toast.undo ? this._ui.toast.undo : null;
		      this._ui.toast = null;
		      this._render();
		      if (!u || typeof u !== "object") return;
		      try {
		        if (u.kind === "reload") {
		          await this._reloadState();
		          return;
		        }
		        if (u.kind === "toggle_completed") {
		          await this._setWorkoutCompleted(String(u.person_id || ""), String(u.week_start || ""), String(u.date || ""), Boolean(u.completed));
		          return;
		        }
		        if (u.kind === "restore_workout") {
		          await this._upsertWorkout(String(u.person_id || ""), String(u.week_start || ""), u.workout || {});
		          await this._reloadState();
		        }
		      } catch (e) {
		        this._error = String((e && e.message) || e);
		        this._render();
		      }
		    });

	    // Restore focus after re-render (only happens on load/save/generate)
	    queueMicrotask(() => this._restoreFocus());
	  }

  _cssSize(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (/^\\d+$/.test(raw)) return `${raw}px`;
    if (/^\\d+(\\.\\d+)?(px|rem|em|vw|vh|%)$/.test(raw)) return raw;
    return raw;
  }

  _formatWeekRange(weekStartIso) {
    try {
      const ws = new Date(String(weekStartIso) + "T00:00:00Z");
      const we = new Date(ws.getTime() + 6 * 24 * 3600 * 1000);
      const f = (d) => String(d.getUTCDate()).padStart(2, "0") + "." + String(d.getUTCMonth() + 1).padStart(2, "0");
      return `${f(ws)} - ${f(we)}`;
    } catch (_) {
      return "";
    }
  }

  _colorFor(seed) {
    // Deterministic, muted-but-colorful avatar backgrounds.
    const s = String(seed || "");
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    const hue = h % 360;
    return `hsl(${hue} 45% 45%)`;
  }

  _escape(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
}

customElements.define("weekly-training-card", WeeklyTrainingCard);
