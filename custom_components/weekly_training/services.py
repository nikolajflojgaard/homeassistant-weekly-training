"""Services for Weekly Training."""

from __future__ import annotations

from datetime import date, timedelta

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse

from .const import DOMAIN

SERVICE_GENERATE = "generate_weekly_plan"
SERVICE_GET = "get_weekly_plan"
SERVICE_ADD_PERSON = "add_person"
SERVICE_UPDATE_PERSON = "update_person"
SERVICE_DELETE_PERSON = "delete_person"
SERVICE_LIST_PEOPLE = "list_people"
SERVICE_SYNC_TO_HOUSEHOLD = "sync_to_household_chores"

_ENTRY_SCHEMA = vol.Schema({vol.Required("entry_id"): str})
_PERSON_ID_SCHEMA = vol.Schema({vol.Required("entry_id"): str, vol.Required("person_id"): str})
_ADD_PERSON_SCHEMA = vol.Schema(
    {
        vol.Required("entry_id"): str,
        vol.Required("name"): str,
        vol.Optional("gender", default="male"): str,
        vol.Optional("duration_minutes", default=45): vol.Coerce(int),
        vol.Optional("preferred_exercises", default=""): str,
        vol.Optional("equipment", default="bodyweight, dumbbell, barbell, band"): str,
        vol.Optional("units", default="kg"): str,
        vol.Optional("max_squat", default=100): vol.Coerce(int),
        vol.Optional("max_deadlift", default=120): vol.Coerce(int),
        vol.Optional("max_bench", default=80): vol.Coerce(int),
    }
)
_UPDATE_PERSON_SCHEMA = vol.Schema(
    {
        vol.Required("entry_id"): str,
        vol.Required("person_id"): str,
        vol.Optional("name"): str,
        vol.Optional("gender"): str,
        vol.Optional("duration_minutes"): vol.Coerce(int),
        vol.Optional("preferred_exercises"): str,
        vol.Optional("equipment"): str,
        vol.Optional("units"): str,
        vol.Optional("max_squat"): vol.Coerce(int),
        vol.Optional("max_deadlift"): vol.Coerce(int),
        vol.Optional("max_bench"): vol.Coerce(int),
    }
)
_SYNC_TO_HOUSEHOLD_SCHEMA = vol.Schema(
    {
        vol.Required("entry_id"): str,
        vol.Required("household_entry_id"): str,
        vol.Required("person_id"): str,
        vol.Optional("week_offset", default=0): vol.Coerce(int),
        vol.Optional("overwrite_titles", default=False): bool,
    }
)


async def async_sync_plan_to_household(
    hass: HomeAssistant,
    *,
    entry_id: str,
    household_entry_id: str,
    person_id: str,
    week_offset: int = 0,
    overwrite_titles: bool = False,
) -> ServiceResponse:
    coordinator = hass.data.get(DOMAIN, {}).get(entry_id)
    if coordinator is None:
        return {"ok": False, "error": "entry_not_found"}

    board_store = hass.data.get("household_chores", {}).get("boards", {}).get(household_entry_id)
    if board_store is None:
        return {"ok": False, "error": "household_entry_not_found"}

    state = coordinator.data or await coordinator.store.async_load()
    people = state.get("people", []) if isinstance(state, dict) else []
    person = next((p for p in people if isinstance(p, dict) and str(p.get("id") or "") == person_id), None)
    if not isinstance(person, dict):
        return {"ok": False, "error": "person_not_found"}

    week_start = _week_start_for_offset(week_offset).isoformat()
    plan = coordinator.store.get_plan(state, person_id=person_id, week_start=week_start)
    if not isinstance(plan, dict):
        return {
            "ok": False,
            "error": "plan_not_found",
            "entry_id": entry_id,
            "household_entry_id": household_entry_id,
            "person_id": person_id,
            "week_start": week_start,
        }

    board = await board_store.async_load()
    board_people = board.get("people", []) if isinstance(board, dict) else []
    household_person = next(
        (p for p in board_people if isinstance(p, dict) and str(p.get("name") or "").strip().lower() == str(person.get("name") or "").strip().lower()),
        None,
    )
    if not isinstance(household_person, dict):
        return {"ok": False, "error": "household_person_not_found", "person_name": person.get("name")}
    household_person_id = str(household_person.get("id") or "")

    workouts = plan.get("workouts", []) if isinstance(plan.get("workouts"), list) else []
    tasks = board.get("tasks", []) if isinstance(board.get("tasks"), list) else []
    prefix = f"wt_{entry_id}_{person_id}_"

    kept_tasks = []
    for task in tasks:
        if not isinstance(task, dict):
            continue
        task_id = str(task.get("id") or "")
        same_week = str(task.get("week_start") or "") == week_start
        is_synced = task_id.startswith(prefix)
        if same_week and is_synced:
            continue
        kept_tasks.append(task)

    by_column: dict[str, list[dict]] = {}
    for task in kept_tasks:
        column = str(task.get("column") or "monday")
        by_column.setdefault(column, []).append(task)

    created = 0
    for workout in workouts:
        if not isinstance(workout, dict):
            continue
        date_iso = str(workout.get("date") or "")
        try:
            day = date.fromisoformat(date_iso)
        except Exception:
            continue
        column = _day_column(day.weekday())
        title = str(workout.get("name") or "Workout").strip() or "Workout"
        task = {
            "id": f"{prefix}{date_iso}",
            "title": title,
            "assignees": [household_person_id],
            "column": column,
            "order": len(by_column.get(column, [])),
            "created_at": str(workout.get("generated_at") or plan.get("generated_at") or ""),
            "end_date": None,
            "template_id": None,
            "fixed": False,
            "span_id": None,
            "span_index": 0,
            "span_total": 0,
            "week_start": week_start,
            "week_number": plan.get("week_number"),
        }
        kept_tasks.append(task)
        by_column.setdefault(column, []).append(task)
        created += 1

    board["tasks"] = kept_tasks
    await board_store.async_save(board)
    return {
        "ok": True,
        "entry_id": entry_id,
        "household_entry_id": household_entry_id,
        "person_id": person_id,
        "person_name": person.get("name"),
        "week_start": week_start,
        "week_number": plan.get("week_number"),
        "synced_workouts": created,
        "overwrite_titles": overwrite_titles,
    }


def _week_start_for_offset(offset: int) -> date:
    from homeassistant.util import dt as dt_util

    now = dt_util.as_local(dt_util.utcnow())
    today = now.date()
    if now.weekday() == 0 and now.hour < 1:
        today = today - timedelta(days=1)
    monday = today - timedelta(days=today.weekday())
    return monday + timedelta(days=int(offset) * 7)


def _day_column(day_index: int) -> str:
    return ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][int(day_index)]


async def async_register(hass: HomeAssistant) -> None:
    async def _coordinator_for_entry(entry_id: str):
        return hass.data.get(DOMAIN, {}).get(entry_id)

    async def _async_generate(call: ServiceCall) -> ServiceResponse:
        entry_id = str(call.data["entry_id"])
        coordinator = await _coordinator_for_entry(entry_id)
        if coordinator is None:
            return {"ok": False, "error": "entry_not_found"}
        person_id = str(call.data.get("person_id") or "").strip()
        week_offset = call.data.get("week_offset")
        weekday = call.data.get("weekday")
        state = await coordinator.async_generate_for_day(
            person_id=person_id or None,
            week_offset=int(week_offset) if week_offset is not None else None,
            weekday=int(weekday) if weekday is not None else None,
        )
        return {"ok": True, "entry_id": entry_id, "state": state}

    async def _async_get(call: ServiceCall) -> ServiceResponse:
        entry_id = str(call.data["entry_id"])
        coordinator = await _coordinator_for_entry(entry_id)
        if coordinator is None:
            return {"ok": False, "error": "entry_not_found"}
        state = coordinator.data or {}
        return {"ok": True, "entry_id": entry_id, "state": state}

    async def _async_list_people(call: ServiceCall) -> ServiceResponse:
        entry_id = str(call.data["entry_id"])
        coordinator = await _coordinator_for_entry(entry_id)
        if coordinator is None:
            return {"ok": False, "error": "entry_not_found"}
        state = await coordinator.store.async_load()
        people = state.get("people", []) if isinstance(state, dict) else []
        return {"ok": True, "entry_id": entry_id, "people": people}

    async def _async_add_person(call: ServiceCall) -> ServiceResponse:
        entry_id = str(call.data["entry_id"])
        coordinator = await _coordinator_for_entry(entry_id)
        if coordinator is None:
            return {"ok": False, "error": "entry_not_found"}
        person = {
            "name": str(call.data["name"]).strip(),
            "gender": str(call.data.get("gender") or "male").lower(),
            "duration_minutes": int(call.data.get("duration_minutes") or 45),
            "preferred_exercises": str(call.data.get("preferred_exercises") or "").strip(),
            "equipment": str(call.data.get("equipment") or "").strip(),
            "units": str(call.data.get("units") or "kg").lower(),
            "maxes": {
                "squat": int(call.data.get("max_squat") or 100),
                "deadlift": int(call.data.get("max_deadlift") or 120),
                "bench": int(call.data.get("max_bench") or 80),
            },
        }
        state = await coordinator.store.async_upsert_person(person)
        await coordinator.async_request_refresh()
        return {"ok": True, "entry_id": entry_id, "people": state.get("people", [])}

    async def _async_update_person(call: ServiceCall) -> ServiceResponse:
        entry_id = str(call.data["entry_id"])
        coordinator = await _coordinator_for_entry(entry_id)
        if coordinator is None:
            return {"ok": False, "error": "entry_not_found"}

        state = await coordinator.store.async_load()
        people = state.get("people", []) if isinstance(state, dict) else []
        person_id = str(call.data["person_id"]).strip()
        person = next((p for p in people if isinstance(p, dict) and str(p.get("id") or "") == person_id), None)
        if not isinstance(person, dict):
            return {"ok": False, "error": "person_not_found"}

        updated = dict(person)
        for key in ("name", "gender", "duration_minutes", "preferred_exercises", "equipment", "units"):
            if key in call.data:
                updated[key] = call.data[key]
        maxes = dict(updated.get("maxes") or {})
        if "max_squat" in call.data:
            maxes["squat"] = int(call.data["max_squat"])
        if "max_deadlift" in call.data:
            maxes["deadlift"] = int(call.data["max_deadlift"])
        if "max_bench" in call.data:
            maxes["bench"] = int(call.data["max_bench"])
        updated["maxes"] = maxes

        next_state = await coordinator.store.async_upsert_person(updated)
        await coordinator.async_request_refresh()
        return {"ok": True, "entry_id": entry_id, "people": next_state.get("people", [])}

    async def _async_delete_person(call: ServiceCall) -> ServiceResponse:
        entry_id = str(call.data["entry_id"])
        coordinator = await _coordinator_for_entry(entry_id)
        if coordinator is None:
            return {"ok": False, "error": "entry_not_found"}
        person_id = str(call.data["person_id"]).strip()
        next_state = await coordinator.store.async_delete_person(person_id)
        await coordinator.async_request_refresh()
        return {"ok": True, "entry_id": entry_id, "people": next_state.get("people", [])}

    async def _async_sync_to_household(call: ServiceCall) -> ServiceResponse:
        entry_id = str(call.data["entry_id"])
        household_entry_id = str(call.data["household_entry_id"])
        person_id = str(call.data["person_id"]).strip()
        week_offset = int(call.data.get("week_offset", 0))
        overwrite_titles = bool(call.data.get("overwrite_titles", False))

        return await async_sync_plan_to_household(
            hass,
            entry_id=entry_id,
            household_entry_id=household_entry_id,
            person_id=person_id,
            week_offset=week_offset,
            overwrite_titles=overwrite_titles,
        )

    if not hass.services.has_service(DOMAIN, SERVICE_GENERATE):
        hass.services.async_register(
            DOMAIN,
            SERVICE_GENERATE,
            _async_generate,
            schema=vol.Schema(
                {
                    vol.Required("entry_id"): str,
                    vol.Optional("person_id"): str,
                    vol.Optional("week_offset"): vol.Coerce(int),
                    vol.Optional("weekday"): vol.Coerce(int),
                }
            ),
            supports_response=SupportsResponse.ONLY,
        )
    if not hass.services.has_service(DOMAIN, SERVICE_GET):
        hass.services.async_register(
            DOMAIN,
            SERVICE_GET,
            _async_get,
            schema=_ENTRY_SCHEMA,
            supports_response=SupportsResponse.ONLY,
        )
    if not hass.services.has_service(DOMAIN, SERVICE_LIST_PEOPLE):
        hass.services.async_register(
            DOMAIN,
            SERVICE_LIST_PEOPLE,
            _async_list_people,
            schema=_ENTRY_SCHEMA,
            supports_response=SupportsResponse.ONLY,
        )
    if not hass.services.has_service(DOMAIN, SERVICE_ADD_PERSON):
        hass.services.async_register(
            DOMAIN,
            SERVICE_ADD_PERSON,
            _async_add_person,
            schema=_ADD_PERSON_SCHEMA,
            supports_response=SupportsResponse.ONLY,
        )
    if not hass.services.has_service(DOMAIN, SERVICE_UPDATE_PERSON):
        hass.services.async_register(
            DOMAIN,
            SERVICE_UPDATE_PERSON,
            _async_update_person,
            schema=_UPDATE_PERSON_SCHEMA,
            supports_response=SupportsResponse.ONLY,
        )
    if not hass.services.has_service(DOMAIN, SERVICE_DELETE_PERSON):
        hass.services.async_register(
            DOMAIN,
            SERVICE_DELETE_PERSON,
            _async_delete_person,
            schema=_PERSON_ID_SCHEMA,
            supports_response=SupportsResponse.ONLY,
        )
    if not hass.services.has_service(DOMAIN, SERVICE_SYNC_TO_HOUSEHOLD):
        hass.services.async_register(
            DOMAIN,
            SERVICE_SYNC_TO_HOUSEHOLD,
            _async_sync_to_household,
            schema=_SYNC_TO_HOUSEHOLD_SCHEMA,
            supports_response=SupportsResponse.ONLY,
        )
