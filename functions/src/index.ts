import {createHash, randomUUID} from "node:crypto";
import {logger} from "firebase-functions";
import {setGlobalOptions} from "firebase-functions/v2";
import {onValueWritten} from "firebase-functions/v2/database";
import {onDocumentCreated, onDocumentUpdated, onDocumentWritten} from "firebase-functions/v2/firestore";
import {onCall, onRequest} from "firebase-functions/v2/https";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {onTaskDispatched} from "firebase-functions/v2/tasks";
import {z} from "zod";
import {db, firestoreDb} from "./admin";
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
} from "./firestorePaths";
import {buildRiderJobProjection} from "./domain/riderJob";
import {computeNextBroadcastOccurrence, type CustomerBroadcastRepeat} from "./domain/broadcastSchedule";
import {buildPricing, priceCart} from "./domain/order";
import {GOOGLE_WEATHER_API_KEY, refreshRainPricingSignals} from "./services/weather";
import {AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY} from "./services/faceVerification";
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
  cityEconomicsQuerySchema,
  restaurantOfferSchema,
  restaurantOffersQuerySchema,
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
  createCodOrderSchema,
  declineOrderSchema,
  exportPlatformDataWorkbookSchema,
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
  scheduleDispatchClaimRecovery,
  type Presence,
  updateRiderAvailabilityIndex,
} from "./services/dispatch";
import {registerDeviceToken, unregisterDeviceToken} from "./services/deviceTokens";
import {
  checkoutTax,
  loadEconomicsControl,
  planCheckoutEconomics,
  readEconomicsControlForAdmin,
  recordOrderEconomicsOutcome,
  releasePromotionSpend,
  resolveCheckoutPromotion,
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
} from "./services/economicsAdmin";
import {economicsScopeKey, rupeesToPaise} from "./domain/economics";
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
import {readPlatformConfiguration, updatePlatformConfiguration} from "./services/platformConfigControl";
import {loadCheckoutConfiguration} from "./services/platformConfig";
import {
  deliverNotificationRecord,
  notifyCustomerBroadcast,
  notifyCustomerRiderAssigned,
  notifyCustomerStatus,
  notifyRestaurantNewOrder,
  stopRiderOffers,
  stopRestaurantAlarm,
} from "./services/notifications";
import {listDueNotifications, processNotification} from "./services/outbox";
import {
  createAuthoritativeCodOrder,
  createAuthoritativeOrder,
  recoverCustomerDeliveryOtp,
  recordCodLedger,
  recordOnlinePaymentLedger,
  scrubLegacyPublicOtp,
  transitionOrder,
} from "./services/orders";
import {processTrackingUpdate} from "./services/tracking";
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
import {getRestaurantSettlementSummary as readRestaurantSettlementSummary} from "./services/restaurantSettlements";
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
import {runWeeklyFinanceAutomation} from "./services/financeAutomation";
import {movePayoutProfileToPrivate} from "./services/restaurantPayoutProfiles";
import {recordRiderDeliveredOrder} from "./services/riderDeliveryCount";
import {backfillLedgerPartyIndex} from "./services/ledgerPartyIndex";
import {
  applyVerifiedPayment,
  callbackHash,
  initiatePayment,
  UnconfiguredPhonePeGateway,
} from "./services/payments";
import type {SavrivoOrder} from "./types";

// Each instance serves up to 80 requests at once, so 100 instances is room
// for roughly 8,000 simultaneous requests per function. Instances only exist
// (and cost) while traffic needs them; idle functions scale to zero.
setGlobalOptions({maxInstances: 100});

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
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to place an order."));
  try {
    const input = parse(createCodOrderSchema, request.data);
    const result = await createAuthoritativeCodOrder(request.auth.uid, input);
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

export const createOrder = onCall({
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to place an order."));
  try {
    const input = parse(createOrderSchema, request.data);
    if (input.paymentMethod !== "cod" && !phonePeGateway.configured) {
      throw new DomainError("failed-precondition", "Online payments are not available right now.");
    }
    const result = await createAuthoritativeOrder(request.auth.uid, input);
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
      await beginSequentialDispatch(result.order);
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
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to accept a delivery."));
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
  region: REGION,
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
  region: REGION,
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
  region: REGION,
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
export const getCheckoutConfiguration = onCall({
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 15,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to view checkout configuration."));
  try {
    const config = await loadCheckoutConfiguration(phonePeGateway.configured);
    const data = request.data as Record<string, unknown> | null | undefined;
    if (!data || !data.restaurantId) return config;
    try {
      const input = parse(checkoutPricingPreviewSchema, data);
      const [{restaurant, menuById}, {address}] = await Promise.all([
        loadRestaurantAndMenu(input.restaurantId),
        loadCustomerAddress(request.auth.uid, input.addressId),
      ]);
      const {subtotal} = priceCart(input.items, menuById);
      const now = Date.now();
      const [fees, control, financePolicy] = await Promise.all([
        loadServerFees(restaurant, address, subtotal),
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
      const tax = checkoutTax(control, plan, fees, subtotal, now);
      const feeInput = {
        subtotal,
        discount: (plan.discount.restaurantDiscountPaise + plan.discount.platformDiscountPaise) / 100,
        deliveryFee: fees.deliveryFee, platformFee: fees.platformFee, taxRate: fees.taxRate, tip: input.tip,
        smallOrderThreshold: fees.smallOrderThreshold, smallOrderFee: fees.smallOrderFee,
        lateNightFee: fees.lateNightFee, rainFee: fees.rainFee, surgeFee: fees.surgeFee,
        riderIncentiveFee: fees.riderIncentiveFee,
        ...(tax ? {taxOverride: tax.customerTaxPaise / 100} : {}),
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
          riderIncentiveFee: fees.riderIncentiveFee,
          riderIncentiveItems: fees.riderIncentiveItems,
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
export const exportPlatformDataWorkbook = onCall({
  region: REGION,
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

const phonePeGateway = new UnconfiguredPhonePeGateway();

async function handleCreatePaymentIntent(request: {
  auth?: {uid: string};
  data: unknown;
}): Promise<unknown> {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to start payment."));
  const input = parse(initiatePaymentSchema, request.data);
  return await initiatePayment(request.auth.uid, input, phonePeGateway);
}

export const createPaymentIntent = onCall({
  region: REGION,
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

export const createPhonePeIntent = onCall({
  region: REGION,
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

export const dispatchOfferTimeout = onTaskDispatched({
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
  timeoutSeconds: 300,
  memory: "256MiB",
}, async (event) => {
  const parsed = Date.parse(String((event as {scheduleTime?: string}).scheduleTime ?? ""));
  const referenceAt = Number.isFinite(parsed) ? parsed : Date.now();
  const summary = await runWeeklyFinanceAutomation(referenceAt);
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
  await reconcileRestaurantOrderProjection(order);
  await reconcileRestaurantWorkload(order);
  await reconcileOperationalOrderProjection(order);
  logger.info("ORDER_CREATED_TRIGGER", {orderId: order.id, status: order.status});
  if (order.status !== "Order placed") {
    logger.info("STALE_NEW_ORDER_EVENT_IGNORED", {orderId: order.id, status: order.status});
    return;
  }
  await sideEffectLease(`restaurant-new-order:${order.id}`, async () => {
    logger.info("NEW_ORDER_PUSH_REQUESTED", {orderId: order.id, restaurantId: order.restaurantId});
    await notifyRestaurantNewOrder(order);
  });
});

export const onOrderUpdated = onDocumentUpdated({
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
  if (["Accepted", "Preparing", "Ready for pickup"].includes(order.status) && !order.riderId) {
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
    batch.delete(deliveryOtpRef(firestoreDb, order.id));
    if (order.riderId) {
      batch.set(riderJobRef(firestoreDb, order.riderId, order.id), {status: "cancelled"}, {merge: true});
    }
    await Promise.all([
      batch.commit(),
      // `tracking` still lives in RTDB - the rider app's live-location writes
      // have not migrated off it yet.
      db.ref(`${ROOT}/tracking/${order.id}`).remove(),
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
  if (order.riderId) {
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
    await sideEffectLease(`rider-rewards:${order.id}`, async () => {
      await evaluateRiderRewardsForDeliveredOrder(order);
    });
    await sideEffectLease(`rider-delivered-count:${order.id}`, async () => {
      await recordRiderDeliveredOrder(order);
    });
    const batch: WriteBatchLike = firestoreDb.batch();
    batch.delete(trackingEvidenceRef(firestoreDb, order.id));
    batch.delete(deliveryOtpRef(firestoreDb, order.id));
    await Promise.all([
      batch.commit(),
      db.ref(`${ROOT}/tracking/${order.id}`).remove(),
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

export const onTrackingUpdated = onValueWritten({
  ref: `/${ROOT}/tracking/{orderId}`,
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
) {
  return onCall({region: REGION, enforceAppCheck: true, timeoutSeconds: 30, memory: "256MiB"}, async (request) => {
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
