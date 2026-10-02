import type {ContractorTdsRule} from "./taxLaw";

/**
 * Contractor TDS on a rider's credits (Income-tax Act, 2025 s.393(1) Table
 * Sl. 6(i); s.194C before April 2026), worked out at the earlier of credit or
 * payment, i.e. when the ledger credits the rider:
 * - 1% for an individual/HUF, 2% for other entities, 20% when no PAN is
 *   furnished (the contractor category's own higher rate);
 * - nothing while every credit is at most ₹30,000 and the year's credits are
 *   at most ₹1,00,000 (strictly "exceeds" in both cases);
 * - a single credit above ₹30,000 is taxed on its own; once the year's credits
 *   exceed ₹1,00,000 the whole year's credits are taxed (catch-up):
 *   TDS_now = required_TDS_YTD − TDS_already_deducted.
 * Customer tips are tracked apart (customer_tip) and enter the base only when
 * the tip treatment is INCLUDED; PENDING_REVIEW keeps them out for now but
 * still counts them, so switching to INCLUDED later catches them up.
 */

export type LegalEntityType = "INDIVIDUAL" | "HUF" | "COMPANY" | "FIRM" | "LLP" | "AOP_BOI" | "TRUST" | "GOVERNMENT" | "OTHER";
export type TipTdsTreatment = "INCLUDED" | "EXCLUDED" | "PENDING_REVIEW";
export type RiderCreditComponent = "rider_earning" | "customer_tip";

export const LEGAL_ENTITY_TYPES: readonly LegalEntityType[] =
  ["INDIVIDUAL", "HUF", "COMPANY", "FIRM", "LLP", "AOP_BOI", "TRUST", "GOVERNMENT", "OTHER"];

const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export function validPan(value: unknown): string {
  const pan = String(value ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  return PAN_PATTERN.test(pan) ? pan : "";
}

/** What the PAN's 4th character says the holder is. A check, never the source of truth. */
export function panEntityType(pan: string): LegalEntityType | "" {
  if (!pan) return "";
  const map: Record<string, LegalEntityType> = {P: "INDIVIDUAL", H: "HUF", C: "COMPANY", F: "FIRM", A: "AOP_BOI", B: "AOP_BOI",
    T: "TRUST", G: "GOVERNMENT", L: "OTHER", J: "OTHER"};
  return map[pan[3] ?? ""] ?? "OTHER";
}

/** Does the declared legal entity agree with the PAN? (An LLP holds an "F" PAN.) */
export function panMatchesEntity(declared: LegalEntityType, fromPan: LegalEntityType | ""): boolean {
  if (!fromPan) return true;
  if (declared === "LLP") return fromPan === "FIRM";
  return declared === fromPan;
}

export function normalizeLegalEntityType(value: unknown): LegalEntityType | "" {
  const text = String(value ?? "").toUpperCase();
  return (LEGAL_ENTITY_TYPES as readonly string[]).includes(text) ? text as LegalEntityType : "";
}

export function normalizeTipTdsTreatment(value: unknown): TipTdsTreatment {
  const text = String(value ?? "").toUpperCase();
  return text === "INCLUDED" || text === "EXCLUDED" ? text : "PENDING_REVIEW";
}

export interface RiderTdsIdentity {
  legalEntityType: LegalEntityType;
  pan: string;
  panEntityType: LegalEntityType | "";
  panVerified: boolean;
}

export interface RiderTdsRate {
  rateBps: number;
  reason: "individual_huf" | "other_entity" | "no_pan" | "entity_pan_mismatch";
}

export function riderTdsRate(rule: ContractorTdsRule, identity: RiderTdsIdentity): RiderTdsRate {
  if (!identity.pan) return {rateBps: rule.noPanRateBps, reason: "no_pan"};
  // When the declared entity and the PAN disagree, the higher rate is applied until it is resolved.
  if (!panMatchesEntity(identity.legalEntityType, identity.panEntityType)) {
    return {rateBps: Math.max(rule.individualRateBps, rule.otherRateBps), reason: "entity_pan_mismatch"};
  }
  return identity.legalEntityType === "INDIVIDUAL" || identity.legalEntityType === "HUF"
    ? {rateBps: rule.individualRateBps, reason: "individual_huf"}
    : {rateBps: rule.otherRateBps, reason: "other_entity"};
}

export interface RiderTdsYear {
  /** rider_earning credits (trip pay, incentives, fee shares). */
  earningsPaise: number;
  /** customer_tip credits, always counted, taxed only when INCLUDED. */
  tipsPaise: number;
  /** Sum of single credits above the single-credit limit that are in the base. */
  largeCreditsPaise: number;
  deductedPaise: number;
}

export interface RiderTdsResult {
  rateBps: number;
  rateReason: RiderTdsRate["reason"];
  basePaise: number;
  requiredYtdPaise: number;
  tdsPaise: number;
  year: RiderTdsYear;
}

export const EMPTY_RIDER_TDS_YEAR: Readonly<RiderTdsYear> =
  Object.freeze({earningsPaise: 0, tipsPaise: 0, largeCreditsPaise: 0, deductedPaise: 0});

export function riderContractorTdsOnCredit(rule: ContractorTdsRule, identity: RiderTdsIdentity, before: RiderTdsYear,
  credit: {component: RiderCreditComponent; amountPaise: number}, tipTreatment: TipTdsTreatment): RiderTdsResult {
  const rate = riderTdsRate(rule, identity);
  const amount = Math.max(0, Math.round(credit.amountPaise));
  const isTip = credit.component === "customer_tip";
  const inBase = !isTip || tipTreatment === "INCLUDED";
  const year: RiderTdsYear = {
    earningsPaise: before.earningsPaise + (isTip ? 0 : amount),
    tipsPaise: before.tipsPaise + (isTip ? amount : 0),
    largeCreditsPaise: before.largeCreditsPaise + (inBase && amount > rule.singleCreditOverPaise ? amount : 0),
    deductedPaise: before.deductedPaise,
  };
  const aggregate = year.earningsPaise + (tipTreatment === "INCLUDED" ? year.tipsPaise : 0);
  const basePaise = aggregate > rule.aggregateOverPaise ? aggregate : year.largeCreditsPaise;
  const requiredYtdPaise = Math.round(basePaise * rate.rateBps / 10_000);
  const tdsPaise = Math.max(0, requiredYtdPaise - before.deductedPaise);
  year.deductedPaise += tdsPaise;
  return {rateBps: rate.rateBps, rateReason: rate.reason, basePaise, requiredYtdPaise, tdsPaise, year};
}

// ---------------------------------------------------------------------------
// Contractor / employee: a legal relationship, changed only through a
// restricted, dated, audited control - never edited back in time.
// ---------------------------------------------------------------------------

export type RiderTaxClassification = "CONTRACTOR" | "EMPLOYEE";

export interface ClassificationEntry {
  taxClassification: RiderTaxClassification;
  /** IST date, YYYY-MM-DD. */
  classificationEffectiveFrom: string;
  classificationReason: string;
  changedBy: string;
  changedAt: number;
}

export const DEFAULT_CLASSIFICATION: Readonly<Omit<ClassificationEntry, "changedBy" | "changedAt">> = Object.freeze({
  taxClassification: "CONTRACTOR", classificationEffectiveFrom: "", classificationReason: "INDEPENDENT_DELIVERY_PARTNER",
});

const istStart = (date: string) => Date.parse(`${date}T00:00:00+05:30`);

/** The classification in force at a moment, from the append-only history. */
export function classificationAt(entries: readonly ClassificationEntry[], at: number): Omit<ClassificationEntry, "changedBy" | "changedAt"> {
  const live = entries.filter((entry) => istStart(entry.classificationEffectiveFrom) <= at)
    .sort((a, b) => a.classificationEffectiveFrom.localeCompare(b.classificationEffectiveFrom));
  return live[live.length - 1] ?? DEFAULT_CLASSIFICATION;
}

/** Why a requested classification change must be refused, or "" when it may be recorded. */
export function classificationChangeProblem(entries: readonly ClassificationEntry[], change: {
  effectiveFrom: string; now: number;
}): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(change.effectiveFrom) || !Number.isFinite(istStart(change.effectiveFrom))) {
    return "Give the effective date as YYYY-MM-DD.";
  }
  const today = new Date(change.now + 19_800_000).toISOString().slice(0, 10);
  if (change.effectiveFrom < today) return "A classification cannot be changed back in time. Use today or a later date.";
  const latest = [...entries].sort((a, b) => a.classificationEffectiveFrom.localeCompare(b.classificationEffectiveFrom)).pop();
  if (latest && change.effectiveFrom <= latest.classificationEffectiveFrom) {
    return `The last change already takes effect on ${latest.classificationEffectiveFrom}. Choose a later date.`;
  }
  return "";
}
