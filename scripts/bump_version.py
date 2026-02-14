#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--version", required=True, help="New version, e.g. 0.1.1")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    version = str(args.version).strip()
    if not version or "." not in version:
        raise SystemExit("Invalid --version")

    manifest_path = Path("custom_components/weekly_training/manifest.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["version"] = version
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("Updated manifest version to", version)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

