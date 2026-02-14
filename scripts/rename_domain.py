#!/usr/bin/env python3
"""Rename template domain.

This script is intentionally simple and uses a controlled set of replacements.
Review changes after running.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--old", required=True, help="Old domain (e.g. weekly_training)")
    p.add_argument("--new", required=True, help="New domain (e.g. my_integration)")
    p.add_argument("--name", required=True, help='Integration name (e.g. "My Integration")')
    p.add_argument("--repo", default="", help='Optional GitHub repo "owner/name" to update manifest URLs')
    p.add_argument("--codeowner", default="", help='Optional codeowner, e.g. "@yourhandle"')
    return p.parse_args()


def replace_in_file(path: pathlib.Path, old: str, new: str, old_name: str, new_name: str) -> bool:
    try:
        raw = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return False

    updated = raw.replace(old_name, new_name).replace(old, new)
    if updated == raw:
        return False
    path.write_text(updated, encoding="utf-8")
    return True


def main() -> int:
    args = parse_args()
    repo_root = pathlib.Path(__file__).resolve().parents[1]

    old = args.old.strip()
    new = args.new.strip()
    old_name = "Weekly Training"
    new_name = args.name.strip()
    repo = str(args.repo or "").strip()
    codeowner = str(args.codeowner or "").strip()

    if not old or not new or old == new:
        raise SystemExit("Invalid --old/--new")
    if not re.fullmatch(r"[a-z][a-z0-9_]{2,62}", new):
        raise SystemExit("Invalid --new domain (use lowercase letters, digits, underscore)")
    if not new_name:
        raise SystemExit("Invalid --name")
    if repo and not re.fullmatch(r"[^/\\s]+/[^/\\s]+", repo):
        raise SystemExit('Invalid --repo (expected "owner/name")')

    # 1) Rename folder
    old_dir = repo_root / "custom_components" / old
    new_dir = repo_root / "custom_components" / new
    if not old_dir.exists():
        raise SystemExit(f"Domain folder not found: {old_dir}")
    if old_dir.exists() and not new_dir.exists():
        old_dir.rename(new_dir)

    # 2) Replace contents
    for path in repo_root.rglob("*"):
        if path.is_dir():
            continue
        if ".git/" in str(path):
            continue
        replace_in_file(path, old, new, old_name, new_name)

    # 3) Patch manifest fields if requested
    manifest_path = repo_root / "custom_components" / new / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["domain"] = new
        manifest["name"] = new_name
        if codeowner:
            manifest["codeowners"] = [codeowner]
        if repo:
            manifest["documentation"] = f"https://github.com/{repo}"
            manifest["issue_tracker"] = f"https://github.com/{repo}/issues"
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    # 4) Patch hacs.json if present
    hacs_path = repo_root / "hacs.json"
    if hacs_path.exists():
        hacs = json.loads(hacs_path.read_text(encoding="utf-8"))
        hacs["domains"] = [new]
        if "name" in hacs:
            hacs["name"] = new_name
        hacs_path.write_text(json.dumps(hacs, indent=2) + "\n", encoding="utf-8")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
