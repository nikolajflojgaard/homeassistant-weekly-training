"""Websocket API for Weekly Training."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from datetime import timedelta

from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .ws_state import public_state
from .storage import ConflictError


def _runtime_payload() -> dict[str, Any]:
    """Compute UI runtime values (week start + week number + today) with 01:00 rollover."""
    now = dt_util.as_local(dt_util.utcnow())
    today = now.date()
    # Week rollover is intentionally delayed until Monday 01:00 (local time).
    if now.weekday() == 0 and now.hour < 1:
        today = today - timedelta(days=1)
    current_week_start = (today - timedelta(days=today.weekday())).isoformat()
    current_week_number = int(today.isocalendar().week)
    return {
        "today": today.isoformat(),
        "current_week_start": current_week_start,
        "current_week_number": current_week_number,
    }


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/get_library",
        vol.Required("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_get_library(
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
    cfg = state.get("exercise_config") if isinstance(state, dict) else {}
    if not isinstance(cfg, dict):
        cfg = {}

    lib = await coordinator.library.async_load()
    exercises = lib.get("exercises", [])
    if not isinstance(exercises, list):
        exercises = []
    custom = cfg.get("custom_exercises", [])
    if isinstance(custom, list):
        exercises = [*exercises, *[e for e in custom if isinstance(e, dict)]]

    # Payload: enough for UI grouping + future-proofing.
    payload = []
    for ex in exercises:
        if not isinstance(ex, dict):
            continue
        ex_id = str(ex.get("id") or "").strip()
        name = str(ex.get("name") or "").strip()
        if not name:
            continue
        group = ex.get("group")
        tags = ex.get("tags") if isinstance(ex.get("tags"), list) else []
        equipment = ex.get("equipment") if isinstance(ex.get("equipment"), list) else []
        payload.append(
            {
                **({"id": ex_id} if ex_id else {}),
                "name": name,
                **({"group": str(group)} if group else {}),
                "tags": [str(t).strip().lower() for t in tags if str(t).strip()],
                "equipment": [str(t).strip().lower() for t in equipment if str(t).strip()],
            }
        )

    payload.sort(key=lambda e: str(e.get("name") or "").lower())
    connection.send_result(msg["id"], {"entry_id": entry_id, "exercises": payload})


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
    connection.send_result(
        msg["id"],
        {
            "entry_id": entry_id,
            "state": public_state(
                state,
                runtime=_runtime_payload(),
            ),
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/set_workout_completed",
        vol.Required("entry_id"): str,
        vol.Required("person_id"): str,
        vol.Required("week_start"): str,
        vol.Required("date"): str,
        vol.Required("completed"): bool,
        vol.Optional("expected_rev"): vol.Coerce(int),
    }
)
@websocket_api.async_response
async def ws_set_workout_completed(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    entry_id = msg["entry_id"]
    coordinator = hass.data.get(DOMAIN, {}).get(entry_id)
    if coordinator is None:
        connection.send_error(msg["id"], "entry_not_found", f"No entry found for entry_id={entry_id}")
        return
    try:
        state = await coordinator.store.async_set_workout_completed(
            person_id=str(msg["person_id"]),
            week_start=str(msg["week_start"]),
            date_iso=str(msg["date"]),
            completed=bool(msg["completed"]),
            expected_rev=msg.get("expected_rev"),
        )
    except ConflictError as e:
        connection.send_error(msg["id"], "conflict", str(e))
        return
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"entry_id": entry_id, "state": public_state(state, runtime=_runtime_payload())})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/delete_workout",
        vol.Required("entry_id"): str,
        vol.Required("person_id"): str,
        vol.Required("week_start"): str,
        vol.Required("date"): str,
        vol.Optional("expected_rev"): vol.Coerce(int),
    }
)
@websocket_api.async_response
async def ws_delete_workout(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    entry_id = msg["entry_id"]
    coordinator = hass.data.get(DOMAIN, {}).get(entry_id)
    if coordinator is None:
        connection.send_error(msg["id"], "entry_not_found", f"No entry found for entry_id={entry_id}")
        return
    try:
        state = await coordinator.store.async_delete_workout(
            person_id=str(msg["person_id"]),
            week_start=str(msg["week_start"]),
            date_iso=str(msg["date"]),
            expected_rev=msg.get("expected_rev"),
        )
    except ConflictError as e:
        connection.send_error(msg["id"], "conflict", str(e))
        return
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"entry_id": entry_id, "state": public_state(state, runtime=_runtime_payload())})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/delete_workout_series",
        vol.Required("entry_id"): str,
        vol.Required("person_id"): str,
        vol.Required("start_week_start"): str,
        vol.Required("weekday"): vol.Coerce(int),
        vol.Optional("weeks"): vol.Coerce(int),
        vol.Optional("expected_rev"): vol.Coerce(int),
    }
)
@websocket_api.async_response
async def ws_delete_workout_series(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    entry_id = msg["entry_id"]
    coordinator = hass.data.get(DOMAIN, {}).get(entry_id)
    if coordinator is None:
        connection.send_error(msg["id"], "entry_not_found", f"No entry found for entry_id={entry_id}")
        return
    try:
        state = await coordinator.store.async_delete_workout_series(
            person_id=str(msg["person_id"]),
            start_week_start=str(msg["start_week_start"]),
            weekday=int(msg["weekday"]),
            weeks=int(msg.get("weeks") or 4),
            expected_rev=msg.get("expected_rev"),
        )
    except ConflictError as e:
        connection.send_error(msg["id"], "conflict", str(e))
        return
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"entry_id": entry_id, "state": public_state(state, runtime=_runtime_payload())})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/set_active_person",
        vol.Required("entry_id"): str,
        vol.Required("person_id"): str,
        vol.Optional("expected_rev"): vol.Coerce(int),
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
    try:
        state = await coordinator.store.async_set_active_person(str(msg["person_id"]), expected_rev=msg.get("expected_rev"))
    except ConflictError as e:
        connection.send_error(msg["id"], "conflict", str(e))
        return
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"entry_id": entry_id, "state": public_state(state, runtime=_runtime_payload())})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/set_overrides",
        vol.Required("entry_id"): str,
        vol.Required("overrides"): dict,
        vol.Optional("expected_rev"): vol.Coerce(int),
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
    expected_rev = msg.get("expected_rev")
    has_override_fields = any(
        k in raw
        for k in (
            "week_offset",
            "selected_weekday",
            "duration_minutes",
            "preferred_exercises",
            "planning_mode",
            "intensity",
            "progression",
            "cycle",
            "session_overrides",
        )
    )

    # If this is only an exercise config update, avoid bumping rev twice (and avoid conflicts).
    if not has_override_fields and "exercise_config" in raw and isinstance(raw.get("exercise_config"), dict):
        cfg = raw.get("exercise_config") or {}
        try:
            state = await coordinator.store.async_set_exercise_config(
                disabled_exercises=cfg.get("disabled_exercises") if isinstance(cfg.get("disabled_exercises"), list) else None,
                custom_exercises=cfg.get("custom_exercises") if isinstance(cfg.get("custom_exercises"), list) else None,
                expected_rev=expected_rev,
            )
        except ConflictError as e:
            connection.send_error(msg["id"], "conflict", str(e))
            return
    else:
        try:
            state = await coordinator.store.async_set_overrides(
                week_offset=raw.get("week_offset"),
                selected_weekday=raw.get("selected_weekday"),
                duration_minutes=raw.get("duration_minutes"),
                preferred_exercises=raw.get("preferred_exercises"),
                planning_mode=raw.get("planning_mode"),
                intensity=raw.get("intensity"),
                progression=raw.get("progression") if isinstance(raw.get("progression"), dict) else None,
                cycle=raw.get("cycle") if isinstance(raw.get("cycle"), dict) else None,
                session_overrides=raw.get("session_overrides") if isinstance(raw.get("session_overrides"), dict) else None,
                expected_rev=expected_rev,
            )
        except ConflictError as e:
            connection.send_error(msg["id"], "conflict", str(e))
            return
        # Optional: exercise config updates piggybacked here (UI convenience).
        if "exercise_config" in raw and isinstance(raw.get("exercise_config"), dict):
            cfg = raw.get("exercise_config") or {}
            try:
                # Do not re-check expected_rev after we have already saved overrides.
                state = await coordinator.store.async_set_exercise_config(
                    disabled_exercises=cfg.get("disabled_exercises") if isinstance(cfg.get("disabled_exercises"), list) else None,
                    custom_exercises=cfg.get("custom_exercises") if isinstance(cfg.get("custom_exercises"), list) else None,
                    expected_rev=None,
                )
            except ConflictError as e:
                connection.send_error(msg["id"], "conflict", str(e))
                return
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"entry_id": entry_id, "state": public_state(state, runtime=_runtime_payload())})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/add_person",
        vol.Required("entry_id"): str,
        vol.Required("person"): dict,
        vol.Optional("expected_rev"): vol.Coerce(int),
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
    try:
        state = await coordinator.store.async_upsert_person(person, expected_rev=msg.get("expected_rev"))
    except ConflictError as e:
        connection.send_error(msg["id"], "conflict", str(e))
        return
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"entry_id": entry_id, "state": public_state(state, runtime=_runtime_payload())})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/delete_person",
        vol.Required("entry_id"): str,
        vol.Required("person_id"): str,
        vol.Optional("expected_rev"): vol.Coerce(int),
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
    try:
        state = await coordinator.store.async_delete_person(str(msg["person_id"]), expected_rev=msg.get("expected_rev"))
    except ConflictError as e:
        connection.send_error(msg["id"], "conflict", str(e))
        return
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"entry_id": entry_id, "state": public_state(state, runtime=_runtime_payload())})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/set_person_cycle",
        vol.Required("entry_id"): str,
        vol.Required("person_id"): str,
        vol.Optional("cycle"): dict,
        vol.Optional("expected_rev"): vol.Coerce(int),
    }
)
@websocket_api.async_response
async def ws_set_person_cycle(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    entry_id = msg["entry_id"]
    coordinator = hass.data.get(DOMAIN, {}).get(entry_id)
    if coordinator is None:
        connection.send_error(msg["id"], "entry_not_found", f"No entry found for entry_id={entry_id}")
        return
    cycle = msg.get("cycle")
    if cycle is not None and not isinstance(cycle, dict):
        cycle = None
    try:
        state = await coordinator.store.async_set_person_cycle(
            person_id=str(msg["person_id"]),
            cycle=cycle,
            expected_rev=msg.get("expected_rev"),
        )
    except ConflictError as e:
        connection.send_error(msg["id"], "conflict", str(e))
        return
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"entry_id": entry_id, "state": public_state(state, runtime=_runtime_payload())})


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
    state = await coordinator.store.async_load()
    overrides = state.get("overrides", {}) if isinstance(state, dict) else {}
    active_id = str(state.get("active_person_id") or "")
    week_offset = int(overrides.get("week_offset") or 0) if isinstance(overrides, dict) else 0
    week_start_day = coordinator._week_start_for_offset(week_offset).isoformat()  # noqa: SLF001
    plan = coordinator.store.get_plan(state, person_id=active_id, week_start=week_start_day) if active_id else None
    connection.send_result(msg["id"], {"entry_id": entry_id, "week_start": week_start_day, "plan": plan or {}})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/generate_plan",
        vol.Required("entry_id"): str,
        vol.Optional("person_id"): str,
        vol.Optional("expected_rev"): vol.Coerce(int),
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
    person_id = msg.get("person_id")
    if person_id is not None:
        person_id = str(person_id)
    try:
        state = await coordinator.async_generate_for_day(person_id=person_id, expected_rev=msg.get("expected_rev"))
    except ConflictError as e:
        connection.send_error(msg["id"], "conflict", str(e))
        return
    connection.send_result(msg["id"], {"entry_id": entry_id, "state": public_state(state, runtime=_runtime_payload())})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/generate_cycle",
        vol.Required("entry_id"): str,
        vol.Required("person_id"): str,
        vol.Required("start_week_start"): str,  # ISO date for Monday (YYYY-MM-DD)
        vol.Optional("weeks"): vol.Coerce(int),
        vol.Optional("weekdays"): list,  # 0..6 (Mon..Sun)
        vol.Optional("expected_rev"): vol.Coerce(int),
    }
)
@websocket_api.async_response
async def ws_generate_cycle(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Bulk-generate a multi-week cycle for selected weekdays.

    This avoids UI loops of set_overrides+generate calls. It writes all sessions
    and returns updated state once.
    """
    entry_id = msg["entry_id"]
    coordinator = hass.data.get(DOMAIN, {}).get(entry_id)
    if coordinator is None:
        connection.send_error(msg["id"], "entry_not_found", f"No entry found for entry_id={entry_id}")
        return

    person_id = str(msg.get("person_id") or "").strip()
    if not person_id:
        connection.send_error(msg["id"], "invalid", "person_id is required")
        return

    try:
        start_week_start = date.fromisoformat(str(msg.get("start_week_start") or "").strip())
    except Exception:  # noqa: BLE001
        connection.send_error(msg["id"], "invalid", "start_week_start must be an ISO date (YYYY-MM-DD)")
        return

    weeks = int(msg.get("weeks") or 4)
    weeks = max(1, min(12, weeks))
    weekdays_raw = msg.get("weekdays")
    if not isinstance(weekdays_raw, list):
        weekdays_raw = []
    weekdays: list[int] = []
    for x in weekdays_raw:
        try:
            xi = int(x)
        except Exception:  # noqa: BLE001
            continue
        if 0 <= xi <= 6 and xi not in weekdays:
            weekdays.append(xi)
    weekdays.sort()
    if not weekdays:
        connection.send_error(msg["id"], "invalid", "weekdays must include at least one day (0..6)")
        return

    # Optional optimistic concurrency check (single check only; we write multiple times below).
    expected_rev = msg.get("expected_rev")
    if expected_rev is not None:
        state0 = await coordinator.store.async_load()
        try:
            coordinator.store._assert_rev(state0, expected_rev)  # noqa: SLF001
        except ConflictError as e:
            connection.send_error(msg["id"], "conflict", str(e))
            return

    # Coordinator offsets are relative to its effective "current Monday" (Monday 01:00 rule).
    current_monday = coordinator._week_start_for_offset(0)  # noqa: SLF001
    start_offset = int(round((start_week_start - current_monday).days / 7))

    # Generate each planned day across N weeks. Do not pass expected_rev, since rev increments per write.
    try:
        state = None
        for w in range(weeks):
            off = start_offset + w
            for wd in weekdays:
                state = await coordinator.async_generate_for_day(person_id=person_id, week_offset=off, weekday=int(wd), expected_rev=None)
    except ConflictError as e:
        connection.send_error(msg["id"], "conflict", str(e))
        return

    connection.send_result(msg["id"], {"entry_id": entry_id, "state": public_state(state or {}, runtime=_runtime_payload())})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/upsert_workout",
        vol.Required("entry_id"): str,
        vol.Required("person_id"): str,
        vol.Required("week_start"): str,
        vol.Required("workout"): dict,
        vol.Optional("expected_rev"): vol.Coerce(int),
    }
)
@websocket_api.async_response
async def ws_upsert_workout(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    entry_id = msg["entry_id"]
    coordinator = hass.data.get(DOMAIN, {}).get(entry_id)
    if coordinator is None:
        connection.send_error(msg["id"], "entry_not_found", f"No entry found for entry_id={entry_id}")
        return
    workout = msg.get("workout") or {}
    if not isinstance(workout, dict):
        workout = {}
    try:
        state = await coordinator.store.async_upsert_workout(
            person_id=str(msg["person_id"]),
            week_start=str(msg["week_start"]),
            workout=workout,
            expected_rev=msg.get("expected_rev"),
        )
    except ConflictError as e:
        connection.send_error(msg["id"], "conflict", str(e))
        return
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"entry_id": entry_id, "state": public_state(state, runtime=_runtime_payload())})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/get_history",
        vol.Required("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_get_history(
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
    history = coordinator.store.get_history(state)
    connection.send_result(msg["id"], {"entry_id": entry_id, "history": history})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/export_config",
        vol.Required("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_export_config(
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
    config = {
        "people": state.get("people", []),
        "exercise_config": state.get("exercise_config", {}),
    }
    connection.send_result(msg["id"], {"entry_id": entry_id, "config": config})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "weekly_training/import_config",
        vol.Required("entry_id"): str,
        vol.Required("config"): dict,
        vol.Optional("expected_rev"): vol.Coerce(int),
    }
)
@websocket_api.async_response
async def ws_import_config(
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
    try:
        coordinator.store._assert_rev(state, msg.get("expected_rev"))  # noqa: SLF001
    except ConflictError as e:
        connection.send_error(msg["id"], "conflict", str(e))
        return
    cfg = msg.get("config") or {}
    if not isinstance(cfg, dict):
        cfg = {}
    people = cfg.get("people")
    ex_cfg = cfg.get("exercise_config")
    if isinstance(people, list):
        state["people"] = [p for p in people if isinstance(p, dict)]
    if isinstance(ex_cfg, dict):
        state["exercise_config"] = ex_cfg
    # Safety: imported profiles rarely match existing plans. Start fresh.
    state["plans"] = {}
    state["history"] = []
    # Ensure active_person_id is valid.
    ids = {str(p.get("id") or "") for p in (state.get("people") or []) if isinstance(p, dict)}
    if state.get("active_person_id") not in ids:
        state["active_person_id"] = next(iter(ids), "")
    state = await coordinator.store.async_save(state)
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"entry_id": entry_id, "state": public_state(state, runtime=_runtime_payload())})


def async_register(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_list_entries)
    websocket_api.async_register_command(hass, ws_get_state)
    websocket_api.async_register_command(hass, ws_set_active_person)
    websocket_api.async_register_command(hass, ws_set_overrides)
    websocket_api.async_register_command(hass, ws_add_person)
    websocket_api.async_register_command(hass, ws_delete_person)
    websocket_api.async_register_command(hass, ws_set_person_cycle)
    websocket_api.async_register_command(hass, ws_get_plan)
    websocket_api.async_register_command(hass, ws_generate_plan)
    websocket_api.async_register_command(hass, ws_generate_cycle)
    websocket_api.async_register_command(hass, ws_get_library)
    websocket_api.async_register_command(hass, ws_set_workout_completed)
    websocket_api.async_register_command(hass, ws_delete_workout)
    websocket_api.async_register_command(hass, ws_delete_workout_series)
    websocket_api.async_register_command(hass, ws_upsert_workout)
    websocket_api.async_register_command(hass, ws_get_history)
    websocket_api.async_register_command(hass, ws_export_config)
    websocket_api.async_register_command(hass, ws_import_config)
