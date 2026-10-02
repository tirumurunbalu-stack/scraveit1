/**
 * Indian tax law as SCRAVEIT applies it, as effective-dated tables.
 *
 * Nothing here is hard-coded into order code: every rate has an effective
 * window, the baseline below can be overridden from Firestore
 * (private/taxLaw), and each order stores the table version it used so later
 * amendments never change past transactions.
 *
 * Baseline (current law as of October 2026):
 * - GST TCS u/s 52 CGST Act: 0.5% of net taxable supplies (0.25% CGST +
 *   0.25% SGST intra-State, 0.5% IGST inter-State) from 10 July 2024
 *   (Notification 15/2024-CT); 1% before that.
 * - Restaurant service through an ECO is taxed on the ECO u/s 9(5): 5%, no
 *   TCS on that value.
 * - Local delivery through an ECO u/s 9(5) from 22 September 2025: 18%.
 * - SCRAVEIT's own services (platform fee, commission, other fees): 18%.
 * - Income-tax e-commerce TDS: Income-tax Act, 2025 s.393(1) Table Sl. 8(v)
 *   (successor of s.194-O) from 1 April 2026: 0.1% of gross sales/services;
 *   nil for an individual/HUF with PAN/Aadhaar whose yearly gross through the
 *   platform is at most ₹5,00,000.
 * - Goods GST is per product (HSN, pre-packaged/labelled), never per shop.
 */

export const TAX_LAW_VERSION = "in-2026-10-02";

export interface DatedRate {
  effectiveFrom: number;
  /** Exclusive; 0 = still in force. */
  effectiveTo: number;
  rateBps: number;
}

export interface EcomTdsRule {
  effectiveFrom: number;
  effectiveTo: number;
  section: string;
  rateBps: number;
  /** Rate when the participant has not furnished PAN/Aadhaar. */
  noPanRateBps: number;
  /** Yearly gross below which an individual/HUF with PAN owes no TDS. */
  individualExemptUptoPaise: number;
  /** GST charged separately on the invoice is not part of the TDS base. */
  baseExcludesGst: boolean;
}

export interface ProductTaxRule {
  effectiveFrom: number;
  effectiveTo: number;
  hsnCode: string;
  gstRateBps: number;
  taxability: "taxable" | "nil" | "exempt";
  prepackagedLabelled: boolean;
}

export interface HsnGuide {
  key: string;
  description: string;
  hsnCode: string;
  rule: Omit<ProductTaxRule, "hsnCode">;
}

export interface TaxLaw {
  version: string;
  /** Section 52 TCS, total rate (split CGST/SGST intra-State, IGST inter-State). */
  gstTcs: DatedRate[];
  /** Registration types whose taxable supplies attract Section 52 TCS. */
  gstTcsRegistrationTypes: string[];
  /** Restaurant service supplied through the ECO (s.9(5)). */
  restaurantServiceGst: DatedRate[];
  /** Local delivery through the ECO (s.9(5)). */
  deliveryServiceGst: DatedRate[];
  /** SCRAVEIT's own services: platform fee, commission, other fees. */
  platformServiceGst: DatedRate[];
  ecomTds: EcomTdsRule[];
  /** Product GST suggestions for the store apps (owners confirm per product). */
  hsnGuides: HsnGuide[];
}

const IST = (date: string) => Date.parse(`${date}T00:00:00+05:30`);
const FOREVER = 0;

export const BASELINE_TAX_LAW: Readonly<TaxLaw> = Object.freeze({
  version: TAX_LAW_VERSION,
  gstTcs: [
    {effectiveFrom: IST("2018-10-01"), effectiveTo: IST("2024-07-10"), rateBps: 100},
    {effectiveFrom: IST("2024-07-10"), effectiveTo: FOREVER, rateBps: 50},
  ],
  gstTcsRegistrationTypes: ["regular", "composition"],
  restaurantServiceGst: [{effectiveFrom: IST("2022-01-01"), effectiveTo: FOREVER, rateBps: 500}],
  deliveryServiceGst: [{effectiveFrom: IST("2025-09-22"), effectiveTo: FOREVER, rateBps: 1_800}],
  platformServiceGst: [{effectiveFrom: IST("2017-07-01"), effectiveTo: FOREVER, rateBps: 1_800}],
  ecomTds: [
    {effectiveFrom: IST("2024-10-01"), effectiveTo: IST("2026-04-01"), section: "194-O (Income-tax Act, 1961)",
      rateBps: 10, noPanRateBps: 500, individualExemptUptoPaise: 5_00_000_00, baseExcludesGst: true},
    {effectiveFrom: IST("2026-04-01"), effectiveTo: FOREVER, section: "393(1) Table Sl. 8(v) (Income-tax Act, 2025)",
      rateBps: 10, noPanRateBps: 500, individualExemptUptoPaise: 5_00_000_00, baseExcludesGst: true},
  ],
  hsnGuides: [
    ...[
      ["milk", "Fresh / pasteurised milk, including UHT milk", "0401", 0, "nil", false],
      ["paneer", "Chena / paneer (packaged or not)", "0406", 0, "nil", false],
      ["curd_loose", "Curd, lassi, buttermilk (not pre-packaged)", "0403", 0, "nil", false],
      ["curd_packed", "Curd, lassi, buttermilk (pre-packaged and labelled)", "0403", 500, "taxable", true],
      ["condensed_milk", "Condensed milk", "0402", 500, "taxable", true],
      ["butter_ghee", "Butter, ghee, dairy spreads", "0405", 500, "taxable", true],
      ["cheese", "Cheese (other than chena / paneer)", "0406", 500, "taxable", true],
      ["plant_milk", "Plant-based / soya milk drinks", "2202", 500, "taxable", true],
      ["fresh_veg", "Fresh vegetables and fruits", "0702", 0, "nil", false],
      ["eggs", "Fresh eggs", "0407", 0, "nil", false],
    ].map(([key, description, hsnCode, gstRateBps, taxability, prepackagedLabelled]) => ({
      key: String(key), description: String(description), hsnCode: String(hsnCode),
      rule: {effectiveFrom: IST("2025-09-22"), effectiveTo: FOREVER, gstRateBps: Number(gstRateBps),
        taxability: taxability as ProductTaxRule["taxability"], prepackagedLabelled: Boolean(prepackagedLabelled)},
    })),
  ],
});

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(Math.min(max, Math.max(min, parsed))) : fallback;
}

function datedRates(value: unknown, fallback: readonly DatedRate[]): DatedRate[] {
  if (!Array.isArray(value) || !value.length) return fallback.map((rate) => ({...rate}));
  return value.map((entry) => {
    const input = record(entry);
    return {effectiveFrom: int(input.effectiveFrom, 0, 0, Number.MAX_SAFE_INTEGER),
      effectiveTo: int(input.effectiveTo, 0, 0, Number.MAX_SAFE_INTEGER), rateBps: int(input.rateBps, 0, 0, 10_000)};
  }).sort((left, right) => left.effectiveFrom - right.effectiveFrom);
}

/** Baseline merged with any amendment stored in Firestore. */
export function normalizeTaxLaw(value: unknown): TaxLaw {
  const input = record(value);
  const base = BASELINE_TAX_LAW;
  return {
    version: String(input.version || base.version).slice(0, 60),
    gstTcs: datedRates(input.gstTcs, base.gstTcs),
    gstTcsRegistrationTypes: Array.isArray(input.gstTcsRegistrationTypes) && input.gstTcsRegistrationTypes.length
      ? input.gstTcsRegistrationTypes.map(String) : [...base.gstTcsRegistrationTypes],
    restaurantServiceGst: datedRates(input.restaurantServiceGst, base.restaurantServiceGst),
    deliveryServiceGst: datedRates(input.deliveryServiceGst, base.deliveryServiceGst),
    platformServiceGst: datedRates(input.platformServiceGst, base.platformServiceGst),
    ecomTds: Array.isArray(input.ecomTds) && input.ecomTds.length ? input.ecomTds.map((entry) => {
      const rule = record(entry);
      return {effectiveFrom: int(rule.effectiveFrom, 0, 0, Number.MAX_SAFE_INTEGER),
        effectiveTo: int(rule.effectiveTo, 0, 0, Number.MAX_SAFE_INTEGER), section: String(rule.section ?? "").slice(0, 120),
        rateBps: int(rule.rateBps, 10, 0, 10_000), noPanRateBps: int(rule.noPanRateBps, 500, 0, 10_000),
        individualExemptUptoPaise: int(rule.individualExemptUptoPaise, 0, 0, Number.MAX_SAFE_INTEGER),
        baseExcludesGst: rule.baseExcludesGst !== false};
    }) : base.ecomTds.map((rule) => ({...rule})),
    hsnGuides: base.hsnGuides.map((guide) => ({...guide, rule: {...guide.rule}})),
  };
}

function inForce<T extends {effectiveFrom: number; effectiveTo: number}>(rules: readonly T[], at: number): T | null {
  const live = rules.filter((rule) => rule.effectiveFrom <= at && (rule.effectiveTo === 0 || at < rule.effectiveTo));
  return live.length ? live[live.length - 1]! : null;
}

export function rateAt(rates: readonly DatedRate[], at: number): number {
  return inForce(rates, at)?.rateBps ?? 0;
}

export function ecomTdsRuleAt(law: TaxLaw, at: number): EcomTdsRule | null {
  return inForce(law.ecomTds, at);
}

/** The product's own tax rule valid on the order date. */
export function productTaxRuleAt(rules: readonly ProductTaxRule[], at: number): ProductTaxRule | null {
  return inForce(rules, at);
}

export function normalizeProductTaxRules(value: unknown): ProductTaxRule[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const input = record(entry);
    const taxability = input.taxability === "nil" || input.taxability === "exempt" ? input.taxability : "taxable";
    return {
      effectiveFrom: int(input.effectiveFrom, 0, 0, Number.MAX_SAFE_INTEGER),
      effectiveTo: int(input.effectiveTo, 0, 0, Number.MAX_SAFE_INTEGER),
      hsnCode: String(input.hsnCode ?? "").replace(/[^0-9]/g, "").slice(0, 8),
      gstRateBps: taxability === "taxable" ? int(input.gstRateBps, 0, 0, 4_000) : 0,
      taxability,
      prepackagedLabelled: input.prepackagedLabelled === true,
    } as ProductTaxRule;
  }).sort((left, right) => left.effectiveFrom - right.effectiveFrom);
}

/** Indian financial year label (April–March), e.g. "26-27". */
export function financialYearLabel(at: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit"})
    .formatToParts(new Date(at));
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const start = month >= 4 ? year : year - 1;
  return `${String(start % 100).padStart(2, "0")}-${String((start + 1) % 100).padStart(2, "0")}`;
}
