from __future__ import annotations

from datetime import date

from custom_components.weekly_training.planner import generate_session


def _base_profile() -> dict:
    return {
        "gender": "male",
        "duration_minutes": 55,
        "units": "kg",
        "equipment": "barbell,dumbbell,bodyweight,band",
        "preferred_exercises": "",
        "maxes": {"squat": 120, "deadlift": 160, "bench": 100},
    }


def _base_library() -> dict:
    # Minimal library with the names our templates try first.
    ex = lambda name, tags: {"id": name.lower().replace(" ", "_"), "name": name, "tags": tags, "equipment": ["barbell"]}
    return {
        "exercises": [
            ex("Back Squat", ["squat", "leg"]),
            ex("Pause Squat", ["squat", "leg"]),
            ex("Front Squat", ["squat", "leg"]),
            ex("Deadlift", ["deadlift", "hinge"]),
            ex("Bench Press", ["bench", "push", "press"]),
            ex("Close-Grip Bench Press", ["bench", "push", "press"]),
            ex("Barbell Row", ["row", "pull"]),
            ex("Dumbbell Row", ["row", "pull"]),
            ex("Pull-Up", ["pullup", "pull"]),
            ex("Dumbbell Shoulder Press", ["shoulders", "press", "push"]),
            ex("Hanging Leg Raise", ["core"]),
            ex("Ab Wheel Rollout", ["core"]),
            ex("Plank", ["core"]),
            ex("Hammer Curl", ["arms"]),
            ex("Bulgarian Split Squat", ["lunge", "single_leg", "leg"]),
            ex("Romanian Deadlift", ["hinge"]),
        ]
    }


def _cycle_overrides(*, program: str, training_weekdays: list[int], start_week_start: str) -> dict:
    return {
        "planning_mode": "auto",
        "cycle": {
            "enabled": True,
            "preset": "strength",
            "program": program,
            "start_week_start": start_week_start,
            "training_weekdays": training_weekdays,
            "weeks": 4,
            "step_pct": 2.5,
            "deload_pct": 10,
            "deload_volume": 0.65,
        },
    }


def _workout_for_day(plan: dict, iso_date: str) -> dict:
    ws = plan.get("workouts") or []
    for w in ws:
        if isinstance(w, dict) and str(w.get("date") or "") == iso_date:
            return w
    raise AssertionError(f"workout not found for {iso_date}")


def test_full_body_abc_rotates_across_week() -> None:
    prof = _base_profile()
    lib = _base_library()
    ws = date.fromisoformat("2026-02-16")  # Monday
    ov = _cycle_overrides(program="full_body_abc", training_weekdays=[0, 2, 4], start_week_start=ws.isoformat())

    plan = None
    for wd in [0, 2, 4]:
        plan = generate_session(profile=prof, library=lib, overrides=ov, week_start_day=ws, weekday=wd, existing_plan=plan)

    assert plan is not None
    assert _workout_for_day(plan, "2026-02-16")["name"] == "Dag A"
    assert _workout_for_day(plan, "2026-02-18")["name"] == "Dag B"
    assert _workout_for_day(plan, "2026-02-20")["name"] == "Dag C"


def test_upper_lower_4day_names() -> None:
    prof = _base_profile()
    lib = _base_library()
    ws = date.fromisoformat("2026-02-16")
    ov = _cycle_overrides(program="upper_lower_4day", training_weekdays=[0, 1, 3, 4], start_week_start=ws.isoformat())

    plan = None
    for wd in [0, 1, 3, 4]:
        plan = generate_session(profile=prof, library=lib, overrides=ov, week_start_day=ws, weekday=wd, existing_plan=plan)

    assert plan is not None
    assert _workout_for_day(plan, "2026-02-16")["name"] == "Upper"
    assert _workout_for_day(plan, "2026-02-17")["name"] == "Lower (Squat)"
    assert _workout_for_day(plan, "2026-02-19")["name"] == "Upper"
    assert _workout_for_day(plan, "2026-02-20")["name"] == "Lower (Deadlift)"


def test_front_squat_not_auto_selected_for_strength_templates() -> None:
    prof = _base_profile()
    lib = _base_library()
    ws = date.fromisoformat("2026-02-16")
    ov = _cycle_overrides(program="full_body_abc", training_weekdays=[0, 2, 4], start_week_start=ws.isoformat())

    plan = generate_session(profile=prof, library=lib, overrides=ov, week_start_day=ws, weekday=4, existing_plan=None)
    w = _workout_for_day(plan, "2026-02-20")
    items = w.get("items") or []
    lowers = [i for i in items if isinstance(i, dict) and str(i.get("type") or "").startswith("main_lower")]
    assert lowers
    assert all("front squat" not in str(i.get("exercise") or "").lower() for i in lowers)

