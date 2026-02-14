"""Websocket state helpers."""

from __future__ import annotations

from typing import Any


def public_state(state: dict[str, Any], *, runtime: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return a stable public payload for the UI."""
    if not isinstance(state, dict):
        return {}
    runtime = runtime or {}
    return {
        "schema": int(state.get("schema") or 1),
        "people": state.get("people", []),
        "active_person_id": str(state.get("active_person_id") or ""),
        "overrides": state.get("overrides", {}),
        "exercise_config": state.get("exercise_config", {}),
        "plans": state.get("plans", {}),
        "updated_at": str(state.get("updated_at") or ""),
        "runtime": runtime,
    }
