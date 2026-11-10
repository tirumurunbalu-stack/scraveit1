#!/bin/bash
# Redeploys, ONE function at a time, every function whose live copy still runs on a full CPU, so it picks up
# the CPU share lightCpu() in src/index.ts gives it. (Changing CPU in place fails on older functions because
# their container images were removed by the 1-day gcf-artifacts cleanup policy.)
# Tests and build run once up front; each deploy then skips the predeploy step. Safe to stop (Ctrl+C) and
# re-run: functions already on their small CPU are skipped. --non-interactive means a deploy can never delete a function.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
P=savrivo-app
R=asia-south1
npm --prefix functions run typecheck && npm --prefix functions test && npm --prefix functions run build || { echo "Tests or build failed; nothing deployed."; exit 1; }
CFG="$ROOT/firebase.redeploy-light.json"
python3 -c 'import json; c=json.load(open("firebase.json")); f=c["functions"]; f.pop("predeploy",None); json.dump({"functions":f},open("firebase.redeploy-light.json","w"))'
trap 'rm -f "$CFG"' EXIT
FUNCS="
createOrder
createCodOrder
getCheckoutConfiguration
getPlatformConfiguration
updateOrderStatus
claimRiderOrder
dispatchOfferTimeout
onDispatchClaimWritten
onCallWritten
onChatMessageCreated
declineRiderOrder
markRiderArrivedRestaurant
recoverDeliveryOtp
registerPushToken
accountParentRequest
accountParentRespond
accountParentRevoke
accountSetBirthDate
applyCustomerReferral
approveRestaurantApplication
attachPackedPhoto
callIceServers
callRang
chatAddFriend
chatCrave
chatIou
chatMarkRead
chatNewCode
chatParentRequest
chatParentRespond
chatParentRevoke
chatReport
chatRespond
chatSetEatingShare
chatSetPrivacy
chatSetUsername
chatSetup
chatTasteMatch
chatUnsend
dineInBookTable
dineInCancelBooking
dineInOpenTable
dineInPlaceRound
dineInRespondBooking
dineInStaff
dineInTableRequest
exportPlatformDataWorkbook
exportTaxPack
getAdminAnalytics
getAdminDashboard
getAdminRiderRewardsDashboard
getAdminToday
getCityBreakEven
getCityEconomics
getCustomerWallet
getEconomicsControl
getFinanceStatement
getLiveRestaurantAgreement
getPayoutAutomationStatus
getRestaurantAgreement
getRestaurantApplicationReview
getRestaurantMealPlans
getRestaurantOfferPerformance
getRestaurantOffers
getRestaurantSettlementSummary
getRiderFinancialSummary
getRiderIdentityReviewCall
getRiderReferralOverview
getRiderRewardsDashboard
getStorePayoutsDue
listCashbackCampaigns
listCityOperatingCosts
listCustomerReferrals
parentPayCancel
parentPayRequest
parentPayRespond
phonePeWebhook
previewWeeklyPayouts
recordCodRemittance
recordRestaurantSettlement
recordRiderPanCheck
recordRiderPayout
requestRestaurantApplicationChanges
resolveChatReport
resolveRefundTdsReversal
resolveRiderFaceReviewCall
reviewCustomerReferral
reviewRestaurantOffer
reviewRiderReferral
saveMealPlan
saveRestaurantOffer
setRestaurantAgreementTerms
setRiderTaxClassification
signLiveRestaurantAgreement
signRestaurantAgreement
simulateEconomicsGuarantee
simulateEconomicsOffer
simulateRiderReferral
submitRiderFaceCheckCall
subscribeMealPlan
unregisterPushToken
updateEconomicsControl
updateMealSubscription
updateRiderRewardSettingsPolicy
upsertCashbackCampaign
upsertCityOperatingCost
upsertGrowthBudget
upsertPromotionPolicy
upsertRiderRewardCampaignPolicy
verifyRiderAadhaarQrCall
verifyRiderLoginFaceCall
"
n=0; total=$(echo "$FUNCS" | grep -c .)
for fn in $FUNCS; do
  n=$((n+1))
  svc=$(echo "$fn" | tr '[:upper:]' '[:lower:]')
  state=$(gcloud run services describe "$svc" --region "$R" --project "$P" --format='value(spec.template.spec.containers[0].resources.limits.cpu,status.conditions[0].status)' 2>/dev/null)
  if [[ "$state" != 1$'\t'* && "$state" != 1000m$'\t'* && "$state" == *$'\t'True ]]; then echo "[$n/$total] $fn already done"; continue; fi
  echo "[$n/$total] deploying $fn ..."
  if firebase deploy --non-interactive --config "$CFG" --only "functions:$fn" --project "$P" 2>&1 | grep -q "Deploy complete"; then
    echo "[$n/$total] $fn ok"
  else
    echo "[$n/$total] $fn FAILED (re-run this script later to retry)"
  fi
done
echo "Done."
