#!/bin/bash
# Moves every deployed function onto the CPU share lightCpu() in src/index.ts gives it, one service at a time,
# so later firebase deploys keep the same settings. Deletes nothing; only CPU, concurrency (must be 1 below a
# full CPU) and, where needed, max instances change (instances x CPU must stay within the 20 vCPU region quota).
set -u
P=savrivo-app
R=asia-south1
FULL=" maptile deliveryroute ontrackingupdated onrideridentitysourcewritten "
HALF=" cashfreewebhook claimriderorder createcodorder createorder createpaymentintent dispatchoffertimeout getcheckoutconfiguration getplatformconfiguration oncallwritten onchatmessagecreated ondispatchclaimwritten onordercreated onorderupdated updateorderstatus "

gcloud run services list --region "$R" --project "$P" \
  --format='value(metadata.name,spec.template.spec.containers[0].resources.limits.cpu,spec.template.spec.containers[0].resources.limits.memory,spec.template.metadata.annotations["autoscaling.knative.dev/maxScale"])' |
while IFS=$'\t' read -r name cpu mem max; do
  [[ "$FULL" == *" $name "* ]] && continue
  [[ "$cpu" == "1" || "$cpu" == "1000m" ]] || continue
  if [[ "$HALF" == *" $name "* ]]; then
    c=0.5; cap=40
  else
    case "$mem" in
      128Mi) c=0.083; cap=100 ;;
      256Mi) c=0.1666; cap=100 ;;
      512Mi) c=0.3333; cap=60 ;;
      1Gi) c=0.5833; cap=34 ;;
      *) echo "skip $name (memory $mem)"; continue ;;
    esac
  fi
  args=(--cpu "$c" --concurrency 1)
  [[ -z "$max" || "$max" -gt "$cap" ]] && args+=(--max-instances "$cap")
  printf '%-40s cpu %s ... ' "$name" "$c"
  if gcloud run services update "$name" --region "$R" --project "$P" "${args[@]}" --quiet </dev/null >/dev/null 2>&1; then
    echo ok
  else
    echo FAILED
  fi
done
echo "Done."
