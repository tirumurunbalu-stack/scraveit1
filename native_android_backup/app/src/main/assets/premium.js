(function () {
  "use strict";

  const BRAND = "Savrivo";
  const DB_ROOT = "feastly"; // Legacy server namespace retained for Firebase compatibility.
  const CONFIG = window.FEASTLY_FIREBASE || {};
  const AUTH_BASE = "https://identitytoolkit.googleapis.com/v1/";
  const TOKEN_BASE = "https://securetoken.googleapis.com/v1/token";
  const ORDER_FLOW = [
    "Order placed", "Accepted", "Preparing", "Ready for pickup", "Assigned",
    "Handed to rider", "Out for delivery", "Near you", "Arrived", "Delivered"
  ];
  const ACTIVE_STATES = new Set(ORDER_FLOW.slice(0, -1));
  const TERMINAL_STATES = new Set(["Delivered", "Cancelled"]);

  const ICONS = {
    home: '<path d="M3 10.8 12 3l9 7.8v9.7a.5.5 0 0 1-.5.5h-5.2v-6.4H8.7V21H3.5a.5.5 0 0 1-.5-.5z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    orders: '<path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/>',
    offers: '<path d="M20 13 13 20 4 11V4h7z"/><circle cx="8.5" cy="8.5" r="1"/>',
    account: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    pin: '<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/>',
    star: '<path d="m12 2.5 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.1l6.2-.9z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
    eyeOff: '<path d="m3 3 18 18M10.6 6.2A10.7 10.7 0 0 1 12 6c6.5 0 10 6 10 6a15 15 0 0 1-2.1 2.8M6.6 6.6C3.7 8.4 2 12 2 12s3.5 6 10 6c1.6 0 3-.4 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    cart: '<path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 2-1.6L21 8H6"/><circle cx="10" cy="20" r="1"/><circle cx="18" cy="20" r="1"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M18.5 9A7 7 0 0 0 6 6.5L4 9M5.5 15A7 7 0 0 0 18 17.5l2-2.5"/>',
    moon: '<path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5 8.5 8.5 0 1 0 20.5 14.5Z"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.7 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1.2.9-1.2 1.7M12 17h.01"/>',
    address: '<path d="M5 10a7 7 0 0 1 14 0c0 4.8-7 11-7 11S5 14.8 5 10Z"/><circle cx="12" cy="10" r="2"/>',
    card: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/>',
    shield: '<path d="M12 22s8-3.6 8-10V5l-8-3-8 3v7c0 6.4 8 10 8 10Z"/><path d="m9 12 2 2 4-5"/>',
    logout: '<path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.8a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    warning: '<path d="M10.3 3.7 1.8 18.2A2 2 0 0 0 3.5 21h17a2 2 0 0 0 1.7-2.8L13.7 3.7a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
    receipt: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h4"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
    chat: '<path d="M21 12a8 8 0 0 1-8 8H4l2.1-3.2A8 8 0 1 1 21 12Z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>'
  };

  const FALLBACK_CATALOG = {
    "55-bistro": {
      id: "55-bistro", name: "55 Bistro", cuisines: ["Continental", "Chinese", "Biryani"],
      rating: 4.3, etaMin: 30, etaMax: 36, deliveryFee: 39, platformFee: 12,
      image: "55-bistro.jpg", address: "3rd Floor, Sreeman Enclave, 2nd Cross, Kings Court, Magunta Layout, Nellore",
      open: true, opensUntil: "11:30 PM", priceForTwo: 700, featured: true,
      menu: [
        { id: "chicken-65", category: "Starters", name: "Chicken 65", description: "Chicken morsels tossed with yoghurt, curry leaves and Indian spices.", price: 315, diet: "nonveg", image: "chicken-biryani.jpg", popular: true, available: true, addOns: [{name:"Extra dip",price:25},{name:"Extra spicy",price:0}] },
        { id: "veg-tawa-biryani", category: "Biryani", name: "Veg Tawa Biryani", description: "Basmati rice, seasonal vegetables and aromatic spices with raita.", price: 295, diet: "veg", image: "veg-meal.jpg", available: true },
        { id: "mughlai-chicken-biryani", category: "Biryani", name: "Mughlai Chicken Biryani", description: "Boneless chicken biryani layered with aromatic spices and egg.", price: 365, diet: "nonveg", image: "chicken-biryani.jpg", popular: true, available: true },
        { id: "chicken-keema-pav", category: "Small Plates", name: "Chicken Keema Pav", description: "Buttered pav served with slow-cooked chicken keema.", price: 275, diet: "nonveg", image: "chicken-biryani.jpg", available: true },
        { id: "veg-meal-box", category: "Meal Boxes", name: "Veg Meal Box", description: "Veg biryani, paneer butter masala, raita and phulka.", price: 325, diet: "veg", image: "veg-meal.jpg", available: true },
        { id: "butter-kulcha", category: "Breads", name: "Butter Kulcha", description: "Freshly baked soft kulcha finished with butter.", price: 75, diet: "veg", image: "kulcha.jpg", available: true }
      ]
    },
    "bombay-bowl": {
      id: "bombay-bowl", name: "Bombay Bowl", cuisines: ["Indian", "Bowls"], rating: 4.7,
      etaMin: 22, etaMax: 28, deliveryFee: 35, platformFee: 12, image: "veg-meal.jpg",
      address: "Nellore", open: true, opensUntil: "10:45 PM", priceForTwo: 450,
      menu: [
        { id: "paneer-bowl", category: "Bowls", name: "Paneer Tikka Bowl", description: "Smoky paneer, jeera rice, salad and mint dressing.", price: 249, diet: "veg", image: "veg-meal.jpg", popular: true, available: true },
        { id: "chicken-bowl", category: "Bowls", name: "Tandoori Chicken Bowl", description: "Tandoori chicken, fragrant rice, slaw and yoghurt dressing.", price: 289, diet: "nonveg", image: "chicken-biryani.jpg", available: true }
      ]
    },
    "little-napoli": {
      id: "little-napoli", name: "Little Napoli", cuisines: ["Italian", "Pizza"], rating: 4.6,
      etaMin: 28, etaMax: 35, deliveryFee: 0, platformFee: 12, image: "kulcha.jpg",
      address: "Nellore", open: true, opensUntil: "11:00 PM", priceForTwo: 650,
      menu: [
        { id: "margherita", category: "Pizza", name: "Classic Margherita", description: "Tomato, mozzarella and basil on a hand-stretched base.", price: 299, diet: "veg", image: "kulcha.jpg", available: true, variants: [{name:"Regular",price:0},{name:"Large",price:180}] },
        { id: "farmhouse", category: "Pizza", name: "Garden Farmhouse", description: "Capsicum, onion, mushroom, olives and mozzarella.", price: 379, diet: "veg", image: "veg-meal.jpg", available: true }
      ]
    }
  };

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function loadJSON(key, fallback) {
    try { const value = JSON.parse(localStorage.getItem(key)); return value == null ? fallback : value; }
    catch (_) { return fallback; }
  }
  function saveJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
  function h(value) {
    return String(value == null ? "" : value).replace(/[&<>'"]/g, function (char) {
      return ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char];
    });
  }
  function safeUrl(value, fallback) {
    const url = String(value || "").trim();
    if (/^(?:[a-z0-9._-]+\.(?:jpg|jpeg|png|webp)|data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+)$/i.test(url)) return url;
    if (/^https:\/\/firebasestorage\.googleapis\.com\//i.test(url)) return url;
    return fallback || "veg-meal.jpg";
  }
  function icon(name, extra) { return '<svg class="icon '+h(extra || "")+'" viewBox="0 0 24 24" aria-hidden="true">'+(ICONS[name] || ICONS.info)+"</svg>"; }
  function logo(extra) {
    return '<span class="logo-mark '+h(extra || "")+'" aria-hidden="true"><svg viewBox="0 0 64 64"><path fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" d="M48 18c-8-7-24-7-30 1-7 10 7 13 15 14 9 1 16 5 12 12-5 9-22 9-31 1"/><path fill="none" stroke="#73d7ff" stroke-width="5" stroke-linecap="round" d="M15 22h-8M13 32H4M17 42H8"/></svg></span>';
  }
  function money(value) { return "₹" + Math.round(Number(value || 0)).toLocaleString("en-IN"); }
  function timeAgo(timestamp) {
    if (!timestamp) return "just now";
    const delta = Math.max(0, Date.now() - Number(timestamp));
    if (delta < 60000) return "just now";
    if (delta < 3600000) return Math.floor(delta / 60000) + " min ago";
    if (delta < 86400000) return Math.floor(delta / 3600000) + " hr ago";
    return new Date(Number(timestamp)).toLocaleDateString("en-IN", {day:"numeric", month:"short"});
  }
  function dateTime(timestamp) {
    if (!timestamp) return "Not available";
    return new Date(Number(timestamp)).toLocaleString("en-IN", {day:"numeric",month:"short",hour:"numeric",minute:"2-digit"});
  }
  function firstName() { return String(state.profile.name || "there").trim().split(/\s+/)[0] || "there"; }
  function initials() {
    const parts = String(state.profile.name || state.profile.email || "S").trim().split(/\s+/).filter(Boolean);
    return parts.slice(0,2).map(x => x[0].toUpperCase()).join("") || "S";
  }
  function uid(prefix) {
    if (window.crypto && crypto.randomUUID) return (prefix || "") + crypto.randomUUID();
    return (prefix || "") + Date.now().toString(36) + Math.random().toString(36).slice(2,10);
  }
  async function sha256(value) {
    if(crypto.subtle){const bytes=new TextEncoder().encode(value),digest=await crypto.subtle.digest("SHA-256",bytes);return Array.from(new Uint8Array(digest)).map(byte=>byte.toString(16).padStart(2,"0")).join("");}
    let hash=2166136261;for(let i=0;i<value.length;i++){hash^=value.charCodeAt(i);hash=Math.imul(hash,16777619);}return"fallback-"+(hash>>>0).toString(16);
  }

  const cachedProfile = loadJSON("savrivo.customer.profile", {});
  const state = {
    route: "welcome", history: [], routeData: {},
    session: loadJSON("savrivo.customer.session", null),
    profile: Object.assign({name:"", email:"", phone:"", addresses:[], selectedAddressId:"", favourites:[], preferences:{theme:"system", vegetarian:false, notifications:true}}, cachedProfile),
    catalog: clone(FALLBACK_CATALOG), catalogMode: "packaged", catalogLoaded: false,
    promotions: [], settings: {platformFee:12, taxRate:0, freeDeliveryAbove:0},
    orders: loadJSON("savrivo.customer.orders", []), tracking: {}, deliveryOtps:loadJSON("savrivo.customer.deliveryOtps",{}),
    cart: loadJSON("savrivo.customer.cart", []), coupon: null, tip: 0,
    query: "", cuisine: "All", diet: "all", sort: "recommended",
    selectedRestaurantId: "55-bistro", selectedOrderId: "", selectedMenuCategory: "All",
    online: navigator.onLine, loading: false, syncError: "", lastSync: 0,
    sheet: null, toastTimer: null, timers: [], locationBusy: false,
    checkout: Object.assign({deliveryMode:"asap", payment:"cod", instructions:"", contactless:false, pendingOrderId:""},loadJSON("savrivo.customer.checkout",{}))
  };

  const app = document.getElementById("app");
  const toastRegion = document.getElementById("toast-region");
  const sheetRegion = document.getElementById("sheet-region");
  const SCREENS = {};

  function themeValue() {
    const pref = state.profile.preferences && state.profile.preferences.theme || "system";
    if (pref === "system") return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    return pref;
  }
  function applyTheme() {
    const value = themeValue();
    document.documentElement.dataset.theme = value;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = value === "dark" ? "#071426" : "#F6F9FD";
  }

  function persistProfile() { saveJSON("savrivo.customer.profile", state.profile); }
  function persistCart() { saveJSON("savrivo.customer.cart", state.cart); }
  function persistCheckout() { saveJSON("savrivo.customer.checkout", state.checkout); }
  function persistOrders() { saveJSON("savrivo.customer.orders", state.orders.slice(0,60)); }
  function persistSession() { state.session ? saveJSON("savrivo.customer.session", state.session) : localStorage.removeItem("savrivo.customer.session"); }

  async function request(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 14000);
    try {
      const response = await fetch(url, Object.assign({}, options || {}, {signal:controller.signal}));
      let data = null;
      const text = await response.text();
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
      if (!response.ok) {
        const code = data && data.error && (data.error.message || data.error) || "REQUEST_FAILED";
        const error = new Error(String(code)); error.status = response.status; throw error;
      }
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("REQUEST_TIMEOUT");
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function authRequest(method, payload) {
    if (!CONFIG.apiKey) throw new Error("CONFIGURATION_MISSING");
    return request(AUTH_BASE + method + "?key=" + encodeURIComponent(CONFIG.apiKey), {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload || {})
    });
  }

  function saveAuth(data, email) {
    state.session = {
      uid: data.localId || state.session && state.session.uid || "",
      email: data.email || email || "",
      idToken: data.idToken,
      refreshToken: data.refreshToken || state.session && state.session.refreshToken || "",
      expiresAt: Date.now() + Math.max(300, Number(data.expiresIn || 3600)) * 1000
    };
    persistSession();
    state.profile.email = state.session.email;
    persistProfile();
  }

  async function refreshSession() {
    if (!state.session || !state.session.refreshToken) throw new Error("AUTH_REQUIRED");
    const data = await request(TOKEN_BASE + "?key=" + encodeURIComponent(CONFIG.apiKey), {
      method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:"grant_type=refresh_token&refresh_token=" + encodeURIComponent(state.session.refreshToken)
    });
    saveAuth({localId:data.user_id,email:state.session.email,idToken:data.id_token,refreshToken:data.refresh_token,expiresIn:data.expires_in}, state.session.email);
    return state.session;
  }
  async function ensureSession() {
    if (!state.session || !state.session.refreshToken) throw new Error("AUTH_REQUIRED");
    if (state.session.idToken && state.session.expiresAt > Date.now() + 120000) return state.session;
    return refreshSession();
  }

  async function db(method, path, body, unauthenticated) {
    const session = unauthenticated ? state.session : await ensureSession();
    const token = session && session.idToken;
    const base = String(CONFIG.databaseUrl || "").replace(/\/$/, "");
    if (!base) throw new Error("CONFIGURATION_MISSING");
    const url = base + "/" + String(path || "").replace(/^\/+/, "") + ".json" + (token ? "?auth=" + encodeURIComponent(token) : "");
    const options = {method:method, headers:{"Content-Type":"application/json"}};
    if (body !== undefined) options.body = JSON.stringify(body);
    return request(url, options, 18000);
  }

  function friendlyError(error) {
    const code = String(error && error.message || error || "").replace(/^Firebase:\s*/i, "").split(" : ")[0];
    const map = {
      EMAIL_NOT_FOUND:"No account was found for that email.", INVALID_PASSWORD:"That password is incorrect.",
      INVALID_LOGIN_CREDENTIALS:"The email or password is incorrect.", EMAIL_EXISTS:"An account already uses that email.",
      WEAK_PASSWORD:"Use a stronger password with at least 8 characters.", USER_DISABLED:"This account has been disabled.",
      TOO_MANY_ATTEMPTS_TRY_LATER:"Too many attempts. Please wait before trying again.",
      NETWORK_REQUEST_FAILED:"Check your internet connection and try again.", REQUEST_TIMEOUT:"The connection took too long. Please try again.",
      CONFIGURATION_MISSING:"Firebase is not configured in this developer build.", AUTH_REQUIRED:"Please sign in again to continue."
    };
    return map[code] || (code.includes("PERMISSION_DENIED") ? "This action is not permitted for this account." : "Something went wrong. Please try again.");
  }

  async function syncProfile(remoteOnly) {
    if (!state.session) return;
    const remote = await db("GET", DB_ROOT + "/users/" + encodeURIComponent(state.session.uid));
    if (remote && typeof remote === "object") {
      const prefs = Object.assign({}, state.profile.preferences || {}, remote.preferences || {});
      state.profile = Object.assign({}, state.profile, remote, {preferences:prefs});
      state.profile.addresses = Array.isArray(remote.addresses) ? remote.addresses : state.profile.addresses || [];
      state.profile.favourites = Array.isArray(remote.favourites) ? remote.favourites : state.profile.favourites || [];
      persistProfile(); applyTheme();
    } else if (!remoteOnly) await saveProfile();
  }

  async function saveProfile() {
    if (!state.session) { persistProfile(); return; }
    persistProfile();
    const payload = {
      name:state.profile.name || "", email:state.profile.email || state.session.email || "", phone:state.profile.phone || "", emailVerified:state.profile.emailVerified===true,
      addresses:state.profile.addresses || [], selectedAddressId:state.profile.selectedAddressId || "",
      favourites:state.profile.favourites || [], preferences:state.profile.preferences || {}, updatedAt:Date.now()
    };
    await db("PUT", DB_ROOT + "/users/" + encodeURIComponent(state.session.uid), payload);
  }

  function normalizeRestaurant(id, record) {
    const data = Object.assign({}, record || {});
    data.id = data.id || id;
    data.name = data.name || "Restaurant";
    data.cuisines = Array.isArray(data.cuisines) ? data.cuisines : String(data.type || "Food").split(/[·,]/).map(x=>x.trim()).filter(Boolean);
    data.menu = Array.isArray(data.menu) ? data.menu : data.items && typeof data.items === "object" ? Object.keys(data.items).map(key => Object.assign({id:key}, data.items[key])) : [];
    data.menu = data.menu
      .map((item,index) => Object.assign({id:item.id || data.id+"-item-"+index,category:item.category||"Menu",diet:item.diet||"veg",available:item.available!==false},item))
      .filter(item => item.archived !== true);
    data.open = data.open !== false && data.active !== false && data.archived !== true;
    return data;
  }

  async function syncCatalog() {
    if (!state.session) return;
    try {
      const result = await Promise.all([
        db("GET", DB_ROOT + "/catalog/restaurants"), db("GET", DB_ROOT + "/catalog/meta"),
        db("GET", DB_ROOT + "/promotions").catch(()=>null), db("GET", DB_ROOT + "/settings/customer").catch(()=>null)
      ]);
      const records = result[0] || {};
      const meta = result[1] || {};
      if (Object.keys(records).length || meta.initialized === true) {
        state.catalog = {};
        Object.keys(records).forEach(id => {
          const restaurant = normalizeRestaurant(id, records[id]);
          if (restaurant.archived !== true) state.catalog[id] = restaurant;
        });
        state.catalogMode = "live";
      } else {
        state.catalog = clone(FALLBACK_CATALOG);
        state.catalogMode = "packaged";
      }
      state.promotions = Object.keys(result[2] || {}).map(id=>Object.assign({id:id},result[2][id])).filter(x=>x.active===true);
      state.settings = Object.assign(state.settings, result[3] || {});
      state.catalogLoaded = true;
    } catch (error) {
      state.catalogLoaded = true;
      state.syncError = "Catalogue refresh failed. Showing saved restaurants.";
    }
  }

  function normalizeOrders(map) {
    return Object.keys(map || {}).map(id=>Object.assign({id:id},map[id]||{})).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
  }

  async function syncOrders(silent) {
    if (!state.session) return;
    try {
      const map = await db("GET", DB_ROOT + "/orders/" + encodeURIComponent(state.session.uid));
      const before = {};
      state.orders.forEach(order=>before[order.id]=order.status);
      state.orders = normalizeOrders(map);
      persistOrders();
      let otpChanged = false;
      state.orders.forEach(order => {
        if (TERMINAL_STATES.has(order.status) && state.deliveryOtps[order.id]) {
          delete state.deliveryOtps[order.id]; otpChanged = true;
        }
      });
      if (otpChanged) saveJSON("savrivo.customer.deliveryOtps", state.deliveryOtps);
      state.orders.forEach(order => {
        if (before[order.id] && before[order.id] !== order.status) notifyOrderTransition(order, before[order.id]);
      });
      const active = state.orders.filter(order=>ACTIVE_STATES.has(order.status));
      const trackingPairs = await Promise.all(active.map(async order => {
        try { return [order.id, await db("GET", DB_ROOT + "/tracking/" + encodeURIComponent(order.id))]; }
        catch (_) { return [order.id, null]; }
      }));
      trackingPairs.forEach(pair=>{ if(pair[1]) state.tracking[pair[0]]=pair[1]; });
      state.lastSync = Date.now(); state.syncError = "";
      if (!silent && ["home","orders","order","tracking"].includes(state.route)) render({preserveScroll:true});
    } catch (error) {
      state.syncError = "Live order updates are temporarily unavailable.";
      if (!silent) render({preserveScroll:true});
    }
  }

  function notifyOrderTransition(order) {
    const copy = {
      Accepted:"Your order was confirmed by the restaurant.", Preparing:"The kitchen is preparing your order.",
      "Ready for pickup":"Your order is packed and ready for a rider.", Assigned:"A delivery partner has been assigned.",
      "Handed to rider":"Your order has been handed to the delivery partner.", "Out for delivery":"Your order is on the way.",
      "Near you":"Your delivery partner is nearby.", Arrived:"Your delivery partner is at the delivery location.",
      Delivered:"Your order has been delivered. Enjoy your meal!", Cancelled:"This order was cancelled."
    };
    if (copy[order.status]) {
      toast(copy[order.status], order.status === "Cancelled" ? "danger" : "success");
      if (state.profile.preferences.notifications !== false && window.FeastlyNative && FeastlyNative.notifyOrder) {
        try { FeastlyNative.notifyOrder(BRAND + " · " + order.status, copy[order.status], Math.abs(hashCode(order.id+order.status))); } catch (_) {}
      }
    }
  }

  function hashCode(text) { let hash=0; for(let i=0;i<text.length;i++) hash=((hash<<5)-hash)+text.charCodeAt(i)|0; return hash; }

  async function bootstrap() {
    applyTheme();
    if (!localStorage.getItem("savrivo.customer.seenWelcome")) state.route = "welcome";
    else state.route = state.session ? "home" : "login";
    render();
    if (!state.session) return;
    state.loading = true; render({preserveScroll:true});
    try {
      await ensureSession();
      await syncProfile(false);
      const results = await Promise.all([syncCatalog(), syncOrders(true), syncEmailVerification()]);
      if (!results[2]) state.route = "verifyEmail";
      else offerAutomaticLocation();
      startPolling();
    } catch (error) {
      if (["INVALID_REFRESH_TOKEN","TOKEN_EXPIRED","USER_DISABLED","AUTH_REQUIRED"].some(code=>String(error.message).includes(code))) signOut(false);
      else state.syncError = "Could not refresh live data. Saved information is still available.";
    } finally { state.loading = false; app.setAttribute("aria-busy","false"); render({preserveScroll:true}); }
  }

  function startPolling() {
    stopPolling();
    state.timers.push(setInterval(()=>{ if(document.visibilityState === "visible" && state.online) syncOrders(true); }, 12000));
    state.timers.push(setInterval(()=>{ if(document.visibilityState === "visible" && state.online) syncCatalog().then(()=>render({preserveScroll:true})); }, 180000));
  }
  function stopPolling() { state.timers.forEach(clearInterval); state.timers = []; }

  function toast(message, type) {
    clearTimeout(state.toastTimer);
    toastRegion.innerHTML = '<div class="toast '+h(type||"")+'">'+h(message)+'</div>';
    state.toastTimer = setTimeout(()=>{ toastRegion.innerHTML=""; }, 3600);
  }
  function setSheet(sheet) { state.sheet = sheet; renderSheet(); }
  function closeSheet() { state.sheet = null; renderSheet(); }

  function go(route, data, replace) {
    if (!replace && state.route !== route) state.history.push({route:state.route,data:state.routeData});
    state.route = route; state.routeData = data || {};
    if (data && data.restaurantId) state.selectedRestaurantId = data.restaurantId;
    if (data && data.orderId) state.selectedOrderId = data.orderId;
    closeSheet();
    render(); window.scrollTo(0,0);
  }
  function goBack() {
    const previous = state.history.pop();
    if (previous) { state.route = previous.route; state.routeData = previous.data || {}; closeSheet(); render(); window.scrollTo(0,0); return true; }
    if (["home","orders","offers","account"].includes(state.route)) return false;
    state.route = state.session ? "home" : "login"; state.routeData={}; closeSheet(); render(); return true;
  }
  window.handleAndroidBack = function () {
    if (state.sheet) { closeSheet(); return "handled"; }
    return goBack() ? "handled" : "root";
  };

  function currentAddress() {
    const addresses = state.profile.addresses || [];
    return addresses.find(x=>x.id===state.profile.selectedAddressId) || addresses[0] || null;
  }
  function hasPinnedAddress(){return(state.profile.addresses||[]).some(address=>Number.isFinite(Number(address.lat))&&Number.isFinite(Number(address.lng)));}
  function offerAutomaticLocation(){if(!hasPinnedAddress()&&!state.locationBusy)setTimeout(()=>{if(state.session&&state.profile.emailVerified===true&&!hasPinnedAddress())requestLocation();},450);}
  function restaurant(id) { return state.catalog[id || state.selectedRestaurantId] || null; }
  function menuItem(rid, iid) { const r=restaurant(rid); return r && r.menu.find(x=>x.id===iid); }
  function cartCount() { return state.cart.reduce((sum,item)=>sum+Number(item.quantity||0),0); }
  function cartRestaurant() { return state.cart.length ? restaurant(state.cart[0].restaurantId) : null; }
  function cartSubtotal() { return state.cart.reduce((sum,item)=>sum+(Number(item.price)+Number(item.variantPrice||0)+Number(item.addOnTotal||0))*Number(item.quantity||0),0); }
  function deliveryFee() { const r=cartRestaurant(); if(!r)return 0; const threshold=Number(state.settings.freeDeliveryAbove||0); return threshold>0&&cartSubtotal()>=threshold?0:Number(r.deliveryFee||0); }
  function platformFee() { const r=cartRestaurant(); return Number(r&&r.platformFee!=null?r.platformFee:state.settings.platformFee||0); }
  function eligibleCoupon() {
    if(!state.coupon||!state.cart.length||state.coupon.active!==true)return null;
    if(state.coupon.expiresAt&&Date.now()>Number(state.coupon.expiresAt))return null;
    if(state.coupon.minimumOrder&&cartSubtotal()<Number(state.coupon.minimumOrder))return null;
    if(Array.isArray(state.coupon.restaurantIds)&&!state.coupon.restaurantIds.includes(state.cart[0].restaurantId))return null;
    return state.coupon;
  }
  function discount() { const coupon=eligibleCoupon();return coupon?Math.min(Number(coupon.maxDiscount||99999),cartSubtotal()*Number(coupon.percent||0)/100):0; }
  function tax() { return Math.max(0,(cartSubtotal()-discount())*Number(state.settings.taxRate||0)/100); }
  function orderTotal() { return Math.max(0,cartSubtotal()+deliveryFee()+platformFee()+Number(state.tip||0)+tax()-discount()); }

  function addCartItem(rid, iid, custom) {
    const r = restaurant(rid), item = menuItem(rid,iid);
    if (!r || !item || item.available === false) { toast("This item is unavailable right now.","danger"); return; }
    if (state.cart.length && state.cart[0].restaurantId !== rid) {
      setSheet({type:"replaceCart", restaurantId:rid, itemId:iid, custom:custom||{}}); return;
    }
    const variant = custom && custom.variant || null;
    const addOns = custom && custom.addOns || [];
    const key = rid+"::"+iid+"::"+(variant&&variant.name||"")+"::"+addOns.map(x=>x.name).sort().join("|");
    const existing = state.cart.find(x=>x.key===key);
    if (existing) existing.quantity += 1;
    else state.cart.push({
      key:key, restaurantId:rid, restaurantName:r.name, itemId:iid, name:item.name, price:Number(item.price||0),
      image:safeUrl(item.image,r.image), diet:item.diet||"veg", quantity:1,
      variant:variant&&variant.name||"", variantPrice:Number(variant&&variant.price||0), addOns:addOns,
      addOnTotal:addOns.reduce((sum,x)=>sum+Number(x.price||0),0), note:custom&&custom.note||""
    });
    persistCart(); closeSheet(); toast(item.name+" added to cart.","success"); render({preserveScroll:true});
  }
  function updateCart(key, delta) {
    const item = state.cart.find(x=>x.key===key); if(!item)return;
    item.quantity += delta;
    if(item.quantity<=0) state.cart=state.cart.filter(x=>x.key!==key);
    if(!state.cart.length){state.coupon=null;state.tip=0;}
    persistCart(); render({preserveScroll:true});
  }

  async function selectAddress(id) {
    state.profile.selectedAddressId = id; persistProfile(); render({preserveScroll:true});
    try { await saveProfile(); toast("Delivery address updated.","success"); } catch (_) { toast("Saved on this device; cloud sync will retry."); }
  }
  function requestLocation() {
    state.locationBusy = true; render({preserveScroll:true});
    if (window.FeastlyNative && FeastlyNative.requestCurrentLocation) FeastlyNative.requestCurrentLocation();
    else { state.locationBusy=false; toast("Current location is available in the installed Android app.","danger"); render({preserveScroll:true}); }
  }
  window.setDetectedLocation = async function (label, area, details, lat, lng) {
    const addresses=state.profile.addresses||[];
    let current=addresses.find(x=>x.id==="current-location");
    const record={id:"current-location",label:label||"Current location",area:area||"Nearby",address:details||"Current delivery location",phone:current&&current.phone||state.profile.phone||"",lat:Number(lat),lng:Number(lng),source:"gps",updatedAt:Date.now()};
    if(current)Object.assign(current,record);else addresses.unshift(record);
    state.profile.addresses=addresses;state.profile.selectedAddressId=record.id;state.locationBusy=false;persistProfile();render({preserveScroll:true});
    try{await saveProfile();toast("Current location is ready.","success");}catch(_){toast("Location saved on this device; cloud sync will retry.");}
  };
  window.locationUnavailable = function(){state.locationBusy=false;toast("Location could not be detected. Check permission and try again.","danger");render({preserveScroll:true});};
  window.locationServicesDisabled = function(){state.locationBusy=false;toast("Turn on phone Location, then try again.","danger");render({preserveScroll:true});};

  function openGoogleSignIn() {
    if (window.FeastlyNative && FeastlyNative.signInWithGoogle) { state.loading=true;render({preserveScroll:true});FeastlyNative.signInWithGoogle(); }
    else toast("Google sign-in is available in the installed Android app.","danger");
  }
  window.googleAccessTokenReceived = async function(accessToken){
    try{
      const data=await authRequest("accounts:signInWithIdp",{postBody:"access_token="+encodeURIComponent(accessToken)+"&providerId=google.com",requestUri:"http://localhost",returnIdpCredential:true,returnSecureToken:true});
      saveAuth(data,data.email);state.profile.name=data.displayName||state.profile.name;state.profile.email=data.email||state.profile.email;await afterAuth();
    }catch(error){toast(friendlyError(error),"danger");}finally{state.loading=false;render();}
  };
  window.googleSignInFailed = function(message){state.loading=false;toast(message||"Google sign-in could not be completed.","danger");render({preserveScroll:true});};

  async function syncEmailVerification() {
    if (!state.session) return false;
    const result = await authRequest("accounts:lookup", {idToken:state.session.idToken});
    const user = result && result.users && result.users[0];
    const verified = !!(user && user.emailVerified);
    if(verified)await refreshSession();
    state.profile.emailVerified = verified;
    persistProfile();
    try { await db("PATCH", DB_ROOT + "/users/" + encodeURIComponent(state.session.uid), {emailVerified:verified,updatedAt:Date.now()}); } catch (_) {}
    return verified;
  }

  async function afterAuth() {
    localStorage.setItem("savrivo.customer.seenWelcome","1");
    state.loading=true;state.route="home";state.history=[];render();
    await syncProfile(false);
    const results=await Promise.all([syncCatalog(),syncOrders(true),syncEmailVerification()]);
    state.route=results[2]?"home":"verifyEmail";startPolling();state.loading=false;render();if(results[2])offerAutomaticLocation();
  }
  function signOut(showMessage) {
    stopPolling();state.session=null;persistSession();
    state.profile={name:"",email:"",phone:"",addresses:[],selectedAddressId:"",favourites:[],preferences:{theme:"system",vegetarian:false,notifications:true}};
    state.orders=[];state.tracking={};state.cart=[];state.checkout={deliveryMode:"asap",payment:"cod",instructions:"",contactless:false,pendingOrderId:""};state.history=[];state.route="login";
    ["savrivo.customer.profile","savrivo.customer.orders","savrivo.customer.cart","savrivo.customer.checkout","savrivo.customer.deliveryOtps"].forEach(key=>localStorage.removeItem(key));state.deliveryOtps={};
    applyTheme();render();if(showMessage!==false)toast("You have signed out safely.");
  }

  function activeOrders() { return state.orders.filter(x=>ACTIVE_STATES.has(x.status)); }
  function orderById(id) { return state.orders.find(x=>x.id===(id||state.selectedOrderId)) || null; }
  function statusIndex(status) { return Math.max(0,ORDER_FLOW.indexOf(status)); }
  function statusTone(status) { if(status==="Delivered")return"success";if(status==="Cancelled")return"danger";if(["Preparing","Ready for pickup"].includes(status))return"warning";return""; }
  function etaText(order) {
    if(!order)return""; if(order.status==="Delivered")return"Delivered";if(order.status==="Cancelled")return"Cancelled";
    const elapsed=Math.max(0,Date.now()-Number(order.createdAt||Date.now()));const estimate=Math.max(4,Number(order.etaMax||35)-Math.floor(elapsed/60000));return estimate+"–"+(estimate+6)+" min";
  }

  function parentTab() {
    if(["home","search","restaurant","cart","checkout","addresses","favourites"].includes(state.route))return"home";
    if(["orders","order","tracking","review"].includes(state.route))return"orders";
    if(state.route==="offers")return"offers";return"account";
  }
  function nav() {
    const selected=parentTab();
    return '<nav class="bottom-nav" aria-label="Main navigation">'+[
      ["home","home","Home"],["orders","orders","Orders"],["offers","offers","Offers"],["account","account","Account"]
    ].map(([route,ic,label])=>'<button class="nav-button '+(selected===route?'active':'')+'" data-action="go" data-route="'+route+'" aria-current="'+(selected===route?'page':'false')+'">'+icon(ic)+'<span>'+label+'</span></button>').join("")+'</nav>';
  }
  function topbar(title,subtitle,actions) {
    return '<header class="topbar"><button class="back-button" data-action="back" aria-label="Go back">'+icon("back")+'</button><div class="topbar-title"><h1 class="page-title">'+h(title)+'</h1>'+(subtitle?'<p class="supporting">'+h(subtitle)+'</p>':'')+'</div>'+(actions||"")+'</header>';
  }
  function networkBanner() {
    if(!state.online)return'<div class="notice warning offline-banner">'+icon("warning","small")+'<div><strong>You are offline</strong><div class="caption">Showing saved information. Orders cannot be placed until you reconnect.</div></div></div>';
    if(state.syncError)return'<div class="notice warning offline-banner">'+icon("refresh","small")+'<div class="grow"><strong>Live sync paused</strong><div class="caption">'+h(state.syncError)+'</div></div><button class="text-button" data-action="refresh">Retry</button></div>';
    return"";
  }
  function loadingRow(label){return'<div class="load-row"><span class="spinner" aria-hidden="true"></span><span>'+h(label||"Loading")+'</span></div>';}
  function emptyState(ic,title,copy,action,label){return'<div class="empty-state"><div><div class="empty-visual">'+icon(ic,"large")+'</div><h2 class="section-title">'+h(title)+'</h2><p class="supporting" style="margin-top:8px">'+h(copy)+'</p>'+(action?'<button class="button secondary" style="margin-top:18px" data-action="'+h(action)+'">'+h(label||"Continue")+'</button>':'')+'</div></div>';}

  function render(options) {
    applyTheme();
    const scrollY = options && options.preserveScroll ? window.scrollY : 0;
    const renderer = SCREENS[state.route] || screenHome;
    app.innerHTML = renderer(); app.setAttribute("aria-busy",state.loading?"true":"false");
    renderSheet();
    if(options&&options.preserveScroll)requestAnimationFrame(()=>window.scrollTo(0,scrollY));
  }

  function screenWelcome() {
    return '<main class="welcome-screen no-nav">'
      +'<div class="cluster">'+logo()+'<div><div class="brand-word">'+BRAND+'</div><div class="caption">Food, thoughtfully delivered</div></div></div>'
      +'<div class="welcome-art" aria-label="A calm delivery route illustration"><div class="route-line"><svg viewBox="0 0 360 270" fill="none" aria-hidden="true"><path d="M47 207C82 118 121 233 169 151c41-70 85-20 144-95" stroke="rgba(255,255,255,.35)" stroke-width="24" stroke-linecap="round"/><path d="M47 207C82 118 121 233 169 151c41-70 85-20 144-95" stroke="white" stroke-width="5" stroke-linecap="round" stroke-dasharray="9 14"/><circle cx="47" cy="207" r="18" fill="#4DD6A4" stroke="white" stroke-width="6"/><path d="M306 44c0-18 27-18 27 0 0 15-13.5 29-13.5 29S306 59 306 44Z" fill="#fff"/><circle cx="319.5" cy="44" r="5" fill="#155EEF"/><rect x="134" y="114" width="74" height="58" rx="18" fill="rgba(7,20,38,.72)"/><path d="M151 144h40m-26-13h26m-40 26h27" stroke="#73D7FF" stroke-width="7" stroke-linecap="round"/></svg></div></div>'
      +'<div class="stack-lg"><div><p class="eyebrow">Made for your neighbourhood</p><h1 class="display" style="margin-top:8px">Good food.<br>Clear journeys.</h1><p class="body muted" style="margin-top:14px">Discover trusted kitchens, order without surprises and follow every step to your door.</p></div><div class="welcome-actions"><button class="button primary full" data-action="welcome-signup">Create your account</button><button class="button tonal full" data-action="welcome-login">I already have an account</button><p class="caption" style="text-align:center">By continuing, you agree to Savrivo’s Terms and Privacy Notice.</p></div></div>'
      +'</main>';
  }

  function authHeader(title, copy) {
    return '<div class="auth-hero"><div class="cluster">'+logo("compact")+'<span class="brand-word">'+BRAND+'</span></div><div><h1 class="display">'+h(title)+'</h1><p class="body muted" style="margin-top:10px">'+h(copy)+'</p></div></div>';
  }
  function passwordField(id, label, autocomplete) {
    return '<div class="field"><label for="'+id+'">'+h(label)+'</label><div class="input-wrap"><input class="input with-action" id="'+id+'" name="'+id+'" type="password" autocomplete="'+h(autocomplete||"current-password")+'" minlength="8" required><button type="button" class="icon-button flat input-action" data-action="toggle-password" data-target="'+id+'" aria-label="Show password">'+icon("eye")+'</button></div><div class="field-error" data-error-for="'+id+'"></div></div>';
  }
  function screenLogin() {
    return '<main class="screen no-nav auth-screen"><div class="screen-content auth-card">'+authHeader("Welcome back.","Sign in to see your favourites, orders and live delivery updates.")
      +networkBanner()+'<form id="login-form" class="form-grid" novalidate><div class="field"><label for="login-email">Email address</label><input class="input" id="login-email" name="email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" required><div class="field-error" data-error-for="login-email"></div></div>'
      +passwordField("login-password","Password","current-password")
      +'<div class="cluster between"><label class="cluster supporting"><input type="checkbox" checked disabled> Keep me signed in</label><button type="button" class="text-button" data-action="forgot-password">Forgot password?</button></div>'
      +'<button class="button primary full" type="submit" '+(state.loading?'disabled':'')+'>'+(state.loading?'<span class="spinner"></span> Signing in…':'Sign in securely')+'</button></form>'
      +'<div class="divider">or</div><button class="button tonal full google-button" data-action="google-signin" '+(state.loading?'disabled':'')+'><span class="google-dot">G</span>Continue with Google</button>'
      +'<p class="supporting" style="text-align:center">New to Savrivo? <button class="text-button" data-action="go" data-route="signup">Create an account</button></p></div>'
      +'<p class="caption" style="text-align:center">Protected by Firebase Authentication. Savrivo never sees your password.</p></main>';
  }
  function screenSignup() {
    return '<main class="screen no-nav"><div class="screen-content">'+topbar("Create account","Your details stay connected to your own account.")
      +networkBanner()+'<form id="signup-form" class="form-grid" novalidate><div class="field"><label for="signup-name">Full name</label><input class="input" id="signup-name" name="name" autocomplete="name" placeholder="Your full name" required><div class="field-error" data-error-for="signup-name"></div></div>'
      +'<div class="field"><label for="signup-email">Email address</label><input class="input" id="signup-email" name="email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" required><div class="field-error" data-error-for="signup-email"></div></div>'
      +'<div class="field"><label for="signup-phone">Mobile number</label><input class="input" id="signup-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="10-digit mobile number" required><div class="field-error" data-error-for="signup-phone"></div></div>'
      +passwordField("signup-password","Create password","new-password")+passwordField("signup-confirm","Confirm password","new-password")
      +'<label class="notice info"><input id="signup-consent" type="checkbox" required><span>I agree to the Terms of Service and acknowledge the Privacy Notice.</span></label>'
      +'<button class="button primary full" type="submit" '+(state.loading?'disabled':'')+'>'+(state.loading?'<span class="spinner"></span> Creating account…':'Create my account')+'</button></form>'
      +'<div class="divider" style="margin:22px 0">or</div><button class="button tonal full" data-action="google-signin" '+(state.loading?'disabled':'')+'><span class="google-dot">G</span>Sign up with Google</button></div></main>';
  }
  function screenVerifyEmail() {
    return '<main class="screen no-nav auth-screen"><div class="screen-content auth-card">'+authHeader("Verify your email.","Open the newest Savrivo verification message sent to your account, then return here.")
      +networkBanner()+'<section class="card stack-lg"><div class="notice info">'+icon("shield","small")+'<span>Verification protects your orders, saved addresses and account recovery.</span></div><div><p class="eyebrow">Verification sent to</p><h2 class="section-title" style="margin-top:7px">'+h(state.profile.email||state.session&&state.session.email||"")+'</h2></div><button class="button primary full" data-action="check-verification" '+(state.loading?'disabled':'')+'>'+(state.loading?'<span class="spinner"></span> Checking…':'I verified my email')+'</button><button class="button tonal full" data-action="resend-verification">Send a new verification email</button><button class="text-button" data-action="signout">Use another account</button></section><p class="caption" style="text-align:center">Use only the newest message. If it is not in Inbox, check Spam and mark Savrivo as safe.</p></div></main>';
  }

  function homeHeader() {
    const address=currentAddress();
    return '<header class="cluster between"><button class="location-pill" data-action="go" data-route="addresses" aria-label="Change delivery location"><span class="location-dot">'+icon("target")+'</span><span class="location-copy"><span>Deliver to</span><strong>'+(address?h(address.label||address.area):"Choose a location")+'</strong></span>'+icon("chevron","small")+'</button><button class="avatar" data-action="go" data-route="account" aria-label="Open account">'+h(initials())+'</button></header>';
  }
  function orderProgress(order) { const progress=Math.min(100,Math.max(6,(statusIndex(order.status)+1)/ORDER_FLOW.length*100)); return progress; }
  function activeOrderCard(order) {
    return '<button class="active-order" data-action="open-order" data-order-id="'+h(order.id)+'"><div class="cluster between"><span class="status-pill" style="background:rgba(255,255,255,.18);color:white">'+h(order.status)+'</span><strong>'+h(etaText(order))+'</strong></div><div><h2 class="section-title">'+h(order.restaurant||"Your order")+'</h2><p class="supporting">'+h((order.items||[]).map(x=>(x.quantity||1)+'× '+x.name).slice(0,2).join(" · "))+'</p></div><div class="status-progress"><span style="width:'+orderProgress(order)+'%"></span></div><div class="cluster between supporting"><span>Order '+h(order.id)+'</span><span>View journey '+icon("chevron","small")+'</span></div></button>';
  }
  function cuisineList() {
    const all=new Set(["All"]);Object.values(state.catalog).forEach(r=>(r.cuisines||[]).forEach(c=>all.add(c)));
    return Array.from(all).slice(0,9);
  }
  function restaurantsFiltered() {
    let list=Object.values(state.catalog).filter(r=>r.archived!==true);
    if(state.cuisine!=="All")list=list.filter(r=>(r.cuisines||[]).includes(state.cuisine));
    if(state.profile.preferences.vegetarian||state.diet==="veg")list=list.filter(r=>(r.menu||[]).some(i=>i.diet==="veg"&&i.available!==false));
    const q=state.query.trim().toLowerCase();
    if(q)list=list.filter(r=>[r.name,(r.cuisines||[]).join(" "),...(r.menu||[]).map(i=>i.name+" "+i.description)].join(" ").toLowerCase().includes(q));
    if(state.sort==="rating")list.sort((a,b)=>Number(b.rating||0)-Number(a.rating||0));
    else if(state.sort==="delivery")list.sort((a,b)=>Number(a.etaMin||99)-Number(b.etaMin||99));
    else if(state.sort==="fee")list.sort((a,b)=>Number(a.deliveryFee||0)-Number(b.deliveryFee||0));
    else list.sort((a,b)=>(Number(b.featured||false)-Number(a.featured||false))||(Number(b.rating||0)-Number(a.rating||0)));
    return list;
  }
  function restaurantCard(r,horizontal) {
    const liked=(state.profile.favourites||[]).includes(r.id);
    return '<article class="restaurant-card '+(horizontal?'horizontal':'')+'" data-action="open-restaurant" data-restaurant-id="'+h(r.id)+'" tabindex="0" role="button" aria-label="Open '+h(r.name)+'"><div class="restaurant-media"><img src="'+h(safeUrl(r.image,"veg-meal.jpg"))+'" alt="'+h(r.name)+'"><span class="media-badge">'+(r.open?'Open now':'Currently closed')+'</span><button class="heart-button '+(liked?'liked':'')+'" data-action="toggle-favourite" data-restaurant-id="'+h(r.id)+'" aria-label="'+(liked?'Remove from':'Add to')+' favourites">'+icon("heart")+'</button></div><div class="restaurant-copy"><div class="cluster between"><h3 class="card-title">'+h(r.name)+'</h3><span class="rating">'+icon("star","small")+' '+h(r.rating||"New")+'</span></div><p class="supporting">'+h((r.cuisines||[]).join(" · "))+'</p><div class="restaurant-meta"><span>'+icon("clock","small")+' '+h(r.etaMin||25)+'–'+h(r.etaMax||35)+' min</span><span>•</span><span>'+(Number(r.deliveryFee||0)===0?'Free delivery':money(r.deliveryFee)+' delivery')+'</span></div></div></article>';
  }
  function screenHome() {
    const active=activeOrders()[0], restaurants=restaurantsFiltered();
    return '<main class="screen"><div class="screen-content page-stack">'+networkBanner()+homeHeader()
      +'<section><p class="eyebrow">'+(new Date().getHours()<12?'Good morning':new Date().getHours()<17?'Good afternoon':'Good evening')+'</p><h1 class="display" style="font-size:34px;margin-top:5px">What tastes good,<br>'+h(firstName())+'?</h1></section>'
      +(active?activeOrderCard(active):'')
      +'<button class="search-trigger" data-action="go" data-route="search">'+icon("search")+'<span>Search dishes, restaurants or cuisines</span></button>'
      +'<section class="card brand-card promo-card"><div><p class="eyebrow" style="color:#bfe9ff">SAVRIVO STANDARD</p><h2 class="section-title" style="font-size:25px;margin-top:7px">Clear pricing. Careful delivery.</h2><p class="supporting" style="margin-top:8px">Every charge is shown before you place an order.</p></div><span class="promo-code">NO SURPRISES</span></section>'
      +'<section class="stack"><div class="cluster between"><h2 class="section-title">Explore by taste</h2><button class="text-button" data-action="go" data-route="search">See all</button></div><div class="chip-row">'+cuisineList().map(c=>'<button class="chip '+(state.cuisine===c?'active':'')+'" data-action="cuisine" data-value="'+h(c)+'">'+h(c)+'</button>').join("")+'</div></section>'
      +'<section class="stack"><div class="cluster between"><div><h2 class="section-title">Top picks near you</h2><p class="supporting">Based on availability in your area</p></div><button class="text-button" data-action="go" data-route="search">View all</button></div>'
      +(state.loading?loadingRow("Refreshing restaurants…"):restaurants.length?'<div class="restaurant-list">'+restaurants.slice(0,5).map(r=>restaurantCard(r,true)).join("")+'</div>':emptyState("search","No restaurants are live","The operations team has not published restaurants for this location yet.","refresh","Refresh"))+'</section>'
      +(state.catalogMode==="packaged"?'<div class="notice info">'+icon("info","small")+'<div><strong>Developer catalogue</strong><div class="caption">Packaged sample data is shown until Savrivo Control publishes the live catalogue.</div></div></div>':'')
      +'</div>'+nav()+'</main>';
  }

  function searchResultMarkup() {
    const results=restaurantsFiltered();
    return results.length?'<div class="restaurant-list two-column">'+results.map(r=>restaurantCard(r,false)).join("")+'</div>':emptyState("search","Nothing matched","Try another dish, cuisine or filter.","clear-search","Clear search");
  }
  function screenSearch() {
    return '<main class="screen"><div class="screen-content page-stack">'+topbar("Find your next meal","Search live menus, cuisines and restaurants.",'<button class="icon-button" data-action="open-filters" aria-label="Open filters">'+icon("filter")+'</button>')+networkBanner()
      +'<div class="input-wrap"><span class="input-icon">'+icon("search")+'</span><input id="search-input" class="input with-icon with-action" value="'+h(state.query)+'" placeholder="Try biryani, pizza or 55 Bistro" autocomplete="off" enterkeyhint="search" aria-label="Search"><button class="icon-button flat input-action" data-action="clear-search" aria-label="Clear search">'+icon("close")+'</button></div>'
      +'<div class="chip-row">'+cuisineList().map(c=>'<button class="chip '+(state.cuisine===c?'active':'')+'" data-action="cuisine" data-value="'+h(c)+'">'+h(c)+'</button>').join("")+'</div>'
      +'<div id="search-results">'+searchResultMarkup()+'</div></div>'+nav()+'</main>';
  }

  function restaurantMenu(r) {
    let items=(r.menu||[]).filter(item=>state.selectedMenuCategory==="All"||item.category===state.selectedMenuCategory);
    if(state.diet==="veg"||state.profile.preferences.vegetarian)items=items.filter(x=>x.diet==="veg");
    if(state.diet==="nonveg")items=items.filter(x=>x.diet==="nonveg");
    const grouped={};items.forEach(item=>(grouped[item.category||"Menu"]||(grouped[item.category||"Menu"]=[])).push(item));
    return Object.keys(grouped).map(category=>'<section class="stack"><div><h2 class="section-title">'+h(category)+'</h2><p class="supporting">'+grouped[category].length+' item'+(grouped[category].length===1?'':'s')+'</p></div><div class="menu-list">'+grouped[category].map(item=>{
      const inCart=state.cart.filter(x=>x.restaurantId===r.id&&x.itemId===item.id).reduce((n,x)=>n+x.quantity,0);
      return '<article class="menu-item"><div class="menu-copy"><span class="diet-mark '+(item.diet==="nonveg"?'nonveg':'')+'" aria-label="'+(item.diet==="nonveg"?'Non-vegetarian':'Vegetarian')+'"></span><h3 class="card-title">'+h(item.name)+'</h3><strong>'+money(item.price)+'</strong><p class="supporting">'+h(item.description||"")+'</p>'+(item.popular?'<span class="caption success-text">Popular choice</span>':'')+(item.available===false?'<span class="caption danger-text">Unavailable right now</span>':'')+'</div><div class="menu-media"><img src="'+h(safeUrl(item.image,r.image))+'" alt="'+h(item.name)+'">'+(item.available===false?'':inCart?'<button class="add-button" data-action="open-item" data-restaurant-id="'+h(r.id)+'" data-item-id="'+h(item.id)+'">'+inCart+' in cart · Edit</button>':'<button class="add-button" data-action="open-item" data-restaurant-id="'+h(r.id)+'" data-item-id="'+h(item.id)+'">ADD +</button>')+'</div></article>';
    }).join("")+'</div></section>').join("") || emptyState("search","No items in this filter","Try another menu category or dietary filter.","clear-menu-filter","Show full menu");
  }
  function screenRestaurant() {
    const r=restaurant();if(!r)return'<main class="screen"><div class="screen-content">'+topbar("Restaurant unavailable","This restaurant is no longer in the live catalogue.")+emptyState("search","Restaurant unavailable","Return home to find another restaurant.","go-home","Back to home")+'</div>'+nav()+'</main>';
    const categories=["All",...new Set((r.menu||[]).map(x=>x.category||"Menu"))];const liked=(state.profile.favourites||[]).includes(r.id);
    return '<main class="screen flush"><div class="screen-content"><section class="restaurant-hero"><img src="'+h(safeUrl(r.image,"55-bistro.jpg"))+'" alt="'+h(r.name)+' restaurant"><div class="restaurant-hero-actions"><button class="icon-button" data-action="back" aria-label="Go back">'+icon("back")+'</button><button class="icon-button '+(liked?'active':'')+'" data-action="toggle-favourite" data-restaurant-id="'+h(r.id)+'" aria-label="'+(liked?'Remove from':'Add to')+' favourites">'+icon("heart")+'</button></div><div class="restaurant-hero-copy"><h1 class="page-title" style="font-size:30px">'+h(r.name)+'</h1><p class="supporting">'+h((r.cuisines||[]).join(" · "))+'</p></div></section>'
      +'<div class="restaurant-body">'+networkBanner()+'<section class="service-strip"><div class="service-stat"><strong>'+h(r.rating||"New")+' ★</strong><span>Rating</span></div><div class="service-stat"><strong>'+h(r.etaMin||25)+'–'+h(r.etaMax||35)+' min</strong><span>Delivery</span></div><div class="service-stat"><strong>'+(Number(r.deliveryFee||0)===0?'Free':money(r.deliveryFee))+'</strong><span>Delivery fee</span></div></section>'
      +'<div class="notice '+(r.open?'success':'warning')+'">'+icon(r.open?'check':'clock',"small")+'<div><strong>'+(r.open?'Accepting orders':'Currently closed')+'</strong><div class="caption">'+h(r.address||"Location provided by the restaurant")+(r.opensUntil?' · Until '+h(r.opensUntil):'')+'</div></div></div>'
      +'<section class="stack"><div class="cluster between"><div><h2 class="section-title">Menu</h2><p class="supporting">Choose items and customise before adding.</p></div><button class="chip '+(state.diet==="veg"?'success':'')+'" data-action="toggle-veg">Veg only</button></div><div class="chip-row">'+categories.map(c=>'<button class="chip '+(state.selectedMenuCategory===c?'active':'')+'" data-action="menu-category" data-value="'+h(c)+'">'+h(c)+'</button>').join("")+'</div></section>'+restaurantMenu(r)
      +'<section class="card flat stack"><h2 class="section-title">About this restaurant</h2><p class="supporting">'+h(r.description||r.address||"Restaurant information is maintained by Savrivo Control.")+'</p><div class="restaurant-meta"><span>'+icon("clock","small")+' '+(r.open?'Open now':'Closed')+'</span><span>•</span><span>Approx. '+money(r.priceForTwo||500)+' for two</span></div></section></div></div>'
      +(cartCount()?'<div class="floating-cart"><button class="button primary full" data-action="go" data-route="cart"><span>'+cartCount()+' item'+(cartCount()===1?'':'s')+'</span><span>View cart · '+money(orderTotal())+'</span></button></div>':'')+nav()+'</main>';
  }

  function cartItemMarkup(item) {
    return '<article class="cart-item"><img class="cart-thumb" src="'+h(safeUrl(item.image,"veg-meal.jpg"))+'" alt=""><div class="grow"><h3 class="card-title">'+h(item.name)+'</h3><p class="caption">'+h([item.variant,(item.addOns||[]).map(x=>x.name).join(", ")].filter(Boolean).join(" · ")||item.restaurantName)+'</p><strong>'+money((item.price+item.variantPrice+item.addOnTotal)*item.quantity)+'</strong></div><div class="quantity-control"><button data-action="cart-quantity" data-key="'+h(item.key)+'" data-delta="-1" aria-label="Remove one">−</button><span>'+item.quantity+'</span><button data-action="cart-quantity" data-key="'+h(item.key)+'" data-delta="1" aria-label="Add one">+</button></div></article>';
  }
  function priceBreakdown(includeTotal) {
    return '<div class="stack"><div class="price-row"><span>Item subtotal</span><span>'+money(cartSubtotal())+'</span></div>'+(discount()?'<div class="price-row success-text"><span>'+h(state.coupon.code)+' discount</span><span>−'+money(discount())+'</span></div>':'')+'<div class="price-row"><span>Delivery fee</span><span>'+(deliveryFee()?money(deliveryFee()):'<span class="success-text">Free</span>')+'</span></div><div class="price-row"><span>Platform fee</span><span>'+money(platformFee())+'</span></div>'+(tax()?'<div class="price-row"><span>Taxes</span><span>'+money(tax())+'</span></div>':'')+(state.tip?'<div class="price-row"><span>Delivery tip</span><span>'+money(state.tip)+'</span></div>':'')+(includeTotal?'<div class="price-row total"><span>Order total</span><span>'+money(orderTotal())+'</span></div>':'')+'</div>';
  }
  function screenCart() {
    const r=cartRestaurant();
    return '<main class="screen"><div class="screen-content page-stack">'+topbar("Your cart",r?r.name:"Ready when you are")+networkBanner()
      +(state.cart.length?'<section class="card stack-lg">'+state.cart.map(cartItemMarkup).join("")+'<button class="text-button" data-action="open-restaurant" data-restaurant-id="'+h(r.id)+'">+ Add more from '+h(r.name)+'</button></section><section class="card stack"><h2 class="section-title">Savings</h2><div class="coupon-row"><input id="coupon-input" class="input" placeholder="Enter offer code" value="'+h(state.coupon&&state.coupon.code||"")+'"><button class="button secondary" data-action="apply-coupon">Apply</button></div><p class="caption">Only live, eligible Savrivo promotions can be applied.</p></section><section class="card">'+priceBreakdown(true)+'</section><button class="button primary full" data-action="go-checkout" '+(!state.online?'disabled':'')+'>Continue to checkout · '+money(orderTotal())+'</button>':emptyState("cart","Your cart is empty","Browse restaurants and add something you will enjoy.","go-home","Explore restaurants"))+'</div>'+nav()+'</main>';
  }

  function addressSummary(address) {
    if(!address)return'<div class="notice warning">'+icon("warning","small")+'<div><strong>No delivery address selected</strong><div class="caption">Add an address with a mobile number before placing your order.</div></div></div>';
    return '<div class="cluster"><span class="settings-icon">'+icon("address")+'</span><div class="grow"><strong>'+h(address.label||address.area||"Delivery address")+'</strong><p class="supporting">'+h(address.address||address.details||"")+'</p><p class="caption">'+h(address.phone||state.profile.phone||"Mobile number required")+(Number.isFinite(Number(address.lat))?' · Location pin saved':' · Location pin needed for proximity alerts')+'</p></div></div>';
  }
  function paymentOption(id,title,copy,enabled) {
    return '<button class="settings-row" data-action="select-payment" data-value="'+h(id)+'" '+(enabled?'':'disabled')+'><span class="settings-icon">'+icon(id==="cod"?"receipt":"card")+'</span><span class="grow"><strong>'+h(title)+'</strong><span class="supporting">'+h(copy)+'</span></span><span class="'+(state.checkout.payment===id?'status-pill success':'caption')+'">'+(state.checkout.payment===id?'Selected':enabled?'Choose':'Connect gateway')+'</span></button>';
  }
  function screenCheckout() {
    const address=currentAddress();
    return '<main class="screen"><div class="screen-content page-stack">'+topbar("Review your order","Confirm contact, delivery and payment details.")+networkBanner()
      +'<section class="card stack"><div class="cluster between"><h2 class="section-title">Delivering to</h2><button class="text-button" data-action="go" data-route="addresses">Change</button></div>'+addressSummary(address)+'</section>'
      +'<section class="card stack"><h2 class="section-title">Delivery time</h2><div class="segmented"><button class="segment '+(state.checkout.deliveryMode==="asap"?'active':'')+'" data-action="delivery-mode" data-value="asap">As soon as possible</button><button class="segment '+(state.checkout.deliveryMode==="scheduled"?'active':'')+'" data-action="delivery-mode" data-value="scheduled">Schedule</button></div>'+(state.checkout.deliveryMode==="scheduled"?'<div class="notice info">'+icon("clock","small")+'<span>Scheduled delivery needs restaurant and dispatch scheduling services. It will be activated with the production backend.</span></div>':'')+'</section>'
      +'<section class="card stack"><h2 class="section-title">Delivery preferences</h2><label class="field"><span>Instructions for the rider</span><textarea id="checkout-instructions" class="textarea" maxlength="180" placeholder="Landmark, gate or delivery note">'+h(state.checkout.instructions)+'</textarea></label><button class="settings-row" data-action="toggle-contactless"><span class="settings-icon">'+icon("shield")+'</span><span class="grow"><strong>Contactless delivery</strong><span class="supporting">Leave the order at the door and notify me.</span></span><span class="switch '+(state.checkout.contactless?'on':'')+'" aria-hidden="true"></span></button></section>'
      +'<section class="card settings-list"><div style="padding:18px 16px 8px"><h2 class="section-title">Payment</h2><p class="supporting">Only activated payment methods can be selected.</p></div>'+paymentOption("cod","Cash on delivery","Pay the rider at delivery.",true)+paymentOption("upi","UPI","Requires a production payment gateway.",false)+paymentOption("card","Card","Requires a PCI-compliant payment gateway.",false)+'</section>'
      +'<section class="card">'+priceBreakdown(true)+'</section><div class="notice info">'+icon("shield","small")+'<span>This developer build creates a cash-on-delivery order. Online payment will never be simulated as successful.</span></div>'
      +'<button class="button primary full" data-action="place-order" '+(!address||!state.online||state.loading||!state.cart.length?'disabled':'')+'>'+(state.loading?'<span class="spinner"></span> Placing order…':'Place cash order · '+money(orderTotal()))+'</button></div>'+nav()+'</main>';
  }

  function orderItemsSummary(order) {
    return (order.items||[]).map(item=>'<div class="price-row"><span>'+h(item.quantity||1)+' × '+h(item.name)+(item.variant?' · '+h(item.variant):'')+'</span><span>'+money((Number(item.price||0)+Number(item.variantPrice||0)+Number(item.addOnTotal||0))*Number(item.quantity||1))+'</span></div>').join("");
  }
  function orderCard(order) {
    return '<article class="card order-card" data-action="open-order" data-order-id="'+h(order.id)+'" tabindex="0" role="button"><div class="cluster between"><span class="status-pill '+statusTone(order.status)+'">'+h(order.status||"Order placed")+'</span><strong>'+money(order.total)+'</strong></div><div><h2 class="card-title">'+h(order.restaurant||"Restaurant")+'</h2><p class="supporting">'+h((order.items||[]).map(x=>(x.quantity||1)+'× '+x.name).slice(0,2).join(" · "))+'</p></div><div class="cluster between caption"><span>'+h(order.id)+' · '+h(timeAgo(order.createdAt))+'</span><span>'+icon("chevron","small")+'</span></div></article>';
  }
  function screenOrders() {
    const active=state.orders.filter(o=>!TERMINAL_STATES.has(o.status)),past=state.orders.filter(o=>TERMINAL_STATES.has(o.status));
    return '<main class="screen"><div class="screen-content page-stack">'+networkBanner()+'<header class="cluster between"><div><p class="eyebrow">Your orders</p><h1 class="page-title">Every journey, in one place.</h1></div><button class="icon-button" data-action="refresh" aria-label="Refresh orders">'+icon("refresh")+'</button></header>'
      +(state.loading?loadingRow("Checking live orders…"):'')
      +(active.length?'<section class="stack"><div><h2 class="section-title">In progress</h2><p class="supporting">Live status and rider updates</p></div>'+active.map(orderCard).join("")+'</section>':'')
      +(past.length?'<section class="stack"><div><h2 class="section-title">Past orders</h2><p class="supporting">Receipts, reorder and support</p></div>'+past.map(orderCard).join("")+'</section>':'')
      +(!state.orders.length&&!state.loading?emptyState("orders","No orders yet","Your first Savrivo order will appear here.","go-home","Explore restaurants"):'')+'</div>'+nav()+'</main>';
  }

  function statusTimeline(order) {
    const current=statusIndex(order.status);const cancelled=order.status==="Cancelled";
    const visible=ORDER_FLOW.filter((status,index)=>index<=Math.max(current+1,3)||index===ORDER_FLOW.length-1);
    return '<div class="timeline">'+visible.map((status,index)=>{
      const fullIndex=ORDER_FLOW.indexOf(status),done=!cancelled&&fullIndex<current,active=!cancelled&&fullIndex===current;
      const event=order.statusHistory&&Object.values(order.statusHistory).find(x=>x.status===status);
      return '<div class="timeline-step '+(done?'done':active?'active':'')+'"><span class="timeline-dot"></span><div class="timeline-copy"><strong>'+h(status)+'</strong><span>'+(event?h(dateTime(event.at||event.createdAt)):active?'Current status':'')+'</span></div></div>';
    }).join("")+(cancelled?'<div class="timeline-step active"><span class="timeline-dot" style="border-color:var(--danger)"></span><div class="timeline-copy"><strong class="danger-text">Cancelled</strong><span>'+h(order.cancelReason||"Order was cancelled")+'</span></div></div>':'')+'</div>';
  }
  function screenOrder() {
    const order=orderById();if(!order)return'<main class="screen"><div class="screen-content">'+topbar("Order unavailable","This order is not in your account cache.")+emptyState("orders","Order not found","Refresh your orders and try again.","refresh","Refresh orders")+'</div>'+nav()+'</main>';
    const tracking=state.tracking[order.id];const canTrack=["Assigned","Handed to rider","Out for delivery","Near you","Arrived"].includes(order.status);
    const showDeliveryOtp=["Out for delivery","Near you","Arrived"].includes(order.status),deliveryOtp=state.deliveryOtps[order.id];
    return '<main class="screen"><div class="screen-content page-stack">'+topbar("Order "+order.id,order.restaurant||"Order details")+networkBanner()
      +'<section class="card brand-card stack"><div class="cluster between"><span class="status-pill" style="background:rgba(255,255,255,.17);color:white">'+h(order.status)+'</span><strong>'+h(etaText(order))+'</strong></div><h2 class="section-title" style="font-size:25px">'+(order.status==="Delivered"?'Delivered with care.':order.status==="Cancelled"?'This order was cancelled.':'Your order is moving forward.')+'</h2><p class="supporting">Last updated '+h(timeAgo(order.updatedAt||order.createdAt))+'</p>'+(canTrack?'<button class="button" style="background:white;color:#155eef" data-action="open-tracking" data-order-id="'+h(order.id)+'">'+icon("pin")+' Open live tracking</button>':'')+'</section>'
      +(showDeliveryOtp?'<section class="card stack" aria-label="Delivery verification code"><div><p class="eyebrow">Delivery OTP</p><h2 class="section-title">Share only at your doorstep.</h2><p class="supporting">Give this code to your assigned Savrivo Partner only after you receive the complete order.</p></div>'+(deliveryOtp?'<div style="font-size:36px;line-height:1;font-weight:850;letter-spacing:.24em;color:var(--primary);padding:10px 0" aria-label="Delivery code '+h(deliveryOtp.split("").join(" "))+'">'+h(deliveryOtp)+'</div>':'<div class="notice warning">'+icon("warning","small")+'<span>This code is available only on the device that placed the order. Use in-app support if you changed devices.</span></div>')+'</section>':'')
      +'<section class="card stack"><div><h2 class="section-title">Order journey</h2><p class="supporting">Restaurant and rider events are shown as they happen.</p></div>'+statusTimeline(order)+'</section>'
      +(order.riderName?'<section class="card cluster"><span class="avatar">'+h(String(order.riderName).slice(0,1).toUpperCase())+'</span><div class="grow"><h2 class="card-title">'+h(order.riderName)+'</h2><p class="supporting">Your assigned Savrivo Partner</p></div><span class="status-pill '+(tracking&&tracking.status==="live"?'success':'')+'">'+(tracking&&tracking.status==="live"?'Tracking live':'Assigned')+'</span></section>':'')
      +'<section class="card stack"><div class="cluster between"><h2 class="section-title">Items</h2><strong>'+money(order.total)+'</strong></div>'+orderItemsSummary(order)+'<div class="price-row total"><span>Paid / due</span><span>'+h(order.paymentMethod==="cod"||order.paymentMethod==="Cash on delivery"?'Cash on delivery':order.paymentMethod||"Payment")+'</span></div></section>'
      +'<section class="card stack"><h2 class="section-title">Delivery details</h2>'+addressSummary(order.address||{})+(order.instructions?'<div class="notice info">'+icon("info","small")+'<span>'+h(order.instructions)+'</span></div>':'')+'</section>'
      +'<div class="cluster wrap">'+(order.status==="Delivered"?'<button class="button secondary grow" data-action="reorder" data-order-id="'+h(order.id)+'">'+icon("refresh")+' Reorder</button><button class="button tonal grow" data-action="review-order" data-order-id="'+h(order.id)+'">'+icon("star")+' Rate order</button>':'')+(["Order placed","Accepted"].includes(order.status)?'<button class="button danger grow" data-action="cancel-order" data-order-id="'+h(order.id)+'">Request cancellation</button>':'')+'<button class="button tonal grow" data-action="support-order" data-order-id="'+h(order.id)+'">'+icon("help")+' Get help</button></div>'
      +'</div>'+nav()+'</main>';
  }

  function tileFor(lat,lng,zoom) {
    if(!Number.isFinite(lat)||!Number.isFinite(lng))return"";const z=zoom||15,n=Math.pow(2,z),x=Math.floor((lng+180)/360*n),y=Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*n);return"https://tile.openstreetmap.org/"+z+"/"+x+"/"+y+".png";
  }
  function screenTracking() {
    const order=orderById();if(!order)return screenOrder();
    const live=state.tracking[order.id]||{},lat=Number(live.lat),lng=Number(live.lng),fresh=live.updatedAt&&Date.now()-Number(live.updatedAt)<45000;
    const tile=tileFor(lat,lng,15);
    return '<main class="screen"><div class="screen-content page-stack">'+topbar("Live delivery",order.restaurant||order.id)+networkBanner()
      +'<section class="card map-card"><div class="map-canvas" '+(tile?'style="background-image:linear-gradient(rgba(220,235,243,.18),rgba(220,235,243,.18)),url('+h(tile)+')"':'')+'></div><span class="map-pin rider">'+icon("pin")+'</span><span class="map-pin home">'+icon("home")+'</span><div class="map-overlay"><div class="cluster between"><div><strong>'+(fresh?'Location updated '+h(timeAgo(live.updatedAt)):'Waiting for a fresh rider location')+'</strong><p class="caption">Location-only map · © OpenStreetMap contributors</p></div><span class="status-pill '+(fresh?'success':'warning')+'">'+(fresh?'LIVE':'STALE')+'</span></div></div></section>'
      +'<section class="card brand-card stack"><div class="cluster between"><span class="status-pill" style="background:rgba(255,255,255,.17);color:white">'+h(order.status)+'</span><strong>'+h(etaText(order))+'</strong></div><h1 class="page-title">'+(order.status==="Arrived"?'Your partner is at the delivery location.':order.status==="Near you"?'Your partner is nearby.':'Your meal is on the way.')+'</h1><p class="supporting">'+(live.riderName?h(live.riderName)+' is sharing location for this active order.':'Tracking begins after a partner is assigned and starts delivery.')+'</p></section>'
      +'<section class="card stack"><h2 class="section-title">Tracking health</h2><div class="price-row"><span>Last location</span><strong>'+h(live.updatedAt?dateTime(live.updatedAt):"Not received")+'</strong></div><div class="price-row"><span>Accuracy</span><strong>'+h(live.accuracy?Math.round(live.accuracy)+" m":"Not available")+'</strong></div><div class="price-row"><span>Sharing state</span><strong>'+h(live.status||"Waiting")+'</strong></div></section><div class="notice info">'+icon("shield","small")+'<span>Location is visible only for this active order and must be removed by the production retention service after completion.</span></div><button class="button tonal full" data-action="refresh">'+icon("refresh")+' Refresh tracking</button></div>'+nav()+'</main>';
  }

  function promoCard(promo) {
    const eligibility=promo.minimumOrder?"Minimum order "+money(promo.minimumOrder):"See terms before checkout";
    return '<article class="card brand-card stack"><div class="cluster between"><span class="eyebrow" style="color:#bfe9ff">'+h(promo.label||"LIVE OFFER")+'</span><span class="status-pill" style="background:rgba(255,255,255,.17);color:white">'+h(promo.code||"Offer")+'</span></div><h2 class="section-title" style="font-size:25px">'+h(promo.title||((promo.percent||0)+"% off"))+'</h2><p class="supporting">'+h(promo.description||eligibility)+'</p><button class="button" style="background:white;color:#155eef" data-action="use-promo" data-promo-id="'+h(promo.id)+'">Use '+h(promo.code||"offer")+'</button></article>';
  }
  function screenOffers() {
    return '<main class="screen"><div class="screen-content page-stack">'+networkBanner()+'<header><p class="eyebrow">Savings</p><h1 class="page-title">Offers with clear terms.</h1><p class="supporting" style="margin-top:7px">Only active promotions published by Savrivo Control appear here.</p></header>'
      +(state.promotions.length?'<section class="stack-lg">'+state.promotions.map(promoCard).join("")+'</section>':emptyState("offers","No live offers right now","We will show a promotion here only when its eligibility and discount are actually active.","go-home","Browse restaurants"))
      +'<section class="card stack"><h2 class="section-title">How offers work</h2><div class="notice info">'+icon("info","small")+'<span>Eligibility is checked again against the live promotion at checkout. Expired or restaurant-limited codes are never shown as applied.</span></div></section></div>'+nav()+'</main>';
  }

  function settingsRow(ic,title,copy,route,action,tail) {
    return '<button class="settings-row" '+(route?'data-action="go" data-route="'+h(route)+'"':'data-action="'+h(action||"")+'"')+'><span class="settings-icon">'+icon(ic)+'</span><span class="grow"><strong>'+h(title)+'</strong>'+(copy?'<span class="supporting">'+h(copy)+'</span>':'')+'</span>'+(tail||icon("chevron","small"))+'</button>';
  }
  function screenAccount() {
    return '<main class="screen"><div class="screen-content page-stack">'+networkBanner()+'<header><p class="eyebrow">Your account</p><h1 class="page-title">Details, preferences and help.</h1></header>'
      +'<section class="card brand-card cluster"><span class="avatar" style="width:58px;height:58px;background:rgba(255,255,255,.18)">'+h(initials())+'</span><div class="grow"><h2 class="section-title">'+h(state.profile.name||"Savrivo customer")+'</h2><p class="supporting">'+h(state.profile.email||state.session&&state.session.email||"")+'</p><p class="caption" style="color:rgba(255,255,255,.72)">'+h(state.profile.phone||"Add your mobile number")+'</p></div><button class="icon-button" style="background:rgba(255,255,255,.16);color:white;border:0;box-shadow:none" data-action="edit-profile" aria-label="Edit profile">'+icon("chevron")+'</button></section>'
      +'<section class="card settings-list">'+settingsRow("address","Saved addresses",(state.profile.addresses||[]).length+" saved","addresses")+settingsRow("heart","Favourite restaurants",(state.profile.favourites||[]).length+" saved","favourites")+settingsRow("card","Payment methods","Cash on delivery active",null,"payment-info")+'</section>'
      +'<section class="card settings-list">'+settingsRow("settings","Preferences","Theme, dietary and notifications","preferences")+settingsRow("help","Help and support","Order issues and account help","support")+settingsRow("shield","Privacy and terms","Data use, rights and service terms","legal")+'</section>'
      +'<section class="card settings-list">'+settingsRow("logout","Sign out","Remove this account from this device",null,"confirm-signout")+settingsRow("trash","Delete account request","Request permanent account and data deletion",null,"request-deletion",'<span class="danger-text">'+icon("chevron","small")+'</span>')+'</section>'
      +'<p class="caption" style="text-align:center">Savrivo Customer · Developer build 3.0<br>Operational data is synced to the configured Firebase project.</p></div>'+nav()+'</main>';
  }

  function addressCard(address) {
    const selected=address.id===state.profile.selectedAddressId;
    return '<article class="card stack"><div class="cluster"><span class="settings-icon">'+icon(address.source==="gps"?"target":"address")+'</span><div class="grow"><div class="cluster wrap"><h2 class="card-title">'+h(address.label||"Address")+'</h2>'+(selected?'<span class="status-pill success">Selected</span>':'')+'</div><p class="supporting">'+h(address.address||address.details||"")+'</p><p class="caption">'+h(address.phone||"Mobile number missing")+(Number.isFinite(Number(address.lat))?' · GPS pin saved':' · GPS pin not saved')+'</p></div></div><div class="cluster"><button class="button secondary grow" data-action="select-address" data-address-id="'+h(address.id)+'" '+(selected?'disabled':'')+'>'+(selected?'Current delivery address':'Deliver here')+'</button><button class="icon-button" data-action="edit-address" data-address-id="'+h(address.id)+'" aria-label="Edit '+h(address.label||"address")+'">'+icon("settings")+'</button></div></article>';
  }
  function screenAddresses() {
    const addresses=state.profile.addresses||[];
    return '<main class="screen"><div class="screen-content page-stack">'+topbar("Delivery addresses","A mobile number and location pin make delivery reliable.")+networkBanner()
      +'<button class="button primary full" data-action="detect-location" '+(state.locationBusy?'disabled':'')+'>'+(state.locationBusy?'<span class="spinner"></span> Detecting your location…':icon("target")+' Use my current location')+'</button>'
      +'<div class="notice info">'+icon("info","small")+'<span>If phone Location is off, Savrivo will ask you to turn it on. The pin is used for serviceability and delivery proximity alerts.</span></div>'
      +(addresses.length?'<section class="stack">'+addresses.map(addressCard).join("")+'</section>':emptyState("address","No saved addresses","Use your current location, then confirm the mobile number and delivery details."))
      +'<button class="button tonal full" data-action="add-address">'+icon("plus")+' Add address manually</button></div>'+nav()+'</main>';
  }

  function screenFavourites() {
    const list=(state.profile.favourites||[]).map(id=>state.catalog[id]).filter(Boolean);
    return '<main class="screen"><div class="screen-content page-stack">'+topbar("Favourites","Restaurants you saved for later.")+networkBanner()+(list.length?'<div class="restaurant-list two-column">'+list.map(r=>restaurantCard(r,false)).join("")+'</div>':emptyState("heart","No favourites yet","Tap the heart on a restaurant to keep it here.","go-home","Find restaurants"))+'</div>'+nav()+'</main>';
  }

  function preferenceSwitch(key,title,copy,enabled) {
    return '<button class="settings-row" data-action="toggle-preference" data-key="'+h(key)+'"><span class="grow"><strong>'+h(title)+'</strong><span class="supporting">'+h(copy)+'</span></span><span class="switch '+(enabled?'on':'')+'" aria-hidden="true"></span></button>';
  }
  function screenPreferences() {
    const prefs=state.profile.preferences||{};
    return '<main class="screen"><div class="screen-content page-stack">'+topbar("Preferences","Make Savrivo comfortable and relevant for you.")+networkBanner()
      +'<section class="card stack"><h2 class="section-title">Appearance</h2><div class="segmented">'+["light","dark"].map(value=>'<button class="segment '+(themeValue()===value?'active':'')+'" data-action="theme" data-value="'+value+'">'+(value==="light"?'Light':'Dark')+'</button>').join("")+'</div><button class="button tonal full" data-action="theme" data-value="system">Use phone setting</button></section>'
      +'<section class="card settings-list">'+preferenceSwitch("vegetarian","Vegetarian mode","Prioritise vegetarian restaurants and menu items.",prefs.vegetarian===true)+preferenceSwitch("notifications","Order notifications","Show local alerts when a live order status changes.",prefs.notifications!==false)+'</section>'
      +'<section class="notice info">'+icon("info","small")+'<span>Production push notifications require the Savrivo notification service. This developer build can notify only after it receives a live update.</span></section></div>'+nav()+'</main>';
  }

  function screenSupport() {
    const order=state.routeData.orderId?orderById(state.routeData.orderId):null;
    return '<main class="screen"><div class="screen-content page-stack">'+topbar("Help and support",order?'About order '+order.id:'Tell us what you need')+networkBanner()
      +'<section class="card stack"><h2 class="section-title">Quick help</h2><div class="notice info">'+icon("chat","small")+'<span>Support tickets are saved to your account. A production support team and response SLA must be activated before public launch.</span></div></section>'
      +'<form id="support-form" class="card form-grid"><div class="field"><label for="support-topic">Topic</label><select id="support-topic" class="select" name="topic"><option>Order status</option><option>Missing or incorrect item</option><option>Delivery issue</option><option>Payment or refund</option><option>Account and privacy</option><option>Other</option></select></div><div class="field"><label for="support-message">What happened?</label><textarea id="support-message" class="textarea" name="message" minlength="10" maxlength="800" placeholder="Share the details so the team can help" required></textarea><div class="field-error" data-error-for="support-message"></div></div><button class="button primary full" type="submit" '+(!state.online?'disabled':'')+'>Submit support request</button></form>'
      +'<section class="card stack"><h2 class="section-title">Safety</h2><p class="supporting">For an immediate safety or medical emergency, contact local emergency services. In-app support is not an emergency service.</p></section></div>'+nav()+'</main>';
  }

  function screenLegal() {
    return '<main class="screen"><div class="screen-content page-stack">'+topbar("Privacy and terms","Plain-language developer-build summary")+'<section class="card stack"><h2 class="section-title">Data used to provide delivery</h2><p class="supporting">Savrivo stores account details, saved addresses, favourites, order records, support requests and preferences in the configured Firebase project. During an active assigned delivery, the rider’s latest location can be shown for that order.</p></section><section class="card stack"><h2 class="section-title">Your controls</h2><p class="supporting">You can edit local profile data, sign out, disable local notifications and submit an account deletion request. A verified production privacy process is still required to complete export, correction and deletion requests.</p></section><section class="card stack"><h2 class="section-title">Payments and refunds</h2><p class="supporting">Only cash on delivery is active in this developer build. No online payment, refund or settlement is represented as completed without a connected payment provider and verified server event.</p></section><section class="notice warning">'+icon("warning","small")+'<span>This summary is not a substitute for client-approved Terms of Service, Privacy Policy, refund policy, restaurant agreement, rider agreement or legal review before launch.</span></section></div>'+nav()+'</main>';
  }

  function screenReview() {
    const order=orderById();if(!order)return screenOrders();
    return '<main class="screen"><div class="screen-content page-stack">'+topbar("Rate your order",order.restaurant||order.id)+'<form id="review-form" class="card form-grid"><fieldset style="border:0;padding:0;margin:0"><legend class="section-title">How was your experience?</legend><div class="cluster" style="margin-top:14px">'+[1,2,3,4,5].map(n=>'<label class="icon-button flat" style="color:var(--warning)"><input class="sr-only" type="radio" name="rating" value="'+n+'" required>'+icon("star","large")+'<span class="sr-only">'+n+' stars</span></label>').join("")+'</div></fieldset><div class="field"><label for="review-comment">Comment (optional)</label><textarea id="review-comment" class="textarea" name="comment" maxlength="500" placeholder="What went well or could improve?"></textarea></div><button class="button primary full" type="submit">Submit review</button></form></div>'+nav()+'</main>';
  }

  function sheetShell(title,copy,content) {
    return '<div class="sheet-backdrop" data-action="close-sheet"><section class="sheet" data-sheet-surface role="dialog" aria-modal="true" aria-label="'+h(title)+'"><div class="sheet-handle"></div><div class="cluster between"><div><h2 class="sheet-title">'+h(title)+'</h2>'+(copy?'<p class="supporting">'+h(copy)+'</p>':'')+'</div><button class="icon-button flat" data-action="close-sheet" aria-label="Close">'+icon("close")+'</button></div><div style="margin-top:20px">'+content+'</div></section></div>';
  }
  function filterSheet() {
    return sheetShell("Filters and sorting","Choose what matters for this search.",'<div class="stack-lg"><div class="field"><label for="sort-select">Sort restaurants by</label><select id="sort-select" class="select"><option value="recommended" '+(state.sort==="recommended"?'selected':'')+'>Recommended</option><option value="rating" '+(state.sort==="rating"?'selected':'')+'>Highest rated</option><option value="delivery" '+(state.sort==="delivery"?'selected':'')+'>Fastest delivery</option><option value="fee" '+(state.sort==="fee"?'selected':'')+'>Lowest delivery fee</option></select></div><div><p class="card-title">Dietary filter</p><div class="segmented" style="margin-top:10px"><button class="segment '+(state.diet==="all"?'active':'')+'" data-action="diet" data-value="all">All menus</button><button class="segment '+(state.diet==="veg"?'active':'')+'" data-action="diet" data-value="veg">Veg only</button></div></div><button class="button primary full" data-action="apply-filters">Show '+restaurantsFiltered().length+' restaurants</button></div>');
  }
  function itemSheet(sheet) {
    const r=restaurant(sheet.restaurantId),item=menuItem(sheet.restaurantId,sheet.itemId);if(!r||!item)return"";
    const variants=Array.isArray(item.variants)?item.variants:[];const addons=Array.isArray(item.addOns)?item.addOns:[];
    return sheetShell(item.name,item.description||"Customise this item before adding it.",'<form id="item-form" class="form-grid" data-restaurant-id="'+h(r.id)+'" data-item-id="'+h(item.id)+'"><img src="'+h(safeUrl(item.image,r.image))+'" alt="'+h(item.name)+'" style="width:100%;height:190px;object-fit:cover;border-radius:18px"><div class="cluster between"><span class="diet-mark '+(item.diet==="nonveg"?'nonveg':'')+'"></span><strong class="section-title">'+money(item.price)+'</strong></div>'
      +(variants.length?'<fieldset class="stack" style="border:0;padding:0;margin:0"><legend class="card-title">Choose a size</legend>'+variants.map((v,i)=>'<label class="settings-row" style="border:1px solid var(--border);border-radius:14px"><input type="radio" name="variant" value="'+i+'" '+(i===0?'checked':'')+' required><span class="grow"><strong>'+h(v.name)+'</strong></span><span>'+(!v.price?'Included':'+'+money(v.price))+'</span></label>').join("")+'</fieldset>':'')
      +(addons.length?'<fieldset class="stack" style="border:0;padding:0;margin:0"><legend class="card-title">Add extras</legend>'+addons.map((a,i)=>'<label class="settings-row" style="border:1px solid var(--border);border-radius:14px"><input type="checkbox" name="addon" value="'+i+'"><span class="grow"><strong>'+h(a.name)+'</strong></span><span>'+(!a.price?'No charge':'+'+money(a.price))+'</span></label>').join("")+'</fieldset>':'')
      +'<div class="field"><label for="item-note">Kitchen note (optional)</label><textarea class="textarea" id="item-note" name="note" maxlength="140" placeholder="Allergy note or preparation request"></textarea><p class="caption">Allergy requests cannot guarantee an allergen-free kitchen.</p></div><button class="button primary full" type="submit">Add to cart · '+money(item.price)+'</button></form>');
  }
  function replaceCartSheet(sheet) {
    const current=cartRestaurant(),next=restaurant(sheet.restaurantId);
    return sheetShell("Start a new cart?","A delivery order can contain items from only one restaurant.",'<div class="stack-lg"><div class="notice warning">'+icon("warning","small")+'<span>Your '+h(current&&current.name||"current")+' items will be removed before adding '+h(next&&next.name||"the new item")+'.</span></div><button class="button danger full" data-action="confirm-replace-cart">Clear cart and continue</button><button class="button tonal full" data-action="close-sheet">Keep current cart</button></div>');
  }
  function addressFormSheet(sheet) {
    const address=sheet.address||{};
    return sheetShell(address.id?"Edit address":"Add address","Include a reachable mobile number. Add a GPS pin for live proximity updates.",'<form id="address-form" class="form-grid"><input type="hidden" name="id" value="'+h(address.id||"")+'"><input type="hidden" name="lat" value="'+h(address.lat==null?"":address.lat)+'"><input type="hidden" name="lng" value="'+h(address.lng==null?"":address.lng)+'"><div class="field"><label for="address-label">Address label</label><input id="address-label" class="input" name="label" value="'+h(address.label||"")+'" placeholder="Home, Work or Other" required></div><div class="field"><label for="address-area">Area</label><input id="address-area" class="input" name="area" value="'+h(address.area||"")+'" placeholder="Neighbourhood or locality" required></div><div class="field"><label for="address-full">Full delivery address</label><textarea id="address-full" class="textarea" name="address" placeholder="Flat, building, street, landmark and city" required>'+h(address.address||address.details||"")+'</textarea></div><div class="field"><label for="address-phone">Mobile number</label><input id="address-phone" class="input" name="phone" type="tel" inputmode="tel" value="'+h(address.phone||state.profile.phone||"")+'" placeholder="10-digit mobile number" required></div>'+(Number.isFinite(Number(address.lat))?'<div class="notice success">'+icon("check","small")+'<span>GPS pin saved for this address.</span></div>':'<div class="notice warning">'+icon("warning","small")+'<span>No GPS pin is attached. Save this address, then use current location before checkout if you need live proximity alerts.</span></div>')+'<button class="button primary full" type="submit">Save delivery address</button></form>');
  }
  function profileSheet() {
    return sheetShell("Edit profile","Keep your contact details accurate for delivery.",'<form id="profile-form" class="form-grid"><div class="field"><label for="profile-name">Full name</label><input id="profile-name" class="input" name="name" value="'+h(state.profile.name||"")+'" required></div><div class="field"><label for="profile-email">Email address</label><input id="profile-email" class="input" value="'+h(state.profile.email||"")+'" disabled><p class="caption">Email changes require a verified Firebase account flow.</p></div><div class="field"><label for="profile-phone">Mobile number</label><input id="profile-phone" class="input" name="phone" type="tel" inputmode="tel" value="'+h(state.profile.phone||"")+'" required></div><button class="button primary full" type="submit">Save profile</button></form>');
  }
  function forgotSheet() {
    return sheetShell("Reset your password","We will ask Firebase to send a secure reset link.",'<form id="reset-form" class="form-grid"><div class="field"><label for="reset-email">Account email</label><input id="reset-email" class="input" name="email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" required></div><div class="notice info">'+icon("info","small")+'<span>Open only the newest reset email. Older links can expire after another reset request is created.</span></div><button class="button primary full" type="submit">Send reset link</button></form>');
  }
  function cancelSheet(sheet) {
    return sheetShell("Request cancellation","The restaurant must review this request. It is not shown as cancelled until the server confirms it.",'<form id="cancel-form" class="form-grid" data-order-id="'+h(sheet.orderId)+'"><div class="field"><label for="cancel-reason">Reason</label><select id="cancel-reason" name="reason" class="select"><option>Ordered by mistake</option><option>Wrong delivery address</option><option>Need to change items</option><option>Delivery is taking too long</option><option>Other</option></select></div><button class="button danger full" type="submit">Submit cancellation request</button><button class="button tonal full" type="button" data-action="close-sheet">Keep my order</button></form>');
  }
  function deletionSheet() {
    return sheetShell("Request account deletion","This creates a verified privacy request. A production service must complete authentication deletion and data retention checks.",'<form id="deletion-form" class="form-grid"><div class="notice danger">'+icon("warning","small")+'<span>Deletion can affect saved addresses, favourites, support history and access to past orders. Legally required transaction records may need limited retention.</span></div><label class="field"><span>Type DELETE to confirm</span><input class="input" name="confirmation" autocomplete="off" required></label><button class="button danger full" type="submit">Submit deletion request</button></form>');
  }
  function signoutSheet() {
    return sheetShell("Sign out of Savrivo?","Cached account details will be removed from this device.",'<div class="stack"><button class="button danger full" data-action="signout">Sign out</button><button class="button tonal full" data-action="close-sheet">Stay signed in</button></div>');
  }
  function paymentInfoSheet() {
    return sheetShell("Payment methods","Savrivo will never pretend an unconnected payment succeeded.",'<div class="stack"><div class="notice success">'+icon("receipt","small")+'<div><strong>Cash on delivery</strong><div class="caption">Available in this developer build.</div></div></div><div class="notice info">'+icon("card","small")+'<div><strong>UPI and cards</strong><div class="caption">Prepared for a production gateway, webhook verification, refunds and settlement. Not active yet.</div></div></div><button class="button primary full" data-action="close-sheet">Done</button></div>');
  }
  function renderSheet() {
    if(!state.sheet){sheetRegion.innerHTML="";return;}
    const sheet=state.sheet;let html="";
    if(sheet.type==="filters")html=filterSheet();
    else if(sheet.type==="item")html=itemSheet(sheet);
    else if(sheet.type==="replaceCart")html=replaceCartSheet(sheet);
    else if(sheet.type==="address")html=addressFormSheet(sheet);
    else if(sheet.type==="profile")html=profileSheet();
    else if(sheet.type==="forgot")html=forgotSheet();
    else if(sheet.type==="cancel")html=cancelSheet(sheet);
    else if(sheet.type==="deletion")html=deletionSheet();
    else if(sheet.type==="signout")html=signoutSheet();
    else if(sheet.type==="payment")html=paymentInfoSheet();
    sheetRegion.innerHTML=html;
    if(html)requestAnimationFrame(()=>{const focus=sheetRegion.querySelector("input,select,textarea,button");if(focus)focus.focus({preventScroll:true});});
  }

  function setFieldError(id,message) { const node=document.querySelector('[data-error-for="'+id+'"]');if(node)node.textContent=message||""; }
  function validEmail(value){return /^\S+@\S+\.\S+$/.test(String(value||"").trim());}
  function validPhone(value){return String(value||"").replace(/\D/g,"").length>=10;}

  function finishOrderPlacement(order,orderId,deliveryOtp,recovered){
    const saved=Object.assign({id:orderId},order||{});
    state.orders=[saved].concat(state.orders.filter(x=>x.id!==orderId));persistOrders();
    if(deliveryOtp){state.deliveryOtps[orderId]=deliveryOtp;saveJSON("savrivo.customer.deliveryOtps",state.deliveryOtps);}
    state.cart=[];state.coupon=null;state.tip=0;state.checkout.pendingOrderId="";state.loading=false;persistCart();persistCheckout();state.selectedOrderId=orderId;
    toast(recovered?"Your existing order was restored safely.":"Order placed successfully.","success");go("order",{orderId:orderId});
  }

  async function submitOrder() {
    if(state.loading||!state.cart.length)return;
    if(state.profile.emailVerified!==true){toast("Verify your account email before placing an order.","danger");go("verifyEmail");return;}
    const address=currentAddress(),r=cartRestaurant();
    if(!address){toast("Choose a delivery address first.","danger");go("addresses");return;}
    if(!validPhone(address.phone||state.profile.phone)){toast("Add a reachable mobile number to the delivery address.","danger");go("addresses");return;}
    if(!Number.isFinite(Number(address.lat))||!Number.isFinite(Number(address.lng))){toast("Use your current location to attach a delivery pin before checkout.","danger");go("addresses");return;}
    if(!state.online){toast("Reconnect to place this order safely.","danger");return;}
    if(!r||!r.open){toast("This restaurant is not accepting orders right now.","danger");return;}
    state.checkout.instructions=(document.getElementById("checkout-instructions")||{}).value||state.checkout.instructions;
    state.loading=true;render({preserveScroll:true});
    const now=Date.now(),orderId=state.checkout.pendingOrderId||("SV-"+uid("").replace(/-/g,"").slice(0,12).toUpperCase());state.checkout.pendingOrderId=orderId;persistCheckout();
    try{const existing=await db("GET",DB_ROOT+"/orders/"+encodeURIComponent(state.session.uid)+"/"+encodeURIComponent(orderId));if(existing){finishOrderPlacement(existing,orderId,state.deliveryOtps[orderId]||"",true);return;}}catch(_){}
    const deliveryOtp=state.deliveryOtps[orderId]||String(Math.floor(1000+Math.random()*9000)),deliveryOtpSalt=uid("salt_").replace(/-/g,"").slice(0,24),deliveryOtpHash=await sha256(deliveryOtp+deliveryOtpSalt);
    state.deliveryOtps[orderId]=deliveryOtp;saveJSON("savrivo.customer.deliveryOtps",state.deliveryOtps);
    const eventId="e_"+now+"_customer";
    const order={
      id:orderId,schemaVersion:3,idempotencyKey:orderId,customerId:state.session.uid,customerName:state.profile.name||"Savrivo customer",
      customerPhone:address.phone||state.profile.phone,restaurantId:r.id,restaurant:r.name,
      restaurantLocation:{address:r.address||"",lat:Number.isFinite(Number(r.lat))?Number(r.lat):null,lng:Number.isFinite(Number(r.lng))?Number(r.lng):null},
      items:state.cart.map(item=>({itemId:item.itemId,name:item.name,quantity:item.quantity,price:item.price,variant:item.variant||"",variantPrice:item.variantPrice||0,addOns:item.addOns||[],addOnTotal:item.addOnTotal||0,note:item.note||"",diet:item.diet||""})),
      pricing:{subtotal:cartSubtotal(),discount:discount(),deliveryFee:deliveryFee(),platformFee:platformFee(),tax:tax(),tip:Number(state.tip||0),currency:"INR",source:"catalog_snapshot_v3"},
      total:orderTotal(),coupon:eligibleCoupon()&&state.coupon.code||"",paymentMethod:"cod",paymentState:"cash_due",
      deliveryMode:"asap",address:clone(address),instructions:state.checkout.instructions||"",contactless:state.checkout.contactless===true,
      status:"Order placed",deliveryOtpHash:deliveryOtpHash,deliveryOtpSalt:deliveryOtpSalt,statusHistory:{[eventId]:{status:"Order placed",at:now,actorId:state.session.uid,actorRole:"customer"}},
      createdAt:now,updatedAt:now,etaMin:Number(r.etaMin||25),etaMax:Number(r.etaMax||35)
    };
    const changes={};changes["orders/"+state.session.uid+"/"+orderId]=order;changes["restaurantOrders/"+r.id+"/"+state.session.uid+"/"+orderId]=order;
    try{
      await db("PATCH",DB_ROOT,changes);finishOrderPlacement(order,orderId,deliveryOtp,false);
    }catch(error){
      try{const existing=await db("GET",DB_ROOT+"/orders/"+encodeURIComponent(state.session.uid)+"/"+encodeURIComponent(orderId));if(existing){finishOrderPlacement(existing,orderId,deliveryOtp,true);return;}}catch(_){}
      toast("Order was not placed. "+friendlyError(error),"danger");
    }
    finally{state.loading=false;render({preserveScroll:true});}
  }

  function reorder(order) {
    const r=restaurant(order.restaurantId);if(!r){toast("This restaurant is no longer available.","danger");return;}
    const next=[];for(const old of order.items||[]){const current=(r.menu||[]).find(x=>x.id===old.itemId&&x.available!==false);if(current)next.push({key:r.id+"::"+current.id+"::reorder",restaurantId:r.id,restaurantName:r.name,itemId:current.id,name:current.name,price:Number(current.price||0),image:safeUrl(current.image,r.image),diet:current.diet||"",quantity:Number(old.quantity||1),variant:"",variantPrice:0,addOns:[],addOnTotal:0,note:""});}
    if(!next.length){toast("Those items are not currently available.","danger");return;}
    state.cart=next;persistCart();toast("Available items were added at current prices.","success");go("cart");
  }

  Object.assign(SCREENS, {
    welcome:screenWelcome, login:screenLogin, signup:screenSignup, verifyEmail:screenVerifyEmail, home:screenHome, search:screenSearch,
    restaurant:screenRestaurant, cart:screenCart, checkout:screenCheckout, orders:screenOrders,
    order:screenOrder, tracking:screenTracking, offers:screenOffers, account:screenAccount,
    addresses:screenAddresses, favourites:screenFavourites, preferences:screenPreferences,
    support:screenSupport, legal:screenLegal, review:screenReview
  });

  async function refreshAll() {
    if(!state.session||state.loading)return;state.loading=true;render({preserveScroll:true});
    try{await Promise.all([syncOrders(true),syncCatalog(),syncProfile(true)]);state.lastSync=Date.now();state.syncError="";toast("Savrivo is up to date.","success");}
    catch(error){state.syncError=friendlyError(error);toast("Live refresh failed.","danger");}
    finally{state.loading=false;render({preserveScroll:true});}
  }

  async function toggleFavourite(id) {
    const favourites=state.profile.favourites||[];const index=favourites.indexOf(id);
    if(index>=0){favourites.splice(index,1);toast("Removed from favourites.");}else{favourites.push(id);toast("Saved to favourites.","success");}
    state.profile.favourites=favourites;persistProfile();render({preserveScroll:true});
    try{await saveProfile();}catch(_){toast("Saved on this device; cloud sync will retry.");}
  }

  function updateSearchResults() {
    const node=document.getElementById("search-results");if(node)node.innerHTML=searchResultMarkup();
  }

  async function handleActionClick(event){
    const control=event.target.closest("[data-action]");if(!control)return;
    const action=control.dataset.action;
    if(action==="close-sheet"){
      if(control.classList.contains("sheet-backdrop")&&event.target.closest("[data-sheet-surface]"))return;
      closeSheet();return;
    }
    if(action==="go"){go(control.dataset.route);return;}
    if(action==="back"){goBack();return;}
    if(action==="welcome-signup"){localStorage.setItem("savrivo.customer.seenWelcome","1");go("signup");return;}
    if(action==="welcome-login"){localStorage.setItem("savrivo.customer.seenWelcome","1");go("login");return;}
    if(action==="google-signin"){openGoogleSignIn();return;}
    if(action==="forgot-password"){setSheet({type:"forgot"});return;}
    if(action==="check-verification"){
      state.loading=true;render({preserveScroll:true});
      try{await ensureSession();if(await syncEmailVerification()){toast("Email verified. Welcome to Savrivo.","success");go("home",{},true);}else toast("Verification is not complete yet. Open the newest email and try again.","danger");}
      catch(error){toast(friendlyError(error),"danger");}
      finally{state.loading=false;render({preserveScroll:true});}
      return;
    }
    if(action==="resend-verification"){
      try{await ensureSession();await authRequest("accounts:sendOobCode",{requestType:"VERIFY_EMAIL",idToken:state.session.idToken});toast("A new verification email was requested. Use the newest message.","success");}
      catch(error){toast(friendlyError(error),"danger");}
      return;
    }
    if(action==="toggle-password"){
      const input=document.getElementById(control.dataset.target);if(input){const show=input.type==="password";input.type=show?"text":"password";control.innerHTML=icon(show?"eyeOff":"eye");control.setAttribute("aria-label",show?"Hide password":"Show password");}return;
    }
    if(action==="refresh"){refreshAll();return;}
    if(action==="go-home"){go("home");return;}
    if(action==="open-restaurant"){go("restaurant",{restaurantId:control.dataset.restaurantId});return;}
    if(action==="toggle-favourite"){event.preventDefault();event.stopPropagation();toggleFavourite(control.dataset.restaurantId);return;}
    if(action==="cuisine"){state.cuisine=control.dataset.value||"All";if(state.route==="home")render({preserveScroll:true});else{document.querySelectorAll('[data-action="cuisine"]').forEach(x=>x.classList.toggle("active",x.dataset.value===state.cuisine));updateSearchResults();}return;}
    if(action==="clear-search"){state.query="";const input=document.getElementById("search-input");if(input){input.value="";input.focus();}updateSearchResults();return;}
    if(action==="open-filters"){setSheet({type:"filters"});return;}
    if(action==="diet"){state.diet=control.dataset.value;renderSheet();return;}
    if(action==="apply-filters"){const select=document.getElementById("sort-select");if(select)state.sort=select.value;closeSheet();render({preserveScroll:true});return;}
    if(action==="toggle-veg"){state.diet=state.diet==="veg"?"all":"veg";render({preserveScroll:true});return;}
    if(action==="menu-category"){state.selectedMenuCategory=control.dataset.value||"All";render({preserveScroll:true});return;}
    if(action==="clear-menu-filter"){state.diet="all";state.selectedMenuCategory="All";render({preserveScroll:true});return;}
    if(action==="open-item"){setSheet({type:"item",restaurantId:control.dataset.restaurantId,itemId:control.dataset.itemId});return;}
    if(action==="confirm-replace-cart"){const pending=state.sheet;state.cart=[];persistCart();addCartItem(pending.restaurantId,pending.itemId,pending.custom||{});return;}
    if(action==="cart-quantity"){updateCart(control.dataset.key,Number(control.dataset.delta||0));return;}
    if(action==="go-checkout"){if(!state.cart.length)return;go("checkout");return;}
    if(action==="apply-coupon"){
      const code=String((document.getElementById("coupon-input")||{}).value||"").trim().toUpperCase();const promo=state.promotions.find(p=>String(p.code||"").toUpperCase()===code&&p.active===true);
      if(!promo){state.coupon=null;toast("That code is not an active Savrivo offer.","danger");render({preserveScroll:true});return;}
      if(promo.expiresAt&&Date.now()>Number(promo.expiresAt)){toast("That offer has expired.","danger");return;}
      if(promo.minimumOrder&&cartSubtotal()<Number(promo.minimumOrder)){toast("This offer needs a minimum item total of "+money(promo.minimumOrder)+".","danger");return;}
      if(Array.isArray(promo.restaurantIds)&&!promo.restaurantIds.includes(state.cart[0].restaurantId)){toast("That offer is not eligible for this restaurant.","danger");return;}
      state.coupon=promo;toast("Offer applied.","success");render({preserveScroll:true});return;
    }
    if(action==="delivery-mode"){if(control.dataset.value==="scheduled"){toast("Scheduling activates with the production dispatch backend.");return;}state.checkout.deliveryMode="asap";render({preserveScroll:true});return;}
    if(action==="toggle-contactless"){state.checkout.contactless=!state.checkout.contactless;render({preserveScroll:true});return;}
    if(action==="select-payment"){if(control.dataset.value!=="cod"){toast("This payment method is not connected yet.");return;}state.checkout.payment="cod";render({preserveScroll:true});return;}
    if(action==="place-order"){submitOrder();return;}
    if(action==="open-order"){go("order",{orderId:control.dataset.orderId});return;}
    if(action==="open-tracking"){go("tracking",{orderId:control.dataset.orderId});return;}
    if(action==="reorder"){const order=orderById(control.dataset.orderId);if(order)reorder(order);return;}
    if(action==="review-order"){go("review",{orderId:control.dataset.orderId});return;}
    if(action==="support-order"){go("support",{orderId:control.dataset.orderId});return;}
    if(action==="cancel-order"){setSheet({type:"cancel",orderId:control.dataset.orderId});return;}
    if(action==="use-promo"){const promo=state.promotions.find(p=>p.id===control.dataset.promoId);if(promo){state.coupon=promo;toast("Offer ready for an eligible cart.","success");go("home");}return;}
    if(action==="edit-profile"){setSheet({type:"profile"});return;}
    if(action==="payment-info"){setSheet({type:"payment"});return;}
    if(action==="confirm-signout"){setSheet({type:"signout"});return;}
    if(action==="request-deletion"){setSheet({type:"deletion"});return;}
    if(action==="signout"){closeSheet();signOut(true);return;}
    if(action==="detect-location"){requestLocation();return;}
    if(action==="add-address"){setSheet({type:"address",address:{}});return;}
    if(action==="edit-address"){const address=(state.profile.addresses||[]).find(x=>x.id===control.dataset.addressId);if(address)setSheet({type:"address",address:clone(address)});return;}
    if(action==="select-address"){selectAddress(control.dataset.addressId);return;}
    if(action==="toggle-preference"){
      const key=control.dataset.key;state.profile.preferences[key]=!state.profile.preferences[key];persistProfile();applyTheme();render({preserveScroll:true});
      try{await saveProfile();}catch(_){toast("Preference saved on this device.");}return;
    }
    if(action==="theme"){state.profile.preferences.theme=control.dataset.value;persistProfile();applyTheme();render({preserveScroll:true});try{await saveProfile();}catch(_){}return;}
  }
  app.addEventListener("click",handleActionClick);
  sheetRegion.addEventListener("click",handleActionClick);

  app.addEventListener("input",function(event){
    if(event.target.id==="search-input"){state.query=event.target.value;updateSearchResults();}
    if(event.target.id==="checkout-instructions")state.checkout.instructions=event.target.value;
  });
  app.addEventListener("keydown",function(event){
    if((event.key==="Enter"||event.key===" ")&&event.target.matches('[role="button"][data-action]')){event.preventDefault();event.target.click();}
  });

  async function submitLogin(form) {
    const email=form.elements["email"].value.trim().toLowerCase(),password=form.elements["login-password"].value;
    setFieldError("login-email",validEmail(email)?"":"Enter a valid email address.");setFieldError("login-password",password?"":"Enter your password.");
    if(!validEmail(email)||!password)return;
    state.loading=true;render({preserveScroll:true});
    try{const data=await authRequest("accounts:signInWithPassword",{email:email,password:password,returnSecureToken:true});saveAuth(data,email);await afterAuth();}
    catch(error){toast(friendlyError(error),"danger");state.loading=false;render({preserveScroll:true});}
  }
  async function submitSignup(form) {
    const name=form.elements["name"].value.trim(),email=form.elements["email"].value.trim().toLowerCase(),phone=form.elements["phone"].value.trim(),password=form.elements["signup-password"].value,confirm=form.elements["signup-confirm"].value,consent=document.getElementById("signup-consent").checked;
    setFieldError("signup-name",name.length>=2?"":"Enter your full name.");setFieldError("signup-email",validEmail(email)?"":"Enter a valid email.");setFieldError("signup-phone",validPhone(phone)?"":"Enter a valid mobile number.");
    const strong=password.length>=8&&/[A-Za-z]/.test(password)&&/\d/.test(password);setFieldError("signup-password",strong?"":"Use 8+ characters with letters and numbers.");setFieldError("signup-confirm",password===confirm?"":"Passwords do not match.");
    if(name.length<2||!validEmail(email)||!validPhone(phone)||!strong||password!==confirm||!consent){if(!consent)toast("Accept the Terms and Privacy Notice to continue.","danger");return;}
    state.loading=true;render({preserveScroll:true});
    try{
      const data=await authRequest("accounts:signUp",{email:email,password:password,returnSecureToken:true});saveAuth(data,email);state.profile.name=name;state.profile.email=email;state.profile.phone=phone;state.profile.addresses=[];state.profile.favourites=[];state.profile.emailVerified=false;persistProfile();await saveProfile();
      await authRequest("accounts:sendOobCode",{requestType:"VERIFY_EMAIL",idToken:state.session.idToken}).catch(()=>null);toast("Account created. Check your email to verify it.","success");await afterAuth();
    }catch(error){toast(friendlyError(error),"danger");state.loading=false;render({preserveScroll:true});}
  }

  async function submitReset(form) {
    const email=form.elements["email"].value.trim().toLowerCase();if(!validEmail(email)){toast("Enter the email used for your Savrivo account.","danger");return;}
    const button=form.querySelector("button[type=submit]");button.disabled=true;button.innerHTML='<span class="spinner"></span> Sending…';
    try{await authRequest("accounts:sendOobCode",{requestType:"PASSWORD_RESET",email:email});closeSheet();toast("If the account exists, the newest reset link has been sent. Check Inbox and Spam.","success");}
    catch(error){toast(friendlyError(error),"danger");button.disabled=false;button.textContent="Send reset link";}
  }
  function submitItem(form) {
    const rid=form.dataset.restaurantId,iid=form.dataset.itemId,item=menuItem(rid,iid);if(!item)return;
    const variantIndex=form.variant?Number(form.variant.value):null,variant=variantIndex!=null&&item.variants?item.variants[variantIndex]:null;
    const addOns=Array.from(form.querySelectorAll('input[name="addon"]:checked')).map(input=>item.addOns[Number(input.value)]).filter(Boolean);
    addCartItem(rid,iid,{variant:variant,addOns:addOns,note:form.elements["note"].value.trim()});
  }
  async function submitAddress(form) {
    const values=new FormData(form),phone=String(values.get("phone")||"").trim();if(!validPhone(phone)){toast("Enter a reachable mobile number.","danger");return;}
    const existingId=String(values.get("id")||""),record={id:existingId||uid("addr_"),label:String(values.get("label")||"").trim(),area:String(values.get("area")||"").trim(),address:String(values.get("address")||"").trim(),phone:phone,source:existingId==="current-location"?"gps":"manual",updatedAt:Date.now()};
    const lat=Number(values.get("lat")),lng=Number(values.get("lng"));if(Number.isFinite(lat)&&Number.isFinite(lng)&&String(values.get("lat"))!==""){record.lat=lat;record.lng=lng;}
    if(!record.label||!record.area||!record.address){toast("Complete the label, area and full address.","danger");return;}
    const list=state.profile.addresses||[],index=list.findIndex(x=>x.id===record.id);if(index>=0)list[index]=record;else list.push(record);state.profile.addresses=list;state.profile.selectedAddressId=record.id;if(!state.profile.phone)state.profile.phone=phone;persistProfile();closeSheet();render({preserveScroll:true});
    try{await saveProfile();toast("Delivery address saved.","success");}catch(_){toast("Address saved on this device; cloud sync will retry.");}
  }
  async function submitProfile(form) {
    const name=form.elements["name"].value.trim(),phone=form.elements["phone"].value.trim();if(name.length<2||!validPhone(phone)){toast("Enter your full name and a valid mobile number.","danger");return;}
    state.profile.name=name;state.profile.phone=phone;persistProfile();closeSheet();render({preserveScroll:true});try{await saveProfile();toast("Profile updated.","success");}catch(_){toast("Profile saved on this device; cloud sync will retry.");}
  }
  async function submitSupport(form) {
    const message=form.elements["message"].value.trim();if(message.length<10){setFieldError("support-message","Please add a little more detail.");return;}
    const id=uid("ticket_"),ticket={id:id,uid:state.session.uid,customerName:state.profile.name||"",email:state.profile.email||"",orderId:state.routeData.orderId||"",topic:form.elements["topic"].value,message:message,status:"open",createdAt:Date.now(),updatedAt:Date.now()};
    const button=form.querySelector("button");button.disabled=true;button.innerHTML='<span class="spinner"></span> Submitting…';
    try{await db("PUT",DB_ROOT+"/support/"+state.session.uid+"/"+id,ticket);form.reset();toast("Support request submitted. Reference "+id.slice(-8).toUpperCase()+".","success");}
    catch(error){toast("Request could not be saved. "+friendlyError(error),"danger");}
    finally{button.disabled=false;button.textContent="Submit support request";}
  }
  async function submitReview(form) {
    const data=new FormData(form),rating=Number(data.get("rating"));if(!rating){toast("Choose a star rating.","danger");return;}
    const order=orderById();const review={orderId:order.id,restaurantId:order.restaurantId,rating:rating,comment:String(data.get("comment")||"").trim(),createdAt:Date.now(),status:"published"};
    try{await db("PUT",DB_ROOT+"/reviews/"+state.session.uid+"/"+order.id,review);toast("Thank you for your review.","success");go("order",{orderId:order.id},true);}
    catch(error){toast("Review could not be saved. "+friendlyError(error),"danger");}
  }
  async function submitCancellation(form) {
    const orderId=form.dataset.orderId,id=uid("cancel_"),requestData={id:id,type:"cancellation",orderId:orderId,reason:form.elements["reason"].value,status:"requested",createdAt:Date.now(),customerId:state.session.uid};
    try{await db("PUT",DB_ROOT+"/support/"+state.session.uid+"/"+id,requestData);closeSheet();toast("Cancellation request sent for restaurant review.","success");}
    catch(error){toast("Cancellation request could not be sent. "+friendlyError(error),"danger");}
  }
  async function submitDeletion(form) {
    if(String(new FormData(form).get("confirmation")||"").trim().toUpperCase()!=="DELETE"){toast("Type DELETE exactly to confirm.","danger");return;}
    const id=uid("privacy_"),record={id:id,type:"account_deletion",uid:state.session.uid,email:state.profile.email||state.session.email,status:"requested",createdAt:Date.now()};
    try{await db("PUT",DB_ROOT+"/privacyRequests/"+state.session.uid+"/"+id,record);closeSheet();toast("Deletion request submitted. Keep reference "+id.slice(-8).toUpperCase()+".","success");}
    catch(error){toast("Deletion request could not be saved. "+friendlyError(error),"danger");}
  }

  document.addEventListener("submit",function(event){
    const form=event.target;if(!(form instanceof HTMLFormElement))return;event.preventDefault();
    if(form.id==="login-form")submitLogin(form);
    else if(form.id==="signup-form")submitSignup(form);
    else if(form.id==="reset-form")submitReset(form);
    else if(form.id==="item-form")submitItem(form);
    else if(form.id==="address-form")submitAddress(form);
    else if(form.id==="profile-form")submitProfile(form);
    else if(form.id==="support-form")submitSupport(form);
    else if(form.id==="review-form")submitReview(form);
    else if(form.id==="cancel-form")submitCancellation(form);
    else if(form.id==="deletion-form")submitDeletion(form);
  });

  window.addEventListener("online",function(){state.online=true;state.syncError="";render({preserveScroll:true});if(state.session)refreshAll();});
  window.addEventListener("offline",function(){state.online=false;render({preserveScroll:true});});
  document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible"&&state.session&&state.online)syncOrders(false);});
  if(window.matchMedia){const media=matchMedia("(prefers-color-scheme: dark)");if(media.addEventListener)media.addEventListener("change",function(){if((state.profile.preferences||{}).theme==="system"){applyTheme();render({preserveScroll:true});}});}

  bootstrap();
})();
