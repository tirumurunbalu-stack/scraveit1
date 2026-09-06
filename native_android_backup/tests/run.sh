#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -n "${NODE_BIN:-}" ]]; then
  NODE_EXECUTABLE="$NODE_BIN"
elif command -v node >/dev/null 2>&1; then
  NODE_EXECUTABLE="$(command -v node)"
elif [[ -x "/Users/balu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]]; then
  NODE_EXECUTABLE="/Users/balu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
else
  echo "Node.js was not found. Set NODE_BIN to a Node.js 18+ executable." >&2
  exit 2
fi

"$NODE_EXECUTABLE" "$TEST_DIR/boot_smoke.js"
exec "$NODE_EXECUTABLE" "$TEST_DIR/validate_premium.js"
