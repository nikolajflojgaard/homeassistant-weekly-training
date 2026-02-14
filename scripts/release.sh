#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: ./scripts/release.sh <version>"
  exit 2
fi

version="$1"

./scripts/bump_version.py --version "${version}"
git add custom_components/weekly_training/manifest.json
git commit -m "Release ${version}"
git tag "v${version}"

echo "Created commit + tag v${version}"
echo "Next: git push && git push --tags"

