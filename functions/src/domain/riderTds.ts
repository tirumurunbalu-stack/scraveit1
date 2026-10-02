import type {ContractorTdsRule} from "./taxLaw";

/**
 * Contractor TDS on a rider's earnings (Income-tax Act, 2025 s.393(1) Table
 * Sl. 6(i); s.194C before April 2026), worked out when earnings are credited:
 * - 1% for an individual/HUF (PAN 4th letter P or H), 2% for others, the
 *   higher no-PAN rate when no valid PAN is on file;
 * - nothing while every credit is at most ₹30,000 and the year's credits are
 *   at most ₹1,00,000;
 * - a single credit above ₹30,000 is taxed on its own; once the year's credits
 *   pass ₹1,00,000 the whole year's credits are taxed (catch-up):
 *   TDS_now = required_TDS_YTD − TDS_already_deducted.
 * Customer tips are not part of the base: they sit in a separate account.
 */

export interface RiderTdsYear {
  creditedPaise: number;
  /** Sum of the single credits that were above the single-credit limit. */
  largeCreditsPaise: number;
  deductedPaise: number;
}

export interface RiderTdsResult {
  rateBps: number;
  requiredYtdPaise: number;
  tdsPaise: number;
  year: RiderTdsYear;
}

const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export function validPan(value: unknown): string {
  const pan = String(value ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  return PAN_PATTERN.test(pan) ? pan : "";
}

/** Individual or HUF by the PAN's 4th letter. */
export function panIsIndividualOrHuf(pan: string): boolean {
  return pan[3] === "P" || pan[3] === "H";
}

export function riderTdsRateBps(rule: ContractorTdsRule, pan: string): number {
  if (!pan) return rule.noPanRateBps;
  return panIsIndividualOrHuf(pan) ? rule.individualRateBps : rule.otherRateBps;
}

export function riderContractorTdsOnCredit(rule: ContractorTdsRule, pan: string, before: RiderTdsYear,
  creditPaise: number): RiderTdsResult {
  const rateBps = riderTdsRateBps(rule, pan);
  const credit = Math.max(0, Math.round(creditPaise));
  const year: RiderTdsYear = {
    creditedPaise: before.creditedPaise + credit,
    largeCreditsPaise: before.largeCreditsPaise + (credit > rule.singleCreditOverPaise ? credit : 0),
    deductedPaise: before.deductedPaise,
  };
  const base = year.creditedPaise > rule.aggregateOverPaise ? year.creditedPaise : year.largeCreditsPaise;
  const requiredYtdPaise = Math.round(base * rateBps / 10_000);
  const tdsPaise = Math.max(0, requiredYtdPaise - before.deductedPaise);
  year.deductedPaise += tdsPaise;
  return {rateBps, requiredYtdPaise, tdsPaise, year};
}
