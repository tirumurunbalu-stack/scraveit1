import {z} from "zod";
import {MAX_CART_LINES, MAX_ITEMS_PER_LINE} from "./config";

const identifier = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/);
const paymentMethodSchema = z.enum(["cod", "upi", "card"]);
const paymentProviderSchema = z.enum(["phonepe"]);

export const cartLineSchema = z.object({
  itemId: identifier,
  quantity: z.number().int().min(1).max(MAX_ITEMS_PER_LINE),
  variantId: z.string().trim().max(100).optional(),
  addOnIds: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  note: z.string().trim().max(200).default(""),
}).strict();

const createOrderBaseSchema = z.object({
  idempotencyKey: z.string().trim().min(16).max(80).regex(/^[A-Za-z0-9_-]+$/),
  restaurantId: identifier,
  items: z.array(cartLineSchema).min(1).max(MAX_CART_LINES),
  addressId: identifier,
  couponCode: z.string().trim().toUpperCase().max(30).default(""),
  tip: z.number().finite().min(0).max(10_000).default(0),
  deliveryMode: z.literal("asap").default("asap"),
  instructions: z.string().trim().max(500).default(""),
  contactless: z.boolean().default(false),
}).strict();

export const createCodOrderSchema = createOrderBaseSchema;

export const createOrderSchema = createOrderBaseSchema.extend({
  paymentMethod: paymentMethodSchema.default("cod"),
  paymentProvider: paymentProviderSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.paymentMethod === "cod" && value.paymentProvider !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["paymentProvider"],
      message: "Cash on delivery orders must not specify an online payment provider.",
    });
  }
});

export const recoverDeliveryOtpSchema = z.object({
  orderId: identifier,
}).strict();

// Optional cart context for getCheckoutConfiguration's fee-preview fields -
// intentionally accepts only items/restaurantId/addressId, never a client-
// supplied subtotal or fee amount, so the preview is computed the exact same
// server-trusted way as order creation itself.
export const checkoutPricingPreviewSchema = z.object({
  restaurantId: identifier,
  items: z.array(cartLineSchema).min(1).max(MAX_CART_LINES),
  addressId: identifier,
}).strict();

export const statusSchema = z.enum([
  "Order placed",
  "Accepted",
  "Preparing",
  "Ready for pickup",
  "Assigned",
  "Handed to rider",
  "Out for delivery",
  "Near you",
  "Arrived",
  "Delivered",
  "Cancelled",
]);

export const transitionOrderSchema = z.object({
  customerId: identifier,
  orderId: identifier,
  toStatus: statusSchema,
  reason: z.string().trim().max(500).default(""),
  deliveryOtp: z.string().trim().regex(/^\d{4,6}$/).optional(),
  cashCollected: z.boolean().default(false),
}).strict();

export const claimOrderSchema = z.object({
  orderId: identifier,
}).strict();

export const declineOrderSchema = claimOrderSchema;
export const markRiderArrivedRestaurantSchema = claimOrderSchema;

export const initiatePaymentSchema = z.object({
  customerId: identifier,
  orderId: identifier,
  provider: z.literal("phonepe"),
}).strict();

/**
 * An operator-supplied idempotency key is mandatory because a COD deposit may
 * be retried after the wallet reservation or immutable ledger write succeeds.
 * Amounts are integer paise; no floating-point rupee value crosses this API.
 */
export const recordCodRemittanceSchema = z.object({
  operationId: z.string().trim().min(16).max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Operation id contains unsupported characters."),
  riderId: identifier,
  amountPaise: z.number().int().positive().max(1_000_000_000),
  method: z.enum(["cash_deposit", "bank_transfer", "upi"]),
  referenceId: z.string().trim().min(1).max(120)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "Reference id contains unsupported characters.")
    .optional(),
}).strict().superRefine((value, context) => {
  if (value.method !== "cash_deposit" && !value.referenceId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["referenceId"],
      message: "A bank or UPI reference id is required for electronic remittance.",
    });
  }
});

export type RecordCodRemittanceInput = z.infer<typeof recordCodRemittanceSchema>;

const financePayoutMethodSchema = z.enum(["upi", "imps", "neft"]);

/**
 * A verified rider payout records money that has already been sent from the
 * platform treasury. The backend remains authoritative for payable amounts,
 * beneficiary validation, idempotency, and immutable ledger evidence.
 */
export const recordRiderPayoutSchema = z.object({
  operationId: z.string().trim().min(16).max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Operation id contains unsupported characters."),
  riderId: identifier,
  amountPaise: z.number().int().positive().max(1_000_000_000),
  method: financePayoutMethodSchema,
  referenceId: z.string().trim().min(1).max(120)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "Reference id contains unsupported characters."),
}).strict();

export type RecordRiderPayoutInput = z.infer<typeof recordRiderPayoutSchema>;

/**
 * A verified restaurant settlement records money that has already been sent
 * from the platform treasury to that restaurant's beneficiary destination.
 */
export const recordRestaurantSettlementSchema = z.object({
  operationId: z.string().trim().min(16).max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Operation id contains unsupported characters."),
  restaurantId: identifier,
  amountPaise: z.number().int().positive().max(1_000_000_000),
  method: financePayoutMethodSchema,
  referenceId: z.string().trim().min(1).max(120)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "Reference id contains unsupported characters."),
}).strict();

export type RecordRestaurantSettlementInput = z.infer<typeof recordRestaurantSettlementSchema>;

/**
 * Bounded control-plane reads. Admin clients must never select the complete
 * production order or ledger trees just to render their home screen.
 */
export const adminDashboardQuerySchema = z.object({
  activeLimit: z.number().int().min(1).max(250).default(100),
  recentLimit: z.number().int().min(1).max(250).default(100),
  ledgerLimit: z.number().int().min(1).max(250).default(100),
  codLimit: z.number().int().min(1).max(100).default(100),
}).strict();

export type AdminDashboardQueryInput = z.infer<typeof adminDashboardQuerySchema>;

/** An empty/omitted city exports every city; a non-empty one scopes customers, riders and restaurants to it. */
export const exportPlatformDataWorkbookSchema = z.object({
  city: z.string().trim().max(120).optional(),
}).strict();

/**
 * Rider finance is a read-only, bounded server projection. A rider omits
 * riderId and receives their own result; a claim-verified operator may provide
 * one to inspect that rider. The backend never accepts monetary totals here.
 */
export const riderFinancialSummaryQuerySchema = z.object({
  riderId: identifier.optional(),
  referenceAt: z.number().int().positive().optional(),
  ledgerLimit: z.number().int().min(1).max(250).default(250),
  historyLimit: z.number().int().min(1).max(100).default(50),
}).strict();

export type RiderFinancialSummaryQueryInput = z.infer<typeof riderFinancialSummaryQuerySchema>;

const rewardSectionSchema = z.enum([
  "breakfast",
  "lunch",
  "snacks",
  "dinner",
  "late_night",
  "special",
]);

const rewardDisplayTypeSchema = z.enum([
  "trip_milestone",
  "surge",
  "rain_surge",
  "shift_bonus",
  "daily_incentive",
  "weekly_incentive",
  "zone_bonus",
  "special_campaign",
]);

const rewardKindSchema = z.enum([
  "per_order_bonus",
  "milestone_bonus",
]);

const rewardWindowSchema = z.enum([
  "daily",
  "weekly",
  "custom",
]);

const rewardStackingSchema = z.enum([
  "stack",
  "highest_only",
]);

const rewardMilestonePayoutModeSchema = z.enum([
  "highest_unlocked",
  "cumulative",
]);

const rewardSlotOverlapModeSchema = z.enum([
  "no_double_count",
  "allow_double_count",
]);

const rewardTripAttributionSchema = z.enum([
  "delivered_at",
]);

const rewardMilestoneSchema = z.object({
  target: z.number().int().min(1).max(100_000),
  rewardAmountPaise: z.number().int().positive().max(1_000_000_000),
  label: z.string().trim().max(80).default(""),
}).strict();

const rewardTimeSlotSchema = z.object({
  label: z.string().trim().min(1).max(80),
  startMinute: z.number().int().min(0).max(1_439),
  endMinute: z.number().int().min(0).max(1_439),
}).strict().refine((value) => value.startMinute !== value.endMinute, {
  message: "A time slot must have a non-zero duration.",
  path: ["endMinute"],
});

const rewardConditionSlotSchema = z.object({
  slotId: identifier.optional(),
  label: z.string().trim().min(1).max(80),
  startMinute: z.number().int().min(0).max(1_439),
  endMinute: z.number().int().min(0).max(1_439),
  requiredDurationMinutes: z.number().int().min(0).max(1_440).optional(),
  requiredActiveDurationMinutes: z.number().int().min(0).max(1_440).optional(),
  requiredOnlinePercentage: z.number().finite().min(0).max(100).optional(),
  minimumOrdersAccepted: z.number().int().min(0).max(10_000).optional(),
  minimumCompletedDeliveries: z.number().int().min(0).max(10_000).optional(),
  offlineToleranceMinutes: z.number().int().min(0).max(240).default(10),
  gracePeriodMinutes: z.number().int().min(0).max(240).default(0),
  overlapMode: rewardSlotOverlapModeSchema.default("no_double_count"),
  disabledCityNames: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
}).strict().superRefine((value, context) => {
  if (value.startMinute === value.endMinute) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endMinute"],
      message: "A login slot must have a non-zero duration.",
    });
  }
});

const rewardConditionGroupSchema = z.object({
  groupId: identifier.optional(),
  title: z.string().trim().min(1).max(80).default("Login condition group"),
  minimumSlotsRequired: z.number().int().min(1).max(24).default(1),
  slots: z.array(rewardConditionSlotSchema).min(1).max(24),
}).strict().superRefine((value, context) => {
  if (value.minimumSlotsRequired > value.slots.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["minimumSlotsRequired"],
      message: "Minimum required slots cannot exceed the number of slot options in the group.",
    });
  }
});

const rewardOtherConditionTypeSchema = z.enum([
  "max_rejected_orders",
  "max_cancelled_booked_shifts",
  "max_incomplete_shifts",
  "max_cancelled_accepted_orders",
  "min_acceptance_rate",
  "min_completion_rate",
  "min_customer_rating",
  "max_offline_duration_minutes",
  "min_active_duration_minutes",
  "min_completed_trips",
]);

const rewardOtherConditionSchema = z.object({
  conditionId: identifier.optional(),
  type: rewardOtherConditionTypeSchema,
  title: z.string().trim().max(120).default(""),
  maximumCount: z.number().int().min(0).max(100_000).optional(),
  minimumCount: z.number().int().min(0).max(100_000).optional(),
  minimumPercentage: z.number().finite().min(0).max(100).optional(),
  maximumMinutes: z.number().int().min(0).max(100_000).optional(),
  minimumMinutes: z.number().int().min(0).max(100_000).optional(),
  minimumRating: z.number().finite().min(0).max(5).optional(),
  enabled: z.boolean().default(true),
}).strict().superRefine((value, context) => {
  const missingThreshold = (path: string, message: string) => context.addIssue({
    code: z.ZodIssueCode.custom,
    path: [path],
    message,
  });
  switch (value.type) {
  case "max_rejected_orders":
  case "max_cancelled_booked_shifts":
  case "max_incomplete_shifts":
  case "max_cancelled_accepted_orders":
    if (value.maximumCount === undefined) {
      missingThreshold("maximumCount", "This condition requires a maximum count.");
    }
    break;
  case "min_completed_trips":
    if (value.minimumCount === undefined) {
      missingThreshold("minimumCount", "This condition requires a minimum trip count.");
    }
    break;
  case "min_acceptance_rate":
  case "min_completion_rate":
    if (value.minimumPercentage === undefined) {
      missingThreshold("minimumPercentage", "This condition requires a minimum percentage.");
    }
    break;
  case "min_customer_rating":
    if (value.minimumRating === undefined) {
      missingThreshold("minimumRating", "This condition requires a minimum rating.");
    }
    break;
  case "max_offline_duration_minutes":
    if (value.maximumMinutes === undefined) {
      missingThreshold("maximumMinutes", "This condition requires a maximum offline duration.");
    }
    break;
  case "min_active_duration_minutes":
    if (value.minimumMinutes === undefined) {
      missingThreshold("minimumMinutes", "This condition requires a minimum active duration.");
    }
    break;
  }
});

export const riderRewardCampaignSchema = z.object({
  internalName: z.string().trim().min(3).max(120),
  title: z.string().trim().min(3).max(120),
  subtitle: z.string().trim().max(160).default(""),
  description: z.string().trim().max(500).default(""),
  kind: rewardKindSchema,
  displayType: rewardDisplayTypeSchema,
  section: rewardSectionSchema.default("special"),
  rewardAmountPaise: z.number().int().positive().max(1_000_000_000).optional(),
  milestones: z.array(rewardMilestoneSchema).max(20).default([]),
  window: rewardWindowSchema.default("daily"),
  startAt: z.number().int().positive(),
  endAt: z.number().int().positive(),
  eligibleDays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  timeSlots: z.array(rewardTimeSlotSchema).max(12).default([]),
  cityNames: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  zoneNames: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  restaurantIds: z.array(identifier).max(100).default([]),
  riderIds: z.array(identifier).max(200).default([]),
  minCompletedTrips: z.number().int().min(0).max(100_000).optional(),
  minRating: z.number().finite().min(0).max(5).optional(),
  firstNCompletedTrips: z.number().int().min(1).max(100_000).optional(),
  orderTotalMinPaise: z.number().int().min(0).max(1_000_000_000).optional(),
  rainOnly: z.boolean().default(false),
  requireDailyLoginSession: z.boolean().default(false),
  minimumCompletedSessionsPerDay: z.number().int().min(1).max(24).optional(),
  conditionGroups: z.array(rewardConditionGroupSchema).max(12).default([]),
  otherConditions: z.array(rewardOtherConditionSchema).max(32).default([]),
  milestonePayoutMode: rewardMilestonePayoutModeSchema.default("highest_unlocked"),
  timezone: z.string().trim().min(1).max(80).default("Asia/Kolkata"),
  tripAttribution: rewardTripAttributionSchema.default("delivered_at"),
  allowOverlappingSlotCredit: z.boolean().default(false),
  eligibleRiderTypes: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  vehicleTypes: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  minimumAccountAgeDays: z.number().int().min(0).max(10_000).optional(),
  stacking: rewardStackingSchema.default("stack"),
  priority: z.number().int().min(0).max(1_000).default(100),
  visible: z.boolean().default(true),
  active: z.boolean().default(true),
  archived: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.endAt <= value.startAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endAt"],
      message: "End time must be after start time.",
    });
  }
  if (value.kind === "per_order_bonus" && value.rewardAmountPaise === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rewardAmountPaise"],
      message: "Per-order campaigns require a fixed reward amount.",
    });
  }
  if (value.kind === "milestone_bonus" && value.milestones.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["milestones"],
      message: "Milestone campaigns require at least one milestone.",
    });
  }
  if (value.kind === "milestone_bonus" && value.rewardAmountPaise !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rewardAmountPaise"],
      message: "Milestone campaigns use milestone rewards instead of a fixed per-order amount.",
    });
  }
  const targets = new Set<number>();
  for (const milestone of value.milestones) {
    if (targets.has(milestone.target)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["milestones"],
        message: "Milestone targets must be unique.",
      });
      break;
    }
    targets.add(milestone.target);
  }
  // Archiving only files a campaign away - it must never be blocked by a content-quality
  // rule meant for campaigns still being actively created or edited, or a legacy-shaped
  // campaign could never be archived at all. Restoring it back out of the archive does
  // still have to satisfy this rule, same as creating a new campaign would.
  if (value.archived !== true && value.conditionGroups.length === 0 &&
      value.requireDailyLoginSession !== true &&
      value.kind === "milestone_bonus" && value.timeSlots.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["conditionGroups"],
      message: "Milestone incentive campaigns should use login condition groups instead of a flat time-slot list.",
    });
  }
});

export const riderRewardsDashboardQuerySchema = z.object({
  riderId: identifier.optional(),
  referenceAt: z.number().int().positive().optional(),
  ledgerLimit: z.number().int().min(1).max(500).default(250),
  historyLimit: z.number().int().min(1).max(200).default(100),
  campaignLimit: z.number().int().min(1).max(200).default(100),
}).strict();

export type RiderRewardsDashboardQueryInput = z.infer<typeof riderRewardsDashboardQuerySchema>;

export const adminRiderRewardsDashboardQuerySchema = z.object({
  ledgerLimit: z.number().int().min(1).max(1_000).default(500),
  campaignLimit: z.number().int().min(1).max(250).default(200),
  progressLimit: z.number().int().min(1).max(2_000).default(1_000),
  riderPreviewLimit: z.number().int().min(1).max(200).default(60),
}).strict();

export type AdminRiderRewardsDashboardQueryInput = z.infer<typeof adminRiderRewardsDashboardQuerySchema>;

export const upsertRiderRewardCampaignSchema = z.object({
  operationId: z.string().trim().min(8).max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Operation id contains unsupported characters."),
  campaignId: identifier,
  expectedUpdatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  campaign: riderRewardCampaignSchema,
}).strict();

export type UpsertRiderRewardCampaignInput = z.infer<typeof upsertRiderRewardCampaignSchema>;

export const updateRiderRewardSettingsSchema = z.object({
  operationId: z.string().trim().min(8).max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Operation id contains unsupported characters."),
  expectedUpdatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  payoutMinimumPaise: z.number().int().min(0).max(1_000_000_000).optional(),
  referralProgramActive: z.boolean().optional(),
  inviterRewardPaise: z.number().int().min(0).max(1_000_000_000).optional(),
  inviteeRewardPaise: z.number().int().min(0).max(1_000_000_000).optional(),
  referralMinCompletedTrips: z.number().int().min(0).max(100_000).optional(),
  referralMaxRewardsPerRider: z.number().int().min(0).max(100_000).optional(),
}).strict().refine((value) => Object.keys(value).some((key) => !["operationId", "expectedUpdatedAt"].includes(key)), {
  message: "At least one rider rewards setting is required.",
});

export type UpdateRiderRewardSettingsInput = z.infer<typeof updateRiderRewardSettingsSchema>;

/**
 * Restaurant settlement is a read-only server-derived ledger view. The
 * caller chooses only the restaurant and bounded history window; clients
 * never submit monetary totals or settlement state.
 */
export const restaurantSettlementQuerySchema = z.object({
  restaurantId: identifier,
  ledgerLimit: z.number().int().min(1).max(2_000).default(1_000),
  historyLimit: z.number().int().min(1).max(100).default(50),
}).strict();

export type RestaurantSettlementQueryInput = z.infer<typeof restaurantSettlementQuerySchema>;

export const deviceAppSchema = z.enum(["customer", "restaurant", "rider", "admin"]);
export const devicePlatformSchema = z.enum(["android", "ios"]);

export const registerDeviceTokenSchema = z.object({
  token: z.string().trim().min(20).max(4096),
  app: deviceAppSchema,
  platform: devicePlatformSchema,
  appVersion: z.string().trim().max(40).default(""),
  deviceModel: z.string().trim().max(120).default(""),
}).strict();

export const unregisterDeviceTokenSchema = z.object({
  token: z.string().trim().min(20).max(4096),
}).strict();

export function validationMessage(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
}
