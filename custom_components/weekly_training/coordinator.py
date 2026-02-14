"""Coordinator for Weekly Training."""

from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
from homeassistant.util import dt as dt_util

from .const import (
    CONF_DURATION_MINUTES,
    CONF_EQUIPMENT,
    CONF_GENDER,
    CONF_PREFERRED_EXERCISES,
    DOMAIN,
    SIGNAL_PLAN_UPDATED,
)
from .library import ExerciseLibrary
from .planner import generate_session
from .storage import WeeklyTrainingStore

_LOGGER = logging.getLogger(__name__)


class WeeklyTrainingCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Coordinates loading and generating weekly training plans."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.entry = entry
        self.store = WeeklyTrainingStore(hass, entry.entry_id)
        self.library = ExerciseLibrary()

        super().__init__(
            hass,
            logger=_LOGGER,
            name=f"{DOMAIN}_{entry.entry_id}",
            update_interval=timedelta(hours=6),
        )

    def _profile_from_entry(self) -> dict[str, Any]:
        # Kept for backwards compatibility; per-person profiles live in storage.
        data = self.entry.data or {}
        opts = self.entry.options or {}
        return {
            "gender": str(opts.get(CONF_GENDER, data.get(CONF_GENDER, "male")) or "male"),
            "duration_minutes": int(opts.get(CONF_DURATION_MINUTES, data.get(CONF_DURATION_MINUTES, 45)) or 45),
            "preferred_exercises": str(
                opts.get(CONF_PREFERRED_EXERCISES, data.get(CONF_PREFERRED_EXERCISES, "")) or ""
            ).strip(),
            "equipment": str(opts.get(CONF_EQUIPMENT, data.get(CONF_EQUIPMENT, "")) or "").strip(),
        }

    async def _async_update_data(self) -> dict[str, Any]:
        # Single source of truth is storage; entities/services write to it.
        return await self.store.async_load()

    def _week_start_for_offset(self, offset: int) -> date:
        today = dt_util.as_local(dt_util.utcnow()).date()
        monday = today - timedelta(days=today.weekday())
        return monday + timedelta(days=int(offset) * 7)

    async def async_generate_for_day(
        self,
        *,
        person_id: str | None = None,
        week_offset: int | None = None,
        weekday: int | None = None,
    ) -> dict[str, Any]:
        """Generate and persist a session for a specific weekday in a selected week."""
        state = await self.store.async_load()
        overrides = state.get("overrides") if isinstance(state, dict) else {}
        if not isinstance(overrides, dict):
            overrides = {}

        library = await self.library.async_load()
        people = state.get("people", []) if isinstance(state, dict) else []
        active_id = str(person_id or state.get("active_person_id") or "")
        person = next((p for p in people if isinstance(p, dict) and str(p.get("id") or "") == active_id), None)
        if not isinstance(person, dict):
            person = people[0] if people and isinstance(people[0], dict) else {}
            active_id = str(person.get("id") or "")

        # Week/day selection
        effective_week_offset = int(week_offset) if week_offset is not None else int(overrides.get("week_offset") or 0)
        week_start_day = self._week_start_for_offset(effective_week_offset)
        if weekday is None:
            sel = overrides.get("selected_weekday")
            if sel is None:
                sel = dt_util.as_local(dt_util.utcnow()).date().weekday()
            weekday = int(sel)
        weekday = max(0, min(6, int(weekday)))

        # Apply per-generation overrides on top of the active person profile.
        effective_profile = dict(person)
        if overrides.get("duration_minutes") is not None:
            effective_profile["duration_minutes"] = int(overrides.get("duration_minutes") or effective_profile.get("duration_minutes") or 45)
        if overrides.get("preferred_exercises") is not None:
            effective_profile["preferred_exercises"] = str(overrides.get("preferred_exercises") or "")

        existing_plan = self.store.get_plan(state, person_id=active_id, week_start=week_start_day.isoformat())
        plan = generate_session(
            profile=effective_profile,
            library=library,
            overrides=overrides,
            week_start_day=week_start_day,
            weekday=weekday,
            existing_plan=existing_plan,
        )

        updated = await self.store.async_save_plan(person_id=active_id, week_start=week_start_day.isoformat(), plan=plan)
        # Nudge entity UI to refresh options/overrides when generation happens.
        try:
            from homeassistant.helpers.dispatcher import async_dispatcher_send

            async_dispatcher_send(self.hass, f"{SIGNAL_PLAN_UPDATED}_{self.entry.entry_id}")
        except Exception:  # noqa: BLE001
            pass
        await self.async_request_refresh()
        return updated
