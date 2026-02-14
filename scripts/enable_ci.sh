#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src_dir="${repo_root}/docs/workflows"
dst_dir="${repo_root}/.github/workflows"

mkdir -p "${dst_dir}"

count=0
for f in "${src_dir}"/*.yml; do
  [ -e "${f}" ] || continue
  cp "${f}" "${dst_dir}/$(basename "${f}")"
  count=$((count + 1))
done

echo "Enabled ${count} workflow(s) in ${dst_dir}"
