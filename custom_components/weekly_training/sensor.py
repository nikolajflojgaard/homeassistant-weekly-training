"""Sensor platform for Weekly Training."""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import WeeklyTrainingCoordinator
from .entity import device_info_from_entry


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: WeeklyTrainingCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([WeeklyPlanSensor(entry, coordinator)])


class WeeklyPlanSensor(CoordinatorEntity[WeeklyTrainingCoordinator], SensorEntity):
    """Sensor exposing the latest weekly training plan."""

    _attr_has_entity_name = True
    _attr_name = "Weekly plan"
    _attr_icon = "mdi:dumbbell"
    _attr_translation_key = "weekly_plan"

    def __init__(self, entry: ConfigEntry, coordinator: WeeklyTrainingCoordinator) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_weekly_plan"
        self._attr_device_info = device_info_from_entry(entry)

    @property
    def native_value(self) -> str:
        data = self.coordinator.data or {}
        if isinstance(data, dict):
            overrides = data.get("overrides", {}) if isinstance(data.get("overrides"), dict) else {}
            week_offset = int(overrides.get("week_offset") or 0)
            week_start = self.coordinator._week_start_for_offset(week_offset).isoformat()  # noqa: SLF001
            active_id = str(data.get("active_person_id") or "")
            plans = data.get("plans", {}) if isinstance(data.get("plans"), dict) else {}
            person_plans = plans.get(active_id) if active_id and isinstance(plans.get(active_id), dict) else {}
            plan = person_plans.get(week_start) if isinstance(person_plans, dict) else None
            if isinstance(plan, dict) and plan.get("week_number") is not None:
                return str(plan.get("week_number"))
        return "not_generated"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        data = self.coordinator.data or {}
        plan = None
        person = None
        if isinstance(data, dict):
            active_id = str(data.get("active_person_id") or "")
            overrides = data.get("overrides", {}) if isinstance(data.get("overrides"), dict) else {}
            week_offset = int(overrides.get("week_offset") or 0)
            week_start = self.coordinator._week_start_for_offset(week_offset).isoformat()  # noqa: SLF001
            plans = data.get("plans", {}) if isinstance(data.get("plans"), dict) else {}
            person_plans = plans.get(active_id) if active_id and isinstance(plans.get(active_id), dict) else {}
            plan = person_plans.get(week_start) if isinstance(person_plans, dict) else None
            people = data.get("people", []) if isinstance(data.get("people"), list) else []
            person = next((p for p in people if isinstance(p, dict) and str(p.get("id") or "") == active_id), None)
        attrs: dict[str, Any] = {
            "entry_id": self._entry.entry_id,
            "updated_at": str(data.get("updated_at") or ""),
            "person": person if isinstance(person, dict) else {},
        }
        if isinstance(plan, dict):
            attrs["week_number"] = plan.get("week_number")
            attrs["week_start"] = plan.get("week_start")
            attrs["generated_at"] = plan.get("generated_at")
            attrs["workouts"] = plan.get("workouts", [])
            attrs["markdown"] = plan.get("markdown", "")
        return attrs
