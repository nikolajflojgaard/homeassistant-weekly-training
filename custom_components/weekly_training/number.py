"""Number platform for Weekly Training."""

from __future__ import annotations

from homeassistant.components.number import NumberEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DEFAULT_DURATION_MINUTES, DOMAIN, SIGNAL_PLAN_UPDATED
from .coordinator import WeeklyTrainingCoordinator
from .entity import device_info_from_entry


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: WeeklyTrainingCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([SessionDurationNumber(entry, coordinator)])


class SessionDurationNumber(NumberEntity):
    """Override session duration for next generation."""

    _attr_has_entity_name = True
    _attr_name = "Session minutes"
    _attr_icon = "mdi:timer"
    _attr_translation_key = "session_minutes"
    _attr_native_min_value = 20
    _attr_native_max_value = 120
    _attr_native_step = 5
    _attr_native_unit_of_measurement = "min"

    def __init__(self, entry: ConfigEntry, coordinator: WeeklyTrainingCoordinator) -> None:
        self._entry = entry
        self._coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_session_minutes"
        self._attr_device_info = device_info_from_entry(entry)
        self._unsub = None
        self._value = float(DEFAULT_DURATION_MINUTES)

    async def async_added_to_hass(self) -> None:
        self._unsub = async_dispatcher_connect(
            self.hass,
            f"{SIGNAL_PLAN_UPDATED}_{self._entry.entry_id}",
            self._handle_updated,
        )
        await self._refresh_from_store()

    async def async_will_remove_from_hass(self) -> None:
        if self._unsub:
            self._unsub()
            self._unsub = None

    @property
    def native_value(self) -> float:
        return float(self._value)

    async def async_set_native_value(self, value: float) -> None:
        await self._coordinator.store.async_set_overrides(duration_minutes=int(value))
        await self._coordinator.async_request_refresh()
        await self._refresh_from_store()
        self.async_write_ha_state()

    async def _refresh_from_store(self) -> None:
        state = await self._coordinator.store.async_load()
        overrides = state.get("overrides", {}) if isinstance(state, dict) else {}
        if isinstance(overrides, dict) and overrides.get("duration_minutes") is not None:
            self._value = float(int(overrides.get("duration_minutes") or DEFAULT_DURATION_MINUTES))
        else:
            self._value = float(DEFAULT_DURATION_MINUTES)

    def _handle_updated(self) -> None:
        self.hass.async_create_task(self._async_reload_and_write())

    async def _async_reload_and_write(self) -> None:
        await self._refresh_from_store()
        self.async_write_ha_state()

