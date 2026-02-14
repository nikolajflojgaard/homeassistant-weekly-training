"""Button platform for Weekly Training."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import WeeklyTrainingCoordinator
from .entity import device_info_from_entry


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: WeeklyTrainingCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([GenerateWeeklyPlanButton(entry, coordinator)])


class GenerateWeeklyPlanButton(ButtonEntity):
    """Button to generate the weekly training plan."""

    _attr_has_entity_name = True
    _attr_name = "Generate weekly plan"
    _attr_icon = "mdi:calendar-refresh"
    _attr_translation_key = "generate_weekly_plan"

    def __init__(self, entry: ConfigEntry, coordinator: WeeklyTrainingCoordinator) -> None:
        self._entry = entry
        self._coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_generate_plan"
        self._attr_device_info = device_info_from_entry(entry)

    async def async_press(self) -> None:
        # Generate for currently selected week/day from overrides.
        await self._coordinator.async_generate_for_day()
