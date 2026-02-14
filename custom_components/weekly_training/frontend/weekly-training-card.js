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
      showWorkout: false,
      workoutDay: null, // 0..6
      selectedDay: null, // 0..6
      workoutPersonId: "",
      swipeX: 0,
      longPress: { timer: 0, fired: false },
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

  async _callWS(payload) {
    if (!this._hass) throw new Error("No hass");
    return await this._hass.callWS(payload);
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

  _applyStateToDraft() {
    const st = this._state || {};
    const overrides = st.overrides || {};
    this._weekOffset = Number(overrides.week_offset != null ? overrides.week_offset : 0);
    this._selectedWeekday = overrides.selected_weekday != null ? overrides.selected_weekday : null;
    this._draft.planning_mode = String(overrides.planning_mode || "auto");
    this._draft.duration_minutes = Number(overrides.duration_minutes != null ? overrides.duration_minutes : 45);
    this._draft.preferred_exercises = String(overrides.preferred_exercises || "");
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

  _planForPerson(personId) {
    const plans = this._state && this._state.plans && typeof this._state.plans === "object" ? this._state.plans : {};
    const id = String(personId || "");
    const personPlans = (id && plans[id] && typeof plans[id] === "object") ? plans[id] : {};
    const runtime = (this._state && this._state.runtime) || {};
    const currentWeekStart = String(runtime.current_week_start || "");
    if (!currentWeekStart) return null;
    const key = currentWeekStart.slice(0, 10);
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
          duration_minutes: Number(this._draft.duration_minutes || 45),
          preferred_exercises: String(this._draft.preferred_exercises || ""),
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
      new_custom: { name: "", tags: "", equipment: "" },
    };
    this._ui.showSettings = true;
    this._render();
  }

  _exercisePrimaryGroup(ex) {
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
    const currentWeekNumber = Number(runtime.current_week_number || 0);
    const weekStartIso = String(runtime.current_week_start || "");
    const weekLabel = currentWeekNumber ? `Week ${currentWeekNumber}` : "Week";
    const weekRange = weekStartIso ? this._formatWeekRange(weekStartIso) : "";

    const todayIso = String(runtime.today || "");
    const todayW = todayIso ? new Date(todayIso + "T00:00:00Z").getUTCDay() : null;
    const todayWeekday = todayW == null ? 0 : ((todayW + 6) % 7);
    const selectedDay = this._ui.selectedDay != null ? Number(this._ui.selectedDay) : Number(todayWeekday);

    const activeName = viewPerson ? String(viewPerson.name || "") : "";

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
	    const selectedWorkout = workoutsByDay[selectedDay] || null;

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

            <div class="actions" style="margin-top:12px">
              <button class="primary" id="p-save" ${saving || !String(this._newPerson.name || "").trim() ? "disabled" : ""}>Save</button>
              ${isEditPerson && String(this._ui.editPersonId || "") !== String(activeId || "") ? `<button id="p-set-active" ${saving ? "disabled" : ""}>Set active</button>` : ""}
              ${isEditPerson ? `<button id="p-delete" ${saving ? "disabled" : ""}>Delete</button>` : ""}
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

            <div class="actions" style="margin-top:12px">
              <button class="primary" id="w-generate" ${saving || loading ? "disabled" : ""}>Generate</button>
              <button id="w-cancel" ${saving ? "disabled" : ""}>Cancel</button>
            </div>
          </div>
        </div>
      </div>
    ` : "";

    const settingsModal = this._ui.showSettings ? (() => {
      const draft = this._settingsDraft || { disabled: new Set(), custom: [], query: "", new_custom: { name: "", tags: "", equipment: "" } };
      const exercises = Array.isArray(this._library) ? this._library : [];
      const grouped = this._groupExercisesForSettings(exercises);

      const custom = Array.isArray(draft.custom) ? draft.custom : [];
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
                    return `<div class="xcustom"><div>${this._escape(nm)}</div><button class="icon-btn" data-custom-del="${idx}" ${saving ? "disabled" : ""}>Remove</button></div>`;
                  }).join("")}
                </div>
              ` : `<div class="muted">No custom exercises yet.</div>`}

              <div class="row compact" style="margin-top:10px">
                <div>
                  <div class="label">Name</div>
                  <input data-focus-key="c_name" id="c-name" type="text" placeholder="e.g. Ring Row" value="${this._escape(String(draft.new_custom && draft.new_custom.name || ""))}" ${saving ? "disabled" : ""}/>
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

              <div class="actions" style="margin-top:12px">
                <button class="primary" id="s-save" ${saving ? "disabled" : ""}>Save</button>
                <button id="s-cancel" ${saving ? "disabled" : ""}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      `;
    })() : "";

    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; }
        /* Always fill the available Lovelace column width. */
        ha-card {
          overflow: hidden;
          width: 100%;
          ${maxWidthCss ? `max-width:${this._escape(maxWidthCss)};` : ""}
        }
        .wrap { padding: 12px; }
        .muted { color: var(--secondary-text-color); }
        .header { display:flex; flex-direction:column; gap: 10px; }
        .h-title { font-size: 20px; font-weight: 700; letter-spacing: 0.2px; }
	        .h-row { display:flex; align-items:center; justify-content:space-between; gap: 12px; }
	        .weekctrl { display:flex; align-items:center; gap: 10px; }
	        .weekpill {
	          border: 1px solid var(--divider-color);
	          border-radius: 12px;
	          background: var(--card-background-color);
          padding: 8px 12px;
          min-width: 150px;
        }
        .wk { font-size: 13px; font-weight: 700; }
        .range { font-size: 12px; color: var(--secondary-text-color); margin-top: 2px; }
        .gearbtn {
          width: 42px;
          height: 38px;
          border-radius: 12px;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .gearbtn ha-icon { color: var(--secondary-text-color); }
        .peoplebar {
          border: 1px dashed var(--divider-color);
          border-radius: 12px;
          padding: 10px;
          display:flex;
          align-items:center;
          justify-content:flex-start;
          gap: 10px;
          background: var(--card-background-color);
        }
        .peoplelabel { font-size: 13px; font-weight: 700; color: var(--primary-text-color); }
        .peoplechips { display:flex; gap: 8px; align-items:center; flex-wrap:wrap; justify-content:flex-start; flex: 1 1 auto; }
	        .pchip {
          border: 1px solid var(--divider-color);
          border-radius: 999px;
          background: var(--card-background-color);
          color: var(--primary-text-color);
          padding: 6px 10px;
          display:flex;
          align-items:center;
          gap: 8px;
          cursor: pointer;
          font: inherit;
	        }
	        .pchip.active { border-color: var(--accent, var(--primary-color)); box-shadow: 0 0 0 1px var(--accent, var(--primary-color)) inset; }
        .pcircle {
          width: 22px;
          height: 22px;
          border-radius: 999px;
          display:inline-flex;
          align-items:center;
          justify-content:center;
          color: #fff;
          font-size: 12px;
          font-weight: 800;
        }
        .pname { font-size: 13px; }
        .pchip.add { padding: 6px 12px; font-weight: 800; }
        /* Tablet-first: iPad (768px) should show the 2-column layout even in portrait. */
        .layout { display:grid; grid-template-columns: 1fr; gap: 14px; margin-top: 12px; }
        @media (min-width: 740px) { .layout { grid-template-columns: minmax(280px, 340px) 1fr; } }
        .days { border: 1px solid var(--divider-color); border-radius: 12px; overflow: hidden; }
        .day {
          width: 100%;
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap: 10px;
          font: inherit;
          border: 0;
          border-bottom: 1px solid var(--divider-color);
          padding: 14px 12px;
          background: var(--card-background-color);
          color: var(--primary-text-color);
          cursor: pointer;
          text-align: left;
          touch-action: manipulation;
        }
	        .day:last-child { border-bottom: 0; }
	        .day.active { background: var(--secondary-background-color); }
	        /* TODAY is calendar-driven (not person-driven). */
	        .day.today { box-shadow: 0 0 0 2px var(--primary-color) inset; }
	        .day .meta { display:flex; flex-direction:column; gap: 2px; }
	        .day .name { font-weight: 600; font-size: 13px; }
	        .day .hint2 { font-size: 12px; color: var(--secondary-text-color); }
	        .badge { font-size: 11px; border: 1px solid var(--divider-color); border-radius: 999px; padding: 5px 9px; color: var(--secondary-text-color); }
	        .badge.today { border-color: var(--primary-color); color: var(--primary-color); font-weight: 800; }
	        .daybadges { display:flex; flex-direction:column; align-items:flex-end; gap: 6px; }
	        .wbadge {
	          font-size: 11px;
	          border: 1px solid var(--divider-color);
	          border-radius: 999px;
	          padding: 5px 9px;
	          color: var(--secondary-text-color);
	          display:flex;
	          align-items:center;
	          gap: 6px;
	          max-width: 140px;
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
	          font-weight: 800;
	          flex: 0 0 auto;
	        }
	        .wbadge .wtext { overflow:hidden; text-overflow: ellipsis; white-space: nowrap; }
	        /* Only the workout detail panel is accented by the active person. */
	        .main {
	          border: 1px solid var(--accent, var(--divider-color));
	          box-shadow: 0 0 0 1px var(--accent, var(--divider-color)) inset;
	          border-radius: 12px;
	          padding: 12px;
	        }
	        .main h3 { margin: 0 0 6px 0; font-size: 16px; }
	        .swipehint { margin-top: 6px; font-size: 12px; color: var(--secondary-text-color); }
	        .completedbar {
	          margin-top: 12px;
	          border: 1px solid var(--divider-color);
	          border-radius: 12px;
	          padding: 10px;
	          background: var(--card-background-color);
	        }
	        .cb-h { display:flex; align-items:center; justify-content:space-between; gap: 10px; }
	        .cb-title { font-size: 13px; font-weight: 800; }
	        .cb-chips { margin-top: 8px; display:flex; gap: 8px; flex-wrap: wrap; }
	        .cb-chip {
	          border: 1px solid var(--divider-color);
	          border-radius: 999px;
	          padding: 6px 10px;
	          background: var(--card-background-color);
	          color: var(--primary-text-color);
	          display:flex;
	          align-items:center;
	          gap: 8px;
	          font-size: 13px;
	        }
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
        .items { margin-top: 10px; display:flex; flex-direction:column; gap: 8px; }
        .item { border: 1px solid var(--divider-color); border-radius: 12px; padding: 10px; background: var(--card-background-color); }
        .item .ex { font-weight: 600; }
        .actions { display:flex; gap: 8px; flex-wrap:wrap; }
        .actions button {
          font: inherit;
          border: 1px solid var(--divider-color);
          border-radius: 10px;
          padding: 10px 12px;
          background: var(--card-background-color);
          color: var(--primary-text-color);
          cursor: pointer;
        }
        .actions button.primary {
          background: var(--primary-color);
          border-color: var(--primary-color);
          color: var(--text-primary-color, #fff);
        }
        .actions button:disabled { opacity: 0.6; cursor: not-allowed; }
        .label { font-size: 12px; color: var(--secondary-text-color); margin-bottom: 6px; }
        select, input {
          width: 100%;
          box-sizing: border-box;
          font: inherit;
          border: 1px solid var(--divider-color);
          border-radius: 10px;
          padding: 10px;
          background: var(--card-background-color);
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
          width: min(780px, 100%);
          max-height: min(80vh, 720px);
          overflow: auto;
          background: var(--card-background-color);
          color: var(--primary-text-color);
          border: 1px solid var(--divider-color);
          border-radius: 14px;
          box-shadow: 0 14px 40px rgba(0,0,0,0.22);
        }
        .modal-h { display:flex; align-items:center; justify-content:space-between; gap: 10px; padding: 12px 12px 0 12px; }
        .modal-title { font-weight: 700; }
        .modal-b { padding: 12px; }
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

	      <ha-card style="--accent:${this._escape(accent)};">
        <div class="wrap">
          ${this._error ? `<div class="error">${this._escape(this._error)}</div>` : ""}
          ${loading ? `<div class="muted">Loading\u2026</div>` : ""}

          <div class="header">
            <div class="h-title">${this._escape(String(title || ""))}</div>
	            <div class="h-row">
	              <div class="weekctrl" aria-label="Week">
	                <div class="weekpill">
	                  <div class="wk">${this._escape(weekLabel)}</div>
	                  <div class="range">${this._escape(weekRange || "")}</div>
	                </div>
	              </div>
              <button class="gearbtn" id="settings" title="Exercise settings" ${saving ? "disabled" : ""}>
                <ha-icon icon="mdi:tune-variant"></ha-icon>
              </button>
            </div>
            <div class="peoplebar">
              <div class="peoplelabel">People</div>
	              <div class="peoplechips" aria-label="People list">
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
          </div>

          <div class="layout">
	            <div class="days" role="list" aria-label="Weekdays">
	              ${daysDa.map((d, idx) => {
	                const w = workoutsByDay[idx];
	                const entries = allByDay[idx] || [];
	                const activeCls = idx === selectedDay ? "active" : "";
	                const isToday = idx === todayWeekday;
	                const dateShort = dayDates[idx] ? String(dayDates[idx]) : "";
	                const small = w ? String(w.name || "Session") : "Tap to add";
	                const done = w && w.completed ? true : false;
	                return `
	                  <button class="day ${activeCls} ${isToday ? "today" : ""}" data-day="${idx}" ${saving ? "disabled" : ""}>
	                    <div class="meta">
	                      <div class="name">${this._escape(d)}</div>
	                      <div class="hint2">${dateShort ? this._escape(dateShort) + " \u2022 " : ""}${this._escape(small)}</div>
	                    </div>
	                    <div class="daybadges">
	                      ${isToday ? `<span class="badge today">TODAY</span>` : ``}
	                      ${entries.length ? entries.map((x) => {
	                        const p = x.person;
	                        const w3 = x.workout;
	                        const nm = String((p && p.name) || "");
	                        const initial = (nm || "?").slice(0, 1).toUpperCase();
	                        const color = this._personColor(p);
	                        const label = w3 && w3.completed ? "Done" : "Workout";
	                        return `<span class="wbadge" style="border-color:${this._escape(color)}"><span class="mini" style="background:${this._escape(color)}">${this._escape(initial)}</span><span class="wtext">${this._escape(label)}</span></span>`;
	                      }).join("") : `<span class="badge">${done ? "Done" : "Empty"}</span>`}
	                    </div>
	                  </button>
	                `;
	              }).join("")}
	            </div>

	            <div class="main" id="main-panel">
	              <h3>${this._escape(daysDa[selectedDay] || "Day")}</h3>
	              ${selectedWorkout ? `
	                <div class="range">${this._escape(String(selectedWorkout.name || "Session"))} \u2022 ${this._escape(String(selectedWorkout.date || ""))}${selectedWorkout.completed ? " \u2022 Completed" : ""}</div>
	                <div class="swipehint">Swipe right: completed. Swipe left: delete.</div>
	                <div class="items" id="swipe-zone">
	                  ${(Array.isArray(selectedWorkout.items) ? selectedWorkout.items : []).map((it) => {
	                    if (!it || typeof it !== "object") return "";
	                    const ex = String(it.exercise || "");
	                    const sr = String(it.sets_reps || "");
	                    const load = it.suggested_load != null ? String(it.suggested_load) : "";
	                    return `<div class="item"><div class="ex">${this._escape(ex)}</div><div class="range">${this._escape(sr)}${load ? ` \u2022 ~${this._escape(load)}` : ""}</div></div>`;
	                  }).join("")}
	                </div>
	              ` : `
	                <div class="empty-main" id="open-workout">
	                  <div class="empty-card">
	                    <div class="empty-title">Her kommer dit tr\u00e6ningspas</div>
	                    <div class="empty-sub">Tap to add</div>
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
	              return `<div class="cb-chip"><span class="pcircle" style="background:${this._escape(color)}">${this._escape(initial)}</span>${this._escape(label)} \u2022 ${this._escape(dateIso)}</div>`;
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
        </div>
      </ha-card>
    `;

    // Wire events (header)
    const qSettings = this.shadowRoot ? this.shadowRoot.querySelector("#settings") : null;
    if (qSettings) qSettings.addEventListener("click", () => { this._openSettingsModal(); });
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
    const qWPref = this.shadowRoot ? this.shadowRoot.querySelector("#w-pref") : null;
    if (qWPref) qWPref.addEventListener("input", (e) => { this._draft.preferred_exercises = String(e.target.value || ""); });
    const qWGen = this.shadowRoot ? this.shadowRoot.querySelector("#w-generate") : null;
    if (qWGen) qWGen.addEventListener("click", async () => {
      const d = Number(this._ui.selectedDay);
      this._selectedWeekday = Number.isFinite(d) ? d : null;
      const pid = String(this._ui.workoutPersonId || this._activePersonId() || this._defaultPersonId() || "");
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

    // Swipe actions on the generated workout (tablet-first).
    const swipeZone = this.shadowRoot ? this.shadowRoot.querySelector("#swipe-zone") : null;
    if (swipeZone && selectedWorkout) {
      const pid = String(this._activePersonId() || "");
      const wk = String(weekStartIso || "").slice(0, 10);
      const dateIso = String(selectedWorkout.date || "");
      swipeZone.addEventListener("touchstart", (e) => {
        try {
          const t = e.touches && e.touches[0];
          if (t) this._ui.swipeX = Number(t.clientX) || 0;
        } catch (_) {}
      }, { passive: true });
      swipeZone.addEventListener("touchend", async (e) => {
        try {
          const t = e.changedTouches && e.changedTouches[0];
          if (!t) return;
          const dx = (Number(t.clientX) || 0) - Number(this._ui.swipeX || 0);
          const threshold = 80;
          if (Math.abs(dx) < threshold) return;
          if (!pid || !wk || !dateIso) return;
          if (dx > 0) {
            await this._setWorkoutCompleted(pid, wk, dateIso, !Boolean(selectedWorkout.completed));
          } else {
            const ok = window.confirm("Delete this workout?");
            if (!ok) return;
            await this._deleteWorkout(pid, wk, dateIso);
          }
        } catch (_) {}
      }, { passive: true });
    }

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
      this._settingsDraft.custom = [...(this._settingsDraft.custom || []), { name, tags, equipment }];
      this._settingsDraft.new_custom = { name: "", tags: "", equipment: "" };
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
