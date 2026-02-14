# Weekly Training (Home Assistant)

Weekly Training is a HACS-installable custom integration that generates **full body strength sessions** for a selected day, stored per **ISO week**.

It is designed for **tablet dashboards** (responsive down to mobile) and uses a HA-style custom card.

## Features

- People profiles (male/female), per-person defaults and 1RM maxes:
  - Squat (SQ), Deadlift (DL), Bench Press (BP)
- Weekly canvas:
  - Pick `Week X` and a weekday, then generate that day's session
  - New week starts blank (generate again)
- Choose planning mode:
  - `Auto`: let the generator pick exercises
  - `Manual`: pick exercises per session
- Rule enforcement:
  - If you pick Squat, the generator will not suggest Deadlift (and vice versa)
  - Bench can be paired with either
- Uses only basic exercises (no machines) with barbell/dumbbell/band/bodyweight

## Install (HACS)

1. HACS -> Integrations -> three dots -> Custom repositories
2. Add this repo URL and select category `Integration`
3. Install `Weekly Training`
4. Restart Home Assistant
5. Settings -> Devices & Services -> Add Integration -> `Weekly Training`

## Add The Card (Tablet View)

Add a Manual card:

```yaml
type: custom:weekly-training-card
title: Weekly Training
```

If you have multiple entries, set `entry_id`.

Example full view YAML is in `docs/lovelace_tablet_view.yaml`.

## Screenshots

Tablet (2-column layout, Week + day selector):

![Weekly Training Tablet UI](docs/screenshots/ui-tablet.svg)

Mobile (single column):

![Weekly Training Mobile UI](docs/screenshots/ui-mobile.svg)

## Entities You Get

- `button.weekly_training_generate_weekly_plan`
- `sensor.weekly_training_weekly_plan` (attributes include markdown + workouts)
- `select.weekly_training_person`
- `select.weekly_training_planning_mode`
- `number.weekly_training_session_minutes`
- `text.weekly_training_preferred_exercises`
- `select.weekly_training_session_*` (per-session overrides)

## Notes

- Suggested loads are based on your 1RM maxes and rounded to 2.5kg or 5lb increments (simple heuristics).
- This is not medical advice and not a substitute for coaching.
