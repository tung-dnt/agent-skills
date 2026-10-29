#!/usr/bin/env bash
# Runs hooks/jev.ts (the Jev shadow pilot, see hooks/JEV-SHADOW.md) with bun, or
# with node >= 22.18.0 (strips TypeScript types by default from there). Without
# either, predictions are skipped.
src="${BASH_SOURCE[0]}"
case "$src" in */*) here="$(cd "${src%/*}" && pwd)" ;; *) here="$(pwd)" ;; esac
if command -v bun >/dev/null 2>&1; then exec bun "$here/jev.ts" "$@"; fi
if command -v node >/dev/null 2>&1; then
  IFS=. read -r major minor _ < <(node -p process.versions.node 2>/dev/null)
  if [ "${major:-0}" -gt 22 ] || { [ "${major:-0}" -eq 22 ] && [ "${minor:-0}" -ge 18 ]; }; then
    exec node "$here/jev.ts" "$@"
  fi
fi
echo "jev=skipped reason=no-runtime"
