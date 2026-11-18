import {enforceRiderIdentityRetention, getRiderIdentityReview, IDENTITY_CONSENT_VERSION, PAN_REGISTRY_RESULTS, recordRiderPanCheck as recordRiderPanCheckService, refreshRiderIdentity, syncGigRegistry, verifyRiderAadhaarQr} from "./services/riderIdentity";
import {bookTable, cancelBooking, dineInStaffAction, openTable, placeTableRound, respondToBooking, tableRequest, watchDineIn} from "./services/dineIn";
import {attachSquadToOrder} from "./services/squads";
import * as onboarding from "./services/restaurantOnboarding";
import {readAdminAnalytics} from "./services/adminAnalytics";
import {readServerWarmth, setServerWarmth} from "./services/serverWarmth";
import {requireOwnerClaim, requirePlatformConfigAdminClaim} from "./services/authz";
import {readAdminToday, readStorePayoutsDue} from "./services/adminToday";
import {attachPackedPhoto as attachPackedPhotoToOrder} from "./services/packedPhoto";
import * as mealPlans from "./services/mealPlans";
import * as social from "./services/social";
import * as accountAge from "./services/accountAge";
import * as parentPay from "./services/parentPay";
import * as chatFun from "./services/chatFun";
import * as posts from "./services/posts";
import * as reels from "./services/reels";
import * as clusterOrders from "./services/clusterOrders";
import * as learning from "./services/learning";
import * as partnerTrail from "./services/partnerTrail";
import {alarmAdmins, alertAdmins, applicationAlert, privacyRequestAlert, riderApplicationAlert, supportTicketAlert, watchStuckOrders} from "./services/adminAlerts";
import * as accountDeletion from "./services/accountDeletion";
import * as cartReminderService from "./services/cartReminders";
import * as mealSuggestionService from "./services/mealSuggestions";
import {createHash, randomUUID} from "node:crypto";
import {logger} from "firebase-functions";
import {setGlobalOptions} from "firebase-functions/v2";
import * as databaseTriggers from "firebase-functions/v2/database";
import * as firestoreTriggers from "firebase-functions/v2/firestore";
import * as httpsTriggers from "firebase-functions/v2/https";
import * as scheduler from "firebase-functions/v2/scheduler";
import * as tasks from "firebase-functions/v2/tasks";
import {z} from "zod";
import {auth, db, firestoreDb} from "./admin";
import {DATABASE_INSTANCE, DATABASE_REGION, REGION, ROOT} from "./config";
import {asHttpsError, DomainError} from "./errors";
import type {TransactionLike, WriteBatchLike} from "./firestoreTypes";
import {FieldValue} from "./firestoreTypes";
import {
  deliveryOtpRef,
  dispatchQueueRef,
  orderRef,
  restaurantRef,
  riderJobRef,
  trackingEvidenceRef,
  deliveryCampusRef,
  ordersCollectionRef,
} from "./firestorePaths";
import {lateReminderDue} from "./domain/kitchenLate";
import {buildRiderJobProjection} from "./domain/riderJob";
import {computeNextBroadcastOccurrence, type CustomerBroadcastRepeat} from "./domain/broadcastSchedule";
import {buildPricing, priceCart} from "./domain/order";
import {GOOGLE_WEATHER_API_KEY, refreshRainPricingSignals} from "./services/weather";
import {savePriceQuote} from "./services/priceQuotes";
import {deliveryRouteForOrder, fetchMapTile, parsePoint} from "./services/googleMaps";
import {takeRouteAllowance, watchMapsUsage} from "./services/mapsGuard";
import {AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY} from "./services/faceVerification";
import {CASHFREE_SECRETS, CashfreeGateway, cashfreeCheckoutPage, liveCashfreeConfig} from "./services/cashfree";
import {CALL_SECRETS, callIceServers as iceServersFor, confirmRinging, onCallWritten as handleCallWritten} from "./services/calls";
import {VOICE_AGENT_SECRETS, handleVoiceWebhook, liveDeps as voiceAgentDeps, startConfirmationCall} from "./services/voiceAgent";
import {
  resolveRiderFaceReview,
  resolveRiderFaceReviewSchema,
  riderFaceImageSchema,
  submitRiderFaceCheck,
  verifyRiderLoginFace,
} from "./services/mediaUploads";
import {loadCustomerAddress, loadRestaurantAndMenu, loadServerFees} from "./services/catalog";
import {
  claimOrderSchema,
  adminDashboardQuerySchema,
  financeStatementQuerySchema,
  adminRiderRewardsDashboardQuerySchema,
  checkoutPricingPreviewSchema,
  deliveryPartnerCheckSchema,
  cityEconomicsQuerySchema,
  restaurantOfferSchema,
  restaurantOffersQuerySchema,
  restaurantFreebiesSchema,
  restaurantPairingsSchema,
  dishDescriptionSchema,
  reviewRestaurantOfferSchema,
  simulateGuaranteeSchema,
  simulateOfferSchema,
  updateEconomicsControlSchema,
  breakEvenSchema,
  cashbackCampaignSchema,
  operatingCostSchema,
  upsertGrowthBudgetSchema,
  upsertPromotionSchema,
  createOrderSchema,
  createClusterOrderSchema,
  createCodOrderSchema,
  declineOrderSchema,
  exportPlatformDataWorkbookSchema,
  exportTaxPackSchema,
  setRiderTaxClassificationSchema,
  resolveTdsReversalSchema,
  initiatePaymentSchema,
  markRiderArrivedRestaurantSchema,
  recoverDeliveryOtpSchema,
  recordCodRemittanceSchema,
  recordRestaurantSettlementSchema,
  recordRiderPayoutSchema,
  registerDeviceTokenSchema,
  restaurantSettlementQuerySchema,
  riderRewardsDashboardQuerySchema,
  riderFinancialSummaryQuerySchema,
  transitionOrderSchema,
  unregisterDeviceTokenSchema,
  updateRiderRewardSettingsSchema,
  upsertRiderRewardCampaignSchema,
  validationMessage,
  restaurantAgreementTermsSchema,
  restaurantApplicationChangesSchema,
  restaurantApplicationIdSchema,
  attachPackedPhotoSchema,
  chatSetupSchema,
  accountBirthDateSchema,
  accountParentRequestSchema,
  parentPayRequestSchema,
  chatCraveSchema,
  chatEatingShareSchema,
  chatPairOnlySchema,
  chatIouSchema,
  parentPayIdSchema,
  parentPayRespondSchema,
  chatEmptySchema,
  chatCodeSchema,
  chatUsernameSchema,
  chatHandleSchema,
  chatPrivacySchema,
  chatRespondSchema,
  chatPairSchema,
  chatParentRespondSchema,
  chatChildSchema,
  chatReportSchema,
  createReelSchema,
  reportReelSchema,
  reviewReelSchema,
  chatUnsendSchema,
  resolveChatReportSchema,
  restaurantMealPlansSchema,
  saveMealPlanSchema,
  subscribeMealPlanSchema,
  updateMealSubscriptionSchema,
  signRestaurantAgreementSchema,
  liveRestaurantAgreementSchema,
  signLiveRestaurantAgreementSchema,
  cancelUnpaidOrderSchema,
  checkOrderPaymentSchema,
} from "./schemas";
import {
  exportPlatformDataWorkbook as buildPlatformDataExport,
  purgeExpiredPlatformDataExports,
} from "./services/adminDataExport";
import {
  advanceDispatchOffer,
  beginSequentialDispatch,
  cancelDispatchOffers,
  claimDispatchOffer,
  declineDispatchOffer,
  recoverDispatchClaim,
  recoverExpiredDispatchClaims,
  recoverExhaustedDispatchesForRider,
  recoverExhaustedDispatchesForFinishingRider,
  releaseTripFollowers,
  scheduleDispatchClaimRecovery,
  type Presence,
  deliveryPartnerStatusForRestaurant,
  updateRiderAvailabilityIndex,
} from "./services/dispatch";
import {registerDeviceToken, unregisterDeviceToken} from "./services/deviceTokens";
import {
  checkoutTax,
  loadEconomicsControl,
  markupCheckoutBill,
  planCheckoutEconomics,
  readEconomicsControlForAdmin,
  recordOrderEconomicsOutcome,
  releasePromotionSpend,
  resolveCheckoutPromotion,
  checkoutLines,
  updateEconomicsControlForAdmin,
} from "./services/economics";
import {
  breakEvenForAdmin,
  listOperatingCostsForAdmin,
  upsertOperatingCostForAdmin,
  listGrowthBudgetsForAdmin,
  listRestaurantOffers,
  readCityEconomics,
  readRestaurantOfferPerformance,
  reviewRestaurantOfferForAdmin,
  simulateGuaranteeForAdmin,
  simulateOfferForAdmin,
  upsertGrowthBudgetForAdmin,
  upsertPromotionForAdmin,
  upsertRestaurantOffer,
  saveRestaurantFreebies as saveFreebiesForRestaurant,
  saveRestaurantPairings as savePairingsForRestaurant,
} from "./services/economicsAdmin";
import {DISH_DESCRIPTION_SECRETS, suggestDishDescription as writeDishDescription} from "./services/dishDescription";
import {economicsScopeKey, rupeesToPaise} from "./domain/economics";
import {isMarkupCart, markupCutPaise, markupFees, menuPricingOf, withoutCustomerTax} from "./domain/markupPricing";
import {orderAttribution} from "./services/deliverySettlement";
import {
  earnCashbackForDeliveredOrder,
  estimateCashback,
  expireWalletLots,
  planWalletRedemption,
  listCashbackCampaignsForAdmin,
  readCustomerWallet,
  restoreWalletRedemption,
  reverseCashbackForOrder,
  upsertCashbackCampaignForAdmin,
} from "./services/wallet";
import {
  applyCustomerReferralCode,
  listCustomerReferralsForAdmin,
  qualifyCustomerReferralOnDelivery,
  readCustomerReferral,
  reviewCustomerReferralForAdmin,
} from "./services/customerReferrals";
import {loadFinancePolicy} from "./services/platformConfig";
import {financePayoutAutomationSummary} from "./domain/financePolicy";
import {readPlatformConfiguration, updatePlatformConfiguration} from "./services/platformConfigControl";
import {loadCheckoutConfiguration} from "./services/platformConfig";
import {
  deliverNotificationRecord,
  notifyCustomerBroadcast,
  notifyCustomerRiderAssigned,
  notifyCustomerStatus,
  notifyRestaurantNewOrder,
  notifyRestaurantOrderLate,
  notifyStoreApplicant,
  stopRiderOffers,
  stopRestaurantAlarm,
} from "./services/notifications";
import {listDueNotifications, processNotification} from "./services/outbox";
import {
  assignStoreAsRider,
  cancelUnpaidOnlineOrder,
  completeStoreDeliveryFromChat,
  createAuthoritativeCodOrder,
  createAuthoritativeOrder,
  recoverCustomerDeliveryOtp,
  recordCodLedger,
  recordOnlinePaymentLedger,
  requiresVerifiedOnlinePaymentBeforeProgress,
  scrubLegacyPublicOtp,
  transitionOrder,
} from "./services/orders";
import {processTrackingUpdate} from "./services/tracking";
import {recordCampusHandover, recordDeliveryCampus} from "./services/campus";
import {applyStoreHours} from "./services/storeHours";
import {reconcileRestaurantWorkload} from "./services/workload";
import {reconcileRestaurantOrderProjection} from "./services/orderProjection";
import {reconcileOperationalOrderProjection} from "./services/operationalOrders";
import {recordDeliveredReviewFeedback} from "./services/reviews";
import {refreshRiderDispatchEligibility} from "./services/riderEligibility";
import {reconcileRiderOperationalWorkload} from "./services/riderWorkload";
import {recordRiderCodRemittance} from "./services/codRemittance";
import {markRiderArrivedRestaurant as recordRiderRestaurantArrival} from "./services/riderRestaurantArrival";
import {readAdminDashboard} from "./services/adminDashboard";
import {readFinanceStatement} from "./services/financeStatement";
import {citySortNeedsUpdate, citySortValue} from "./domain/catalogIndex";
import {searchTokenUpdates} from "./domain/catalogSearchTokens";
import {geoSortGlobalNeedsUpdate, geoSortGlobalValue, geoSortNeedsUpdate, geoSortValue} from "./domain/catalogGeoIndex";
import {
  recordRestaurantSettlement as writeRestaurantSettlement,
  recordRiderPayout as writeRiderPayout,
} from "./services/payouts";
import {readRiderFinancialSummary} from "./services/riderFinance";
import {setRiderTaxClassification as recordRiderTaxClassification, sweepRiderContractorTds} from "./services/riderTds";
import {getRestaurantSettlementSummary as readRestaurantSettlementSummary} from "./services/restaurantSettlements";
import {getRestaurantTaxStatement as readRestaurantTaxStatement, restaurantTaxStatementSchema} from "./services/restaurantTaxStatement";
import {
  bookSponsoredListing as bookSponsoredListingFor,
  bookSponsoredListingSchema,
  cancelSponsoredListing as cancelSponsoredListingFor,
  cancelSponsoredListingSchema,
  getSponsoredListings as readSponsoredListings,
  sponsoredListingsSchema,
} from "./services/sponsoredListings";
import {getRestaurantPayoutReport as readRestaurantPayoutReport, restaurantPayoutReportSchema} from "./services/restaurantPayoutReport";
import * as outletStaff from "./services/restaurantStaff";
import * as tdsClaims from "./services/tdsCommissionClaims";
import {
  evaluateRiderRewardsForDeliveredOrder,
  expireRiderReferrals,
  readRiderReferralOverviewForAdmin,
  reverseRiderReferralDelivery,
  reviewRiderReferralForAdmin,
  simulateRiderReferralForAdmin,
  syncRiderReferralForProfile,
  recordRiderRewardOrderCancelledAfterAccept,
  recordRiderRewardOrderPickedUp,
  recordRiderRewardPresenceUpdate,
  readRiderRewardsAdminDashboard,
  readRiderRewardsDashboard,
  settleQualifiedRiderRewardPeriods,
  updateRiderRewardSettings,
  upsertRiderRewardCampaign,
} from "./services/riderRewards";
import {readLatestWeeklyRun, readWeeklyRunItems, runWeeklyFinanceAutomation, selectPayoutGateway} from "./services/financeAutomation";
import {CASHFREE_PAYOUT_SECRETS, CashfreePayoutGateway, liveCashfreePayoutConfig} from "./services/cashfreePayouts";
import {movePayoutProfileToPrivate} from "./services/restaurantPayoutProfiles";
import {recordRiderDeliveredOrder} from "./services/riderDeliveryCount";
import {lawBasedCheckoutTax, recordDeliveredOrderTax, resolveTdsReversal, reverseOrderTaxWithholding} from "./services/taxEngine";
import {exportTaxPack as buildTaxPackExport} from "./services/taxPack";
import {backfillLedgerPartyIndex} from "./services/ledgerPartyIndex";
import {
  UnconfiguredPhonePeGateway,
  applyVerifiedPayment,
  callbackHash,
  checkOrderPaymentStatus,
  closeUnpaidPaymentAttempts,
  refundCancelledOrderPayment,
  initiatePayment,
} from "./services/payments";
import type {CatalogRestaurant, SavrivoOrder} from "./types";

// Each instance serves up to 80 requests at once, so 100 instances is room
// for roughly 8,000 simultaneous requests per function. Instances only exist
// (and cost) while traffic needs them; idle functions scale to zero.
setGlobalOptions({maxInstances: 100});

// Every function runs on a small CPU share ("gcf_gen1": a sixth of a CPU at 256MiB) unless it is on the
// order/checkout/rider hot path (cpu: 0.5) or needs many requests per instance (maps, tracking: cpu: 1). With a full CPU each, idle instances of ~160 functions used up
// the region's Cloud Run CPU quota (20 vCPU) and app requests failed with 503 "server busy".
// Cloud Run also refuses a function whose max instances x CPU is above the region's quota, so the
// instance cap shrinks with the CPU share (a sixth of a CPU: 100 instances; half a CPU: 40).
const REGION_VCPU_QUOTA = 20;
const GEN1_CPU: Record<string, number> = {"128MiB": 0.083, "256MiB": 0.1666, "512MiB": 0.3333, "1GiB": 0.5833, "2GiB": 1};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lightCpu<F extends (...args: any[]) => any>(trigger: F): F {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((options: any, handler: any) => {
    if (typeof options !== "object" || !options) return trigger(options, handler);
    const withCpu = {cpu: "gcf_gen1", ...options};
    const cpu = withCpu.cpu === "gcf_gen1" ? GEN1_CPU[String(withCpu.memory ?? "256MiB")] ?? 1 : Number(withCpu.cpu);
    const asked = typeof withCpu.maxInstances === "number" ? withCpu.maxInstances : 100;
    return trigger({...withCpu, maxInstances: Math.min(asked, Math.floor(REGION_VCPU_QUOTA / cpu))}, handler);
  }) as F;
}
const onValueWritten = lightCpu(databaseTriggers.onValueWritten);
const onDocumentCreated = lightCpu(firestoreTriggers.onDocumentCreated);
const onDocumentDeleted = lightCpu(firestoreTriggers.onDocumentDeleted);
const onDocumentUpdated = lightCpu(firestoreTriggers.onDocumentUpdated);
const onDocumentWritten = lightCpu(firestoreTriggers.onDocumentWritten);
const onSchedule = lightCpu(scheduler.onSchedule);
const onTaskDispatched = lightCpu(tasks.onTaskDispatched);
const onCall = lightCpu(httpsTriggers.onCall);
const onRequest = lightCpu(httpsTriggers.onRequest);

// The customer app pings the checkout functions with {warmup: true} while the cart fills, so each one
// is already running when "Place order" is tapped: no 4-5 s cold start, and no always-on instance to pay for.
function isWarmup(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as {warmup?: unknown}).warmup === true;
}

// Starting the copy is only half the warm-up: the first real order on a fresh copy still had to
// open the Firestore connection and load the pricing settings (1.9 s instead of 0.65 s on
// 2026-11-04). Doing those reads here leaves "Place order" only the order's own work.
async function warmUp(): Promise<{warm: true}> {
  const now = Date.now();
  await Promise.all([
    loadEconomicsControl(now),
    loadFinancePolicy(now),
    firestoreDb.collection("settings").doc("customer").get(),
    firestoreDb.collection("settings").limit(1).get(),
  ]).catch((error) => logger.warn("WARMUP_READ_FAILED", {error: String(error)}));
  return {warm: true};
}

// The rider app's native client only sends {orderId}, so it wakes accept/decline with this id
// the moment an offer arrives: the tap on Accept then skips the 5-6 s cold start.
const RIDER_WARMUP_ORDER_ID = "__warmup__";
function isRiderWarmup(data: unknown): boolean {
  return isWarmup(data) || (typeof data === "object" && data !== null
    && (data as {orderId?: unknown}).orderId === RIDER_WARMUP_ORDER_ID);
}

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new DomainError("invalid-argument", validationMessage(result.error));
  return result.data as z.infer<S>;
}

async function sideEffectLease(key: string, work: () => Promise<void>): Promise<void> {
  const safeKey = createHash("sha256").update(key).digest("hex");
  const ref = firestoreDb.collection("backendEvents").doc(safeKey);
  const now = Date.now();
  let leaseCommitted = false;
  await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() as {status?: string; leaseUntil?: number} : null;
    if (current?.status === "done" || Number(current?.leaseUntil ?? 0) > now) return;
    transaction.set(ref, {status: "running", startedAt: now, leaseUntil: now + 5 * 60_000});
    leaseCommitted = true;
  });
  if (!leaseCommitted) return;
  try {
    await work();
    await ref.set({status: "done", completedAt: Date.now(), leaseUntil: 0}, {merge: true});
  } catch (error) {
    await ref.set({
      status: "retry",
      lastError: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      leaseUntil: 0,
    }, {merge: true});
    throw error;
  }
}

export const createCodOrder = onCall({
  cpu: 0.5, // hot path: half a CPU, quicker than gcf_gen1 (see lightCpu)
  region: REGION,
  secrets: [GOOGLE_WEATHER_API_KEY], // road km for the delivery fee (services/roadDistance)
  enforceAppCheck: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to place an order."));
  if (isWarmup(request.data)) return await warmUp();
  try {
    const input = parse(createCodOrderSchema, request.data);
    const result = await createAuthoritativeCodOrder(request.auth.uid, input);
    if (input.squadCode && !result.recovered) {
      await attachSquadToOrder(request.auth.uid, input.squadCode, result.order.id, input.restaurantId)
        .catch((error) => logger.warn("SQUAD_ATTACH_FAILED", {orderId: result.order.id, error: String(error)}));
    }
    return {
      orderId: result.order.id,
      order: result.order,
      deliveryOtp: result.deliveryOtp,
      recovered: result.recovered,
    };
  } catch (error) {
    logger.warn("createCodOrder rejected", {uid: request.auth.uid, error});
    throw asHttpsError(error);
  }
});

/** One cart with food from two or three restaurants: an order per restaurant, released together. */
export const createClusterOrder = onCall({
  cpu: 0.5,
  region: REGION,
  secrets: [GOOGLE_WEATHER_API_KEY], // road km for the delivery fee (services/roadDistance)
  enforceAppCheck: true,
  timeoutSeconds: 60,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to place an order."));
  if (isWarmup(request.data)) return await warmUp();
  const auth = request.auth;
  try {
    const input = parse(createClusterOrderSchema, request.data);
    const result = await clusterOrders.createClusterOrder(auth.uid, input, (orderId) =>
      transitionOrder(auth.uid, auth.token, {orderId, customerId: auth.uid, toStatus: "Cancelled", reason: "Another restaurant in this cart could not take the order."} as never));
    // Announce every part to its restaurant only now that all of them exist.
    for (const order of result.released ?? []) {
      await reconcileRestaurantOrderProjection(order);
      await reconcileRestaurantWorkload(order);
      await reconcileOperationalOrderProjection(order);
      if (awaitingOnlinePayment(order)) continue;
      await sideEffectLease(`restaurant-new-order:${order.id}`, async () => {
        await notifyRestaurantNewOrder(order);
      });
    }
    return {
      clusterId: result.clusterId,
      orderIds: (result.released ?? []).map((order) => order.id),
      bill: result.bill,
      plan: result.plan,
      deliveryOtps: result.deliveryOtps ?? [],
    };
  } catch (error) {
    logger.warn("createClusterOrder rejected", {uid: auth.uid, error});
    throw asHttpsError(error);
  }
});

export const createOrder = onCall({
  // A full CPU so one copy can serve many calls at once (Cloud Run allows that only from 1 CPU up).
  // At half a CPU each call needed its own copy, so the cart's warm-up and a real order woke two
  // sleeping copies (4–6 s each) instead of sharing one. 512MiB: one call alone used up to 0.8 of 256MiB.
  cpu: 1,
  concurrency: 20,
  // One copy awake 7 AM–midnight IST only (founder 2026-11-13): Cloud Scheduler jobs
  // warm-<name> / cold-<name> set the Cloud Run service's minimum, so no minInstances here.
  maxInstances: 3, // 60 calls at once; kept small for the region's 20 vCPU quota (see mapTile)
  region: REGION,
  secrets: [...CASHFREE_SECRETS, GOOGLE_WEATHER_API_KEY], // + road km for the delivery fee
  enforceAppCheck: true,
  timeoutSeconds: 30,
  memory: "512MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to place an order."));
  if (isWarmup(request.data)) return await warmUp();
  try {
    const input = parse(createOrderSchema, request.data);
    if (input.paymentMethod !== "cod" && !paymentGateway.configured) {
      throw new DomainError("failed-precondition", "Online payments are not available right now.");
    }
    const result = await createAuthoritativeOrder(request.auth.uid, input);
    if (input.squadCode && !result.recovered) {
      await attachSquadToOrder(request.auth.uid, input.squadCode, result.order.id, input.restaurantId)
        .catch((error) => logger.warn("SQUAD_ATTACH_FAILED", {orderId: result.order.id, error: String(error)}));
    }
    return {
      orderId: result.order.id,
      order: result.order,
      deliveryOtp: result.deliveryOtp,
      recovered: result.recovered,
    };
  } catch (error) {
    logger.warn("createOrder rejected", {uid: request.auth.uid, error});
    throw asHttpsError(error);
  }
});

export const recoverDeliveryOtp = onCall({
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 15,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to view delivery verification."));
  try {
    const input = parse(recoverDeliveryOtpSchema, request.data);
    const deliveryOtp = await recoverCustomerDeliveryOtp(request.auth.uid, input.orderId);
    return {orderId: input.orderId, deliveryOtp};
  } catch (error) {
    logger.warn("recoverDeliveryOtp rejected", {uid: request.auth.uid, error});
    throw asHttpsError(error);
  }
});

export const updateOrderStatus = onCall({
  cpu: 0.5, // hot path: half a CPU, quicker than gcf_gen1 (see lightCpu)
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to update an order."));
  // Sent by the restaurant app when a new order arrives, so the instance is
  // already running when Accept is tapped (no ~3 s cold start).
  if ((request.data as {warmup?: unknown} | null)?.warmup === true) return {warm: true};
  try {
    const input = parse(transitionOrderSchema, request.data);
    const result = await transitionOrder(request.auth.uid, request.auth.token, input);
    // Acceptance is the dispatch boundary. Start the first offer before this
    // callable returns so rider assignment never waits for a later kitchen
    // status or for the asynchronous database trigger to catch up. The
    // onOrderUpdated trigger remains an idempotent recovery path.
    if (result.order.status === "Accepted" && !result.order.riderId) {
      if (result.order.selfDelivery === true) await assignStoreAsRider(result.order);
      else await beginSequentialDispatch(result.order);
    }
    if (result.idempotent) {
      logger.info("DUPLICATE_ORDER_ACTION_IGNORED", {
        orderId: result.order.id,
        status: result.order.status,
      });
    }
    return {
      orderId: result.order.id,
      status: result.order.status,
      updatedAt: result.order.updatedAt,
      idempotent: result.idempotent,
    };
  } catch (error) {
    logger.warn("updateOrderStatus rejected", {uid: request.auth.uid, error});
    throw asHttpsError(error);
  }
});

export const claimRiderOrder = onCall({
  cpu: 0.5, // hot path: half a CPU, quicker than gcf_gen1 (see lightCpu)
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to accept a delivery."));
  if (isRiderWarmup(request.data)) return {warm: true};
  try {
    const input = parse(claimOrderSchema, request.data);
    const order = await claimDispatchOffer(request.auth.uid, input.orderId);
    return {orderId: order.id, status: order.status, riderId: order.riderId};
  } catch (error) {
    logger.warn("claimRiderOrder rejected", {uid: request.auth.uid, error});
    throw asHttpsError(error);
  }
});

export const declineRiderOrder = onCall({
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to decline a delivery."));
  if (isRiderWarmup(request.data)) return {warm: true};
  try {
    const input = parse(declineOrderSchema, request.data);
    await declineDispatchOffer(request.auth.uid, input.orderId);
    return {orderId: input.orderId, declined: true};
  } catch (error) {
    logger.warn("declineRiderOrder rejected", {uid: request.auth.uid, error});
    throw asHttpsError(error);
  }
});

export const submitRiderFaceCheckCall = onCall({
  region: REGION, maxInstances: 10,
  enforceAppCheck: true,
  timeoutSeconds: 45,
  memory: "256MiB",
  secrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY],
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to verify your identity."));
  try {
    const input = parse(riderFaceImageSchema, request.data);
    return await submitRiderFaceCheck(request.auth.uid, input, AWS_ACCESS_KEY_ID.value(), AWS_SECRET_ACCESS_KEY.value());
  } catch (error) {
    logger.warn("submitRiderFaceCheck rejected", {uid: request.auth.uid, error});
    throw asHttpsError(error);
  }
});

export const verifyRiderLoginFaceCall = onCall({
  region: REGION, maxInstances: 10,
  enforceAppCheck: true,
  timeoutSeconds: 45,
  memory: "256MiB",
  secrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY],
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to verify your identity."));
  // The rider app sends this the moment the face screen opens, so the
  // instance is already started (no ~3 s cold start) by the time the photo
  // arrives - without paying for an always-on instance.
  if ((request.data as {warmup?: unknown} | null)?.warmup === true) return {warm: true};
  try {
    const input = parse(riderFaceImageSchema, request.data);
    return await verifyRiderLoginFace(request.auth.uid, input, AWS_ACCESS_KEY_ID.value(), AWS_SECRET_ACCESS_KEY.value());
  } catch (error) {
    logger.warn("verifyRiderLoginFace rejected", {uid: request.auth.uid, error});
    throw asHttpsError(error);
  }
});

export const resolveRiderFaceReviewCall = onCall({
  region: REGION, maxInstances: 5,
  enforceAppCheck: true,
  timeoutSeconds: 45,
  memory: "256MiB",
  secrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY],
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to review this application."));
  try {
    const input = parse(resolveRiderFaceReviewSchema, request.data);
    return await resolveRiderFaceReview(
      request.auth.uid, request.auth.token, input, AWS_ACCESS_KEY_ID.value(), AWS_SECRET_ACCESS_KEY.value());
  } catch (error) {
    logger.warn("resolveRiderFaceReview rejected", {uid: request.auth.uid, error});
    throw asHttpsError(error);
  }
});

export const markRiderArrivedRestaurant = onCall({
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to record arrival."));
  // The rider app sends this while heading to the restaurant, so the
  // instance is already running when "I have arrived" is tapped.
  if ((request.data as {orderId?: unknown} | null)?.orderId === "__warmup__") return {warm: true};
  try {
    const input = parse(markRiderArrivedRestaurantSchema, request.data);
    return await recordRiderRestaurantArrival(request.auth.uid, input.orderId);
  } catch (error) {
    logger.warn("markRiderArrivedRestaurant rejected", {uid: request.auth.uid, error});
    throw asHttpsError(error);
  }
});

export const registerPushToken = onCall({
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 20,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to register this device."));
  try {
    const input = parse(registerDeviceTokenSchema, request.data);
    return await registerDeviceToken(request.auth.uid, request.auth.token, input);
  } catch (error) {
    logger.warn("registerPushToken rejected", {uid: request.auth.uid, error});
    throw asHttpsError(error);
  }
});

export const unregisterPushToken = onCall({
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 20,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to remove this device."));
  try {
    const input = parse(unregisterDeviceTokenSchema, request.data);
    return await unregisterDeviceToken(request.auth.uid, input);
  } catch (error) {
    logger.warn("unregisterPushToken rejected", {uid: request.auth.uid, error});
    throw asHttpsError(error);
  }
});

/** Server-authoritative operations control plane. These callables deliberately
* require owner/ops-admin custom claims and do not rely on fixed account lists. */
export const getPlatformConfiguration = onCall({
  cpu: 0.5, // hot path: half a CPU, quicker than gcf_gen1 (see lightCpu)
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 15,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to view platform configuration."));
  try {
    return await readPlatformConfiguration(request.auth.token);
  } catch (error) {
    logger.warn("getPlatformConfiguration rejected", {uid: request.auth.uid, error});
    throw asHttpsError(error);
  }
});

/**
 * Optional cart context (restaurantId/items/addressId) turns this into a live
 * checkout price preview too - the same rainFee/surgeFee/riderIncentiveFee
 * loadServerFees() computes at real order creation, shown before the
 * customer commits to placing the order. A preview failure never breaks the
 * base checkout-configuration response (payment methods still load); it just
 * means no feePreview is attached, same "fail closed" idiom used everywhere
 * else these dynamic fees are computed.
 */
const TAX_BREAKDOWN_LABELS: Record<string, string> = {
  restaurant_service: "GST on item total", food: "GST on item total", packaging: "GST on packaging",
  delivery_fee: "GST on delivery fee", platform_fee: "GST on platform fee", small_order_fee: "GST on small-order fee",
  late_night_fee: "GST on late-night fee", surge_fee: "GST on demand fee", rain_fee: "GST on rain fee",
  rider_incentive_fee: "GST on rider fees",
};

export const getCheckoutConfiguration = onCall({
  // A full CPU and many calls per copy, like createOrder: the warm-up, the cart price and the
  // delivery-partner check arrive together and now share one copy instead of waking one each.
  cpu: 1,
  concurrency: 20,
  // One copy awake 7 AM–midnight IST only (founder 2026-11-13): Cloud Scheduler jobs
  // warm-<name> / cold-<name> set the Cloud Run service's minimum, so no minInstances here.
  maxInstances: 3, // 60 calls at once; kept small for the region's 20 vCPU quota (see mapTile)
  region: REGION,
  secrets: [...CASHFREE_SECRETS, GOOGLE_WEATHER_API_KEY], // + road km for the delivery fee
  enforceAppCheck: true,
  timeoutSeconds: 15,
  memory: "512MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to view checkout configuration."));
  if (isWarmup(request.data)) return await warmUp();
  try {
    const data = request.data as Record<string, unknown> | null | undefined;
    // Restaurant page: is a delivery partner free near this store? Same check as Place order.
    if (data && data.deliveryPartnerCheck === true) {
      const check = parse(deliveryPartnerCheckSchema, data);
      return {deliveryPartners: await deliveryPartnerStatusForRestaurant(check.restaurantId)};
    }
    // priceLock tells the app this server takes quotedTotal on an order.
    const config = {...await loadCheckoutConfiguration(paymentGateway.configured), priceLock: true};
    if (!data || !data.restaurantId) return config;
    try {
      const input = parse(checkoutPricingPreviewSchema, data);
      const [{restaurant, menuById}, {address}] = await Promise.all([
        loadRestaurantAndMenu(input.restaurantId),
        loadCustomerAddress(request.auth.uid, input.addressId),
      ]);
      const {items: pricedItems, subtotal, markup} = priceCart(input.items, menuById, menuPricingOf(restaurant));
      const now = Date.now();
      const [fees, control, financePolicy] = await Promise.all([
        loadServerFees(restaurant, address, markup?.listSubtotal ?? subtotal).then((value) => markupFees(value, markup)),
        loadEconomicsControl(now),
        loadFinancePolicy(now),
      ]);
      // The same plan order creation runs, so the customer sees exactly the
      // discount (and who funds it) that the real order will get.
      let offerPreview: Record<string, unknown> | null = null;
      let promotion: Awaited<ReturnType<typeof resolveCheckoutPromotion>> = null;
      if (input.couponCode) {
        try {
          promotion = await resolveCheckoutPromotion(input.couponCode, {
            subtotalPaise: rupeesToPaise(subtotal),
            restaurantId: restaurant.id,
            cityKey: economicsScopeKey(restaurant.city),
            customerId: request.auth.uid,
            at: now,
            lines: checkoutLines(pricedItems),
            deliveryArea: address.area,
          });
        } catch (offerError) {
          offerPreview = {
            valid: false,
            code: input.couponCode,
            message: offerError instanceof DomainError ? offerError.message : "Coupon is not valid.",
          };
        }
      }
      const plan = planCheckoutEconomics({
        control, restaurant, address, subtotal, fees,
        paymentMethod: input.paymentMethod,
        tip: input.tip,
        promotion,
        defaultCommissionBps: financePolicy.restaurantCommissionBps,
        now,
        ...(isMarkupCart(markup) ? {markupCutPaise: markupCutPaise(rupeesToPaise(subtotal), markup)} : {}),
      });
      if (plan.offer) {
        offerPreview = {
          ...plan.offer,
          valid: true,
          discount: (plan.discount.restaurantDiscountPaise + plan.discount.platformDiscountPaise) / 100,
          restaurantFunded: plan.discount.restaurantDiscountPaise / 100,
          platformFunded: plan.discount.platformDiscountPaise / 100,
        };
      }
      let tax = checkoutTax(control, plan, fees, subtotal, now);
      const lawTax = await lawBasedCheckoutTax({restaurant, items: pricedItems, menuById, plan, fees, subtotal, at: now});
      if (lawTax) tax = lawTax.tax;
      // Markup restaurants: food GST is inside the item prices, so the bill adds GST on fees only.
      const markupPricing = markup ? markupCheckoutBill(markup, {subtotal, plan, tax, orderTax: lawTax ? lawTax.orderTax : null}) : null;
      // The app takes the offer's discount from here: GST-inclusive, like the item total it comes off.
      if (markupPricing && offerPreview?.valid === true) offerPreview.discount = markupPricing.discount;
      // What the customer's GST is made of, for the "GST & charges" line in the bill.
      const taxParts = !tax ? [] : lawTax ?
        lawTax.orderTax.services.filter((line) => line.chargedTo === "customer").map((line) => ({component: line.component, paise: line.gstPaise})) :
        tax.lines.filter((line) => !line.inclusive && line.component !== "commission").map((line) => ({component: line.component, paise: line.taxPaise}));
      const taxBreakdown: {label: string; amount: number}[] = [];
      for (const part of taxParts) {
        if (part.paise <= 0) continue;
        if (markupPricing && (part.component === "restaurant_service" || part.component === "food")) continue;
        const label = TAX_BREAKDOWN_LABELS[part.component] ?? `GST on ${part.component.replace(/_/g, " ")}`;
        const row = taxBreakdown.find((entry) => entry.label === label);
        if (row) row.amount = Math.round((row.amount + part.paise / 100) * 100) / 100;
        else taxBreakdown.push({label, amount: part.paise / 100});
      }
      const feeInput = {
        subtotal,
        discount: (plan.discount.restaurantDiscountPaise + plan.discount.platformDiscountPaise) / 100,
        deliveryFee: fees.deliveryFee, platformFee: fees.platformFee, taxRate: fees.taxRate, tip: input.tip,
        smallOrderThreshold: fees.smallOrderThreshold, smallOrderFee: fees.smallOrderFee,
        lateNightFee: fees.lateNightFee, rainFee: fees.rainFee, surgeFee: fees.surgeFee,
        riderIncentiveFee: fees.riderIncentiveFee,
        // Same inputs as order creation, so the preview total is the real total.
        riderSurgeFee: fees.riderSurgeFee,
        ...(markupPricing ? {taxOverride: markupPricing.customerTaxPaise / 100} :
          tax ? {taxOverride: tax.customerTaxPaise / 100} : {}),
      };
      const beforeWallet = buildPricing(feeInput);
      const wallet = plan.engineEnabled ? await planWalletRedemption({
        customerId: request.auth.uid,
        rules: control.walletRules,
        subtotalPaise: rupeesToPaise(subtotal),
        payableBeforeWalletPaise: rupeesToPaise(beforeWallet.total),
        at: now,
        requested: input.useWallet,
      }).catch(() => null) : null;
      const priced = buildPricing({...feeInput, ...(wallet?.amountPaise ? {walletRedeem: wallet.amountPaise / 100} : {})});
      const cashback = plan.engineEnabled ? await estimateCashback(request.auth.uid, restaurant.id, plan, priced, now)
        .catch(() => null) : null;
      await savePriceQuote(request.auth.uid, {...input, lat: address.lat, lng: address.lng}, fees, priced.total, now);
      const checkoutPreview = {
        serverAuthoritative: true,
        ...priced.pricing,
        restaurantDiscount: plan.discount.restaurantDiscountPaise / 100,
        platformDiscount: plan.discount.platformDiscountPaise / 100,
        total: priced.total,
        walletBalance: (wallet?.balancePaise ?? 0) / 100,
        walletMaxForOrder: (wallet?.maxForOrderPaise ?? 0) / 100,
        cashbackEstimate: cashback,
        taxVersionId: tax?.versionId ?? "",
        taxBreakdown,
        // Markup restaurants: shown GST-inclusive, so item total + fees + tax still add up to total.
        ...(markupPricing ? {
          subtotal: markupPricing.listSubtotal,
          discount: markupPricing.discount,
          tax: markupPricing.tax,
          foodGstIncluded: markupPricing.foodGst,
          markup: withoutCustomerTax(markupPricing),
        } : {}),
      };
      return {
        ...config,
        checkoutPreview,
        ...(offerPreview ? {offerPreview} : {}),
        feePreview: {
          deliveryFee: fees.deliveryFee,
          platformFee: fees.platformFee,
          smallOrderFee: subtotal < fees.smallOrderThreshold ? fees.smallOrderFee : 0,
          lateNightFee: fees.lateNightFee,
          rainFee: fees.rainFee,
          surgeFee: fees.surgeFee,
          // The customer app lists these as bill lines and adds them up, so the
          // rider surge fee rides along as its own line (no app update needed).
          riderIncentiveFee: fees.riderIncentiveFee + fees.riderSurgeFee,
          riderIncentiveItems: [
            ...fees.riderIncentiveItems,
            ...(fees.riderSurgeFee > 0 ? [{label: "Rider surge fee", amount: fees.riderSurgeFee}] : []),
          ],
          riderSurgeFee: fees.riderSurgeFee,
          returnTripFee: fees.returnTripFee,
          returnTripKm: fees.returnTripKm,
          roadKm: fees.roadKm,
          weatherSeverity: fees.rainFee > 0 ? "verified_rain" : "",
          activeOrders: fees.activeOrders,
        },
      };
    } catch (previewError) {
      logger.warn("getCheckoutConfiguration fee preview skipped", {uid: request.auth.uid, error: previewError});
      return config;
    }
  } catch (error) {
    logger.warn("getCheckoutConfiguration rejected", {uid: request.auth.uid, error});
    throw asHttpsError(error);
  }
});

export const updatePlatformConfigurationPolicy = onCall({
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 20,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to update platform configuration."));
  try {
    return await updatePlatformConfiguration(request.auth.uid, request.auth.token, request.data);
  } catch (error) {
    logger.warn("updatePlatformConfigurationPolicy rejected", {uid: request.auth.uid, error});
    throw asHttpsError(error);
  }
});

/** Records a verified physical/electronic COD return. This is deliberately a
 * custom-claim guarded control-plane action; clients cannot write wallet or
 * immutable ledger state directly. */
export const recordCodRemittance = onCall({
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to record COD remittance."));
  try {
    const input = parse(recordCodRemittanceSchema, request.data);
    return await recordRiderCodRemittance(request.auth.uid, request.auth.token, input);
  } catch (error) {
    logger.warn("recordCodRemittance rejected", {
      uid: request.auth.uid,
      error: error instanceof Error ? error.message.slice(0, 160) : "unknown",
    });
    throw asHttpsError(error);
  }
});

/** Records a verified rider payout after treasury actually sends the money. */
export const recordRiderPayout = onCall({
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 20,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to record rider payouts."));
  try {
    const input = parse(recordRiderPayoutSchema, request.data);
    return await writeRiderPayout(request.auth.uid, request.auth.token, input);
  } catch (error) {
    logger.warn("recordRiderPayout rejected", {
      uid: request.auth.uid,
      error: error instanceof Error ? error.message.slice(0, 160) : "unknown",
    });
    throw asHttpsError(error);
  }
});

/** Records a verified restaurant settlement after treasury actually sends the money. */
export const recordRestaurantSettlement = onCall({
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 20,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) {
    throw asHttpsError(new DomainError("unauthenticated", "Sign in to record restaurant settlements."));
  }
  try {
    const input = parse(recordRestaurantSettlementSchema, request.data);
    return await writeRestaurantSettlement(request.auth.uid, request.auth.token, input);
  } catch (error) {
    logger.warn("recordRestaurantSettlement rejected", {
      uid: request.auth.uid,
      error: error instanceof Error ? error.message.slice(0, 160) : "unknown",
    });
    throw asHttpsError(error);
  }
});

/**
 * Claim-protected and bounded operator dashboard. This replaces client-side
 * full-tree polling without exposing the backend-private projections directly.
 */
export const getAdminDashboard = onCall({
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 20,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to view operations."));
  try {
    const input = parse(adminDashboardQuerySchema, request.data ?? {});
    return await readAdminDashboard(request.auth.token, input);
  } catch (error) {
    logger.warn("getAdminDashboard rejected", {
      uid: request.auth.uid,
      error: error instanceof Error ? error.message.slice(0, 160) : "unknown",
    });
    throw asHttpsError(error);
  }
});

/**
 * Itemized, bank-statement-style ledger read for an explicit day/week/month/
 * year window the web admin computes client-side. Same owner/ops-admin bar
 * and bounded-read discipline as getAdminDashboard's finance summary - just
 * scoped to a caller-chosen window instead of "most recent N".
 */
export const getFinanceStatement = onCall({
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 20,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to view the finance statement."));
  try {
    const input = parse(financeStatementQuerySchema, request.data ?? {});
    return await readFinanceStatement(request.auth.token, input);
  } catch (error) {
    logger.warn("getFinanceStatement rejected", {
      uid: request.auth.uid,
      error: error instanceof Error ? error.message.slice(0, 160) : "unknown",
    });
    throw asHttpsError(error);
  }
});

/**
 * Owner-only bulk export: one workbook covering customers, riders,
 * restaurants and admin/ops-admin accounts. Deliberately gated stricter than
 * the rest of the admin surface (owner claim, not ops-admin) given the export
 * covers every user's data - including restaurant bank/UPI payout details -
 * at once rather than one record at a time. An optional city narrows
 * customers, riders and restaurants to that city; admin accounts are never
 * city-scoped.
 */
// Tax pack for a CA: sales, Scraveit income and GST, seller GST and TCS,
// TDS, settlements, rider payouts, cash, refunds, invoices and a bank match.
export const exportTaxPack = onCall({
  region: REGION, maxInstances: 3,
  enforceAppCheck: true,
  timeoutSeconds: 300,
  memory: "1GiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to download the tax pack."));
  try {
    const input = parse(exportTaxPackSchema, request.data ?? {});
    return await buildTaxPackExport(request.auth.uid, request.auth.token, input);
  } catch (error) {
    logger.warn("exportTaxPack rejected", {uid: request.auth.uid, error: error instanceof Error ? error.message.slice(0, 160) : "unknown"});
    throw asHttpsError(error);
  }
});

export const setRiderTaxClassification = onCall({
  region: REGION,
  enforceAppCheck: true,
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to change a tax classification."));
  try {
    const input = parse(setRiderTaxClassificationSchema, request.data ?? {});
    return await recordRiderTaxClassification(request.auth.uid, request.auth.token, input);
  } catch (error) {
    logger.warn("setRiderTaxClassification rejected", {uid: request.auth.uid, error: error instanceof Error ? error.message.slice(0, 160) : "unknown"});
    throw asHttpsError(error);
  }
});

export const resolveRefundTdsReversal = onCall({
  region: REGION,
  enforceAppCheck: true,
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to reconcile TDS."));
  try {
    const input = parse(resolveTdsReversalSchema, request.data ?? {});
    return await resolveTdsReversal(request.auth.uid, request.auth.token, input);
  } catch (error) {
    logger.warn("resolveRefundTdsReversal rejected", {uid: request.auth.uid, error: error instanceof Error ? error.message.slice(0, 160) : "unknown"});
    throw asHttpsError(error);
  }
});

export const exportPlatformDataWorkbook = onCall({
  region: REGION, maxInstances: 3,
  enforceAppCheck: true,
  timeoutSeconds: 180,
  memory: "512MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to export platform data."));
  try {
    const input = parse(exportPlatformDataWorkbookSchema, request.data ?? {});
    return await buildPlatformDataExport(request.auth.token, input.city);
  } catch (error) {
    logger.warn("exportPlatformDataWorkbook rejected", {
      uid: request.auth.uid,
      error: error instanceof Error ? error.message.slice(0, 160) : "unknown",
    });
    throw asHttpsError(error);
  }
});

/**
 * The generated export sits in Storage only long enough for the requesting
 * device to download it - this is what actually bounds that, independent of
 * the download link itself.
 */
export const purgeExpiredAdminDataExports = onSchedule({
  schedule: "every 60 minutes",
  region: REGION,
  timeoutSeconds: 120,
  memory: "256MiB",
}, async () => {
  const deleted = await purgeExpiredPlatformDataExports();
  if (deleted > 0) logger.info("ADMIN_DATA_EXPORT_PURGE_RUN_COMPLETED", {deleted});
});

/**
 * Read-only rider/admin financial view. All money comes from validated,
 * backend-private ledger journals and the authoritative COD wallet projection.
 * A bounded/incomplete result never claims to be a current payable balance.
 */
export const getRiderFinancialSummary = onCall({
  region: REGION,
  invoker: "public",
  timeoutSeconds: 20,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to view rider finances."));
  try {
    const input = parse(riderFinancialSummaryQuerySchema, request.data ?? {});
    return await readRiderFinancialSummary(request.auth.uid, request.auth.token, input);
  } catch (error) {
    logger.warn("getRiderFinancialSummary rejected", {
      uid: request.auth.uid,
      error: error instanceof Error ? error.message.slice(0, 160) : "unknown",
    });
    throw asHttpsError(error);
  }
});

export const getRiderRewardsDashboard = onCall({
  region: REGION,
  invoker: "public",
  timeoutSeconds: 20,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to view rider rewards."));
  try {
    const input = parse(riderRewardsDashboardQuerySchema, request.data ?? {});
    return await readRiderRewardsDashboard(request.auth.uid, request.auth.token, input);
  } catch (error) {
    logger.warn("getRiderRewardsDashboard rejected", {
      uid: request.auth.uid,
      error: error instanceof Error ? error.message.slice(0, 160) : "unknown",
    });
    throw asHttpsError(error);
  }
});

export const getAdminRiderRewardsDashboard = onCall({
  region: REGION,
  invoker: "public",
  enforceAppCheck: true,
  timeoutSeconds: 20,
  // 128MiB was tight enough that ordinary codebase growth (shared across
  // every function's cold start) pushed it past the limit, failing the
  // readiness probe with FUNCTION_HTTP_503 before the handler ever ran.
  memory: "256MiB",
  cpu: "gcf_gen1",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to view rider rewards operations."));
  try {
    const input = parse(adminRiderRewardsDashboardQuerySchema, request.data ?? {});
    return await readRiderRewardsAdminDashboard(request.auth.token, input);
  } catch (error) {
    logger.warn("getAdminRiderRewardsDashboard rejected", {
      uid: request.auth.uid,
      error: error instanceof Error ? error.message.slice(0, 160) : "unknown",
    });
    throw asHttpsError(error);
  }
});

export const upsertRiderRewardCampaignPolicy = onCall({
  region: REGION,
  invoker: "public",
  enforceAppCheck: true,
  timeoutSeconds: 20,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to update rider incentives."));
  try {
    const input = parse(upsertRiderRewardCampaignSchema, request.data ?? {});
    return await upsertRiderRewardCampaign(request.auth.uid, request.auth.token, input);
  } catch (error) {
    logger.warn("upsertRiderRewardCampaignPolicy rejected", {
      uid: request.auth.uid,
      error: error instanceof Error ? error.message.slice(0, 160) : "unknown",
    });
    throw asHttpsError(error);
  }
});

export const updateRiderRewardSettingsPolicy = onCall({
  region: REGION,
  invoker: "public",
  enforceAppCheck: true,
  timeoutSeconds: 20,
  // Shares the same cold-start module bundle as getAdminRiderRewardsDashboard,
  // which hit FUNCTION_HTTP_503 at 128MiB - see the comment there.
  memory: "256MiB",
  cpu: "gcf_gen1",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to update rider incentive settings."));
  try {
    const input = parse(updateRiderRewardSettingsSchema, request.data ?? {});
    return await updateRiderRewardSettings(request.auth.uid, request.auth.token, input);
  } catch (error) {
    logger.warn("updateRiderRewardSettingsPolicy rejected", {
      uid: request.auth.uid,
      error: error instanceof Error ? error.message.slice(0, 160) : "unknown",
    });
    throw asHttpsError(error);
  }
});

/**
 * Read-only owner/manager/admin restaurant settlement view. A result is
 * explicitly incomplete and withholds the payable balance unless immutable
 * ledger coverage and semantic integrity are both verified.
 */
export const getRestaurantSettlementSummary = onCall({
  region: REGION,
  invoker: "public",
  enforceAppCheck: true,
  timeoutSeconds: 20,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) {
    throw asHttpsError(new DomainError("unauthenticated", "Sign in to view restaurant finances."));
  }
  try {
    const input = parse(restaurantSettlementQuerySchema, request.data ?? {});
    return await readRestaurantSettlementSummary(request.auth.uid, request.auth.token, input);
  } catch (error) {
    logger.warn("getRestaurantSettlementSummary rejected", {
      uid: request.auth.uid,
      error: error instanceof Error ? error.message.slice(0, 160) : "unknown",
    });
    throw asHttpsError(error);
  }
});

/**
 * A restaurant's own invoices, GST TCS, income-tax TDS and weekly payout runs
 * for up to three months, for the partner dashboard's Finance pages. Same
 * owner/manager/admin bar as getRestaurantSettlementSummary.
 */
export const getRestaurantTaxStatement = onCall({
  region: REGION,
  invoker: "public",
  enforceAppCheck: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) {
    throw asHttpsError(new DomainError("unauthenticated", "Sign in to view restaurant finances."));
  }
  try {
    const input = parse(restaurantTaxStatementSchema, request.data ?? {});
    return await readRestaurantTaxStatement(request.auth.uid, request.auth.token, input);
  } catch (error) {
    logger.warn("getRestaurantTaxStatement rejected", {
      uid: request.auth.uid,
      error: error instanceof Error ? error.message.slice(0, 160) : "unknown",
    });
    throw asHttpsError(error);
  }
});

// Partner-dashboard money calls (ads, payout report, TDS claims): signed in, App Check, logged refusals.
function financeCallable<T>(name: string, signedOut: string,
  schema: Parameters<typeof parse>[0], run: (uid: string, token: import("firebase-admin/auth").DecodedIdToken, input: T) => Promise<unknown>) {
  return onCall({region: REGION, invoker: "public", enforceAppCheck: true, timeoutSeconds: 30, memory: "256MiB"}, async (request) => {
    if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", signedOut));
    try {
      return await run(request.auth.uid, request.auth.token, parse(schema, request.data ?? {}) as T);
    } catch (error) {
      logger.warn(`${name} rejected`, {uid: request.auth.uid, error: error instanceof Error ? error.message.slice(0, 160) : "unknown"});
      throw asHttpsError(error);
    }
  });
}
export const getSponsoredListings = financeCallable("getSponsoredListings", "Sign in to see ads.",
  sponsoredListingsSchema, async (uid, token, input: {restaurantId: string}) => {
    const listing = await readSponsoredListings(uid, token, input);
    // What the ads did: people reached, taps, orders and money earned, per booking and in total.
    const results = await learning.adResultsForRestaurant(input.restaurantId, listing.bookings).catch((error) => {
      logger.warn("AD_RESULTS_FAILED", {restaurantId: input.restaurantId, error: String(error)});
      return null;
    });
    return {...listing, results};
  });
export const bookSponsoredListing = financeCallable("bookSponsoredListing", "Sign in to book ads.",
  bookSponsoredListingSchema, (uid, token, input: Parameters<typeof bookSponsoredListingFor>[2]) => bookSponsoredListingFor(uid, token, input));
export const cancelSponsoredListing = financeCallable("cancelSponsoredListing", "Sign in to cancel ads.",
  cancelSponsoredListingSchema, (uid, token, input: Parameters<typeof cancelSponsoredListingFor>[2]) => cancelSponsoredListingFor(uid, token, input));

// ---- Learning: customer signals, ad results, nightly models, the supervisor's report (services/learning) ----
/** What the customer app saw and did (looks, opens, adds, ad views and taps), sent in batches. */
export const recordAppEvents = onCall({region: REGION, invoker: "public", enforceAppCheck: true, timeoutSeconds: 20, memory: "256MiB"}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to continue."));
  try {
    return await learning.recordAppEvents(request.auth.uid, parse(learning.recordAppEventsSchema, request.data ?? {}));
  } catch (error) {
    logger.warn("recordAppEvents rejected", {uid: request.auth.uid, error: error instanceof Error ? error.message.slice(0, 160) : "unknown"});
    throw asHttpsError(error);
  }
});
/** Every store's and brand's ad results, with a CSV for advertisers. Staff only. */
export const getAdsReport = economicsCallable("getAdsReport", learning.adsReportSchema,
  (_uid, token, input) => learning.getAdsReport(token as import("firebase-admin/auth").DecodedIdToken, input as {days: number}));
/** Staff: train the models and write the supervisor's report now instead of waiting for the night. */
export const runLearningNow = onCall({region: REGION, invoker: "public", enforceAppCheck: true, timeoutSeconds: 540, memory: "1GiB", maxInstances: 1}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to continue."));
  try {
    return await learning.runLearningNow(request.auth.token);
  } catch (error) {
    logger.warn("runLearningNow rejected", {uid: request.auth.uid, error: error instanceof Error ? error.message.slice(0, 160) : "unknown"});
    throw asHttpsError(error);
  }
});
/** 3:20 am India time: train prep and travel models, forecast demand, refresh insights, write the report. */
export const trainScraveitModels = onSchedule({schedule: "20 3 * * *", timeZone: "Asia/Kolkata", region: REGION,
  timeoutSeconds: 540, memory: "1GiB", maxInstances: 1}, async () => {
  const summary = await learning.trainAll();
  logger.info("NIGHTLY_LEARNING_DONE", summary);
});

// Payout report straight from the ledger: carried balance, every deduction, and the UTR that paid each order.
export const getRestaurantPayoutReport = financeCallable("getRestaurantPayoutReport", "Sign in to view payouts.",
  restaurantPayoutReportSchema, (uid, token, input: Parameters<typeof readRestaurantPayoutReport>[2]) => readRestaurantPayoutReport(uid, token, input));
// TDS a restaurant deducted on Scraveit's commission: restaurants send it, Scraveit finance checks and refunds it.
export const submitTdsCommissionClaim = financeCallable("submitTdsCommissionClaim", "Sign in to send a TDS claim.",
  tdsClaims.submitTdsCommissionClaimSchema, (uid, token, input: tdsClaims.SubmitTdsCommissionClaimInput) => tdsClaims.submitTdsCommissionClaim(uid, token, input));
export const getTdsCommissionClaims = financeCallable("getTdsCommissionClaims", "Sign in to see TDS claims.",
  tdsClaims.tdsCommissionClaimsSchema, (uid, token, input: {restaurantId: string}) => tdsClaims.getTdsCommissionClaims(uid, token, input));
export const listTdsCommissionClaimsForReview = financeCallable("listTdsCommissionClaimsForReview", "Sign in to review TDS claims.",
  tdsClaims.tdsCommissionClaimsForReviewSchema, (uid, token, input: {status: string}) => tdsClaims.listTdsCommissionClaimsForReview(uid, token, input));
export const reviewTdsCommissionClaim = financeCallable("reviewTdsCommissionClaim", "Sign in to review TDS claims.",
  tdsClaims.reviewTdsCommissionClaimSchema, (uid, token, input: tdsClaims.ReviewTdsCommissionClaimInput) => tdsClaims.reviewTdsCommissionClaim(uid, token, input));
// Staff accounts the outlet owner makes: staff ID and password, and the features each person may use.
export const listRestaurantStaff = financeCallable("listRestaurantStaff", "Sign in to see your staff.",
  outletStaff.listRestaurantStaffSchema, (uid, token, input: {restaurantId: string}) => outletStaff.listRestaurantStaff(uid, token, input, firestoreDb, auth));
export const createRestaurantStaff = financeCallable("createRestaurantStaff", "Sign in to add staff.",
  outletStaff.createRestaurantStaffSchema, (uid, token, input: outletStaff.CreateRestaurantStaffInput) => outletStaff.createRestaurantStaff(uid, token, input, auth));
export const updateRestaurantStaff = financeCallable("updateRestaurantStaff", "Sign in to change staff access.",
  outletStaff.updateRestaurantStaffSchema, (uid, token, input: outletStaff.UpdateRestaurantStaffInput) => outletStaff.updateRestaurantStaff(uid, token, input, auth));
export const removeRestaurantStaff = financeCallable("removeRestaurantStaff", "Sign in to remove staff.",
  outletStaff.removeRestaurantStaffSchema, (uid, token, input: {restaurantId: string; uid: string}) => outletStaff.removeRestaurantStaff(uid, token, input, auth));

// Cashfree is the live gateway. Without its keys `configured` is false and checkout offers COD only.
const paymentGateway = new CashfreeGateway(liveCashfreeConfig);
/** PhonePe was never switched on; its webhook stays deployed but rejects everything. */
const phonePeGateway = new UnconfiguredPhonePeGateway();

async function handleCreatePaymentIntent(request: {
  auth?: {uid: string};
  data: unknown;
}): Promise<unknown> {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to start payment."));
  if (isWarmup(request.data)) return await warmUp();
  const input = parse(initiatePaymentSchema, request.data);
  return await initiatePayment(request.auth.uid, input, paymentGateway);
}

export const createPaymentIntent = onCall({
  cpu: 0.5, // hot path: half a CPU, quicker than gcf_gen1 (see lightCpu)
  region: REGION,
  secrets: CASHFREE_SECRETS,
  enforceAppCheck: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (request) => {
  try {
    return await handleCreatePaymentIntent(request);
  } catch (error) {
    throw asHttpsError(error);
  }
});

// The app's "Confirming your payment" screen asks this every few seconds.
export const checkOrderPayment = onCall({
  cpu: 0.5, // hot path: half a CPU, quicker than gcf_gen1 (see lightCpu)
  region: REGION,
  secrets: CASHFREE_SECRETS,
  enforceAppCheck: true,
  timeoutSeconds: 15,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to check this payment."));
  if (isWarmup(request.data)) return await warmUp();
  try {
    const input = parse(checkOrderPaymentSchema, request.data);
    return {orderId: input.orderId, status: await checkOrderPaymentStatus(request.auth.uid, input.orderId, paymentGateway)};
  } catch (error) {
    throw asHttpsError(error);
  }
});

// The customer's online payment didn't go through: cancel the unpaid order (the app then places it as cash on delivery).
export const cancelUnpaidOrder = onCall({
  region: REGION,
  secrets: CASHFREE_SECRETS,
  enforceAppCheck: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to change this order."));
  const uid = request.auth.uid;
  try {
    const input = parse(cancelUnpaidOrderSchema, request.data);
    const reason = input.reason === "cod" ? "Customer switched to cash on delivery after online payment did not go through" :
      "Customer cancelled after online payment did not go through";
    const order = await cancelUnpaidOnlineOrder(uid, input.orderId, reason,
      (orderId) => closeUnpaidPaymentAttempts(orderId, paymentGateway));
    logger.info("UNPAID_ORDER_CANCELLED", {orderId: order.id, reason: input.reason});
    return {orderId: order.id, status: order.status};
  } catch (error) {
    logger.warn("cancelUnpaidOrder rejected", {uid, error});
    throw asHttpsError(error);
  }
});

export const createPhonePeIntent = onCall({
  region: REGION,
  secrets: CASHFREE_SECRETS,
  enforceAppCheck: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (request) => {
  try {
    return await handleCreatePaymentIntent(request);
  } catch (error) {
    throw asHttpsError(error);
  }
});

export const phonePeWebhook = onRequest({
  region: REGION,
  timeoutSeconds: 30,
  memory: "256MiB",
  invoker: "public",
}, async (request, response) => {
  if (request.method !== "POST") {
    response.status(405).set("Allow", "POST").send("Method Not Allowed");
    return;
  }
  const rawBody = request.rawBody ?? Buffer.from("");
  const rawEventHash = callbackHash(rawBody);
  try {
    const result = await phonePeGateway.verifyWebhook(
      Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])),
      rawBody,
    );
    if (!result.verified) {
      logger.warn("Rejected unverified PhonePe callback", {reason: result.reason, callbackHash: rawEventHash});
      response.status(503).json({accepted: false, reason: result.reason});
      return;
    }
    // A production adapter reaches this branch only after independent PhonePe
    // signature/status verification. Canonical state, immutable ledger and
    // legacy projections are all idempotent under provider callback retries.
    await applyVerifiedPayment({...result, rawEventHash});
    response.status(200).json({accepted: true});
  } catch (error) {
    logger.error("Verified PhonePe callback could not be applied", {callbackHash: rawEventHash, error});
    // A non-2xx response asks the provider to retry. The payment transition and
    // ledger writes use deterministic identities, so a retry cannot duplicate
    // money movement.
    response.status(500).json({accepted: false, reason: "CALLBACK_APPLICATION_FAILED"});
  }
});

/**
 * Cashfree payment webhooks. Signed with our secret key and then re-checked
 * against Cashfree's order record before the order is marked paid or failed.
 */
export const cashfreeWebhook = onRequest({
  cpu: 0.5, // hot path: half a CPU, quicker than gcf_gen1 (see lightCpu)
  region: REGION,
  timeoutSeconds: 30,
  memory: "256MiB",
  maxInstances: 20,
  invoker: "public",
  secrets: CASHFREE_SECRETS,
}, async (request, response) => {
  if (request.method !== "POST") {
    response.status(405).set("Allow", "POST").send("Method Not Allowed");
    return;
  }
  const rawBody = request.rawBody ?? Buffer.from("");
  const rawEventHash = callbackHash(rawBody);
  try {
    const result = await paymentGateway.verifyWebhook(
      Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])),
      rawBody,
    );
    if (!result.verified) {
      // Events we don't act on (e.g. a failed try on an order that was then paid) are acknowledged so Cashfree stops resending.
      const ignored = result.reason.startsWith("IGNORED_");
      logger[ignored ? "info" : "warn"]("Cashfree callback not applied", {reason: result.reason, callbackHash: rawEventHash});
      response.status(ignored ? 200 : 401).json({accepted: false, reason: result.reason});
      return;
    }
    await applyVerifiedPayment({...result, rawEventHash});
    response.status(200).json({accepted: true});
  } catch (error) {
    logger.error("Verified Cashfree callback could not be applied", {callbackHash: rawEventHash, error});
    // Non-2xx makes Cashfree retry; payment and ledger writes are idempotent.
    response.status(500).json({accepted: false, reason: "CALLBACK_APPLICATION_FAILED"});
  }
});

/**
 * A cancelled order that was paid online gets its money back by itself: the
 * moment it is both cancelled and paid (cancelled after paying, or a payment
 * that landed after the customer gave up on it). Safe to repeat.
 */
export const refundCancelledPaidOrder = onDocumentUpdated({
  cpu: 0.5,
  document: "orders/{orderId}",
  region: REGION,
  retry: true,
  timeoutSeconds: 60,
  memory: "256MiB",
  secrets: CASHFREE_SECRETS,
}, async (event) => {
  const before = event.data?.before.data() as SavrivoOrder | undefined;
  const after = event.data?.after.data() as SavrivoOrder | undefined;
  if (!before || !after || after.status !== "Cancelled" || after.paymentState !== "paid") return;
  if (before.status === "Cancelled" && before.paymentState === "paid") return;
  const result = await refundCancelledOrderPayment(after.id, paymentGateway);
  logger[result === "rejected" ? "error" : "info"]("CANCELLED_ORDER_REFUND", {orderId: after.id, result});
});

/** Catches any refund the trigger above couldn't finish (Cashfree down, a crash between steps). */
export const sweepCancelledOrderRefunds = onSchedule({
  schedule: "every 30 minutes",
  region: REGION,
  timeoutSeconds: 120,
  memory: "256MiB",
  secrets: CASHFREE_SECRETS,
}, async () => {
  const snapshot = await firestoreDb.collection("orders")
    .where("status", "==", "Cancelled").where("paymentState", "==", "paid").limit(50).get();
  const counts: Record<string, number> = {};
  for (const doc of snapshot.docs) {
    try {
      const result = await refundCancelledOrderPayment(doc.id, paymentGateway);
      counts[result] = (counts[result] ?? 0) + 1;
      if (result === "rejected" || result === "refund_started") logger[result === "rejected" ? "error" : "info"]("CANCELLED_ORDER_REFUND", {orderId: doc.id, result, via: "sweep"});
    } catch (error) {
      counts.error = (counts.error ?? 0) + 1;
      logger.warn("CANCELLED_ORDER_REFUND_RETRY_LATER", {orderId: doc.id, error});
    }
  }
  if (snapshot.size) logger.info("CANCELLED_ORDER_REFUND_SWEEP", {checked: snapshot.size, ...counts});
});

/** Our checkout page (opens Cashfree's hosted checkout) and the page customers return to. */
export const cashfreeCheckout = onRequest({
  region: REGION,
  timeoutSeconds: 15,
  memory: "256MiB",
  maxInstances: 20,
  invoker: "public",
}, async (request, response) => {
  const query = Object.fromEntries(Object.entries(request.query).map(([k, v]) => [k, String(Array.isArray(v) ? v[0] : v ?? "").slice(0, 600)]));
  const {status, html} = cashfreeCheckoutPage(query, liveCashfreeConfig().env);
  response.status(status)
    .set("Content-Type", "text/html; charset=utf-8")
    .set("Cache-Control", "no-store")
    .set("Referrer-Policy", "no-referrer")
    .send(html);
});

export const dispatchOfferTimeout = onTaskDispatched({
  cpu: 0.5, // hot path: half a CPU, quicker than gcf_gen1 (see lightCpu)
  region: REGION,
  retryConfig: {maxAttempts: 5, minBackoffSeconds: 5, maxBackoffSeconds: 60, maxDoublings: 3},
  rateLimits: {maxConcurrentDispatches: 50, maxDispatchesPerSecond: 20},
}, async (request) => {
  const schema = z.object({orderId: z.string().min(1).max(120), attempt: z.number().int().min(0).max(100)}).strict();
  const input = parse(schema, request.data);
  await advanceDispatchOffer(input.orderId, input.attempt);
});

export const dispatchClaimRecoveryTask = onTaskDispatched({
  region: REGION,
  retryConfig: {maxAttempts: 8, minBackoffSeconds: 5, maxBackoffSeconds: 300, maxDoublings: 5},
  rateLimits: {maxConcurrentDispatches: 50, maxDispatchesPerSecond: 25},
}, async (request) => {
  const schema = z.object({
    orderId: z.string().min(1).max(120),
    operationId: z.string().min(1).max(180),
  }).strict();
  const input = parse(schema, request.data);
  const outcome = await recoverDispatchClaim(input.orderId, input.operationId);
  logger.info("RIDER_CLAIM_RECOVERY_TASK_COMPLETED", {...input, outcome});
});

/**
 * Immediate notification delivery remains the low-latency path. This worker
 * only reclaims events that had no token, a transient FCM failure, or an
 * expired worker lease. Per-event transactions make overlapping schedules
 * safe and prevent duplicate logical delivery.
 */
export const processNotificationOutbox = onSchedule({
  schedule: "every 1 minutes",
  region: REGION,
  timeoutSeconds: 300,
  memory: "256MiB",
}, async () => {
  const due = await listDueNotifications(Date.now(), 100);
  const workerRunId = `scheduled-${Date.now()}-${randomUUID()}`;
  const outcomes: Record<string, number> = {};
  for (let offset = 0; offset < due.length; offset += 20) {
    const batch = due.slice(offset, offset + 20);
    const results = await Promise.all(batch.map((record, index) => processNotification(
      record.eventId,
      `${workerRunId}-${offset + index}`,
      deliverNotificationRecord,
      record,
    )));
    for (const result of results) outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
  }
  logger.info("NOTIFICATION_OUTBOX_RUN_COMPLETED", {dueCount: due.length, outcomes});
});

/** Store hours: every store opens and closes itself at its saved times; a manual switch holds until the next one. */
export const storeHoursWatch = onSchedule({
  schedule: "every 1 minutes",
  region: REGION,
  timeoutSeconds: 120,
  memory: "256MiB",
}, async () => {
  const result = await applyStoreHours();
  if (result.opened || result.closed) logger.info("STORE_HOURS_WATCH", result);
});

/** Late kitchen orders: the store app says "Your order is getting late" even when it is closed. */
export const restaurantLateOrderWatch = onSchedule({
  schedule: "every 1 minutes",
  region: REGION,
  timeoutSeconds: 120,
  memory: "256MiB",
}, async () => {
  const now = Date.now();
  const snapshot = await ordersCollectionRef(firestoreDb).where("status", "in", ["Accepted", "Preparing"]).get();
  let sent = 0;
  for (const doc of snapshot.docs) {
    const order = doc.data() as SavrivoOrder;
    const reminder = lateReminderDue(order, now);
    if (reminder === null) continue;
    try {
      await notifyRestaurantOrderLate(order, reminder);
      sent++;
    } catch (error) {
      logger.warn("ORDER_LATE_PUSH_FAILED", {orderId: order.id, error: String(error)});
    }
  }
  logger.info("RESTAURANT_LATE_WATCH", {active: snapshot.size, sent});
});

/**
 * Finds customerBroadcasts whose scheduled time has arrived and enqueues a
 * real FCM push for each. Enqueueing is idempotent (deduplicationKey is the
 * broadcast id), so running this every minute against already-dispatched
 * broadcasts is safe; it only ever sends each one once. Delivery retries are
 * handled by the existing processNotificationOutbox worker above.
 */
export const dispatchCustomerBroadcasts = onSchedule({
  schedule: "every 1 minutes",
  region: REGION,
  timeoutSeconds: 120,
  memory: "256MiB",
}, async () => {
  const now = Date.now();
  const snapshot = await firestoreDb.collection("customerBroadcasts").get();
  const broadcasts = snapshot.docs.map((doc) => ({id: doc.id, ...(doc.data() as object)}) as {
    id: string;
    title: string;
    message: string;
    audience?: string;
    city?: string;
    area?: string;
    restaurantId?: string;
    deepLink?: string;
    active?: boolean;
    scheduledAt?: number;
    expiresAt?: number;
    repeat?: CustomerBroadcastRepeat;
  });
  const due = broadcasts.filter((broadcast) => broadcast.active !== false &&
    Number(broadcast.scheduledAt) > 0 && Number(broadcast.scheduledAt) <= now &&
    (!broadcast.expiresAt || Number(broadcast.expiresAt) > now));
  for (const broadcast of due) {
    try {
      await notifyCustomerBroadcast(broadcast as typeof broadcast & {scheduledAt: number});
      // Advance a recurring broadcast to its next occurrence, or retire a
      // one-time (or exhausted) one so this scan skips it going forward.
      const currentScheduledAt = Number(broadcast.scheduledAt);
      const next = computeNextBroadcastOccurrence(currentScheduledAt, broadcast.repeat);
      const ref = firestoreDb.collection("customerBroadcasts").doc(broadcast.id);
      if (next !== null && (!broadcast.expiresAt || next < Number(broadcast.expiresAt))) {
        await ref.update({scheduledAt: next});
      } else {
        await ref.update({active: false});
      }
    } catch (error) {
      logger.warn("CUSTOMER_BROADCAST_DISPATCH_FAILED", {broadcastId: broadcast.id, error});
    }
  }
  if (due.length) logger.info("CUSTOMER_BROADCAST_DISPATCH_RUN_COMPLETED", {dueCount: due.length});
});

/**
 * Refreshes the live rain signal every open restaurant's checkout relies on.
 * loadServerFees() only ever trusts a fresh "verified_weather" pricingSignals
 * entry, so a lookup failure here simply lets that signal go stale (no rain
 * fee) rather than risk writing a guessed one.
 */
export const checkRainPricingSignals = onSchedule({
  schedule: "every 15 minutes",
  region: REGION,
  timeoutSeconds: 120,
  memory: "256MiB",
  secrets: [GOOGLE_WEATHER_API_KEY],
}, async () => {
  const summary = await refreshRainPricingSignals(GOOGLE_WEATHER_API_KEY.value());
  logger.info("RAIN_PRICING_SIGNAL_RUN_COMPLETED", summary);
});

/**
 * Reconciles the narrow failure window between rider-claim reservation,
 * canonical order assignment, and projection fan-out. It never chooses a
 * winner: the canonical order transaction remains the sole authority.
 */
export const reconcileExpiredDispatchClaims = onSchedule({
  schedule: "every 5 minutes",
  region: REGION,
  timeoutSeconds: 300,
  memory: "256MiB",
}, async () => {
  const summary = await recoverExpiredDispatchClaims(100);
  logger.info("RIDER_CLAIM_RECOVERY_RUN_COMPLETED", summary);
});

/** Expires unspent wallet money (cashback / referral credit) past its date. */
export const expireCustomerWalletLots = onSchedule({
  schedule: "every day 03:30",
  timeZone: "Asia/Kolkata",
  region: REGION,
  timeoutSeconds: 300,
  memory: "256MiB",
}, async () => {
  const result = await expireWalletLots(Date.now());
  logger.info("WALLET_EXPIRY_RUN_COMPLETED", result);
  // Rider referrals past their qualification deadline release their budget.
  const expiredReferrals = await expireRiderReferrals();
  logger.info("RIDER_REFERRAL_EXPIRY_RUN_COMPLETED", {expiredReferrals});
});

// Copies older ledger journals into the per-rider / per-restaurant index.
// New journals are indexed as they are written; once the backlog is done,
// finance screens read only their own party's journals and this run is a
// single state-document read.
export const backfillLedgerPartyJournals = onSchedule({
  schedule: "every 15 minutes",
  region: REGION,
  timeoutSeconds: 300,
  memory: "256MiB",
}, async () => {
  const result = await backfillLedgerPartyIndex();
  if (result.indexed > 0 || !result.complete) logger.info("LEDGER_PARTY_INDEX_BACKFILL", result);
});

export const sweepRiderTds = onSchedule({
  schedule: "every 60 minutes",
  region: REGION,
  timeoutSeconds: 300,
  memory: "256MiB",
}, async () => {
  await sweepRiderContractorTds();
});

export const settleRiderIncentivePeriods = onSchedule({
  schedule: "every 15 minutes",
  region: REGION,
  timeoutSeconds: 300,
  memory: "256MiB",
}, async (event) => {
  const parsed = Date.parse(String((event as {scheduleTime?: string}).scheduleTime ?? ""));
  const referenceAt = Number.isFinite(parsed) ? parsed : Date.now();
  const summary = await settleQualifiedRiderRewardPeriods(referenceAt);
  logger.info("RIDER_INCENTIVE_SETTLEMENT_RUN_COMPLETED", {
    referenceAt,
    settledCount: summary.settledCount,
    journalIds: summary.journalIds,
  });
});

export const settleWeeklyFinancePayouts = onSchedule({
  schedule: "every 15 minutes",
  region: REGION,
  // Cashfree Payouts keys (founder 17 Nov 2026); without them every payout is held.
  secrets: CASHFREE_PAYOUT_SECRETS,
  timeoutSeconds: 540,
  memory: "256MiB",
}, async (event) => {
  const parsed = Date.parse(String((event as {scheduleTime?: string}).scheduleTime ?? ""));
  const referenceAt = Number.isFinite(parsed) ? parsed : Date.now();
  const summary = await runWeeklyFinanceAutomation(referenceAt, undefined, selectPayoutGateway().gateway);
  if ((summary.status === "completed" || summary.status === "completed_with_blocks") && summary.periodKey &&
    Date.now() - summary.attemptedAt < 30 * 60_000) {
    const c = summary.counts;
    const needYou = c.blockedMissingEntity + c.blockedMissingCoverage + c.blockedInvalidBalance + c.blockedProfile + c.blockedProvider;
    await alertAdmins(`payout-run:${summary.periodKey}`, "Weekly payouts done",
      `${c.completed} paid, Rs ${Math.round(Number(summary.totalPaise ?? 0) / 100)} in total.` +
      (needYou ? ` ${needYou} need you: open Money.` : ""), "money");
  }
  logger.info("WEEKLY_FINANCE_AUTOMATION_RUN_COMPLETED", {
    referenceAt,
    periodKey: summary.periodKey,
    status: summary.status,
    counts: summary.counts,
    journalIds: summary.journalIds,
    nextRunDayKey: summary.nextRunDayKey,
  });
});

/** Every persisted claim lease gets its own recovery task. Trigger retry
 * guarantees scheduling even if the rider callable exits after reservation. */
export const onDispatchClaimWritten = onDocumentWritten({
  cpu: 0.5, // hot path: half a CPU, quicker than gcf_gen1 (see lightCpu)
  document: "dispatchQueue/{orderId}",
  region: REGION,
  retry: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (event) => {
  type DispatchClaim = {operationId?: string; leaseUntil?: number; state?: string};
  const before = event.data?.before.exists ? (event.data.before.data() as {claim?: DispatchClaim}).claim ?? null : null;
  const claim = event.data?.after.exists ? (event.data.after.data() as {claim?: DispatchClaim}).claim ?? null : null;
  if (!claim || !["reserved", "order_committed"].includes(String(claim.state ?? "reserved"))) return;
  // Firestore triggers fire on the whole document; the RTDB trigger this
  // replaces scoped itself to the `claim` child path directly, so only react
  // here when the claim itself actually changed.
  if (before && JSON.stringify(before) === JSON.stringify(claim)) return;
  const operationId = String(claim.operationId ?? "").trim();
  const leaseUntil = Number(claim.leaseUntil ?? 0);
  if (!operationId || !Number.isSafeInteger(leaseUntil) || leaseUntil < 0) {
    logger.warn("RIDER_CLAIM_RECOVERY_TASK_NOT_SCHEDULED", {
      orderId: String(event.params.orderId),
      reason: "invalid_claim_lease",
    });
    return;
  }
  await scheduleDispatchClaimRecovery(String(event.params.orderId), operationId, leaseUntil);
  logger.info("RIDER_CLAIM_RECOVERY_TASK_SCHEDULED", {
    orderId: String(event.params.orderId),
    operationId,
    leaseUntil,
    state: String(claim.state ?? "reserved"),
  });
});

export const onOrderCreated = onDocumentCreated({
  cpu: 0.5, // hot path: half a CPU, quicker than gcf_gen1 (see lightCpu)
  document: "orders/{orderId}",
  region: REGION,
  retry: true,
  timeoutSeconds: 60,
  memory: "256MiB",
}, async (event) => {
  const rawOrder = event.data?.data() as SavrivoOrder | undefined;
  if (!rawOrder) return;
  // A retry can run after the order has already advanced. Always reconcile
  // and notify from the latest canonical value, never from the old event body.
  const latestSnapshot = await orderRef(firestoreDb, rawOrder.id).get();
  const latest = latestSnapshot.exists ? latestSnapshot.data() as SavrivoOrder : null;
  const order = await scrubLegacyPublicOtp(latest ?? rawOrder);
  // Taste signal for the customer and an "order" for the city's ranking (once per order).
  await sideEffectLease(`learning-order-placed:${order.id}`, async () => {
    const restaurantSnapshot = await restaurantRef(firestoreDb, order.restaurantId).get();
    if (restaurantSnapshot.exists) await learning.noteOrderPlaced(order, restaurantSnapshot.data() as CatalogRestaurant);
  }).catch((error) => logger.warn("ORDER_PLACED_SIGNAL_FAILED", {orderId: order.id, error: String(error)}));
  // A multi-restaurant part on hold is released (projected and announced) by
  // createClusterOrder once every restaurant's part exists.
  if (order.clusterHold === true) {
    logger.info("CLUSTER_PART_HELD", {orderId: order.id, clusterId: order.clusterId});
    return;
  }
  await reconcileRestaurantOrderProjection(order);
  await reconcileRestaurantWorkload(order);
  await reconcileOperationalOrderProjection(order);
  logger.info("ORDER_CREATED_TRIGGER", {orderId: order.id, status: order.status});
  if (order.status !== "Order placed") {
    logger.info("STALE_NEW_ORDER_EVENT_IGNORED", {orderId: order.id, status: order.status});
    return;
  }
  // An unpaid online order can't be accepted, so it rings only once its payment is verified (onOrderUpdated).
  if (awaitingOnlinePayment(order)) {
    logger.info("NEW_ORDER_PUSH_WAITING_FOR_PAYMENT", {orderId: order.id, paymentState: order.paymentState});
    return;
  }
  await sideEffectLease(`restaurant-new-order:${order.id}`, async () => {
    logger.info("NEW_ORDER_PUSH_REQUESTED", {orderId: order.id, restaurantId: order.restaurantId});
    await notifyRestaurantNewOrder(order);
  });
});

function awaitingOnlinePayment(order: SavrivoOrder): boolean {
  return requiresVerifiedOnlinePaymentBeforeProgress(order, "Accepted");
}

/** Relay (TURN) credentials for one voice/video call between friends. */
export const callIceServers = onCall({
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 15,
  memory: "256MiB",
  maxInstances: 20,
  secrets: CALL_SECRETS,
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to call."));
  try {
    return await iceServersFor(request.auth.uid);
  } catch (error) {
    throw asHttpsError(error);
  }
});

/** A call started or stopped: ring the friend's phone, stop the ringing, log the call in the chat. */
export const onCallWritten = onDocumentWritten({
  cpu: 0.5, // hot path: half a CPU, quicker than gcf_gen1 (see lightCpu)
  document: "calls/{callId}",
  region: REGION,
  retry: false,
  timeoutSeconds: 30,
  memory: "256MiB",
  maxInstances: 20,
}, async (event) => {
  const before = event.data?.before?.exists ? event.data.before.data() as Record<string, unknown> : null;
  const after = event.data?.after?.exists ? event.data.after.data() as Record<string, unknown> : null;
  await handleCallWritten(String(event.params.callId), before, after)
    .catch((error) => logger.warn("CALL_TRIGGER_FAILED", {callId: event.params.callId, error: String(error)}));
});

/**
 * The friend's phone got the call push and is ringing (it sends the key that came in the push);
 * the caller's screen goes from "Calling…" to "Ringing…". Public: the key is the proof.
 */
export const callRang = onRequest({
  region: REGION,
  timeoutSeconds: 10,
  memory: "256MiB",
  maxInstances: 10,
  invoker: "public",
}, async (request, response) => {
  if (request.method !== "POST") {
    response.status(405).set("Allow", "POST").send("Method Not Allowed");
    return;
  }
  const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
  const ok = await confirmRinging(String(body.callId ?? ""), String(body.key ?? ""))
    .catch((error) => { logger.warn("CALL_RANG_FAILED", {error: String(error)}); return false; });
  response.status(ok ? 204 : 404).end();
});

/**
 * Cash orders: an AI agent phones the customer to confirm, in Telugu or English.
 * Off until settings/voiceAgent.enabled is true. No retry: a retried trigger must
 * never ring the customer twice (startConfirmationCall also checks its own record).
 */
export const onCodOrderConfirmCall = onDocumentCreated({
  document: "orders/{orderId}",
  region: REGION,
  retry: false,
  timeoutSeconds: 60,
  memory: "256MiB",
  maxInstances: 5,
  secrets: VOICE_AGENT_SECRETS,
}, async (event) => {
  const order = event.data?.data() as SavrivoOrder | undefined;
  if (!order || order.paymentMethod !== "cod") return;
  await sideEffectLease(`cod-confirm-call:${order.id}`, async () => {
    await startConfirmationCall(order, voiceAgentDeps());
  }).catch((error) => logger.warn("VOICE_CONFIRM_START_FAILED", {orderId: order.id, error: String(error)}));
});

/** Plivo's call callbacks and the agent's audio. Each URL carries that call's own secret token. */
export const voiceAgent = onRequest({
  region: REGION,
  timeoutSeconds: 30,
  memory: "256MiB",
  maxInstances: 10,
  invoker: "public",
  secrets: VOICE_AGENT_SECRETS,
}, async (request, response) => {
  const flat = (source: unknown): Record<string, string> => Object.fromEntries(Object.entries((source ?? {}) as Record<string, unknown>)
    .map(([k, v]) => [k, String(Array.isArray(v) ? v[0] : v ?? "").slice(0, 2000)]));
  try {
    const result = await handleVoiceWebhook(flat(request.query), request.method === "POST" ? flat(request.body) : {}, voiceAgentDeps());
    response.status(result.status).set("Content-Type", result.contentType).send(result.body);
  } catch (error) {
    logger.error("VOICE_AGENT_WEBHOOK_FAILED", {error: error instanceof Error ? error.message : "unknown"});
    response.status(200).set("Content-Type", "application/xml").send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Hangup/></Response>");
  }
});

export const onOrderUpdated = onDocumentUpdated({
  cpu: 0.5, // hot path: half a CPU, quicker than gcf_gen1 (see lightCpu)
  secrets: [GOOGLE_WEATHER_API_KEY], // Google campus check at pickup (services/campus.ts)
  document: "orders/{orderId}",
  region: REGION,
  retry: true,
  timeoutSeconds: 60,
  memory: "256MiB",
}, async (event) => {
  const before = event.data?.before.data() as SavrivoOrder | undefined;
  const rawOrder = event.data?.after.data() as SavrivoOrder | undefined;
  if (!before || !rawOrder) return;
  // A retry can fire long after the order has advanced further (this trigger
  // is configured with retry: true). Replaying a superseded status here would
  // rewrite riderJobs/dispatchQueue/riderPresence back to that old status,
  // visibly reverting an in-progress delivery in the rider app. Confirm this
  // event still matches the canonical order before acting on it.
  const latestSnapshot = await orderRef(firestoreDb, rawOrder.id).get();
  const latestForEvent = latestSnapshot.exists ? latestSnapshot.data() as SavrivoOrder : null;
  if (!latestForEvent || Number(latestForEvent.updatedAt) !== Number(rawOrder.updatedAt)) {
    logger.info("STALE_ORDER_UPDATE_EVENT_IGNORED", {
      orderId: rawOrder.id,
      eventStatus: rawOrder.status,
      latestStatus: latestForEvent?.status,
    });
    return;
  }
  const order = await scrubLegacyPublicOtp(rawOrder);
  await reconcileRestaurantOrderProjection(order);
  await reconcileRestaurantWorkload(order);
  await reconcileOperationalOrderProjection(order);
  // Online payment just verified: now ring the restaurant (the same lease as onOrderCreated, so it rings once).
  if (before.paymentState !== "paid" && order.paymentState === "paid" && order.status === "Order placed" && order.clusterHold !== true) {
    await sideEffectLease(`restaurant-new-order:${order.id}`, async () => {
      logger.info("NEW_ORDER_PUSH_REQUESTED", {orderId: order.id, restaurantId: order.restaurantId, after: "payment"});
      await notifyRestaurantNewOrder(order);
    });
  }
  // Delivered or cancelled: a training row for the learned models, the Ad's credit, the group-order outcome.
  if ((before.status !== "Delivered" && order.status === "Delivered") || (before.status !== "Cancelled" && order.status === "Cancelled")) {
    await sideEffectLease(`learning-outcome:${order.id}:${order.status}`, () => learning.recordOrderOutcome(before, order))
      .catch((error) => logger.warn("LEARNING_OUTCOME_FAILED", {orderId: order.id, error: String(error)}));
  }
  // The first pickup of a shared trip was cancelled: its other pickups go to any rider.
  if (before.status !== "Cancelled" && order.status === "Cancelled" && order.clusterTrip?.leadOrderId === order.id) {
    await releaseTripFollowers(order)
      .catch((error) => logger.warn("BUNDLE_FOLLOWER_RELEASE_FAILED", {orderId: order.id, error: String(error)}));
  }
  // Delivered: friends see an "eating now" ring on the customer's photo for 30 minutes.
  if (before.status !== "Delivered" && order.status === "Delivered") {
    await chatFun.markEatingNow(order)
      .catch((error) => logger.warn("EATING_NOW_FAILED", {orderId: order.id, error: String(error)}));
  }
  // A parent who paid for this order follows it on their own home screen.
  if (order.payerUid && (before.status !== order.status || before.riderName !== order.riderName || before.paymentState !== order.paymentState)) {
    await parentPay.mirrorOrderToParent(order, before)
      .catch((error) => logger.warn("PARENT_PAY_MIRROR_FAILED", {orderId: order.id, error: String(error)}));
  }
  if (["Accepted", "Preparing", "Ready for pickup"].includes(order.status) && !order.riderId && order.selfDelivery === true) {
    await assignStoreAsRider(order);
  } else if (["Accepted", "Preparing", "Ready for pickup"].includes(order.status) && !order.riderId) {
    const queueSnapshot = await dispatchQueueRef(firestoreDb, order.id).get();
    const queue = queueSnapshot.exists ? queueSnapshot.data() as {status?: string} : null;
    if (!queue || queue.status === "exhausted") await beginSequentialDispatch(order);
  }
  // A refund after delivery takes back any cashback that is still unspent.
  if (before.paymentState !== "refunded" && order.paymentState === "refunded") {
    await sideEffectLease(`cashback-reversal:${order.id}:refund`, async () => {
      await reverseCashbackForOrder(order, "order refunded", await orderAttribution(order));
    });
    // A refunded order no longer counts toward a rider referral target.
    if (order.riderId) await reverseRiderReferralDelivery(order);
    // Returns: Section 52 TCS return adjustment for the period; TDS kept for reconciliation; delivery settlement reversed.
    await sideEffectLease(`tax-withholding:${order.id}:refund`, async () => {
      await reverseOrderTaxWithholding(order.id, Number(order.updatedAt ?? Date.now()));
    });
  }
  if (before.status === order.status) return;
  logger.info("ORDER_STATUS_CHANGED", {
    orderId: order.id,
    fromStatus: before.status,
    toStatus: order.status,
  });

  if (order.status === "Cancelled") {
    // `set(..., {merge: true})` throughout: unlike RTDB's forgiving multi-path
    // update(), Firestore's update()/batch update() throws NOT_FOUND for a
    // document that was never created (e.g. dispatch never started for this
    // order), and a batch's atomicity means one such miss would fail every
    // write in it.
    const batch: WriteBatchLike = firestoreDb.batch();
    batch.set(dispatchQueueRef(firestoreDb, order.id), {active: false, status: "cancelled"}, {merge: true});
    batch.delete(trackingEvidenceRef(firestoreDb, order.id));
    batch.delete(deliveryCampusRef(firestoreDb, order.id));
    batch.delete(deliveryOtpRef(firestoreDb, order.id));
    if (order.riderId) {
      batch.set(riderJobRef(firestoreDb, order.riderId, order.id), {status: "cancelled"}, {merge: true});
    }
    await Promise.all([
      batch.commit(),
      // `tracking` still lives in RTDB - the rider app's live-location writes
      // have not migrated off it yet.
      db.ref(`${ROOT}/tracking/${order.id}`).remove(),
      db.ref(`${ROOT}/trackingProximity/${order.id}`).remove(),
      db.ref(`${ROOT}/trackingAssignments/${order.id}`).remove(),
      db.ref(`${ROOT}/trackingViewers/${order.id}`).remove(),
    ]);
    await cancelDispatchOffers(order.id, "cancelled");
    // A cancelled order must not keep spending an offer's budget or a
    // customer's one-time use. Idempotent: the redemption record guards it.
    await releasePromotionSpend(order.id);
    await recordOrderEconomicsOutcome(order);
    // Wallet money used on a cancelled order goes back to the customer, once.
    await restoreWalletRedemption(order.id);
    if (before.riderId) {
      await recordRiderRewardOrderCancelledAfterAccept(
        before.riderId,
        order.id,
        Number.isFinite(Number(order.updatedAt)) ? Number(order.updatedAt) : Date.now(),
      );
    }
  }
  // A self-delivering store has no rider app, presence or rewards: skip the rider-side projections.
  if (order.riderId && order.selfDelivery !== true) {
    const jobRef = riderJobRef(firestoreDb, order.riderId, order.id);
    const existingJobSnapshot = await jobRef.get();
    const existingJob = existingJobSnapshot.exists ? existingJobSnapshot.data() as Record<string, unknown> : null;
    // A rider can be pre-assigned and record verified restaurant arrival
    // (phase "at_restaurant") before the kitchen marks Ready for pickup. That
    // later transition auto-promotes the order back through the "Assigned"
    // branch below - passing the existing job here lets
    // buildRiderJobProjection's phase-rank guard keep the verified arrival
    // instead of reverting the rider's screen to "I have arrived at the
    // restaurant" again.
    const jobProjection = buildRiderJobProjection(order, existingJob);
    if (order.status === "Assigned") {
      const batch: WriteBatchLike = firestoreDb.batch();
      batch.set(jobRef, jobProjection);
      batch.set(dispatchQueueRef(firestoreDb, order.id), {
        status: "assigned",
        active: false,
        updatedAt: order.updatedAt,
      }, {merge: true});
      await Promise.all([
        batch.commit(),
        db.ref(`${ROOT}/riderPresence/${order.riderId}/activeOrderId`).set(order.id),
        db.ref(`${ROOT}/trackingAssignments/${order.id}`).set({riderId: order.riderId, customerId: order.customerId,
          assignedAt: order.riderAssignedAt ?? order.updatedAt}),
      ]);
    } else {
      await jobRef.set(jobProjection);
    }
    if (order.status === "Arrived") {
      await recoverExhaustedDispatchesForFinishingRider(order.riderId);
    }
    if (order.status === "Handed to rider") {
      await recordRiderRewardOrderPickedUp(
        order.riderId,
        order.id,
        Number.isFinite(Number(order.updatedAt)) ? Number(order.updatedAt) : Date.now(),
      );
      // Is the customer's pin inside a college, school or hospital? Asked once per order
      // (cached per pin); any failure leaves the order on the normal arrival rules.
      await sideEffectLease(`delivery-campus:${order.id}`, async () => {
        await recordDeliveryCampus(order, GOOGLE_WEATHER_API_KEY.value()).catch((error) =>
          logger.warn("DELIVERY_CAMPUS_FAILED", {orderId: order.id, error: String(error)}));
      });
    }
  }
  if (order.status === "Delivered") {
    await recordCodLedger(order);
    await recordOnlinePaymentLedger(order);
    await recordOrderEconomicsOutcome(order);
    if (order.economics) {
      const attribution = await orderAttribution(order);
      await sideEffectLease(`cashback:${order.id}`, async () => {
        await earnCashbackForDeliveredOrder(order, attribution);
      });
      await sideEffectLease(`customer-referral:${order.id}`, async () => {
        await qualifyCustomerReferralOnDelivery(order, attribution);
      });
    }
    if (order.selfDelivery !== true) {
      await sideEffectLease(`rider-rewards:${order.id}`, async () => {
        await evaluateRiderRewardsForDeliveredOrder(order);
      });
      await sideEffectLease(`rider-delivered-count:${order.id}`, async () => {
        await recordRiderDeliveredOrder(order);
      });
    }
    // GST TCS and income-tax TDS withheld from the seller, and the order's
    // invoice numbers (no-op for orders priced before the tax engine was on).
    await sideEffectLease(`tax-withholding:${order.id}`, async () => {
      await recordDeliveredOrderTax(order);
    });
    // Before the tracking data goes: learn this campus's real gate if it was handed over outside the box.
    await recordCampusHandover(order).catch((error) =>
      logger.warn("CAMPUS_GATE_LEARN_FAILED", {orderId: order.id, error: String(error)}));
    const batch: WriteBatchLike = firestoreDb.batch();
    batch.delete(trackingEvidenceRef(firestoreDb, order.id));
    batch.delete(deliveryCampusRef(firestoreDb, order.id));
    batch.delete(deliveryOtpRef(firestoreDb, order.id));
    await Promise.all([
      batch.commit(),
      db.ref(`${ROOT}/tracking/${order.id}`).remove(),
      db.ref(`${ROOT}/trackingProximity/${order.id}`).remove(),
      db.ref(`${ROOT}/trackingAssignments/${order.id}`).remove(),
      db.ref(`${ROOT}/trackingViewers/${order.id}`).remove(),
      ...(order.riderId ? [db.ref(`${ROOT}/riderPresence/${order.riderId}/activeOrderId`).remove()] : []),
    ]);
  }

  // Rider assignment has one authoritative, order-scoped notification lease.
  // Early dispatch can assign a rider while the kitchen is still preparing;
  // when Ready later advances to Assigned, routing through the generic status
  // notifier used to send the same "Delivery partner assigned" message again.
  const customerNotification = order.status === "Assigned" && order.riderId
    ? notifyCustomerRiderAssigned(order)
    : sideEffectLease(`customer-status:${order.id}:${order.status}`, () => notifyCustomerStatus(order));
  const notifications: Promise<void>[] = [customerNotification];
  if (before.status === "Order placed") {
    notifications.push(sideEffectLease(`stop-restaurant-alarm:${order.id}`, async () => {
      logger.info("STOP_ORDER_ALARM_PUSH_REQUESTED", {orderId: order.id, status: order.status});
      await stopRestaurantAlarm(order);
    }));
  }
  if (order.status === "Assigned" && order.riderId) {
    notifications.push(sideEffectLease(`stop-rider-offers:${order.id}`, async () => {
      const queueSnapshot = await dispatchQueueRef(firestoreDb, order.id).get();
      const queue = queueSnapshot.exists ? queueSnapshot.data() as {candidates?: Array<{riderId?: string}>} : null;
      await stopRiderOffers((queue?.candidates ?? []).map((candidate) => String(candidate.riderId ?? "")).filter(Boolean), order.id, order.riderId!);
    }));
  }
  await Promise.all(notifications);
});

/**
 * Keeps each restaurant's citySort index value in step with its name and city.
 *
 * Maintained here rather than in the apps because the catalogue is written by
 * the admin app, the restaurant app and the onboarding flow, and an index that
 * only some writers maintain is worse than none - it makes a restaurant
 * silently unlistable. Writing the value re-fires this trigger, which is why
 * it writes only when the stored value is genuinely stale.
 */
/**
 * The search-token index (`catalogSearchTokens/{cityKey}`) is a client-read
 * type-ahead structure only - nothing in Cloud Functions queries it. It moves
 * to Firestore here to stay consistent with `restaurants` (its source data),
 * rather than leaving it stranded on RTDB as a second database the reindexer
 * would need to keep in sync across two systems.
 */
// Each token entry is its own document, in a subcollection keyed by city -
// not a field on one shared document. A client's type-ahead needs to range
// over the key space itself (every entry whose key starts with the typed
// prefix), and Firestore can only do that kind of prefix range query against
// document IDs (`orderBy(FieldPath.documentId())` + `startAt`/`endAt`), never
// against field names inside a single document.
async function applyCatalogSearchTokenUpdates(tokenUpdates: Record<string, true | null>): Promise<void> {
  const batch: WriteBatchLike = firestoreDb.batch();
  for (const [path, value] of Object.entries(tokenUpdates)) {
    const separatorIndex = path.indexOf("/");
    const cityKey = path.slice(0, separatorIndex);
    const key = path.slice(separatorIndex + 1);
    const ref = firestoreDb.collection("catalogSearchTokens").doc(cityKey).collection("tokens").doc(key);
    if (value === null) batch.delete(ref);
    else batch.set(ref, {value: true});
  }
  await batch.commit();
}

export const onCatalogRestaurantWritten = onDocumentWritten({
  document: "restaurants/{restaurantId}",
  region: REGION,
  retry: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (event) => {
  const restaurantId = String(event.params.restaurantId);
  const before = event.data?.before.exists
    ? {...(event.data.before.data() as Record<string, unknown>), id: restaurantId} : null;
  const after = event.data?.after.exists
    ? {...(event.data.after.data() as Record<string, unknown>), id: restaurantId} : null;

  // The word index has to be maintained on deletion too - a restaurant that is
  // gone must stop being findable, and only `before` knows what to remove.
  const tokenUpdates = searchTokenUpdates(before, after);
  if (Object.keys(tokenUpdates).length > 0) {
    await applyCatalogSearchTokenUpdates(tokenUpdates);
    logger.info("CATALOG_SEARCH_TOKENS_REINDEXED", {
      restaurantId,
      added: Object.values(tokenUpdates).filter((value) => value === true).length,
      removed: Object.values(tokenUpdates).filter((value) => value === null).length,
    });
  }

  if (!after) return;
  // Bank details must never stay on the public listing.
  const legacyPayout = (after as {payoutProfile?: unknown}).payoutProfile;
  if (legacyPayout && typeof legacyPayout === "object") {
    await movePayoutProfileToPrivate(firestoreDb, restaurantId, legacyPayout, FieldValue.delete());
    logger.info("RESTAURANT_PAYOUT_PROFILE_MADE_PRIVATE", {restaurantId});
    return;
  }
  const restaurant = after as {
    name?: unknown; city?: unknown; lat?: unknown; lng?: unknown;
    citySort?: unknown; geoSort?: unknown; geoSortGlobal?: unknown;
  };
  const source = {id: restaurantId, name: restaurant.name, city: restaurant.city};
  const geoSource = {id: restaurantId, city: restaurant.city, lat: restaurant.lat, lng: restaurant.lng};

  // Writing only when a stored value is actually wrong is what stops this
  // trigger re-firing on its own write. All three sort keys go in one update
  // so a restaurant is never indexed by name or position in one but not the
  // others.
  const fields: Record<string, unknown> = {};
  if (citySortNeedsUpdate(source, restaurant.citySort)) fields.citySort = citySortValue(source);
  if (geoSortNeedsUpdate(geoSource, restaurant.geoSort)) {
    // A restaurant with no usable coordinates has no place in the proximity
    // index; clearing it is what removes one that used to have them.
    fields.geoSort = geoSortValue(geoSource) || FieldValue.delete();
  }
  if (geoSortGlobalNeedsUpdate(geoSource, restaurant.geoSortGlobal)) {
    fields.geoSortGlobal = geoSortGlobalValue(geoSource) || FieldValue.delete();
  }
  if (Object.keys(fields).length === 0) return;

  await restaurantRef(firestoreDb, restaurantId).update(fields);
  logger.info("CATALOG_SORT_KEYS_REINDEXED", {restaurantId, ...fields});
});

export const onRiderPresenceUpdated = onValueWritten({
  ref: `/${ROOT}/riderPresence/{riderId}`,
  instance: DATABASE_INSTANCE,
  region: DATABASE_REGION,
  retry: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (event) => {
  const riderId = String(event.params.riderId);
  const before = event.data.before.exists() ? event.data.before.val() as Presence : null;
  const after = event.data.after.exists() ? event.data.after.val() as Presence : null;
  await updateRiderAvailabilityIndex(riderId, before, after);
  await recoverExhaustedDispatchesForRider(riderId, before, after);
  const eventAt = Date.parse(String(event.time ?? ""));
  const recordedAt = Number.isFinite(eventAt)
    ? eventAt
    : Number.isFinite(Number(after?.updatedAt))
      ? Number(after?.updatedAt)
      : Date.now();
  await recordRiderRewardPresenceUpdate(riderId, before, after, recordedAt);
});

/** Keep dispatch candidate selection bounded to one private projection read.
 * Claiming an offer still revalidates every authoritative source inside the
 * race-safe assignment flow, so projection lag can never grant a delivery. */
export const onRiderProfileEligibilitySourceWritten = onDocumentWritten({
  document: "riders/{riderId}",
  region: REGION,
  retry: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (event) => {
  const parsed = Date.parse(String(event.time ?? ""));
  await refreshRiderDispatchEligibility(
    String(event.params.riderId),
    Number.isFinite(parsed) ? parsed : Date.now(),
  );
  // Creates the rider referral (terms frozen) when a referred rider applies.
  const after = event.data?.after?.data() as {referredByCode?: unknown; status?: unknown} | undefined;
  const before = event.data?.before?.data() as {status?: unknown} | undefined;
  if (after?.referredByCode && (after.status !== before?.status || !event.data?.before?.exists)) {
    await syncRiderReferralForProfile(String(event.params.riderId));
  }
});

export const onRiderWalletEligibilitySourceWritten = onDocumentWritten({
  document: "riderWallets/{riderId}",
  region: REGION,
  retry: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (event) => {
  const parsed = Date.parse(String(event.time ?? ""));
  await refreshRiderDispatchEligibility(
    String(event.params.riderId),
    Number.isFinite(parsed) ? parsed : Date.now(),
  );
});

export const onRiderJobEligibilitySourceWritten = onDocumentWritten({
  // `riderJobs` is a flat collection (doc id `{riderId}_{orderId}`), not the
  // nested RTDB path this replaces - both ids are read from the document's
  // own `riderId`/`orderId` fields (which buildRiderJobProjection always
  // sets) rather than parsed back out of the id, since a Firebase UID can in
  // principle itself contain "_".
  document: "riderJobs/{jobId}",
  region: REGION,
  retry: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (event) => {
  const parsed = Date.parse(String(event.time ?? ""));
  const eventAt = Number.isFinite(parsed) ? parsed : Date.now();
  const before = event.data?.before.exists ? event.data.before.data() as Record<string, unknown> : null;
  const after = event.data?.after.exists ? event.data.after.data() as Record<string, unknown> : null;
  const riderId = String((after ?? before)?.riderId ?? "");
  const orderId = String((after ?? before)?.orderId ?? "");
  if (!riderId || !orderId) {
    logger.warn("RIDER_JOB_EVENT_MISSING_IDENTIFIERS", {jobId: String(event.params.jobId)});
    return;
  }
  const workload = await reconcileRiderOperationalWorkload(riderId, orderId, before, after, eventAt);
  await refreshRiderDispatchEligibility(
    riderId,
    eventAt,
    {workload},
  );
});

// A self-delivering store finishes an order by typing the customer's delivery
// code into its order chat (the released Restaurant app has no delivered button).
export const onStoreDeliveryChatMessage = onDocumentCreated({
  document: "orderChats/{messageId}",
  region: REGION,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (event) => {
  const message = event.data?.data() as {orderId?: unknown; senderRole?: unknown; body?: unknown} | undefined;
  if (!message || message.senderRole !== "restaurant") return;
  try {
    await completeStoreDeliveryFromChat(message);
  } catch (error) {
    logger.warn("STORE_DELIVERY_CHAT_FAILED", {orderId: String(message.orderId ?? ""), error: String(error)});
  }
});

export const onReviewCreated = onDocumentCreated({
  // reviews/{customerId}_{orderId} - a client-written composite id (see
  // reviews.ts). Prefer the review's own `orderId` field as a known-length
  // suffix to split the id unambiguously; a Firebase UID can in principle
  // contain "_", so only the fallback (first "_") assumes customerId itself
  // never does.
  document: "reviews/{reviewId}",
  region: REGION,
  retry: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (event) => {
  const review = event.data?.data() as {orderId?: string; restaurantId?: string; riderId?: string; rating?: number; riderRating?: number; postDeliveryTip?: unknown; growthContribution?: unknown} | undefined;
  if (!review) return;
  const reviewId = String(event.params.reviewId);
  const suffixSeparator = review.orderId && reviewId.endsWith(`_${review.orderId}`)
    ? reviewId.length - review.orderId.length - 1
    : reviewId.indexOf("_");
  const customerId = suffixSeparator > 0 ? reviewId.slice(0, suffixSeparator) : "";
  const orderId = review.orderId || (suffixSeparator > 0 ? reviewId.slice(suffixSeparator + 1) : "");
  if (!customerId || !orderId) {
    logger.warn("REVIEW_TIP_IDENTIFIERS_UNRESOLVED", {reviewId});
    return;
  }
  const orderSnapshot = await orderRef(firestoreDb, orderId).get();
  const order = orderSnapshot.exists ? orderSnapshot.data() as SavrivoOrder : null;
  if (!order || order.status !== "Delivered" || order.customerId !== customerId) {
    logger.warn("REVIEW_TIP_ORDER_NOT_ELIGIBLE", {customerId, orderId});
    return;
  }
  if (review.riderId && review.riderId !== order.riderId) {
    logger.warn("REVIEW_TIP_RIDER_MISMATCH", {customerId, orderId});
    return;
  }
  if (review.restaurantId && review.restaurantId !== order.restaurantId) {
    logger.warn("REVIEW_RESTAURANT_MISMATCH", {customerId, orderId});
    return;
  }
  const result = await recordDeliveredReviewFeedback({
    customerId,
    orderId,
    restaurantId: order.restaurantId,
    riderId: order.riderId,
    restaurantRating: review.rating,
    riderRating: review.riderRating,
    postDeliveryTip: review.postDeliveryTip,
    growthContribution: review.growthContribution,
  });
  if (result.unverifiedMoneyDiscarded) {
    logger.warn("REVIEW_UNVERIFIED_MONEY_DISCARDED", {customerId, orderId});
  }
  logger.info("REVIEW_RATINGS_RECORDED", {orderId, restaurantId: order.restaurantId, riderId: order.riderId});
});

// Runs only for the last stretch to the door: the rider app copies its fixes to
// trackingProximity/{orderId} once within 1.2 km of the customer, so the arrival
// check no longer runs for every location update of the whole ride.
export const onTrackingUpdated = onValueWritten({
  cpu: 1, // time-critical: keeps a full CPU (see lightCpu)
  ref: `/${ROOT}/trackingProximity/{orderId}`,
  instance: DATABASE_INSTANCE,
  region: DATABASE_REGION,
  retry: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (event) => {
  const result = await processTrackingUpdate({
    orderId: String(event.params.orderId),
    eventId: event.id,
    authType: event.authType,
    ...(event.authId ? {authId: event.authId} : {}),
    before: event.data.before.exists() ? event.data.before.val() : null,
    after: event.data.after.exists() ? event.data.after.val() : null,
  });
  if (result.outcome === "transitioned") {
    logger.info("Tracking geofence advanced order", {orderId: event.params.orderId, status: result.status});
  }
});


// ---------------------------------------------------------------------------
// Economics engine control plane
// ---------------------------------------------------------------------------

function economicsCallable<S extends z.ZodTypeAny, R>(
  name: string,
  schema: S,
  handler: (uid: string, token: DecodedIdTokenLike, input: z.infer<S>) => Promise<R>,
  options: {secrets?: Array<(typeof CASHFREE_SECRETS)[number]>} = {},
) {
  // Admin and store set-up screens only: a few instances are plenty (and keep the project inside its CPU quota).
  return onCall({region: REGION, maxInstances: 10, enforceAppCheck: true, timeoutSeconds: 30, memory: "256MiB",
    ...(options.secrets ? {secrets: options.secrets} : {})}, async (request) => {
    if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to continue."));
    try {
      return await handler(request.auth.uid, request.auth.token, parse(schema, request.data ?? {}));
    } catch (error) {
      logger.warn(`${name} rejected`, {
        uid: request.auth.uid,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
      throw asHttpsError(error);
    }
  });
}

type DecodedIdTokenLike = Parameters<typeof readEconomicsControlForAdmin>[0];

export const getEconomicsControl = economicsCallable("getEconomicsControl", z.object({}).strict(),
  async (_uid, token) => {
    const [control, growthBudgets] = await Promise.all([
      readEconomicsControlForAdmin(token),
      listGrowthBudgetsForAdmin(token),
    ]);
    return {...control, growthBudgets};
  });

export const updateEconomicsControl = economicsCallable("updateEconomicsControl", updateEconomicsControlSchema,
  (uid, token, input) => updateEconomicsControlForAdmin(uid, token, input));

export const simulateEconomicsOffer = economicsCallable("simulateEconomicsOffer", simulateOfferSchema,
  (_uid, token, input) => simulateOfferForAdmin(token, input));

export const simulateEconomicsGuarantee = economicsCallable("simulateEconomicsGuarantee", simulateGuaranteeSchema,
  (_uid, token, input) => simulateGuaranteeForAdmin(token, input));

export const upsertPromotionPolicy = economicsCallable("upsertPromotionPolicy", upsertPromotionSchema,
  (uid, token, input) => upsertPromotionForAdmin(uid, token, input));

export const upsertGrowthBudget = economicsCallable("upsertGrowthBudget", upsertGrowthBudgetSchema,
  (uid, token, input) => upsertGrowthBudgetForAdmin(uid, token, input));

export const reviewRestaurantOffer = economicsCallable("reviewRestaurantOffer", reviewRestaurantOfferSchema,
  (uid, token, input) => reviewRestaurantOfferForAdmin(uid, token, input));

export const getCityEconomics = economicsCallable("getCityEconomics", cityEconomicsQuerySchema,
  (_uid, token, input) => readCityEconomics(token, input));

export const saveRestaurantOffer = economicsCallable("saveRestaurantOffer", restaurantOfferSchema,
  (uid, token, input) => upsertRestaurantOffer(uid, token, input));

export const saveRestaurantFreebies = economicsCallable("saveRestaurantFreebies", restaurantFreebiesSchema,
  (uid, token, input) => saveFreebiesForRestaurant(uid, token, input));

export const saveRestaurantPairings = economicsCallable("saveRestaurantPairings", restaurantPairingsSchema,
  (uid, token, input) => savePairingsForRestaurant(uid, token, input));

// Partner dashboard: an AI-written draft of a dish's menu description.
export const suggestDishDescription = economicsCallable("suggestDishDescription", dishDescriptionSchema,
  (uid, token, input) => writeDishDescription(uid, token as import("firebase-admin/auth").DecodedIdToken, input), {secrets: DISH_DESCRIPTION_SECRETS});

export const getRestaurantOffers = economicsCallable("getRestaurantOffers", restaurantOffersQuerySchema,
  (uid, token, input) => listRestaurantOffers(uid, token, input.restaurantId));

// ---------------------------------------------------------------------------
// Wallet, cashback, customer referrals, city P&L
// ---------------------------------------------------------------------------

const installIdSchema = z.string().trim().max(80).default("");

/** Customer: wallet balance, expiring money, history, live cashback offers and referral status. */
export const getCustomerWallet = economicsCallable("getCustomerWallet", z.object({installId: installIdSchema}).strict(),
  async (uid, _token, input) => {
    const [wallet, referral] = await Promise.all([readCustomerWallet(uid), readCustomerReferral(uid, input.installId)]);
    return {wallet, referral};
  });

export const applyCustomerReferral = economicsCallable("applyCustomerReferral",
  z.object({code: z.string().trim().min(4).max(200), installId: installIdSchema}).strict(),
  (uid, _token, input) => applyCustomerReferralCode(uid, input));

export const upsertCashbackCampaign = economicsCallable("upsertCashbackCampaign", cashbackCampaignSchema,
  (uid, token, input) => upsertCashbackCampaignForAdmin(uid, token, input));

export const listCashbackCampaigns = economicsCallable("listCashbackCampaigns", z.object({}).strict(),
  (_uid, token) => listCashbackCampaignsForAdmin(token));

export const listCustomerReferrals = economicsCallable("listCustomerReferrals", z.object({}).strict(),
  (_uid, token) => listCustomerReferralsForAdmin(token));

export const reviewCustomerReferral = economicsCallable("reviewCustomerReferral",
  z.object({referredUid: z.string().trim().min(1).max(128), decision: z.enum(["approved", "rejected"]), reason: z.string().trim().max(300).default("")}).strict(),
  (uid, token, input) => reviewCustomerReferralForAdmin(uid, token, input));

export const upsertCityOperatingCost = economicsCallable("upsertCityOperatingCost", operatingCostSchema,
  (uid, token, input) => upsertOperatingCostForAdmin(uid, token, input));

export const listCityOperatingCosts = economicsCallable("listCityOperatingCosts",
  z.object({cityKey: z.string().trim().max(80).default("")}).strict(),
  (_uid, token, input) => listOperatingCostsForAdmin(token, input.cityKey));

export const getCityBreakEven = economicsCallable("getCityBreakEven", breakEvenSchema,
  (_uid, token, input) => breakEvenForAdmin(token, input));

export const getRiderReferralOverview = economicsCallable("getRiderReferralOverview",
  z.object({
    cityKey: z.string().trim().max(80).default(""),
    status: z.enum(["", "in_progress", "review", "qualified", "paid", "expired", "rejected", "not_eligible"]).default(""),
    limit: z.number().int().min(1).max(500).default(200),
  }).strict(),
  (_uid, token, input) => readRiderReferralOverviewForAdmin(token, input));

export const reviewRiderReferral = economicsCallable("reviewRiderReferral",
  z.object({
    referredRiderId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/),
    decision: z.enum(["approved", "rejected"]),
    note: z.string().trim().max(300).default(""),
  }).strict(),
  (uid, token, input) => reviewRiderReferralForAdmin(uid, token, input));

export const simulateRiderReferral = economicsCallable("simulateRiderReferral",
  z.object({
    expectedReferredRiders: z.number().int().min(0).max(1_000_000),
    qualificationRatePercent: z.number().min(0).max(100),
    cityKey: z.string().trim().max(80).default("nellore"),
  }).strict(),
  async (_uid, token, input) => {
    const endAt = Date.now();
    // A month of the city's real results, so the effect on operating profit
    // and the expansion fund is shown against actual numbers.
    const city = input.cityKey
      ? await readCityEconomics(token, {cityKey: input.cityKey, startAt: endAt - 30 * 24 * 60 * 60 * 1000, endAt}).catch(() => null)
      : null;
    return {
      cityKey: input.cityKey,
      ...(await simulateRiderReferralForAdmin(token, {
        expectedReferredRiders: input.expectedReferredRiders,
        qualificationRatePercent: input.qualificationRatePercent,
        monthlyOperatingProfitPaise: city?.pnl?.operatingProfitPaise ?? null,
        monthlyExpansionFundPaise: city?.pnl?.expansionAllocationPaise ?? null,
      })),
    };
  });

export const getRestaurantOfferPerformance = economicsCallable("getRestaurantOfferPerformance",
  z.object({restaurantId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/), days: z.number().int().min(1).max(90).default(30)}).strict(),
  (uid, token, input) => readRestaurantOfferPerformance(uid, token, input));


// ---------------------------------------------------------------------------
// Google Maps for the live map: tiles (served via Firebase Hosting's CDN at
// /maptile/{day|night}/{z}/{x}/{y}) and two-wheeler routes. The Google key
// stays here; it is the same key the weather check uses.
// ---------------------------------------------------------------------------
export const mapTile = onRequest({
  cpu: 1, // time-critical: keeps a full CPU (see lightCpu)
  region: REGION,
  secrets: [GOOGLE_WEATHER_API_KEY],
  memory: "256MiB",
  timeoutSeconds: 20,
  // Kept at 2: a burst of ~50 tiles once started 7 full-CPU copies and used up the
  // region's 20 vCPU quota, so riders couldn't accept offers. 80 per copy is plenty.
  maxInstances: 2,
  concurrency: 80,
}, async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.status(405).send("Method not allowed");
    return;
  }
  try {
    const client = String(request.headers["x-forwarded-for"] ?? request.ip ?? "").split(",")[0]!.trim();
    const tile = await fetchMapTile(request.path, GOOGLE_WEATHER_API_KEY.value(), client);
    response.set("Cache-Control", tile.cacheControl).set("Content-Type", tile.contentType)
      .set("Access-Control-Allow-Origin", "*").status(tile.status).send(tile.body);
  } catch (error) {
    logger.warn("MAP_TILE_ERROR", {error: String(error)});
    response.set("Cache-Control", "no-store").status(502).send("");
  }
});

export const deliveryRoute = onRequest({
  cpu: 1, // time-critical: keeps a full CPU (see lightCpu)
  region: REGION,
  secrets: [GOOGLE_WEATHER_API_KEY],
  memory: "256MiB",
  timeoutSeconds: 20,
  maxInstances: 2, // same reason as mapTile
  concurrency: 80,
}, async (request, response) => {
  response.set("Access-Control-Allow-Origin", "*")
    .set("Access-Control-Allow-Headers", "Authorization, Content-Type")
    .set("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (request.method === "OPTIONS") {
    response.status(204).send("");
    return;
  }
  // Only signed-in app users may ask for routes (each one is a paid Google request).
  const header = String(request.headers.authorization ?? "");
  const idToken = header.startsWith("Bearer ") ? header.slice(7) : "";
  let decoded: DecodedIdTokenLike;
  try {
    decoded = await auth.verifyIdToken(idToken) as unknown as DecodedIdTokenLike;
  } catch {
    response.status(401).json({code: "Unauthorized"});
    return;
  }
  try {
    if (!await takeRouteAllowance(decoded.uid)) {
      response.status(429).json({code: "TooManyRequests"});
      return;
    }
    const role = String((decoded as unknown as Record<string, unknown>).savrivoRole ?? "");
    const result = await deliveryRouteForOrder({
      uid: decoded.uid,
      privileged: role === "owner" || role === "ops_admin",
      orderId: String(request.query.orderId ?? ""),
      from: parsePoint(String(request.query.from ?? "")),
      apiKey: GOOGLE_WEATHER_API_KEY.value(),
    });
    response.set("Cache-Control", "private, max-age=300").status(result.status).json(result.payload);
  } catch (error) {
    logger.warn("DELIVERY_ROUTE_ERROR", {error: String(error)});
    response.status(502).json({code: "NoRoute"});
  }
});

/** Google Maps usage watch: alerts admins at 80% / 100% of daily caps; daily map-cache check. */
export const mapsUsageWatch = onSchedule({
  schedule: "every 30 minutes",
  region: REGION,
  timeoutSeconds: 120,
  memory: "256MiB",
}, async () => {
  const result = await watchMapsUsage();
  logger.info("MAPS_USAGE_WATCH", result);
});


// ---------------------------------------------------------------------------
// Dine-in (Phase 1): bookings, table sessions, rounds, staff actions, watch.
// ---------------------------------------------------------------------------
const dineId = z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/);
const dineLine = z.object({
  itemId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/),
  quantity: z.number().int().min(1).max(20),
  variantId: z.string().trim().max(100).optional(),
  addOnIds: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  note: z.string().trim().max(200).default(""),
}).strict();
function dineCallable<S extends z.ZodTypeAny, R>(schema: S, run: (request: {auth: NonNullable<CallableRequestLike["auth"]>; data: z.infer<S>}) => Promise<R>) {
  return onCall({region: REGION, enforceAppCheck: true, timeoutSeconds: 30, memory: "256MiB"}, async (request) => {
    if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in first."));
    try {
      return await run({auth: request.auth, data: parse(schema, request.data)});
    } catch (error) {
      logger.warn("DINE_IN_REJECTED", {uid: request.auth.uid, error: String(error)});
      throw asHttpsError(error);
    }
  });
}
type CallableRequestLike = {auth?: {uid: string; token: import("firebase-admin/auth").DecodedIdToken}};

export const dineInBookTable = dineCallable(z.object({restaurantId: dineId, slotAt: z.number().int().positive(), party: z.number().int().min(1).max(30), note: z.string().trim().max(200).default("")}).strict(),
  ({auth, data}) => bookTable(auth.uid, data));
export const dineInCancelBooking = dineCallable(z.object({bookingId: dineId}).strict(), ({auth, data}) => cancelBooking(auth.uid, data));
export const dineInRespondBooking = dineCallable(z.object({bookingId: dineId, accept: z.boolean()}).strict(), ({auth, data}) => respondToBooking({...auth.token, uid: auth.uid}, data));
export const dineInOpenTable = dineCallable(z.object({restaurantId: dineId, tableId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,20}$/)}).strict(), ({auth, data}) => openTable(auth.uid, data));
export const dineInPlaceRound = dineCallable(z.object({sessionId: dineId, items: z.array(dineLine).min(1).max(40)}).strict(), ({auth, data}) => placeTableRound(auth.uid, data));
export const dineInTableRequest = dineCallable(z.object({sessionId: dineId, kind: z.enum(["waiter", "bill"])}).strict(), ({auth, data}) => tableRequest(auth.uid, data));
export const dineInStaff = dineCallable(z.object({sessionId: dineId, action: z.enum(["cooking", "served", "reopen", "paid", "close", "ackWaiter"]), roundId: dineId.optional(), paidAmount: z.number().min(0).max(1_000_000).optional()}).strict(),
  ({auth, data}) => dineInStaffAction({...auth.token, uid: auth.uid}, data));

/** Dine-in watch: booking reminders, 15-minute no-show release, stale tables. */
export const dineInWatch = onSchedule({schedule: "every 10 minutes", region: REGION, timeoutSeconds: 120, memory: "256MiB"}, async () => {
  await watchDineIn();
});


// ---------------------------------------------------------------------------
// Rider identity: Aadhaar Secure QR (UIDAI-signed), face match, PAN checks,
// admin review links, document retention and the gig-worker register.
// ---------------------------------------------------------------------------
const awsKeys = () => ({id: AWS_ACCESS_KEY_ID.value(), secret: AWS_SECRET_ACCESS_KEY.value()});

export const verifyRiderAadhaarQrCall = onCall({
  region: REGION, maxInstances: 5, invoker: "public", enforceAppCheck: true, timeoutSeconds: 60, memory: "512MiB",
  secrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY],
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to verify your identity."));
  try {
    const input = parse(z.object({qrData: z.string().trim().min(100).max(12_000).regex(/^\d+$/), consentVersion: z.literal(IDENTITY_CONSENT_VERSION)}).strict(), request.data);
    return await verifyRiderAadhaarQr(request.auth.uid, input, awsKeys());
  } catch (error) {
    logger.warn("verifyRiderAadhaarQr rejected", {uid: request.auth.uid, error: String(error)});
    throw asHttpsError(error);
  }
});

export const getRiderIdentityReviewCall = onCall({
  region: REGION, maxInstances: 5, invoker: "public", enforceAppCheck: true, timeoutSeconds: 60, memory: "512MiB",
  secrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY],
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in first."));
  try {
    const input = parse(z.object({riderUid: z.string().trim().min(10).max(128).regex(/^[A-Za-z0-9_-]+$/)}).strict(), request.data);
    return await getRiderIdentityReview(request.auth.uid, request.auth.token, input, awsKeys());
  } catch (error) {
    logger.warn("getRiderIdentityReview rejected", {uid: request.auth.uid, error: String(error)});
    throw asHttpsError(error);
  }
});

/** Admin recorded the Income Tax portal's answer for a rider's PAN. */
export const recordRiderPanCheck = onCall({
  region: REGION, invoker: "public", enforceAppCheck: true, timeoutSeconds: 60, memory: "512MiB",
  secrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY],
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in first."));
  try {
    const input = parse(z.object({riderUid: z.string().trim().min(10).max(128).regex(/^[A-Za-z0-9_-]+$/), result: z.enum(PAN_REGISTRY_RESULTS)}).strict(), request.data);
    return await recordRiderPanCheckService(request.auth.uid, request.auth.token, input, awsKeys());
  } catch (error) {
    logger.warn("recordRiderPanCheck rejected", {uid: request.auth.uid, error: String(error)});
    throw asHttpsError(error);
  }
});

/** Recompute a rider's identity checks when their PAN, face scan or name changes. */
export const onRiderIdentitySourceWritten = onDocumentWritten({
  document: "riders/{riderId}", region: REGION, maxInstances: 5, retry: false, timeoutSeconds: 60, memory: "512MiB",
  cpu: 1, // rarely runs; at 512MiB a small CPU share would exceed the region quota (Cloud Run keeps maxScale 100)
  secrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY],
}, async (event) => {
  const after = event.data?.after?.data() as Record<string, unknown> | undefined;
  if (!after) return;
  const before = (event.data?.before?.data() ?? {}) as Record<string, unknown>;
  const keys = ["panNumber", "faceReferenceObjectPath", "faceMatchStatus", "fullName", "identityFallback", "status", "vehicleType", "dlNumber", "dlValidTill"];
  if (keys.every((key) => JSON.stringify(before[key] ?? null) === JSON.stringify(after[key] ?? null))) return;
  await refreshRiderIdentity(event.params.riderId, awsKeys()).catch((error) => logger.warn("RIDER_IDENTITY_REFRESH_FAILED", {uid: event.params.riderId, error: String(error)}));
});

/** Daily: delete Aadhaar images 7 days after a rider is approved or rejected. */
export const riderIdentityRetention = onSchedule({schedule: "every 24 hours", region: REGION, maxInstances: 1, timeoutSeconds: 300, memory: "256MiB"}, async () => {
  await enforceRiderIdentityRetention();
});

/** Hourly: keep the gig-worker register (joiners and exits) current for Shram Suvidha. */
export const gigRegistrySync = onSchedule({schedule: "every 60 minutes", region: REGION, maxInstances: 1, timeoutSeconds: 300, memory: "256MiB"}, async () => {
  await syncGigRegistry();
});

// ---------------------------------------------------------------------------
// Restaurant sign-up 2.0: the partner agreement and approval
// ---------------------------------------------------------------------------
export const getRestaurantAgreement = economicsCallable("getRestaurantAgreement", restaurantApplicationIdSchema,
  (uid, token, input) => onboarding.getRestaurantAgreement(uid, token, input.appId));

/** A store that went live before in-app signing: its owner reads and signs the same agreement. */
export const getLiveRestaurantAgreement = economicsCallable("getLiveRestaurantAgreement", liveRestaurantAgreementSchema,
  (uid, token, input) => onboarding.getLiveRestaurantAgreement(uid, token, {restaurantId: input.restaurantId, details: input.details}));

export const signLiveRestaurantAgreement = onCall({region: REGION, maxInstances: 5, enforceAppCheck: true, timeoutSeconds: 60, memory: "512MiB"}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to continue."));
  try {
    const raw = request.rawRequest;
    const forwarded = String(raw?.headers?.["x-forwarded-for"] ?? "").split(",")[0]?.trim() ?? "";
    return await onboarding.signLiveRestaurantAgreement(request.auth.uid, request.auth.token, parse(signLiveRestaurantAgreementSchema, request.data ?? {}),
      {ip: forwarded || String(raw?.ip ?? ""), userAgent: String(raw?.headers?.["user-agent"] ?? "")});
  } catch (error) {
    logger.warn("signLiveRestaurantAgreement rejected", {uid: request.auth.uid, error: error instanceof Error ? error.message.slice(0, 200) : "unknown"});
    throw asHttpsError(error);
  }
});

/** Signing records the IP and device, so it reads the raw request. */
export const signRestaurantAgreement = onCall({region: REGION, maxInstances: 5, enforceAppCheck: true, timeoutSeconds: 60, memory: "512MiB"}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to continue."));
  try {
    const raw = request.rawRequest;
    const forwarded = String(raw?.headers?.["x-forwarded-for"] ?? "").split(",")[0]?.trim() ?? "";
    return await onboarding.signRestaurantAgreement(request.auth.uid, request.auth.token, parse(signRestaurantAgreementSchema, request.data ?? {}),
      {ip: forwarded || String(raw?.ip ?? ""), userAgent: String(raw?.headers?.["user-agent"] ?? "")});
  } catch (error) {
    logger.warn("signRestaurantAgreement rejected", {uid: request.auth.uid, error: error instanceof Error ? error.message.slice(0, 200) : "unknown"});
    throw asHttpsError(error);
  }
});

/** The restaurant's photo of the sealed packet, shown to the customer on their order. */
export const attachPackedPhoto = economicsCallable("attachPackedPhoto", attachPackedPhotoSchema,
  (uid, token, input) => attachPackedPhotoToOrder(uid, token as import("firebase-admin/auth").DecodedIdToken, input));

// ---- Account age and parent approval ----
export const accountSetBirthDate = economicsCallable("accountSetBirthDate", accountBirthDateSchema, (uid, _t, input) => accountAge.accountSetBirthDate(uid, input));
export const accountParentRequest = economicsCallable("accountParentRequest", accountParentRequestSchema, (uid, _t, input) => accountAge.accountParentRequest(uid, input));
export const accountParentRespond = economicsCallable("accountParentRespond", chatParentRespondSchema, (uid, _t, input) => accountAge.accountParentRespond(uid, input));
export const accountParentRevoke = economicsCallable("accountParentRevoke", chatChildSchema, (uid, _t, input) => accountAge.accountParentRevoke(uid, input));
export const parentPayRequest = economicsCallable("parentPayRequest", parentPayRequestSchema, (uid, _t, input) => parentPay.parentPayRequest(uid, input));
export const parentPayCancel = economicsCallable("parentPayCancel", parentPayIdSchema, (uid, _t, input) => parentPay.parentPayCancel(uid, input));
export const parentPayRespond = economicsCallable("parentPayRespond", parentPayRespondSchema, (uid, _t, input) =>
  parentPay.parentPayRespond(uid, input, {onlineAvailable: paymentGateway.configured}), {secrets: CASHFREE_SECRETS});

// ---- Friends & chat ----
export const chatSetup = economicsCallable("chatSetup", chatSetupSchema, (uid, _t, input) => social.chatSetup(uid, input));
export const chatNewCode = economicsCallable("chatNewCode", chatEmptySchema, (uid) => social.chatNewCode(uid));
export const chatSetPrivacy = economicsCallable("chatSetPrivacy", chatPrivacySchema, (uid, _t, input) => social.chatSetPrivacy(uid, input));
export const chatAddFriend = economicsCallable("chatAddFriend", chatHandleSchema, (uid, _t, input) => social.chatAddFriend(uid, input));
export const chatSetUsername = economicsCallable("chatSetUsername", chatUsernameSchema, (uid, _t, input) => social.chatSetUsername(uid, input));
export const chatRespond = economicsCallable("chatRespond", chatRespondSchema, (uid, _t, input) => social.chatRespond(uid, input));
export const chatMarkRead = economicsCallable("chatMarkRead", chatPairSchema, (uid, _t, input) => social.chatMarkRead(uid, input));
export const chatParentRequest = economicsCallable("chatParentRequest", chatCodeSchema, (uid, _t, input) => social.chatParentRequest(uid, input));
export const chatParentRespond = economicsCallable("chatParentRespond", chatParentRespondSchema, (uid, _t, input) => social.chatParentRespond(uid, input));
export const chatParentRevoke = economicsCallable("chatParentRevoke", chatChildSchema, (uid, _t, input) => social.chatParentRevoke(uid, input));
export const chatCrave = economicsCallable("chatCrave", chatCraveSchema, (uid, _t, input) => chatFun.chatCrave(uid, input));
export const chatSetEatingShare = economicsCallable("chatSetEatingShare", chatEatingShareSchema, (uid, _t, input) => chatFun.chatSetEatingShare(uid, input));
export const chatTasteMatch = economicsCallable("chatTasteMatch", chatPairOnlySchema, (uid, _t, input) => chatFun.chatTasteMatch(uid, input));
export const chatIou = economicsCallable("chatIou", chatIouSchema, (uid, _t, input) => chatFun.chatIou(uid, input));
/** Sunday 7 pm India time: "Your food week is ready". */
export const weeklyFoodCardPush = onSchedule({schedule: "0 19 * * 0", timeZone: "Asia/Kolkata", region: REGION, timeoutSeconds: 300, memory: "256MiB"},
  async () => { await chatFun.weeklyCardPush(); });
export const chatReport = economicsCallable("chatReport", chatReportSchema, (uid, _t, input) => social.chatReport(uid, input));
/** Unsend one of your own messages (within 2 days): gone for both, kept for moderators. */
export const chatUnsend = economicsCallable("chatUnsend", chatUnsendSchema, (uid, _t, input) => social.chatUnsend(uid, input));
export const resolveChatReport = economicsCallable("resolveChatReport", resolveChatReportSchema,
  (uid, token, input) => social.resolveChatReport(uid, token as import("firebase-admin/auth").DecodedIdToken, input));

/** A new chat message: hide phone numbers, update the chat list, push to the friend. */
export const onChatMessageCreated = onDocumentCreated({
  cpu: 0.5, // hot path: half a CPU, quicker than gcf_gen1 (see lightCpu)
  document: "chats/{pairId}/messages/{messageId}", region: REGION, retry: false, timeoutSeconds: 30, memory: "256MiB",
}, async (event) => {
  const data = event.data?.data() as Record<string, unknown> | undefined;
  if (data) await social.onChatMessage(event.params.pairId, event.params.messageId, data);
});

/** A reaction added to a chat message. */
export const onChatMessageReacted = onDocumentUpdated({
  document: "chats/{pairId}/messages/{messageId}", region: REGION, retry: false, timeoutSeconds: 30, memory: "256MiB",
}, async (event) => {
  const before = event.data?.before?.data() as Record<string, unknown> | undefined;
  const after = event.data?.after?.data() as Record<string, unknown> | undefined;
  if (before && after && JSON.stringify(before.reactions ?? {}) !== JSON.stringify(after.reactions ?? {})) {
    await social.onChatReaction(event.params.pairId, before, after);
  }
});

// ---- Friends' feed: photos and 24-hour stories ----
/** A new post or story: put its card in the poster's and each friend's feed. */
export const onPostCreated = onDocumentCreated({
  document: "posts/{postId}", region: REGION, retry: false, timeoutSeconds: 60, memory: "256MiB",
}, async (event) => {
  const data = event.data?.data() as Record<string, unknown> | undefined;
  if (data) await posts.onPostCreated(event.params.postId, data);
});
// ---- Public reels: reviewed before they go public, reportable, city-level location only ----
export const createReel = economicsCallable("createReel", createReelSchema, (uid, _t, input) => reels.createReel(uid, input as Parameters<typeof reels.createReel>[1]));
export const reportReel = economicsCallable("reportReel", reportReelSchema, (uid, _t, input) => reels.reportReel(uid, input));
export const reviewReel = economicsCallable("reviewReel", reviewReelSchema,
  (uid, token, input) => reels.reviewReel(uid, token as import("firebase-admin/auth").DecodedIdToken, input));
/** A poster deleted their reel: its video and picture go too. */
export const onReelDeleted = onDocumentDeleted({
  document: "reels/{reelId}", region: REGION, retry: false, timeoutSeconds: 60, memory: "256MiB",
}, async (event) => { const data = event.data?.data() as Record<string, unknown> | undefined; if (data) await reels.onReelDeleted(event.params.reelId, data); });

/** A post deleted (by its poster, or its story ended): its cards, photo and video go too. */
export const onPostDeleted = onDocumentDeleted({
  document: "posts/{postId}", region: REGION, retry: false, timeoutSeconds: 60, memory: "256MiB",
}, async (event) => { await posts.onPostDeleted(event.params.postId, event.data?.data() as Record<string, unknown> | undefined); });
/** The poster edited a caption or audience, or kept a story in a highlight: cards follow. */
export const onPostUpdated = onDocumentUpdated({
  document: "posts/{postId}", region: REGION, retry: false, timeoutSeconds: 60, memory: "256MiB", maxInstances: 10,
}, async (event) => {
  const before = event.data?.before?.data() as Record<string, unknown> | undefined;
  const after = event.data?.after?.data() as Record<string, unknown> | undefined;
  if (before && after) await posts.onPostUpdated(event.params.postId, before, after);
});
/** A friend answered a story's poll, slider or question: the totals on the story refresh. */
export const onStoryResponse = onDocumentWritten({
  document: "posts/{postId}/responses/{uid}", region: REGION, retry: false, timeoutSeconds: 30, memory: "256MiB", maxInstances: 10,
}, async (event) => { await posts.onStoryResponse(event.params.postId); });
/** A comment on a post or story: the commenter's name goes on it and the poster is told. */
export const onPostCommentCreated = onDocumentCreated({
  document: "posts/{postId}/comments/{commentId}", region: REGION, retry: false, timeoutSeconds: 60, memory: "256MiB",
}, async (event) => {
  const data = event.data?.data() as Record<string, unknown> | undefined;
  if (data) await posts.onCommentCreated(event.params.postId, event.params.commentId, data);
});
/** No longer friends: each person's posts leave the other's feed. */
export const onFriendshipChanged = onDocumentWritten({
  document: "friendships/{pairId}", region: REGION, retry: false, timeoutSeconds: 60, memory: "256MiB",
}, async (event) => {
  await posts.onFriendshipChanged(event.data?.before?.data() as Record<string, unknown> | undefined,
    event.data?.after?.data() as Record<string, unknown> | undefined);
});
/** Every 30 minutes: delete stories older than 24 hours. */
export const deleteEndedStories = onSchedule({schedule: "every 30 minutes", region: REGION, timeoutSeconds: 120, memory: "256MiB"},
  async () => { await posts.deleteEndedStories(); });

// ---- Daily meal plans (tiffin) ----
type IdToken = import("firebase-admin/auth").DecodedIdToken;
export const saveMealPlan = economicsCallable("saveMealPlan", saveMealPlanSchema,
  (uid, token, input) => mealPlans.saveMealPlan(uid, token as IdToken, input));
export const getRestaurantMealPlans = economicsCallable("getRestaurantMealPlans", restaurantMealPlansSchema,
  (uid, token, input) => mealPlans.getRestaurantMealPlans(uid, token as IdToken, input.restaurantId));
export const subscribeMealPlan = economicsCallable("subscribeMealPlan", subscribeMealPlanSchema,
  (uid, _token, input) => mealPlans.subscribeMealPlan(uid, input));
export const updateMealSubscription = economicsCallable("updateMealSubscription", updateMealSubscriptionSchema,
  (uid, _token, input) => mealPlans.updateMealSubscription(uid, input));

/** Every 5 minutes: place today's meal-plan orders ahead of each delivery window. */
export const placeMealPlanOrders = onSchedule({schedule: "every 5 minutes", region: REGION, timeoutSeconds: 300, memory: "256MiB"}, async () => {
  await mealPlans.placeDueMealOrders();
});

export const setRestaurantAgreementTerms = economicsCallable("setRestaurantAgreementTerms", restaurantAgreementTermsSchema,
  (uid, token, input) => onboarding.setRestaurantAgreementTerms(uid, token, input));

export const getRestaurantApplicationReview = economicsCallable("getRestaurantApplicationReview", restaurantApplicationIdSchema,
  (uid, token, input) => onboarding.getRestaurantApplicationReview(uid, token, input.appId));

export const requestRestaurantApplicationChanges = economicsCallable("requestRestaurantApplicationChanges", restaurantApplicationChangesSchema,
  async (uid, token, input) => { await onboarding.requestRestaurantApplicationChanges(uid, token, input); return {ok: true}; });

export const approveRestaurantApplication = economicsCallable("approveRestaurantApplication", restaurantApplicationIdSchema,
  (uid, token, input) => onboarding.approveRestaurantApplication(uid, token, input.appId));

// ---------------------------------------------------------------------------
// Admin app 2.0: today at a glance and urgent alerts
// ---------------------------------------------------------------------------
export const getAdminToday = economicsCallable("getAdminToday", z.object({days: z.number().int().min(1).max(30).default(1)}).strict(),
  (_uid, token, input) => readAdminToday(token, input));

export const getStorePayoutsDue = economicsCallable("getStorePayoutsDue", z.object({}).strict(),
  (uid, token) => readStorePayoutsDue(uid, token));

/** Customer insights: who orders, from where, what and when - aggregates only. */
export const getAdminAnalytics = onCall({region: REGION, enforceAppCheck: true, timeoutSeconds: 120, memory: "1GiB"},
  async (request) => {
    if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to continue."));
    try {
      const input = parse(z.object({
        days: z.number().int().min(1).max(90).default(30),
        kind: z.enum(["all", "restaurant", "grocery", "dairy", "pharmacy"]).default("all"),
        fresh: z.boolean().default(false),
      }).strict(), request.data ?? {});
      return await readAdminAnalytics(request.auth.token, input);
    } catch (error) {
      logger.warn("getAdminAnalytics rejected", {uid: request.auth.uid, error: error instanceof Error ? error.message.slice(0, 200) : "unknown"});
      throw asHttpsError(error);
    }
  });

/** Pre-launch watching, once a day: saves each finished day's summary (kept), then deletes trails older than 60 days. */
export const partnerTrailRecorder = onSchedule({
  schedule: "every day 03:00",
  timeZone: "Asia/Kolkata",
  region: REGION,
  timeoutSeconds: 120,
  memory: "256MiB",
  maxInstances: 1,
}, async () => {
  const result = await partnerTrail.cleanPartnerTrails();
  if (result.summarized || result.cleaned) logger.info("PARTNER_TRAIL_DAILY", result);
});

/** Pre-launch watching of delivery partners who agreed: saves each position update (about every 15 s) while online. */
export const partnerTrailOnPresence = onValueWritten({
  ref: `/${ROOT}/riderPresence/{riderId}`,
  instance: DATABASE_INSTANCE,
  region: DATABASE_REGION,
  retry: false,
  timeoutSeconds: 30,
  memory: "256MiB",
  maxInstances: 10,
}, async (event) => {
  const after = event.data.after.exists() ? event.data.after.val() as Presence : null;
  const at = Date.parse(String(event.time ?? "")) || Date.now();
  await partnerTrail.recordPresencePoint(String(event.params.riderId), after, at);
});

/** Admin page: choose who is watched (after they agree), and read a partner's day. */
export const partnerActivity = onCall({region: REGION, enforceAppCheck: true, timeoutSeconds: 60, memory: "256MiB", maxInstances: 5},
  async (request) => {
    if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to continue."));
    try {
      requirePlatformConfigAdminClaim(request.auth.token);
      const riderId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
      const input = parse(z.discriminatedUnion("action", [
        z.object({action: z.literal("list")}).strict(),
        z.object({action: z.literal("day"), riderId, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).strict(),
        z.object({action: z.literal("watch"), riderId, on: z.boolean(), note: z.string().max(200).optional()}).strict(),
        z.object({action: z.literal("forget"), riderId}).strict(),
        z.object({action: z.literal("history"), riderId}).strict(),
      ]), request.data ?? {});
      if (input.action === "history") return await partnerTrail.partnerHistory(input.riderId);
      if (input.action === "list") return await partnerTrail.listPartners();
      if (input.action === "day") return await partnerTrail.partnerDay(input.riderId, input.date);
      if (input.action === "watch") {
        const result = await partnerTrail.setWatch(input.riderId, input.on, request.auth.uid, input.note ?? "");
        logger.info("PARTNER_TRAIL_WATCH", {by: request.auth.uid, riderId: input.riderId, on: input.on});
        return result;
      }
      const result = await partnerTrail.forgetPartner(input.riderId);
      logger.info("PARTNER_TRAIL_FORGET", {by: request.auth.uid, riderId: input.riderId, ...result});
      return result;
    } catch (error) {
      logger.warn("partnerActivity rejected", {uid: request.auth.uid, error: error instanceof Error ? error.message.slice(0, 200) : "unknown"});
      throw asHttpsError(error);
    }
  });

/**
 * Owner's switch for the 7 warm servers: "always" = warm 24/7; "cold" = all cold now and the 7 AM warm-up paused;
 * "schedule" = back to warm 7 AM–midnight. No mode = just read the state.
 */
export const serverWarmth = onCall({region: REGION, enforceAppCheck: true, timeoutSeconds: 300, memory: "256MiB"},
  async (request) => {
    if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to continue."));
    try {
      requireOwnerClaim(request.auth.token);
      const input = parse(z.object({mode: z.enum(["always", "schedule", "cold"]).optional()}).strict(), request.data ?? {});
      if (!input.mode) return await readServerWarmth();
      const result = await setServerWarmth(input.mode);
      logger.info("SERVER_WARMTH_SET", {uid: request.auth.uid, mode: input.mode, result: result.mode});
      return result;
    } catch (error) {
      logger.warn("serverWarmth rejected", {uid: request.auth.uid, error: error instanceof Error ? error.message.slice(0, 200) : "unknown"});
      throw asHttpsError(error);
    }
  });

/**
 * Tell Scraveit's admins when a store applies, and when it signs and is ready to approve; tell the
 * store's owner when Scraveit confirms their rate, asks for changes or approves them.
 */
export const onRestaurantApplicationWritten = onDocumentWritten({
  document: "restaurantApplications/{appId}", region: REGION, retry: false, timeoutSeconds: 60, memory: "256MiB",
}, async (event) => {
  const before = (event.data?.before?.data() ?? null) as Record<string, unknown> | null;
  const after = (event.data?.after?.data() ?? null) as Record<string, unknown> | null;
  const alert = applicationAlert(event.params.appId, before, after);
  const update = onboarding.applicantUpdate(event.params.appId, before, after);
  await Promise.all([alert ? alarmAdmins(alert) : null, update ? notifyStoreApplicant(update) : null]);
});

/** Ring the admin app when a rider sends their application. */
export const onRiderApplicationAlarm = onDocumentWritten({
  document: "riders/{riderId}", region: REGION, retry: false, timeoutSeconds: 60, memory: "256MiB",
}, async (event) => {
  const before = (event.data?.before?.data() ?? null) as Record<string, unknown> | null;
  const after = (event.data?.after?.data() ?? null) as Record<string, unknown> | null;
  const alert = riderApplicationAlert(event.params.riderId, before, after);
  if (alert) await alarmAdmins(alert);
});

/** Ring the admin app when anyone opens a support ticket. */
export const onSupportTicketCreated = onDocumentCreated({
  document: "support/{ticketId}", region: REGION, retry: false, timeoutSeconds: 60, memory: "256MiB",
}, async (event) => {
  const alert = supportTicketAlert(event.params.ticketId, (event.data?.data() ?? null) as Record<string, unknown> | null);
  if (alert) await alarmAdmins(alert);
});

/** Someone asked to delete their account: tell the owner, then delete it (accountDeletion.ts). */
export const onPrivacyRequestCreated = onDocumentCreated({
  document: "privacyRequests/{requestId}", region: REGION, retry: false, timeoutSeconds: 540, memory: "512MiB", maxInstances: 5,
}, async (event) => {
  if (!event.data) return;
  const alert = privacyRequestAlert(event.params.requestId, (event.data.data() ?? null) as Record<string, unknown> | null);
  if (alert) await alertAdmins(alert.key, alert.title, alert.body, alert.route);
  await accountDeletion.processDeletionRequest(event.data);
});

/** Every 15 minutes, 8 am to 10 pm: the next-day follow-up about a cart left behind. */
export const cartReminders = onSchedule({schedule: "*/15 8-21 * * *", timeZone: "Asia/Kolkata", region: REGION, timeoutSeconds: 300, memory: "256MiB", maxInstances: 1}, async () => {
  const sent = await cartReminderService.runCartReminders();
  if (sent) logger.info("CART_REMINDERS_SENT", {sent});
});

/** Breakfast, lunch and dinner ideas for customers (mealSuggestions.ts). */
function mealSchedule(slot: mealSuggestionService.MealSlot, schedule: string) {
  return onSchedule({schedule, timeZone: "Asia/Kolkata", region: REGION, timeoutSeconds: 540, memory: "512MiB", maxInstances: 1}, async () => {
    const sent = await mealSuggestionService.runMealSuggestions(slot);
    logger.info("MEAL_SUGGESTIONS_SENT", {slot, sent});
  });
}
export const mealSuggestionBreakfast = mealSchedule("breakfast", "0 8 * * *");
export const mealSuggestionLunch = mealSchedule("lunch", "30 12 * * *");
export const mealSuggestionDinner = mealSchedule("dinner", "30 19 * * *");

/** Daily: deletions that were waiting for an order to finish, and old squads. */
export const accountDeletionDaily = onSchedule({schedule: "every day 03:30", timeZone: "Asia/Kolkata", region: REGION, timeoutSeconds: 540, memory: "512MiB", maxInstances: 1}, async () => {
  const done = await accountDeletion.retryWaitingDeletions();
  const squads = await accountDeletion.deleteOldSquads();
  if (done || squads) logger.info("ACCOUNT_DELETION_DAILY", {done, squads});
});

/** Every 5 minutes: orders not accepted, cooking too long, or waiting for a rider. */
export const adminStuckOrderWatch = onSchedule({schedule: "every 5 minutes", region: REGION, timeoutSeconds: 120, memory: "256MiB"}, async () => {
  const count = await watchStuckOrders();
  if (count) logger.info("ADMIN_STUCK_ORDERS", {count});
});

// ---------------------------------------------------------------------------
// Weekly payouts: status and a no-money preview for the Admin app
// ---------------------------------------------------------------------------
export const getPayoutAutomationStatus = economicsCallable("getPayoutAutomationStatus", z.object({}).strict(),
  async (_uid, token) => {
    if (token.savrivoRole !== "owner" && token.savrivoRole !== "ops_admin") throw new DomainError("permission-denied", "Admins only.");
    const [policy, lastRun] = await Promise.all([loadFinancePolicy(), readLatestWeeklyRun()]);
    const automation = financePayoutAutomationSummary(policy, Date.now());
    const connector = selectPayoutGateway();
    return {
      enabled: automation.enabled, scheduleLabel: automation.scheduleLabel, nextRunDayKey: automation.nextRunDayKey,
      ridersEnabled: automation.ridersEnabled, restaurantsEnabled: automation.restaurantsEnabled,
      maxPerPayoutPaise: policy.payouts.automation.maxPerPayoutPaise, maxPerRunPaise: policy.payouts.automation.maxPerRunPaise,
      bankConnected: connector.gateway.configured, bankName: connector.name,
      lastRun, lastRunItems: lastRun?.periodKey ? (await readWeeklyRunItems(lastRun.periodKey)).slice(0, 100) : [],
    };
  }, {secrets: CASHFREE_PAYOUT_SECRETS});

/** Runs this week's payout calculation without moving or recording any money. */
/**
 * Founder 17 Nov 2026: a one-off Rs 1 Cashfree transfer to the payout details saved for one delivery
 * partner or store, to prove the connection. Owner only, fixed Rs 1, one per entity per minute (same
 * transfer id), and it never touches balances or ledgers.
 */
export const sendTestPayout = economicsCallable("sendTestPayout",
  z.object({entityType: z.enum(["rider", "restaurant"]), entityId: z.string().trim().min(1).max(128)}).strict(),
  async (uid, token, input) => {
    if (token.savrivoRole !== "owner") throw new DomainError("permission-denied", "Owner only.");
    const snap = input.entityType === "rider" ?
      await firestoreDb.collection("riders").doc(input.entityId).get() :
      await firestoreDb.collection("restaurantPayoutProfiles").doc(input.entityId).get();
    if (!snap.exists) throw new DomainError("not-found", "No such delivery partner or store payout profile.");
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    const p = (input.entityType === "rider" ? data.payoutProfile ?? {} : data) as Record<string, unknown>;
    const str = (v: unknown) => typeof v === "string" ? v.trim() : "";
    const upiId = str(p.upiId), bankAccountNumber = str(p.bankAccountNumber), bankIfsc = str(p.bankIfsc);
    const preferred = str(p.preferredMethod);
    const method = (preferred === "upi" || preferred === "imps" || preferred === "neft") ? preferred : (upiId ? "upi" : "imps");
    const label = str(p.beneficiaryName) || str(p.legalBusinessName) || str(data.fullName) || str(data.name) || input.entityId;
    // One transfer id per minute: a rejected test can be tried again after Cashfree fixes something.
    const day = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 16);
    const gateway = new CashfreePayoutGateway(liveCashfreePayoutConfig());
    const result = await gateway.executePayout({
      entityType: input.entityType, entityId: input.entityId, amountPaise: 100, method: method as never,
      operationId: `test-payout:${input.entityType}:${input.entityId}:${day}`, beneficiaryLabel: label,
      upiId, bankAccountHolderName: str(p.bankAccountHolderName) || label, bankAccountNumber, bankIfsc,
    });
    logger.info("TEST_PAYOUT_SENT", {by: uid, entityType: input.entityType, entityId: input.entityId, method, ref: result.referenceId});
    return {ok: true, method, amountRupees: 1, referenceId: result.referenceId, providerOperationId: result.providerOperationId};
  }, {secrets: CASHFREE_PAYOUT_SECRETS});

export const previewWeeklyPayouts = economicsCallable("previewWeeklyPayouts", z.object({}).strict(),
  async (_uid, token) => {
    if (token.savrivoRole !== "owner") throw new DomainError("permission-denied", "Only the owner can preview payouts.");
    const summary = await runWeeklyFinanceAutomation(Date.now(), undefined, undefined, undefined, {preview: true});
    return {summary, items: summary.periodKey ? (await readWeeklyRunItems(summary.periodKey)).slice(0, 200) : []};
  });

