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
    };

    this._focusKey = "";
    this._focusSelStart = null;
    this._focusSelEnd = null;

    // UI state (purely client-side).
    this._ui = {
      showPeople: false,
      showWorkout: false,
      workoutDay: null, // 0..6
      selectedDay: null, // 0..6
    };
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
    this._render();
  }

  getCardSize() {
    return 8;
  }

  async _callWS(payload) {
    if (!this._hass) throw new Error("No hass");
    return await this._hass.callWS(payload);
  }

  _captureFocus() {
    const el = this.shadowRoot?.activeElement;
    if (!el) return;
    const key = el.getAttribute?.("data-focus-key") || "";
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
    const el = this.shadowRoot?.querySelector(`[data-focus-key="${CSS.escape(this._focusKey)}"]`);
    if (!el) return;
    // Don't steal focus if user clicked elsewhere outside the card.
    const active = this.getRootNode()?.activeElement;
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
        const entries = Array.isArray(res?.entries) ? res.entries : [];
        if (entries.length === 1) this._entryId = entries[0].entry_id;
      }
      if (!this._entryId) throw new Error("Set entry_id in card config (or keep only one entry).");
      const res = await this._callWS({ type: "weekly_training/get_state", entry_id: this._entryId });
      this._state = res?.state || {};
      this._applyStateToDraft();
    } catch (e) {
      this._error = String(e?.message || e);
    } finally {
      this._loading = false;
      this._render();
    }
  }

  _applyStateToDraft() {
    const st = this._state || {};
    const overrides = st.overrides || {};
    this._weekOffset = Number(overrides.week_offset ?? 0);
    this._selectedWeekday = overrides.selected_weekday ?? null;
    this._draft.planning_mode = String(overrides.planning_mode || "auto");
    this._draft.duration_minutes = Number(overrides.duration_minutes ?? 45);
    this._draft.preferred_exercises = String(overrides.preferred_exercises || "");
    this._draft.session_overrides = { ...this._draft.session_overrides, ...(overrides.session_overrides || {}) };

    const people = Array.isArray(st.people) ? st.people : [];
    const activeId = String(st.active_person_id || "");
    this._activePerson = people.find((p) => String(p?.id || "") === activeId) || people[0] || null;
  }

  _people() {
    return Array.isArray(this._state?.people) ? this._state.people : [];
  }

  _activePersonId() {
    return String(this._state?.active_person_id || "");
  }

  _activePlan() {
    const plans = this._state?.plans && typeof this._state.plans === "object" ? this._state.plans : {};
    const id = this._activePersonId();
    const personPlans = (id && plans[id] && typeof plans[id] === "object") ? plans[id] : {};
    const runtime = this._state?.runtime || {};
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
      this._state = res?.state || this._state;
      this._applyStateToDraft();
    } catch (e) {
      this._error = String(e?.message || e);
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
      this._state = res?.state || this._state;
      this._applyStateToDraft();
    } catch (e) {
      this._error = String(e?.message || e);
    } finally {
      this._saving = false;
      this._render();
    }
  }

  async _generate() {
    this._captureFocus();
    this._saving = true;
    this._error = "";
    this._render();
    try {
      // Persist draft first so generation uses latest values
      await this._saveOverrides();
      await this._callWS({ type: "weekly_training/generate_plan", entry_id: this._entryId });
      // Refresh state after generation
      const st = await this._callWS({ type: "weekly_training/get_state", entry_id: this._entryId });
      this._state = st?.state || this._state;
      this._applyStateToDraft();
    } catch (e) {
      this._error = String(e?.message || e);
    } finally {
      this._saving = false;
      this._render();
    }
  }

  async _addPerson() {
    this._captureFocus();
    const name = String(this._newPerson.name || "").trim();
    if (!name) return;
    this._saving = true;
    this._error = "";
    this._render();
    try {
      const res = await this._callWS({
        type: "weekly_training/add_person",
        entry_id: this._entryId,
        person: {
          name,
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
      this._state = res?.state || this._state;
      this._newPerson.name = "";
      this._applyStateToDraft();
    } catch (e) {
      this._error = String(e?.message || e);
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
      this._state = res?.state || this._state;
      this._applyStateToDraft();
    } catch (e) {
      this._error = String(e?.message || e);
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
    const title = this._config?.title || "Weekly Training";
    const loading = this._loading;
    const saving = this._saving;
    const people = this._people();
    const activeId = this._activePersonId();
    const plan = this._activePlan();
    const planningMode = String(this._draft.planning_mode || "auto");
    const manual = planningMode === "manual";

    const runtime = this._state?.runtime || {};
    const currentWeekNumber = Number(runtime.current_week_number || 0);
    const weekStartIso = String(runtime.current_week_start || "");
    const weekLabel = currentWeekNumber ? `Week ${currentWeekNumber}` : "Week";
    const weekRange = weekStartIso ? this._formatWeekRange(weekStartIso) : "";

    const todayIso = String(runtime.today || "");
    const todayW = todayIso ? new Date(todayIso + "T00:00:00Z").getUTCDay() : null;
    const todayWeekday = todayW == null ? 0 : ((todayW + 6) % 7);
    const selectedDay = this._ui.selectedDay != null ? Number(this._ui.selectedDay) : Number(todayWeekday);

    const activePerson = people.find((p) => String(p?.id || "") === activeId) || null;
    const activeName = activePerson ? String(activePerson.name || "") : "";

    const workouts = Array.isArray(plan?.workouts) ? plan.workouts : [];
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

    const daysDa = ["Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag", "L\u00f8rdag", "S\u00f8ndag"];

    const maxWidthRaw = String(this._config?.max_width || "").trim();
    const maxWidthCss = maxWidthRaw ? this._cssSize(maxWidthRaw) : "";

    const peopleModal = this._ui.showPeople ? `
      <div class="modal-backdrop" id="people-backdrop" aria-hidden="false">
        <div class="modal" role="dialog" aria-label="People">
          <div class="modal-h">
            <div class="modal-title">People</div>
            <button class="icon-btn" id="people-close" title="Close">\u00d7</button>
          </div>
          <div class="modal-b">
            <div class="label">Active person</div>
            <div class="chiprow">
              ${people.map((p) => {
                const pid = String(p?.id || "");
                const nm = String(p?.name || "");
                const initial = (nm || "?").slice(0, 1).toUpperCase();
                const active = pid === activeId;
                return `<button class="chip ${active ? "active" : ""}" data-person="${this._escape(pid)}" ${saving ? "disabled" : ""}><span class="avatar">${this._escape(initial)}</span>${this._escape(nm || pid)}</button>`;
              }).join("")}
            </div>

            <div class="divider"></div>

            <div class="label">Add person</div>
            <div class="row compact">
              <div>
                <div class="label">Name</div>
                <input data-focus-key="p_name" id="p-name" type="text" placeholder="Name" value="${this._escape(String(this._newPerson.name || ""))}" ${saving ? "disabled" : ""} />
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
                <input data-focus-key="p_sq" id="p-sq" type="number" min="10" max="500" step="1" value="${this._escape(String(this._newPerson.max_squat ?? 100))}" ${saving ? "disabled" : ""} />
              </div>
              <div>
                <div class="label">1RM DL</div>
                <input data-focus-key="p_dl" id="p-dl" type="number" min="10" max="600" step="1" value="${this._escape(String(this._newPerson.max_deadlift ?? 120))}" ${saving ? "disabled" : ""} />
              </div>
              <div>
                <div class="label">1RM BP</div>
                <input data-focus-key="p_bp" id="p-bp" type="number" min="5" max="400" step="1" value="${this._escape(String(this._newPerson.max_bench ?? 80))}" ${saving ? "disabled" : ""} />
              </div>
            </div>

            <div class="actions" style="margin-top:12px">
              <button class="primary" id="p-add" ${saving || !String(this._newPerson.name || "").trim() ? "disabled" : ""}>Add person</button>
              ${activeId ? `<button id="p-delete" ${saving ? "disabled" : ""}>Delete active</button>` : ""}
            </div>
          </div>
        </div>
      </div>
    ` : "";

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
                <div class="label">Planning mode</div>
                <select data-focus-key="w_mode" id="w-mode" ${saving ? "disabled" : ""}>
                  <option value="auto" ${planningMode === "auto" ? "selected" : ""}>Auto</option>
                  <option value="manual" ${planningMode === "manual" ? "selected" : ""}>Manual (choose exercises)</option>
                </select>
              </div>
              <div>
                <div class="label">Session minutes</div>
                <input data-focus-key="w_minutes" id="w-minutes" type="number" min="20" max="120" step="5" value="${this._escape(String(this._draft.duration_minutes ?? 45))}" ${saving ? "disabled" : ""} />
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
        .topbar { display:flex; align-items:flex-start; justify-content:space-between; gap: 12px; }
        .title { font-size: 18px; font-weight: 600; }
        .sub { font-size: 12px; color: var(--secondary-text-color); margin-top: 2px; }
        .muted { color: var(--secondary-text-color); }
        .top-actions { display:flex; gap: 8px; align-items:center; }
        .top-actions button { font: inherit; border: 1px solid var(--divider-color); border-radius: 10px; padding: 8px 10px; background: var(--card-background-color); color: var(--primary-text-color); cursor:pointer; }
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
        .day .meta { display:flex; flex-direction:column; gap: 2px; }
        .day .name { font-weight: 600; font-size: 13px; }
        .day .hint2 { font-size: 12px; color: var(--secondary-text-color); }
        .badge { font-size: 11px; border: 1px solid var(--divider-color); border-radius: 999px; padding: 5px 9px; color: var(--secondary-text-color); }
        .main { border: 1px solid var(--divider-color); border-radius: 12px; padding: 12px; }
        .main h3 { margin: 0 0 6px 0; font-size: 16px; }
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
      </style>

      <ha-card>
        <div class="wrap">
          ${this._error ? `<div class="error">${this._escape(this._error)}</div>` : ""}
          ${loading ? `<div class="muted">Loading\u2026</div>` : ""}

          <div class="topbar">
            <div>
              <div class="title">${this._escape(String(title || ""))}</div>
              <div class="sub">${this._escape(weekLabel)}${weekRange ? ` \u2022 ${this._escape(weekRange)}` : ""}${activeName ? ` \u2022 ${this._escape(activeName)}` : ""}</div>
            </div>
            <div class="top-actions">
              <button id="people" ${saving ? "disabled" : ""}>People</button>
            </div>
          </div>

          <div class="layout">
            <div class="days" role="list" aria-label="Weekdays">
              ${daysDa.map((d, idx) => {
                const w = workoutsByDay[idx];
                const activeCls = idx === selectedDay ? "active" : "";
                const badge = w ? "Workout" : "Empty";
                const small = w ? String(w.name || "Session") : "Tap to create";
                return `
                  <button class="day ${activeCls}" data-day="${idx}" ${saving ? "disabled" : ""}>
                    <div class="meta">
                      <div class="name">${this._escape(d)}</div>
                      <div class="hint2">${this._escape(small)}</div>
                    </div>
                    <span class="badge">${this._escape(badge)}</span>
                  </button>
                `;
              }).join("")}
            </div>

            <div class="main">
              <h3>${this._escape(daysDa[selectedDay] || "Day")}</h3>
              ${selectedWorkout ? `
                <div class="sub">${this._escape(String(selectedWorkout.name || "Session"))} \u2022 ${this._escape(String(selectedWorkout.date || ""))}</div>
                <div class="items">
                  ${(Array.isArray(selectedWorkout.items) ? selectedWorkout.items : []).map((it) => {
                    if (!it || typeof it !== "object") return "";
                    const ex = String(it.exercise || "");
                    const sr = String(it.sets_reps || "");
                    const load = it.suggested_load != null ? String(it.suggested_load) : "";
                    return `<div class="item"><div class="ex">${this._escape(ex)}</div><div class="sub">${this._escape(sr)}${load ? ` \u2022 ~${this._escape(load)}` : ""}</div></div>`;
                  }).join("")}
                </div>
                <div class="actions" style="margin-top:12px">
                  <button class="primary" id="create" ${saving || loading ? "disabled" : ""}>Replace workout</button>
                </div>
              ` : `
                <div class="muted">Ingen workout endnu. Tryk for at oprette.</div>
                <div class="actions" style="margin-top:12px">
                  <button class="primary" id="create" ${saving || loading ? "disabled" : ""}>Create workout</button>
                </div>
              `}
            </div>
          </div>

          ${peopleModal}
          ${workoutModal}
        </div>
      </ha-card>
    `;

    // Wire events
    this.shadowRoot.querySelector("#people")?.addEventListener("click", () => { this._ui.showPeople = true; this._render(); });
    this.shadowRoot.querySelector("#create")?.addEventListener("click", () => { this._ui.showWorkout = true; this._render(); });

    this.shadowRoot.querySelectorAll("button.day[data-day]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const d = Number(e.currentTarget.getAttribute("data-day"));
        if (!Number.isFinite(d)) return;
        this._ui.selectedDay = d;
        this._ui.showWorkout = true;
        this._render();
      });
    });

    // People modal
    this.shadowRoot.querySelector("#people-close")?.addEventListener("click", () => { this._ui.showPeople = false; this._render(); });
    this.shadowRoot.querySelector("#people-backdrop")?.addEventListener("click", (e) => {
      if (e.target && e.target.id === "people-backdrop") { this._ui.showPeople = false; this._render(); }
    });
    this.shadowRoot.querySelectorAll("button.chip[data-person]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const pid = String(e.currentTarget.getAttribute("data-person") || "");
        if (pid) this._setActivePerson(pid);
      });
    });
    this.shadowRoot.querySelector("#p-name")?.addEventListener("input", (e) => { this._newPerson.name = String(e.target.value || ""); });
    this.shadowRoot.querySelector("#p-gender")?.addEventListener("change", (e) => { this._newPerson.gender = String(e.target.value || "male"); });
    this.shadowRoot.querySelector("#p-units")?.addEventListener("change", (e) => { this._newPerson.units = String(e.target.value || "kg"); });
    this.shadowRoot.querySelector("#p-minutes")?.addEventListener("input", (e) => { this._newPerson.duration_minutes = Number(e.target.value || 45); });
    this.shadowRoot.querySelector("#p-equipment")?.addEventListener("input", (e) => { this._newPerson.equipment = String(e.target.value || ""); });
    this.shadowRoot.querySelector("#p-pref")?.addEventListener("input", (e) => { this._newPerson.preferred_exercises = String(e.target.value || ""); });
    this.shadowRoot.querySelector("#p-sq")?.addEventListener("input", (e) => { this._newPerson.max_squat = Number(e.target.value || 0); });
    this.shadowRoot.querySelector("#p-dl")?.addEventListener("input", (e) => { this._newPerson.max_deadlift = Number(e.target.value || 0); });
    this.shadowRoot.querySelector("#p-bp")?.addEventListener("input", (e) => { this._newPerson.max_bench = Number(e.target.value || 0); });
    this.shadowRoot.querySelector("#p-add")?.addEventListener("click", () => this._addPerson());
    this.shadowRoot.querySelector("#p-delete")?.addEventListener("click", () => { if (activeId) this._deletePerson(activeId); });

    // Workout modal
    this.shadowRoot.querySelector("#workout-close")?.addEventListener("click", () => { this._ui.showWorkout = false; this._render(); });
    this.shadowRoot.querySelector("#w-cancel")?.addEventListener("click", () => { this._ui.showWorkout = false; this._render(); });
    this.shadowRoot.querySelector("#workout-backdrop")?.addEventListener("click", (e) => {
      if (e.target && e.target.id === "workout-backdrop") { this._ui.showWorkout = false; this._render(); }
    });
    this.shadowRoot.querySelector("#w-mode")?.addEventListener("change", (e) => {
      this._draft.planning_mode = String(e.target.value || "auto");
      this._render();
    });
    this.shadowRoot.querySelector("#w-minutes")?.addEventListener("input", (e) => { this._draft.duration_minutes = Number(e.target.value || 45); });
    this.shadowRoot.querySelector("#w-pref")?.addEventListener("input", (e) => { this._draft.preferred_exercises = String(e.target.value || ""); });
    this.shadowRoot.querySelector("#w-generate")?.addEventListener("click", () => {
      const d = Number(this._ui.selectedDay);
      this._selectedWeekday = Number.isFinite(d) ? d : null;
      if (String(this._draft.planning_mode || "auto") === "manual") {
        const slot = d <= 1 ? "a" : (d <= 3 ? "b" : "c");
        const lower = String(this.shadowRoot.querySelector("#w-lower")?.value || "").trim();
        const push = String(this.shadowRoot.querySelector("#w-push")?.value || "").trim();
        const pull = String(this.shadowRoot.querySelector("#w-pull")?.value || "").trim();
        const next = { ...(this._draft.session_overrides || {}) };
        next[`${slot}_lower`] = lower;
        next[`${slot}_push`] = push;
        next[`${slot}_pull`] = pull;
        this._draft.session_overrides = next;
      }
      this._ui.showWorkout = false;
      this._generate();
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

  _escape(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
}

customElements.define("weekly-training-card", WeeklyTrainingCard);
