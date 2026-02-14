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
  }

  setConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Invalid card config");
    this._config = {
      title: config.title || "Weekly Training",
      entry_id: config.entry_id || "",
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
        person: { ...this._newPerson, name },
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
    const weekLabel = currentWeekNumber ? `Week ${currentWeekNumber + Number(this._weekOffset || 0)}` : "Week";
    const todayIso = String(runtime.today || "");
    const todayW = todayIso ? new Date(todayIso + "T00:00:00Z").getUTCDay() : null;
    // Convert JS Sunday=0 to our Monday=0
    const todayWeekday = todayW == null ? null : ((todayW + 6) % 7);
    const selectedWeekday = this._selectedWeekday == null ? todayWeekday : Number(this._selectedWeekday);

    const peopleOptions = people
      .map((p) => ({ id: String(p.id || ""), name: String(p.name || "") }))
      .filter((p) => p.id && p.name);

    const planMarkdown = String(plan?.markdown || "");

    const sessionSlots = [
      { slot: "a_lower", label: "A lower" },
      { slot: "a_push", label: "A push" },
      { slot: "a_pull", label: "A pull" },
      { slot: "b_lower", label: "B lower" },
      { slot: "b_push", label: "B push" },
      { slot: "b_pull", label: "B pull" },
      { slot: "c_lower", label: "C lower" },
      { slot: "c_push", label: "C push" },
      { slot: "c_pull", label: "C pull" },
    ];

    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; }
        ha-card { overflow:hidden; }
        .wrap { padding: 12px; }
        .grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 12px;
        }
        @media (min-width: 900px) {
          .grid { grid-template-columns: 1fr 1fr; align-items: start; }
        }
        .section {
          border: 1px solid var(--divider-color);
          border-radius: 12px;
          padding: 12px;
        }
        .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
        .row > * { min-width: 180px; flex: 1 1 180px; }
        .row.compact > * { min-width: 140px; }
        .label { font-size: 12px; color: var(--secondary-text-color); margin-bottom: 6px; }
        select, input, textarea {
          width: 100%;
          box-sizing: border-box;
          font: inherit;
          border: 1px solid var(--divider-color);
          border-radius: 10px;
          padding: 10px;
          background: var(--card-background-color);
          color: var(--primary-text-color);
        }
        textarea { min-height: 90px; resize: vertical; }
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
        .hint { font-size: 12px; color: var(--secondary-text-color); margin-top: 8px; }
        .error { color: var(--error-color); font-size: 13px; margin-top: 8px; }
        pre {
          background: var(--secondary-background-color);
          border: 1px solid var(--divider-color);
          border-radius: 12px;
          padding: 10px;
          overflow: auto;
          max-height: 520px;
          white-space: pre-wrap;
        }
        .muted { color: var(--secondary-text-color); }
        .pill {
          display:inline-flex;
          align-items:center;
          gap: 8px;
          padding: 6px 10px;
          border: 1px solid var(--divider-color);
          border-radius: 999px;
          font-size: 12px;
          color: var(--secondary-text-color);
        }
        .weekbar { display:flex; align-items:center; justify-content:space-between; gap: 8px; flex-wrap:wrap; }
        .weeknav { display:flex; gap:8px; align-items:center; }
        .weeknav button { width: 38px; height: 38px; padding: 0; }
        .daybar { display:flex; gap:6px; flex-wrap:wrap; margin-top: 10px; }
        .daybtn {
          height: 34px;
          min-width: 44px;
          border-radius: 999px;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          cursor: pointer;
        }
        .daybtn.active { border-color: var(--primary-color); box-shadow: 0 0 0 1px var(--primary-color) inset; }
        .daybtn.today { box-shadow: 0 0 0 1px rgba(3, 169, 244, 0.35) inset; }
      </style>

      <ha-card header="${this._escape(title)}">
        <div class="wrap">
          ${this._error ? `<div class="error">${this._escape(this._error)}</div>` : ""}
          ${loading ? `<div class="muted">Loading…</div>` : ""}

          <div class="grid">
            <div class="section">
              <div class="weekbar">
                <div class="weeknav">
                  <button id="week-prev" title="Previous week" ${saving ? "disabled" : ""}>&lt;</button>
                  <div class="pill">${this._escape(weekLabel)}</div>
                  <button id="week-next" title="Next week" ${saving ? "disabled" : ""}>&gt;</button>
                </div>
                <div class="pill muted">Pick day, then Generate</div>
              </div>

              <div class="daybar" role="group" aria-label="Weekday selector">
                ${["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d, idx) => {
                  const cls = [
                    "daybtn",
                    (idx === selectedWeekday ? "active" : ""),
                    (idx === todayWeekday ? "today" : "")
                  ].filter(Boolean).join(" ");
                  return `<button class="${cls}" data-day="${idx}" ${saving ? "disabled" : ""}>${d}</button>`;
                }).join("")}
              </div>

              <div class="row compact" style="margin-top:12px">
                <div>
                  <div class="label">Person</div>
                  <select data-focus-key="person" id="person-select" ${saving ? "disabled" : ""}>
                    ${peopleOptions.map((p) => `<option value="${this._escape(p.id)}" ${p.id === activeId ? "selected" : ""}>${this._escape(p.name)}</option>`).join("")}
                  </select>
                </div>
                <div>
                  <div class="label">Planning mode</div>
                  <select data-focus-key="planning_mode" id="planning-mode" ${saving ? "disabled" : ""}>
                    <option value="auto" ${planningMode === "auto" ? "selected" : ""}>Auto</option>
                    <option value="manual" ${planningMode === "manual" ? "selected" : ""}>Manual per session</option>
                  </select>
                </div>
                <div>
                  <div class="label">Session minutes (default override)</div>
                  <input data-focus-key="duration" id="duration" type="number" min="20" max="120" step="5" value="${this._escape(String(this._draft.duration_minutes ?? 45))}" ${saving ? "disabled" : ""} />
                </div>
              </div>

              <div style="margin-top:10px">
                <div class="label">Preferred exercises/tags (CSV)</div>
                <textarea data-focus-key="preferred" id="preferred" placeholder="e.g. squat, pullup, overhead_press" ${saving ? "disabled" : ""}>${this._escape(this._draft.preferred_exercises || "")}</textarea>
                <div class="hint">Tip: use tags like <span class="pill">squat</span> <span class="pill">deadlift</span> <span class="pill">bench</span> <span class="pill">pullup</span> <span class="pill">row</span> <span class="pill">core</span></div>
              </div>

              <div class="actions" style="margin-top: 12px">
                <button class="primary" id="generate" ${saving || loading ? "disabled" : ""}>Generate session</button>
                <button id="save" ${saving || loading ? "disabled" : ""}>Save settings</button>
                <button id="reload" ${saving ? "disabled" : ""}>Reload</button>
              </div>

              <div class="hint">
                Rule: if you pick Squat, the generator won't suggest Deadlift (and vice versa). Bench can pair with either.
              </div>
            </div>

            <div class="section">
              <div class="row">
                <div>
                  <div class="label">Add person</div>
                  <input data-focus-key="new_name" id="new-name" type="text" placeholder="Name" value="${this._escape(this._newPerson.name || "")}" ${saving ? "disabled" : ""} />
                </div>
                <div>
                  <div class="label">Gender</div>
                  <select data-focus-key="new_gender" id="new-gender" ${saving ? "disabled" : ""}>
                    <option value="male" ${this._newPerson.gender === "male" ? "selected" : ""}>Male</option>
                    <option value="female" ${this._newPerson.gender === "female" ? "selected" : ""}>Female</option>
                  </select>
                </div>
              </div>
              <div class="row compact" style="margin-top: 10px">
                <div>
                  <div class="label">Squat 1RM</div>
                  <input data-focus-key="new_sq" id="new-sq" type="number" min="10" max="500" step="1" value="${this._escape(String(this._newPerson.max_squat ?? 100))}" ${saving ? "disabled" : ""} />
                </div>
                <div>
                  <div class="label">Deadlift 1RM</div>
                  <input data-focus-key="new_dl" id="new-dl" type="number" min="10" max="600" step="1" value="${this._escape(String(this._newPerson.max_deadlift ?? 120))}" ${saving ? "disabled" : ""} />
                </div>
                <div>
                  <div class="label">Bench 1RM</div>
                  <input data-focus-key="new_bp" id="new-bp" type="number" min="5" max="400" step="1" value="${this._escape(String(this._newPerson.max_bench ?? 80))}" ${saving ? "disabled" : ""} />
                </div>
                <div>
                  <div class="label">Units</div>
                  <select data-focus-key="new_units" id="new-units" ${saving ? "disabled" : ""}>
                    <option value="kg" ${this._newPerson.units === "kg" ? "selected" : ""}>kg</option>
                    <option value="lb" ${this._newPerson.units === "lb" ? "selected" : ""}>lb</option>
                  </select>
                </div>
              </div>
              <div class="actions" style="margin-top: 12px">
                <button id="add-person" ${saving || !String(this._newPerson.name||"").trim() ? "disabled" : ""}>Add</button>
              </div>
              <div class="hint">People are stored in Home Assistant storage and can be used across devices.</div>
            </div>

            <div class="section" style="${manual ? "" : "opacity:0.55"}">
              <div class="row compact">
                <div class="muted" style="flex: 1 1 100%">
                  Manual per-session exercise picks (only used when Planning mode = Manual)
                </div>
              </div>
              <div class="row compact" style="margin-top: 10px">
                ${sessionSlots.map((s) => `
                  <div>
                    <div class="label">${this._escape(s.label)}</div>
                    <input data-focus-key="session_${this._escape(s.slot)}" data-slot="${this._escape(s.slot)}" class="session-input" type="text" placeholder="Auto" value="${this._escape(String(this._draft.session_overrides?.[s.slot] || ''))}" ${saving || !manual ? "disabled" : ""} />
                  </div>
                `).join("")}
              </div>
              <div class="hint">
                Tip: write an exercise name here (e.g. "Back Squat"). Save settings, then Generate.
              </div>
            </div>

            <div class="section">
              <div class="row compact" style="justify-content: space-between">
                <div class="muted">Latest plan (active person)</div>
                ${plan?.week_number ? `<div class="pill">Week ${this._escape(String(plan.week_number))}</div>` : `<div class="pill">Not generated</div>`}
              </div>
              ${planMarkdown ? `<pre>${this._escape(planMarkdown)}</pre>` : `<div class="muted" style="margin-top:10px">Generate a plan to see it here.</div>`}
            </div>
          </div>
        </div>
      </ha-card>
    `;

    // Wire events
    const personSel = this.shadowRoot.querySelector("#person-select");
    personSel?.addEventListener("change", (e) => this._setActivePerson(e.target.value));

    const modeSel = this.shadowRoot.querySelector("#planning-mode");
    modeSel?.addEventListener("change", (e) => { this._draft.planning_mode = String(e.target.value || "auto"); });

    const duration = this.shadowRoot.querySelector("#duration");
    duration?.addEventListener("input", (e) => { this._draft.duration_minutes = Number(e.target.value || 45); });

    const pref = this.shadowRoot.querySelector("#preferred");
    pref?.addEventListener("input", (e) => { this._draft.preferred_exercises = String(e.target.value || ""); });

    this.shadowRoot.querySelector("#save")?.addEventListener("click", () => this._saveOverrides());
    this.shadowRoot.querySelector("#generate")?.addEventListener("click", () => this._generate());
    this.shadowRoot.querySelector("#reload")?.addEventListener("click", () => { this._state = null; this._load(); });

    // Week nav
    this.shadowRoot.querySelector("#week-prev")?.addEventListener("click", () => { this._weekOffset = Number(this._weekOffset || 0) - 1; this._saveOverrides(); });
    this.shadowRoot.querySelector("#week-next")?.addEventListener("click", () => { this._weekOffset = Number(this._weekOffset || 0) + 1; this._saveOverrides(); });

    // Day selector
    this.shadowRoot.querySelectorAll("button[data-day]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const d = Number(e.currentTarget.getAttribute("data-day"));
        this._selectedWeekday = Number.isFinite(d) ? d : null;
        this._saveOverrides();
      });
    });

    // New person controls
    this.shadowRoot.querySelector("#new-name")?.addEventListener("input", (e) => { this._newPerson.name = String(e.target.value || ""); });
    this.shadowRoot.querySelector("#new-gender")?.addEventListener("change", (e) => { this._newPerson.gender = String(e.target.value || "male"); });
    this.shadowRoot.querySelector("#new-sq")?.addEventListener("input", (e) => { this._newPerson.max_squat = Number(e.target.value || 0); });
    this.shadowRoot.querySelector("#new-dl")?.addEventListener("input", (e) => { this._newPerson.max_deadlift = Number(e.target.value || 0); });
    this.shadowRoot.querySelector("#new-bp")?.addEventListener("input", (e) => { this._newPerson.max_bench = Number(e.target.value || 0); });
    this.shadowRoot.querySelector("#new-units")?.addEventListener("change", (e) => { this._newPerson.units = String(e.target.value || "kg"); });
    this.shadowRoot.querySelector("#add-person")?.addEventListener("click", () => this._addPerson());

    // Manual session inputs (persist into draft session_overrides)
    this.shadowRoot.querySelectorAll(".session-input").forEach((el) => {
      el.addEventListener("input", (e) => {
        const slot = String(e.target.getAttribute("data-slot") || "");
        if (!slot) return;
        this._draft.session_overrides = { ...(this._draft.session_overrides || {}), [slot]: String(e.target.value || "") };
      });
    });

    // Restore focus after re-render (only happens on load/save/generate)
    queueMicrotask(() => this._restoreFocus());
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
