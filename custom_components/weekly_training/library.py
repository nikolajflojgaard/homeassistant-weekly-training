"""Exercise library loader."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class ExerciseLibrary:
    """Loads bundled exercise data from JSON and caches it."""

    def __init__(self) -> None:
        self._cache: dict[str, Any] | None = None

    async def async_load(self) -> dict[str, Any]:
        if self._cache is not None:
            return self._cache

        data_path = Path(__file__).parent / "data" / "exercises.json"
        raw = json.loads(data_path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raw = {}
        raw.setdefault("exercises", [])
        raw.setdefault("tags", {})
        self._cache = raw
        return self._cache

