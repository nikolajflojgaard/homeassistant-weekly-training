"""Websocket API for Weekly Training."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .ws_state import public_state


@websocket_api.websocket_command({vol.Required("type"): "weekly_training/list_entries"})
@websocket_api.async_response
async def ws_list_entries(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    entries = hass.config_entries.async_entries(DOMAIN)
    payload = [{"entry_id": entry.entry_id, "title": entry.title} for entry in entries]
    connection.send_result(msg["id"], {"entries": payload})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/get_state",
        vol.Required("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_get_state(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    entry_id = msg["entry_id"]
    coordinator = hass.data.get(DOMAIN, {}).get(entry_id)
    if coordinator is None:
        connection.send_error(msg["id"], "entry_not_found", f"No entry found for entry_id={entry_id}")
        return
    state = await coordinator.store.async_load()
    connection.send_result(msg["id"], {"entry_id": entry_id, "state": public_state(state)})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/set_active_person",
        vol.Required("entry_id"): str,
        vol.Required("person_id"): str,
    }
)
@websocket_api.async_response
async def ws_set_active_person(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    entry_id = msg["entry_id"]
    coordinator = hass.data.get(DOMAIN, {}).get(entry_id)
    if coordinator is None:
        connection.send_error(msg["id"], "entry_not_found", f"No entry found for entry_id={entry_id}")
        return
    state = await coordinator.store.async_set_active_person(str(msg["person_id"]))
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"entry_id": entry_id, "state": public_state(state)})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/set_overrides",
        vol.Required("entry_id"): str,
        vol.Required("overrides"): dict,
    }
)
@websocket_api.async_response
async def ws_set_overrides(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    entry_id = msg["entry_id"]
    coordinator = hass.data.get(DOMAIN, {}).get(entry_id)
    if coordinator is None:
        connection.send_error(msg["id"], "entry_not_found", f"No entry found for entry_id={entry_id}")
        return
    raw = msg.get("overrides") or {}
    if not isinstance(raw, dict):
        raw = {}
    state = await coordinator.store.async_set_overrides(
        duration_minutes=raw.get("duration_minutes"),
        preferred_exercises=raw.get("preferred_exercises"),
        planning_mode=raw.get("planning_mode"),
        session_overrides=raw.get("session_overrides") if isinstance(raw.get("session_overrides"), dict) else None,
    )
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"entry_id": entry_id, "state": public_state(state)})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/add_person",
        vol.Required("entry_id"): str,
        vol.Required("person"): dict,
    }
)
@websocket_api.async_response
async def ws_add_person(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    entry_id = msg["entry_id"]
    coordinator = hass.data.get(DOMAIN, {}).get(entry_id)
    if coordinator is None:
        connection.send_error(msg["id"], "entry_not_found", f"No entry found for entry_id={entry_id}")
        return
    person = msg.get("person") or {}
    if not isinstance(person, dict):
        person = {}
    state = await coordinator.store.async_upsert_person(person)
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"entry_id": entry_id, "state": public_state(state)})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/delete_person",
        vol.Required("entry_id"): str,
        vol.Required("person_id"): str,
    }
)
@websocket_api.async_response
async def ws_delete_person(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    entry_id = msg["entry_id"]
    coordinator = hass.data.get(DOMAIN, {}).get(entry_id)
    if coordinator is None:
        connection.send_error(msg["id"], "entry_not_found", f"No entry found for entry_id={entry_id}")
        return
    state = await coordinator.store.async_delete_person(str(msg["person_id"]))
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"entry_id": entry_id, "state": public_state(state)})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/get_plan",
        vol.Required("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_get_plan(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    entry_id = msg["entry_id"]
    coordinator = hass.data.get(DOMAIN, {}).get(entry_id)
    if coordinator is None:
        connection.send_error(msg["id"], "entry_not_found", f"No entry found for entry_id={entry_id}")
        return
    state = coordinator.data or {}
    plan = state.get("plan") if isinstance(state, dict) else None
    connection.send_result(msg["id"], {"entry_id": entry_id, "plan": plan or {}})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/generate_plan",
        vol.Required("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_generate_plan(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    entry_id = msg["entry_id"]
    coordinator = hass.data.get(DOMAIN, {}).get(entry_id)
    if coordinator is None:
        connection.send_error(msg["id"], "entry_not_found", f"No entry found for entry_id={entry_id}")
        return
    state = await coordinator.async_generate_plan()
    # Return latest plan for active person
    if isinstance(state, dict):
        active_id = str(state.get("active_person_id") or "")
        plans = state.get("plans", {}) if isinstance(state.get("plans"), dict) else {}
        plan = plans.get(active_id) if active_id else None
    else:
        plan = None
    connection.send_result(msg["id"], {"entry_id": entry_id, "plan": plan or {}})


def async_register(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_list_entries)
    websocket_api.async_register_command(hass, ws_get_state)
    websocket_api.async_register_command(hass, ws_set_active_person)
    websocket_api.async_register_command(hass, ws_set_overrides)
    websocket_api.async_register_command(hass, ws_add_person)
    websocket_api.async_register_command(hass, ws_delete_person)
    websocket_api.async_register_command(hass, ws_get_plan)
    websocket_api.async_register_command(hass, ws_generate_plan)
