/*
 * Scraveit offer and payout maths, shared by the Price Planner, the
 * restaurant app and the customer app so all three always agree with the
 * server (functions/src/domain/economics.ts). Amounts are integer paise.
 *
 *   discount   = percent of the item total (capped) or a flat amount, never
 *                more than the item total, and nothing below the minimum order
 *   base       = item total - restaurant discount   (commission is on this)
 *   commission = base x rate
 *   GST        = 18% of the commission (Scraveit's invoice to the restaurant)
 *   you get    = base - commission - GST on commission
 *
 * Food GST is paid by the customer on top, at checkout, so it is never part of
 * the restaurant's price or of what it gets.
 */
(function (root) {
  "use strict";
  var GST_ON_COMMISSION_BPS = 1800;
  function bpsOf(paise, bps) { return Math.round(paise * bps / 10000); }
  function int(v) { var n = Math.round(Number(v)); return isFinite(n) && n > 0 ? n : 0; }
  function group(digits) {
    if (digits.length <= 3) return digits;
    return digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + digits.slice(-3);
  }
  /** Rs amount in Indian style: 1,23,456 and 100.41 (whole rupees without .00). */
  function rupees(paise, keepPaise) {
    var p = Math.round(Number(paise || 0)), sign = p < 0 ? "-" : "", a = Math.abs(p);
    var whole = Math.floor(a / 100), rest = a % 100;
    return sign + "\u20b9" + group(String(whole)) + (rest || keepPaise ? "." + (rest < 10 ? "0" : "") + rest : "");
  }
  function normalize(offer) {
    var o = offer || {};
    return {
      kind: o.kind === "flat" ? "flat" : "percent",
      percent: Math.max(0, Math.min(100, Math.round(Number(o.percent || 0)))),
      maxDiscountPaise: int(o.maxDiscountPaise),
      flatAmountPaise: int(o.flatAmountPaise),
      minimumOrderPaise: int(o.minimumOrderPaise),
    };
  }
  /** What the customer saves on an order of this item total. */
  function discountPaise(offer, orderPaise) {
    var o = normalize(offer), total = int(orderPaise);
    if (!offer || !total || total < o.minimumOrderPaise) return 0;
    var raw = o.kind === "flat" ? o.flatAmountPaise : bpsOf(total, o.percent * 100);
    var capped = o.maxDiscountPaise > 0 ? Math.min(raw, o.maxDiscountPaise) : raw;
    return Math.max(0, Math.min(total, capped));
  }
  /** The most the restaurant can ever give on one order. */
  function maxGivePaise(offer) {
    var o = normalize(offer);
    return o.kind === "flat" ? o.flatAmountPaise : o.maxDiscountPaise;
  }
  /** What the restaurant gets for an item total after its own discount. */
  function payout(orderPaise, restaurantDiscountPaise, commissionBps, options) {
    var withGst = !(options && options.gstOnCommission === false);
    var base = Math.max(0, int(orderPaise) - int(restaurantDiscountPaise));
    var commission = bpsOf(base, Math.max(0, Number(commissionBps) || 0));
    var gst = withGst ? bpsOf(commission, GST_ON_COMMISSION_BPS) : 0;
    return {base: base, commission: commission, commissionGst: gst, receive: base - commission - gst};
  }
  /** Smallest whole-rupee price that gets the restaurant at least the target. */
  function priceForReceive(targetPaise, commissionBps, options) {
    var target = int(targetPaise);
    if (!target) return 0;
    var keep = 1 - (Number(commissionBps) || 0) / 10000 * (1 + (options && options.gstOnCommission === false ? 0 : GST_ON_COMMISSION_BPS / 10000));
    if (keep <= 0) return 0;
    var price = Math.max(100, Math.floor(target / keep / 100) * 100 - 200);
    while (payout(price, 0, commissionBps, options).receive < target) price += 100;
    return price;
  }
  /** One dish ordered on its own, with the offer applied if it qualifies. */
  function dishPayout(pricePaise, offer, commissionBps, options) {
    var d = discountPaise(offer, pricePaise);
    var p = payout(pricePaise, d, commissionBps, options);
    p.discount = d;
    return p;
  }
  /** Exactly what customers see on the restaurant card. */
  function offerLabel(offer) {
    var o = normalize(offer);
    var main = o.kind === "flat" ? rupees(o.flatAmountPaise) + " OFF" : o.percent + "% OFF" + (o.maxDiscountPaise ? " up to " + rupees(o.maxDiscountPaise) : "");
    return main + (o.minimumOrderPaise ? " above " + rupees(o.minimumOrderPaise) : "");
  }
  function offerNumber(offer) {
    var o = normalize(offer);
    return o.kind === "flat" ? Math.round(o.flatAmountPaise / 100) : o.percent;
  }
  /** WAFFLE20 for "The Waffle Spot" with 20% off: 3-12 letters and digits. */
  function suggestCode(restaurantName, offer) {
    var skip = {THE: 1, AND: 1, SRI: 1, SHREE: 1, NEW: 1, CAFE: 0};
    var words = String(restaurantName || "").toUpperCase().replace(/[^A-Z ]/g, " ").split(/\s+/).filter(Boolean);
    var pick = words.filter(function (w) { return w.length >= 3 && !skip[w]; })[0] || words[0] || "SCRAVEIT";
    var num = String(offerNumber(offer) || "");
    return (pick.slice(0, 12 - num.length) + num).slice(0, 12);
  }
  /** Next codes to try when one is taken: WAFFLE21, WAFFLE22, ... */
  function codeAlternatives(code, count) {
    var m = String(code || "").toUpperCase().match(/^(.*?)(\d*)$/), stem = m[1] || "OFFER", n = m[2] ? Number(m[2]) : 0, out = [];
    for (var i = 1; out.length < (count || 5); i++) {
      var next = stem + String(n + i);
      if (next.length > 12) next = stem.slice(0, 12 - String(n + i).length) + String(n + i);
      out.push(next);
    }
    return out;
  }
  function validCode(code) { return /^[A-Z0-9]{3,12}$/.test(String(code || "")); }
  /**
   * Area ranking: the saving on a typical Rs 300 order, in percent, plus a
   * small bonus for no minimum order and for running 2 or more live offers.
   */
  var RANK_SAMPLE_PAISE = 30000;
  function offerScore(offers) {
    var list = (offers || []).filter(Boolean);
    if (!list.length) return {score: 0, best: null, savingPercent: 0};
    var best = null, bestSave = -1;
    list.forEach(function (offer) {
      var save = discountPaise(offer, RANK_SAMPLE_PAISE);
      if (save > bestSave || (save === bestSave && best && int(offer.minimumOrderPaise) < int(best.minimumOrderPaise))) { best = offer; bestSave = save; }
    });
    var savingPercent = Math.round(bestSave / RANK_SAMPLE_PAISE * 1000) / 10;
    var bonus = (bestSave > 0 && !int(best.minimumOrderPaise) ? 1 : 0) + (list.length >= 2 ? 0.5 : 0);
    return {score: bestSave > 0 ? savingPercent + bonus : bonus / 10, best: best, savingPercent: savingPercent};
  }
  var api = {
    GST_ON_COMMISSION_BPS: GST_ON_COMMISSION_BPS,
    RANK_SAMPLE_PAISE: RANK_SAMPLE_PAISE,
    rupees: rupees,
    discountPaise: discountPaise,
    maxGivePaise: maxGivePaise,
    payout: payout,
    priceForReceive: priceForReceive,
    dishPayout: dishPayout,
    offerLabel: offerLabel,
    suggestCode: suggestCode,
    codeAlternatives: codeAlternatives,
    validCode: validCode,
    offerScore: offerScore,
  };
  root.ScraveitOfferMath = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
