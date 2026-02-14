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


def _parse_sets_reps(value: str) -> tuple[int, int]:
    raw = str(value or "").lower().replace("×", "x")
    parts = [p.strip() for p in raw.split("x") if p.strip()]
    if len(parts) != 2:
        return (3, 5)
    try:
        s = int(parts[0])
        r = int(parts[1])
        return (max(1, s), max(1, r))
    except Exception:  # noqa: BLE001
        return (3, 5)


def _format_sets_reps(sets_n: int, reps_n: int) -> str:
    return f"{max(1, int(sets_n))} x {max(1, int(reps_n))}"


def _week_index_from_start(*, start_week_start: date, week_start_day: date, cycle_len: int) -> int:
    if cycle_len <= 0:
        return 0
    delta_weeks = int(round((week_start_day - start_week_start).days / 7))
    # Python modulo handles negatives the way we want for repeating cycles.
    return delta_weeks % cycle_len


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


def _cycle_slot_for_day(
    *,
    start_week_start: date | None,
    week_start_day: date,
    weekday: int,
    training_weekdays: list[int],
) -> str | None:
    """Return A/B/C rotation slot for a cycle day.

    Rotation is based on the *ordered training weekdays* and continues across weeks.
    This means:
    - 3 days/week => A/B/C each week
    - 2 days/week => A/B, then C/A next week, etc.
    """
    if start_week_start is None:
        return None
    if not training_weekdays:
        return None
    if weekday not in training_weekdays:
        return None
    try:
        delta_weeks = int(round((week_start_day - start_week_start).days / 7))
        if delta_weeks < 0:
            return None
        idx_in_week = training_weekdays.index(int(weekday))
        seq = delta_weeks * len(training_weekdays) + idx_in_week
        return ["A", "B", "C"][seq % 3]
    except Exception:  # noqa: BLE001
        return None

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

    cycle_cfg = overrides.get("cycle") if isinstance(overrides.get("cycle"), dict) else {}
    cycle_enabled = bool(cycle_cfg.get("enabled")) if isinstance(cycle_cfg.get("enabled"), bool) else False
    cycle_preset = str(cycle_cfg.get("preset") or "strength").strip().lower()
    if cycle_preset not in {"strength", "hypertrophy", "minimalist"}:
        cycle_preset = "strength"
    try:
        cycle_step_pct = float(cycle_cfg.get("step_pct")) if cycle_cfg.get("step_pct") is not None else 2.5
    except Exception:  # noqa: BLE001
        cycle_step_pct = 2.5
    try:
        deload_pct = float(cycle_cfg.get("deload_pct")) if cycle_cfg.get("deload_pct") is not None else 10.0
    except Exception:  # noqa: BLE001
        deload_pct = 10.0
    try:
        deload_volume = float(cycle_cfg.get("deload_volume")) if cycle_cfg.get("deload_volume") is not None else 0.65
    except Exception:  # noqa: BLE001
        deload_volume = 0.65

    start_week_start_raw = str(cycle_cfg.get("start_week_start") or "").strip()
    start_week_start = None
    if start_week_start_raw:
        try:
            start_week_start = _week_start(date.fromisoformat(start_week_start_raw))
        except Exception:  # noqa: BLE001
            start_week_start = None
    if cycle_enabled and start_week_start is None:
        # If enabled but unset, treat current week as cycle start.
        start_week_start = _week_start(_effective_today_local())

    cycle_len = 4
    cycle_index = 0
    if cycle_enabled and start_week_start is not None:
        cycle_index = _week_index_from_start(start_week_start=start_week_start, week_start_day=week_start_day, cycle_len=cycle_len)
    is_deload = cycle_enabled and cycle_index == 3
    if is_deload:
        # Make deload feel different even if the user doesn't change intensity.
        if intensity == "hard":
            intensity = "normal"

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

    # Rep ranges: keep simple. Cycle presets can nudge volume/intensity.
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

    if cycle_enabled:
        if cycle_preset == "hypertrophy":
            main_reps = "4 x 8" if gender == "male" else "4 x 9"
            accessory_reps = "3 x 12"
            core_reps = "3 x 15"
        elif cycle_preset == "minimalist":
            main_reps = "3 x 5"
            accessory_reps = "2 x 10"
            core_reps = "2 x 12"
        else:
            # strength
            main_reps = "4 x 5" if gender == "male" else "4 x 6"
            accessory_reps = "3 x 8"
            core_reps = "3 x 12"

    if is_deload:
        ms, mr = _parse_sets_reps(main_reps)
        as_, ar = _parse_sets_reps(accessory_reps)
        cs, cr = _parse_sets_reps(core_reps)
        # Reduce volume; keep reps mostly intact, reduce sets.
        ms = max(1, int(round(ms * deload_volume)))
        as_ = max(1, int(round(as_ * deload_volume)))
        cs = max(1, int(round(cs * deload_volume)))
        main_reps = _format_sets_reps(ms, mr)
        accessory_reps = _format_sets_reps(as_, ar)
        core_reps = _format_sets_reps(cs, cr)

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

    # Cycle uses A/B/C rotation across chosen training weekdays.
    training_weekdays: list[int] = []
    if isinstance(cycle_cfg, dict):
        tw = cycle_cfg.get("training_weekdays")
        if isinstance(tw, list):
            cleaned: list[int] = []
            for x in tw:
                try:
                    xi = int(x)
                except Exception:  # noqa: BLE001
                    continue
                if 0 <= xi <= 6 and xi not in cleaned:
                    cleaned.append(xi)
            cleaned.sort()
            training_weekdays = cleaned

    slot = _cycle_slot_for_day(
        start_week_start=start_week_start if cycle_enabled else None,
        week_start_day=week_start_day,
        weekday=int(weekday),
        training_weekdays=training_weekdays,
    ) or _slot_for_weekday(int(weekday))
    slot_key = slot.lower()

    by_name_lc = {str(k or "").strip().lower(): v for k, v in by_name.items() if str(k or "").strip()}

    def _pick_named_or_tags(
        *,
        names: list[str],
        tags_any: set[str],
        fallback_tags_any: set[str],
        disallow_tags: set[str] | None = None,
    ) -> dict[str, Any]:
        # Prefer exact exercise names if available (keeps templates stable).
        for nm in names:
            ex = by_name_lc.get(str(nm or "").strip().lower())
            if not isinstance(ex, dict):
                continue
            ex_name = str(ex.get("name") or "").strip().lower()
            if ex_name and ex_name in disabled:
                continue
            if disallow_tags and not tags_for(str(ex.get("name") or "")).isdisjoint(disallow_tags):
                continue
            if _matches_preferences(ex, ctx):
                return ex
        return _pick_one(library, tags_any=tags_any, ctx=ctx, fallback_tags_any=fallback_tags_any)

    def _apply_deload_sr(sr: str) -> str:
        if not is_deload:
            return sr
        s, r = _parse_sets_reps(sr)
        s = max(1, int(round(s * float(deload_volume))))
        return _format_sets_reps(s, r)

    # Lower: A/B are main lower, C is more single-leg by default.
    use_strength_abc = cycle_enabled and cycle_preset == "strength" and (slot in {"A", "B", "C"}) and (int(weekday) in training_weekdays) and planning_mode != "manual"

    lower = {}
    push = {}
    pull = {}
    accessory = {}
    core = {}
    items_spec: list[tuple[str, dict[str, Any], str]] | None = None

    if use_strength_abc:
        # Strength-ish: A/B/C templates (no squat+deadlift in same session; bench can pair).
        if slot == "A":
            lower = _pick_named_or_tags(names=["Back Squat", "Squat"], tags_any={"squat"}, fallback_tags_any={"leg"}, disallow_tags=disallow_deadlift)
            push = _pick_named_or_tags(names=["Bench Press", "Barbell Bench Press"], tags_any={"bench", "press", "push"}, fallback_tags_any={"push"})
            pull = _pick_named_or_tags(names=["Barbell Row", "Bent-Over Row", "Row"], tags_any={"row"}, fallback_tags_any={"pull"})
            core = _pick_named_or_tags(names=["Hanging Leg Raise", "Leg Raise"], tags_any={"core"}, fallback_tags_any={"core"})
            items_spec = [
                ("main_lower", lower, _apply_deload_sr("4 x 5")),
                ("main_push", push, _apply_deload_sr("4 x 5")),
                ("accessory", pull, _apply_deload_sr("3 x 8")),
                ("core", core, _apply_deload_sr("3 x 10")),
            ]
        elif slot == "B":
            lower = _pick_named_or_tags(names=["Deadlift", "Conventional Deadlift"], tags_any={"deadlift", "hinge"}, fallback_tags_any={"hinge"}, disallow_tags=disallow_squat)
            accessory = _pick_named_or_tags(names=["Dumbbell Shoulder Press", "DB Shoulder Press", "Overhead Press"], tags_any={"shoulders", "press", "push"}, fallback_tags_any={"shoulders"})
            pull = _pick_named_or_tags(names=["Pull-Up", "Pull-ups", "Pull Up", "Chin-Up"], tags_any={"pullup", "pull"}, fallback_tags_any={"pull"})
            core = _pick_named_or_tags(names=["Plank"], tags_any={"core"}, fallback_tags_any={"core"})
            items_spec = [
                ("main_lower", lower, _apply_deload_sr("4 x 4")),
                ("accessory", accessory, _apply_deload_sr("3 x 10")),
                ("accessory_2", pull, _apply_deload_sr("3 x 6")),
                ("core", core, _apply_deload_sr("3 x 45")),
            ]
        else:
            # C
            lower = _pick_named_or_tags(names=["Back Squat", "Squat"], tags_any={"squat"}, fallback_tags_any={"leg"}, disallow_tags=disallow_deadlift)
            push = _pick_named_or_tags(
                names=["Close-Grip Bench Press", "Close Grip Bench Press", "Close-Grip Bench", "Bench Press"],
                tags_any={"bench", "press", "push"},
                fallback_tags_any={"push"},
            )
            pull = _pick_named_or_tags(names=["Dumbbell Row", "DB Row", "Row"], tags_any={"row", "pull"}, fallback_tags_any={"pull"})
            accessory = _pick_named_or_tags(names=["Hammer Curl", "Dumbbell Hammer Curl", "Curl"], tags_any={"arms"}, fallback_tags_any={"arms"})
            core = _pick_named_or_tags(names=["Ab Wheel Rollout", "Ab Wheel", "Rollout"], tags_any={"core"}, fallback_tags_any={"core"})
            items_spec = [
                ("main_lower", lower, _apply_deload_sr("3 x 6")),
                ("main_push", push, _apply_deload_sr("3 x 8")),
                ("accessory", pull, _apply_deload_sr("3 x 10")),
                ("accessory_2", accessory, _apply_deload_sr("3 x 10")),
                ("core", core, _apply_deload_sr("3 x 8")),
            ]
    else:
        # Default generator behavior (auto or manual per-slot picking).
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

        items_spec = [
            ("main_lower", lower, main_reps),
            ("main_push", push, main_reps),
            ("main_pull", pull, main_reps),
            ("accessory", accessory, accessory_reps),
            ("core", core, core_reps),
        ]
        if extra_accessory:
            items_spec.insert(4, ("accessory_2", extra_accessory, accessory_reps))

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

        # Apply 4-week cycle if enabled, otherwise fall back to linear "plan ahead" progression.
        if cycle_enabled:
            try:
                if is_deload:
                    factor = 1.0 - (max(0.0, float(deload_pct)) / 100.0)
                else:
                    # week 1..3: 0, +step, +2step
                    up = float(cycle_step_pct) * float(min(2, max(0, int(cycle_index))))
                    factor = 1.0 + (up / 100.0)
                factor = max(0.80, min(1.25, factor))
                main_pct = main_pct * factor
            except Exception:  # noqa: BLE001
                pass
        elif prog_enabled and prog_step_pct:
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

    # Build item list (template-specific or default).
    items: list[dict[str, Any]] = []
    for kind, ex, sr in (items_spec or []):
        items.append(_item(kind, str((ex or {}).get("name") or ""), sr))

    workout_name = f"Dag {slot}" if (cycle_enabled and int(weekday) in training_weekdays and slot in {"A", "B", "C"}) else f"Full Body {slot}"
    workout = {
        "name": workout_name,
        "date": session_date_iso,
        "weekday": int(weekday),
        "intensity": intensity,
        "progression": {"enabled": prog_enabled, "step_pct": prog_step_pct},
        "cycle": {
            "enabled": cycle_enabled,
            "preset": cycle_preset,
            "week_index": int(cycle_index),  # 0..3
            "is_deload": bool(is_deload),
        },
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
