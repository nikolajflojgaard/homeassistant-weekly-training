"""Weekly Training integration."""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN, PLATFORMS
from .coordinator import WeeklyTrainingCoordinator
from .frontend import async_register_frontend
from .services import async_register as async_register_services
from .websocket_api import async_register as async_register_ws

_LOGGER = logging.getLogger(__name__)

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
