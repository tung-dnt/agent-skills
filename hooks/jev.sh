#!/usr/bin/env bash
# Runs hooks/jev.mjs (the Jev shadow pilot, see hooks/JEV-SHADOW.md) with node
# or bun, whichever exists. Without either, predictions are skipped.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if command -v node >/dev/null 2>&1; then exec node "$here/jev.mjs" "$@"; fi
if command -v bun >/dev/null 2>&1; then exec bun "$here/jev.mjs" "$@"; fi
echo "jev=skipped reason=no-runtime"
