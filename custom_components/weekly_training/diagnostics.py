"""Diagnostics support for Weekly Training.

This file is picked up by Home Assistant automatically when present.
"""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import CONF_API_KEY, CONF_HOST, DOMAIN


def _redact(value: Any) -> Any:
    if value is None:
        return None
    raw = str(value)
    if not raw:
        return ""
    if len(raw) <= 4:
        return "***"
    return f"{raw[:2]}***{raw[-2:]}"


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant,
    entry: ConfigEntry,
) -> dict[str, Any]:
    """Return diagnostics for a config entry (with sensitive data redacted)."""
    coordinator = hass.data.get(DOMAIN, {}).get(entry.entry_id)
    data = dict(entry.data)
    data[CONF_API_KEY] = _redact(data.get(CONF_API_KEY))
    options = dict(entry.options)
    if CONF_API_KEY in options:
        options[CONF_API_KEY] = _redact(options.get(CONF_API_KEY))

    payload: dict[str, Any] = {
        "entry": {
            "entry_id": entry.entry_id,
            "title": entry.title,
            "version": entry.version,
            "data": data,
            "options": options,
        },
        "runtime": {
            "host_configured": bool((entry.options.get(CONF_HOST) or entry.data.get(CONF_HOST) or "").strip()),
        },
    }

    if coordinator is not None:
        payload["coordinator"] = {
            "last_update_success": bool(getattr(coordinator, "last_update_success", False)),
            "last_exception": repr(getattr(coordinator, "last_exception", None)),
            "data": getattr(coordinator, "data", None),
        }

    return payload

