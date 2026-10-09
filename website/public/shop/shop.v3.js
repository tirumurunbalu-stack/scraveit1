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
      pureVeg: r.pureVeg === true, sellerFssai: r.fssaiNumber || r.fssaiLicence || r.fssaiLicenseNumber || "", sample: !ORDERS_OPEN,
      deliveryFee: num(r.deliveryFee, 29), platformFee: num(r.platformFee, 15),
      embeddedMenu: Array.isArray(r.menu) ? r.menu : [],
    };
  }
  // Internal test stores (app review accounts, the founder's own test sign-ups) stay off the public website.
  const HIDDEN_STORES = new Set((CFG.hiddenStoreIds || []).map(String));
  // When set, only these onboarded stores appear on the website (the rest are still being set up).
  const VISIBLE_STORES = Array.isArray(CFG.visibleStoreIds) ? new Set(CFG.visibleStoreIds.map(String)) : null;
  async function loadStores() {
    if (state.stores) return state.stores;
    const stores = [];
    try {
      const snapshot = await db.collection("restaurants").get();
      snapshot.forEach((doc) => {
        const r = doc.data() || {};
        if (r.archived === true || r.active === false || HIDDEN_STORES.has(doc.id)) return;
        if (VISIBLE_STORES && !VISIBLE_STORES.has(doc.id)) return;
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
      if (!(CFG.curatedMenus !== false && SAMPLE_MENUS[store.id])) try {
        const snapshot = await db.collection("menus").doc(store.id).collection("items").get();
        snapshot.forEach((doc) => items.push(Object.assign({id: doc.id}, doc.data())));
      } catch (error) { console.warn("MENU_LOAD_FAILED", error); }
      // Before launch the website shows a short, fully detailed sample menu for each restaurant.
      if (CFG.curatedMenus !== false && SAMPLE_MENUS[store.id]) items = SAMPLE_MENUS[store.id].map((i) => Object.assign({}, i));
      if (!items.length) items = store.embeddedMenu.map((item, i) => Object.assign({id: String(item.id || i)}, item));
      if (!items.length && SAMPLE_MENUS[store.id]) items = SAMPLE_MENUS[store.id].map((i) => Object.assign({}, i));
      items = items.filter((i) => i.archived !== true && String(i.name || "").trim().length >= 3)
        .map((i) => Object.assign({}, i, {price: num(i.price), sample: i.sample === true || store.sample === true}));
    } else {
      items = (store.items || []).map((i) => Object.assign({}, i));
    }
    // Packaged goods are never sold above the MRP printed on the pack.
    items.forEach((i) => { const mrp = num(i.compliance && i.compliance.mrp); if (mrp > 0 && num(i.price) > mrp) i.price = mrp; });
    if (!(store.real && CFG.curatedMenus !== false && SAMPLE_MENUS[store.id]) && store.real) items.sort((a, b) => String(a.category || "").localeCompare(String(b.category || "")) || String(a.name).localeCompare(String(b.name)));
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
    if (parts[1] !== "item") { state.openDish = null; document.body.classList.remove("modal-open"); }
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
      '<div class="store-meta"><span>' + h(((window.SCRAVEIT_RESTAURANT_INFO || {})[store.id] || {}).cuisines || store.tagline || "") + "</span></div>" +
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
  const RESTAURANT_INFO = window.SCRAVEIT_RESTAURANT_INFO || {};
  const PHOTO_CREDITS = window.SCRAVEIT_PHOTO_CREDITS || {};
  const itemHref = (store, item) => "/shop/item/" + encodeURIComponent(store.id) + "/" + encodeURIComponent(item.id);
  const fssaiNo = (value) => /^[12]\d{13}$/.test(String(value || "")) ? String(value) : "";
  function photoCredit(item) {
    const c = PHOTO_CREDITS[item.photo];
    return c ? '<p class="photo-credit">Photo for representation: ' + h(c.a) + ', <a href="' + h(c.s) + '" target="_blank" rel="noopener">' + h(c.l) + "</a>, via Wikimedia Commons</p>" : "";
  }
  function stepperFor(store, item, big) {
    const q = cart.storeId === store.id ? num(cart.lines[item.id]) : 0;
    const cls = big ? " big" : "";
    if (item.available === false) return '<span class="pill closed">Unavailable</span>';
    return q ? '<div class="stepper' + cls + '"><button type="button" data-cart="-1" data-store="' + h(store.id) + '" data-item="' + h(item.id) + '" aria-label="Remove one ' + h(item.name) + '">−</button><span>' + q +
      '</span><button type="button" data-cart="1" data-store="' + h(store.id) + '" data-item="' + h(item.id) + '" aria-label="Add one more ' + h(item.name) + '">+</button></div>'
      : '<button type="button" class="add-btn' + cls + '" data-cart="1" data-store="' + h(store.id) + '" data-item="' + h(item.id) + '" aria-label="Add ' + h(item.name) + '">ADD</button>';
  }
  function sampleNotice(store) {
    return store.sample ? '<div class="notice warn"><div><strong>Sample listing.</strong>' + (store.storeType === "restaurant" ?
      "The dishes, prices and food details on this page are examples shown before launch. Ordering opens once SCRAVEIT's FSSAI licence is issued." :
      "This store and its products show how " + h(KIND_LABEL[store.storeType].toLowerCase()) + " partners will appear on SCRAVEIT. Products and label values are examples, not real products. Ordering opens once SCRAVEIT's FSSAI licence is issued.") + "</div></div>" : "";
  }
  async function viewStore(id) {
    await loadStores();
    const store = storeById(id);
    if (!store) { app.innerHTML = '<p class="s-empty">This store is not available. <a href="/shop">Back to the shop</a></p>'; return; }
    setTitle(store.name);
    setKindBar(store.storeType);
    if (!state.menus[store.id]) app.innerHTML = '<p class="s-loading">Loading ' + h(store.name) + "…</p>";
    const items = await loadMenu(store);
    if (store.storeType === "restaurant") return restaurantPage(store, items);
    return goodsStorePage(store, items);
  }

  // Restaurant menu, laid out the way customers know from food apps: dishes by
  // section, each with its veg / non-veg mark, price, serving size, energy and
  // allergens; tapping a dish opens its full details. The restaurant's FSSAI
  // licence and address close the page.
  function dishRow(store, item) {
    const kcal = num(item.calories) ? num(item.calories) + " kcal" : "";
    return '<article class="dish" data-diet="' + h(item.diet || "veg") + '" data-name="' + h(String(item.name).toLowerCase()) + '">' +
      '<div class="dish-text">' + dietMark(item.diet) +
      '<h3><a href="' + itemHref(store, item) + '" data-open-dish="' + h(item.id) + '">' + h(item.name) + "</a></h3>" +
      '<div class="dish-price">' + rs(item.price) + "</div>" +
      '<p class="dish-desc">' + h([item.servingSize, item.description].filter(Boolean).join(" | ")) + "</p>" +
      '<p class="dish-facts">' + [kcal, item.allergens && !/^none/i.test(item.allergens) ? item.allergens : ""].filter(Boolean).map(h).join(" · ") + "</p></div>" +
      '<div class="dish-media">' + (item.imageUrl ? '<button type="button" class="dish-photo" data-open-dish="' + h(item.id) + '" aria-label="View details of ' + h(item.name) + '"><img src="' + h(item.imageUrl) + '" alt=""></button>' : "") +
      '<div class="dish-add">' + stepperFor(store, item) + "</div></div></article>";
  }
  function dishModal(store, item) {
    const row = (label, value) => value ? "<dt>" + h(label) + "</dt><dd>" + h(value) + "</dd>" : "";
    return '<div class="modal-backdrop" data-close-dish="1"><div class="dish-modal" role="dialog" aria-modal="true" aria-labelledby="dish-modal-title">' +
      '<button type="button" class="modal-close" data-close-dish="1" aria-label="Close">×</button>' +
      (item.imageUrl ? '<img class="dish-modal-photo" src="' + h(item.imageUrl) + '" alt="' + h(item.name) + '">' : "") +
      '<div class="dish-modal-body"><div class="dish-modal-head"><div>' + dietMark(item.diet) + '<h2 id="dish-modal-title">' + h(item.name) + "</h2>" +
      '<div class="dish-price">' + rs(item.price) + "</div></div>" + stepperFor(store, item, true) + "</div>" +
      (item.description ? '<p class="dish-desc">' + h(item.description) + "</p>" : "") +
      '<dl class="facts">' + row("Serving size", item.servingSize) + row("Energy", num(item.calories) ? num(item.calories) + " kcal per serving" : "") +
      row("Veg / non-veg", String(item.diet || "veg") === "veg" ? "Vegetarian" : "Non-vegetarian") +
      row("Ingredients", item.ingredients) + row("Allergens", item.allergens) + row("Preparation time", item.preparationTime ? item.preparationTime + " min" : "") +
      row("Prepared by", store.name + (fssaiNo(store.sellerFssai) ? " · FSSAI Lic. No. " + store.sellerFssai : "")) + "</dl>" +
      '<p class="fine">Nutritional information is indicative, per serve, as shared by the restaurant. An average active adult requires 2,000 kcal energy per day; however, calorie needs may vary.</p>' +
      photoCredit(item) + "</div></div></div>";
  }
  function restaurantPage(store, items) {
    const info = RESTAURANT_INFO[store.id] || {};
    const groups = [];
    const recommended = items.filter((i) => i.recommended);
    if (recommended.length) groups.push(["Recommended", recommended]);
    items.forEach((i) => { const k = i.category || "Menu"; let g = groups.find(([name]) => name === k); if (!g) groups.push(g = [k, []]); g[1].push(i); });
    const anyVeg = items.some((i) => String(i.diet || "veg") === "veg"), anyNonVeg = items.some((i) => String(i.diet) === "nonveg");
    const lic = fssaiNo(store.sellerFssai);
    const open = state.openDish && state.openDish.storeId === store.id ? items.find((i) => i.id === state.openDish.itemId) : null;
    app.innerHTML =
      '<div class="r-page"><nav class="crumbs" aria-label="Breadcrumb"><a href="/shop">Home</a><span>/</span><a href="/shop?type=restaurant">Restaurants</a><span>/</span><span>' + h(store.name) + "</span></nav>" +
      '<h1 class="r-title">' + h(store.name) + "</h1>" +
      '<section class="r-card">' + (store.image ? '<img class="r-cover" src="' + h(store.image) + '" alt="">' : "") +
      '<div class="r-card-body"><p class="r-line"><span class="r-new">New on SCRAVEIT</span>' + (info.priceForTwo ? " · " + rs(info.priceForTwo) + " for two" : "") + "</p>" +
      '<p class="r-cuisines">' + h(info.cuisines || store.tagline || "") + "</p>" +
      (info.opens ? '<p class="r-hours">Opens ' + h(info.opens) + " · Closes " + h(info.closes) + "</p>" : "") +
      '<div class="r-timeline"><p><b>Outlet</b> ' + h(info.area || store.city || "") + "</p><p><b>" + h(store.etaMin + "–" + store.etaMax + " mins") + "</b></p></div></div></section>" +
      sampleNotice(store) +
      '<div class="r-tools"><label class="r-search"><span class="sr-only">Search for dishes</span><input type="search" id="dish-search" placeholder="Search for dishes" autocomplete="off"></label>' +
      '<div class="r-chips">' + (anyVeg && anyNonVeg ? '<button type="button" class="chip" data-diet-filter="veg" aria-pressed="false">' + dietMark("veg") + "Veg</button>" +
        '<button type="button" class="chip" data-diet-filter="nonveg" aria-pressed="false">' + dietMark("nonveg") + "Non-veg</button>" : (anyVeg ? '<span class="chip static">' + dietMark("veg") + "Pure veg</span>" : "")) + "</div></div>" +
      (!items.length ? '<p class="s-empty">No dishes listed yet.</p>' : groups.map(([name, list]) =>
        '<details class="r-section" open><summary><h2>' + h(name) + " (" + list.length + ")</h2></summary>" + list.map((i) => dishRow(store, i)).join("") + "</details>").join("")) +
      '<section class="r-legal"><h2>Disclaimer</h2><ul><li>All prices are set directly by the restaurant.</li>' +
      "<li>All nutritional information is indicative; values are per serve as shared by the restaurant and may vary depending on the ingredients and portion size.</li>" +
      "<li>An average active adult requires 2,000 kcal energy per day; however, calorie needs may vary.</li>" +
      "<li>Dish photos are for representation only.</li></ul>" +
      '<div class="r-fssai"><img class="fssai-logo" src="/img/fssai-logo-grey.png" alt="FSSAI" width="53" height="26" style="width:53px;height:26px"><span>' + (lic ? "Licence No. " + h(lic) : "Licence No. will be shown here when the restaurant goes live") + "</span></div>" +
      '<p class="r-legal-name">' + h(store.name) + "</p><p>" + h(info.area || store.city || "") + "</p>" +
      (store.address ? '<p class="r-address">' + h(store.address) + "</p>" : "") + "</section></div>" +
      (open ? dishModal(store, open) : "");
    if (open) document.body.classList.add("modal-open"); else document.body.classList.remove("modal-open");
  }
  document.addEventListener("click", (event) => {
    const opener = event.target.closest("[data-open-dish]");
    if (opener) {
      event.preventDefault(); event.stopPropagation();
      const storeId = decodeURIComponent((location.pathname.split("/")[3] || ""));
      state.openDish = {storeId, itemId: opener.dataset.openDish};
      history.pushState({}, "", "/shop/item/" + encodeURIComponent(storeId) + "/" + encodeURIComponent(opener.dataset.openDish));
      render();
      return;
    }
    const closer = event.target.closest("[data-close-dish]");
    if (closer && (closer.classList.contains("modal-close") || event.target === closer)) closeDish();
    const chip = event.target.closest("[data-diet-filter]");
    if (chip) {
      const on = chip.getAttribute("aria-pressed") !== "true";
      document.querySelectorAll("[data-diet-filter]").forEach((c) => c.setAttribute("aria-pressed", "false"));
      chip.setAttribute("aria-pressed", String(on));
      filterDishes();
    }
  }, true);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && state.openDish) closeDish(); });
  document.addEventListener("input", (event) => { if (event.target.id === "dish-search") filterDishes(); });
  function closeDish() {
    const storeId = state.openDish && state.openDish.storeId;
    state.openDish = null;
    document.body.classList.remove("modal-open");
    if (storeId) { history.pushState({}, "", "/shop/store/" + encodeURIComponent(storeId)); render(); }
  }
  function filterDishes() {
    const q = String((document.getElementById("dish-search") || {}).value || "").trim().toLowerCase();
    const pressed = document.querySelector('[data-diet-filter][aria-pressed="true"]');
    const diet = pressed ? pressed.dataset.dietFilter : "";
    document.querySelectorAll(".r-section").forEach((section) => {
      let shown = 0;
      section.querySelectorAll(".dish").forEach((d) => {
        const ok = (!q || d.dataset.name.includes(q)) && (!diet || d.dataset.diet === diet);
        d.hidden = !ok; if (ok) shown++;
      });
      section.hidden = !shown;
    });
  }

  // Grocery and dairy: product cards like a quick-commerce shelf, and a product
  // page with the principal display panel and every label particular.
  const offPercent = (item) => { const mrp = num(item.compliance && item.compliance.mrp); return mrp > item.price ? Math.round((1 - item.price / mrp) * 100) : 0; };
  function productCard(store, item) {
    const c = item.compliance || {}, off = offPercent(item);
    return '<article class="p-card"><a class="p-media" href="' + itemHref(store, item) + '">' + packSvg(item) +
      (off ? '<span class="p-off">' + off + "% OFF</span>" : "") + "</a>" +
      '<div class="p-body"><span class="p-eta">' + h(store.etaMin) + " MINS</span>" +
      '<h3><a href="' + itemHref(store, item) + '">' + h(item.name) + "</a></h3>" + (item.category ? '<p class="p-cat">' + h(item.category) + "</p>" : "") +
      '<p class="p-qty">' + h(c.netQuantity || "") + "</p>" +
      '<div class="p-foot"><div class="p-price"><b>' + rs(item.price) + "</b>" + (num(c.mrp) > item.price ? "<s>" + rs(c.mrp) + "</s>" : "") + "</div>" + stepperFor(store, item) + "</div></div></article>";
  }
  function goodsStorePage(store, items) {
    // Category tiles like a quick-commerce shelf; tapping one shows only its products.
    const cats = [];
    items.forEach((i) => { const k = i.category || "Products"; let c = cats.find((x) => x.name === k); if (!c) cats.push(c = {name: k, items: []}); c.items.push(i); });
    app.innerHTML =
      '<nav class="crumbs" aria-label="Breadcrumb"><a href="/shop">Home</a><span>/</span><a href="/shop?type=' + store.storeType + '">' + h(KIND_TABS.find(([k]) => k === store.storeType)[1]) + "</a><span>/</span><span>" + h(store.name) + "</span></nav>" +
      '<section class="g-head"><div><h1>' + h(store.name) + "</h1><p>" + h(store.tagline || "") + '</p><p class="g-eta">Delivery in ' + h(store.etaMin + "–" + store.etaMax) + " mins</p></div>" +
      '<div class="seller-box"><b>Seller</b><br>' + h(store.name) + (store.address ? "<br>" + h(store.address) : "") +
      "<br><b>Seller FSSAI licence:</b> " + (fssaiNo(store.sellerFssai) ? h(store.sellerFssai) : "<i>" + h(store.sellerFssai || "Shown here once provided by the seller") + "</i>") + "</div></section>" +
      sampleNotice(store) +
      '<h2 class="g-cats-title">Shop by category</h2><div class="g-cats" role="tablist" aria-label="Categories">' +
      cats.map((c) => '<button type="button" class="g-cat" role="tab" aria-selected="false" data-goods-cat="' + h(c.name) + '"><span class="g-cat-img">' + packSvg(c.items[0]) + "</span><span>" + h(c.name) + "</span></button>").join("") + "</div>" +
      '<section class="menu-section"><h2 id="g-shelf-title">All products (' + items.length + ')</h2><div class="p-grid">' +
      items.map((i) => productCard(store, i).replace('<article class="p-card"', '<article class="p-card" data-cat="' + h(i.category || "Products") + '"')).join("") + "</div></section>" +
      goodsDisclaimer(store);
  }
  document.addEventListener("click", (event) => {
    const tile = event.target.closest("[data-goods-cat]");
    if (!tile) return;
    const on = tile.getAttribute("aria-selected") !== "true", cat = tile.dataset.goodsCat;
    document.querySelectorAll("[data-goods-cat]").forEach((t) => t.setAttribute("aria-selected", String(on && t === tile)));
    let shown = 0;
    document.querySelectorAll(".p-card[data-cat]").forEach((card) => { const ok = !on || card.dataset.cat === cat; card.hidden = !ok; if (ok) shown++; });
    const title = document.getElementById("g-shelf-title");
    if (title) title.textContent = (on ? cat : "All products") + " (" + shown + ")";
  });
  function goodsDisclaimer(store) {
    const lic = store && fssaiNo(store.sellerFssai);
    return '<section class="g-disclaimer"><h2>Disclaimer</h2><p>All images are for representation. Product details are as declared on the label by the manufacturer. Please read the batch number, dates of manufacture and expiry, directions for use and allergen and nutrition information on the delivered pack before use. Packaged food is delivered with at least 30% of its shelf life, or 45 days, remaining. Report a concern on the <a href="/grievance">grievance page</a>.</p>' +
      (store ? '<div class="r-fssai"><img class="fssai-logo" src="/img/fssai-logo-grey.png" alt="FSSAI" width="53" height="26" style="width:53px;height:26px"><span>' +
        (lic ? "Licence No. " + h(lic) : "Licence No. will be shown here when the store goes live") + "</span></div>" +
        '<p class="r-legal-name">' + h(store.name) + "</p>" + (store.address ? '<p class="r-address">' + h(store.address) + "</p>" : "") : "") + "</section>";
  }
  function nutritionTable(n) {
    if (!n) return "";
    const rows = [["Energy", n.energyKcal, "kcal"], ["Protein", n.proteinG, "g"], ["Carbohydrate", n.carbohydrateG, "g"], ["  of which total sugars", n.totalSugarsG, "g"],
      ["  of which added sugars", n.addedSugarsG, "g"], ["Total fat", n.fatG, "g"], ["  of which saturated fat", n.saturatedFatG, "g"], ["  of which trans fat", n.transFatG, "g"], ["Sodium", n.sodiumMg, "mg"]];
    return '<table class="nutrition"><thead><tr><th>Nutrition information</th><th>Per ' + h(n.per || "100 g") + "</th></tr></thead><tbody>" +
      rows.map(([l, v, u]) => "<tr><td>" + h(l.trim()).replace(/^of which/, "&nbsp;&nbsp;of which") + "</td><td>" + (v == null ? "—" : h(v) + " " + u) + "</td></tr>").join("") + "</tbody></table>";
  }
  function factRow(label, value, pendingText) {
    const has = value !== undefined && value !== null && String(value).trim() !== "";
    return "<dt>" + h(label) + "</dt><dd" + (has ? "" : ' class="pending"') + ">" + (has ? value : h(pendingText || "To be provided by the seller")) + "</dd>";
  }
  // FSSAI order of 18.03.2026, Annexure 1 item 3: a legible, clear picture of
  // the principal display panel of every pre-packed product. Real listings use
  // the seller's photo of the pack front (compliance.pdpImageUrl); sample
  // listings get a drawn pack whose front carries the declared values.
  function svgText(value) { return String(value == null ? "" : value).replace(/[&<>"]/g, (m) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[m])); }
  function packSvg(item) {
    const c = item.compliance || {};
    if (c.pdpImageUrl) return '<img src="' + h(c.pdpImageUrl) + '" alt="Front of pack: ' + h(item.name) + '">';
    const p = packShape(item, "f"), veg = String(item.diet || "veg") === "veg", mark = veg ? "#1b8a3a" : "#8a3a1b";
    const name = String(item.name), words = name.split(" "), mid = Math.ceil(words.length / 2);
    const lines = name.length > 14 ? [words.slice(0, mid).join(" "), words.slice(mid).join(" ")] : [name];
    const size = Math.max(16, Math.min(30, Math.floor(300 / Math.max(...lines.map((l) => l.length)))));
    const lic = /^\d{14}$/.test(String(c.manufacturerFssai || "")) ? c.manufacturerFssai : "1XXXXXXXXXXXXX";
    const cx = 200, top = p.inner[1];
    return '<svg viewBox="0 0 400 310" role="img" aria-label="Front of pack: ' + svgText(name) + ", " + svgText(c.netQuantity || "") + '" class="pack" font-family="Helvetica,Arial,sans-serif">' +
      p.defs + '<rect width="400" height="310" fill="#f4f2ee"/><ellipse cx="200" cy="296" rx="150" ry="9" fill="#000" opacity=".12"/>' + p.body +
      '<text x="' + cx + '" y="' + (top + 22) + '" text-anchor="middle" font-family="Georgia,serif" font-size="15" font-weight="700" fill="#fff" letter-spacing="1">' + svgText(String(c.brand || "Brand").toUpperCase()) + "</text>" +
      '<rect x="' + (p.inner[0] + p.inner[2] - 26) + '" y="' + (top + 8) + '" width="18" height="18" fill="#fff" stroke="' + mark + '" stroke-width="2"/>' +
      (veg ? '<circle cx="' + (p.inner[0] + p.inner[2] - 17) + '" cy="' + (top + 17) + '" r="5" fill="' + mark + '"/>' : '<path d="M' + (p.inner[0] + p.inner[2] - 17) + " " + (top + 11) + " l6 11 h-12 Z\" fill=\"" + mark + '"/>') +
      '<circle cx="' + cx + '" cy="' + (top + 74) + '" r="36" fill="#fff" opacity=".95"/>' + packIcon(item.icon, cx, top + 74, item.packColor || "#8a5a2b") +
      lines.map((l, i) => '<text x="' + cx + '" y="' + (top + 140 + i * (size + 2)) + '" text-anchor="middle" font-family="Georgia,serif" font-size="' + size + '" font-weight="700" fill="#fff">' + svgText(l) + "</text>").join("") +
      '<rect x="' + (cx - 46) + '" y="' + (p.inner[1] + p.inner[3] - 46) + '" width="92" height="26" rx="13" fill="#fff"/>' +
      '<text x="' + cx + '" y="' + (p.inner[1] + p.inner[3] - 28) + '" text-anchor="middle" font-size="13" font-weight="700" fill="#22190f">' + svgText(String(c.netQuantity || "").replace(/\s*\(.*\)/, "")) + "</text>" +
      '<image href="/img/fssai-logo-white.png" x="' + (p.inner[0] + 6) + '" y="' + (p.inner[1] + p.inner[3] - 19) + '" width="28" height="13.7"/>' +
      '<text x="' + (p.inner[0] + 37) + '" y="' + (p.inner[1] + p.inner[3] - 8) + '" font-size="8" fill="#fff">Lic. No. ' + svgText(lic) + "</text>" +
      (c.sampleValues ? '<text x="' + (p.inner[0] + p.inner[2] - 6) + '" y="' + (p.inner[1] + p.inner[3] - 8) + '" text-anchor="end" font-size="7.5" fill="#fff" opacity=".9">SAMPLE PACK</text>' : "") +
      "</svg>";
  }
  // Pack silhouettes with a little shading so they read as real packets.
  function packShape(item, side) {
    const col = item.packColor || "#8a5a2b", gid = "pk-" + side + "-" + String(item.id).replace(/[^a-z0-9]/gi, "");
    const defs = '<defs><linearGradient id="' + gid + '" x1="0" x2="1"><stop offset="0" stop-color="' + col + '" stop-opacity=".82"/><stop offset=".45" stop-color="' + col + '"/>' +
      '<stop offset="1" stop-color="#000" stop-opacity=".35"/></linearGradient><linearGradient id="' + gid + 's" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/>' +
      '<stop offset=".5" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>';
    const f = "url(#" + gid + ")", shine = "url(#" + gid + "s)";
    const shapes = {
      pouch: {d: '<path d="M96 30 Q200 16 304 30 L318 284 Q200 298 82 284 Z" fill="' + f + '"/><path d="M96 30 Q200 16 304 30 L305 44 Q200 31 95 44 Z" fill="#000" opacity=".18"/><path d="M130 40 L170 40 L150 280 L110 280 Z" fill="' + shine + '"/>', inner: [104, 48, 192, 228]},
      sachet: {d: '<path d="M92 34 L308 34 L318 282 L82 282 Z" fill="' + f + '"/><path d="M92 34 L308 34 L309 50 L91 50 Z" fill="#000" opacity=".18"/><path d="M82 266 L318 266 L318 282 L82 282 Z" fill="#000" opacity=".18"/><path d="M124 52 L160 52 L146 264 L110 264 Z" fill="' + shine + '"/>', inner: [100, 52, 200, 214]},
      box: {d: '<rect x="92" y="40" width="216" height="244" rx="6" fill="' + f + '"/><path d="M92 40 L118 22 L334 22 L308 40 Z" fill="' + item.packColor + '" opacity=".7"/><path d="M308 40 L334 22 L334 266 L308 284 Z" fill="#000" opacity=".28"/><rect x="112" y="40" width="34" height="244" fill="' + shine + '"/>', inner: [100, 46, 200, 232]},
      jar: {d: '<rect x="118" y="16" width="164" height="30" rx="8" fill="#3b2f22"/><rect x="118" y="24" width="164" height="4" fill="#fff" opacity=".15"/><rect x="92" y="44" width="216" height="244" rx="34" fill="' + f + '"/><rect x="116" y="60" width="30" height="214" rx="14" fill="' + shine + '"/>', inner: [104, 52, 192, 228]},
      tub: {d: '<path d="M84 46 L316 46 L298 286 L102 286 Z" fill="' + f + '"/><rect x="76" y="30" width="248" height="22" rx="6" fill="#e9e5df"/><rect x="76" y="46" width="248" height="6" fill="#000" opacity=".12"/><path d="M110 56 L140 56 L150 280 L124 280 Z" fill="' + shine + '"/>', inner: [104, 54, 192, 224]},
    };
    const s = shapes[item.pack] || shapes.box;
    return {defs, body: s.d, inner: s.inner};
  }
  function packIcon(kind, x, y, col) {
    const icons = {
      wheat: '<path d="M' + x + " " + (y + 26) + " L" + x + " " + (y - 24) + '" stroke="' + col + '" stroke-width="3"/>' + [-16, -6, 4, 14].map((dy) =>
        '<ellipse cx="' + (x - 8) + '" cy="' + (y + dy) + '" rx="8" ry="4" transform="rotate(-35 ' + (x - 8) + " " + (y + dy) + ')" fill="' + col + '"/><ellipse cx="' + (x + 8) + '" cy="' + (y + dy) + '" rx="8" ry="4" transform="rotate(35 ' + (x + 8) + " " + (y + dy) + ')" fill="' + col + '"/>').join(""),
      grains: [[-12, -8], [2, -12], [14, -4], [-8, 6], [6, 4], [-2, 16], [14, 12], [-16, 14]].map(([dx, dy]) => '<ellipse cx="' + (x + dx) + '" cy="' + (y + dy) + '" rx="7" ry="5.5" fill="' + col + '"/>').join(""),
      cake: '<rect x="' + (x - 22) + '" y="' + (y - 2) + '" width="44" height="22" rx="3" fill="' + col + '"/><path d="M' + (x - 22) + " " + (y - 2) + " Q" + x + " " + (y - 20) + " " + (x + 22) + " " + (y - 2) + ' Z" fill="' + col + '" opacity=".7"/><circle cx="' + x + '" cy="' + (y - 20) + '" r="4" fill="#c0392b"/>',
      scoop: '<path d="M' + (x - 22) + " " + (y - 4) + " A22 18 0 0 0 " + (x + 22) + " " + (y - 4) + ' Z" fill="' + col + '"/><rect x="' + (x + 14) + '" y="' + (y - 8) + '" width="18" height="6" rx="3" fill="' + col + '"/><path d="M' + (x - 16) + " " + (y - 6) + " Q" + x + " " + (y - 22) + " " + (x + 16) + " " + (y - 6) + ' Z" fill="#c9a27a"/>',
      drop: '<path d="M' + x + " " + (y - 26) + " C" + (x + 6) + " " + (y - 12) + " " + (x + 20) + " " + (y - 2) + " " + (x + 20) + " " + (y + 10) + " A20 20 0 0 1 " + (x - 20) + " " + (y + 10) + " C" + (x - 20) + " " + (y - 2) + " " + (x - 6) + " " + (y - 12) + " " + x + " " + (y - 26) + ' Z" fill="' + col + '"/>',
      cup: '<path d="M' + (x - 22) + " " + (y - 10) + " L" + (x + 22) + " " + (y - 10) + " L" + (x + 16) + " " + (y + 22) + " L" + (x - 16) + " " + (y + 22) + ' Z" fill="' + col + '"/><ellipse cx="' + x + '" cy="' + (y - 10) + '" rx="22" ry="6" fill="#fff" stroke="' + col + '" stroke-width="2"/>',
      cube: '<path d="M' + x + " " + (y - 22) + " L" + (x + 20) + " " + (y - 11) + " L" + x + " " + y + " L" + (x - 20) + " " + (y - 11) + ' Z" fill="' + col + '" opacity=".6"/><path d="M' + (x - 20) + " " + (y - 11) + " L" + x + " " + y + " L" + x + " " + (y + 22) + " L" + (x - 20) + " " + (y + 11) + ' Z" fill="' + col + '"/><path d="M' + (x + 20) + " " + (y - 11) + " L" + x + " " + y + " L" + x + " " + (y + 22) + " L" + (x + 20) + " " + (y + 11) + ' Z" fill="' + col + '" opacity=".8"/>',
    };
    return icons[kind] || icons.cube;
  }
  // Back of pack: the full back label printed on the same packet.
  function packBackSvg(item) {
    const c = item.compliance || {};
    if (c.backImageUrl) return '<img src="' + h(c.backImageUrl) + '" alt="Back of pack: ' + h(item.name) + '">';
    const p = packShape(item, "b"), label = backPackSvg(item), m = label.match(/viewBox="0 0 600 ([\d.]+)"/), H = m ? Number(m[1]) : 465;
    const [ix, iy, iw, ih] = p.inner, scale = Math.min(iw / 600, ih / H), w = 600 * scale, hh = H * scale;
    const nested = label.replace("<svg ", '<svg x="' + (ix + (iw - w) / 2) + '" y="' + (iy + (ih - hh) / 2) + '" width="' + w + '" height="' + hh + '" ');
    return '<svg viewBox="0 0 400 310" role="img" aria-label="Back of pack: ' + svgText(item.name) + '" class="pack">' + p.defs +
      '<rect width="400" height="310" fill="#f4f2ee"/><ellipse cx="200" cy="296" rx="150" ry="9" fill="#000" opacity=".12"/>' + p.body + nested + "</svg>";
  }
  // Last image: the nutrition panel and licence, zoomed so every value reads clearly.
  function nutritionCloseupSvg(item) {
    const c = item.compliance || {}, n = c.nutrition || {}, g = num(c.servingG);
    if (c.nutritionImageUrl) return '<img src="' + h(c.nutritionImageUrl) + '" alt="Nutrition information: ' + h(item.name) + '">';
    const ing = wrapSvg("Ingredients: " + (c.ingredients || ""), 70, 52, 460, 20, 25, 3, 400);
    let y = 52 + ing.height + 20;
    const t0 = y;
    const rows = [["Energy (kcal)", "energyKcal"], ["Protein (g)", "proteinG"], ["Carbohydrate (g)", "carbohydrateG"], ["  Total sugars (g)", "totalSugarsG"],
      ["  Added sugars (g)", "addedSugarsG"], ["Total fat (g)", "fatG"], ["  Saturated fat (g)", "saturatedFatG"], ["  Trans fat (g)", "transFatG"], ["Sodium (mg)", "sodiumMg"]];
    const fmt = (v) => v == null ? "—" : String(Math.round(v * 10) / 10);
    let body = '<text x="300" y="' + (y + 26) + '" text-anchor="middle" font-size="19" font-weight="700">Nutrition Information</text>' +
      '<text x="84" y="' + (y + 52) + '" font-size="13" fill="#444">Approx. values</text><text x="372" y="' + (y + 52) + '" font-size="13" font-weight="700" text-anchor="end">Per ' + svgText(n.per || "100 g") + "</text>" +
      '<text x="454" y="' + (y + 52) + '" font-size="13" font-weight="700" text-anchor="end">Per serve</text><text x="520" y="' + (y + 52) + '" font-size="13" font-weight="700" text-anchor="end">%RDA*</text>' +
      '<line x1="72" y1="' + (y + 60) + '" x2="528" y2="' + (y + 60) + '" stroke="#1d3a6e" stroke-width="2"/>';
    y += 84;
    rows.forEach(([label, key]) => {
      const v = n[key], serve = v == null || !g ? null : v * g / 100, rda = RDA[key] && serve != null ? Math.round(serve / RDA[key] * 100) + "%" : "";
      body += '<text x="' + (label.startsWith("  ") ? 100 : 84) + '" y="' + y + '" font-size="16">' + svgText(label.trim()) + "</text>" +
        '<text x="372" y="' + y + '" font-size="16" text-anchor="end">' + fmt(v) + '</text><text x="454" y="' + y + '" font-size="16" text-anchor="end">' + (serve == null ? "—" : fmt(serve)) + "</text>" +
        '<text x="520" y="' + y + '" font-size="16" text-anchor="end">' + rda + '</text><line x1="72" y1="' + (y + 8) + '" x2="528" y2="' + (y + 8) + '" stroke="#1d3a6e" stroke-width=".8"/>';
      y += 27;
    });
    body = '<rect x="72" y="' + t0 + '" width="456" height="' + (y - t0 - 19) + '" fill="none" stroke="#1d3a6e" stroke-width="2"/>' + body +
      '<text x="84" y="' + (y + 12) + '" font-size="12.5" fill="#444">*Approximate values. Serve size: ' + svgText(c.serving || "—") + ". %RDA per serve, based on 2,000 kcal.</text>";
    y += 34;
    const lic = /^\d{14}$/.test(String(c.manufacturerFssai || "")) ? c.manufacturerFssai : "1XXXXXXXXXXXXX";
    let bars = "", bx = 196;
    const seed = String(item.id).split("").reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 9973, 7);
    for (let i = 0; i < 64; i++) { const wdt = 1 + ((seed * (i + 3)) % 3); if ((seed + i * 7) % 2 === 0) bars += '<rect x="' + bx + '" y="' + (y + 116) + '" width="' + wdt + '" height="48" fill="#111"/>'; bx += wdt + 0.9; }
    const H = y + 196;
    return '<svg viewBox="0 0 600 ' + H + '" role="img" aria-label="Nutrition information and FSSAI licence: ' + svgText(item.name) + '" class="pack closeup" font-family="Helvetica,Arial,sans-serif" fill="#1d3a6e">' +
      '<rect width="600" height="' + H + '" fill="#fff"/>' + ing.svg.replace(">Ingredients: ", '><tspan font-weight="700">Ingredients:</tspan> ') + body +
      '<image href="/img/fssai-logo.png" x="240" y="' + (y + 0) + '" width="120" height="59"/>' +
      '<text x="300" y="' + (y + 98) + '" text-anchor="middle" font-size="28" font-weight="700" fill="#1d3a6e">Lic. No. ' + svgText(lic) + "</text>" + bars +
      '<text x="300" y="' + (y + 182) + '" text-anchor="middle" font-size="12" fill="#a0522d">' + (c.sampleValues ? "SAMPLE LABEL · NOT A REAL PRODUCT" : "") + "</text></svg>";
  }
  // Back of pack, laid out like an Indian retail label: ingredients, nutrition
  // per 100 g and per serve with %RDA (FSS (Labelling and Display) Regulations,
  // 2020), allergens, storage, manufacturer, FSSAI licence, and the Legal
  // Metrology declarations (net quantity, MRP incl. of all taxes, unit sale
  // price, batch, date of manufacture, best before, customer care).
  const RDA = {energyKcal: 2000, fatG: 67, saturatedFatG: 22, transFatG: 2, addedSugarsG: 50, sodiumMg: 2000};
  function parseQty(text) {
    const m = String(text || "").match(/([\d.]+)\s*(kg|g|l|ml)\b/i);
    if (!m) return null;
    const v = Number(m[1]), u = m[2].toLowerCase();
    return u === "kg" ? {base: v * 1000, unit: "g"} : u === "l" ? {base: v * 1000, unit: "ml"} : {base: v, unit: u};
  }
  function unitSalePrice(item) {
    const c = item.compliance || {}, q = parseQty(c.netQuantity), mrp = num(c.mrp);
    if (!q || !mrp) return "";
    const big = q.unit === "g" ? "kg" : "L";
    return q.base >= 1000 ? rs(Math.round(mrp / q.base * 1000 * 100) / 100) + " per " + big : rs(Math.round(mrp / q.base * 100) / 100) + " per " + q.unit;
  }
  function wrapSvg(text, x, y, width, size, lineGap, maxLines, weight) {
    // Estimated advance per character in Helvetica: capitals and digits are wider.
    const est = (t) => [...t].reduce((sum, ch) => sum + size * (/[A-Z0-9]/.test(ch) ? 0.68 : /[ .,;:()'il]/.test(ch) ? 0.3 : 0.55), 0);
    const words = String(text || "").split(/\s+/), lines = []; let line = "";
    words.forEach((w) => { const next = (line + " " + w).trim(); if (line && est(next) > width) { lines.push(line); line = w; } else line = next; });
    if (line) lines.push(line);
    const shown = lines.slice(0, maxLines);
    if (lines.length > maxLines) shown[maxLines - 1] = shown[maxLines - 1].replace(/\s*\S*$/, "") + "…";
    return {svg: shown.map((l, i) => '<text x="' + x + '" y="' + (y + i * lineGap) + '" font-size="' + size + '"' + (weight ? ' font-weight="' + weight + '"' : "") + ">" + svgText(l) + "</text>").join(""), height: shown.length * lineGap};
  }
  function backPackSvg(item) {
    const c = item.compliance || {}, n = c.nutrition || {}, g = num(c.servingG), veg = String(item.diet || "veg") === "veg", mark = veg ? "#1b8a3a" : "#8a3a1b";
    if (c.backImageUrl) return '<img src="' + h(c.backImageUrl) + '" alt="Back of pack: ' + h(item.name) + '">';
    const per = String(n.per || "100 g"), rows = [["Energy (kcal)", "energyKcal"], ["Protein (g)", "proteinG"], ["Carbohydrate (g)", "carbohydrateG"],
      ["  Total sugars (g)", "totalSugarsG"], ["  Added sugars (g)", "addedSugarsG"], ["Total fat (g)", "fatG"], ["  Saturated fat (g)", "saturatedFatG"], ["  Trans fat (g)", "transFatG"], ["Sodium (mg)", "sodiumMg"]];
    const fmt = (v) => v == null ? "—" : String(Math.round(v * 10) / 10);
    let y = 74;
    const table = rows.map(([label, key]) => {
      const v = n[key], serve = v == null || !g ? null : v * g / 100, rda = RDA[key] && serve != null ? Math.round(serve / RDA[key] * 100) + "%" : "";
      const row = '<text x="322" y="' + y + '" font-size="11.5"' + (label.startsWith("  ") ? ' fill="#5b4c3a"' : "") + ">" + svgText(label.trim()) + "</text>" +
        '<text x="478" y="' + y + '" font-size="11.5" text-anchor="end">' + fmt(v) + "</text>" +
        '<text x="534" y="' + y + '" font-size="11.5" text-anchor="end">' + (serve == null ? "—" : fmt(serve)) + "</text>" +
        '<text x="584" y="' + y + '" font-size="11.5" text-anchor="end">' + rda + "</text>" +
        '<line x1="316" y1="' + (y + 5) + '" x2="588" y2="' + (y + 5) + '" stroke="#d9cfbf" stroke-width="0.8"/>';
      y += 19; return row;
    }).join("");
    let ly = 40;
    const block = (title, body, lines) => { const w = wrapSvg(body, 16, ly + 15, 286, 11.5, 14.5, lines); const out = '<text x="16" y="' + ly + '" font-size="11" font-weight="700" letter-spacing=".6">' + svgText(title) + "</text>" + w.svg; ly += 18 + w.height + 6; return out; };
    const left = block("INGREDIENTS", c.ingredients, 3) + block("ALLERGEN INFORMATION", c.allergens, 2) +
      (c.directions ? block("DIRECTIONS & CAUTION", c.directions, 6) : "") + block("STORAGE", c.storage, 2) +
      block("MFD. & PACKED BY", c.manufacturer, 2) + block("CUSTOMER CARE", "Write to the manufacturer at the address above, or SCRAVEIT: balaji@scraveit.in, +91 9652509409", 3);
    const usp = unitSalePrice(item);
    const top = Math.max(ly, y + 14) + 8, H = top + 112;
    const foot = (dy) => top + dy;
    return '<svg viewBox="0 0 600 ' + H + '" role="img" aria-label="Back of pack: ' + svgText(item.name) + ' — ingredients, nutrition information and statutory declarations" class="pack back" font-family="Helvetica,Arial,sans-serif" fill="#22190f">' +
      '<rect width="600" height="' + H + '" fill="#fffdf8"/><rect x="6" y="6" width="588" height="' + (H - 12) + '" rx="10" fill="none" stroke="#c9bfb3" stroke-width="1.5"/>' +
      wrapSvg(item.name + " · " + (c.brand || ""), 16, 24, 280, 13, 15, 1, 700).svg +
      left +
      '<rect x="312" y="16" width="278" height="' + (y - 4) + '" fill="none" stroke="#22190f" stroke-width="1.2"/>' +
      '<text x="322" y="34" font-size="12.5" font-weight="700">NUTRITION INFORMATION</text>' +
      '<text x="322" y="52" font-size="9.5" fill="#5b4c3a">Approx. values</text>' +
      '<text x="478" y="52" font-size="9.5" text-anchor="end" font-weight="700">Per ' + svgText(per) + "</text>" +
      '<text x="534" y="52" font-size="9.5" text-anchor="end" font-weight="700">Per serve</text>' +
      '<text x="584" y="52" font-size="9.5" text-anchor="end" font-weight="700">%RDA*</text>' +
      '<line x1="316" y1="58" x2="588" y2="58" stroke="#22190f" stroke-width="1.2"/>' + table +
      '<text x="322" y="' + (y + 4) + '" font-size="9" fill="#5b4c3a">Serve size: ' + svgText(c.serving || "—") + ". *%RDA per serve, based on 2,000 kcal.</text>" +
      '<line x1="12" y1="' + foot(0) + '" x2="588" y2="' + foot(0) + '" stroke="#c9bfb3"/>' +
      '<text x="16" y="' + foot(20) + '" font-size="11"><tspan font-weight="700">Net Qty: </tspan>' + svgText(c.netQuantity || "") + '</text>' +
      '<text x="16" y="' + foot(38) + '" font-size="11"><tspan font-weight="700">MRP ₹' + svgText(num(c.mrp).toFixed(2)) + "</tspan> (Incl. of all taxes)</text>" +
      (usp ? '<text x="16" y="' + foot(56) + '" font-size="11"><tspan font-weight="700">Unit sale price: </tspan>' + svgText(usp) + "</text>" : "") +
      '<text x="16" y="' + foot(74) + '" font-size="11"><tspan font-weight="700">Batch No.: </tspan>' + (c.sampleValues ? "SAMPLE" : "As printed") + '   <tspan font-weight="700">Mfd./Pkd.: </tspan>As printed</text>' +
      '<text x="16" y="' + foot(92) + '" font-size="11"><tspan font-weight="700">Best before: </tspan>' + svgText(c.shelfLife || "") + "</text>" +
      '<text x="306" y="' + foot(20) + '" font-size="11"><tspan font-weight="700">Country of origin: </tspan>' + svgText(c.countryOfOrigin || "India") + "</text>" +
      '<rect x="306" y="' + foot(32) + '" width="20" height="20" fill="none" stroke="' + mark + '" stroke-width="2"/>' +
      (veg ? '<circle cx="316" cy="' + foot(42) + '" r="5.5" fill="' + mark + '"/>' : '<path d="M316 ' + foot(35) + ' L323 ' + foot(48) + ' L309 ' + foot(48) + ' Z" fill="' + mark + '"/>') +
      '<text x="334" y="' + foot(47) + '" font-size="11">' + (veg ? "Vegetarian" : "Non-vegetarian") + "</text>" +
      '<image href="/img/fssai-logo.png" x="523" y="' + foot(16) + '" width="61" height="30"/>' +
      '<text x="584" y="' + foot(64) + '" text-anchor="end" font-size="10.5">' + (/^\d{14}$/.test(String(c.manufacturerFssai || "")) ? "Lic. No. " + svgText(c.manufacturerFssai) : "Lic. No. 1XXXXXXXXXXXXX") + "</text>" +
      (c.sampleValues ? '<text x="584" y="' + foot(92) + '" text-anchor="end" font-size="9.5" fill="#a0522d">SAMPLE LABEL · NOT A REAL PRODUCT</text>' : "") +
      "</svg>";
  }
  function goodsProductPage(store, item) {
    const c = item.compliance || {}, off = offPercent(item), veg = String(item.diet || "veg") === "veg", usp = unitSalePrice(item);
    const views = [["Front of pack", packSvg(item)], ["Back of pack", packBackSvg(item)], ["Nutrition information and licence", nutritionCloseupSvg(item)]];
    app.innerHTML =
      '<nav class="crumbs" aria-label="Breadcrumb"><a href="/shop">Home</a><span>/</span><a href="/shop/store/' + encodeURIComponent(store.id) + '">' + h(store.name) + "</a><span>/</span><span>" + h(item.name) + "</span></nav>" +
      '<div class="gp"><div class="gp-gallery"><div class="gp-view" id="gp-view">' + views[0][1] + "</div>" +
      (views.length > 1 ? '<div class="gp-thumbs" role="tablist" aria-label="Product images">' + views.map(([label, markup], i) =>
        '<button type="button" class="gp-thumb" role="tab" aria-selected="' + (i === 0) + '" data-view="' + i + '" aria-label="' + h(label) + '">' + markup + "</button>").join("") + "</div>" : "") +
      '<p class="gp-caption">Front of pack, back of pack, and nutrition information with FSSAI licence' + (c.sampleValues ? " — sample pack drawn from the declared values below, not a real product" : "") +
      ". Tap an image to enlarge it.</p></div>" +
      '<div class="gp-info"><p class="gp-brand">' + h(c.brand || "") + "</p><h1>" + h(item.name) + '</h1><p class="gp-qty">' + h(c.netQuantity || "") + "</p>" +
      '<span class="p-eta">' + h(store.etaMin) + " MINS</span>" +
      '<div class="gp-price"><b>' + rs(item.price) + "</b>" + (num(c.mrp) > item.price ? "<s>MRP " + rs(c.mrp) + "</s>" : '<span class="gp-mrp">MRP ' + rs(c.mrp || item.price) + "</span>") +
      (off ? '<span class="p-off inline">' + off + "% OFF</span>" : "") + '</div><p class="gp-tax">(Inclusive of all taxes)' + (usp ? " · Unit sale price " + h(usp) : "") + "</p>" +
      '<p class="gp-fees">Our price is never above the MRP. Delivery, platform and maintenance fees are SCRAVEIT\'s own charges, shown separately in your bill before you pay.</p>' +
      '<div class="gp-actions">' + stepperFor(store, item, true) + "</div>" +
      sampleNotice(store) +
      '<section class="gp-sec"><h2>Highlights</h2><dl class="facts">' +
      factRow("Brand", c.brand ? h(c.brand) : "") +
      factRow("Product type", c.foodCategory ? h(c.foodCategory) : "") +
      factRow("Key features", item.description ? h(item.description) : "") +
      factRow("Ingredients", c.ingredients ? h(c.ingredients) : "") +
      factRow("Allergen information", c.allergens ? h(c.allergens) : "") +
      factRow("Dietary preference", dietMark(item.diet) + " " + (veg ? "Vegetarian" : "Non-vegetarian")) +
      "</dl>" + nutritionTable(c.nutrition) + "</section>" +
      '<section class="gp-sec"><h2>Information</h2><dl class="facts">' +
      factRow("Net quantity", c.netQuantity ? h(c.netQuantity) : "") +
      factRow("MRP (incl. of all taxes)", c.mrp ? rs(c.mrp) : "") +
      factRow("Shelf life", c.shelfLife ? h(c.shelfLife) : "") +
      factRow("Best before / use by", c.bestBefore ? h(c.bestBefore) : "") +
      factRow("Storage instructions", c.storage ? h(c.storage) : "") +
      factRow("Country of origin", c.countryOfOrigin ? h(c.countryOfOrigin) : "") +
      factRow("Manufacturer / packer name and address", c.manufacturer ? h(c.manufacturer) : "") +
      factRow("Manufacturer FSSAI licence", c.manufacturerFssai ? h(c.manufacturerFssai) : "") +
      factRow("Customer care details", c.customerCare ? h(c.customerCare) : "") +
      factRow("Seller name", h(store.name)) +
      factRow("Seller address", store.address ? h(store.address) : "") +
      factRow("Seller FSSAI licence", c.sellerFssai ? h(c.sellerFssai) : (store.sellerFssai ? h(store.sellerFssai) : "")) +
      factRow("Return policy", 'Not returnable once delivered. Damaged, expired or wrong items are refunded in full — see <a href="/refunds">refunds</a>.') +
      "</dl></section></div></div>" + goodsDisclaimer(store);
  }
  document.addEventListener("click", (event) => {
    if (event.target.closest(".gp-view")) {
      const box = document.createElement("div");
      box.className = "modal-backdrop zoom"; box.setAttribute("data-close-zoom", "1");
      box.innerHTML = '<div class="zoom-box" role="dialog" aria-modal="true" aria-label="Enlarged product image"><button type="button" class="modal-close" data-close-zoom="1" aria-label="Close">×</button>' + event.target.closest(".gp-view").innerHTML + "</div>";
      document.body.appendChild(box); document.body.classList.add("modal-open");
      return;
    }
    const zoom = event.target.closest("[data-close-zoom]");
    if (zoom && (zoom.classList.contains("modal-close") || event.target === zoom)) { document.querySelector(".modal-backdrop.zoom")?.remove(); document.body.classList.remove("modal-open"); return; }
    const thumb = event.target.closest(".gp-thumb");
    if (!thumb) return;
    const view = document.getElementById("gp-view");
    if (view) view.innerHTML = thumb.innerHTML;
    document.querySelectorAll(".gp-thumb").forEach((t) => t.setAttribute("aria-selected", String(t === thumb)));
  });
  async function viewItem(storeId, itemId) {
    await loadStores();
    const store = storeById(storeId);
    if (store && store.storeType === "restaurant") { state.openDish = {storeId, itemId}; return viewStore(storeId); }
    const items = await loadMenu(store);
    const item = store && items.find((i) => i.id === itemId);
    if (!store || !item) { app.innerHTML = '<p class="s-empty">This product is not available. <a href="/shop">Back to the shop</a></p>'; return; }
    setTitle(item.name + " · " + store.name);
    setKindBar(store.storeType);
    goodsProductPage(store, item);
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
    const food = store.storeType === "restaurant", goodsFees = CFG.goodsFees || {};
    const deliveryFee = num(store.deliveryFee, food ? 29 : 25);
    const platformFee = food ? num(store.platformFee, 15) : num(goodsFees.platformFee, 14.99);
    // Grocery and dairy: items at or below MRP; Scraveit's service is billed as separate, disclosed fees.
    const maintenanceFee = food ? 0 : num(goodsFees.maintenanceFee, 0);
    const tax = food ? Math.round(subtotal * 0.05 * 100) / 100 : 0;
    return {subtotal, deliveryFee, platformFee, maintenanceFee, tax, taxLabel: food ? "GST on food (5%)" : "Taxes (included in MRP)",
      total: Math.round((subtotal + deliveryFee + platformFee + maintenanceFee + tax) * 100) / 100};
  }
  function demoBanner() {
    return '<div class="notice warn demo-banner"><div><strong>Demo checkout.</strong>This shows every step of ordering on SCRAVEIT. No order is placed, no payment is taken and no seller is contacted. Ordering opens once SCRAVEIT\'s FSSAI licence is issued.</div></div>';
  }
  function billMarkup(b) {
    return '<div class="bill-row"><span>Item total</span><span>' + rs(b.subtotal) + '</span></div><div class="bill-row"><span>Delivery fee</span><span>' + rs(b.deliveryFee) +
      '</span></div><div class="bill-row"><span>Platform fee (incl. GST)</span><span>' + rs(b.platformFee) + "</span></div>" +
      (b.maintenanceFee ? '<div class="bill-row"><span>Maintenance fee (incl. GST)</span><span>' + rs(b.maintenanceFee) + "</span></div>" : "") +
      '<div class="bill-row"><span>' + h(b.taxLabel) + "</span><span>" +
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
  document.getElementById("footer-legal").innerHTML = h((CFG.company || {}).legalName || "SCRAVEIT PRIVATE LIMITED") + " · CIN " + h((CFG.company || {}).cin || "") + ((CFG.company || {}).gstin ? " · GSTIN " + h(CFG.company.gstin) : "") + " · Registered office: " + h((CFG.company || {}).address || "") +
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
