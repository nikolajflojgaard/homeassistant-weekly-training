"""Weekly Training integration."""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_track_time_change
from homeassistant.util import dt as dt_util

from .const import DOMAIN, PLATFORMS
from .coordinator import WeeklyTrainingCoordinator
from .frontend import async_register_frontend
from .services import async_register as async_register_services
from .websocket_api import async_register as async_register_ws

_LOGGER = logging.getLogger(__name__)


def _schedule_week_cleanup(*, hass: HomeAssistant, entry: ConfigEntry, coordinator: WeeklyTrainingCoordinator) -> None:
    """Delete previous week's plans automatically on Monday 01:00 (local time)."""

    async def _run(now) -> None:
        try:
            local_now = dt_util.as_local(now)
            if local_now.weekday() != 0:
                return
            if local_now.hour < 1:
                return
            today = local_now.date()
            monday = today - timedelta(days=today.weekday())
            prev_week_start = (monday - timedelta(days=7)).isoformat()
            # Archive completed workouts before blanking the canvas.
            await coordinator.store.async_archive_week(week_start=prev_week_start)
            await coordinator.store.async_delete_week(week_start=prev_week_start)
            await coordinator.async_request_refresh()
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Weekly cleanup failed for entry_id=%s", entry.entry_id)

    remove = async_track_time_change(hass, _run, hour=1, minute=0, second=0)
    entry.async_on_unload(remove)

async def _async_register_domain_resources(hass: HomeAssistant) -> None:
    """Register domain-wide resources once.

    In some setups, config-entry-only integrations may not get async_setup() called
    the way you expect, so we also call this from async_setup_entry().
    """
    hass.data.setdefault(DOMAIN, {})

    if not hass.data[DOMAIN].get("ws_registered"):
        async_register_ws(hass)
        hass.data[DOMAIN]["ws_registered"] = True

    if not hass.data[DOMAIN].get("services_registered"):
        await async_register_services(hass)
        hass.data[DOMAIN]["services_registered"] = True

    if not hass.data[DOMAIN].get("frontend_registered"):
        await async_register_frontend(hass)
        hass.data[DOMAIN]["frontend_registered"] = True


async def async_setup(hass: HomeAssistant, _config: dict[str, Any]) -> bool:
    """Set up domain-level resources."""
    await _async_register_domain_resources(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up from a config entry."""
    await _async_register_domain_resources(hass)

    coordinator = WeeklyTrainingCoordinator(hass, entry)
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = coordinator
    _schedule_week_cleanup(hass=hass, entry=entry, coordinator=coordinator)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(async_reload_entry))
    _LOGGER.debug("Setup complete for entry_id=%s", entry.entry_id)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    return unload_ok


async def async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Handle options update by reloading."""
    await hass.config_entries.async_reload(entry.entry_id)
