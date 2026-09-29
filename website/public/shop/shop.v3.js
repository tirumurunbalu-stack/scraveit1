/*
 * SCRAVEIT web shop (www.scraveit.in/shop).
 *
 * Restaurants and their menus are read live from the same Firestore catalogue
 * the Customer app uses; orders go through the same server callables
 * (getCheckoutConfiguration, createOrder), so prices, fees, riders and order
 * tracking are identical. Grocery and dairy stores are sample listings
 * (samples.v3.js) until the FSSAI licence is issued; they can be browsed and
 * carted but not ordered.
 */
(function () {
  "use strict";
  const CFG = window.SCRAVEIT_WEB || {};
  const SAMPLE_STORES = window.SCRAVEIT_SAMPLE_STORES || [];
  const app = document.getElementById("app");
  const KIND_LABEL = {restaurant: "Restaurant", grocery: "Grocery", dairy: "Dairy"};
  const KIND_TABS = [["restaurant", "Restaurants"], ["grocery", "Groceries"], ["dairy", "Dairy"]];
  const ORDERS_OPEN = CFG.ordersOpen === true;
  const SAMPLE_MENUS = window.SCRAVEIT_SAMPLE_MENUS || {};
  const STATUS_FLOW = ["Order placed", "Accepted", "Preparing", "Ready for pickup", "Assigned", "Handed to rider", "Out for delivery", "Near you", "Arrived", "Delivered"];

  // ---------------------------------------------------------------- helpers
  const h = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const rs = (value) => "₹" + Number(value || 0).toLocaleString("en-IN", {maximumFractionDigits: 2, minimumFractionDigits: Number(value) % 1 ? 2 : 0});
  const num = (value, fallback = 0) => { const n = Number(value); return Number.isFinite(n) ? n : fallback; };
  const load = (key, fallback) => { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; } };
  const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* private mode */ } };
  let toastTimer = 0;
  function toast(message) {
    const el = document.getElementById("toast");
    el.textContent = message; el.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
  }
  function friendly(error) {
    const raw = String(error && (error.message || error.code) || error || "");
    if (/app[- ]?check|unauthenticated.*app/i.test(raw)) return "Website ordering is still being switched on. Please use the SCRAVEIT app for now.";
    if (/network|unavailable|failed to fetch/i.test(raw)) return "You seem to be offline. Check your connection and try again.";
    if (/popup-closed|cancelled-popup/i.test(raw)) return "Sign-in was cancelled.";
    if (/unauthorized-domain/i.test(raw)) return "Sign-in isn't enabled for this website yet.";
    if (/wrong-password|invalid-credential|user-not-found/i.test(raw)) return "That email and password don't match.";
    if (/email-already-in-use/i.test(raw)) return "An account already exists for that email. Sign in instead.";
    if (/weak-password/i.test(raw)) return "Use a password of at least 8 characters.";
    return raw.replace(/^Firebase:\s*/, "").replace(/\s*\(.*?\)\.?$/, "") || "Something went wrong. Please try again.";
  }
  const dietMark = (diet) => '<span class="diet ' + (String(diet || "veg") === "veg" ? "veg" : "nonveg") + '" role="img" aria-label="' + (String(diet || "veg") === "veg" ? "Vegetarian" : "Non-vegetarian") + '"></span>';

  // ---------------------------------------------------------------- firebase
  let auth = null, db = null, fns = null, appCheckOn = false;
  try {
    firebase.initializeApp(CFG.firebase);
    if (CFG.recaptchaEnterpriseSiteKey) {
      firebase.appCheck().activate(new firebase.appCheck.ReCaptchaEnterpriseProvider(CFG.recaptchaEnterpriseSiteKey), true);
      appCheckOn = true;
    }
    auth = firebase.auth(); db = firebase.firestore(); fns = firebase.app().functions(CFG.functionsRegion || "asia-south1");
  } catch (error) {
    console.error("FIREBASE_INIT_FAILED", error);
  }
  const call = (name, data) => fns.httpsCallable(name, {timeout: 40000})(data).then((r) => r.data);

  // ---------------------------------------------------------------- state
  const state = {user: null, authReady: false, stores: null, menus: {}, profile: null, preview: null, previewKey: ""};
  const CART_KEY = "scraveit.web.cart", OTP_KEY = "scraveit.web.otps";
  let cart = load(CART_KEY, {storeId: "", lines: {}});
  function cartCount() { return Object.values(cart.lines || {}).reduce((sum, q) => sum + num(q), 0); }
  function persistCart() { save(CART_KEY, cart); document.getElementById("cart-count").textContent = cartCount(); }

  // ---------------------------------------------------------------- catalogue
  function kindOf(record) {
    const explicit = String(record.storeType || "").toLowerCase();
    if (KIND_LABEL[explicit]) return explicit;
    const category = String(record.category || "").toLowerCase();
    if (/grocery|kirana|supermarket|provision/.test(category)) return "grocery";
    if (/dairy|milk/.test(category)) return "dairy";
    return "restaurant";
  }
  function realStore(id, r) {
    return {
      id, real: true, storeType: kindOf(r), name: String(r.name || "Store"), city: String(r.city || ""),
      address: String(r.address || ""), tagline: String(r.description || (Array.isArray(r.cuisines) ? r.cuisines.join(" · ") : r.category || "")),
      image: r.imageThumbUrl || r.imageUrl || "", open: r.open !== false, etaMin: num(r.etaMin, 25), etaMax: num(r.etaMax, 40),
      pureVeg: r.pureVeg === true, sellerFssai: r.fssaiLicence || r.fssaiLicenseNumber || "", sample: !ORDERS_OPEN,
      deliveryFee: num(r.deliveryFee, 29), platformFee: num(r.platformFee, 15),
      embeddedMenu: Array.isArray(r.menu) ? r.menu : [],
    };
  }
  async function loadStores() {
    if (state.stores) return state.stores;
    const stores = [];
    try {
      const snapshot = await db.collection("restaurants").get();
      snapshot.forEach((doc) => {
        const r = doc.data() || {};
        if (r.archived === true || r.active === false) return;
        stores.push(realStore(doc.id, r));
      });
    } catch (error) {
      console.warn("CATALOGUE_LOAD_FAILED", error);
    }
    SAMPLE_STORES.forEach((s) => stores.push(Object.assign({real: false, open: true, image: ""}, s)));
    state.stores = stores;
    return stores;
  }
  const storeById = (id) => (state.stores || []).find((s) => s.id === id) || null;
  async function loadMenu(store) {
    if (!store) return [];
    if (state.menus[store.id]) return state.menus[store.id];
    let items = [];
    if (store.real) {
      try {
        const snapshot = await db.collection("menus").doc(store.id).collection("items").get();
        snapshot.forEach((doc) => items.push(Object.assign({id: doc.id}, doc.data())));
      } catch (error) { console.warn("MENU_LOAD_FAILED", error); }
      if (!items.length) items = store.embeddedMenu.map((item, i) => Object.assign({id: String(item.id || i)}, item));
      if (!items.length && SAMPLE_MENUS[store.id]) items = SAMPLE_MENUS[store.id].map((i) => Object.assign({}, i));
      items = items.filter((i) => i.archived !== true && String(i.name || "").trim().length >= 3)
        .map((i) => Object.assign({}, i, {price: num(i.price), sample: i.sample === true || store.sample === true}));
    } else {
      items = (store.items || []).map((i) => Object.assign({}, i));
    }
    items.sort((a, b) => String(a.category || "").localeCompare(String(b.category || "")) || String(a.name).localeCompare(String(b.name)));
    state.menus[store.id] = items;
    return items;
  }

  // ---------------------------------------------------------------- routing
  function go(path, replace) {
    if (replace) history.replaceState({}, "", path); else history.pushState({}, "", path);
    render();
    window.scrollTo(0, 0);
  }
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href]");
    if (!link || link.target || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const url = new URL(link.href, location.href);
    if (url.origin === location.origin && url.pathname.startsWith("/shop")) {
      event.preventDefault();
      go(url.pathname + url.search);
    }
  });
  window.addEventListener("popstate", render);

  function setTitle(title) { document.title = title ? title + " | SCRAVEIT" : "Order food, groceries and dairy | SCRAVEIT"; }
  function markNav(path) {
    document.querySelectorAll(".s-nav a").forEach((a) => a.toggleAttribute("aria-current", a.getAttribute("href") === path));
  }

  async function render() {
    const path = location.pathname.replace(/\/+$/, "") || "/shop";
    const parts = path.split("/").filter(Boolean); // ["shop", ...]
    setKindBar("");
    markNav("/" + parts.slice(0, 2).join("/"));
    try {
      if (parts[1] === "store" && parts[2]) return await viewStore(decodeURIComponent(parts[2]));
      if (parts[1] === "item" && parts[2] && parts[3]) return await viewItem(decodeURIComponent(parts[2]), decodeURIComponent(parts[3]));
      if (parts[1] === "cart") return await viewCart();
      if (parts[1] === "checkout") return await viewCheckout();
      if (parts[1] === "demo-checkout") return await viewDemoCheckout();
      if (parts[1] === "demo-order" && parts[2]) return viewDemoOrder(decodeURIComponent(parts[2]));
      if (parts[1] === "orders" && parts[2]) return await viewOrder(decodeURIComponent(parts[2]));
      if (parts[1] === "orders") return await viewOrders();
      if (parts[1] === "signin") return viewSignIn();
      return await viewHome();
    } catch (error) {
      console.error(error);
      app.innerHTML = '<div class="notice bad"><div><strong>This page could not load.</strong>' + h(friendly(error)) + "</div></div>";
    }
  }

  // ---------------------------------------------------------------- views: home
  function storeCard(store) {
    const tags = (store.sample ? '<span class="pill sample">Sample listing</span>' : "") +
      (store.real && ORDERS_OPEN ? '<span class="pill ' + (store.open ? "open" : "closed") + '">' + (store.open ? "Open" : "Closed") + "</span>" : "");
    return '<a class="store-card" href="/shop/store/' + encodeURIComponent(store.id) + '">' +
      '<div class="store-cover">' + (store.image ? '<img src="' + h(store.image) + '" alt="" loading="lazy">' : '<span class="glyph" aria-hidden="true">' + h(store.name.charAt(0)) + "</span>") +
      '<div class="cover-tags"><span class="pill kind">' + h(KIND_LABEL[store.storeType]) + "</span>" + tags + "</div></div>" +
      '<div class="store-body"><h3>' + h(store.name) + "</h3>" +
      '<div class="store-meta"><span>' + h(store.tagline || "") + "</span></div>" +
      '<div class="store-meta"><span>' + h(store.etaMin + "–" + store.etaMax + " min") + "</span>" + (store.city ? "<span>" + h(store.city) + "</span>" : "") + "</div></div></a>";
  }
  async function viewHome() {
    setTitle("");
    const params = new URLSearchParams(location.search);
    const kind = KIND_TABS.some(([k]) => k === params.get("type")) ? params.get("type") : "restaurant";
    setKindBar(kind);
    app.innerHTML = '<p class="s-loading">Loading stores…</p>';
    const stores = await loadStores();
    const shown = stores.filter((s) => s.storeType === kind);
    app.innerHTML =
      '<section class="s-hero"><div><p class="eyebrow">Restaurants · Groceries · Dairy</p><h1>Good food, <em>delivered</em> with care.</h1></div>' +
      "<p>Order from partner restaurants, grocery stores and dairies near you. Every product page shows the full FSSAI label information, and each store's own FSSAI licence.</p></section>" +
      (ORDERS_OPEN ? "" : '<div class="notice info" style="margin-bottom:20px"><div><strong>Launching soon in Nellore district.</strong>Every store and product shown here is a sample listing, to show how SCRAVEIT will work. Ordering opens once SCRAVEIT\'s FSSAI licence is issued.</div></div>') +
      '<h2 class="kind-title">' + h((KIND_TABS.find(([k]) => k === kind) || [])[1] || "") + "</h2>" +
      (shown.length ? '<div class="store-grid">' + shown.map(storeCard).join("") + "</div>" : '<p class="s-empty">No stores in this category yet.</p>');
  }

  // ---------------------------------------------------------------- views: store
  function priceBlock(item) {
    const mrp = item.compliance && num(item.compliance.mrp);
    return '<div class="item-price">' + rs(item.price) + (mrp && mrp > item.price ? "<s>MRP " + rs(mrp) + "</s>" : "") + "</div>";
  }
  function stepperFor(store, item) {
    const q = cart.storeId === store.id ? num(cart.lines[item.id]) : 0;
    if (item.available === false) return '<span class="pill closed">Unavailable</span>';
    if (Array.isArray(item.variants) && item.variants.length) return '<a class="btn small ghost" href="/shop/item/' + encodeURIComponent(store.id) + "/" + encodeURIComponent(item.id) + '">Choose</a>';
    return q ? '<div class="stepper"><button type="button" data-cart="-1" data-store="' + h(store.id) + '" data-item="' + h(item.id) + '" aria-label="Remove one">−</button><span>' + q +
      '</span><button type="button" data-cart="1" data-store="' + h(store.id) + '" data-item="' + h(item.id) + '" aria-label="Add one">+</button></div>'
      : '<button type="button" class="btn small" data-cart="1" data-store="' + h(store.id) + '" data-item="' + h(item.id) + '">Add</button>';
  }
  function itemCard(store, item) {
    const href = "/shop/item/" + encodeURIComponent(store.id) + "/" + encodeURIComponent(item.id);
    const thumb = item.imageThumbUrl || item.imageUrl;
    const meta = item.compliance && item.compliance.netQuantity ? '<p>' + h(item.compliance.netQuantity) + (item.compliance.brand ? " · " + h(item.compliance.brand) : "") + "</p>" : (item.description ? "<p>" + h(item.description) + "</p>" : "");
    return '<article class="item-card"><div><h3>' + dietMark(item.diet) + '<a href="' + href + '">' + h(item.name) + "</a></h3>" + meta + priceBlock(item) +
      '<div class="item-links"><a href="' + href + '">Product details &amp; label</a></div></div>' +
      '<div class="item-side">' + (thumb ? '<img class="item-thumb" src="' + h(thumb) + '" alt="" loading="lazy">' : '<span class="item-thumb placeholder" aria-hidden="true">' + h(item.name.charAt(0)) + "</span>") +
      stepperFor(store, item) + "</div></article>";
  }
  async function viewStore(id) {
    await loadStores();
    const store = storeById(id);
    if (!store) { app.innerHTML = '<p class="s-empty">This store is not available. <a href="/shop">Back to the shop</a></p>'; return; }
    setTitle(store.name);
    setKindBar(store.storeType);
    app.innerHTML = '<p class="s-loading">Loading ' + h(store.name) + "…</p>";
    const items = await loadMenu(store);
    const groups = {};
    items.forEach((i) => { const k = i.category || "Menu"; (groups[k] = groups[k] || []).push(i); });
    app.innerHTML =
      '<nav class="crumbs" aria-label="Breadcrumb"><a href="/shop">Shop</a><span>/</span><a href="/shop?type=' + store.storeType + '">' + h(KIND_LABEL[store.storeType]) + "</a><span>/</span><span>" + h(store.name) + "</span></nav>" +
      '<section class="store-head"><div><p class="eyebrow">' + h(KIND_LABEL[store.storeType]) + (store.sample ? " · Sample listing" : "") + "</p><h1>" + h(store.name) + "</h1><p>" + h(store.tagline || "") + "</p>" +
      '<p class="store-meta">' + h(store.etaMin + "–" + store.etaMax + " min delivery") + (store.real && ORDERS_OPEN ? " · " + (store.open ? "Open now" : "Closed now") : "") + "</p></div>" +
      '<div class="seller-box"><b>Sold by:</b> ' + h(store.name) + (store.address ? "<br>" + h(store.address) : "") +
      "<br><b>Seller FSSAI licence:</b> " + (store.sellerFssai ? h(store.sellerFssai) : '<i>Shown here once provided by the seller</i>') + "</div></section>" +
      (store.sample ? '<div class="notice warn"><div><strong>Sample listing.</strong>This store shows how ' + h(KIND_LABEL[store.storeType].toLowerCase()) + ' partners will appear on SCRAVEIT. Items, prices and label details are examples; ordering opens once SCRAVEIT\'s FSSAI licence is issued.</div></div>' : "") +
      (!items.length ? '<p class="s-empty">No items listed yet.</p>' : Object.keys(groups).map((g) =>
        '<section class="menu-section"><h2>' + h(g) + '</h2><div class="item-list">' + groups[g].map((i) => itemCard(store, i)).join("") + "</div></section>").join(""));
  }

  // ---------------------------------------------------------------- views: product page (FSSAI label)
  function row(label, value, pendingText) {
    const has = value !== undefined && value !== null && String(value).trim() !== "";
    return "<dt>" + h(label) + "</dt><dd" + (has ? "" : ' class="pending"') + ">" + (has ? value : h(pendingText || "To be provided by the seller")) + "</dd>";
  }
  function nutritionTable(n) {
    if (!n) return "";
    const rows = [["Energy", n.energyKcal, "kcal"], ["Protein", n.proteinG, "g"], ["Carbohydrate", n.carbohydrateG, "g"], ["  of which total sugars", n.totalSugarsG, "g"],
      ["  of which added sugars", n.addedSugarsG, "g"], ["Total fat", n.fatG, "g"], ["  of which saturated fat", n.saturatedFatG, "g"], ["  of which trans fat", n.transFatG, "g"], ["Sodium", n.sodiumMg, "mg"]];
    return '<table class="nutrition"><thead><tr><th>Nutrition information</th><th>Per ' + h(n.per || "100 g") + "</th></tr></thead><tbody>" +
      rows.map(([l, v, u]) => "<tr><td>" + h(l.trim()).replace(/^of which/, "&nbsp;&nbsp;of which") + "</td><td>" + (v == null ? "—" : h(v) + " " + u) + "</td></tr>").join("") + "</tbody></table>";
  }
  function labelPanel(store, item) {
    const c = item.compliance || {};
    const veg = String(item.diet || "veg") === "veg";
    if (store.storeType === "restaurant" && !item.compliance) {
      return '<section class="label-panel"><h2>Food information <span>' + (item.sample ? '<span class="pill sample">Sample values</span> ' : "") + '<span class="pill kind">Prepared food</span></span></h2><dl>' +
        row("Dish", h(item.name)) +
        row("Veg / non-veg", dietMark(item.diet) + " " + (veg ? "Vegetarian" : "Non-vegetarian")) +
        row("Description", item.description ? h(item.description) : "", "Not described by the restaurant yet") +
        row("Ingredients", item.ingredients ? h(item.ingredients) : "", "Provided by the restaurant on request") +
        row("Allergens", item.allergens ? h(item.allergens) : "", "Ask the restaurant before ordering if you have a food allergy") +
        row("Energy", item.calories ? h(item.calories) + " kcal per serving" : "", "Not declared by the restaurant") +
        row("Serving size", item.servingSize ? h(item.servingSize) : "", "One portion as prepared") +
        row("Preparation time", item.preparationTime ? h(item.preparationTime) + " min" : "", "Shown at checkout") +
        row("Price", rs(item.price) + " (menu price; taxes, if any, shown at checkout)") +
        row("Sold and prepared by", h(store.name) + (store.address ? ", " + h(store.address) : "")) +
        row("Restaurant FSSAI licence", store.sellerFssai ? h(store.sellerFssai) : "", "Shown here once provided by the restaurant") +
        "</dl><p class=\"panel-note\">Prepared fresh by the restaurant for each order. Report a food safety concern on the <a href=\"/grievance\">grievance page</a>.</p></section>";
    }
    return '<section class="label-panel"><h2>Label information <span>' + (c.sampleValues ? '<span class="pill sample">Sample values</span>' : "") + "</span></h2><dl>" +
      row("Product name", h(item.name)) +
      row("Brand", c.brand ? h(c.brand) : "") +
      row("Veg / non-veg", dietMark(item.diet) + " " + (veg ? "Vegetarian" : "Non-vegetarian")) +
      row("Net quantity", c.netQuantity ? h(c.netQuantity) : "") +
      row("MRP (incl. of all taxes)", c.mrp ? rs(c.mrp) : "") +
      row("Selling price", rs(item.price)) +
      row("Ingredients", c.ingredients ? h(c.ingredients) : "") +
      row("Allergen information", c.allergens ? h(c.allergens) : "") +
      row("Food category", c.foodCategory ? h(c.foodCategory) : "") +
      row("Storage instructions", c.storage ? h(c.storage) : "") +
      row("Shelf life", c.shelfLife ? h(c.shelfLife) : "") +
      row("Best before / use by", c.bestBefore ? h(c.bestBefore) : "") +
      row("Manufacturer / packer name and address", c.manufacturer ? h(c.manufacturer) : "") +
      row("Manufacturer FSSAI licence", c.manufacturerFssai ? h(c.manufacturerFssai) : "") +
      row("Country of origin", c.countryOfOrigin ? h(c.countryOfOrigin) : "") +
      row("Sold by", h(store.name)) +
      row("Seller FSSAI licence", c.sellerFssai ? h(c.sellerFssai) : (store.sellerFssai ? h(store.sellerFssai) : "")) +
      row("Customer care", c.customerCare ? h(c.customerCare) : "") +
      "</dl>" + nutritionTable(c.nutrition) +
      '<p class="panel-note">Information shown is as declared on the product label' + (c.sampleValues ? " — for this sample listing the values are typical examples, not a real product." : ".") +
      " Actual label on the delivered pack prevails. Report a concern on the <a href=\"/grievance\">grievance page</a>.</p></section>";
  }
  async function viewItem(storeId, itemId) {
    await loadStores();
    const store = storeById(storeId);
    const items = await loadMenu(store);
    const item = items.find((i) => i.id === itemId);
    if (!store || !item) { app.innerHTML = '<p class="s-empty">This product is not available. <a href="/shop">Back to the shop</a></p>'; return; }
    setTitle(item.name + " · " + store.name);
    setKindBar(store.storeType);
    const img = item.imageUrl || item.imageThumbUrl;
    const mrp = item.compliance && num(item.compliance.mrp);
    const variants = Array.isArray(item.variants) ? item.variants : [];
    app.innerHTML =
      '<nav class="crumbs" aria-label="Breadcrumb"><a href="/shop">Shop</a><span>/</span><a href="/shop/store/' + encodeURIComponent(store.id) + '">' + h(store.name) + "</a><span>/</span><span>" + h(item.name) + "</span></nav>" +
      '<div class="pdp"><div><div class="pdp-media">' + (img ? '<img src="' + h(img) + '" alt="' + h(item.name) + '">' : '<span class="glyph" aria-hidden="true">' + h(item.name.charAt(0)) + "</span>") + "</div>" +
      (item.sample ? '<div class="notice warn" style="margin-top:14px"><div><strong>Sample listing.</strong>This page shows how every item will be displayed on SCRAVEIT. It cannot be ordered yet.</div></div>' : "") + "</div>" +
      "<div><p class=\"eyebrow\">" + h(KIND_LABEL[store.storeType]) + " · " + h(item.category || "") + "</p><h1>" + dietMark(item.diet) + "<span>" + h(item.name) + "</span></h1>" +
      '<p class="pdp-sub">Sold by <a href="/shop/store/' + encodeURIComponent(store.id) + '">' + h(store.name) + "</a></p>" +
      '<div class="pdp-price"><strong>' + rs(item.price) + "</strong>" + (mrp ? "<s>MRP " + rs(mrp) + "</s><small>incl. of all taxes</small>" : "") + "</div>" +
      (variants.length ? '<div class="field" style="max-width:320px"><label for="variant">Choose</label><select class="input" id="variant">' +
        variants.map((v) => '<option value="' + h(v.id || v.name) + '">' + h(v.name) + " · " + rs(v.price) + "</option>").join("") + "</select></div>" : "") +
      '<div class="pdp-actions">' + (item.available === false ? '<span class="pill closed">Currently unavailable</span>' :
        '<button type="button" class="btn" data-cart="1" data-store="' + h(store.id) + '" data-item="' + h(item.id) + '">Add to cart</button><a class="btn ghost" href="/shop/cart">Go to cart</a>') + "</div>" +
      labelPanel(store, item) + "</div></div>";
  }

  // ---------------------------------------------------------------- cart
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-cart]");
    if (!button) return;
    const storeId = button.dataset.store, itemId = button.dataset.item, delta = num(button.dataset.cart);
    if (delta > 0 && cart.storeId && cart.storeId !== storeId && cartCount() > 0) {
      const current = storeById(cart.storeId);
      if (!confirm("Your cart has items from " + (current ? current.name : "another store") + ". Start a new cart with this store?")) return;
      cart = {storeId, lines: {}};
    }
    if (!cart.storeId || cartCount() === 0) cart = {storeId, lines: {}};
    const next = Math.max(0, num(cart.lines[itemId]) + delta);
    if (next) cart.lines[itemId] = Math.min(next, 20); else delete cart.lines[itemId];
    if (!cartCount()) cart = {storeId: "", lines: {}};
    persistCart();
    state.preview = null;
    if (delta > 0) toast("Added to cart");
    render();
  });
  async function cartDetails() {
    await loadStores();
    const store = storeById(cart.storeId);
    if (!store || !cartCount()) return {store: null, lines: [], subtotal: 0};
    const items = await loadMenu(store);
    const lines = Object.entries(cart.lines).map(([id, q]) => ({item: items.find((i) => i.id === id), quantity: num(q)})).filter((l) => l.item);
    const subtotal = lines.reduce((sum, l) => sum + l.item.price * l.quantity, 0);
    return {store, lines, subtotal};
  }
  function cartLinesMarkup(store, lines) {
    return lines.map((l) => '<div class="cart-line"><div class="name">' + dietMark(l.item.diet) + "<span>" + h(l.item.name) +
      (l.item.compliance && l.item.compliance.netQuantity ? '<br><small style="color:var(--muted);font-weight:400">' + h(l.item.compliance.netQuantity) + "</small>" : "") + "</span></div>" +
      '<div class="stepper"><button type="button" data-cart="-1" data-store="' + h(store.id) + '" data-item="' + h(l.item.id) + '" aria-label="Remove one">−</button><span>' + l.quantity +
      '</span><button type="button" data-cart="1" data-store="' + h(store.id) + '" data-item="' + h(l.item.id) + '" aria-label="Add one">+</button></div>' +
      '<div class="price">' + rs(l.item.price * l.quantity) + "</div></div>").join("");
  }
  async function viewCart() {
    setTitle("Cart");
    const {store, lines, subtotal} = await cartDetails();
    if (!store || !lines.length) {
      app.innerHTML = '<div class="panel" style="max-width:560px"><h2>Your cart is empty</h2><p style="margin:0;color:var(--muted)">Add something from a restaurant or store to get started.</p><a class="btn" href="/shop">Browse the shop</a></div>';
      return;
    }
    const blocked = !ORDERS_OPEN || store.sample ? "sample" : !store.open ? "closed" : "";
    app.innerHTML = '<div class="two-col"><section class="panel"><h2>Cart · ' + h(store.name) + "</h2>" + cartLinesMarkup(store, lines) + "</section>" +
      '<aside class="panel"><h2>Summary</h2><div class="bill-row"><span>Item total</span><span>' + rs(subtotal) + "</span></div>" +
      '<p style="margin:0;font-size:13px;color:var(--muted)">Delivery, platform fee and taxes are calculated at checkout from your address.</p>' +
      (blocked === "sample" ? '<div class="notice warn"><div><strong>Ordering opens soon.</strong>All listings are samples until SCRAVEIT\'s FSSAI licence is issued. Try the demo checkout to see every step of ordering; nothing is placed or charged.</div></div><a class="btn block peach" href="/shop/demo-checkout">Continue to demo checkout</a>' : "") +
      (blocked === "closed" ? '<div class="notice bad"><div><strong>' + h(store.name) + " is closed right now.</strong>Try again when it opens.</div></div>" : "") +
      (blocked === "sample" ? "" : '<a class="btn block" href="/shop/checkout"' + (blocked ? ' aria-disabled="true" style="pointer-events:none;opacity:.5"' : "") + ">Proceed to checkout</a>") + "</aside></div>";
  }

  // ---------------------------------------------------------------- auth
  function requireUser(next) {
    if (state.user) return true;
    go("/shop/signin?next=" + encodeURIComponent(next || location.pathname), true);
    return false;
  }
  function viewSignIn() {
    setTitle("Sign in");
    const next = new URLSearchParams(location.search).get("next") || "/shop";
    if (state.user) {
      app.innerHTML = '<div class="panel" style="max-width:520px"><h2>You are signed in</h2><p style="margin:0">' + h(state.user.email || state.user.displayName || "") +
        '</p><div style="display:flex;gap:10px;flex-wrap:wrap"><a class="btn" href="' + h(next) + '">Continue</a><a class="btn ghost" href="/shop/orders">My orders</a><button class="btn ghost" type="button" id="sign-out">Sign out</button></div></div>';
      document.getElementById("sign-out").onclick = () => auth.signOut().then(() => { toast("Signed out"); go("/shop"); });
      return;
    }
    app.innerHTML = '<div class="panel" style="max-width:520px"><p class="eyebrow">Your SCRAVEIT account</p><h2>Sign in to order</h2>' +
      '<p style="margin:0;color:var(--muted)">Use the same account as the SCRAVEIT app — your addresses and orders are shared.</p>' +
      '<button class="btn block ghost" type="button" id="google-sign-in">Continue with Google</button><div class="divider">or with email</div>' +
      '<form id="email-form" class="panel" style="padding:0;border:0;gap:12px"><div class="field"><label for="email">Email</label><input class="input" id="email" type="email" autocomplete="email" required></div>' +
      '<div class="field"><label for="password">Password</label><input class="input" id="password" type="password" autocomplete="current-password" minlength="8" required></div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn" type="submit" data-mode="signin">Sign in</button><button class="btn ghost" type="submit" data-mode="signup">Create account</button></div></form>' +
      '<p style="margin:0;font-size:12px;color:var(--muted)">By continuing you agree to the <a href="/terms">Terms of use</a> and <a href="/privacy">Privacy policy</a>.</p></div>';
    document.getElementById("google-sign-in").onclick = () => auth.signInWithPopup(new firebase.auth.GoogleAuthProvider())
      .then(() => go(next, true)).catch((e) => toast(friendly(e)));
    document.getElementById("email-form").onsubmit = (event) => {
      event.preventDefault();
      const mode = event.submitter && event.submitter.dataset.mode;
      const email = document.getElementById("email").value.trim(), password = document.getElementById("password").value;
      const action = mode === "signup" ? auth.createUserWithEmailAndPassword(email, password) : auth.signInWithEmailAndPassword(email, password);
      action.then(() => go(next, true)).catch((e) => toast(friendly(e)));
    };
  }

  // ---------------------------------------------------------------- profile & address
  async function loadProfile() {
    if (!state.user) return null;
    const snap = await db.collection("users").doc(state.user.uid).get();
    state.profile = snap.exists ? snap.data() : {};
    return state.profile;
  }
  async function saveAddress(address) {
    const ref = db.collection("users").doc(state.user.uid);
    const snap = await ref.get();
    const profile = snap.exists ? snap.data() : {};
    const addresses = Array.isArray(profile.addresses) ? profile.addresses.slice() : [];
    addresses.push(address);
    await ref.set({
      name: profile.name || state.user.displayName || "", email: profile.email || state.user.email || "",
      phone: profile.phone || address.phone, addresses, selectedAddressId: address.id, updatedAt: Date.now(),
    }, {merge: true});
    state.profile = Object.assign({}, profile, {addresses, selectedAddressId: address.id});
  }
  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    return new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet"; css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
      js.onload = () => resolve(window.L); js.onerror = reject;
      document.head.appendChild(js);
    });
  }
  async function mountPinMap(pin) {
    const L = await loadLeaflet();
    const box = document.getElementById("pin-map");
    if (!box) return;
    const start = pin.lat ? [pin.lat, pin.lng] : [14.4426, 79.9865]; // Nellore
    const map = L.map(box).setView(start, pin.lat ? 17 : 13);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom: 19, attribution: "© OpenStreetMap"}).addTo(map);
    const marker = L.marker(start, {draggable: true}).addTo(map);
    const setPin = (latlng) => { pin.lat = latlng.lat; pin.lng = latlng.lng; marker.setLatLng(latlng); document.getElementById("pin-status").textContent = "Pin set at " + latlng.lat.toFixed(5) + ", " + latlng.lng.toFixed(5); };
    map.on("click", (e) => setPin(e.latlng));
    marker.on("dragend", () => setPin(marker.getLatLng()));
    document.getElementById("use-location").onclick = () => {
      if (!navigator.geolocation) return toast("Location isn't available in this browser.");
      navigator.geolocation.getCurrentPosition((p) => { const ll = {lat: p.coords.latitude, lng: p.coords.longitude}; setPin(ll); map.setView([ll.lat, ll.lng], 17); },
        () => toast("Allow location access, or tap the map to place the pin."), {enableHighAccuracy: true, timeout: 12000});
    };
  }

  // ---------------------------------------------------------------- checkout
  let placing = false;
  async function viewCheckout() {
    setTitle("Checkout");
    if (!state.authReady) { app.innerHTML = '<p class="s-loading">Checking your account…</p>'; return; }
    if (!requireUser("/shop/checkout")) return;
    const {store, lines, subtotal} = await cartDetails();
    if (!store || !lines.length) { go("/shop/cart", true); return; }
    if (!ORDERS_OPEN || store.sample || !store.real || !store.open) { go("/shop/cart", true); return; }
    const profile = await loadProfile();
    const addresses = (profile.addresses || []).filter((a) => Number.isFinite(Number(a.lat)) && Number.isFinite(Number(a.lng)));
    const selected = addresses.find((a) => a.id === (state.checkoutAddressId || profile.selectedAddressId)) || addresses[0] || null;
    state.checkoutAddressId = selected ? selected.id : "";
    app.innerHTML = '<div class="two-col"><div style="display:grid;gap:18px">' +
      '<section class="panel"><h2>Delivery address</h2>' +
      (addresses.length ? addresses.map((a) => '<label class="choice"><input type="radio" name="addr" value="' + h(a.id) + '"' + (selected && a.id === selected.id ? " checked" : "") + "><span><b>" + h(a.label || "Address") +
        "</b><small>" + h(a.address) + ", " + h(a.area || a.city || "") + " · " + h(a.phone || "") + "</small></span></label>").join("") : '<p style="margin:0;color:var(--muted)">Add an address with a map pin so the rider can find you.</p>') +
      '<details id="add-address"' + (addresses.length ? "" : " open") + '><summary class="btn small ghost" style="list-style:none;cursor:pointer;width:max-content">Add a new address</summary>' +
      '<form id="address-form" style="display:grid;gap:12px;margin-top:12px"><div class="row2"><div class="field"><label for="a-label">Label</label><input class="input" id="a-label" value="Home" maxlength="40"></div>' +
      '<div class="field"><label for="a-phone">Phone for the rider</label><input class="input" id="a-phone" type="tel" inputmode="tel" autocomplete="tel" required placeholder="10-digit mobile" value="' + h(profile.phone || "") + '"></div></div>' +
      '<div class="field"><label for="a-address">House / flat, street</label><input class="input" id="a-address" required maxlength="300" autocomplete="street-address"></div>' +
      '<div class="field"><label for="a-area">Area and city</label><input class="input" id="a-area" required maxlength="160" placeholder="e.g. Vedayapalem, Nellore"></div>' +
      '<div class="field"><label>Map pin</label><div class="map-box" id="pin-map"></div><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button type="button" class="btn small ghost" id="use-location">Use my current location</button><small id="pin-status" style="color:var(--muted)">Tap the map to place the pin at your door.</small></div></div>' +
      '<button class="btn" type="submit">Save address</button></form></details></section>' +
      '<section class="panel"><h2>Payment</h2><label class="choice"><input type="radio" checked name="pay" value="cod"><span><b>Cash on delivery</b><small>Pay the rider in cash or by UPI at your door.</small></span></label>' +
      '<p style="margin:0;font-size:13px;color:var(--muted)">Online payment on the website is coming soon; it is available in the app.</p>' +
      '<div class="field"><label for="instructions">Instructions for the restaurant or rider (optional)</label><input class="input" id="instructions" maxlength="300"></div></section></div>' +
      '<aside class="panel"><h2>' + h(store.name) + "</h2>" + cartLinesMarkup(store, lines) + '<div id="bill"><div class="bill-row"><span>Item total</span><span>' + rs(subtotal) + "</span></div></div>" +
      (appCheckOn ? "" : '<div class="notice warn"><div><strong>Website ordering is being switched on.</strong>You can browse and fill your cart; placing orders from the website opens shortly. Use the SCRAVEIT app to order meanwhile.</div></div>') +
      '<button class="btn block" type="button" id="place-order"' + (selected ? "" : " disabled") + ">Place order (cash on delivery)</button>" +
      '<p style="margin:0;font-size:12px;color:var(--muted)">By placing the order you agree to the <a href="/terms">Terms</a> and the <a href="/refunds">Refund &amp; cancellation policy</a>.</p></aside></div>';

    const pin = {lat: null, lng: null};
    const details = document.getElementById("add-address");
    const startMap = () => { if (!pin.mounted) { pin.mounted = true; mountPinMap(pin).catch(() => toast("The map could not load.")); } };
    if (details.open) startMap();
    details.addEventListener("toggle", () => { if (details.open) startMap(); });
    document.querySelectorAll('input[name="addr"]').forEach((r) => r.onchange = () => { state.checkoutAddressId = r.value; state.preview = null; refreshBill(store, lines); });
    document.getElementById("address-form").onsubmit = async (event) => {
      event.preventDefault();
      const phone = document.getElementById("a-phone").value.trim();
      if (phone.replace(/\D/g, "").length < 10) return toast("Enter a 10-digit phone number.");
      if (!Number.isFinite(pin.lat)) return toast("Place the map pin at your door first.");
      const address = {id: "web-" + Date.now().toString(36), label: document.getElementById("a-label").value.trim() || "Home",
        address: document.getElementById("a-address").value.trim(), area: document.getElementById("a-area").value.trim(), phone,
        lat: pin.lat, lng: pin.lng, source: "manual", updatedAt: Date.now()};
      try { await saveAddress(address); state.checkoutAddressId = address.id; toast("Address saved"); render(); } catch (e) { toast(friendly(e)); }
    };
    document.getElementById("place-order").onclick = () => placeOrder(store, lines);
    refreshBill(store, lines);
  }
  async function refreshBill(store, lines) {
    const bill = document.getElementById("bill");
    if (!bill || !state.checkoutAddressId || !appCheckOn) return;
    const items = lines.map((l) => ({itemId: l.item.id, quantity: l.quantity}));
    const key = JSON.stringify([store.id, items, state.checkoutAddressId]);
    try {
      if (state.previewKey !== key || !state.preview) {
        const config = await call("getCheckoutConfiguration", {restaurantId: store.id, items, addressId: state.checkoutAddressId, paymentMethod: "cod"});
        state.preview = config && config.checkoutPreview; state.previewKey = key;
      }
      const p = state.preview || {};
      const rowsHtml = [["Item total", p.subtotal], ["Discount", p.discount ? -p.discount : 0], ["Delivery fee", p.deliveryFee], ["Platform fee", p.platformFee],
        ["Small order fee", p.smallOrderFee], ["Late night fee", p.lateNightFee], ["Rain fee", p.rainFee], ["Taxes", p.tax]]
        .filter(([, v]) => num(v) !== 0 || v === p.subtotal).map(([l, v]) => '<div class="bill-row"><span>' + h(l) + "</span><span>" + rs(v) + "</span></div>").join("");
      bill.innerHTML = rowsHtml + '<div class="bill-row total"><span>To pay</span><span>' + rs(p.total) + "</span></div>";
    } catch (error) {
      bill.insertAdjacentHTML("beforeend", '<div class="notice bad"><div>' + h(friendly(error)) + "</div></div>");
    }
  }
  async function placeOrder(store, lines) {
    if (placing) return;
    if (!appCheckOn) return toast("Website ordering opens shortly. Please use the SCRAVEIT app for now.");
    if (!state.checkoutAddressId) return toast("Choose a delivery address.");
    placing = true;
    const button = document.getElementById("place-order");
    button.disabled = true; button.textContent = "Placing your order…";
    try {
      const idempotencyKey = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 40).padEnd(16, "0");
      const result = await call("createOrder", {
        idempotencyKey, restaurantId: store.id, items: lines.map((l) => ({itemId: l.item.id, quantity: l.quantity})),
        addressId: state.checkoutAddressId, paymentMethod: "cod", instructions: (document.getElementById("instructions").value || "").trim(),
      });
      const orderId = String(result && result.orderId || "");
      if (!orderId) throw new Error("The order could not be confirmed.");
      const otps = load(OTP_KEY, {}); if (result.deliveryOtp) otps[orderId] = String(result.deliveryOtp); save(OTP_KEY, otps);
      cart = {storeId: "", lines: {}}; persistCart();
      toast("Order placed");
      go("/shop/orders/" + encodeURIComponent(orderId), true);
    } catch (error) {
      toast(friendly(error));
      button.disabled = false; button.textContent = "Place order (cash on delivery)";
    } finally { placing = false; }
  }

  // ---------------------------------------------------------------- demo checkout (before the licence)
  // Walks through the whole purchase so the flow can be seen and inspected,
  // without placing an order, taking a payment or contacting any seller.
  const DEMO_KEY = "scraveit.web.demoOrders";
  const DEMO_FLOW = [["Order placed", "We've received your order."], ["Accepted", "The seller has accepted your order."],
    ["Preparing", "Your order is being prepared and packed."], ["Out for delivery", "Your delivery partner is on the way."], ["Delivered", "Delivered. Enjoy!"]];
  function demoBill(store, subtotal) {
    const deliveryFee = num(store.deliveryFee, store.storeType === "restaurant" ? 29 : 25);
    const platformFee = num(store.platformFee, store.storeType === "restaurant" ? 15 : 10);
    const food = store.storeType === "restaurant";
    const tax = food ? Math.round(subtotal * 0.05 * 100) / 100 : 0;
    return {subtotal, deliveryFee, platformFee, tax, taxLabel: food ? "GST on food (5%)" : "Taxes (included in MRP)",
      total: Math.round((subtotal + deliveryFee + platformFee + tax) * 100) / 100};
  }
  function demoBanner() {
    return '<div class="notice warn demo-banner"><div><strong>Demo checkout.</strong>This shows every step of ordering on SCRAVEIT. No order is placed, no payment is taken and no seller is contacted. Ordering opens once SCRAVEIT\'s FSSAI licence is issued.</div></div>';
  }
  function billMarkup(b) {
    return '<div class="bill-row"><span>Item total</span><span>' + rs(b.subtotal) + '</span></div><div class="bill-row"><span>Delivery fee</span><span>' + rs(b.deliveryFee) +
      '</span></div><div class="bill-row"><span>Platform fee</span><span>' + rs(b.platformFee) + '</span></div><div class="bill-row"><span>' + h(b.taxLabel) + "</span><span>" +
      (b.tax ? rs(b.tax) : "Included") + '</span></div><div class="bill-row total"><span>To pay</span><span>' + rs(b.total) + "</span></div>";
  }
  async function viewDemoCheckout() {
    setTitle("Demo checkout");
    const {store, lines, subtotal} = await cartDetails();
    if (!store || !lines.length) { go("/shop/cart", true); return; }
    setKindBar(store.storeType);
    const bill = demoBill(store, subtotal);
    app.innerHTML = demoBanner() + '<ol class="demo-steps" aria-label="Checkout steps"><li class="done">Cart</li><li class="now">Address &amp; payment</li><li>Confirmation</li></ol>' +
      '<div class="two-col"><form id="demo-form" style="display:grid;gap:18px">' +
      '<section class="panel"><h2>1. Delivery address</h2><div class="row2"><div class="field"><label for="d-name">Name</label><input class="input" id="d-name" value="Sample Customer" required></div>' +
      '<div class="field"><label for="d-phone">Phone</label><input class="input" id="d-phone" type="tel" value="98XXXXXX10" required></div></div>' +
      '<div class="field"><label for="d-address">House / flat, street</label><input class="input" id="d-address" value="Door 1-2-3, Sample Street" required></div>' +
      '<div class="field"><label for="d-area">Area and city</label><input class="input" id="d-area" value="Vedayapalem, Nellore" required></div>' +
      '<p style="margin:0;font-size:13px;color:var(--muted)">In a real order you also drop a map pin at your door, so the delivery partner can find you.</p></section>' +
      '<section class="panel"><h2>2. Delivery</h2><label class="choice"><input type="radio" name="d-when" checked><span><b>Deliver now</b><small>Estimated ' + h(store.etaMin + "–" + store.etaMax) + ' minutes</small></span></label>' +
      '<div class="field"><label for="d-note">Instructions for the seller or delivery partner (optional)</label><input class="input" id="d-note" placeholder="e.g. Less spicy, ring the bell"></div></section>' +
      '<section class="panel"><h2>3. Payment</h2>' +
      '<label class="choice"><input type="radio" name="d-pay" value="Cash on delivery" checked><span><b>Cash on delivery</b><small>Pay the delivery partner in cash or by UPI at your door.</small></span></label>' +
      '<label class="choice"><input type="radio" name="d-pay" value="UPI"><span><b>UPI</b><small>Pay with any UPI app through a secure payment gateway.</small></span></label>' +
      '<label class="choice"><input type="radio" name="d-pay" value="Card"><span><b>Debit / credit card</b><small>Card details are entered on the payment gateway, never stored by SCRAVEIT.</small></span></label></section>' +
      "</form>" +
      '<aside class="panel"><h2>Order summary</h2><p style="margin:0;font-size:13px;color:var(--muted)">From <b>' + h(store.name) + "</b></p>" + cartLinesMarkup(store, lines) + billMarkup(bill) +
      '<button class="btn block" type="submit" form="demo-form">Place demo order · ' + rs(bill.total) + "</button>" +
      '<p style="margin:0;font-size:12px;color:var(--muted)">In a real order, prices and fees are confirmed by SCRAVEIT\'s server before you pay. See the <a href="/refunds">Refund &amp; cancellation policy</a>.</p></aside></div>';
    document.getElementById("demo-form").onsubmit = (event) => {
      event.preventDefault();
      const id = "DEMO-" + Math.random().toString(36).slice(2, 8).toUpperCase();
      const order = {id, storeId: store.id, storeName: store.name, storeType: store.storeType, createdAt: Date.now(), bill,
        otp: String(1000 + Math.floor(Math.random() * 9000)),
        payment: (document.querySelector('input[name="d-pay"]:checked') || {}).value || "Cash on delivery",
        address: document.getElementById("d-address").value + ", " + document.getElementById("d-area").value,
        lines: lines.map((l) => ({name: l.item.name, quantity: l.quantity, price: l.item.price, diet: l.item.diet}))};
      const orders = load(DEMO_KEY, []); orders.unshift(order); save(DEMO_KEY, orders.slice(0, 10));
      cart = {storeId: "", lines: {}}; persistCart();
      go("/shop/demo-order/" + id, true);
    };
  }
  let demoTimer = 0;
  function viewDemoOrder(id) {
    setTitle("Demo order " + id);
    clearInterval(demoTimer);
    const order = load(DEMO_KEY, []).find((o) => o.id === id);
    if (!order) { app.innerHTML = '<p class="s-empty">This demo order is not on this device. <a href="/shop">Back to the shop</a></p>'; return; }
    setKindBar(order.storeType);
    const paint = () => {
      if (!location.pathname.startsWith("/shop/demo-order/")) { clearInterval(demoTimer); return; }
      const step = Math.min(DEMO_FLOW.length - 1, Math.floor((Date.now() - order.createdAt) / 5000));
      app.innerHTML = demoBanner() + '<ol class="demo-steps"><li class="done">Cart</li><li class="done">Address &amp; payment</li><li class="now">Confirmation</li></ol>' +
        '<div class="two-col"><section class="panel"><p class="eyebrow">Demo order ' + h(order.id) + "</p><h2>" + h(DEMO_FLOW[step][0]) + '</h2><p style="margin:0">' + h(DEMO_FLOW[step][1]) + "</p>" +
        '<ol class="timeline">' + DEMO_FLOW.map(([label], i) => '<li class="' + (i < step ? "done" : i === step ? "now" : "") + '"><span></span>' + h(label) + "</li>").join("") + "</ol>" +
        (step < DEMO_FLOW.length - 1 ? '<div class="notice info"><div><strong>Delivery code</strong>In a real order you share this only at your door, after receiving the complete order.<div class="otp">' + h(order.otp) + "</div></div></div>" : "") +
        '<p style="margin:0;font-size:13px;color:var(--muted)">Deliver to: ' + h(order.address) + " · " + h(order.payment) + '</p><p style="margin:0;font-size:13px;color:var(--muted)">This timeline advances on its own to show each stage. For a real order the SCRAVEIT app also shows the delivery partner live on a map.</p></section>' +
        '<aside class="panel"><h2>' + h(order.storeName) + "</h2>" + order.lines.map((l) => '<div class="bill-row"><span>' + h(l.quantity) + " × " + h(l.name) + "</span><span>" + rs(l.price * l.quantity) + "</span></div>").join("") +
        billMarkup(order.bill) + '<div style="display:flex;gap:10px;flex-wrap:wrap"><a class="btn ghost small" href="/shop">Back to the shop</a><a class="btn ghost small" href="/grievance">Help with an order</a></div></aside></div>';
      if (step >= DEMO_FLOW.length - 1) clearInterval(demoTimer);
    };
    paint();
    demoTimer = setInterval(paint, 1000);
  }

  // ---------------------------------------------------------------- orders
  let orderUnsub = null;
  async function viewOrders() {
    setTitle("My orders");
    if (!ORDERS_OPEN) {
      const demos = load(DEMO_KEY, []);
      app.innerHTML = '<h1 style="font-size:32px;margin-bottom:12px">My orders</h1>' + demoBanner() + (demos.length ? '<div style="display:grid;gap:12px;margin-top:14px">' + demos.map((o) =>
        '<a class="order-card" style="text-decoration:none" href="/shop/demo-order/' + encodeURIComponent(o.id) + '"><div class="order-top"><strong>' + h(o.storeName) + "</strong><span>" + rs(o.bill.total) +
        '</span></div><div class="store-meta"><span>Demo order ' + h(o.id) + "</span><span>" + new Date(o.createdAt).toLocaleString("en-IN", {dateStyle: "medium", timeStyle: "short"}) + "</span></div></a>").join("") + "</div>"
        : '<p class="s-empty">No demo orders yet. Add something to your cart and try the demo checkout.</p>');
      return;
    }
    if (!state.authReady) { app.innerHTML = '<p class="s-loading">Checking your account…</p>'; return; }
    if (!requireUser("/shop/orders")) return;
    app.innerHTML = '<p class="s-loading">Loading your orders…</p>';
    const snap = await db.collection("orders").where("customerId", "==", state.user.uid).limit(50).get();
    const orders = snap.docs.map((d) => Object.assign({id: d.id}, d.data())).sort((a, b) => num(b.createdAt) - num(a.createdAt));
    app.innerHTML = '<h1 style="font-size:32px;margin-bottom:18px">My orders</h1>' + (orders.length ? '<div style="display:grid;gap:12px">' + orders.map((o) =>
      '<a class="order-card" style="text-decoration:none" href="/shop/orders/' + encodeURIComponent(o.id) + '"><div class="order-top"><strong>' + h(o.restaurant || "Order") + "</strong><span>" + rs(o.total) +
      '</span></div><div class="store-meta"><span>' + h(o.status) + "</span><span>" + new Date(num(o.createdAt)).toLocaleString("en-IN", {dateStyle: "medium", timeStyle: "short"}) + "</span><span>" + h(o.id) + "</span></div></a>").join("") + "</div>"
      : '<p class="s-empty">No orders yet. <a href="/shop">Start shopping</a></p>');
  }
  async function viewOrder(orderId) {
    setTitle("Order " + orderId);
    if (!state.authReady) { app.innerHTML = '<p class="s-loading">Checking your account…</p>'; return; }
    if (!requireUser("/shop/orders/" + orderId)) return;
    if (orderUnsub) orderUnsub();
    app.innerHTML = '<p class="s-loading">Loading your order…</p>';
    orderUnsub = db.collection("orders").doc(orderId).onSnapshot((doc) => {
      if (!location.pathname.startsWith("/shop/orders/")) { orderUnsub && orderUnsub(); return; }
      if (!doc.exists) { app.innerHTML = '<p class="s-empty">Order not found.</p>'; return; }
      const o = doc.data(), otp = load(OTP_KEY, {})[orderId];
      const reached = Math.max(0, STATUS_FLOW.indexOf(o.status));
      const items = Array.isArray(o.items) ? o.items : [];
      const p = o.pricing || {};
      app.innerHTML = '<nav class="crumbs"><a href="/shop/orders">My orders</a><span>/</span><span>' + h(orderId) + "</span></nav>" +
        '<div class="two-col"><section class="panel"><p class="eyebrow">Order ' + h(orderId) + "</p><h2>" + h(o.status === "Cancelled" ? "This order was cancelled" : o.status) + "</h2>" +
        (o.status === "Cancelled" ? "" : '<div class="status-steps">' + STATUS_FLOW.filter((s) => !["Assigned", "Handed to rider", "Near you", "Arrived"].includes(s))
          .map((s) => '<span class="' + (STATUS_FLOW.indexOf(s) <= reached ? "done" : "") + '">' + h(s) + "</span>").join("") + "</div>") +
        (otp && !["Delivered", "Cancelled"].includes(o.status) ? '<div class="notice info"><div><strong>Delivery code</strong>Share only at your door after you receive the full order.<div class="otp">' + h(otp) + "</div></div></div>" : "") +
        (o.riderName ? "<p style=\"margin:0\">Delivery partner: <b>" + h(o.riderName) + "</b></p>" : "") +
        '<p style="margin:0;font-size:13px;color:var(--muted)">For live map tracking, open this order in the SCRAVEIT app.</p></section>' +
        '<aside class="panel"><h2>' + h(o.restaurant || "") + "</h2>" + items.map((i) => '<div class="bill-row"><span>' + h(i.quantity) + " × " + h(i.name) + "</span><span>" + rs(num(i.price) * num(i.quantity)) + "</span></div>").join("") +
        [["Delivery fee", p.deliveryFee], ["Platform fee", p.platformFee], ["Taxes", p.tax], ["Discount", p.discount ? -p.discount : 0]].filter(([, v]) => num(v) !== 0)
          .map(([l, v]) => '<div class="bill-row"><span>' + h(l) + "</span><span>" + rs(v) + "</span></div>").join("") +
        '<div class="bill-row total"><span>Total</span><span>' + rs(o.total) + '</span></div><p style="margin:0;font-size:13px;color:var(--muted)">' + h(o.paymentMethod === "cod" ? "Cash on delivery" : "Paid online") + "</p>" +
        '<a class="btn ghost small" href="/grievance">Need help with this order?</a></aside></div>';
    }, (error) => { app.innerHTML = '<div class="notice bad"><div>' + h(friendly(error)) + "</div></div>"; });
  }

  // Bottom bar: Restaurants · Groceries · Dairy.
  function setKindBar(kind) {
    document.querySelectorAll("#kind-bar a").forEach((a) => {
      const on = a.dataset.kind === kind;
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
  }

  // ---------------------------------------------------------------- boot
  document.getElementById("footer-legal").innerHTML = h((CFG.company || {}).legalName || "SCRAVEIT PRIVATE LIMITED") + " · CIN " + h((CFG.company || {}).cin || "") + " · Registered office: " + h((CFG.company || {}).address || "") +
    '<br><b>FSSAI:</b> ' + h((CFG.company || {}).fssaiStatus || "") + ' · Grievance officer: <a href="/grievance">details</a> · © ' + new Date().getFullYear() + " SCRAVEIT PRIVATE LIMITED";
  persistCart();
  if (auth) {
    auth.onAuthStateChanged((user) => {
      state.user = user; state.authReady = true; state.profile = null;
      const link = document.getElementById("account-link");
      link.textContent = user ? "Account" : "Sign in";
      render();
    });
  } else {
    state.authReady = true;
    render();
  }
})();
