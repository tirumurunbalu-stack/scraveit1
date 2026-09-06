export type CheckoutPaymentMethod = "cod" | "upi" | "card";
export type CheckoutPaymentProvider = "phonepe";
export type FinancePayoutMethod = "upi" | "imps" | "neft";
export type FinancePayoutBankMethod = "imps" | "neft";
export type FinanceBeneficiaryAccountType = "savings" | "current";
export type FinancePayoutAutomationCadence = "weekly";

export interface FinancePaymentPolicy {
  defaultMethod: CheckoutPaymentMethod;
  codEnabled: boolean;
  upiEnabled: boolean;
  cardEnabled: boolean;
  upiProvider: CheckoutPaymentProvider;
  cardProvider: CheckoutPaymentProvider;
}

export interface FinancePayoutBeneficiaryProfile {
  legalName: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  preferredMethod: FinancePayoutMethod;
  upiId: string;
  bankAccountHolderName: string;
  bankAccountNumber: string;
  bankIfsc: string;
  bankName: string;
  branchName: string;
  accountType: FinanceBeneficiaryAccountType;
  panNumber: string;
  gstin: string;
  notes: string;
}

export interface FinancePayoutAutomationPolicy {
  enabled: boolean;
  cadence: FinancePayoutAutomationCadence;
  timezone: string;
  executionDayOfWeek: number;
  executionMinuteOfDay: number;
  ridersEnabled: boolean;
  restaurantsEnabled: boolean;
  minimumRestaurantSettlementPaise: number;
}

export interface FinancePayoutPolicy {
  upiEnabled: boolean;
  impsEnabled: boolean;
  neftEnabled: boolean;
  upiPreferredMaximumPaise: number;
  highValuePayoutMethod: FinancePayoutBankMethod;
  platformBeneficiary: FinancePayoutBeneficiaryProfile;
  automation: FinancePayoutAutomationPolicy;
}

export interface FinancePayoutAutomationSummary {
  enabled: boolean;
  cadence: FinancePayoutAutomationCadence;
  timezone: string;
  executionDayOfWeek: number;
  executionMinuteOfDay: number;
  scheduleLabel: string;
  currentPeriodKey: string | null;
  nextRunDayKey: string | null;
  ridersEnabled: boolean;
  restaurantsEnabled: boolean;
  minimumRestaurantSettlementPaise: number;
}

export interface CheckoutPaymentMethodAvailability {
  enabled: boolean;
  available: boolean;
  provider?: CheckoutPaymentProvider;
}

export interface CheckoutConfiguration {
  version: 1;
  defaultMethod: CheckoutPaymentMethod;
  onlineGatewayConfigured: boolean;
  methods: {
    cod: CheckoutPaymentMethodAvailability;
    upi: CheckoutPaymentMethodAvailability;
    card: CheckoutPaymentMethodAvailability;
  };
}

export interface FinancePolicy {
  version: 1;
  /** 1,500 basis points = 15%. */
  restaurantCommissionBps: number;
  /** Zero is an explicit owner override; production defaults to a finite exposure limit. */
  codOutstandingLimitPaise: number;
  payments: FinancePaymentPolicy;
  payouts: FinancePayoutPolicy;
}

/** Conservative initial exposure ceiling: INR 5,000 per rider. Operations can
 * change it through the existing custom-claim guarded platform configuration
 * control plane without an application release. */
export const DEFAULT_COD_OUTSTANDING_LIMIT_PAISE = 500_000;

export const DEFAULT_FINANCE_PAYMENT_POLICY: Readonly<FinancePaymentPolicy> = Object.freeze({
  defaultMethod: "cod",
  codEnabled: true,
  upiEnabled: false,
  cardEnabled: false,
  upiProvider: "phonepe",
  cardProvider: "phonepe",
});

export const DEFAULT_FINANCE_PAYOUT_BENEFICIARY: Readonly<FinancePayoutBeneficiaryProfile> = Object.freeze({
  legalName: "",
  contactName: "",
  contactPhone: "",
  contactEmail: "",
  preferredMethod: "neft",
  upiId: "",
  bankAccountHolderName: "",
  bankAccountNumber: "",
  bankIfsc: "",
  bankName: "",
  branchName: "",
  accountType: "current",
  panNumber: "",
  gstin: "",
  notes: "",
});

export const DEFAULT_FINANCE_PAYOUT_AUTOMATION_POLICY: Readonly<FinancePayoutAutomationPolicy> = Object.freeze({
  enabled: false,
  cadence: "weekly",
  timezone: "Asia/Kolkata",
  executionDayOfWeek: 1,
  executionMinuteOfDay: 10 * 60 + 30,
  ridersEnabled: true,
  restaurantsEnabled: true,
  minimumRestaurantSettlementPaise: 0,
});

export const DEFAULT_FINANCE_PAYOUT_POLICY: Readonly<FinancePayoutPolicy> = Object.freeze({
  upiEnabled: true,
  impsEnabled: true,
  neftEnabled: true,
  upiPreferredMaximumPaise: 10_000_000,
  highValuePayoutMethod: "neft",
  platformBeneficiary: DEFAULT_FINANCE_PAYOUT_BENEFICIARY,
  automation: DEFAULT_FINANCE_PAYOUT_AUTOMATION_POLICY,
});

export const DEFAULT_FINANCE_POLICY: Readonly<FinancePolicy> = Object.freeze({
  version: 1,
  restaurantCommissionBps: 1_500,
  codOutstandingLimitPaise: DEFAULT_COD_OUTSTANDING_LIMIT_PAISE,
  payments: DEFAULT_FINANCE_PAYMENT_POLICY,
  payouts: DEFAULT_FINANCE_PAYOUT_POLICY,
});

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(Math.min(maximum, Math.max(minimum, parsed))) : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function paymentMethod(value: unknown, fallback: CheckoutPaymentMethod): CheckoutPaymentMethod {
  return value === "cod" || value === "upi" || value === "card" ? value : fallback;
}

function paymentProvider(value: unknown, fallback: CheckoutPaymentProvider): CheckoutPaymentProvider {
  return value === "phonepe" ? value : fallback;
}

function payoutMethod(value: unknown, fallback: FinancePayoutMethod): FinancePayoutMethod {
  return value === "upi" || value === "imps" || value === "neft" ? value : fallback;
}

function payoutBankMethod(value: unknown, fallback: FinancePayoutBankMethod): FinancePayoutBankMethod {
  return value === "imps" || value === "neft" ? value : fallback;
}

function payoutAutomationCadence(
  value: unknown,
  fallback: FinancePayoutAutomationCadence,
): FinancePayoutAutomationCadence {
  return value === "weekly" ? value : fallback;
}

function accountType(value: unknown, fallback: FinanceBeneficiaryAccountType): FinanceBeneficiaryAccountType {
  return value === "current" || value === "savings" ? value : fallback;
}

function textValue(value: unknown, fallback: string, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : fallback;
}

function validTimeZone(value: string, fallback: string): string {
  try {
    Intl.DateTimeFormat("en-US", {timeZone: value}).format(0);
    return value;
  } catch {
    return fallback;
  }
}

function firstEnabledMethod(policy: Pick<FinancePaymentPolicy, "codEnabled" | "upiEnabled" | "cardEnabled">): CheckoutPaymentMethod {
  if (policy.codEnabled) return "cod";
  if (policy.upiEnabled) return "upi";
  return "card";
}

export function normalizeFinancePaymentPolicy(value: unknown): FinancePaymentPolicy {
  const input = record(value);
  let codEnabled = booleanValue(input.codEnabled, DEFAULT_FINANCE_PAYMENT_POLICY.codEnabled);
  const upiEnabled = booleanValue(input.upiEnabled, DEFAULT_FINANCE_PAYMENT_POLICY.upiEnabled);
  const cardEnabled = booleanValue(input.cardEnabled, DEFAULT_FINANCE_PAYMENT_POLICY.cardEnabled);
  if (!codEnabled && !upiEnabled && !cardEnabled) codEnabled = true;
  let defaultMethod = paymentMethod(input.defaultMethod, DEFAULT_FINANCE_PAYMENT_POLICY.defaultMethod);
  if (
    (defaultMethod === "cod" && !codEnabled) ||
    (defaultMethod === "upi" && !upiEnabled) ||
    (defaultMethod === "card" && !cardEnabled)
  ) {
    defaultMethod = firstEnabledMethod({codEnabled, upiEnabled, cardEnabled});
  }
  return {
    defaultMethod,
    codEnabled,
    upiEnabled,
    cardEnabled,
    upiProvider: paymentProvider(input.upiProvider, DEFAULT_FINANCE_PAYMENT_POLICY.upiProvider),
    cardProvider: paymentProvider(input.cardProvider, DEFAULT_FINANCE_PAYMENT_POLICY.cardProvider),
  };
}

export function normalizeFinancePayoutBeneficiaryProfile(value: unknown): FinancePayoutBeneficiaryProfile {
  const input = record(value);
  return {
    legalName: textValue(input.legalName, DEFAULT_FINANCE_PAYOUT_BENEFICIARY.legalName, 160),
    contactName: textValue(input.contactName, DEFAULT_FINANCE_PAYOUT_BENEFICIARY.contactName, 120),
    contactPhone: textValue(input.contactPhone, DEFAULT_FINANCE_PAYOUT_BENEFICIARY.contactPhone, 32),
    contactEmail: textValue(input.contactEmail, DEFAULT_FINANCE_PAYOUT_BENEFICIARY.contactEmail, 160),
    preferredMethod: payoutMethod(input.preferredMethod, DEFAULT_FINANCE_PAYOUT_BENEFICIARY.preferredMethod),
    upiId: textValue(input.upiId, DEFAULT_FINANCE_PAYOUT_BENEFICIARY.upiId, 120),
    bankAccountHolderName: textValue(
      input.bankAccountHolderName,
      DEFAULT_FINANCE_PAYOUT_BENEFICIARY.bankAccountHolderName,
      120,
    ),
    bankAccountNumber: textValue(input.bankAccountNumber, DEFAULT_FINANCE_PAYOUT_BENEFICIARY.bankAccountNumber, 40),
    bankIfsc: textValue(input.bankIfsc, DEFAULT_FINANCE_PAYOUT_BENEFICIARY.bankIfsc, 20).toUpperCase(),
    bankName: textValue(input.bankName, DEFAULT_FINANCE_PAYOUT_BENEFICIARY.bankName, 120),
    branchName: textValue(input.branchName, DEFAULT_FINANCE_PAYOUT_BENEFICIARY.branchName, 120),
    accountType: accountType(input.accountType, DEFAULT_FINANCE_PAYOUT_BENEFICIARY.accountType),
    panNumber: textValue(input.panNumber, DEFAULT_FINANCE_PAYOUT_BENEFICIARY.panNumber, 20).toUpperCase(),
    gstin: textValue(input.gstin, DEFAULT_FINANCE_PAYOUT_BENEFICIARY.gstin, 24).toUpperCase(),
    notes: textValue(input.notes, DEFAULT_FINANCE_PAYOUT_BENEFICIARY.notes, 500),
  };
}

export function normalizeFinancePayoutAutomationPolicy(value: unknown): FinancePayoutAutomationPolicy {
  const input = record(value);
  const timezone = textValue(
    input.timezone,
    DEFAULT_FINANCE_PAYOUT_AUTOMATION_POLICY.timezone,
    80,
  );
  return {
    enabled: booleanValue(input.enabled, DEFAULT_FINANCE_PAYOUT_AUTOMATION_POLICY.enabled),
    cadence: payoutAutomationCadence(input.cadence, DEFAULT_FINANCE_PAYOUT_AUTOMATION_POLICY.cadence),
    timezone: validTimeZone(timezone, DEFAULT_FINANCE_PAYOUT_AUTOMATION_POLICY.timezone),
    executionDayOfWeek: boundedInteger(
      input.executionDayOfWeek,
      DEFAULT_FINANCE_PAYOUT_AUTOMATION_POLICY.executionDayOfWeek,
      0,
      6,
    ),
    executionMinuteOfDay: boundedInteger(
      input.executionMinuteOfDay,
      DEFAULT_FINANCE_PAYOUT_AUTOMATION_POLICY.executionMinuteOfDay,
      0,
      1_439,
    ),
    ridersEnabled: booleanValue(input.ridersEnabled, DEFAULT_FINANCE_PAYOUT_AUTOMATION_POLICY.ridersEnabled),
    restaurantsEnabled: booleanValue(
      input.restaurantsEnabled,
      DEFAULT_FINANCE_PAYOUT_AUTOMATION_POLICY.restaurantsEnabled,
    ),
    minimumRestaurantSettlementPaise: boundedInteger(
      input.minimumRestaurantSettlementPaise,
      DEFAULT_FINANCE_PAYOUT_AUTOMATION_POLICY.minimumRestaurantSettlementPaise,
      0,
      10_000_000_00,
    ),
  };
}

export function normalizeFinancePayoutPolicy(value: unknown): FinancePayoutPolicy {
  const input = record(value);
  const upiEnabled = booleanValue(input.upiEnabled, DEFAULT_FINANCE_PAYOUT_POLICY.upiEnabled);
  let impsEnabled = booleanValue(input.impsEnabled, DEFAULT_FINANCE_PAYOUT_POLICY.impsEnabled);
  let neftEnabled = booleanValue(input.neftEnabled, DEFAULT_FINANCE_PAYOUT_POLICY.neftEnabled);
  if (!upiEnabled && !impsEnabled && !neftEnabled) neftEnabled = true;
  let highValuePayoutMethod = payoutBankMethod(
    input.highValuePayoutMethod,
    DEFAULT_FINANCE_PAYOUT_POLICY.highValuePayoutMethod,
  );
  if (highValuePayoutMethod === "imps" && !impsEnabled) {
    highValuePayoutMethod = neftEnabled ? "neft" : "imps";
    if (!impsEnabled && !neftEnabled) impsEnabled = true;
  }
  if (highValuePayoutMethod === "neft" && !neftEnabled) {
    highValuePayoutMethod = impsEnabled ? "imps" : "neft";
    if (!impsEnabled && !neftEnabled) neftEnabled = true;
  }
  return {
    upiEnabled,
    impsEnabled,
    neftEnabled,
    upiPreferredMaximumPaise: boundedInteger(
      input.upiPreferredMaximumPaise,
      DEFAULT_FINANCE_PAYOUT_POLICY.upiPreferredMaximumPaise,
      0,
      10_000_000_00,
    ),
    highValuePayoutMethod,
    platformBeneficiary: normalizeFinancePayoutBeneficiaryProfile(input.platformBeneficiary),
    automation: normalizeFinancePayoutAutomationPolicy(input.automation),
  };
}

export function financePaymentMethodEnabled(
  policy: Pick<FinancePolicy, "payments">,
  method: CheckoutPaymentMethod,
): boolean {
  if (method === "cod") return policy.payments.codEnabled;
  if (method === "upi") return policy.payments.upiEnabled;
  return policy.payments.cardEnabled;
}

export function financePaymentProviderForMethod(
  policy: Pick<FinancePolicy, "payments">,
  method: CheckoutPaymentMethod,
): CheckoutPaymentProvider | undefined {
  if (method === "upi") return policy.payments.upiProvider;
  if (method === "card") return policy.payments.cardProvider;
  return undefined;
}

export function resolveFinancePaymentSelection(
  policy: Pick<FinancePolicy, "payments">,
  request: {paymentMethod?: unknown; paymentProvider?: unknown},
): {paymentMethod: CheckoutPaymentMethod; paymentProvider?: CheckoutPaymentProvider} {
  const requestedMethod = paymentMethod(request.paymentMethod, policy.payments.defaultMethod);
  if (!financePaymentMethodEnabled(policy, requestedMethod)) {
    throw new Error(`PAYMENT_METHOD_DISABLED:${requestedMethod}`);
  }
  if (requestedMethod === "cod") {
    return {paymentMethod: "cod"};
  }
  const preferredProvider = financePaymentProviderForMethod(policy, requestedMethod);
  if (!preferredProvider) throw new Error(`PAYMENT_PROVIDER_MISSING:${requestedMethod}`);
  const requestedProvider = paymentProvider(request.paymentProvider, preferredProvider);
  if (requestedProvider !== preferredProvider) {
    throw new Error(`PAYMENT_PROVIDER_UNAVAILABLE:${requestedMethod}`);
  }
  return {
    paymentMethod: requestedMethod,
    paymentProvider: requestedProvider,
  };
}

export function checkoutConfiguration(
  policy: Pick<FinancePolicy, "payments">,
  onlineGatewayConfigured: boolean,
): CheckoutConfiguration {
  const cod = {
    enabled: policy.payments.codEnabled,
    available: policy.payments.codEnabled,
  };
  const upi = {
    enabled: policy.payments.upiEnabled,
    available: policy.payments.upiEnabled && onlineGatewayConfigured,
    provider: policy.payments.upiProvider,
  };
  const card = {
    enabled: policy.payments.cardEnabled,
    available: policy.payments.cardEnabled && onlineGatewayConfigured,
    provider: policy.payments.cardProvider,
  };
  return {
    version: 1,
    defaultMethod: policy.payments.defaultMethod,
    onlineGatewayConfigured,
    methods: {cod, upi, card},
  };
}

export function recommendedFinancePayoutMethod(
  policy: Pick<FinancePolicy, "payouts">,
  amountPaise: number,
): FinancePayoutMethod {
  const amount = Number.isFinite(amountPaise) ? Math.max(0, Math.round(amountPaise)) : 0;
  if (amount <= policy.payouts.upiPreferredMaximumPaise && policy.payouts.upiEnabled) {
    return "upi";
  }
  if (amount > policy.payouts.upiPreferredMaximumPaise) {
    if (policy.payouts.highValuePayoutMethod === "neft" && policy.payouts.neftEnabled) return "neft";
    if (policy.payouts.highValuePayoutMethod === "imps" && policy.payouts.impsEnabled) return "imps";
  }
  if (policy.payouts.upiEnabled) return "upi";
  if (policy.payouts.impsEnabled) return "imps";
  return "neft";
}

export type FinancePayoutAutomationBlockedReason =
  | "AUTOMATION_DISABLED"
  | "HIGH_VALUE_REQUIRES_BANK"
  | "UPI_OR_BANK_DETAILS_REQUIRED"
  | "PREFERRED_RAIL_UNAVAILABLE"
  | "NO_ENABLED_RAIL";

export function selectFinancePayoutMethodForAutomation(
  policy: Pick<FinancePolicy, "payouts">,
  amountPaise: number,
  readiness: {
    preferredMethod?: FinancePayoutMethod | null;
    upiReady: boolean;
    bankReady: boolean;
  },
): {method: FinancePayoutMethod | null; blockedReason: FinancePayoutAutomationBlockedReason | null} {
  const amount = Number.isFinite(amountPaise) ? Math.max(0, Math.round(amountPaise)) : 0;
  const preferredMethod = readiness.preferredMethod === "upi" ||
    readiness.preferredMethod === "imps" ||
    readiness.preferredMethod === "neft"
    ? readiness.preferredMethod
    : null;
  const supports = (method: FinancePayoutMethod): boolean => {
    if (method === "upi") return policy.payouts.upiEnabled && readiness.upiReady;
    if (method === "imps") return policy.payouts.impsEnabled && readiness.bankReady;
    return policy.payouts.neftEnabled && readiness.bankReady;
  };

  if (amount > policy.payouts.upiPreferredMaximumPaise) {
    if (!readiness.bankReady) return {method: null, blockedReason: "HIGH_VALUE_REQUIRES_BANK"};
    if (policy.payouts.highValuePayoutMethod === "neft" && supports("neft")) {
      return {method: "neft", blockedReason: null};
    }
    if (policy.payouts.highValuePayoutMethod === "imps" && supports("imps")) {
      return {method: "imps", blockedReason: null};
    }
    if (supports("neft")) return {method: "neft", blockedReason: null};
    if (supports("imps")) return {method: "imps", blockedReason: null};
    return {method: null, blockedReason: "NO_ENABLED_RAIL"};
  }

  if (preferredMethod && supports(preferredMethod)) {
    return {method: preferredMethod, blockedReason: null};
  }

  const recommended = recommendedFinancePayoutMethod(policy, amount);
  if (supports(recommended)) return {method: recommended, blockedReason: null};
  if (supports("upi")) return {method: "upi", blockedReason: null};
  if (supports("imps")) return {method: "imps", blockedReason: null};
  if (supports("neft")) return {method: "neft", blockedReason: null};

  if (!readiness.upiReady && !readiness.bankReady) {
    return {method: null, blockedReason: "UPI_OR_BANK_DETAILS_REQUIRED"};
  }
  if (preferredMethod && !supports(preferredMethod)) {
    return {method: null, blockedReason: "PREFERRED_RAIL_UNAVAILABLE"};
  }
  return {method: null, blockedReason: "NO_ENABLED_RAIL"};
}

const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

function weekdayLabel(index: number): string {
  return WEEKDAY_LABELS[Math.max(0, Math.min(WEEKDAY_LABELS.length - 1, Math.trunc(index)))] ?? WEEKDAY_LABELS[0];
}

function localDateFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function zonedDateParts(referenceAt: number, timeZone: string): {
  dayKey: string;
  weekday: number;
  minuteOfDay: number;
} {
  const parts = localDateFormatter(timeZone).formatToParts(referenceAt);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const weekdayPart = get("weekday");
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayPart);
  return {
    dayKey: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: weekday >= 0 ? weekday : 0,
    minuteOfDay: Number(get("hour") || 0) * 60 + Number(get("minute") || 0),
  };
}

function shiftDayKey(dayKey: string, deltaDays: number): string {
  const [year = 1970, month = 1, day = 1] = String(dayKey).split("-").map((value) => Number(value));
  const shifted = new Date(Date.UTC(year, Math.max(0, month - 1), day + deltaDays));
  return shifted.toISOString().slice(0, 10);
}

export function financePayoutAutomationCurrentPeriodKey(
  policy: Pick<FinancePolicy, "payouts">,
  referenceAt: number,
): string | null {
  if (!policy.payouts.automation.enabled || policy.payouts.automation.cadence !== "weekly") return null;
  const local = zonedDateParts(referenceAt, policy.payouts.automation.timezone);
  const offset = (local.weekday - policy.payouts.automation.executionDayOfWeek + 7) % 7;
  let scheduledDayKey = shiftDayKey(local.dayKey, -offset);
  if (offset === 0 && local.minuteOfDay < policy.payouts.automation.executionMinuteOfDay) {
    scheduledDayKey = shiftDayKey(scheduledDayKey, -7);
  }
  return scheduledDayKey;
}

export function financePayoutAutomationNextRunDayKey(
  policy: Pick<FinancePolicy, "payouts">,
  referenceAt: number,
): string | null {
  if (policy.payouts.automation.cadence !== "weekly") return null;
  const local = zonedDateParts(referenceAt, policy.payouts.automation.timezone);
  let offset = (policy.payouts.automation.executionDayOfWeek - local.weekday + 7) % 7;
  if (offset === 0 && local.minuteOfDay >= policy.payouts.automation.executionMinuteOfDay) offset = 7;
  return shiftDayKey(local.dayKey, offset);
}

export function financePayoutAutomationScheduleLabel(
  policy: Pick<FinancePolicy, "payouts">,
): string {
  const hour24 = Math.floor(policy.payouts.automation.executionMinuteOfDay / 60);
  const minute = policy.payouts.automation.executionMinuteOfDay % 60;
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${weekdayLabel(policy.payouts.automation.executionDayOfWeek)} ${hour12}:${String(minute).padStart(2, "0")} ${period} (${policy.payouts.automation.timezone})`;
}

export function financePayoutAutomationSummary(
  policy: Pick<FinancePolicy, "payouts">,
  referenceAt: number,
): FinancePayoutAutomationSummary {
  return {
    enabled: policy.payouts.automation.enabled,
    cadence: policy.payouts.automation.cadence,
    timezone: policy.payouts.automation.timezone,
    executionDayOfWeek: policy.payouts.automation.executionDayOfWeek,
    executionMinuteOfDay: policy.payouts.automation.executionMinuteOfDay,
    scheduleLabel: financePayoutAutomationScheduleLabel(policy),
    currentPeriodKey: policy.payouts.automation.enabled ?
      financePayoutAutomationCurrentPeriodKey(policy, referenceAt) :
      null,
    nextRunDayKey: policy.payouts.automation.enabled ?
      financePayoutAutomationNextRunDayKey(policy, referenceAt) :
      null,
    ridersEnabled: policy.payouts.automation.ridersEnabled,
    restaurantsEnabled: policy.payouts.automation.restaurantsEnabled,
    minimumRestaurantSettlementPaise: policy.payouts.automation.minimumRestaurantSettlementPaise,
  };
}

export function normalizeFinancePolicy(value: unknown): FinancePolicy {
  const input = record(value);
  return {
    version: 1,
    restaurantCommissionBps: boundedInteger(
      input.restaurantCommissionBps,
      DEFAULT_FINANCE_POLICY.restaurantCommissionBps,
      0,
      5_000,
    ),
    codOutstandingLimitPaise: boundedInteger(
      input.codOutstandingLimitPaise,
      DEFAULT_FINANCE_POLICY.codOutstandingLimitPaise,
      0,
      10_000_000_00,
    ),
    payments: normalizeFinancePaymentPolicy(input.payments),
    payouts: normalizeFinancePayoutPolicy(input.payouts),
  };
}
