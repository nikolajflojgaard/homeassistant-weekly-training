"""Constants for Weekly Training integration."""

from __future__ import annotations

from homeassistant.const import Platform

DOMAIN = "weekly_training"

PLATFORMS: list[Platform] = [
    Platform.BUTTON,
    Platform.SENSOR,
    Platform.SELECT,
    Platform.NUMBER,
    Platform.TEXT,
]

CONF_NAME = "name"
CONF_GENDER = "gender"
CONF_DURATION_MINUTES = "duration_minutes"
CONF_PREFERRED_EXERCISES = "preferred_exercises"
CONF_EQUIPMENT = "equipment"
CONF_MAX_SQ = "max_squat"
CONF_MAX_DL = "max_deadlift"
CONF_MAX_BP = "max_bench"
CONF_UNITS = "units"

DEFAULT_NAME = "Weekly Training"
DEFAULT_GENDER = "male"
DEFAULT_DURATION_MINUTES = 45
DEFAULT_PREFERRED_EXERCISES = ""
DEFAULT_EQUIPMENT = "bodyweight, dumbbell, barbell, band"
DEFAULT_MAX_SQ = 100
DEFAULT_MAX_DL = 120
DEFAULT_MAX_BP = 80
DEFAULT_UNITS = "kg"

GENDER_CHOICES = ["male", "female"]
UNITS_CHOICES = ["kg", "lb"]

SIGNAL_PLAN_UPDATED = f"{DOMAIN}_plan_updated"
