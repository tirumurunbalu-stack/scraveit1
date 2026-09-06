import {createHash, randomUUID} from "node:crypto";
import {logger} from "firebase-functions";
import {onValueCreated, onValueUpdated, onValueWritten} from "firebase-functions/v2/database";
import {onCall, onRequest} from "firebase-functions/v2/https";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {onTaskDispatched} from "firebase-functions/v2/tasks";
import {z} from "zod";
import {db} from "./admin";
import {DATABASE_REGION, REGION, ROOT} from "./config";
import {asHttpsError, DomainError} from "./errors";
import {buildRiderJobProjection} from "./domain/riderJob";
import {
  claimOrderSchema,
  adminDashboardQuerySchema,
  adminRiderRewardsDashboardQuerySchema,
  createOrderSchema,
  createCodOrderSchema,
  declineOrderSchema,
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
import {readPlatformConfiguration, updatePlatformConfiguration} from "./services/platformConfigControl";
import {loadCheckoutConfiguration} from "./services/platformConfig";
import {
  deliverNotificationRecord,
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
import {
  recordRestaurantSettlement as writeRestaurantSettlement,
  recordRiderPayout as writeRiderPayout,
} from "./services/payouts";
import {readRiderFinancialSummary} from "./services/riderFinance";
import {getRestaurantSettlementSummary as readRestaurantSettlementSummary} from "./services/restaurantSettlements";
import {
  evaluateRiderRewardsForDeliveredOrder,
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
import {
  applyVerifiedPayment,
  callbackHash,
  initiatePayment,
  UnconfiguredPhonePeGateway,
} from "./services/payments";
import type {SavrivoOrder} from "./types";

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new DomainError("invalid-argument", validationMessage(result.error));
  return result.data as z.infer<S>;
}

async function sideEffectLease(key: string, work: () => Promise<void>): Promise<void> {
  const safeKey = createHash("sha256").update(key).digest("hex");
  const ref = db.ref(`${ROOT}/backendEvents/${safeKey}`);
  const now = Date.now();
  const lease = await ref.transaction((current: {status?: string; leaseUntil?: number} | null) => {
    if (current?.status === "done" || Number(current?.leaseUntil ?? 0) > now) return undefined;
    return {status: "running", startedAt: now, leaseUntil: now + 5 * 60_000};
  }, undefined, false);
  if (!lease.committed) return;
  try {
    await work();
    await ref.update({status: "done", completedAt: Date.now(), leaseUntil: 0});
  } catch (error) {
    await ref.update({status: "retry", lastError: error instanceof Error ? error.message.slice(0, 300) : "unknown", leaseUntil: 0});
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

export const markRiderArrivedRestaurant = onCall({
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to record arrival."));
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

export const getCheckoutConfiguration = onCall({
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 15,
  memory: "256MiB",
}, async (request) => {
  if (!request.auth) throw asHttpsError(new DomainError("unauthenticated", "Sign in to view checkout configuration."));
  try {
    return await loadCheckoutConfiguration(phonePeGateway.configured);
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
  memory: "128MiB",
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
  memory: "128MiB",
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
 * Reconciles the narrow failure window between rider-claim reservation,
 * canonical order assignment, and projection fan-out. It never chooses a
 * winner: the canonical order transaction remains the sole authority.
 */
export const reconcileExpiredDispatchClaims = onSchedule({
  schedule: "every 5 minutes",
  region: DATABASE_REGION,
  timeoutSeconds: 300,
  memory: "256MiB",
}, async () => {
  const summary = await recoverExpiredDispatchClaims(100);
  logger.info("RIDER_CLAIM_RECOVERY_RUN_COMPLETED", summary);
});

export const settleRiderIncentivePeriods = onSchedule({
  schedule: "every 15 minutes",
  region: DATABASE_REGION,
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
  region: DATABASE_REGION,
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

/** Every persisted claim lease gets its own recovery task. RTDB trigger retry
 * guarantees scheduling even if the rider callable exits after reservation. */
export const onDispatchClaimWritten = onValueWritten({
  ref: `/${ROOT}/dispatchQueue/{orderId}/claim`,
  region: DATABASE_REGION,
  retry: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (event) => {
  if (!event.data.after.exists()) return;
  const claim = event.data.after.val() as {
    operationId?: string;
    leaseUntil?: number;
    state?: string;
  } | null;
  if (!claim || !["reserved", "order_committed"].includes(String(claim.state ?? "reserved"))) return;
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

export const onOrderCreated = onValueCreated({
  ref: `/${ROOT}/orders/{customerId}/{orderId}`,
  region: DATABASE_REGION,
  retry: true,
  timeoutSeconds: 60,
  memory: "256MiB",
}, async (event) => {
  const rawOrder = event.data.val() as SavrivoOrder | null;
  if (!rawOrder) return;
  // A retry can run after the order has already advanced. Always reconcile
  // and notify from the latest canonical value, never from the old event body.
  const latest = (await db.ref(`${ROOT}/orders/${rawOrder.customerId}/${rawOrder.id}`).get()).val() as SavrivoOrder | null;
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

export const onOrderUpdated = onValueUpdated({
  ref: `/${ROOT}/orders/{customerId}/{orderId}`,
  region: DATABASE_REGION,
  retry: true,
  timeoutSeconds: 60,
  memory: "256MiB",
}, async (event) => {
  const before = event.data.before.val() as SavrivoOrder | null;
  const rawOrder = event.data.after.val() as SavrivoOrder | null;
  if (!before || !rawOrder) return;
  const order = await scrubLegacyPublicOtp(rawOrder);
  await reconcileRestaurantOrderProjection(order);
  await reconcileRestaurantWorkload(order);
  await reconcileOperationalOrderProjection(order);
  if (["Accepted", "Preparing", "Ready for pickup"].includes(order.status) && !order.riderId) {
    const queue = (await db.ref(`${ROOT}/dispatchQueue/${order.id}`).get()).val() as {status?: string} | null;
    if (!queue || queue.status === "exhausted") await beginSequentialDispatch(order);
  }
  if (before.status === order.status) return;
  logger.info("ORDER_STATUS_CHANGED", {
    orderId: order.id,
    fromStatus: before.status,
    toStatus: order.status,
  });

  if (order.status === "Cancelled") {
    const updates: Record<string, unknown> = {
      [`${ROOT}/dispatchQueue/${order.id}/active`]: false,
      [`${ROOT}/dispatchQueue/${order.id}/status`]: "cancelled",
      [`${ROOT}/tracking/${order.id}`]: null,
      [`${ROOT}/private/trackingEvidence/${order.id}`]: null,
      [`${ROOT}/private/deliveryOtps/${order.id}`]: null,
    };
    if (order.riderId) updates[`${ROOT}/riderJobs/${order.riderId}/${order.id}/status`] = "cancelled";
    await db.ref().update(updates);
    await cancelDispatchOffers(order.id, "cancelled");
    if (before.riderId) {
      await recordRiderRewardOrderCancelledAfterAccept(
        before.riderId,
        order.id,
        Number.isFinite(Number(order.updatedAt)) ? Number(order.updatedAt) : Date.now(),
      );
    }
  }
  if (order.riderId) {
    if (order.status === "Assigned") {
      await db.ref(ROOT).update({
        [`riderJobs/${order.riderId}/${order.id}`]: buildRiderJobProjection(order),
        [`dispatchQueue/${order.id}/status`]: "assigned",
        [`dispatchQueue/${order.id}/active`]: false,
        [`dispatchQueue/${order.id}/updatedAt`]: order.updatedAt,
        [`riderPresence/${order.riderId}/activeOrderId`]: order.id,
      });
    } else {
      const jobRef = db.ref(`${ROOT}/riderJobs/${order.riderId}/${order.id}`);
      const existingJob = (await jobRef.get()).val() as Record<string, unknown> | null;
      await jobRef.set(buildRiderJobProjection(order, existingJob));
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
    await sideEffectLease(`rider-rewards:${order.id}`, async () => {
      await evaluateRiderRewardsForDeliveredOrder(order);
    });
    const deliveredUpdates: Record<string, null> = {
      [`${ROOT}/tracking/${order.id}`]: null,
      [`${ROOT}/private/trackingEvidence/${order.id}`]: null,
      [`${ROOT}/private/deliveryOtps/${order.id}`]: null,
    };
    if (order.riderId) deliveredUpdates[`${ROOT}/riderPresence/${order.riderId}/activeOrderId`] = null;
    await db.ref().update(deliveredUpdates);
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
      const queue = (await db.ref(`${ROOT}/dispatchQueue/${order.id}`).get()).val() as {candidates?: Array<{riderId?: string}>} | null;
      await stopRiderOffers((queue?.candidates ?? []).map((candidate) => String(candidate.riderId ?? "")).filter(Boolean), order.id, order.riderId!);
    }));
  }
  await Promise.all(notifications);
});

export const onRiderPresenceUpdated = onValueWritten({
  ref: `/${ROOT}/riderPresence/{riderId}`,
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
export const onRiderProfileEligibilitySourceWritten = onValueWritten({
  ref: `/${ROOT}/riders/{riderId}`,
  region: DATABASE_REGION,
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

export const onRiderWalletEligibilitySourceWritten = onValueWritten({
  ref: `/${ROOT}/riderWallets/{riderId}`,
  region: DATABASE_REGION,
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

export const onRiderJobEligibilitySourceWritten = onValueWritten({
  ref: `/${ROOT}/riderJobs/{riderId}/{orderId}`,
  region: DATABASE_REGION,
  retry: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (event) => {
  const parsed = Date.parse(String(event.time ?? ""));
  const eventAt = Number.isFinite(parsed) ? parsed : Date.now();
  const riderId = String(event.params.riderId);
  const workload = await reconcileRiderOperationalWorkload(
    riderId,
    String(event.params.orderId),
    event.data.before.exists() ? event.data.before.val() : null,
    event.data.after.exists() ? event.data.after.val() : null,
    eventAt,
  );
  await refreshRiderDispatchEligibility(
    riderId,
    eventAt,
    {workload},
  );
});

export const onReviewCreated = onValueCreated({
  ref: `/${ROOT}/reviews/{customerId}/{orderId}`,
  region: DATABASE_REGION,
  retry: true,
  timeoutSeconds: 30,
  memory: "256MiB",
}, async (event) => {
  const review = event.data.val() as {orderId?: string; restaurantId?: string; riderId?: string; rating?: number; riderRating?: number; postDeliveryTip?: unknown; growthContribution?: unknown} | null;
  if (!review) return;
  const customerId = String(event.params.customerId);
  const orderId = String(event.params.orderId);
  const order = (await db.ref(`${ROOT}/orders/${customerId}/${orderId}`).get()).val() as SavrivoOrder | null;
  if (!order || order.status !== "Delivered") {
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
