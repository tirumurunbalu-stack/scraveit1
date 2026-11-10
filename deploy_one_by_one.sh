#!/usr/bin/env bash
# Deploys the pending functions one at a time (Cloud Run CPU quota).
# Current list: restaurant staff accounts and the finance reads they unlock. Add WEBSITE=1 to also deploy the partner website.
# Usage:
#   ./deploy_one_by_one.sh                     deploy everything below
#   ./deploy_one_by_one.sh --from createOrder  resume from that function
# A failed deploy is retried once after 60 s; if it fails again the script stops
# and prints the command to resume from there. It never deletes functions: if the
# CLI ever asks to delete anything, answer No.

set -u
cd "$(dirname "$0")" || exit 1

PROJECT=savrivo-app
FUNCTIONS=(
  listRestaurantStaff
  createRestaurantStaff
  updateRestaurantStaff
  removeRestaurantStaff
  getRestaurantSettlementSummary
  getRestaurantTaxStatement
  getRestaurantPayoutReport
  getSponsoredListings
  getTdsCommissionClaims
  submitTdsCommissionClaim
)

from=""
if [ "${1:-}" = "--from" ]; then
  from="${2:-}"
  found=0
  for fn in "${FUNCTIONS[@]}"; do [ "$fn" = "$from" ] && found=1; done
  if [ $found -eq 0 ]; then
    echo "No function named '$from' in the list."
    exit 1
  fi
fi

deploy() {
  firebase deploy --only "functions:$1" --project "$PROJECT"
}

total=${#FUNCTIONS[@]}
i=0
started=0
[ -z "$from" ] && started=1
for fn in "${FUNCTIONS[@]}"; do
  i=$((i + 1))
  if [ $started -eq 0 ]; then
    [ "$fn" = "$from" ] || continue
    started=1
  fi
  echo
  echo "=== [$i/$total] $fn ==="
  if ! deploy "$fn"; then
    echo "Deploy of $fn failed. Waiting 60 s, then trying once more..."
    sleep 60
    if ! deploy "$fn"; then
      echo
      echo "Stopped at $fn. Resume with:"
      echo "  ./deploy_one_by_one.sh --from $fn"
      exit 1
    fi
  fi
  echo "✔ $fn done ($i/$total)"
done

if [ "${WEBSITE:-0}" = "1" ]; then
  echo
  echo "=== Partner website ==="
  if ! (cd website && firebase deploy --only hosting --project "$PROJECT"); then
    echo "Website deploy failed. Run it again with:"
    echo "  cd website && firebase deploy --only hosting --project $PROJECT"
    exit 1
  fi
fi

echo
echo "All $total functions are deployed."
