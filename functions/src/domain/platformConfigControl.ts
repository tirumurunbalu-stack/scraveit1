import {createHash} from "node:crypto";
import {z} from "zod";
import {
  normalizeDispatchPolicy,
  type DispatchPolicy,
} from "./dispatchPolicy";
import {
  normalizeFinancePolicy,
  type FinancePolicy,
} from "./financePolicy";

const dispatchPatchSchema = z.object({
  mode: z.enum(["sequential", "waves"]).optional(),
  initialRadiusKm: z.number().finite().min(0.25).max(100).optional(),
  radiusExpansionKm: z.number().finite().min(0).max(50).optional(),
  maxRadiusKm: z.number().finite().min(1).max(100).optional(),
  offerTimeoutSeconds: z.number().int().min(15).max(300).optional(),
  ridersPerWave: z.number().int().min(1).max(10).optional(),
  maxWaves: z.number().int().min(1).max(50).optional(),
  maxCandidates: z.number().int().min(1).max(100).optional(),
  presenceFreshMs: z.number().int().min(15_000).max(300_000).optional(),
  maxLocationAccuracyMeters: z.number().finite().min(10).max(500).optional(),
  reofferCooldownMs: z.number().int().min(30_000).max(24 * 60 * 60_000).optional(),
  fairnessLoadPenaltyKm: z.number().finite().min(0).max(100).optional(),
  claimLeaseSeconds: z.number().int().min(15).max(300).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Dispatch patch cannot be empty.");

const financePaymentsPatchSchema = z.object({
  defaultMethod: z.enum(["cod", "upi", "card"]).optional(),
  codEnabled: z.boolean().optional(),
  upiEnabled: z.boolean().optional(),
  cardEnabled: z.boolean().optional(),
  upiProvider: z.literal("phonepe").optional(),
  cardProvider: z.literal("phonepe").optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Payment patch cannot be empty.");

const financePayoutBeneficiaryPatchSchema = z.object({
  legalName: z.string().trim().max(160).optional(),
  contactName: z.string().trim().max(120).optional(),
  contactPhone: z.string().trim().max(32).optional(),
  contactEmail: z.string().trim().max(160).optional(),
  preferredMethod: z.enum(["upi", "imps", "neft"]).optional(),
  upiId: z.string().trim().max(120).optional(),
  bankAccountHolderName: z.string().trim().max(120).optional(),
  bankAccountNumber: z.string().trim().max(40).optional(),
  bankIfsc: z.string().trim().max(20).optional(),
  bankName: z.string().trim().max(120).optional(),
  branchName: z.string().trim().max(120).optional(),
  accountType: z.enum(["savings", "current"]).optional(),
  panNumber: z.string().trim().max(20).optional(),
  gstin: z.string().trim().max(24).optional(),
  notes: z.string().trim().max(500).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Platform beneficiary patch cannot be empty.");

const financePayoutsPatchSchema = z.object({
  upiEnabled: z.boolean().optional(),
  impsEnabled: z.boolean().optional(),
  neftEnabled: z.boolean().optional(),
  upiPreferredMaximumPaise: z.number().int().min(0).max(10_000_000_00).optional(),
  highValuePayoutMethod: z.enum(["imps", "neft"]).optional(),
  automation: z.object({
    enabled: z.boolean().optional(),
    cadence: z.literal("weekly").optional(),
    timezone: z.string().trim().max(80).optional(),
    executionDayOfWeek: z.number().int().min(0).max(6).optional(),
    executionMinuteOfDay: z.number().int().min(0).max(1_439).optional(),
    ridersEnabled: z.boolean().optional(),
    restaurantsEnabled: z.boolean().optional(),
    minimumRestaurantSettlementPaise: z.number().int().min(0).max(10_000_000_00).optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, "Payout automation patch cannot be empty.").optional(),
  platformBeneficiary: financePayoutBeneficiaryPatchSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Payout patch cannot be empty.");

const financePatchSchema = z.object({
  restaurantCommissionBps: z.number().int().min(0).max(5_000).optional(),
  codOutstandingLimitPaise: z.number().int().min(0).max(10_000_000_00).optional(),
  payments: financePaymentsPatchSchema.optional(),
  payouts: financePayoutsPatchSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Finance patch cannot be empty.");

export const updatePlatformConfigSchema = z.object({
  operationId: z.string().trim().min(8).max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Operation id contains unsupported characters."),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  dispatch: dispatchPatchSchema.optional(),
  finance: financePatchSchema.optional(),
}).strict().refine((value) => value.dispatch !== undefined || value.finance !== undefined, {
  message: "At least one policy section is required.",
});

export type UpdatePlatformConfigInput = z.infer<typeof updatePlatformConfigSchema>;

export interface PlatformConfigState {
  dispatch: DispatchPolicy;
  finance: FinancePolicy;
  revision: number;
  updatedAt: number;
  updatedBy: string;
  updatedByRole: "owner" | "ops_admin" | "";
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function safeNonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** Reads persisted config defensively; malformed values fall back through the
 * same safe normalizers used by runtime dispatch and finance code. */
export function platformConfigState(value: unknown): PlatformConfigState {
  const root = record(value);
  const metadata = record(root._meta);
  const updatedByRole = metadata.updatedByRole === "owner" || metadata.updatedByRole === "ops_admin"
    ? metadata.updatedByRole
    : "";
  return {
    dispatch: normalizeDispatchPolicy(root.dispatch),
    finance: normalizeFinancePolicy(root.finance),
    revision: safeNonNegativeInteger(metadata.revision),
    updatedAt: safeNonNegativeInteger(metadata.updatedAt),
    updatedBy: typeof metadata.updatedBy === "string" ? metadata.updatedBy.slice(0, 128) : "",
    updatedByRole,
  };
}

/** Applies a strictly validated partial update and returns complete canonical
 * policies. Cross-field checks reject unsafe operator mistakes rather than
 * silently storing a surprising configuration. */
export function applyPlatformConfigPatch(
  current: PlatformConfigState,
  input: UpdatePlatformConfigInput,
): Pick<PlatformConfigState, "dispatch" | "finance"> {
  const rawDispatch = {...current.dispatch, ...(input.dispatch ?? {})};
  if (rawDispatch.mode === "sequential" && input.dispatch?.radiusExpansionKm !== undefined &&
      input.dispatch.radiusExpansionKm !== 0) {
    throw new Error("DISPATCH_SEQUENTIAL_RADIUS_EXPANSION_MUST_BE_ZERO");
  }
  if (rawDispatch.mode === "sequential" && input.dispatch?.ridersPerWave !== undefined &&
      input.dispatch.ridersPerWave !== 1) {
    throw new Error("DISPATCH_SEQUENTIAL_RIDERS_PER_WAVE_MUST_BE_ONE");
  }
  if (rawDispatch.mode === "waves" && input.dispatch?.radiusExpansionKm === 0) {
    throw new Error("DISPATCH_WAVE_RADIUS_EXPANSION_REQUIRED");
  }
  if (rawDispatch.initialRadiusKm > rawDispatch.maxRadiusKm) {
    throw new Error("DISPATCH_INITIAL_RADIUS_EXCEEDS_MAXIMUM");
  }
  if (rawDispatch.ridersPerWave > rawDispatch.maxCandidates) {
    throw new Error("DISPATCH_RIDERS_PER_WAVE_EXCEEDS_MAX_CANDIDATES");
  }
  const rawFinance = {
    ...current.finance,
    ...(input.finance ?? {}),
    payments: {
      ...current.finance.payments,
      ...(input.finance?.payments ?? {}),
    },
    payouts: {
      ...current.finance.payouts,
      ...(input.finance?.payouts ?? {}),
      automation: {
        ...current.finance.payouts.automation,
        ...(input.finance?.payouts?.automation ?? {}),
      },
      platformBeneficiary: {
        ...current.finance.payouts.platformBeneficiary,
        ...(input.finance?.payouts?.platformBeneficiary ?? {}),
      },
    },
  };
  return {
    dispatch: normalizeDispatchPolicy(rawDispatch),
    finance: normalizeFinancePolicy(rawFinance),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const source = value as UnknownRecord;
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${canonical(source[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function platformConfigHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function platformConfigOperationKey(operationId: string): string {
  return platformConfigHash(operationId);
}
