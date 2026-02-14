"""Storage for Weekly Training (.storage).

State model (schema v1):
- people: list of people profiles (gender, defaults, 1RM maxes, preferences)
- active_person_id: which person the UI controls target by default
- overrides: per-entry generation overrides (week offset/day + duration/preferred + planning mode + session picks)
- exercise_config: exercise list overrides (disable built-ins, add custom exercises)
- plans: mapping person_id -> mapping week_start -> plan payload
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

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


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


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
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    }


class WeeklyTrainingStore:
    """Per-config-entry storage wrapper."""

    def __init__(self, hass: HomeAssistant, entry_id: str) -> None:
        self._store: Store[dict[str, Any]] = Store(hass, _STORAGE_VERSION, f"{DOMAIN}_{entry_id}")
        self._data: dict[str, Any] | None = None

    async def async_load(self) -> dict[str, Any]:
        if self._data is None:
            loaded = await self._store.async_load()
            self._data = loaded if isinstance(loaded, dict) else {}

            self._data.setdefault("schema", 1)
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
                    "session_overrides": {
                        "a_lower": "",
                        "a_push": "",
                        "a_pull": "",
                        "b_lower": "",
                        "b_push": "",
                        "b_pull": "",
                        "c_lower": "",
                        "c_push": "",
                        "c_pull": ""
                    },
                },
            )
            self._data.setdefault("plans", {})
            self._data.setdefault(
                "exercise_config",
                {
                    # If non-empty: these exercise names are excluded from auto-picks and manual picks.
                    "disabled_exercises": [],
                    # List of custom exercise dicts {name,tags,equipment} to be merged into the library.
                    "custom_exercises": [],
                },
            )
            self._data.setdefault("updated_at", _now_iso())

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

        return dict(self._data)

    async def async_set_exercise_config(
        self,
        *,
        disabled_exercises: list[str] | None = None,
        custom_exercises: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        state = await self.async_load()
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
                name = str(ex.get("name") or "").strip()
                if not name:
                    continue
                tags = ex.get("tags") or []
                equipment = ex.get("equipment") or []
                if not isinstance(tags, list):
                    tags = []
                if not isinstance(equipment, list):
                    equipment = []
                normalized.append(
                    {
                        "name": name,
                        "tags": [str(t).strip().lower() for t in tags if str(t).strip()],
                        "equipment": [str(t).strip().lower() for t in equipment if str(t).strip()],
                    }
                )
            cfg["custom_exercises"] = normalized

        state["exercise_config"] = cfg
        return await self.async_save(state)

    async def async_save(self, state: dict[str, Any]) -> dict[str, Any]:
        next_state = dict(state or {})
        next_state["schema"] = 1
        next_state["updated_at"] = _now_iso()
        self._data = next_state
        await self._store.async_save(self._data)
        return dict(self._data)

    async def async_set_active_person(self, person_id: str) -> dict[str, Any]:
        state = await self.async_load()
        people = state.get("people") if isinstance(state, dict) else []
        ids = {str(p.get("id") or "") for p in (people or []) if isinstance(p, dict)}
        if person_id not in ids:
            return state
        state["active_person_id"] = person_id
        # Reset overrides to per-person defaults on change.
        person = next((p for p in people if isinstance(p, dict) and str(p.get("id")) == person_id), None)
        if isinstance(person, dict):
            state["overrides"] = {
                "week_offset": 0,
                "selected_weekday": None,
                "duration_minutes": int(person.get("duration_minutes") or DEFAULT_DURATION_MINUTES),
                "preferred_exercises": str(person.get("preferred_exercises") or ""),
                "planning_mode": "auto",
                "session_overrides": {
                    "a_lower": "",
                    "a_push": "",
                    "a_pull": "",
                    "b_lower": "",
                    "b_push": "",
                    "b_pull": "",
                    "c_lower": "",
                    "c_push": "",
                    "c_pull": ""
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
    ) -> dict[str, Any]:
        state = await self.async_load()
        overrides = state.get("overrides") if isinstance(state, dict) else None
        if not isinstance(overrides, dict):
            overrides = {
                "week_offset": 0,
                "selected_weekday": None,
                "duration_minutes": None,
                "preferred_exercises": "",
                "planning_mode": "auto",
                "session_overrides": {},
            }
        if week_offset is not None:
            overrides["week_offset"] = int(week_offset)
        if selected_weekday is not None:
            overrides["selected_weekday"] = int(selected_weekday)
        if duration_minutes is not None:
            overrides["duration_minutes"] = int(duration_minutes)
        if preferred_exercises is not None:
            overrides["preferred_exercises"] = str(preferred_exercises or "")
        if planning_mode is not None:
            overrides["planning_mode"] = str(planning_mode or "auto").lower()
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

    async def async_upsert_person(self, person: dict[str, Any]) -> dict[str, Any]:
        state = await self.async_load()
        people = state.get("people")
        if not isinstance(people, list):
            people = []

        incoming_id = str(person.get("id") or "").strip()
        if not incoming_id:
            person = {**_new_person(name=str(person.get("name") or "Person")), **person}
            incoming_id = str(person.get("id") or "")

        now = _now_iso()
        normalized = dict(person)
        normalized["id"] = incoming_id
        normalized["name"] = str(normalized.get("name") or "Person").strip() or "Person"
        normalized["gender"] = str(normalized.get("gender") or DEFAULT_GENDER).lower()
        normalized["duration_minutes"] = int(normalized.get("duration_minutes") or DEFAULT_DURATION_MINUTES)
        normalized["preferred_exercises"] = str(normalized.get("preferred_exercises") or "").strip()
        normalized["equipment"] = str(normalized.get("equipment") or DEFAULT_EQUIPMENT).strip()
        normalized["units"] = str(normalized.get("units") or DEFAULT_UNITS).lower()
        maxes = normalized.get("maxes")
        if not isinstance(maxes, dict):
            maxes = {}
        normalized["maxes"] = {
            "squat": int(maxes.get("squat") or DEFAULT_MAX_SQ),
            "deadlift": int(maxes.get("deadlift") or DEFAULT_MAX_DL),
            "bench": int(maxes.get("bench") or DEFAULT_MAX_BP),
        }
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
        return await self.async_save(state)

    async def async_delete_person(self, person_id: str) -> dict[str, Any]:
        state = await self.async_load()
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

    async def async_save_plan(self, *, person_id: str, week_start: str, plan: dict[str, Any]) -> dict[str, Any]:
        state = await self.async_load()
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

    def get_plan(self, state: dict[str, Any], *, person_id: str, week_start: str) -> dict[str, Any] | None:
        plans = state.get("plans") if isinstance(state, dict) else None
        if not isinstance(plans, dict):
            return None
        person_plans = plans.get(str(person_id))
        if not isinstance(person_plans, dict):
            return None
        plan = person_plans.get(str(week_start))
        return plan if isinstance(plan, dict) else None
