#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"

echo "[1/6] Python syntax"
export PYTHONPYCACHEPREFIX="${repo_root}/.pycache"
mkdir -p "${PYTHONPYCACHEPREFIX}"
python3 -m compileall -q custom_components scripts

echo "[2/6] Basic structure checks"
test -f hacs.json
test -f custom_components/weekly_training/manifest.json
test -f custom_components/weekly_training/strings.json
test -f custom_components/weekly_training/translations/en.json
test -f icon.png
test -f logo.png
test -f dark_icon.png
test -f dark_logo.png

echo "[3/6] Optional ruff"
if command -v ruff >/dev/null 2>&1; then
  ruff check custom_components scripts
else
  echo "ruff not installed (ok). Install with: pip install -r requirements-dev.txt"
fi

echo "[4/6] Manifest sanity"
python3 - <<'PY'
import json
from pathlib import Path

manifest = json.loads(Path("custom_components/weekly_training/manifest.json").read_text(encoding="utf-8"))
assert manifest.get("domain") == "weekly_training", "manifest domain mismatch"
assert str(manifest.get("version","")).strip(), "manifest version missing"
print("manifest ok:", manifest["version"])
PY

echo "[5/6] Optional hassfest (docker)"
if command -v docker >/dev/null 2>&1; then
  # Lightweight hassfest run
  docker run --rm -v "${repo_root}:/github/workspace" -w /github/workspace ghcr.io/home-assistant/hassfest:stable
else
  echo "docker not installed; skipping hassfest (ok)"
fi

echo "[6/6] Done"
