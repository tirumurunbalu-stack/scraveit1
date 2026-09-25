/**
 * Tax configuration readiness.
 *
 * Scraveit does NOT decide Indian tax law here. This module only makes the
 * engine able to apply whatever treatment a chartered accountant defines,
 * component by component, versioned and effective-dated. Until a CA-approved
 * version in "component_rules" mode is saved, checkout keeps the legacy flat
 * rate on food (settings/customer.taxRate) exactly as before.
 *
 * See docs/SCRAVEIT_TAX_CA_INPUTS.md for the values that still need a CA.
 */

export const TAX_COMPONENTS = [
  "food", "packaging", "delivery_fee", "platform_fee", "small_order_fee", "late_night_fee",
  "surge_fee", "rain_fee", "rider_incentive_fee", "commission",
] as const;
export type TaxComponent = typeof TAX_COMPONENTS[number];

export interface TaxRule {
  component: TaxComponent;
  rateBps: number;
  /** Inclusive: the price already contains the tax (it is extracted, not added). */
  inclusive: boolean;
  /** Who is legally liable to pay it over. */
  liableParty: "restaurant" | "platform" | "none";
  /** Who collects it from the payer. */
  collectedBy: "platform" | "restaurant";
  /** Whether discounts reduce the taxable base of this component. */
  discountTreatment: "after_discount" | "before_discount";
  invoiceIssuer: "restaurant" | "platform" | "none";
  hsnSac: string;
}

export interface TaxVersion {
  versionId: string;
  mode: "legacy_flat_rate" | "component_rules";
  effectiveFrom: number;
  effectiveTo: number;
  rules: TaxRule[];
  approvedBy: string;
  notes: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function normalizeTaxRule(value: unknown): TaxRule | null {
  const input = record(value);
  if (!(TAX_COMPONENTS as readonly string[]).includes(String(input.component))) return null;
  const rate = Number(input.rateBps);
  return {
    component: input.component as TaxComponent,
    rateBps: Number.isFinite(rate) ? Math.round(Math.min(10_000, Math.max(0, rate))) : 0,
    inclusive: input.inclusive === true,
    liableParty: input.liableParty === "restaurant" || input.liableParty === "platform" ? input.liableParty : "none",
    collectedBy: input.collectedBy === "restaurant" ? "restaurant" : "platform",
    discountTreatment: input.discountTreatment === "before_discount" ? "before_discount" : "after_discount",
    invoiceIssuer: input.invoiceIssuer === "restaurant" || input.invoiceIssuer === "platform" ? input.invoiceIssuer : "none",
    hsnSac: String(input.hsnSac ?? "").slice(0, 20),
  };
}

export function normalizeTaxVersions(value: unknown): TaxVersion[] {
  const list = Array.isArray(value) ? value : [];
  return list.slice(0, 50).map((entry, index) => {
    const input = record(entry);
    const rules = (Array.isArray(input.rules) ? input.rules : []).map(normalizeTaxRule)
      .filter((rule): rule is TaxRule => rule !== null);
    const unique = new Map<TaxComponent, TaxRule>();
    rules.forEach((rule) => unique.set(rule.component, rule));
    const from = Number(input.effectiveFrom);
    const to = Number(input.effectiveTo);
    return {
      versionId: String(input.versionId || `tax_v${index + 1}`).slice(0, 60),
      mode: input.mode === "component_rules" ? "component_rules" as const : "legacy_flat_rate" as const,
      effectiveFrom: Number.isFinite(from) ? Math.max(0, Math.round(from)) : 0,
      effectiveTo: Number.isFinite(to) ? Math.max(0, Math.round(to)) : 0,
      rules: [...unique.values()],
      approvedBy: String(input.approvedBy ?? "").slice(0, 120),
      notes: String(input.notes ?? "").slice(0, 1_000),
    };
  }).sort((left, right) => left.effectiveFrom - right.effectiveFrom);
}

export function activeTaxVersion(versions: readonly TaxVersion[], at: number): TaxVersion | null {
  const live = versions.filter((version) => version.effectiveFrom <= at && (version.effectiveTo === 0 || at < version.effectiveTo));
  return live.length ? live[live.length - 1]! : null;
}

export interface TaxableAmounts {
  foodPaise: number;
  restaurantDiscountPaise: number;
  platformDiscountPaise: number;
  packagingPaise: number;
  deliveryFeePaise: number;
  platformFeePaise: number;
  smallOrderFeePaise: number;
  lateNightFeePaise: number;
  surgeFeePaise: number;
  rainFeePaise: number;
  riderIncentiveFeePaise: number;
  commissionPaise: number;
}

export interface TaxLine {
  component: TaxComponent;
  basePaise: number;
  rateBps: number;
  taxPaise: number;
  inclusive: boolean;
  liableParty: TaxRule["liableParty"];
  collectedBy: TaxRule["collectedBy"];
  invoiceIssuer: TaxRule["invoiceIssuer"];
  hsnSac: string;
}

export interface TaxComputation {
  versionId: string;
  lines: TaxLine[];
  /** Added on top of the customer's bill (exclusive, customer-facing components). */
  customerTaxPaise: number;
  /** Charged to the restaurant through its settlement (tax on commission). */
  restaurantTaxPaise: number;
}

function baseFor(component: TaxComponent, amounts: TaxableAmounts, rule: TaxRule): number {
  switch (component) {
  case "food": return Math.max(0, amounts.foodPaise - (rule.discountTreatment === "after_discount" ?
    amounts.restaurantDiscountPaise + amounts.platformDiscountPaise : 0));
  case "packaging": return amounts.packagingPaise;
  case "delivery_fee": return amounts.deliveryFeePaise;
  case "platform_fee": return amounts.platformFeePaise;
  case "small_order_fee": return amounts.smallOrderFeePaise;
  case "late_night_fee": return amounts.lateNightFeePaise;
  case "surge_fee": return amounts.surgeFeePaise;
  case "rain_fee": return amounts.rainFeePaise;
  case "rider_incentive_fee": return amounts.riderIncentiveFeePaise;
  case "commission": return amounts.commissionPaise;
  }
}

export function computeTaxLines(version: TaxVersion, amounts: TaxableAmounts): TaxComputation {
  const lines: TaxLine[] = [];
  let customerTaxPaise = 0;
  let restaurantTaxPaise = 0;
  for (const rule of version.rules) {
    const base = baseFor(rule.component, amounts, rule);
    if (base <= 0 || rule.rateBps <= 0) continue;
    const taxPaise = rule.inclusive ?
      base - Math.round(base * 10_000 / (10_000 + rule.rateBps)) :
      Math.round(base * rule.rateBps / 10_000);
    lines.push({
      component: rule.component,
      basePaise: base,
      rateBps: rule.rateBps,
      taxPaise,
      inclusive: rule.inclusive,
      liableParty: rule.liableParty,
      collectedBy: rule.collectedBy,
      invoiceIssuer: rule.invoiceIssuer,
      hsnSac: rule.hsnSac,
    });
    if (rule.inclusive) continue;
    if (rule.component === "commission") restaurantTaxPaise += taxPaise;
    else customerTaxPaise += taxPaise;
  }
  return {versionId: version.versionId, lines, customerTaxPaise, restaurantTaxPaise};
}
