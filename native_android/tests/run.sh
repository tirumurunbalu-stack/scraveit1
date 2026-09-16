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

"$NODE_EXECUTABLE" "$TEST_DIR/../../firebase/tests/validate-functions-rules.mjs"
"$NODE_EXECUTABLE" "$TEST_DIR/../../firebase/tests/validate-query-indexes-stage3.mjs"
"$NODE_EXECUTABLE" "$TEST_DIR/boot_smoke.js"
"$NODE_EXECUTABLE" "$TEST_DIR/admin_session_recovery.js"
"$NODE_EXECUTABLE" "$TEST_DIR/admin_dashboard_projection.js"
"$NODE_EXECUTABLE" "$TEST_DIR/admin_cod_remittance.js"
"$NODE_EXECUTABLE" "$TEST_DIR/admin_support_alarm_ack.js"
"$NODE_EXECUTABLE" "$TEST_DIR/customer_review_state.js"
"$NODE_EXECUTABLE" "$TEST_DIR/customer_contained_reliability.js"
"$NODE_EXECUTABLE" "$TEST_DIR/customer_search_reliability.js"
"$NODE_EXECUTABLE" "$TEST_DIR/finance_ui_truthfulness.js"
"$NODE_EXECUTABLE" "$TEST_DIR/restaurant_alarm_reconciliation.js"
"$NODE_EXECUTABLE" "$TEST_DIR/handover_status_guard.js"
"$NODE_EXECUTABLE" "$TEST_DIR/staging_sandbox_boundary.js"
"$NODE_EXECUTABLE" "$TEST_DIR/nonprod_build_boundary.js"
exec "$NODE_EXECUTABLE" "$TEST_DIR/validate_premium.js"
