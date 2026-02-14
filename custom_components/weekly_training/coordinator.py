"""Coordinator for Weekly Training."""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .const import (
    CONF_DURATION_MINUTES,
    CONF_EQUIPMENT,
    CONF_GENDER,
    CONF_PREFERRED_EXERCISES,
    DOMAIN,
    SIGNAL_PLAN_UPDATED,
)
from .library import ExerciseLibrary
from .planner import build_weekly_plan
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

    async def async_generate_plan(self, *, person_id: str | None = None) -> dict[str, Any]:
        """Generate and persist a plan for the current ISO week."""
        profile = self._profile_from_entry()
        state = await self.store.async_load()

        library = await self.library.async_load()
        people = state.get("people", []) if isinstance(state, dict) else []
        active_id = str(person_id or state.get("active_person_id") or "")
        person = next((p for p in people if isinstance(p, dict) and str(p.get("id") or "") == active_id), None)
        if not isinstance(person, dict):
            person = people[0] if people and isinstance(people[0], dict) else {}
            active_id = str(person.get("id") or "")

        overrides = state.get("overrides") if isinstance(state, dict) else {}
        if not isinstance(overrides, dict):
            overrides = {}
        duration_override = overrides.get("duration_minutes")
        preferred_override = overrides.get("preferred_exercises")

        effective = dict(person)
        if duration_override is not None:
            effective["duration_minutes"] = int(duration_override)
        if preferred_override is not None:
            effective["preferred_exercises"] = str(preferred_override or "")

        plan = build_weekly_plan(profile=effective, library=library, overrides=overrides)

        updated = await self.store.async_save_plan(person_id=active_id, plan=plan)
        # Nudge entity UI to refresh options/overrides when generation happens.
        try:
            from homeassistant.helpers.dispatcher import async_dispatcher_send

            async_dispatcher_send(self.hass, f"{SIGNAL_PLAN_UPDATED}_{self.entry.entry_id}")
        except Exception:  # noqa: BLE001
            pass
        await self.async_request_refresh()
        return updated
