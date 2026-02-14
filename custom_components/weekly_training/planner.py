"""Weekly plan generator."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from homeassistant.util import dt as dt_util


def _week_start(day_value: date) -> date:
    return day_value - timedelta(days=day_value.weekday())


def _iso_week_number(day_value: date) -> int:
    return int(day_value.isocalendar().week)


def _csv_set(raw: str) -> set[str]:
    return {part.strip().lower() for part in str(raw or "").split(",") if part.strip()}


@dataclass(frozen=True, slots=True)
class PickContext:
    equipment: set[str]
    preferred: set[str]


def _matches_preferences(ex: dict[str, Any], ctx: PickContext) -> bool:
    name = str(ex.get("name") or "").strip().lower()
    tags = {str(t).strip().lower() for t in (ex.get("tags") or []) if str(t).strip()}
    equipment = {str(t).strip().lower() for t in (ex.get("equipment") or []) if str(t).strip()}

    if ctx.equipment:
        if equipment and equipment.isdisjoint(ctx.equipment):
            return False

    if not ctx.preferred:
        return True

    # Preferred tokens can match name or tags.
    for token in ctx.preferred:
        if token in name or token in tags:
            return True
    return False


def _pick_one(library: dict[str, Any], *, tags_any: set[str], ctx: PickContext, fallback_tags_any: set[str]) -> dict[str, Any]:
    exercises = library.get("exercises", [])
    if not isinstance(exercises, list):
        exercises = []

    def ok(ex: Any) -> bool:
        if not isinstance(ex, dict):
            return False
        ex_tags = {str(t).strip().lower() for t in (ex.get("tags") or []) if str(t).strip()}
        if tags_any and ex_tags.isdisjoint(tags_any):
            return False
        return _matches_preferences(ex, ctx)

    matches = [ex for ex in exercises if ok(ex)]
    if not matches and fallback_tags_any:
        matches = [ex for ex in exercises if isinstance(ex, dict) and not {str(t).strip().lower() for t in (ex.get("tags") or [])}.isdisjoint(fallback_tags_any)]
    if not matches:
        # Last resort: anything.
        matches = [ex for ex in exercises if isinstance(ex, dict)]

    # Deterministic-ish choice: sort by name
    matches.sort(key=lambda ex: str(ex.get("name") or ""))
    return matches[0] if matches else {"name": "Bodyweight Squat", "tags": ["squat"], "equipment": ["bodyweight"]}


def build_weekly_plan(
    *,
    profile: dict[str, Any],
    library: dict[str, Any],
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a full-body strength plan for the current ISO week.

    Plan structure:
    - 3 sessions: A / B / C (full body)
    - Each session: main lower + main push + main pull + accessory + core
    """
    now_local = dt_util.as_local(dt_util.utcnow()).date()
    monday = _week_start(now_local)
    week_number = _iso_week_number(monday)

    gender = str(profile.get("gender") or "male").lower()
    duration = int(profile.get("duration_minutes") or 45)
    preferred = _csv_set(profile.get("preferred_exercises") or "")
    equipment = _csv_set(profile.get("equipment") or "")
    units = str(profile.get("units") or "kg").lower()
    maxes = profile.get("maxes") if isinstance(profile.get("maxes"), dict) else {}
    max_sq = float(maxes.get("squat") or 0)
    max_dl = float(maxes.get("deadlift") or 0)
    max_bp = float(maxes.get("bench") or 0)
    ctx = PickContext(equipment=equipment, preferred=preferred)

    # Rep ranges: keep simple, slight variation by gender purely as defaults.
    main_reps = "3 x 5" if gender == "male" else "3 x 6"
    accessory_reps = "3 x 10"
    core_reps = "3 x 12"

    overrides = overrides or {}
    planning_mode = str(overrides.get("planning_mode") or "auto").lower()
    session_overrides = overrides.get("session_overrides") if isinstance(overrides.get("session_overrides"), dict) else {}
    if not isinstance(session_overrides, dict):
        session_overrides = {}

    exercises = library.get("exercises", [])
    if not isinstance(exercises, list):
        exercises = []
    by_name = {str(ex.get("name") or ""): ex for ex in exercises if isinstance(ex, dict) and str(ex.get("name") or "")}

    def tags_for(ex_name: str) -> set[str]:
        ex = by_name.get(ex_name)
        if not isinstance(ex, dict):
            return set()
        return {str(t).strip().lower() for t in (ex.get("tags") or []) if str(t).strip()}

    # Rule: if user chooses squat, do not suggest deadlift (and vice versa).
    # Determine chosen "lower family" from manual selections first.
    manual_lower = [
        str(session_overrides.get(k) or "").strip()
        for k in ("a_lower", "b_lower", "c_lower")
        if str(session_overrides.get(k) or "").strip()
    ]
    lower_family = ""
    for ex_name in manual_lower:
        t = tags_for(ex_name)
        if "squat" in t:
            lower_family = "squat"
            break
        if "deadlift" in t or "hinge" in t:
            lower_family = "deadlift"
            break
    # If still not set, infer from preferred tokens.
    if not lower_family:
        if "squat" in preferred:
            lower_family = "squat"
        elif "deadlift" in preferred or "hinge" in preferred:
            lower_family = "deadlift"
    if not lower_family:
        lower_family = "squat"

    def _manual_or_pick(
        slot: str,
        *,
        tags_any: set[str],
        fallback_tags_any: set[str],
        disallow_tags: set[str] | None = None,
    ) -> dict[str, Any]:
        chosen = str(session_overrides.get(slot) or "").strip()
        # Only honor manual choices when planning_mode=manual
        if planning_mode == "manual" and chosen and chosen in by_name:
            t = tags_for(chosen)
            if disallow_tags and not t.isdisjoint(disallow_tags):
                # Conflict with enforced family: ignore manual and auto-pick.
                pass
            else:
                ex = by_name.get(chosen)
                if isinstance(ex, dict) and _matches_preferences(ex, ctx):
                    return ex
                # If it doesn't match equipment/preferences, still honor manual selection.
                if isinstance(ex, dict):
                    return ex
        return _pick_one(library, tags_any=tags_any, ctx=ctx, fallback_tags_any=fallback_tags_any)

    disallow_deadlift = {"deadlift", "hinge"}
    disallow_squat = {"squat"}

    # Lower picks respect lower_family.
    if lower_family == "squat":
        lower_a = _manual_or_pick("a_lower", tags_any={"squat"}, fallback_tags_any={"leg"}, disallow_tags=disallow_deadlift)
        lower_b = _manual_or_pick("b_lower", tags_any={"squat"}, fallback_tags_any={"leg"}, disallow_tags=disallow_deadlift)
        lower_c = _manual_or_pick("c_lower", tags_any={"lunge", "single_leg"}, fallback_tags_any={"leg"}, disallow_tags=disallow_deadlift)
    else:
        lower_a = _manual_or_pick("a_lower", tags_any={"deadlift", "hinge"}, fallback_tags_any={"hinge"}, disallow_tags=disallow_squat)
        lower_b = _manual_or_pick("b_lower", tags_any={"deadlift", "hinge"}, fallback_tags_any={"hinge"}, disallow_tags=disallow_squat)
        lower_c = _manual_or_pick("c_lower", tags_any={"lunge", "single_leg"}, fallback_tags_any={"leg"}, disallow_tags=disallow_squat)

    # Push/pull: manual per session if set, otherwise auto.
    push_a = _manual_or_pick("a_push", tags_any={"bench", "push"}, fallback_tags_any={"push"})
    pull_a = _manual_or_pick("a_pull", tags_any={"row", "pull"}, fallback_tags_any={"pull"})
    push_b = _manual_or_pick("b_push", tags_any={"overhead_press", "press", "push"}, fallback_tags_any={"push"})
    pull_b = _manual_or_pick("b_pull", tags_any={"pullup", "lat", "pull"}, fallback_tags_any={"pull"})
    push_c = _manual_or_pick("c_push", tags_any={"dumbbell_press", "bench", "push"}, fallback_tags_any={"push"})
    pull_c = _manual_or_pick("c_pull", tags_any={"row", "pull"}, fallback_tags_any={"pull"})

    accessory = _pick_one(library, tags_any={"shoulders", "rear_delt"}, ctx=ctx, fallback_tags_any={"shoulders"})
    core = _pick_one(library, tags_any={"core"}, ctx=ctx, fallback_tags_any={"core"})

    # Duration hint: scale number of accessories.
    extra_accessory = None
    if duration >= 60:
        extra_accessory = _pick_one(library, tags_any={"arms"}, ctx=ctx, fallback_tags_any={"arms"})

    def _round_load(value: float) -> float:
        inc = 2.5 if units == "kg" else 5.0
        if value <= 0:
            return 0.0
        return round(value / inc) * inc

    def _suggested_load(exercise_name: str, sets_reps: str, kind: str) -> float | None:
        name = str(exercise_name or "").lower()
        # Simple heuristics. In real life you'd track more lifts.
        if "squat" in name:
            base = max_sq
            if "front squat" in name:
                base = max_sq * 0.85
            return _round_load(base * 0.75) if base else None
        if "deadlift" in name:
            base = max_dl
            if "romanian" in name:
                base = max_dl * 0.65
            return _round_load(base * 0.75) if base else None
        if "bench" in name:
            base = max_bp
            return _round_load(base * 0.75) if base else None
        if "overhead press" in name or "press" == name:
            # If no OHP 1RM exists, approximate from bench.
            base = max_bp * 0.65 if max_bp else 0
            return _round_load(base * 0.75) if base else None
        return None

    def _item(kind: str, exercise: str, sets_reps: str) -> dict[str, Any]:
        item: dict[str, Any] = {"type": kind, "exercise": exercise, "sets_reps": sets_reps}
        load = _suggested_load(exercise, sets_reps, kind)
        if load is not None and load > 0:
            item["suggested_load"] = load
            item["units"] = units
        return item

    def session(name: str, day_offset: int, items: list[dict[str, Any]]) -> dict[str, Any]:
        session_date = (monday + timedelta(days=day_offset)).isoformat()
        return {"name": name, "date": session_date, "items": items}

    a_items = [
        _item("main_lower", lower_a["name"], main_reps),
        _item("main_push", push_a["name"], main_reps),
        _item("main_pull", pull_a["name"], main_reps),
        _item("accessory", accessory["name"], accessory_reps),
        _item("core", core["name"], core_reps),
    ]
    b_items = [
        _item("main_lower", lower_b["name"], main_reps),
        _item("main_push", push_b["name"], main_reps),
        _item("main_pull", pull_b["name"], main_reps),
        _item("accessory", accessory["name"], accessory_reps),
        _item("core", core["name"], core_reps),
    ]
    c_items = [
        _item("main_lower", lower_c["name"], main_reps),
        _item("main_push", push_c["name"], main_reps),
        _item("main_pull", pull_c["name"], main_reps),
        _item("accessory", accessory["name"], accessory_reps),
        _item("core", core["name"], core_reps),
    ]
    if extra_accessory:
        a_items.insert(4, _item("accessory_2", extra_accessory["name"], accessory_reps))
        b_items.insert(4, _item("accessory_2", extra_accessory["name"], accessory_reps))
        c_items.insert(4, _item("accessory_2", extra_accessory["name"], accessory_reps))

    workouts = [
        session("Full Body A", 0, a_items),
        session("Full Body B", 2, b_items),
        session("Full Body C", 4, c_items),
    ]

    # Render markdown for dashboards/notifications.
    lines: list[str] = []
    lines.append(f"# Weekly Training Plan (ISO week {week_number})")
    lines.append("")
    lines.append(f"- Duration target: ~{duration} min")
    lines.append(f"- Gender setting: {gender}")
    if preferred:
        lines.append(f"- Preferred: {', '.join(sorted(preferred))}")
    if equipment:
        lines.append(f"- Equipment: {', '.join(sorted(equipment))}")
    lines.append("")
    for w in workouts:
        lines.append(f"## {w['name']} ({w['date']})")
        for item in w["items"]:
            load = item.get("suggested_load")
            if load:
                lines.append(f"- {item['exercise']}: {item['sets_reps']} @ ~{load:g}{units}")
            else:
                lines.append(f"- {item['exercise']}: {item['sets_reps']}")
        lines.append("")
    markdown = "\n".join(lines).strip()

    return {
        "week_number": week_number,
        "week_start": monday.isoformat(),
        "generated_at": dt_util.utcnow().isoformat(),
        "profile": {"gender": gender, "duration_minutes": duration, "units": units},
        "meta": {
            "planning_mode": planning_mode,
            "lower_family": lower_family
        },
        "workouts": workouts,
        "markdown": markdown,
    }
