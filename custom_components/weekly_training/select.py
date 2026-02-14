"""Select platform for Weekly Training."""

from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, SIGNAL_PLAN_UPDATED
from .coordinator import WeeklyTrainingCoordinator
from .entity import device_info_from_entry


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: WeeklyTrainingCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            ActivePersonSelect(entry, coordinator),
            PlanningModeSelect(entry, coordinator),
            SessionExerciseSelect(entry, coordinator, slot="a_lower", name="Session A lower"),
            SessionExerciseSelect(entry, coordinator, slot="a_push", name="Session A push"),
            SessionExerciseSelect(entry, coordinator, slot="a_pull", name="Session A pull"),
            SessionExerciseSelect(entry, coordinator, slot="b_lower", name="Session B lower"),
            SessionExerciseSelect(entry, coordinator, slot="b_push", name="Session B push"),
            SessionExerciseSelect(entry, coordinator, slot="b_pull", name="Session B pull"),
            SessionExerciseSelect(entry, coordinator, slot="c_lower", name="Session C lower"),
            SessionExerciseSelect(entry, coordinator, slot="c_push", name="Session C push"),
            SessionExerciseSelect(entry, coordinator, slot="c_pull", name="Session C pull"),
        ]
    )


class ActivePersonSelect(SelectEntity):
    """Select active person for plan generation."""

    _attr_has_entity_name = True
    _attr_name = "Person"
    _attr_icon = "mdi:account"
    _attr_translation_key = "active_person"

    def __init__(self, entry: ConfigEntry, coordinator: WeeklyTrainingCoordinator) -> None:
        self._entry = entry
        self._coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_active_person"
        self._attr_device_info = device_info_from_entry(entry)
        self._unsub = None
        self._options = []
        self._value = None

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
    def options(self) -> list[str]:
        return list(self._options)

    @property
    def current_option(self) -> str | None:
        return self._value

    async def async_select_option(self, option: str) -> None:
        state = await self._coordinator.store.async_load()
        people = state.get("people", []) if isinstance(state, dict) else []
        person = next((p for p in people if isinstance(p, dict) and str(p.get("name") or "") == option), None)
        if not isinstance(person, dict):
            return
        await self._coordinator.store.async_set_active_person(str(person.get("id") or ""))
        await self._coordinator.async_request_refresh()
        await self._refresh_from_store()
        self.async_write_ha_state()

    async def _refresh_from_store(self) -> None:
        state = await self._coordinator.store.async_load()
        people = state.get("people", []) if isinstance(state, dict) else []
        names = [str(p.get("name") or "").strip() for p in people if isinstance(p, dict) and str(p.get("name") or "").strip()]
        self._options = names
        active_id = str(state.get("active_person_id") or "")
        active = next((p for p in people if isinstance(p, dict) and str(p.get("id") or "") == active_id), None)
        self._value = str(active.get("name") or "") if isinstance(active, dict) else (names[0] if names else None)

    def _handle_updated(self) -> None:
        self.hass.async_create_task(self._async_reload_and_write())

    async def _async_reload_and_write(self) -> None:
        await self._refresh_from_store()
        self.async_write_ha_state()


class PlanningModeSelect(SelectEntity):
    """Auto vs manual per-session selection."""

    _attr_has_entity_name = True
    _attr_name = "Planning mode"
    _attr_icon = "mdi:tune"
    _attr_translation_key = "planning_mode"

    def __init__(self, entry: ConfigEntry, coordinator: WeeklyTrainingCoordinator) -> None:
        self._entry = entry
        self._coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_planning_mode"
        self._attr_device_info = device_info_from_entry(entry)
        self._unsub = None
        self._value = "auto"

    @property
    def options(self) -> list[str]:
        return ["auto", "manual"]

    @property
    def current_option(self) -> str | None:
        return self._value

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

    async def async_select_option(self, option: str) -> None:
        option = str(option or "").lower()
        if option not in {"auto", "manual"}:
            option = "auto"
        await self._coordinator.store.async_set_overrides(planning_mode=option)
        await self._coordinator.async_request_refresh()
        await self._refresh_from_store()
        self.async_write_ha_state()

    async def _refresh_from_store(self) -> None:
        state = await self._coordinator.store.async_load()
        overrides = state.get("overrides", {}) if isinstance(state, dict) else {}
        if isinstance(overrides, dict):
            self._value = str(overrides.get("planning_mode") or "auto").lower()
        else:
            self._value = "auto"

    def _handle_updated(self) -> None:
        self.hass.async_create_task(self._async_reload_and_write())

    async def _async_reload_and_write(self) -> None:
        await self._refresh_from_store()
        self.async_write_ha_state()


class SessionExerciseSelect(SelectEntity):
    """Per-session exercise override (only used when planning_mode=manual)."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:dumbbell"

    def __init__(self, entry: ConfigEntry, coordinator: WeeklyTrainingCoordinator, *, slot: str, name: str) -> None:
        self._entry = entry
        self._coordinator = coordinator
        self._slot = str(slot)
        self._attr_name = name
        self._attr_unique_id = f"{entry.entry_id}_{slot}"
        self._attr_device_info = device_info_from_entry(entry)
        self._unsub = None
        self._value = "Auto"
        self._options: list[str] = ["Auto"]

    @property
    def translation_key(self) -> str | None:
        # Keep translation optional; entity name is descriptive already.
        return None

    @property
    def options(self) -> list[str]:
        return list(self._options)

    @property
    def current_option(self) -> str | None:
        return self._value

    async def async_added_to_hass(self) -> None:
        self._unsub = async_dispatcher_connect(
            self.hass,
            f"{SIGNAL_PLAN_UPDATED}_{self._entry.entry_id}",
            self._handle_updated,
        )
        await self._refresh()

    async def async_will_remove_from_hass(self) -> None:
        if self._unsub:
            self._unsub()
            self._unsub = None

    async def async_select_option(self, option: str) -> None:
        option = str(option or "").strip()
        value = "" if option.lower() == "auto" else option
        await self._coordinator.store.async_set_overrides(session_overrides={self._slot: value})
        await self._coordinator.async_request_refresh()
        await self._refresh()
        self.async_write_ha_state()

    async def _refresh(self) -> None:
        lib = await self._coordinator.library.async_load()
        exercises = lib.get("exercises", [])
        if not isinstance(exercises, list):
            exercises = []

        def tags(ex: dict) -> set[str]:
            return {str(t).strip().lower() for t in (ex.get("tags") or []) if str(t).strip()}

        wanted: set[str]
        if self._slot.endswith("_lower"):
            wanted = {"squat", "deadlift", "hinge", "lunge", "single_leg"}
        elif self._slot.endswith("_push"):
            wanted = {"bench", "push", "press", "overhead_press", "dumbbell_press"}
        else:
            wanted = {"row", "pull", "pullup", "lat"}

        names: list[str] = []
        for ex in exercises:
            if not isinstance(ex, dict):
                continue
            ex_tags = tags(ex)
            if ex_tags.isdisjoint(wanted):
                continue
            n = str(ex.get("name") or "").strip()
            if n:
                names.append(n)
        names = sorted(set(names))
        self._options = ["Auto", *names]

        state = await self._coordinator.store.async_load()
        overrides = state.get("overrides", {}) if isinstance(state, dict) else {}
        session = overrides.get("session_overrides", {}) if isinstance(overrides, dict) else {}
        if isinstance(session, dict):
            v = str(session.get(self._slot) or "").strip()
            self._value = v if v else "Auto"
        else:
            self._value = "Auto"

    def _handle_updated(self) -> None:
        self.hass.async_create_task(self._async_reload_and_write())

    async def _async_reload_and_write(self) -> None:
        await self._refresh()
        self.async_write_ha_state()
