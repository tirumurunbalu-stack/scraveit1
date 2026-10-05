/*
 * Scraveit Price Planner. Two questions, answered big:
 *   "I want to get Rs X per dish"  -> the menu price to set
 *   "My menu price is Rs X"         -> what I get
 * plus "what if I run this offer?". Everything stays on the phone.
 */
(function () {
  "use strict";
  var M = window.ScraveitOfferMath;
  var STORE = "scraveit.planner.v1";
  var app = document.getElementById("app");
  var defaults = {mode: "find", want: "100", price: "150", commission: "30", offerType: "none",
    percent: "20", cap: "50", flat: "40", aboveOff: "75", aboveMin: "399", dishes: [], working: false};
  var state = load();

  function load() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORE) || "null");
      if (saved && typeof saved === "object") {
        var out = {};
        Object.keys(defaults).forEach(function (k) { out[k] = saved[k] != null ? saved[k] : defaults[k]; });
        if (!Array.isArray(out.dishes)) out.dishes = [];
        out.working = false;
        return out;
      }
    } catch (_) { /* private mode or cleared storage: start fresh */ }
    return JSON.parse(JSON.stringify(defaults));
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (_) { /* not critical */ }
  }
  function h(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c];
    });
  }
  function num(v) { var n = Number(String(v || "").replace(/[^0-9.]/g, "")); return isFinite(n) ? n : 0; }
  function paise(v) { return Math.round(num(v) * 100); }
  var rs = M.rupees;

  function commissionBps() { return Math.max(0, Math.min(5000, Math.round(num(state.commission) * 100))); }
  function offer() {
    if (state.offerType === "percent") return {kind: "percent", percent: Math.min(100, Math.round(num(state.percent))), maxDiscountPaise: paise(state.cap)};
    if (state.offerType === "flat") return {kind: "flat", flatAmountPaise: paise(state.flat)};
    if (state.offerType === "above") return {kind: "flat", flatAmountPaise: paise(state.aboveOff), minimumOrderPaise: paise(state.aboveMin)};
    return null;
  }
  function figures() {
    var bps = commissionBps(), price, plain;
    if (state.mode === "find") {
      price = M.priceForReceive(paise(state.want), bps);
    } else {
      price = paise(state.price);
    }
    plain = M.payout(price, 0, bps);
    var o = offer(), withOffer = o ? M.dishPayout(price, o, bps) : null;
    return {bps: bps, price: price, plain: plain, offer: o, withOffer: withOffer};
  }

  function field(id, label, value, prefix, suffix, hint) {
    return '<label class="field" for="' + id + '"><span class="field-label">' + h(label) + '</span>' +
      '<span class="field-box">' + (prefix ? '<span class="affix">' + h(prefix) + '</span>' : '') +
      '<input id="' + id + '" data-key="' + id + '" inputmode="decimal" autocomplete="off" enterkeyhint="done" value="' + h(value) + '">' +
      (suffix ? '<span class="affix">' + h(suffix) + '</span>' : '') + '</span>' +
      (hint ? '<span class="field-hint">' + h(hint) + '</span>' : '') + '</label>';
  }
  function segmented(name, options, current) {
    return '<div class="segmented" role="tablist">' + options.map(function (o) {
      return '<button type="button" role="tab" aria-selected="' + (o[0] === current) + '" class="seg' + (o[0] === current ? ' on' : '') +
        '" data-set="' + name + '" data-value="' + o[0] + '">' + h(o[1]) + '</button>';
    }).join("") + '</div>';
  }
  function offerFields() {
    if (state.offerType === "percent") return '<div class="row2">' + field("percent", "Percent off", state.percent, "", "%") + field("cap", "Up to", state.cap, "₹") + '</div>';
    if (state.offerType === "flat") return field("flat", "Flat off", state.flat, "₹");
    if (state.offerType === "above") return '<div class="row2">' + field("aboveOff", "Off", state.aboveOff, "₹") + field("aboveMin", "On orders above", state.aboveMin, "₹") + '</div>';
    return '<p class="muted small">Pick an offer to see what you still get per dish.</p>';
  }

  function render() {
    app.innerHTML =
      '<header class="top"><div class="brand"><span class="mark" aria-hidden="true">₹</span><div><p class="eyebrow">Scraveit</p><h1>Price Planner</h1></div></div>' +
      '<p class="lede">Know your money before you set a price or run an offer.</p></header>' +
      segmented("mode", [["find", "Find my price"], ["check", "Check my price"]], state.mode) +
      '<section class="card inputs">' +
        (state.mode === "find" ? field("want", "I want to get, per dish", state.want, "₹") : field("price", "My menu price", state.price, "₹")) +
        field("commission", "Scraveit commission", state.commission, "", "%", "Your rate is in the Scraveit restaurant app, under More › Your agreement.") +
      '</section>' +
      '<section class="answer" id="answer"></section>' +
      '<section class="card">' +
        '<div class="card-head"><h2>Try an offer</h2><span class="muted small">See it before you run it</span></div>' +
        '<div class="chips">' + [["none", "No offer"], ["percent", "% off"], ["flat", "₹ off"], ["above", "₹ off above"]].map(function (o) {
          return '<button type="button" class="chip' + (state.offerType === o[0] ? ' on' : '') + '" data-set="offerType" data-value="' + o[0] + '">' + h(o[1]) + '</button>';
        }).join("") + '</div>' +
        offerFields() +
        '<div id="offer-result"></div>' +
      '</section>' +
      '<button type="button" class="link" data-action="working" aria-expanded="' + state.working + '">How is this worked out? <span aria-hidden="true">' + (state.working ? '⌃' : '›') + '</span></button>' +
      '<section class="card working" id="working"' + (state.working ? '' : ' hidden') + '></section>' +
      '<section class="card">' +
        '<div class="card-head"><h2>My price list</h2>' + (state.dishes.length ? '<button type="button" class="text-btn" data-action="share">Share</button>' : '') + '</div>' +
        '<div class="save-row"><input id="dish-name" class="plain-input" placeholder="Dish name, e.g. Chocolate Waffle" maxlength="40" autocomplete="off"><button type="button" class="btn" data-action="save-dish">Save</button></div>' +
        '<div id="dishes"></div>' +
      '</section>' +
      '<p class="foot">Works offline. Nothing you type leaves this phone.</p>';
    update();
  }

  function update() {
    var f = figures(), answer = document.getElementById("answer");
    if (!answer) return;
    if (!f.price) {
      answer.innerHTML = '<p class="answer-label">' + (state.mode === "find" ? "Set your menu price" : "You get, per dish") + '</p><p class="answer-big">—</p><p class="answer-sub">Type an amount above.</p>';
    } else if (state.mode === "find") {
      answer.innerHTML = '<p class="answer-label">Set your menu price</p><p class="answer-big">' + rs(f.price) + '</p>' +
        '<p class="answer-sub">You get <b>' + rs(f.plain.receive) + '</b> per dish. Customers pay food GST on top at checkout, so it never comes out of your money.</p>';
    } else {
      answer.innerHTML = '<p class="answer-label">You get, per dish</p><p class="answer-big">' + rs(f.plain.receive) + '</p>' +
        '<p class="answer-sub">For a menu price of <b>' + rs(f.price) + '</b>. Food GST is added for the customer at checkout.</p>';
    }
    var result = document.getElementById("offer-result");
    if (result) {
      if (!f.offer || !f.price) result.innerHTML = "";
      else {
        var w = f.withOffer, applies = w.discount > 0;
        result.innerHTML = '<div class="badge-row"><span class="muted small">Customers will see</span><span class="offer-badge">' + h(M.offerLabel(f.offer)) + '</span></div>' +
          '<div class="kv big"><span>You still get, per dish</span><strong class="good">' + rs(w.receive) + '</strong></div>' +
          (applies ? '' : '<p class="muted small">' + (f.offer.minimumOrderPaise ? 'One dish on its own is below ' + rs(f.offer.minimumOrderPaise) + ', so the offer starts once the order reaches it.' : 'Enter the offer amount above.') + '</p>') +
          '<div class="kv"><span>Most you give on one order</span><strong>' + rs(M.maxGivePaise(f.offer)) + '</strong></div>';
      }
    }
    var working = document.getElementById("working");
    if (working && state.working) working.innerHTML = workingMarkup(f);
    var dishes = document.getElementById("dishes");
    if (dishes) dishes.innerHTML = dishesMarkup();
  }

  function workingMarkup(f) {
    if (!f.price) return '<p class="muted small">Type an amount first.</p>';
    var p = f.withOffer || f.plain, discount = f.withOffer ? f.withOffer.discount : 0, pct = (f.bps / 100).toString();
    var row = function (l, v, cls) { return '<div class="kv' + (cls ? ' ' + cls : '') + '"><span>' + l + '</span><strong>' + v + '</strong></div>'; };
    return '<h2>For one dish at ' + rs(f.price) + (discount ? ', with the offer' : '') + '</h2>' +
      row("Your menu price", rs(f.price)) +
      (discount ? row("Offer you give", "− " + rs(discount, true)) : '') +
      row("Commission is charged on", rs(p.base, true), "sub") +
      row("Scraveit commission (" + h(pct) + "%)", "− " + rs(p.commission, true)) +
      row("GST on commission (18%)", "− " + rs(p.commissionGst, true)) +
      row("You get", rs(p.receive, true), "total") +
      '<ul class="notes">' +
        '<li>An offer only reduces the item total. Commission is charged on the price after your offer, so you never pay commission on money you gave away.</li>' +
        '<li>Food GST (5% for restaurants) is added on top of the reduced item total and paid by the customer. Scraveit pays it to the government as the e-commerce operator (CGST Act, s.9(5)).</li>' +
        '<li>GST on commission (18%) is shown on Scraveit’s monthly tax invoice to you.</li>' +
        '<li>When TDS starts, 0.1% of your sales is deducted for income tax and shows in your tax credit statement, so you can claim it back.</li>' +
      '</ul>';
  }

  function dishesMarkup() {
    if (!state.dishes.length) return '<p class="muted small">Save dishes here to build your price list.</p>';
    var bps = commissionBps();
    return '<ul class="dish-list">' + state.dishes.map(function (d, i) {
      var price = d.mode === "find" ? M.priceForReceive(d.want, bps) : d.price, got = M.payout(price, 0, bps).receive;
      return '<li><div><strong>' + h(d.name) + '</strong><span class="muted small">You get ' + rs(got) + '</span></div><span class="dish-price">' + rs(price) + '</span>' +
        '<button type="button" class="x" data-action="remove-dish" data-index="' + i + '" aria-label="Remove ' + h(d.name) + '">×</button></li>';
    }).join("") + '</ul><p class="muted small">Prices follow the commission above.</p>';
  }

  function shareList() {
    var bps = commissionBps();
    var text = "My Scraveit prices (" + (bps / 100) + "% commission)\n" + state.dishes.map(function (d) {
      var price = d.mode === "find" ? M.priceForReceive(d.want, bps) : d.price;
      return "• " + d.name + ": " + rs(price) + " (I get " + rs(M.payout(price, 0, bps).receive) + ")";
    }).join("\n");
    if (window.PlannerNative && PlannerNative.shareText) PlannerNative.shareText(text);
    else if (navigator.share) navigator.share({text: text}).catch(function () {});
  }

  app.addEventListener("input", function (e) {
    var key = e.target && e.target.getAttribute("data-key");
    if (!key) return;
    state[key] = e.target.value.replace(/[^0-9.]/g, "").slice(0, 8);
    if (state[key] !== e.target.value) e.target.value = state[key];
    save();
    update();
  });
  app.addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.set) { state[b.dataset.set] = b.dataset.value; save(); render(); return; }
    var a = b.dataset.action;
    if (a === "working") { state.working = !state.working; render(); return; }
    if (a === "share") { shareList(); return; }
    if (a === "remove-dish") { state.dishes.splice(Number(b.dataset.index), 1); save(); update(); return; }
    if (a === "save-dish") {
      var input = document.getElementById("dish-name"), name = (input.value || "").trim();
      var f = figures();
      if (!f.price) return;
      if (!name) { input.focus(); input.classList.add("need"); return; }
      state.dishes.unshift(state.mode === "find" ? {name: name, mode: "find", want: paise(state.want)} : {name: name, mode: "check", price: f.price});
      state.dishes = state.dishes.slice(0, 60);
      input.value = "";
      input.classList.remove("need");
      save();
      update();
    }
  });
  window.plannerBack = function () {
    if (state.working) { state.working = false; render(); return true; }
    return false;
  };
  render();
})();
