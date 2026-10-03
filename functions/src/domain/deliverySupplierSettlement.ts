import type {DeliveryServiceSupplier, ServiceTaxLine} from "./orderTax";

/**
 * The legal/accounting settlement of one delivery, kept apart from the
 * operational rider-pay engine (trip, distance, waiting, incentives).
 *
 * RIDER (Zomato-style): the rider supplies the delivery to the customer and
 * SCRAVEIT collects the whole consideration on the rider's behalf. So the
 * rider's gross delivery revenue is the full consideration; what SCRAVEIT
 * keeps is an explicit, contractual platform/facilitation fee to the rider
 * (with SCRAVEIT's own GST on it) - never a "delivery margin". When
 * operational pay is above the consideration (a guarantee), the difference
 * is a SCRAVEIT top-up shown under bonuses/adjustments.
 *
 *   riderGrossDeliveryRevenue
 * + riderDeliveryGstCollected            (registered rider only; the rider's GST)
 * - scraveitRiderPlatformFee
 * - scraveitRiderPlatformFeeGst
 * - gstTcsSection52                      (registered rider only)
 * - riderEcommerceTds
 * +/- bonusesAdjustments
 * = riderNetSettlement
 *
 * RESTAURANT (store self-delivery): the same, with the store as supplier.
 * SCRAVEIT: SCRAVEIT supplies delivery itself; the rider is its subcontractor
 * (contractor TDS on the rider's credits), so the consideration is SCRAVEIT's.
 */

export interface DeliverySupplierSettlement {
  delivery_service_supplier: DeliveryServiceSupplier;
  /** Rider id, or the store's id for self-delivery. */
  supplier_id: string;
  delivery_gross_consideration: number;
  /** Parts of the consideration, as classified by the terms. */
  delivery_fee: number;
  delivery_surge: number;
  rain_delivery_amount: number;
  late_night_delivery_amount: number;
  /** The supplier's own GST (registered supplier), collected for it: never SCRAVEIT revenue. */
  delivery_gst_collected_for_supplier: number;
  /** SCRAVEIT's own liability u/s 9(5) (supplier not liable to register). */
  delivery_gst_9_5_paid_by_scraveit: number;
  delivery_supplier_gst_tcs: number;
  rider_ecommerce_tds: number;
  /** Only when SCRAVEIT supplies delivery; worked out per credit, so 0 on this record. */
  rider_contractor_tds: number;
  /** Store self-delivery: the store's e-commerce TDS share on the delivery. */
  store_delivery_tds: number;
  scraveit_rider_platform_fee: number;
  scraveit_rider_platform_fee_gst: number;
  scraveit_rider_platform_fee_sac: string;
  /** What the operational engine pays the supplier for this delivery (trip, distance, waiting, incentive...). */
  operational_pay: number;
  /** SCRAVEIT top-up when operational pay exceeds the consideration. */
  bonuses_adjustments: number;
  delivery_supplier_net_settlement: number;
}

export interface SupplierFeePolicy {
  /** GST rate on SCRAVEIT's platform/facilitation service to the rider/store (configurable until classified). */
  platformFeeGstRateBps: number;
  platformFeeSac: string;
  /** Store self-delivery: SCRAVEIT's contractual fee as a share of the delivery consideration. */
  storeDeliveryFeeBps: number;
}

/** Splits a GST-inclusive retained amount into fee + GST. */
function inclusiveSplit(retainedPaise: number, rateBps: number): {fee: number; gst: number} {
  if (retainedPaise <= 0) return {fee: 0, gst: 0};
  const fee = Math.round(retainedPaise * 10_000 / (10_000 + Math.max(0, rateBps)));
  return {fee, gst: retainedPaise - fee};
}

export function deliverySupplierSettlement(input: {
  supplier: DeliveryServiceSupplier;
  supplierId: string;
  line: ServiceTaxLine | undefined;
  operationalPayPaise: number;
  tcsPaise: number;
  riderEcommerceTdsPaise: number;
  storeDeliveryTdsPaise: number;
  policy: SupplierFeePolicy;
}): DeliverySupplierSettlement | null {
  const line = input.line;
  if (!line || line.basePaise <= 0) return null;
  const c = line.consideration ?? {deliveryFee: line.basePaise, deliverySurge: 0, rainDeliveryAmount: 0, lateNightDeliveryAmount: 0};
  const gross = line.basePaise;
  const supplierOwnsGst = line.supplier === "rider" || line.basis === "store_registered" || line.basis === "composite_goods";
  const gstCollected = supplierOwnsGst ? line.gstPaise : 0;
  const gst95 = line.basis === "section_9_5" || line.basis === "store_section_9_5" ? line.gstPaise : 0;
  const base = {
    delivery_service_supplier: input.supplier, supplier_id: input.supplierId, delivery_gross_consideration: gross,
    delivery_fee: c.deliveryFee, delivery_surge: c.deliverySurge, rain_delivery_amount: c.rainDeliveryAmount,
    late_night_delivery_amount: c.lateNightDeliveryAmount,
    delivery_gst_collected_for_supplier: gstCollected, delivery_gst_9_5_paid_by_scraveit: gst95,
    rider_contractor_tds: 0, scraveit_rider_platform_fee_sac: input.policy.platformFeeSac,
  };
  if (input.supplier === "SCRAVEIT") {
    // The consideration is SCRAVEIT's own; the rider is paid as its subcontractor.
    return {...base, delivery_supplier_gst_tcs: 0, rider_ecommerce_tds: 0, store_delivery_tds: 0,
      scraveit_rider_platform_fee: 0, scraveit_rider_platform_fee_gst: 0, operational_pay: input.operationalPayPaise,
      bonuses_adjustments: 0, delivery_supplier_net_settlement: input.operationalPayPaise};
  }
  const pay = input.supplier === "RESTAURANT"
    ? gross - Math.round(gross * input.policy.storeDeliveryFeeBps / 10_000)
    : Math.max(0, input.operationalPayPaise);
  const retained = Math.max(0, gross - pay);
  const topUp = Math.max(0, pay - gross);
  const {fee, gst} = inclusiveSplit(retained, input.policy.platformFeeGstRateBps);
  const tds = input.supplier === "RIDER" ? input.riderEcommerceTdsPaise : input.storeDeliveryTdsPaise;
  return {
    ...base,
    delivery_supplier_gst_tcs: input.tcsPaise,
    rider_ecommerce_tds: input.supplier === "RIDER" ? input.riderEcommerceTdsPaise : 0,
    store_delivery_tds: input.supplier === "RESTAURANT" ? input.storeDeliveryTdsPaise : 0,
    scraveit_rider_platform_fee: fee,
    scraveit_rider_platform_fee_gst: gst,
    operational_pay: pay,
    bonuses_adjustments: topUp,
    delivery_supplier_net_settlement: gross + gstCollected - fee - gst - input.tcsPaise - tds + topUp,
  };
}
