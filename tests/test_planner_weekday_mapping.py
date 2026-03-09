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
    ex = lambda name, tags: {"id": name.lower().replace(" ", "_"), "name": name, "tags": tags, "equipment": ["barbell"]}
    return {
        "exercises": [
            ex("Back Squat", ["squat", "leg"]),
            ex("Deadlift", ["deadlift", "hinge"]),
            ex("Bench Press", ["bench", "push", "press"]),
            ex("Barbell Row", ["row", "pull"]),
            ex("Dumbbell Shoulder Press", ["shoulders", "press", "push"]),
            ex("Plank", ["core"]),
            ex("Hammer Curl", ["arms"]),
            ex("Bulgarian Split Squat", ["lunge", "single_leg", "leg"]),
        ]
    }


def test_generate_session_maps_weekdays_to_correct_dates() -> None:
    prof = _base_profile()
    lib = _base_library()
    ws = date.fromisoformat("2026-03-09")  # Monday

    expected = {
        0: "2026-03-09",
        1: "2026-03-10",
        2: "2026-03-11",
        3: "2026-03-12",
        4: "2026-03-13",
        5: "2026-03-14",
        6: "2026-03-15",
    }

    for weekday, iso_date in expected.items():
        plan = generate_session(
            profile=prof,
            library=lib,
            overrides={"planning_mode": "auto"},
            week_start_day=ws,
            weekday=weekday,
            existing_plan=None,
        )
        workouts = plan.get("workouts") or []
        assert len(workouts) == 1
        assert workouts[0]["weekday"] == weekday
        assert workouts[0]["date"] == iso_date


def test_generate_session_replaces_existing_workout_for_same_date_only() -> None:
    prof = _base_profile()
    lib = _base_library()
    ws = date.fromisoformat("2026-03-09")

    plan = generate_session(
        profile=prof,
        library=lib,
        overrides={"planning_mode": "auto"},
        week_start_day=ws,
        weekday=2,
        existing_plan=None,
    )
    plan = generate_session(
        profile=prof,
        library=lib,
        overrides={"planning_mode": "manual", "session_overrides": {"b_lower": "Bulgarian Split Squat"}},
        week_start_day=ws,
        weekday=2,
        existing_plan=plan,
    )
    plan = generate_session(
        profile=prof,
        library=lib,
        overrides={"planning_mode": "auto"},
        week_start_day=ws,
        weekday=4,
        existing_plan=plan,
    )

    workouts = sorted(plan.get("workouts") or [], key=lambda w: w["date"])
    assert [w["date"] for w in workouts] == ["2026-03-11", "2026-03-13"]
    assert len([w for w in workouts if w["date"] == "2026-03-11"]) == 1
    assert len([w for w in workouts if w["date"] == "2026-03-13"]) == 1
