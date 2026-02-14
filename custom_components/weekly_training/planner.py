"""Weekly plan generator.

This integration treats each ISO week as a blank canvas.
You generate sessions day-by-day and store them under that week.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from homeassistant.util import dt as dt_util


def _week_start(day_value: date) -> date:
    return day_value - timedelta(days=day_value.weekday())


def _iso_week_number(day_value: date) -> int:
    return int(day_value.isocalendar().week)


def _effective_today_local() -> date:
    """Match the UI rollover rule: new week starts Monday 01:00 (local time)."""
    now = dt_util.as_local(dt_util.utcnow())
    today = now.date()
    if now.weekday() == 0 and now.hour < 1:
        today = today - timedelta(days=1)
    return today


def _csv_set(raw: str) -> set[str]:
    return {part.strip().lower() for part in str(raw or "").split(",") if part.strip()}


@dataclass(frozen=True, slots=True)
class PickContext:
    equipment: set[str]
    preferred: set[str]
    disabled: set[str]


def _matches_preferences(ex: dict[str, Any], ctx: PickContext) -> bool:
    name = str(ex.get("name") or "").strip().lower()
    if name and name in ctx.disabled:
        return False
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


def _slot_for_weekday(weekday: int) -> str:
    # A early week, B mid-week, C end-week
    if weekday <= 1:
        return "A"
    if weekday <= 3:
        return "B"
    return "C"

def _render_markdown(*, week_number: int, week_start: str, plan: dict[str, Any]) -> str:
    workouts = plan.get("workouts", [])
    if not isinstance(workouts, list):
        workouts = []
    workouts_sorted = sorted(
        [w for w in workouts if isinstance(w, dict)],
        key=lambda w: str(w.get("date") or ""),
    )
    units = str((plan.get("profile") or {}).get("units") or "kg")

    lines: list[str] = []
    lines.append(f"# Weekly Training Plan (ISO week {week_number})")
    lines.append(f"- Week start: {week_start}")
    lines.append("")
    if not workouts_sorted:
        lines.append("_No sessions generated yet._")
        return "\n".join(lines).strip()

    for w in workouts_sorted:
        name = str(w.get("name") or "Session")
        date_iso = str(w.get("date") or "")
        lines.append(f"## {name} ({date_iso})")
        items = w.get("items", [])
        if not isinstance(items, list):
            items = []
        for item in items:
            if not isinstance(item, dict):
                continue
            ex = str(item.get("exercise") or "")
            sr = str(item.get("sets_reps") or "")
            load = item.get("suggested_load")
            if load:
                lines.append(f"- {ex}: {sr} @ ~{load:g}{units}")
            else:
                lines.append(f"- {ex}: {sr}")
        lines.append("")
    return "\n".join(lines).strip()

def generate_session(
    *,
    profile: dict[str, Any],
    library: dict[str, Any],
    overrides: dict[str, Any],
    week_start_day: date,
    weekday: int,
    existing_plan: dict[str, Any] | None,
) -> dict[str, Any]:
    """Generate one day's full-body session and merge into the weekly plan."""
    week_number = _iso_week_number(week_start_day)
    session_date = week_start_day + timedelta(days=int(weekday))
    session_date_iso = session_date.isoformat()

    overrides = overrides or {}
    planning_mode = str(overrides.get("planning_mode") or "auto").lower()
    intensity = str(overrides.get("intensity") or "normal").lower()
    prog_cfg = overrides.get("progression") if isinstance(overrides.get("progression"), dict) else {}
    prog_enabled = bool(prog_cfg.get("enabled")) if isinstance(prog_cfg.get("enabled"), bool) else True
    try:
        prog_step_pct = float(prog_cfg.get("step_pct")) if prog_cfg.get("step_pct") is not None else 2.5
    except Exception:  # noqa: BLE001
        prog_step_pct = 2.5
    session_overrides = overrides.get("session_overrides") if isinstance(overrides.get("session_overrides"), dict) else {}
    if not isinstance(session_overrides, dict):
        session_overrides = {}

    gender = str(profile.get("gender") or "male").lower()
    duration = int(profile.get("duration_minutes") or 45)
    preferred = _csv_set(profile.get("preferred_exercises") or "")
    equipment = _csv_set(profile.get("equipment") or "")
    disabled = set()
    dis = overrides.get("exercise_config") if isinstance(overrides.get("exercise_config"), dict) else None
    # Backwards/compat: allow disabled_exercises at top-level of overrides too.
    disabled_raw = None
    if isinstance(dis, dict):
        disabled_raw = dis.get("disabled_exercises")
    if disabled_raw is None:
        disabled_raw = overrides.get("disabled_exercises")
    if isinstance(disabled_raw, list):
        disabled = {str(n or "").strip().lower() for n in disabled_raw if str(n or "").strip()}
    units = str(profile.get("units") or "kg").lower()
    maxes = profile.get("maxes") if isinstance(profile.get("maxes"), dict) else {}
    max_sq = float(maxes.get("squat") or 0)
    max_dl = float(maxes.get("deadlift") or 0)
    max_bp = float(maxes.get("bench") or 0)
    ctx = PickContext(equipment=equipment, preferred=preferred, disabled=disabled)

    # Rep ranges: keep simple, slight variation by gender purely as defaults.
    if intensity == "easy":
        main_reps = "3 x 5" if gender == "male" else "3 x 6"
        accessory_reps = "2 x 12"
    elif intensity == "hard":
        main_reps = "4 x 5" if gender == "male" else "4 x 6"
        accessory_reps = "3 x 10"
    else:
        main_reps = "3 x 5" if gender == "male" else "3 x 6"
        accessory_reps = "3 x 10"
    core_reps = "3 x 12"

    # Index exercises by name to allow manual selection by name.
    exercises = library.get("exercises", [])
    if not isinstance(exercises, list):
        exercises = []
    by_name = {str(ex.get("name") or ""): ex for ex in exercises if isinstance(ex, dict) and str(ex.get("name") or "")}

    def tags_for(ex_name: str) -> set[str]:
        ex = by_name.get(ex_name)
        if not isinstance(ex, dict):
            return set()
        return {str(t).strip().lower() for t in (ex.get("tags") or []) if str(t).strip()}

    # Determine lower_family across the week so SQ and DL don't both appear.
    lower_family = ""
    if isinstance(existing_plan, dict):
        meta = existing_plan.get("meta")
        if isinstance(meta, dict):
            lower_family = str(meta.get("lower_family") or "")
    if not lower_family:
        # Derive from manual "lower" picks first (for this week's templates).
        manual_lower = [
            str(session_overrides.get(k) or "").strip()
            for k in ("a_lower", "b_lower", "c_lower")
            if str(session_overrides.get(k) or "").strip()
        ]
        for ex_name in manual_lower:
            t = tags_for(ex_name)
            if "squat" in t:
                lower_family = "squat"
                break
            if "deadlift" in t or "hinge" in t:
                lower_family = "deadlift"
                break
    if not lower_family:
        if "squat" in preferred:
            lower_family = "squat"
        elif "deadlift" in preferred or "hinge" in preferred:
            lower_family = "deadlift"
    if not lower_family:
        lower_family = "squat"

    def _manual_or_pick(
        slot_key: str,
        *,
        tags_any: set[str],
        fallback_tags_any: set[str],
        disallow_tags: set[str] | None = None,
    ) -> dict[str, Any]:
        chosen = str(session_overrides.get(slot_key) or "").strip()
        if planning_mode == "manual" and chosen and chosen in by_name:
            if str(chosen).strip().lower() in disabled:
                chosen = ""
            t = tags_for(chosen)
            if disallow_tags and not t.isdisjoint(disallow_tags):
                pass
            else:
                ex = by_name.get(chosen)
                if isinstance(ex, dict):
                    return ex
        return _pick_one(library, tags_any=tags_any, ctx=ctx, fallback_tags_any=fallback_tags_any)

    disallow_deadlift = {"deadlift", "hinge"}
    disallow_squat = {"squat"}

    slot = _slot_for_weekday(int(weekday))
    slot_key = slot.lower()

    # Lower: A/B are main lower, C is more single-leg by default.
    if slot == "C":
        lower = _manual_or_pick(f"{slot_key}_lower", tags_any={"lunge", "single_leg"}, fallback_tags_any={"leg"})
    else:
        if lower_family == "squat":
            lower = _manual_or_pick(
                f"{slot_key}_lower",
                tags_any={"squat"},
                fallback_tags_any={"leg"},
                disallow_tags=disallow_deadlift,
            )
        else:
            lower = _manual_or_pick(
                f"{slot_key}_lower",
                tags_any={"deadlift", "hinge"},
                fallback_tags_any={"hinge"},
                disallow_tags=disallow_squat,
            )

    push = _manual_or_pick(f"{slot_key}_push", tags_any={"bench", "push", "press"}, fallback_tags_any={"push"})
    pull = _manual_or_pick(f"{slot_key}_pull", tags_any={"row", "pull", "pullup"}, fallback_tags_any={"pull"})

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
        if intensity == "easy":
            main_pct = 0.65
        elif intensity == "hard":
            main_pct = 0.80
        else:
            main_pct = 0.75

        # Apply progression based on week offset from the current week (UI-aligned).
        if prog_enabled and prog_step_pct:
            try:
                current_monday = _week_start(_effective_today_local())
                offset_weeks = int(round((week_start_day - current_monday).days / 7))
                factor = 1.0 + (float(prog_step_pct) / 100.0) * float(offset_weeks)
                # Clamp to avoid nonsense suggestions.
                factor = max(0.85, min(1.20, factor))
                main_pct = main_pct * factor
            except Exception:  # noqa: BLE001
                pass
        # Simple heuristics. In real life you'd track more lifts.
        if "squat" in name:
            base = max_sq
            if "front squat" in name:
                base = max_sq * 0.85
            return _round_load(base * main_pct) if base else None
        if "deadlift" in name:
            base = max_dl
            if "romanian" in name:
                base = max_dl * 0.65
            return _round_load(base * main_pct) if base else None
        if "bench" in name:
            base = max_bp
            return _round_load(base * main_pct) if base else None
        if "overhead press" in name or "press" == name:
            # If no OHP 1RM exists, approximate from bench.
            base = max_bp * 0.65 if max_bp else 0
            return _round_load(base * main_pct) if base else None
        return None

    def _item(kind: str, exercise: str, sets_reps: str) -> dict[str, Any]:
        item: dict[str, Any] = {"type": kind, "exercise": exercise, "sets_reps": sets_reps}
        load = _suggested_load(exercise, sets_reps, kind)
        if load is not None and load > 0:
            item["suggested_load"] = load
            item["units"] = units
        return item

    items = [
        _item("main_lower", str(lower.get("name") or ""), main_reps),
        _item("main_push", str(push.get("name") or ""), main_reps),
        _item("main_pull", str(pull.get("name") or ""), main_reps),
        _item("accessory", str(accessory.get("name") or ""), accessory_reps),
        _item("core", str(core.get("name") or ""), core_reps),
    ]
    if extra_accessory:
        items.insert(4, _item("accessory_2", str(extra_accessory.get("name") or ""), accessory_reps))

    workout = {
        "name": f"Full Body {slot}",
        "date": session_date_iso,
        "weekday": int(weekday),
        "intensity": intensity,
        "progression": {"enabled": prog_enabled, "step_pct": prog_step_pct},
        "items": items,
    }

    plan = dict(existing_plan or {})
    plan["week_number"] = week_number
    plan["week_start"] = week_start_day.isoformat()
    plan["generated_at"] = dt_util.utcnow().isoformat()
    plan["profile"] = {"gender": gender, "duration_minutes": duration, "units": units}
    plan["meta"] = {"planning_mode": planning_mode, "lower_family": lower_family}

    workouts = plan.get("workouts")
    if not isinstance(workouts, list):
        workouts = []
    # Replace existing workout for this date if present
    workouts = [w for w in workouts if not (isinstance(w, dict) and str(w.get("date") or "") == session_date_iso)]
    workouts.append(workout)
    plan["workouts"] = workouts
    plan["markdown"] = _render_markdown(week_number=week_number, week_start=week_start_day.isoformat(), plan=plan)
    return plan
