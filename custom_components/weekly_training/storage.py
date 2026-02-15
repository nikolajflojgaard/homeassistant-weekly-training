"""Storage for Weekly Training (.storage).

State model (schema v1):
- people: list of people profiles (gender, defaults, 1RM maxes, preferences)
- active_person_id: which person the UI controls target by default
- overrides: per-entry generation overrides (week offset/day + duration/preferred + planning mode + session picks)
- exercise_config: exercise list overrides (disable built-ins, add custom exercises)
- plans: mapping person_id -> mapping week_start -> plan payload
- rev: monotonic revision for optimistic concurrency in the UI
- history: archived previous weeks (read-only in UI, kept small)
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from datetime import timedelta
from typing import Any
from uuid import uuid4

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .planner import recompute_workout_loads
from .const import (
    DEFAULT_DURATION_MINUTES,
    DEFAULT_EQUIPMENT,
    DEFAULT_GENDER,
    DEFAULT_MAX_BP,
    DEFAULT_MAX_DL,
    DEFAULT_MAX_SQ,
    DEFAULT_PREFERRED_EXERCISES,
    DEFAULT_UNITS,
    DOMAIN,
)

_STORAGE_VERSION = 1
DEFAULT_CYCLE_PRESET = "strength"
DEFAULT_CYCLE_PROGRAM = "full_body_abc"
DEFAULT_CYCLE_STEP_PCT = 2.5
DEFAULT_CYCLE_DELOAD_PCT = 10.0
DEFAULT_CYCLE_DELOAD_VOL = 0.65
_DEFAULT_COLORS = [
    "#475569",  # slate
    "#0f766e",  # teal
    "#1d4ed8",  # blue
    "#7c3aed",  # violet
    "#b45309",  # amber/brown
    "#be123c",  # rose
    "#15803d",  # green
]


def _color_for_id(seed: str) -> str:
    s = str(seed or "")
    h = 0
    for ch in s:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return _DEFAULT_COLORS[h % len(_DEFAULT_COLORS)]


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _effective_today_local() -> date:
    """Match UI rollover: new week starts Monday 01:00 (local time)."""
    now = dt_util.as_local(dt_util.utcnow())
    today = now.date()
    if now.weekday() == 0 and now.hour < 1:
        today = today - timedelta(days=1)
    return today


def _week_start(day_value: date) -> date:
    return day_value - timedelta(days=day_value.weekday())


class ConflictError(RuntimeError):
    """Raised when optimistic concurrency checks fail."""

    def __init__(self, *, expected: int, current: int) -> None:
        super().__init__(f"State changed (expected rev={expected}, current rev={current})")
        self.expected = expected
        self.current = current


def _normalize_custom_exercise(ex: dict[str, Any]) -> dict[str, Any] | None:
    name = str(ex.get("name") or "").strip()
    if not name:
        return None
    tags = ex.get("tags") or []
    equipment = ex.get("equipment") or []
    if not isinstance(tags, list):
        tags = []
    if not isinstance(equipment, list):
        equipment = []
    group = str(ex.get("group") or "").strip() or None
    ex_id = str(ex.get("id") or "").strip()
    now = _now_iso()
    if not ex_id:
        ex_id = f"ex_custom_{uuid4().hex[:10]}"
    created_at = str(ex.get("created_at") or "").strip() or now
    updated_at = str(ex.get("updated_at") or "").strip() or now
    return {
        "id": ex_id,
        "name": name,
        "group": group,
        "tags": [str(t).strip().lower() for t in tags if str(t).strip()],
        "equipment": [str(t).strip().lower() for t in equipment if str(t).strip()],
        "custom": True,
        "created_at": created_at,
        "updated_at": updated_at,
    }


def _trim_history(items: list[dict[str, Any]], *, keep: int = 4) -> list[dict[str, Any]]:
    """Keep only the newest N archived weeks, based on week_start.

    We prefer week_start over archived_at so retention stays stable even if HA
    was offline during rollover and archiving happens late.
    """

    def _wk(x: dict[str, Any]) -> date:
        try:
            return date.fromisoformat(str(x.get("week_start") or ""))
        except Exception:  # noqa: BLE001
            return date.min

    items = [x for x in items if isinstance(x, dict)]
    items.sort(key=_wk, reverse=True)

    # De-dupe by week_start (defensive).
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for it in items:
        ws = str(it.get("week_start") or "")
        if not ws or ws in seen:
            continue
        seen.add(ws)
        out.append(it)
        if len(out) >= max(0, int(keep)):
            break
    return out


def _recompute_cycle_workout_loads_for_person(state: dict[str, Any], *, person: dict[str, Any]) -> bool:
    """Update suggested loads for workouts in the active cycle window for this person."""
    cy = person.get("cycle")
    if not isinstance(cy, dict) or not bool(cy.get("enabled")):
        return False
    start_raw = str(cy.get("start_week_start") or "").strip()[:10]
    if not start_raw:
        return False
    try:
        start_ws = date.fromisoformat(start_raw)
    except Exception:  # noqa: BLE001
        return False
    try:
        weeks = max(1, min(12, int(cy.get("weeks") or 4)))
    except Exception:  # noqa: BLE001
        weeks = 4
    tdays = cy.get("training_weekdays")
    if not isinstance(tdays, list) or not tdays:
        return False
    training_weekdays: list[int] = []
    for x in tdays:
        try:
            xi = int(x)
        except Exception:  # noqa: BLE001
            continue
        if 0 <= xi <= 6 and xi not in training_weekdays:
            training_weekdays.append(xi)
    training_weekdays.sort()
    if not training_weekdays:
        return False

    plans = state.get("plans")
    if not isinstance(plans, dict):
        return False
    pid = str(person.get("id") or "").strip()
    if not pid:
        return False
    person_plans = plans.get(pid)
    if not isinstance(person_plans, dict):
        return False

    target_dates: set[str] = set()
    for i in range(weeks):
        wk = start_ws + timedelta(days=i * 7)
        for wd in training_weekdays:
            target_dates.add((wk + timedelta(days=int(wd))).isoformat())

    changed = False
    for wk_key, plan in list(person_plans.items()):
        if not isinstance(plan, dict):
            continue
        workouts = plan.get("workouts")
        if not isinstance(workouts, list) or not workouts:
            continue
        next_workouts: list[dict[str, Any]] = []
        did = False
        for w in workouts:
            if not isinstance(w, dict):
                continue
            d = str(w.get("date") or "")
            if d and d in target_dates and isinstance(w.get("cycle"), dict) and bool(w["cycle"].get("enabled")):
                next_workouts.append(recompute_workout_loads(profile=person, workout=w, cycle_cfg=cy))
                did = True
            else:
                next_workouts.append(w)
        if did:
            plan2 = dict(plan)
            plan2["workouts"] = next_workouts
            person_plans[wk_key] = plan2
            changed = True

    if changed:
        plans[pid] = person_plans
        state["plans"] = plans
    return changed


def _new_person(
    *,
    name: str,
    gender: str = DEFAULT_GENDER,
    duration_minutes: int = DEFAULT_DURATION_MINUTES,
    preferred_exercises: str = DEFAULT_PREFERRED_EXERCISES,
    equipment: str = DEFAULT_EQUIPMENT,
    units: str = DEFAULT_UNITS,
    max_squat: int = DEFAULT_MAX_SQ,
    max_deadlift: int = DEFAULT_MAX_DL,
    max_bench: int = DEFAULT_MAX_BP,
) -> dict[str, Any]:
    person_id = f"person_{uuid4().hex[:10]}"
    return {
        "id": person_id,
        "name": str(name).strip() or "Person",
        "color": _color_for_id(person_id),
        "gender": str(gender).lower(),
        "duration_minutes": int(duration_minutes),
        "preferred_exercises": str(preferred_exercises or "").strip(),
        "equipment": str(equipment or "").strip(),
        "units": str(units).lower(),
        "maxes": {
            "squat": int(max_squat),
            "deadlift": int(max_deadlift),
            "bench": int(max_bench),
        },
        # Optional per-person 4-week cycle configuration.
        "cycle": None,
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    }


class WeeklyTrainingStore:
    """Per-config-entry storage wrapper."""

    def __init__(self, hass: HomeAssistant, entry_id: str) -> None:
        self._store: Store[dict[str, Any]] = Store(hass, _STORAGE_VERSION, f"{DOMAIN}_{entry_id}")
        self._data: dict[str, Any] | None = None

    @staticmethod
    def _clamp_week_offset(value: Any) -> int:
        try:
            v = int(value)
        except Exception:  # noqa: BLE001
            return 0
        return max(-1, min(3, v))

    async def async_load(self) -> dict[str, Any]:
        if self._data is None:
            loaded = await self._store.async_load()
            self._data = loaded if isinstance(loaded, dict) else {}

            self._data.setdefault("schema", 1)
            self._data.setdefault("rev", 1)
            self._data.setdefault("people", [])
            self._data.setdefault("active_person_id", "")
            self._data.setdefault(
                "overrides",
                {
                    "week_offset": 0,  # 0 = current week
                    "selected_weekday": None,  # 0..6, default to "today" in coordinator/UI
                    "duration_minutes": None,
                    "preferred_exercises": "",
                    "planning_mode": "auto",  # auto | manual
                    # Progression applies a per-week % adjustment to suggested loads for main lifts.
                    "progression": {"enabled": True, "step_pct": 2.5},
                    # 4-week cycle planning (optional). Calendar-driven, not person-specific.
                    "cycle": {
                        "enabled": False,
                        "preset": DEFAULT_CYCLE_PRESET,  # strength | hypertrophy | minimalist
                        "program": DEFAULT_CYCLE_PROGRAM,  # full_body_abc | full_body_2day | upper_lower_4day
                        "start_week_start": "",  # ISO date for Monday (YYYY-MM-DD); if empty, auto = current week when enabled
                        "training_weekdays": [0, 2, 4],  # Mon/Wed/Fri default when enabled
                        "weeks": 4,
                        "step_pct": DEFAULT_CYCLE_STEP_PCT,
                        "deload_pct": DEFAULT_CYCLE_DELOAD_PCT,
                        "deload_volume": DEFAULT_CYCLE_DELOAD_VOL,
                    },
                    "session_overrides": {
                        "a_lower": "",
                        "a_push": "",
                        "a_pull": "",
                        "b_lower": "",
                        "b_push": "",
                        "b_pull": "",
                        "c_lower": "",
                        "c_push": "",
                        "c_pull": "",
                    },
                },
            )
            self._data.setdefault("plans", {})
            self._data.setdefault(
                "exercise_config",
                {
                    # If non-empty: these exercise names are excluded from auto-picks and manual picks.
                    "disabled_exercises": [],
                    # List of custom exercise dicts {id,name,group,tags,equipment,...} to be merged into the library.
                    "custom_exercises": [],
                },
            )
            self._data.setdefault("history", [])
            self._data.setdefault("updated_at", _now_iso())

            # Always enforce retention on load (keeps archive at 4-week cycles).
            if isinstance(self._data.get("history"), list):
                self._data["history"] = _trim_history(self._data["history"], keep=4)

            # Clamp week_offset defensively (prevents weird UI/backends if storage is edited).
            overrides0 = self._data.get("overrides")
            if isinstance(overrides0, dict):
                overrides0["week_offset"] = self._clamp_week_offset(overrides0.get("week_offset"))
                self._data["overrides"] = overrides0

            # Normalize custom exercises from older schema.
            cfg = self._data.get("exercise_config")
            if isinstance(cfg, dict):
                custom = cfg.get("custom_exercises")
                if isinstance(custom, list):
                    norm: list[dict[str, Any]] = []
                    for ex in custom:
                        if not isinstance(ex, dict):
                            continue
                        n = _normalize_custom_exercise(ex)
                        if n:
                            norm.append(n)
                    cfg["custom_exercises"] = norm
                    self._data["exercise_config"] = cfg

            # Seed one default person for first-run UX.
            if not self._data["people"]:
                default_person = _new_person(name="You")
                self._data["people"] = [default_person]
                self._data["active_person_id"] = default_person["id"]
                await self._store.async_save(self._data)

            # Ensure active_person_id is valid.
            ids = {str(p.get("id") or "") for p in (self._data.get("people") or []) if isinstance(p, dict)}
            if self._data.get("active_person_id") not in ids:
                self._data["active_person_id"] = next(iter(ids), "")

            # Migrate legacy entry-level cycle config (overrides.cycle) to the active person.
            overrides = self._data.get("overrides")
            if isinstance(overrides, dict) and isinstance(overrides.get("cycle"), dict):
                legacy = overrides.get("cycle") or {}
                if bool(legacy.get("enabled")):
                    pid = str(self._data.get("active_person_id") or "")
                    if pid and isinstance(self._data.get("people"), list):
                        for p in self._data["people"]:
                            if not isinstance(p, dict):
                                continue
                            if str(p.get("id") or "") != pid:
                                continue
                            p["cycle"] = dict(legacy)
                            break
                    # Clear legacy to avoid cross-person bleed.
                    overrides["cycle"] = {"enabled": False, "preset": DEFAULT_CYCLE_PRESET, "program": DEFAULT_CYCLE_PROGRAM, "start_week_start": "", "training_weekdays": [0, 2, 4], "weeks": 4, "step_pct": DEFAULT_CYCLE_STEP_PCT, "deload_pct": DEFAULT_CYCLE_DELOAD_PCT, "deload_volume": DEFAULT_CYCLE_DELOAD_VOL}
                    self._data["overrides"] = overrides

            # Prune expired per-person cycles (only keep one active cycle per person).
            try:
                cur_monday = _week_start(_effective_today_local())
                if isinstance(self._data.get("people"), list):
                    changed = False
                    for p in self._data["people"]:
                        if not isinstance(p, dict):
                            continue
                        cy = p.get("cycle")
                        if not isinstance(cy, dict) or not bool(cy.get("enabled")):
                            continue
                        start = str(cy.get("start_week_start") or "").strip()[:10]
                        if not start:
                            continue
                        try:
                            start_ws = date.fromisoformat(start)
                        except Exception:  # noqa: BLE001
                            continue
                        weeks = int(cy.get("weeks") or 4)
                        weeks = max(1, min(12, weeks))
                        delta_weeks = int(round((cur_monday - start_ws).days / 7))
                        if delta_weeks >= weeks:
                            p["cycle"] = None
                            changed = True
                    if changed:
                        await self._store.async_save(self._data)
            except Exception:  # noqa: BLE001
                pass

        return dict(self._data)

    def _assert_rev(self, state: dict[str, Any], expected_rev: int | None) -> None:
        if expected_rev is None:
            return
        cur = int(state.get("rev") or 1)
        if int(expected_rev) != cur:
            raise ConflictError(expected=int(expected_rev), current=cur)

    async def async_set_exercise_config(
        self,
        *,
        disabled_exercises: list[str] | None = None,
        custom_exercises: list[dict[str, Any]] | None = None,
        expected_rev: int | None = None,
    ) -> dict[str, Any]:
        state = await self.async_load()
        self._assert_rev(state, expected_rev)
        cfg = state.get("exercise_config") if isinstance(state, dict) else None
        if not isinstance(cfg, dict):
            cfg = {"disabled_exercises": [], "custom_exercises": []}

        if disabled_exercises is not None:
            cleaned = []
            for n in disabled_exercises:
                s = str(n or "").strip()
                if s:
                    cleaned.append(s)
            # De-dupe, stable order
            seen: set[str] = set()
            unique = []
            for n in cleaned:
                if n in seen:
                    continue
                seen.add(n)
                unique.append(n)
            cfg["disabled_exercises"] = unique

        if custom_exercises is not None:
            normalized: list[dict[str, Any]] = []
            for ex in custom_exercises:
                if not isinstance(ex, dict):
                    continue
                n = _normalize_custom_exercise(ex)
                if n:
                    normalized.append(n)
            cfg["custom_exercises"] = normalized

        state["exercise_config"] = cfg
        return await self.async_save(state)

    async def async_save(self, state: dict[str, Any]) -> dict[str, Any]:
        next_state = dict(state or {})
        next_state["schema"] = 1
        next_state["rev"] = int(next_state.get("rev") or 1) + 1
        next_state["updated_at"] = _now_iso()
        self._data = next_state
        await self._store.async_save(self._data)
        return dict(self._data)

    async def async_set_active_person(self, person_id: str, *, expected_rev: int | None = None) -> dict[str, Any]:
        state = await self.async_load()
        self._assert_rev(state, expected_rev)
        people = state.get("people") if isinstance(state, dict) else []
        ids = {str(p.get("id") or "") for p in (people or []) if isinstance(p, dict)}
        if person_id not in ids:
            return state
        state["active_person_id"] = person_id
        # Reset overrides to per-person defaults on change, but preserve week navigation.
        # The calendar is not person-specific.
        prev_overrides = state.get("overrides") if isinstance(state, dict) else None
        if not isinstance(prev_overrides, dict):
            prev_overrides = {}
        keep_week_offset = self._clamp_week_offset(prev_overrides.get("week_offset"))
        keep_selected_weekday = prev_overrides.get("selected_weekday")
        keep_selected_weekday = int(keep_selected_weekday) if keep_selected_weekday is not None else None
        keep_progression = prev_overrides.get("progression")
        if not isinstance(keep_progression, dict):
            keep_progression = {"enabled": True, "step_pct": 2.5}
        keep_cycle = prev_overrides.get("cycle")
        if not isinstance(keep_cycle, dict):
            keep_cycle = {
                "enabled": False,
                "preset": DEFAULT_CYCLE_PRESET,
                "start_week_start": "",
                "training_weekdays": [0, 2, 4],
                "weeks": 4,
                "step_pct": DEFAULT_CYCLE_STEP_PCT,
                "deload_pct": DEFAULT_CYCLE_DELOAD_PCT,
                "deload_volume": DEFAULT_CYCLE_DELOAD_VOL,
            }

        person = next((p for p in people if isinstance(p, dict) and str(p.get("id")) == person_id), None)
        if isinstance(person, dict):
            state["overrides"] = {
                "week_offset": keep_week_offset,
                "selected_weekday": keep_selected_weekday,
                "duration_minutes": int(person.get("duration_minutes") or DEFAULT_DURATION_MINUTES),
                "preferred_exercises": str(person.get("preferred_exercises") or ""),
                "planning_mode": "auto",
                "progression": keep_progression,
                "cycle": keep_cycle,
                "session_overrides": {
                    "a_lower": "",
                    "a_push": "",
                    "a_pull": "",
                    "b_lower": "",
                    "b_push": "",
                    "b_pull": "",
                    "c_lower": "",
                    "c_push": "",
                    "c_pull": "",
                },
            }
        return await self.async_save(state)

    async def async_set_overrides(
        self,
        *,
        week_offset: int | None = None,
        selected_weekday: int | None = None,
        duration_minutes: int | None = None,
        preferred_exercises: str | None = None,
        planning_mode: str | None = None,
        session_overrides: dict[str, str] | None = None,
        intensity: str | None = None,
        progression: dict[str, Any] | None = None,
        cycle: dict[str, Any] | None = None,
        expected_rev: int | None = None,
    ) -> dict[str, Any]:
        state = await self.async_load()
        self._assert_rev(state, expected_rev)
        overrides = state.get("overrides") if isinstance(state, dict) else None
        if not isinstance(overrides, dict):
            overrides = {
                "week_offset": 0,
                "selected_weekday": None,
                "duration_minutes": None,
                "preferred_exercises": "",
                "planning_mode": "auto",
                "progression": {"enabled": True, "step_pct": 2.5},
                "cycle": {
                    "enabled": False,
                    "preset": DEFAULT_CYCLE_PRESET,
                    "start_week_start": "",
                    "training_weekdays": [0, 2, 4],
                    "weeks": 4,
                    "step_pct": DEFAULT_CYCLE_STEP_PCT,
                    "deload_pct": DEFAULT_CYCLE_DELOAD_PCT,
                    "deload_volume": DEFAULT_CYCLE_DELOAD_VOL,
                },
                "session_overrides": {},
            }
        if week_offset is not None:
            overrides["week_offset"] = self._clamp_week_offset(week_offset)
        if selected_weekday is not None:
            overrides["selected_weekday"] = int(selected_weekday)
        if duration_minutes is not None:
            overrides["duration_minutes"] = int(duration_minutes)
        if preferred_exercises is not None:
            overrides["preferred_exercises"] = str(preferred_exercises or "")
        if planning_mode is not None:
            overrides["planning_mode"] = str(planning_mode or "auto").lower()
        if intensity is not None:
            overrides["intensity"] = str(intensity or "normal").lower()
        if progression is not None:
            cur = overrides.get("progression")
            if not isinstance(cur, dict):
                cur = {}
            if isinstance(progression.get("enabled"), bool):
                cur["enabled"] = bool(progression.get("enabled"))
            if progression.get("step_pct") is not None:
                try:
                    cur["step_pct"] = float(progression.get("step_pct"))
                except Exception:  # noqa: BLE001
                    pass
            if "enabled" not in cur:
                cur["enabled"] = True
            if "step_pct" not in cur:
                cur["step_pct"] = 2.5
            overrides["progression"] = cur
        if cycle is not None:
            cur = overrides.get("cycle")
            if not isinstance(cur, dict):
                cur = {}
            if isinstance(cycle.get("enabled"), bool):
                cur["enabled"] = bool(cycle.get("enabled"))
            preset = str(cycle.get("preset") or "").strip().lower()
            if preset in {"strength", "hypertrophy", "minimalist"}:
                cur["preset"] = preset
            program = str(cycle.get("program") or "").strip().lower()
            if program in {"full_body_abc", "full_body_2day", "upper_lower_4day"}:
                cur["program"] = program
            if cycle.get("start_week_start") is not None:
                cur["start_week_start"] = str(cycle.get("start_week_start") or "").strip()
            tw = cycle.get("training_weekdays")
            if isinstance(tw, list):
                cleaned: list[int] = []
                for x in tw:
                    try:
                        xi = int(x)
                    except Exception:  # noqa: BLE001
                        continue
                    if 0 <= xi <= 6 and xi not in cleaned:
                        cleaned.append(xi)
                cleaned.sort()
                cur["training_weekdays"] = cleaned
            if cycle.get("weeks") is not None:
                try:
                    cur["weeks"] = int(cycle.get("weeks"))
                except Exception:  # noqa: BLE001
                    pass
            if cycle.get("step_pct") is not None:
                try:
                    cur["step_pct"] = float(cycle.get("step_pct"))
                except Exception:  # noqa: BLE001
                    pass
            if cycle.get("deload_pct") is not None:
                try:
                    cur["deload_pct"] = float(cycle.get("deload_pct"))
                except Exception:  # noqa: BLE001
                    pass
            if cycle.get("deload_volume") is not None:
                try:
                    cur["deload_volume"] = float(cycle.get("deload_volume"))
                except Exception:  # noqa: BLE001
                    pass
            if "enabled" not in cur:
                cur["enabled"] = False
            if "preset" not in cur:
                cur["preset"] = DEFAULT_CYCLE_PRESET
            if "program" not in cur:
                cur["program"] = DEFAULT_CYCLE_PROGRAM
            if "start_week_start" not in cur:
                cur["start_week_start"] = ""
            if "training_weekdays" not in cur or not isinstance(cur.get("training_weekdays"), list):
                cur["training_weekdays"] = [0, 2, 4]
            if "weeks" not in cur:
                cur["weeks"] = 4
            try:
                cur["weeks"] = max(1, min(12, int(cur.get("weeks") or 4)))
            except Exception:  # noqa: BLE001
                cur["weeks"] = 4
            if "step_pct" not in cur:
                cur["step_pct"] = DEFAULT_CYCLE_STEP_PCT
            if "deload_pct" not in cur:
                cur["deload_pct"] = DEFAULT_CYCLE_DELOAD_PCT
            if "deload_volume" not in cur:
                cur["deload_volume"] = DEFAULT_CYCLE_DELOAD_VOL
            overrides["cycle"] = cur
        if session_overrides is not None:
            current = overrides.get("session_overrides")
            if not isinstance(current, dict):
                current = {}
            # Merge known keys only
            for key, value in session_overrides.items():
                current[str(key)] = str(value or "")
            overrides["session_overrides"] = current
        state["overrides"] = overrides
        return await self.async_save(state)

    async def async_upsert_person(self, person: dict[str, Any], *, expected_rev: int | None = None) -> dict[str, Any]:
        state = await self.async_load()
        self._assert_rev(state, expected_rev)
        people = state.get("people")
        if not isinstance(people, list):
            people = []

        incoming_id = str(person.get("id") or "").strip()
        if not incoming_id:
            person = {**_new_person(name=str(person.get("name") or "Person")), **person}
            incoming_id = str(person.get("id") or "")
        existing = next((p for p in people if isinstance(p, dict) and str(p.get("id") or "") == incoming_id), None)
        prev_maxes = existing.get("maxes") if isinstance(existing, dict) and isinstance(existing.get("maxes"), dict) else {}

        now = _now_iso()
        normalized = dict(person)
        normalized["id"] = incoming_id
        normalized["name"] = str(normalized.get("name") or "Person").strip() or "Person"
        # Color is user-configurable. If missing, keep existing, else choose a deterministic default.
        color = str(normalized.get("color") or "").strip()
        if not color and isinstance(existing, dict):
            color = str(existing.get("color") or "").strip()
        if not color:
            color = _color_for_id(incoming_id)
        normalized["color"] = color
        normalized["gender"] = str(normalized.get("gender") or DEFAULT_GENDER).lower()
        normalized["duration_minutes"] = int(normalized.get("duration_minutes") or DEFAULT_DURATION_MINUTES)
        normalized["preferred_exercises"] = str(normalized.get("preferred_exercises") or "").strip()
        normalized["equipment"] = str(normalized.get("equipment") or DEFAULT_EQUIPMENT).strip()
        normalized["units"] = str(normalized.get("units") or DEFAULT_UNITS).lower()
        # Preserve existing per-person cycle unless explicitly updated.
        if "cycle" not in normalized and isinstance(existing, dict) and "cycle" in existing:
            normalized["cycle"] = existing.get("cycle")
        if normalized.get("cycle") is not None and not isinstance(normalized.get("cycle"), dict):
            normalized["cycle"] = None
        maxes = normalized.get("maxes")
        if not isinstance(maxes, dict):
            maxes = {}
        normalized["maxes"] = {
            "squat": int(maxes.get("squat") or DEFAULT_MAX_SQ),
            "deadlift": int(maxes.get("deadlift") or DEFAULT_MAX_DL),
            "bench": int(maxes.get("bench") or DEFAULT_MAX_BP),
        }
        maxes_changed = (
            int(prev_maxes.get("squat") or 0) != int(normalized["maxes"].get("squat") or 0)
            or int(prev_maxes.get("deadlift") or 0) != int(normalized["maxes"].get("deadlift") or 0)
            or int(prev_maxes.get("bench") or 0) != int(normalized["maxes"].get("bench") or 0)
        )
        normalized["updated_at"] = now
        normalized.setdefault("created_at", now)

        replaced = False
        for idx, existing in enumerate(people):
            if isinstance(existing, dict) and str(existing.get("id") or "") == incoming_id:
                people[idx] = normalized
                replaced = True
                break
        if not replaced:
            people.append(normalized)

        state["people"] = people
        if not state.get("active_person_id"):
            state["active_person_id"] = incoming_id
        # If user updated 1RM maxes, recompute suggested loads for workouts in the active cycle window.
        if maxes_changed:
            try:
                _recompute_cycle_workout_loads_for_person(state, person=normalized)
            except Exception:  # noqa: BLE001
                pass
        return await self.async_save(state)

    async def async_delete_person(self, person_id: str, *, expected_rev: int | None = None) -> dict[str, Any]:
        state = await self.async_load()
        self._assert_rev(state, expected_rev)
        people = state.get("people")
        if not isinstance(people, list):
            return state
        people = [p for p in people if not (isinstance(p, dict) and str(p.get("id") or "") == person_id)]
        state["people"] = people
        plans = state.get("plans")
        if isinstance(plans, dict):
            plans.pop(person_id, None)
            state["plans"] = plans
        if state.get("active_person_id") == person_id:
            state["active_person_id"] = str(people[0].get("id")) if people else ""
        return await self.async_save(state)

    async def async_set_person_cycle(
        self,
        *,
        person_id: str,
        cycle: dict[str, Any] | None,
        expected_rev: int | None = None,
    ) -> dict[str, Any]:
        """Set or clear the per-person 4-week cycle config."""
        state = await self.async_load()
        self._assert_rev(state, expected_rev)
        people = state.get("people")
        if not isinstance(people, list):
            return state
        pid = str(person_id or "").strip()
        if not pid:
            return state

        # Normalize incoming cycle (or clear).
        next_cycle: dict[str, Any] | None = None
        if isinstance(cycle, dict):
            cur: dict[str, Any] = {}
            if isinstance(cycle.get("enabled"), bool):
                cur["enabled"] = bool(cycle.get("enabled"))
            preset = str(cycle.get("preset") or "").strip().lower()
            if preset in {"strength", "hypertrophy", "minimalist"}:
                cur["preset"] = preset
            if cycle.get("start_week_start") is not None:
                cur["start_week_start"] = str(cycle.get("start_week_start") or "").strip()
            tw = cycle.get("training_weekdays")
            if isinstance(tw, list):
                cleaned: list[int] = []
                for x in tw:
                    try:
                        xi = int(x)
                    except Exception:  # noqa: BLE001
                        continue
                    if 0 <= xi <= 6 and xi not in cleaned:
                        cleaned.append(xi)
                cleaned.sort()
                cur["training_weekdays"] = cleaned
            if cycle.get("weeks") is not None:
                try:
                    cur["weeks"] = int(cycle.get("weeks"))
                except Exception:  # noqa: BLE001
                    pass
            if cycle.get("step_pct") is not None:
                try:
                    cur["step_pct"] = float(cycle.get("step_pct"))
                except Exception:  # noqa: BLE001
                    pass
            if cycle.get("deload_pct") is not None:
                try:
                    cur["deload_pct"] = float(cycle.get("deload_pct"))
                except Exception:  # noqa: BLE001
                    pass
            if cycle.get("deload_volume") is not None:
                try:
                    cur["deload_volume"] = float(cycle.get("deload_volume"))
                except Exception:  # noqa: BLE001
                    pass

            if "enabled" not in cur:
                cur["enabled"] = False
            if "preset" not in cur:
                cur["preset"] = DEFAULT_CYCLE_PRESET
            if "start_week_start" not in cur:
                cur["start_week_start"] = ""
            if "training_weekdays" not in cur or not isinstance(cur.get("training_weekdays"), list):
                cur["training_weekdays"] = [0, 2, 4]
            if "weeks" not in cur:
                cur["weeks"] = 4
            try:
                cur["weeks"] = max(1, min(12, int(cur.get("weeks") or 4)))
            except Exception:  # noqa: BLE001
                cur["weeks"] = 4
            if "step_pct" not in cur:
                cur["step_pct"] = DEFAULT_CYCLE_STEP_PCT
            if "deload_pct" not in cur:
                cur["deload_pct"] = DEFAULT_CYCLE_DELOAD_PCT
            if "deload_volume" not in cur:
                cur["deload_volume"] = DEFAULT_CYCLE_DELOAD_VOL
            next_cycle = cur if bool(cur.get("enabled")) else None

        changed = False
        for p in people:
            if not isinstance(p, dict):
                continue
            if str(p.get("id") or "") != pid:
                continue
            if next_cycle is None:
                if p.get("cycle") is not None:
                    p["cycle"] = None
                    changed = True
            else:
                p["cycle"] = next_cycle
                changed = True
            break
        if not changed:
            return state
        state["people"] = people
        return await self.async_save(state)

    async def async_save_plan(
        self, *, person_id: str, week_start: str, plan: dict[str, Any], expected_rev: int | None = None
    ) -> dict[str, Any]:
        state = await self.async_load()
        self._assert_rev(state, expected_rev)
        plans = state.get("plans")
        if not isinstance(plans, dict):
            plans = {}
        person_plans = plans.get(str(person_id))
        if not isinstance(person_plans, dict):
            person_plans = {}
        person_plans[str(week_start)] = dict(plan or {})
        plans[str(person_id)] = person_plans
        state["plans"] = plans
        return await self.async_save(state)

    async def async_delete_week(self, *, week_start: str, expected_rev: int | None = None) -> dict[str, Any]:
        """Delete a week plan for all people (blank canvas on new week)."""
        state = await self.async_load()
        self._assert_rev(state, expected_rev)
        plans = state.get("plans")
        if not isinstance(plans, dict):
            return state
        changed = False
        for pid, person_plans in list(plans.items()):
            if not isinstance(person_plans, dict):
                continue
            if str(week_start) in person_plans:
                person_plans.pop(str(week_start), None)
                plans[str(pid)] = person_plans
                changed = True
        if changed:
            state["plans"] = plans
            return await self.async_save(state)
        return state

    async def async_archive_week(self, *, week_start: str, keep_weeks: int = 4) -> dict[str, Any]:
        """Archive completed workouts for a week into history (read-only)."""
        state = await self.async_load()
        plans = state.get("plans")
        if not isinstance(plans, dict):
            return state

        people = state.get("people") if isinstance(state.get("people"), list) else []
        people_by_id = {str(p.get("id") or ""): p for p in people if isinstance(p, dict)}
        completed: list[dict[str, Any]] = []

        for pid, person_plans in plans.items():
            if not isinstance(person_plans, dict):
                continue
            plan = person_plans.get(str(week_start))
            if not isinstance(plan, dict):
                continue
            workouts = plan.get("workouts")
            if not isinstance(workouts, list):
                continue
            person = people_by_id.get(str(pid)) or {}
            for w in workouts:
                if not isinstance(w, dict):
                    continue
                if not bool(w.get("completed")):
                    continue
                completed.append(
                    {
                        "person_id": str(pid),
                        "person_name": str(person.get("name") or ""),
                        "person_color": str(person.get("color") or ""),
                        "week_start": str(week_start),
                        "date": str(w.get("date") or ""),
                        "workout": w,
                    }
                )

        if not completed:
            return state

        history = state.get("history")
        if not isinstance(history, list):
            history = []
        history.append({"week_start": str(week_start), "archived_at": _now_iso(), "completed": completed})
        state["history"] = _trim_history(history, keep=int(keep_weeks))
        return await self.async_save(state)

    def get_history(self, state: dict[str, Any]) -> list[dict[str, Any]]:
        history = state.get("history") if isinstance(state, dict) else None
        return history if isinstance(history, list) else []

    async def async_set_workout_completed(
        self, *, person_id: str, week_start: str, date_iso: str, completed: bool, expected_rev: int | None = None
    ) -> dict[str, Any]:
        """Toggle completed flag on a workout by date."""
        state = await self.async_load()
        self._assert_rev(state, expected_rev)
        plan = self.get_plan(state, person_id=str(person_id), week_start=str(week_start))
        if not isinstance(plan, dict):
            return state
        workouts = plan.get("workouts")
        if not isinstance(workouts, list):
            return state
        target = str(date_iso or "").strip()
        if not target:
            return state
        changed = False
        for w in workouts:
            if not isinstance(w, dict):
                continue
            if str(w.get("date") or "") != target:
                continue
            w["completed"] = bool(completed)
            w["completed_at"] = _now_iso() if completed else None
            changed = True
            break
        if not changed:
            return state
        plan["workouts"] = workouts
        return await self.async_save_plan(person_id=str(person_id), week_start=str(week_start), plan=plan)

    async def async_delete_workout(
        self, *, person_id: str, week_start: str, date_iso: str, expected_rev: int | None = None
    ) -> dict[str, Any]:
        """Delete a workout by date."""
        state = await self.async_load()
        self._assert_rev(state, expected_rev)
        plan = self.get_plan(state, person_id=str(person_id), week_start=str(week_start))
        if not isinstance(plan, dict):
            return state
        workouts = plan.get("workouts")
        if not isinstance(workouts, list):
            return state
        target = str(date_iso or "").strip()
        if not target:
            return state
        next_workouts = [w for w in workouts if not (isinstance(w, dict) and str(w.get("date") or "") == target)]
        if len(next_workouts) == len(workouts):
            return state
        plan["workouts"] = next_workouts
        return await self.async_save_plan(person_id=str(person_id), week_start=str(week_start), plan=plan)

    async def async_delete_workout_series(
        self,
        *,
        person_id: str,
        start_week_start: str,
        weekday: int,
        weeks: int = 4,
        expected_rev: int | None = None,
    ) -> dict[str, Any]:
        """Delete a weekly series (same weekday) across N weeks.

        Used for 4-week cycles: delete a whole "series" of planned sessions.
        """
        state = await self.async_load()
        self._assert_rev(state, expected_rev)

        pid = str(person_id or "").strip()
        if not pid:
            return state
        try:
            start_ws = date.fromisoformat(str(start_week_start or "").strip())
        except Exception:  # noqa: BLE001
            return state
        wd = max(0, min(6, int(weekday)))
        n = max(1, min(12, int(weeks or 4)))

        plans = state.get("plans")
        if not isinstance(plans, dict):
            return state
        person_plans = plans.get(pid)
        if not isinstance(person_plans, dict):
            return state

        changed = False
        for i in range(n):
            week_start_day = start_ws + timedelta(days=i * 7)
            wk_key = week_start_day.isoformat()
            plan = person_plans.get(wk_key)
            if not isinstance(plan, dict):
                continue
            workouts = plan.get("workouts")
            if not isinstance(workouts, list) or not workouts:
                continue
            target_date = (week_start_day + timedelta(days=wd)).isoformat()
            next_workouts = [w for w in workouts if not (isinstance(w, dict) and str(w.get("date") or "") == target_date)]
            if len(next_workouts) != len(workouts):
                plan = dict(plan)
                plan["workouts"] = next_workouts
                person_plans[wk_key] = plan
                changed = True

        if not changed:
            return state
        plans[pid] = person_plans
        state["plans"] = plans
        return await self.async_save(state)

    async def async_delete_cycle(self, *, person_id: str, expected_rev: int | None = None) -> dict[str, Any]:
        """Delete the entire active cycle for a person.

        This removes:
        - all workouts in the cycle window (all planned weekdays across N weeks)
        - the per-person cycle config itself (which removes Planned markers)
        """
        state = await self.async_load()
        self._assert_rev(state, expected_rev)

        pid = str(person_id or "").strip()
        if not pid:
            return state

        people = state.get("people")
        if not isinstance(people, list):
            return state
        person = next((p for p in people if isinstance(p, dict) and str(p.get("id") or "") == pid), None)
        if not isinstance(person, dict):
            return state

        cy = person.get("cycle")
        if not isinstance(cy, dict) or not bool(cy.get("enabled")):
            # Still clear any stray cycle field to guarantee reset.
            if person.get("cycle") is not None:
                person["cycle"] = None
                return await self.async_save(state)
            return state

        start_raw = str(cy.get("start_week_start") or "").strip()[:10]
        if not start_raw:
            person["cycle"] = None
            return await self.async_save(state)
        try:
            start_ws = date.fromisoformat(start_raw)
        except Exception:  # noqa: BLE001
            person["cycle"] = None
            return await self.async_save(state)
        try:
            weeks = max(1, min(12, int(cy.get("weeks") or 4)))
        except Exception:  # noqa: BLE001
            weeks = 4
        tdays = cy.get("training_weekdays")
        training_weekdays: list[int] = []
        if isinstance(tdays, list):
            for x in tdays:
                try:
                    xi = int(x)
                except Exception:  # noqa: BLE001
                    continue
                if 0 <= xi <= 6 and xi not in training_weekdays:
                    training_weekdays.append(xi)
        training_weekdays.sort()

        plans = state.get("plans")
        if not isinstance(plans, dict):
            plans = {}
        person_plans = plans.get(pid)
        if not isinstance(person_plans, dict):
            person_plans = {}

        changed = False
        if training_weekdays:
            for i in range(weeks):
                week_start_day = start_ws + timedelta(days=i * 7)
                wk_key = week_start_day.isoformat()
                plan = person_plans.get(wk_key)
                if not isinstance(plan, dict):
                    continue
                workouts = plan.get("workouts")
                if not isinstance(workouts, list) or not workouts:
                    continue
                targets = {(week_start_day + timedelta(days=wd)).isoformat() for wd in training_weekdays}
                next_workouts = [w for w in workouts if not (isinstance(w, dict) and str(w.get("date") or "") in targets)]
                if len(next_workouts) != len(workouts):
                    plan2 = dict(plan)
                    plan2["workouts"] = next_workouts
                    person_plans[wk_key] = plan2
                    changed = True

        # Clear cycle config (removes Planned markers).
        person["cycle"] = None
        changed = True

        plans[pid] = person_plans
        state["plans"] = plans
        state["people"] = people
        return await self.async_save(state)

    async def async_upsert_workout(
        self,
        *,
        person_id: str,
        week_start: str,
        workout: dict[str, Any],
        expected_rev: int | None = None,
    ) -> dict[str, Any]:
        """Insert or replace a workout (used for undo restore/import)."""
        state = await self.async_load()
        self._assert_rev(state, expected_rev)
        plan = self.get_plan(state, person_id=str(person_id), week_start=str(week_start)) or {}
        if not isinstance(plan, dict):
            plan = {}
        workouts = plan.get("workouts")
        if not isinstance(workouts, list):
            workouts = []
        date_iso = str((workout or {}).get("date") or "").strip()
        if not date_iso:
            return state
        workouts = [w for w in workouts if not (isinstance(w, dict) and str(w.get("date") or "") == date_iso)]
        workouts.append(dict(workout or {}))
        plan["workouts"] = workouts
        return await self.async_save_plan(person_id=str(person_id), week_start=str(week_start), plan=plan)

    def get_plan(self, state: dict[str, Any], *, person_id: str, week_start: str) -> dict[str, Any] | None:
        plans = state.get("plans") if isinstance(state, dict) else None
        if not isinstance(plans, dict):
            return None
        person_plans = plans.get(str(person_id))
        if not isinstance(person_plans, dict):
            return None
        plan = person_plans.get(str(week_start))
        return plan if isinstance(plan, dict) else None
