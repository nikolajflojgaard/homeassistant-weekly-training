from __future__ import annotations

import json
from pathlib import Path


def _read_manifest_version() -> str:
    try:
        manifest_path = Path(__file__).with_name("manifest.json")
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        v = str(data.get("version") or "").strip()
        return v or "0.0.0"
    except Exception:  # noqa: BLE001
        return "0.0.0"


BACKEND_VERSION = _read_manifest_version()

