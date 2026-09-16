(function () {
  "use strict";

  const BRAND = "Scraveit";
  const DB_ROOT = "feastly"; // Legacy server namespace retained for Firebase compatibility.
  const CONFIG = window.FEASTLY_FIREBASE || {};
  const AUTH_BASE = "https://identitytoolkit.googleapis.com/v1/";
  const TOKEN_BASE = "https://securetoken.googleapis.com/v1/token";
  // Emergency rollback only. Production orders use createCodOrder and this remains false.
  const LEGACY_ORDER_WRITE_COMPATIBILITY = false;
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
    scooter: '<circle cx="5.5" cy="14.9" r="3"/><circle cx="18.5" cy="14.9" r="3"/><path d="M8.5 14.9h6.6"/><path d="M15.1 14.9 17.4 7"/><path d="M15.2 6.4h4.2"/><path d="M4.6 8.4h4.2l2.4 6.5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>'
  };

  const FALLBACK_CATALOG = {
    "the-waffle-spot-naidupeta": {
      id: "the-waffle-spot-naidupeta", name: "The Waffle Spot", cuisines: ["Waffle", "Pancake", "Desserts"],
      category: "Desserts", city: "Naidupeta", rating: 0, etaMin: 25, etaMax: 40,
      pureVeg: true,
      deliveryFee: 29, platformFee: 15, image: "waffle-spot-cover.jpg",
      address: "Pichi Reddy Thopu, Near Current Office, Naidupeta, Andhra Pradesh 524126",
      lat: 13.9018832, lng: 79.8877264, open: false, archived: false, opensUntil: "",
      description: "Delivery-only dessert kitchen serving waffles, pancakes and ice creams.",
      menu: [
        { id: "bean-vanilla", category: "Creamora Ice Creams", name: "Bean Vanilla", description: "Vegetarian ice cream from the outlet's published Creamora selection.", price: 77, diet: "veg", image: "waffle-spot-cover.jpg", popular: false, available: false },
        { id: "butter-scotch", category: "Creamora Ice Creams", name: "Butter Scotch", description: "Vegetarian ice cream from the outlet's published Creamora selection.", price: 105, diet: "veg", image: "waffle-spot-cover.jpg", popular: false, available: false },
        { id: "vanilla-caramel-brownie", category: "Creamora Ice Creams", name: "Vanilla Caramel Brownie", description: "Vegetarian ice cream from the outlet's published Creamora selection.", price: 119, diet: "veg", image: "waffle-spot-cover.jpg", popular: false, available: false },
        { id: "red-velvet-icecream", category: "Creamora Ice Creams", name: "Red Velvet Ice Cream", description: "Vegetarian ice cream from the outlet's published Creamora selection.", price: 119, diet: "veg", image: "waffle-spot-cover.jpg", popular: false, available: false },
        { id: "caramel-nut", category: "Creamora Ice Creams", name: "Caramel Nut", description: "Vegetarian ice cream from the outlet's published Creamora selection.", price: 119, diet: "veg", image: "waffle-spot-cover.jpg", popular: false, available: false },
        { id: "black-currant-icecream", category: "Creamora Ice Creams", name: "Black Currant Ice Cream", description: "Vegetarian ice cream from the outlet's published Creamora selection.", price: 119, diet: "veg", image: "waffle-spot-cover.jpg", popular: false, available: false },
        { id: "honeymoon-delight", category: "Creamora Ice Creams", name: "Honeymoon Delight Ice Cream", description: "Vegetarian ice cream from the outlet's published Creamora selection.", price: 119, diet: "veg", image: "waffle-spot-cover.jpg", popular: false, available: false },
        { id: "mango-natural", category: "Creamora Ice Creams", name: "Mango Natural Ice Cream", description: "Vegetarian ice cream from the outlet's published Creamora selection.", price: 119, diet: "veg", image: "waffle-spot-cover.jpg", popular: false, available: false },
        { id: "strawberry-icecream", category: "Creamora Ice Creams", name: "Strawberry Ice Cream", description: "Vegetarian ice cream from the outlet's published Creamora selection.", price: 77, diet: "veg", image: "waffle-spot-cover.jpg", popular: false, available: false },
        { id: "nutella-blend", category: "Creamora Ice Creams", name: "Nutella Blend Ice Cream", description: "Vegetarian ice cream from the outlet's published Creamora selection.", price: 119, diet: "veg", image: "waffle-spot-cover.jpg", popular: false, available: false },
        { id: "sitaphal-natural", category: "Creamora Ice Creams", name: "Sitaphal Natural Ice Cream", description: "Vegetarian ice cream from the outlet's published Creamora selection.", price: 119, diet: "veg", image: "waffle-spot-cover.jpg", popular: false, available: false },
        { id: "tender-coconut", category: "Creamora Ice Creams", name: "Tender Coconut Ice Cream", description: "Vegetarian ice cream from the outlet's published Creamora selection.", price: 119, diet: "veg", image: "waffle-spot-cover.jpg", popular: false, available: false },
        { id: "chikoo-natural", category: "Creamora Ice Creams", name: "Chikoo Natural Ice Cream", description: "Vegetarian ice cream from the outlet's published Creamora selection.", price: 119, diet: "veg", image: "waffle-spot-cover.jpg", popular: false, available: false },
        { id: "jackfruit-natural", category: "Creamora Ice Creams", name: "Jackfruit Natural Ice Cream", description: "Vegetarian ice cream from the outlet's published Creamora selection.", price: 119, diet: "veg", image: "waffle-spot-cover.jpg", popular: false, available: false }
      ]
    }
  };

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function loadJSON(key, fallback) {
    try { const value = JSON.parse(localStorage.getItem(key)); return value == null ? fallback : value; }
    catch (_) { return fallback; }
  }
  function saveJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
  const HOME_CACHE_KEY = "savrivo.customer.homeCache.v1";
  const MENU_CACHE_KEY = "savrivo.customer.menuCache.v1";
  const HOME_CACHE_MAX_AREAS = 8;
  const MENU_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const HOME_PERF_TAG = "SAVRIVO_HOME_PERF";
  function perfNow(){return window.performance&&typeof performance.now==="function"?performance.now():Date.now()}
  function perfLog(event, startedAt, details){
    const payload=Object.assign({},details||{});
    if(Number.isFinite(Number(startedAt)))payload.durationMs=Math.round((perfNow()-Number(startedAt))*10)/10;
    try{console.info(HOME_PERF_TAG,event,payload)}catch(_){}
  }
  function h(value) {
    return String(value == null ? "" : value).replace(/[&<>'"]/g, function (char) {
      return ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char];
    });
  }
  function safeUrl(value, fallback) {
    const url = String(value || "").trim();
    if (/^(?:[a-z0-9._-]+\.(?:jpg|jpeg|png|webp|svg)|data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+)$/i.test(url)) return url;
    if (/^https:\/\/firebasestorage\.googleapis\.com\//i.test(url)) return url;
    return fallback || "restaurant-placeholder.svg";
  }
  function icon(name, extra) { return '<svg class="icon '+h(extra || "")+'" viewBox="0 0 24 24" aria-hidden="true">'+(ICONS[name] || ICONS.info)+"</svg>"; }
  function logo(extra) {
    return '<span class="logo-mark '+h(extra || "")+'" aria-hidden="true"><svg viewBox="0 0 64 64"><path fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" d="M48 18c-8-7-24-7-30 1-7 10 7 13 15 14 9 1 16 5 12 12-5 9-22 9-31 1"/><path fill="none" stroke="#73d7ff" stroke-width="5" stroke-linecap="round" d="M15 22h-8M13 32H4M17 42H8"/></svg></span>';
  }
  function money(value) { return "₹" + Math.round(Number(value || 0)).toLocaleString("en-IN"); }
  function searchKey(value) { return String(value == null ? "" : value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
  function searchMatches(value, query) { const haystack=searchKey(value),needle=searchKey(query);if(!needle)return true;if(haystack.includes(needle))return true;let at=0;for(let i=0;i<haystack.length&&at<needle.length;i++)if(haystack[i]===needle[at])at++;return at===needle.length; }
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
  const cachedSession = loadJSON("savrivo.customer.session", null);
  function reviewCacheKey(uidValue) { return "savrivo.customer.reviews." + String(uidValue || "signed-out"); }
  function searchHistoryKey(uidValue) { return "savrivo.customer.recentSearches." + String(uidValue || "signed-out"); }
  function normalizedRecentSearches(values){
    const next=[];
    (Array.isArray(values)?values:[]).forEach(value=>{
      const label=String(value||"").trim().replace(/\s+/g," ").slice(0,80),identity=searchKey(label);
      if(label.length>=2&&identity&&!next.some(existing=>searchKey(existing)===identity))next.push(label);
    });
    return next.slice(0,8);
  }
  const state = {
    route: "welcome", history: [], routeData: {},
    session: cachedSession,
    profile: Object.assign({name:"", email:"", phone:"", addresses:[], selectedAddressId:"", favourites:[], preferences:{theme:"system", vegetarian:false, notifications:true}}, cachedProfile),
    catalog: {}, catalogMode: "loading", catalogLoaded: false, homeStatus:"initial", catalogRequestSequence:0, appliedCatalogSequence:0,
    promotions: [], settings: {platformFee:15, taxRate:0, freeDeliveryAbove:0, maxDeliveryKm:15, deliverySlabs:{"0":{maxKm:2,fee:29},"1":{maxKm:4,fee:39},"2":{maxKm:6,fee:59},"3":{maxKm:8,fee:79},"4":{maxKm:10,fee:99},"5":{maxKm:12,fee:119},"6":{maxKm:15,fee:139}}, platformFeeOverrides:{cities:{},categories:{},restaurants:{},orderValueRules:{}}, rainFeeEnabled:true,rainLightFee:9,rainModerateFee:19,rainHeavyFee:29,rainSevereFee:39,rainMinProbability:35,rainLightMm:0.1,rainModerateMm:1,rainHeavyMm:4,rainSevereMm:10,surgeEnabled:true,surgeLowOrders:4,surgeMediumOrders:8,surgeHighOrders:12,surgeLowFee:9,surgeMediumFee:19,surgeHighFee:29,maxSurgeFee:39,smallOrderFeeEnabled:true,smallOrderThreshold:149,smallOrderFee:19,lateNightFeeEnabled:true,lateNightStartHour:23,lateNightEndHour:5,lateNightFee:19}, checkoutConfig:null,
    orders: loadJSON("savrivo.customer.orders", []), tracking: {}, deliveryOtps:{}, reviews:loadJSON(reviewCacheKey(cachedSession&&cachedSession.uid),{}), reviewsHydrated:false, reviewsHydratedUid:"", reviewSyncSequence:0, localAds:[], broadcasts:[], seenBroadcasts:loadJSON("savrivo.customer.seenBroadcasts",{}), broadcastTimers:{},
    cart: loadJSON("savrivo.customer.cart", []), coupon: null, tip: 0,
    query: "", recentSearches:normalizedRecentSearches(loadJSON(searchHistoryKey(cachedSession&&cachedSession.uid),[])), searchDebounceTimer:null, cuisine: "All", diet: "all", sort: "recommended", homeFilter: "all",
    menuPrice: "all", menuSort: "recommended", ratingView: loadJSON("savrivo.customer.ratingView", "overall"),
    selectedRestaurantId: "the-waffle-spot-naidupeta", selectedOrderId: "", selectedMenuCategory: "All",
    online: navigator.onLine, loading: false, syncError: "", lastSync: 0,
    sheet: null, toastTimer: null, timers: [], watchers:{catalog:null,orders:null}, watcherStarts:{catalog:null,orders:null}, watcherScopes:{catalog:"",orders:""}, trackingWatchers:{}, trackingWatcherStarts:{}, trackingHydrated:{}, trackingReconnectTimers:{}, trackingSeenAt:{}, trackingMap:null, trackingRoutes:{}, syncTimers:{catalog:null,orders:null,reconnectCatalog:null,reconnectOrders:null}, locationBusy: false, dynamicPricing:{rainFee:0,surgeFee:0,riderIncentiveFee:0,weatherSeverity:"",weatherChecked:false,activeOrders:0,checkedAt:0}, chat:{orderId:"",channel:"",messages:[],title:"Chat"},
    addressMapDraft: null, addressMapZoom: 16, locationMode: "general", menuLoading:{}, menuRequests:{}, menuErrors:{}, homeBootStartedAt:perfNow(), homeVisibleLogged:false,
    checkout: Object.assign({deliveryMode:"asap", payment:"cod", instructions:"", contactless:false, pendingOrderId:"", pendingIdempotencyKey:""},loadJSON("savrivo.customer.checkout",{}))
  };

  // Delivery OTPs from older builds must not remain in WebView local storage.
  localStorage.removeItem("savrivo.customer.deliveryOtps");

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
  function persistReviews() { if(state.session&&state.session.uid)saveJSON(reviewCacheKey(state.session.uid),state.reviews||{}); }
  function reviewStateReady() {
    return !!(state.session&&state.reviewsHydrated&&state.reviewsHydratedUid===String(state.session.uid||""));
  }
  function applyReviewSnapshot(uidValue,requestSequence,reviews) {
    const expectedUid=String(uidValue||"");
    if(!state.session||String(state.session.uid||"")!==expectedUid||requestSequence!==state.reviewSyncSequence)return false;
    state.reviews=reviews&&typeof reviews==="object"?reviews:{};
    state.reviewsHydrated=true;
    state.reviewsHydratedUid=expectedUid;
    persistReviews();
    return true;
  }
  function persistSession() { state.session ? saveJSON("savrivo.customer.session", state.session) : localStorage.removeItem("savrivo.customer.session"); }

  function migrateSavedAddresses(){
    let changed=false;
    state.profile.addresses=(state.profile.addresses||[]).map((raw,index)=>{
      const address=Object.assign({},raw||{});
      if(!address.id){address.id="legacy-address-"+index;changed=true}
      const formatted=String(address.formattedAddress||address.address||address.details||"").trim();
      if(formatted&&!address.formattedAddress){address.formattedAddress=formatted;changed=true}
      if(!address.address&&formatted){address.address=formatted;changed=true}
      const area=String(address.area||address.city||"").trim();
      if(area&&!address.area){address.area=area;changed=true}
      if(!address.serviceAreaId&&area){address.serviceAreaId="area-"+searchKey(address.city||area);changed=true}
      const lat=Number(address.lat),lng=Number(address.lng),pinned=Number.isFinite(lat)&&Number.isFinite(lng);
      if(address.needsLocationPin!==!pinned){address.needsLocationPin=!pinned;changed=true}
      return address;
    });
    if(!state.profile.selectedAddressId&&state.profile.addresses[0]){state.profile.selectedAddressId=state.profile.addresses[0].id;changed=true}
    if(changed)persistProfile();
    return changed;
  }

  function homeScope(address){
    const value=address||{};
    if(value.serviceAreaId)return "service-"+searchKey(value.serviceAreaId);
    if(value.city)return "city-"+searchKey(value.city);
    if(value.area)return "area-"+searchKey(value.area);
    const lat=Number(value.lat),lng=Number(value.lng);
    if(Number.isFinite(lat)&&Number.isFinite(lng))return "geo-"+lat.toFixed(2)+"-"+lng.toFixed(2);
    return "address-"+searchKey(value.id||"unselected");
  }

  function discoveryIndex(items){
    return (items||[]).filter(item=>item&&item.archived!==true).map(item=>({
      id:String(item.id||""),name:String(item.name||"").slice(0,180),category:String(item.category||"Menu").slice(0,100),
      diet:String(item.diet||"veg"),price:Number(item.price||0),available:item.available!==false,popular:item.popular===true
    }));
  }

  function homeSummary(restaurant){
    const summary={};
    ["id","name","image","imageUrl","cuisines","city","category","description","address","lat","lng","etaMin","etaMax","deliveryFee","platformFee","opensUntil","open","active","archived","rating","ratingCount","pureVeg","offer","offerText","discount","deliveryRadiusKm","priceForTwo","serviceAreaId","serviceAreaIds","updatedAt"].forEach(key=>{
      if(restaurant[key]!==undefined)summary[key]=restaurant[key];
    });
    summary.menuIndex=discoveryIndex((restaurant.menu&&restaurant.menu.length)?restaurant.menu:restaurant.menuIndex);
    return summary;
  }

  function cacheMap(){const value=loadJSON(HOME_CACHE_KEY,{});return value&&typeof value==="object"?value:{}}
  function saveHomeCache(){
    const scope=homeScope(currentAddress()),cache=cacheMap(),catalog={};
    Object.keys(state.catalog||{}).forEach(id=>catalog[id]=homeSummary(state.catalog[id]));
    cache[scope]={savedAt:Date.now(),catalog};
    Object.keys(cache).sort((a,b)=>Number(cache[b]&&cache[b].savedAt||0)-Number(cache[a]&&cache[a].savedAt||0)).slice(HOME_CACHE_MAX_AREAS).forEach(key=>delete cache[key]);
    saveJSON(HOME_CACHE_KEY,cache);
  }
  function restoreHomeCache(replace){
    const started=perfNow(),scope=homeScope(currentAddress()),entry=cacheMap()[scope];
    if(!entry||!entry.catalog||typeof entry.catalog!=="object"){perfLog("HOME_CACHE_MISS",started,{scope});return false}
    if(replace!==false)state.catalog={};
    Object.keys(entry.catalog).forEach(id=>{
      const cached=normalizeRestaurant(id,entry.catalog[id]);
      cached.menu=[];cached.menuIndex=discoveryIndex(entry.catalog[id].menuIndex||[]);cached.menuLoaded=false;
      state.catalog[id]=cached;
    });
    state.catalogLoaded=true;state.catalogMode="cached";state.homeStatus="showingCachedData";
    perfLog("HOME_CACHE_RENDER_READY",started,{scope,restaurants:Object.keys(state.catalog).length,ageMs:Math.max(0,Date.now()-Number(entry.savedAt||0))});
    return true;
  }

  function menuCacheMap(){const value=loadJSON(MENU_CACHE_KEY,{});return value&&typeof value==="object"?value:{}}
  function cachedMenu(restaurantId){
    const entry=menuCacheMap()[restaurantId];
    if(!entry||!Array.isArray(entry.items)||Date.now()-Number(entry.savedAt||0)>MENU_CACHE_MAX_AGE_MS)return null;
    return entry.items;
  }
  function saveMenuCache(restaurantId,items){const cache=menuCacheMap();cache[restaurantId]={savedAt:Date.now(),items};saveJSON(MENU_CACHE_KEY,cache)}

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

  const nativeRequests = new Map();
  window.savrivoNativeResult = function (response) {
    if (!response || !response.requestId) return;
    const pending = nativeRequests.get(String(response.requestId));
    if (!pending) return;
    nativeRequests.delete(String(response.requestId));
    clearTimeout(pending.timer);
    if (response.ok === true) pending.resolve(response.data || {});
    else {
      const error = new Error(String(response.code || "FUNCTION_FAILED"));
      error.userMessage = String(response.message || "The request could not be completed.").slice(0, 300);
      pending.reject(error);
    }
  };

  function nativeAvailable(operation) {
    return !!(window.FeastlyNative && typeof window.FeastlyNative[operation] === "function");
  }

  function nativeInvoke(operation, payload, options) {
    const settings = options || {};
    if (!nativeAvailable(operation)) return Promise.reject(new Error("NATIVE_BRIDGE_UNAVAILABLE"));
    const requestId = uid("native_").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
    const firebaseIdToken = settings.idToken != null
      ? String(settings.idToken) : String(state.session && state.session.idToken || "");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        nativeRequests.delete(requestId);
        reject(new Error("REQUEST_TIMEOUT"));
      }, Number(settings.timeoutMs || ((operation === "createCodOrder" || operation === "createOrder") ? 38000 : 22000)));
      nativeRequests.set(requestId, {resolve, reject, timer});
      try {
        if (operation === "createCodOrder") {
          FeastlyNative.createCodOrder(requestId, firebaseIdToken, JSON.stringify(payload || {}));
        } else if (operation === "createOrder") {
          FeastlyNative.createOrder(requestId, firebaseIdToken, JSON.stringify(payload || {}));
        } else if (operation === "getCheckoutConfiguration") {
          FeastlyNative.getCheckoutConfiguration(requestId, firebaseIdToken, JSON.stringify(payload || {}));
        } else if (operation === "createPaymentIntent") {
          FeastlyNative.createPaymentIntent(requestId, firebaseIdToken, JSON.stringify(payload || {}));
        } else if (operation === "createPhonePeIntent") {
          FeastlyNative.createPhonePeIntent(requestId, firebaseIdToken, JSON.stringify(payload || {}));
        } else if (operation === "openExternalPayment") {
          FeastlyNative.openExternalPayment(requestId, String(payload && payload.url || ""));
        } else if (operation === "registerPushToken") {
          FeastlyNative.registerPushToken(requestId, firebaseIdToken);
        } else if (operation === "unregisterPushToken") {
          FeastlyNative.unregisterPushToken(requestId, firebaseIdToken);
        } else if (operation === "getDeliveryOtp") {
          FeastlyNative.getDeliveryOtp(requestId, String(payload && payload.orderId || ""));
        } else if (operation === "recoverDeliveryOtp") {
          FeastlyNative.recoverDeliveryOtp(requestId, firebaseIdToken, String(payload && payload.orderId || ""));
        } else {
          throw new Error("INVALID_OPERATION");
        }
      } catch (error) {
        clearTimeout(timer); nativeRequests.delete(requestId); reject(error);
      }
    });
  }

  async function registerPushTokenIfAllowed() {
    if (!state.session || state.profile.preferences.notifications === false || !nativeAvailable("registerPushToken")) return;
    await ensureSession();
    return nativeInvoke("registerPushToken", null, {idToken:state.session.idToken});
  }

  function unregisterPushTokenBestEffort() {
    if (!state.session || !state.session.idToken || !nativeAvailable("unregisterPushToken")) return;
    nativeInvoke("unregisterPushToken", null, {idToken:state.session.idToken,timeoutMs:8000}).catch(()=>{});
  }

  async function hydrateDeliveryOtp(orderId) {
    if (!orderId || state.deliveryOtps[orderId]) return;
    try {
      let result=null;
      if(nativeAvailable("getDeliveryOtp"))result=await nativeInvoke("getDeliveryOtp", {orderId}, {timeoutMs:5000});
      if((!result||!/^\d{4,6}$/.test(String(result.deliveryOtp||"")))&&state.session&&nativeAvailable("recoverDeliveryOtp")){
        await ensureSession();
        result=await nativeInvoke("recoverDeliveryOtp",{orderId},{idToken:state.session.idToken,timeoutMs:15000});
      }
      if (result && /^\d{4,6}$/.test(String(result.deliveryOtp || ""))) {
        state.deliveryOtps[orderId] = String(result.deliveryOtp);
        if (state.route === "order" && state.selectedOrderId === orderId) render({preserveScroll:true});
      }
    } catch (_) { }
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

  function dbUrl(path, token) {
    const base = String(CONFIG.databaseUrl || "").replace(/\/$/, "");
    if (!base) throw new Error("CONFIGURATION_MISSING");
    return base + "/" + String(path || "").replace(/^\/+/, "") + ".json" + (token ? "?auth=" + encodeURIComponent(token) : "");
  }

  function dbQueryUrl(path,token,parameters){
    const base=dbUrl(path,"");
    const pairs=[];
    if(token)pairs.push("auth="+encodeURIComponent(token));
    Object.keys(parameters||{}).forEach(key=>pairs.push(encodeURIComponent(key)+"="+encodeURIComponent(String(parameters[key]))));
    return base+(pairs.length?"?"+pairs.join("&"):"");
  }

  async function db(method, path, body, unauthenticated) {
    const session = unauthenticated ? state.session : await ensureSession();
    const token = session && session.idToken;
    const options = {method:method, headers:{"Content-Type":"application/json"}};
    if (body !== undefined) options.body = JSON.stringify(body);
    return request(dbUrl(path, token), options, 18000);
  }

  async function dbGetQuery(path,parameters,timeoutMs){
    const session=await ensureSession(),started=perfNow();
    try{return await request(dbQueryUrl(path,session.idToken,parameters),{method:"GET",headers:{"Content-Type":"application/json"}},timeoutMs||10000)}
    finally{perfLog("FIREBASE_QUERY_FINISHED",started,{path:String(path).replace(/\/[^/]+$/,"/:scope")})}
  }

  function friendlyError(error) {
    const code = String(error && error.message || error || "").replace(/^Firebase:\s*/i, "").split(" : ")[0];
    const map = {
      EMAIL_NOT_FOUND:"No account was found for that email.", INVALID_PASSWORD:"That password is incorrect.",
      INVALID_LOGIN_CREDENTIALS:"The email or password is incorrect.", EMAIL_EXISTS:"An account already uses that email.",
      WEAK_PASSWORD:"Use a stronger password with at least 8 characters.", USER_DISABLED:"This account has been disabled.",
      TOO_MANY_ATTEMPTS_TRY_LATER:"Too many attempts. Please wait before trying again.",
      NETWORK_REQUEST_FAILED:"Check your internet connection and try again.", REQUEST_TIMEOUT:"The connection took too long. Please try again.",
      CONFIGURATION_MISSING:"Firebase is not configured for this build.", AUTH_REQUIRED:"Please sign in again to continue.",
      APP_CHECK_UNAVAILABLE:"This installation could not be verified. Update Scraveit from Google Play and try again.",
      FUNCTION_UNAVAILABLE:"The ordering service is temporarily unavailable.", FUNCTION_FAILED:"The request could not be completed.",
      ORDER_SERVICE_UNAVAILABLE:"Secure ordering is not available in this build.", NATIVE_BRIDGE_UNAVAILABLE:"Secure ordering is not available in this build.",
      FAILED_PRECONDITION:"The order changed or an item is no longer available. Refresh and try again.",
      NOT_FOUND:"The selected restaurant, item or address is no longer available.",
      INVALID_ARGUMENT:"Review the cart and delivery details, then try again.",
      RESOURCE_EXHAUSTED:"Too many requests were made. Please wait and try again.",
      SECURE_STORAGE_UNAVAILABLE:"The delivery code could not be protected on this device. Retry safely to recover the order."
    };
    if (error && error.userMessage) return String(error.userMessage).slice(0,300);
    return map[code] ? map[code] + " [" + code + "]" : (code.length > 2 && !code.includes("[object") ? code : "Error: " + JSON.stringify(error));
  }

  async function syncProfile(remoteOnly) {
    if (!state.session) return;
    const previousScope=homeScope(currentAddress());
    const remote = await db("GET", DB_ROOT + "/users/" + encodeURIComponent(state.session.uid));
    if (remote && typeof remote === "object") {
      const prefs = Object.assign({}, state.profile.preferences || {}, remote.preferences || {});
      state.profile = Object.assign({}, state.profile, remote, {preferences:prefs});
      state.profile.addresses = Array.isArray(remote.addresses) ? remote.addresses : state.profile.addresses || [];
      state.profile.favourites = Array.isArray(remote.favourites) ? remote.favourites : state.profile.favourites || [];
      migrateSavedAddresses();persistProfile();applyTheme();
      if(previousScope!==homeScope(currentAddress())){
        // A profile refresh may select a different saved address while an older
        // catalogue request is still in flight. Invalidate that request before
        // restoring/refreshing the newly selected address so stale results can
        // never overwrite the latest address.
        state.catalogRequestSequence+=1;
        if(!restoreHomeCache(true)){
          state.catalog={};state.catalogLoaded=false;state.catalogMode="empty";state.homeStatus="loadingWithoutCache";
        }
        if(state.online)syncCatalog().catch(()=>{});
      }
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
    const packaged = FALLBACK_CATALOG[id] || {};
    data.id = data.id || id;
    data.name = data.name || "Restaurant";
    // A staged live catalogue can intentionally omit media until the owner uploads
    // licensed photos. Keep the locally licensed cover for the matching restaurant
    // so customers never fall back to a blank/cheap-looking card in that interval.
    data.image = data.imageUrl || data.image || packaged.image;
    data.cuisines = Array.isArray(data.cuisines) ? data.cuisines : String(data.type || "Food").split(/[·,]/).map(x=>x.trim()).filter(Boolean);
    data.menu = Array.isArray(data.menu) ? data.menu : data.items && typeof data.items === "object" ? Object.keys(data.items).map(key => Object.assign({id:key}, data.items[key])) : [];
    data.menu = data.menu
      .map((item,index) => Object.assign({id:item.id || data.id+"-item-"+index,category:item.category||"Menu",diet:item.diet||"veg",available:item.available!==false},item))
      .filter(item => item.archived !== true);
    data.open = data.open !== false && data.active !== false && data.archived !== true;
    return data;
  }

  function warmCatalogImages() {
    const urls=[];
    Object.values(state.catalog||{}).forEach(restaurant=>{
      const cover=safeUrl(restaurant.image,"");if(cover)urls.push(cover);
    });
    [...new Set(urls)].slice(0,8).forEach((url,index)=>setTimeout(()=>{const image=new Image();image.decoding="async";image.src=url;},index*35));
  }

  function normalizeRestaurantSummary(id,record){
    const full=normalizeRestaurant(id,record),existing=state.catalog[id],saved=cachedMenu(id);
    full.menuIndex=discoveryIndex(full.menu);
    full.menu=existing&&existing.menuLoaded?(existing.menu||[]):(saved||[]);
    full.menuLoaded=full.menu.length>0;
    return full;
  }

  function restaurantSummaryQuery(){
    const address=currentAddress(),city=String(address&&address.city||"").trim();
    if(city){
      return {orderBy:JSON.stringify("city"),equalTo:JSON.stringify(city),limitToFirst:"100"};
    }
    return {orderBy:JSON.stringify("$key"),limitToFirst:"100"};
  }

  async function fetchRestaurantSummaries(){
    return dbGetQuery(DB_ROOT+"/catalog/restaurants",restaurantSummaryQuery(),10000);
  }

  async function syncSecondaryHomeData(){
    const started=perfNow();
    const result=await Promise.allSettled([
      db("GET",DB_ROOT+"/promotions"),db("GET",DB_ROOT+"/settings/customer"),
      db("GET",DB_ROOT+"/localAds"),db("GET",DB_ROOT+"/customerBroadcasts"),
      state.session&&nativeAvailable("getCheckoutConfiguration")?nativeInvoke("getCheckoutConfiguration",{},{
        idToken:state.session.idToken,timeoutMs:15000
      }):Promise.resolve(null)
    ]);
    const value=index=>result[index].status==="fulfilled"?result[index].value:null;
    state.promotions=Object.keys(value(0)||{}).map(id=>Object.assign({id},value(0)[id])).filter(item=>item.active===true);
    state.settings=Object.assign(state.settings,value(1)||{});
    state.localAds=Object.keys(value(2)||{}).map(id=>Object.assign({id},value(2)[id]||{}));
    state.broadcasts=Object.keys(value(3)||{}).map(id=>Object.assign({id},value(3)[id]||{}));
    const liveCheckoutConfig=normalizeCheckoutConfiguration(value(4));
    if(liveCheckoutConfig)state.checkoutConfig=liveCheckoutConfig;
    reconcileCheckoutPaymentSelection();
    processBroadcasts();
    perfLog("SECONDARY_HOME_DATA_FINISHED",started,{failed:result.filter(item=>item.status==="rejected").length});
    if(["home","offers"].includes(state.route))render({preserveScroll:true});
  }

  async function ensureRestaurantMenu(restaurantId,options){
    const restaurant=state.catalog[restaurantId];
    const force=!!(options&&options.force),throwOnError=!!(options&&options.throwOnError);
    if(!restaurant)return [];
    if(!force&&restaurant.menuLoaded)return restaurant.menu||[];
    if(state.menuRequests[restaurantId])return state.menuRequests[restaurantId];
    const saved=cachedMenu(restaurantId);
    if(!force&&saved&&saved.length){restaurant.menu=saved;restaurant.menuLoaded=true;render({preserveScroll:true})}
    const request=(async()=>{
      state.menuLoading[restaurantId]=true;delete state.menuErrors[restaurantId];
      const started=perfNow();
      try {
        const map=await db("GET",DB_ROOT+"/menus/"+encodeURIComponent(restaurantId));
        const items=Object.keys(map||{}).map(itemId=>{const item=Object.assign({id:itemId},map[itemId]||{});item.image=item.imageUrl||item.image;return item}).filter(item=>item.archived!==true);
        restaurant.menu=items;restaurant.menuIndex=discoveryIndex(items);restaurant.menuLoaded=true;saveMenuCache(restaurantId,items);
        perfLog("RESTAURANT_MENU_LOADED",started,{restaurantId,items:items.length,forced:force});
        return items;
      } catch (error) {
        if(!restaurant.menuLoaded)state.menuErrors[restaurantId]=friendlyError(error);
        perfLog("RESTAURANT_MENU_FAILED",started,{restaurantId,code:String(error&&error.message||"unknown"),forced:force});
        if(throwOnError)throw error;
        return restaurant.menu||[];
      } finally {
        delete state.menuLoading[restaurantId];delete state.menuRequests[restaurantId];
        if(state.route==="restaurant"&&state.selectedRestaurantId===restaurantId)render({preserveScroll:true});
      }
    })();
    state.menuRequests[restaurantId]=request;
    return request;
  }

  async function syncCatalog() {
    if (!state.session) return;
    const sequence=++state.catalogRequestSequence,started=perfNow(),hadCache=state.catalogLoaded&&Object.keys(state.catalog).length>0;
    state.homeStatus=hadCache?"refreshing":"loadingWithoutCache";
    perfLog("REMOTE_CATALOG_STARTED",started,{sequence,scope:homeScope(currentAddress()),cachedRestaurants:Object.keys(state.catalog).length});
    try {
      const records=await fetchRestaurantSummaries()||{};
      if(sequence<state.catalogRequestSequence){perfLog("STALE_CATALOG_IGNORED",started,{sequence,latest:state.catalogRequestSequence});return}
      const next={};
      Object.keys(records).forEach(id=>{const restaurant=normalizeRestaurantSummary(id,records[id]);if(restaurant.archived!==true)next[id]=restaurant});
      state.catalog=next;state.catalogMode="live";state.catalogLoaded=true;state.homeStatus=Object.keys(next).length?"success":"empty";
      state.appliedCatalogSequence=sequence;state.lastSync=Date.now();state.syncError="";saveHomeCache();warmCatalogImages();
      const payloadBytes=(()=>{try{return JSON.stringify(records).length}catch(_){return 0}})();
      perfLog("REMOTE_CATALOG_APPLIED",started,{sequence,downloaded:Object.keys(records).length,displayable:Object.keys(next).length,payloadBytes});
    } catch (error) {
      if(sequence<state.catalogRequestSequence)return;
      state.catalogLoaded=true;state.homeStatus=Object.keys(state.catalog).length?"errorWithCache":"errorWithoutCache";
      state.syncError=Object.keys(state.catalog).length?"Live catalogue refresh failed. Showing saved restaurants.":"Restaurants could not be loaded. Check your connection and retry.";
      perfLog("REMOTE_CATALOG_FAILED",started,{sequence,cacheRetained:Object.keys(state.catalog).length>0,code:String(error&&error.message||"unknown")});
    } finally {
      if(sequence===state.catalogRequestSequence&&["home","search","restaurant"].includes(state.route))render({preserveScroll:true});
    }
  }

  function normalizeOrders(map) {
    return Object.keys(map || {}).map(id=>Object.assign({id:id},map[id]||{})).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
  }

  async function syncOrders(silent) {
    if (!state.session) return;
    const sessionUid=String(state.session.uid||""),reviewSequence=++state.reviewSyncSequence;
    try {
      const pair = await Promise.all([db("GET", DB_ROOT + "/orders/" + encodeURIComponent(sessionUid)),db("GET",DB_ROOT+"/reviews/"+encodeURIComponent(sessionUid)).then(value=>({ok:true,value:value})).catch(()=>({ok:false,value:null}))]);
      if(!state.session||String(state.session.uid||"")!==sessionUid||reviewSequence!==state.reviewSyncSequence)return;
      const map = pair[0];
      // Keep the per-account local review cache when the review request is
      // temporarily unavailable. Clearing it here made an already-reviewed
      // delivery flash on the home screen during every cold start.
      if(pair[1].ok)applyReviewSnapshot(sessionUid,reviewSequence,pair[1].value);
      const before = {};
      state.orders.forEach(order=>before[order.id]=order.status);
      state.orders = normalizeOrders(map);
      persistOrders();
      state.orders.forEach(order => {
        if (TERMINAL_STATES.has(order.status) && state.deliveryOtps[order.id]) {
          delete state.deliveryOtps[order.id];
          if (nativeAvailable("deleteDeliveryOtp")) {
            try { FeastlyNative.deleteDeliveryOtp(order.id); } catch (_) { }
          }
        }
      });
      state.orders.forEach(order => {
        if (before[order.id] && before[order.id] !== order.status) notifyOrderTransition(order, before[order.id]);
      });
      const deliveredForReview=reviewStateReady()?state.orders.find(order=>before[order.id]&&before[order.id]!=="Delivered"&&order.status==="Delivered"&&!state.reviews[order.id]):null;
      const active = state.orders.filter(order=>ACTIVE_STATES.has(order.status));
      active.filter(order=>["Out for delivery","Near you","Arrived"].includes(order.status)).forEach(order=>hydrateDeliveryOtp(order.id));
      await refreshTrackingStreams(active);
      // Firebase streams send an authoritative initial snapshot. Use a one-shot
      // hydration only until that snapshot is known, rather than re-downloading
      // every active order's tracking record on each order/status refresh.
      await hydrateInitialTracking(active);
      state.lastSync = Date.now(); state.syncError = "";
      if(deliveredForReview){go("review",{orderId:deliveredForReview.id});return;}
      if (!silent && ["home","orders","order","tracking"].includes(state.route)) render({preserveScroll:true});
    } catch (error) {
      state.syncError = "Live order updates are temporarily unavailable.";
      if (!silent) render({preserveScroll:true});
    }
  }

  function notifyOrderTransition(order) {
    const copy = {
      Accepted:"The restaurant accepted your order. Scraveit is finding the nearest available rider now.", Preparing:order.riderId?"The kitchen is preparing your order while your rider heads to the restaurant.":"The kitchen is preparing your order while Scraveit finds your rider.",
      "Ready for pickup":order.riderId?"Your order is ready and your assigned rider can collect it.":"Your order is ready while Scraveit finishes assigning the nearest rider.", Assigned:"A delivery partner has been assigned and is heading to the restaurant.",
      "Handed to rider":"Your order has been handed to the delivery partner.", "Out for delivery":"Your order is on the way.",
      "Near you":"Your delivery partner is nearby.", Arrived:"Your delivery partner is at the delivery location.",
      Delivered:"Your order has been delivered. Enjoy your meal!", Cancelled:"This order was cancelled."
    };
    if (copy[order.status]) {
      toast(copy[order.status], order.status === "Cancelled" ? "danger" : "success");
      // The backend is the single authoritative source of system status notifications.
      // This realtime listener updates only the in-app UI; emitting a second native
      // notification here caused duplicate Accepted notifications on the same device.
    }
  }

  function hashCode(text) { let hash=0; for(let i=0;i<text.length;i++) hash=((hash<<5)-hash)+text.charCodeAt(i)|0; return hash; }

  function closeWatcher(watcher) { try { if (watcher) watcher.close(); } catch (_) {} }
  function parseStreamEvent(event) {
    try { return event && event.data ? JSON.parse(event.data) : null; } catch (_) { return null; }
  }
  async function watchPath(path, onChange, parameters, onDisconnect) {
    if (!state.session || !window.EventSource) return null;
    const session = await ensureSession();
    // Realtime Database streaming queries obey the same order/equality/limit
    // parameters as one-shot REST reads. Keeping the catalogue stream scoped
    // prevents every customer from downloading every city's restaurant tree.
    const source = new EventSource(parameters
      ? dbQueryUrl(path, session.idToken, parameters)
      : dbUrl(path, session.idToken));
    source.addEventListener("put", event => onChange(parseStreamEvent(event), "put"));
    source.addEventListener("patch", event => onChange(parseStreamEvent(event), "patch"));
    source.onerror = function () {
      source.__savrivoDisconnected=true;
      closeWatcher(source);
      if(typeof onDisconnect==="function")onDisconnect(source);
    };
    return source;
  }
  function scheduleScopedSync(kind) {
    if(!["catalog","orders"].includes(kind))return;
    clearTimeout(state.syncTimers[kind]);
    state.syncTimers[kind] = setTimeout(async () => {
      state.syncTimers[kind]=null;
      try {
        if (kind === "catalog") await syncCatalog();
        else await syncOrders(true);
        if (["home","search","restaurant","orders","order","tracking"].includes(state.route)) render({preserveScroll:true});
      } catch (_) {}
    }, 180);
  }
  function scheduleRealtimeReconnect(kind) {
    if(!["catalog","orders"].includes(kind)||!state.session||!state.online)return;
    const timerKey=kind==="catalog"?"reconnectCatalog":"reconnectOrders";
    clearTimeout(state.syncTimers[timerKey]);
    state.syncTimers[timerKey]=setTimeout(()=>{
      state.syncTimers[timerKey]=null;
      ensureRealtimeWatcher(kind).catch(()=>scheduleRealtimeReconnect(kind));
    },5000);
  }
  async function ensureRealtimeWatcher(kind) {
    if(!state.session||!state.online||!window.EventSource||!["catalog","orders"].includes(kind))return null;
    const parameters=kind==="catalog"?restaurantSummaryQuery():null;
    const scope=kind==="catalog"?JSON.stringify(parameters||{}):String(state.session.uid||"");
    if(state.watchers[kind]&&state.watcherScopes[kind]===scope)return state.watchers[kind];
    if(state.watchers[kind]){closeWatcher(state.watchers[kind]);state.watchers[kind]=null;state.watcherScopes[kind]="";}
    if(state.watcherStarts[kind])return state.watcherStarts[kind];
    const started=(async()=>{
      let source=null;
      const path=kind==="catalog"?DB_ROOT+"/catalog/restaurants":DB_ROOT+"/orders/"+encodeURIComponent(state.session.uid);
      source=await watchPath(path,()=>scheduleScopedSync(kind),parameters,failed=>{
        if(state.watchers[kind]===failed){state.watchers[kind]=null;state.watcherScopes[kind]="";}
        scheduleRealtimeReconnect(kind);
      });
      const currentParameters=kind==="catalog"?restaurantSummaryQuery():null;
      const currentScope=kind==="catalog"?JSON.stringify(currentParameters||{}):String(state.session&&state.session.uid||"");
      if(!state.session||!state.online||currentScope!==scope||source&&source.__savrivoDisconnected){closeWatcher(source);if(state.session&&state.online)scheduleRealtimeReconnect(kind);return null;}
      state.watchers[kind]=source;state.watcherScopes[kind]=scope;
      return source;
    })();
    state.watcherStarts[kind]=started;
    try{return await started;}catch(error){scheduleRealtimeReconnect(kind);throw error;}finally{state.watcherStarts[kind]=null;}
  }
  function applyTrackingEvent(orderId, payload, eventName) {
    if (!payload) return;
    state.trackingHydrated[orderId]=true;
    if (payload.path === "/") {
      if (eventName === "patch") {
        // A root-path "patch" event merges these children into the existing
        // record - Firebase's REST stream can consolidate a write that
        // touches several direct children (e.g. just status+updatedAt) into
        // a single event at path "/". Treating that the same as "put" would
        // wipe out fields the write didn't touch (like the rider's lat/lng)
        // even though they are still current.
        const merged = Object.assign({}, state.tracking[orderId] || {});
        const patchData = payload.data;
        if (patchData && typeof patchData === "object") {
          Object.keys(patchData).forEach(key => {
            if (patchData[key] == null) delete merged[key]; else merged[key] = patchData[key];
          });
          state.tracking[orderId] = merged;
        } else if (patchData == null) delete state.tracking[orderId];
      }
      else if(payload.data==null)delete state.tracking[orderId];
      else state.tracking[orderId] = payload.data || {};
    }
    else {
      const target = Object.assign({}, state.tracking[orderId] || {});
      const parts = String(payload.path || "").split("/").filter(Boolean);
      if (parts.length === 1) target[parts[0]] = payload.data;
      state.tracking[orderId] = target;
    }
    state.lastSync = Date.now();
    state.trackingSeenAt[orderId] = Date.now();
    if (state.route === "tracking" && state.selectedOrderId === orderId) {
      if (!patchTrackingMap(orderId)) render({preserveScroll:true});
    }
  }
  async function hydrateInitialTracking(activeOrders){
    const missing=(activeOrders||[]).filter(order=>!state.trackingHydrated[order.id]);
    const results=await Promise.all(missing.map(async order=>{
      try{return {id:order.id,ok:true,value:await db("GET",DB_ROOT+"/tracking/"+encodeURIComponent(order.id))};}
      catch(_){return {id:order.id,ok:false,value:null};}
    }));
    results.forEach(result=>{
      if(!result.ok)return;
      state.trackingHydrated[result.id]=true;
      if(result.value)state.tracking[result.id]=result.value;
    });
  }
  function scheduleTrackingReconnect(orderId){
    clearTimeout(state.trackingReconnectTimers[orderId]);
    if(!state.session||!state.online)return;
    state.trackingReconnectTimers[orderId]=setTimeout(()=>{
      delete state.trackingReconnectTimers[orderId];
      const order=activeOrders().find(item=>item.id===orderId);
      if(order)ensureTrackingWatcher(order).catch(()=>scheduleTrackingReconnect(orderId));
    },5000);
  }
  async function ensureTrackingWatcher(order){
    if(!order||!state.session||!state.online||!window.EventSource)return null;
    if(state.trackingWatchers[order.id])return state.trackingWatchers[order.id];
    if(state.trackingWatcherStarts[order.id])return state.trackingWatcherStarts[order.id];
    const started=(async()=>{
      let source=null;
      source=await watchPath(DB_ROOT+"/tracking/"+encodeURIComponent(order.id),(payload,eventName)=>applyTrackingEvent(order.id,payload,eventName),null,failed=>{
        if(state.trackingWatchers[order.id]===failed)delete state.trackingWatchers[order.id];
        scheduleTrackingReconnect(order.id);
      });
      if(!activeOrders().some(item=>item.id===order.id)||source&&source.__savrivoDisconnected){closeWatcher(source);return null;}
      state.trackingWatchers[order.id]=source;
      return source;
    })();
    state.trackingWatcherStarts[order.id]=started;
    try{return await started;}finally{delete state.trackingWatcherStarts[order.id];}
  }
  async function refreshTrackingStreams(activeOrders) {
    const activeIds = new Set((activeOrders || []).map(order => order.id));
    Object.keys(state.trackingWatchers).forEach(id => {
      if (!activeIds.has(id)) { closeWatcher(state.trackingWatchers[id]); delete state.trackingWatchers[id]; delete state.trackingHydrated[id]; delete state.tracking[id]; delete state.trackingSeenAt[id]; if(state.trackingMap&&state.trackingMap.orderId===id){clearTimeout(state.trackingMap.tileTimer);state.trackingMap=null;} clearTimeout(state.trackingReconnectTimers[id]);delete state.trackingReconnectTimers[id]; }
    });
    for (const order of activeOrders || []) {
      try { await ensureTrackingWatcher(order); } catch (_) { scheduleTrackingReconnect(order.id); }
    }
  }
  function stopRealtime() {
    Object.keys(state.watchers).forEach(kind=>closeWatcher(state.watchers[kind]));state.watchers={catalog:null,orders:null};state.watcherStarts={catalog:null,orders:null};state.watcherScopes={catalog:"",orders:""};
    Object.keys(state.trackingWatchers).forEach(id => closeWatcher(state.trackingWatchers[id]));
    state.trackingWatchers = {};state.trackingWatcherStarts={};
    Object.keys(state.trackingReconnectTimers).forEach(id=>clearTimeout(state.trackingReconnectTimers[id]));state.trackingReconnectTimers={};
    Object.keys(state.syncTimers).forEach(key=>clearTimeout(state.syncTimers[key]));state.syncTimers={catalog:null,orders:null,reconnectCatalog:null,reconnectOrders:null};
  }
  async function startRealtime() {
    if (!state.session || !state.online || !window.EventSource) return;
    // Each stream owns its own reconnect lifecycle. A temporary catalogue
    // failure must never tear down healthy order or live-tracking streams.
    await Promise.allSettled([ensureRealtimeWatcher("catalog"),ensureRealtimeWatcher("orders")]);
    await refreshTrackingStreams(activeOrders());
  }

  async function bootstrap() {
    const started=state.homeBootStartedAt;
    applyTheme();
    migrateSavedAddresses();
    const cacheAvailable=restoreHomeCache(true);
    if (!localStorage.getItem("savrivo.customer.seenWelcome")) state.route = "welcome";
    else state.route = state.session ? "home" : "login";
    render();
    perfLog("HOME_SHELL_RENDERED",started,{route:state.route,cacheAvailable});
    if (!state.session) return;
    state.loading = false; render({preserveScroll:true});
    try {
      const authStarted=perfNow();
      await ensureSession();
      perfLog("AUTH_SESSION_READY",authStarted,{});
      const profilePromise=syncProfile(false).then(()=>{migrateSavedAddresses();return true});
      const results=await Promise.allSettled([profilePromise,syncCatalog(),syncOrders(true),syncEmailVerification(),syncSecondaryHomeData()]);
      const failed=results.filter(result=>result.status==="rejected").length;
      if(failed)perfLog("NON_BLOCKING_STARTUP_FAILURES",started,{failed});
      state.route="home";
      startPolling();
      registerPushTokenIfAllowed().catch(()=>{});
    } catch (error) {
      if (["INVALID_REFRESH_TOKEN","TOKEN_EXPIRED","USER_DISABLED","AUTH_REQUIRED"].some(code=>String(error.message).includes(code))) signOut(false);
      else {
        state.catalogLoaded=true;state.homeStatus=Object.keys(state.catalog).length?"errorWithCache":"errorWithoutCache";
        state.syncError=Object.keys(state.catalog).length?"Could not refresh live data. Saved restaurants are still available.":"Restaurants could not be loaded. Check your connection and retry.";
      }
    } finally { state.loading = false; app.setAttribute("aria-busy","false"); render({preserveScroll:true}); }
  }

  function startPolling() {
    stopPolling();
    startRealtime().catch(()=>{});
    // Slow resilience poll only. Normal live updates arrive through scoped Firebase streams.
    state.timers.push(setInterval(()=>{ if(document.visibilityState === "visible" && state.online) syncOrders(true); }, 120000));
    state.timers.push(setInterval(()=>{ if(document.visibilityState === "visible" && state.online) Promise.allSettled([syncCatalog(),syncSecondaryHomeData()]); }, 300000));
  }
  function stopPolling() { state.timers.forEach(clearInterval); state.timers = []; stopRealtime(); }

  function toast(message, type) {
    clearTimeout(state.toastTimer);
    toastRegion.innerHTML = '<div class="toast '+h(type||"")+'">'+h(message)+'</div>';
    const durationMs = type === "success" ? 900 : 5000;
    state.toastTimer = setTimeout(()=>{ toastRegion.innerHTML=""; }, durationMs);
  }
  function setSheet(sheet) { state.sheet = sheet; renderSheet(); }
  function closeSheet() { state.sheet = null; renderSheet(); }

  function pageScroller() {
    return document.querySelector("#app > main");
  }
  function currentPageScrollTop() {
    const scroller=pageScroller();
    return scroller ? Number(scroller.scrollTop||0) : Number(window.scrollY||0);
  }
  function setPageScrollTop(value) {
    requestAnimationFrame(()=>{
      const scroller=pageScroller();
      if(scroller){scroller.scrollTop=Math.max(0,Number(value||0));return;}
      try{window.scrollTo(0,Math.max(0,Number(value||0)))}catch(_){}
    });
  }
  function resetPageScroll(){setPageScrollTop(0);}

  function go(route, data, replace) {
    if (!replace && state.route !== route) state.history.push({route:state.route,data:state.routeData});
    state.route = route; state.routeData = data || {};
    if (data && data.restaurantId) state.selectedRestaurantId = data.restaurantId;
    if (data && data.orderId) state.selectedOrderId = data.orderId;
    closeSheet();
    render(); resetPageScroll();
  }
  function goBack() {
    const previous = state.history.pop();
    if (previous) { state.route = previous.route; state.routeData = previous.data || {}; closeSheet(); render(); resetPageScroll(); return true; }
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

  function geoDistanceKm(lat1,lng1,lat2,lng2) {
    const values=[lat1,lng1,lat2,lng2].map(Number);
    if(!values.every(Number.isFinite))return null;
    const [a1,o1,a2,o2]=values,rad=v=>v*Math.PI/180;
    const dLat=rad(a2-a1),dLng=rad(o2-o1);
    const x=Math.sin(dLat/2)*Math.sin(dLat/2)
      +Math.cos(rad(a1))*Math.cos(rad(a2))
      *Math.sin(dLng/2)*Math.sin(dLng/2);
    return 6371*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
  }

  function restaurantDistanceKm(r) {
    const a=currentAddress();
    if(!a||!r)return null;
    return geoDistanceKm(a.lat,a.lng,r.lat,r.lng);
  }

  function deliveryRadiusKm(r) {
    const own=Number(r&&r.deliveryRadiusKm);
    return Number.isFinite(own)&&own>0 ? own : Number(state.settings.maxDeliveryKm||15);
  }

  function restaurantServiceable(r) {
    const d=restaurantDistanceKm(r);
    return d==null || d<=deliveryRadiusKm(r);
  }

  function keyName(value){return String(value||"").trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")}
  function deliverySlabs(){const raw=state.settings.deliverySlabs||{};const list=Array.isArray(raw)?raw:Object.keys(raw).sort((a,b)=>Number(a)-Number(b)).map(k=>raw[k]);return (list||[]).filter(x=>x&&Number.isFinite(Number(x.maxKm))&&Number.isFinite(Number(x.fee))).sort((a,b)=>Number(a.maxKm)-Number(b.maxKm))}
  function deliveryFeeForRestaurant(r,subtotal){if(!r)return 0;const threshold=Number(state.settings.freeDeliveryAbove||0);if(threshold>0&&Number(subtotal||0)>=threshold)return 0;const d=restaurantDistanceKm(r);if(d==null)return Number(state.settings.fallbackDeliveryFee||29);const base=deliverySlabs(),over=state.settings.deliveryFeeOverrides||{},a=currentAddress()||{},rid=keyName(r.id),area=keyName(a.area),city=keyName(r.city||a.city||a.area),fees=over.restaurants&&over.restaurants[rid]||over.areas&&over.areas[area]||over.cities&&over.cities[city]||null,slabs=fees&&fees.length===base.length?base.map((x,i)=>({maxKm:x.maxKm,fee:Number(fees[i])})):base;for(const slab of slabs)if(d<=Number(slab.maxKm))return Math.max(0,Number(slab.fee||0));return Math.max(0,Number(slabs.length?slabs[slabs.length-1].fee:139))}
  function clampLat(lat){return Math.max(-85.05112878,Math.min(85.05112878,Number(lat)||0));}
  function mapWorld(lat,lng,zoom){const size=256*Math.pow(2,zoom),x=(Number(lng)+180)/360*size,rad=clampLat(lat)*Math.PI/180,y=(1-Math.log(Math.tan(rad)+1/Math.cos(rad))/Math.PI)/2*size;return{x,y,size};}
  function worldToLatLng(x,y,zoom){const size=256*Math.pow(2,zoom),lng=x/size*360-180,n=Math.PI-2*Math.PI*y/size,lat=180/Math.PI*Math.atan(Math.sinh(n));return{lat:clampLat(lat),lng:Math.max(-180,Math.min(180,lng))};}
  // Last-resort centre for the pin map, only reached when nothing is known about
  // where this customer is. Deliberately paired with a wide zoom so it reads as
  // "find your area" instead of pretending to be their street.
  const ADDRESS_MAP_FALLBACK={lat:14.9077,lng:79.8946,zoom:12};
  function coordinatePoint(source){
    if(!source)return null;
    const rawLat=source.lat,rawLng=source.lng;
    // Number(null) and Number("") are 0, so empty values have to be rejected
    // before the numeric check or a missing pin becomes a point at (0, 0).
    if(rawLat==null||rawLng==null||rawLat===""||rawLng==="")return null;
    const lat=Number(rawLat),lng=Number(rawLng);
    if(!Number.isFinite(lat)||!Number.isFinite(lng))return null;
    if(lat<-90||lat>90||lng<-180||lng>180)return null;
    if(lat===0&&lng===0)return null; // no real delivery address sits on Null Island
    return {lat:lat,lng:lng};
  }
  // Open the pin map on the best thing we actually know: the address being
  // edited, then their chosen address, then any saved address (a detected GPS
  // one first), then the restaurant they are ordering from. The browsing
  // restaurant is deliberately not used - it has a fixed default that would put
  // every new customer in the same town.
  function addressMapSeed(source){
    const saved=state.profile.addresses||[];
    const candidates=[source,currentAddress()]
      .concat(saved.filter(entry=>entry&&entry.source==="gps"))
      .concat(saved)
      .concat([cartRestaurant()]);
    for(let i=0;i<candidates.length;i++){
      const point=coordinatePoint(candidates[i]);
      if(point)return {lat:point.lat,lng:point.lng,zoom:16};
    }
    return {lat:ADDRESS_MAP_FALLBACK.lat,lng:ADDRESS_MAP_FALLBACK.lng,zoom:ADDRESS_MAP_FALLBACK.zoom};
  }
  function openAddressSheet(address){
    const source=address||{},seed=addressMapSeed(source);
    state.addressMapDraft={lat:seed.lat,lng:seed.lng};state.addressMapZoom=seed.zoom;setSheet({type:"address",address:clone(source)});
  }
  function addressMapMarkup(){
    const point=state.addressMapDraft||addressMapSeed(null),zoom=Math.max(12,Math.min(18,Number(state.addressMapZoom)||16)),world=mapWorld(point.lat,point.lng,zoom),tileX=Math.floor(world.x/256),tileY=Math.floor(world.y/256),max=Math.pow(2,zoom),tiles=[];
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){let tx=(tileX+dx)%max;if(tx<0)tx+=max;const ty=Math.max(0,Math.min(max-1,tileY+dy)),left=(tileX+dx)*256-world.x,top=(tileY+dy)*256-world.y;tiles.push('<img alt="" aria-hidden="true" src="https://tile.openstreetmap.org/'+zoom+'/'+tx+'/'+ty+'.png" style="position:absolute;width:256px;height:256px;left:calc(50% + '+left.toFixed(1)+'px);top:calc(50% + '+top.toFixed(1)+'px);max-width:none">');}
    return '<div class="stack"><div class="cluster between"><div><strong>Delivery pin</strong><div class="caption">Tap the map to move the pin. Use phone location for your exact position.</div></div><div class="cluster"><button type="button" class="icon-button" data-action="address-map-zoom" data-delta="-1" aria-label="Zoom out">−</button><button type="button" class="icon-button" data-action="address-map-zoom" data-delta="1" aria-label="Zoom in">+</button></div></div><div data-action="address-map-pick" class="map-picker" role="button" tabindex="0" aria-label="Choose delivery location on map" style="height:250px;position:relative;overflow:hidden;border-radius:18px;border:1px solid var(--border);background:#dce7ef;touch-action:manipulation">'+tiles.join("")+'<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-100%);font-size:34px;filter:drop-shadow(0 3px 4px rgba(0,0,0,.35));pointer-events:none">📍</div></div><div class="cluster wrap"><button type="button" class="button tonal grow" data-action="detect-address-location">'+icon("target","small")+' Use phone location</button><span class="caption">'+point.lat.toFixed(5)+', '+point.lng.toFixed(5)+'</span></div></div>';
  }
  function restaurant(id){return state.catalog[id||state.selectedRestaurantId]||null;}
  function menuItem(rid,iid){const r=restaurant(rid);return r&&r.menu.find(x=>x.id===iid);}
  function cartCount(){return state.cart.reduce((sum,item)=>sum+Number(item.quantity||0),0);}
  function cartRestaurant(){return state.cart.length?restaurant(state.cart[0].restaurantId):null;}
  function cartSubtotal(){return state.cart.reduce((sum,item)=>sum+(Number(item.price)+Number(item.variantPrice||0)+Number(item.addOnTotal||0))*Number(item.quantity||0),0);}
  function deliveryFee(){return deliveryFeeForRestaurant(cartRestaurant(),cartSubtotal());}
  function platformFeeDetails(){const r=cartRestaurant(),base=Number(state.settings.platformFee==null?9:state.settings.platformFee),over=state.settings.platformFeeOverrides||{},subtotal=cartSubtotal(),addr=currentAddress()||{},rid=keyName(r&&r.id),area=keyName(addr.area),city=keyName(r&&r.city||addr.city||addr.area),category=keyName(r&&r.category||r&&r.type||(r&&r.cuisines||[])[0]);if(over.restaurants&&over.restaurants[rid]!=null)return{fee:Number(over.restaurants[rid]),rule:"Restaurant override"};const rules=over.orderValueRules||{};for(const k of Object.keys(rules)){const rule=rules[k]||{},min=Number(rule.min||0),max=rule.max==null?Infinity:Number(rule.max);if(subtotal>=min&&subtotal<=max&&Number.isFinite(Number(rule.fee)))return{fee:Number(rule.fee),rule:"Order value override"}}if(over.categories&&over.categories[category]!=null)return{fee:Number(over.categories[category]),rule:"Category override"};if(over.areas&&over.areas[area]!=null)return{fee:Number(over.areas[area]),rule:"Area override"};if(over.cities&&over.cities[city]!=null)return{fee:Number(over.cities[city]),rule:"City override"};return{fee:base,rule:"Global default"}}
  function platformFee(){return Math.max(0,platformFeeDetails().fee);}
  function eligibleCoupon(){if(!state.coupon||!state.cart.length||state.coupon.active!==true)return null;if(state.coupon.expiresAt&&Date.now()>Number(state.coupon.expiresAt))return null;if(state.coupon.minimumOrder&&cartSubtotal()<Number(state.coupon.minimumOrder))return null;if(Array.isArray(state.coupon.restaurantIds)&&!state.coupon.restaurantIds.includes(state.cart[0].restaurantId))return null;return state.coupon;}
  function discount(){const coupon=eligibleCoupon();return coupon?Math.min(Number(coupon.maxDiscount||99999),cartSubtotal()*Number(coupon.percent||0)/100):0;}
  function tax(){return Math.max(0,(cartSubtotal()-discount())*Number(state.settings.taxRate||0)/100);}
  function smallOrderFee(){return state.settings.smallOrderFeeEnabled===true&&cartSubtotal()>0&&cartSubtotal()<Number(state.settings.smallOrderThreshold||149)?Math.max(0,Number(state.settings.smallOrderFee||19)):0;}
  function lateNightFee(){if(state.settings.lateNightFeeEnabled!==true)return 0;const hNow=new Date().getHours(),start=Number(state.settings.lateNightStartHour==null?23:state.settings.lateNightStartHour),end=Number(state.settings.lateNightEndHour==null?5:state.settings.lateNightEndHour),active=start>end?(hNow>=start||hNow<end):(hNow>=start&&hNow<end);return active?Math.max(0,Number(state.settings.lateNightFee||19)):0;}
  function rainFee(){return Math.max(0,Number(state.dynamicPricing&&state.dynamicPricing.rainFee||0));}
  function surgeFee(){return Math.max(0,Number(state.dynamicPricing&&state.dynamicPricing.surgeFee||0));}
  function riderIncentiveFee(){return Math.max(0,Number(state.dynamicPricing&&state.dynamicPricing.riderIncentiveFee||0));}
  function riderIncentiveItems(){return(state.dynamicPricing&&Array.isArray(state.dynamicPricing.riderIncentiveItems))?state.dynamicPricing.riderIncentiveItems:[];}
  function orderTotal(){return Math.max(0,cartSubtotal()+deliveryFee()+platformFee()+smallOrderFee()+lateNightFee()+rainFee()+surgeFee()+riderIncentiveFee()+Number(state.tip||0)+tax()-discount());}
  // Dynamic weather/demand/rider-incentive pricing is calculated only by the
  // trusted backend - the APK never contains a Weather API server key and
  // never authorizes these fees itself. This calls the live preview on
  // getCheckoutConfiguration (same loadServerFees() computation used at real
  // order creation) so the checkout screen shows the true fee before the
  // customer commits, instead of guessing client-side. Any failure - no
  // session, no cart/address yet, network issue - falls back to zero so
  // checkout is never blocked by a preview problem; the real, authoritative
  // fee is still enforced server-side when the order is actually placed.
  const dynamicPricingFallback=()=>({rainFee:0,surgeFee:0,riderIncentiveFee:0,riderIncentiveItems:[],weatherSeverity:"",weatherChecked:false,activeOrders:0,serverAuthoritative:true,checkedAt:Date.now()});
  async function refreshDynamicPricing(){
    const fallback=dynamicPricingFallback();
    const r=cartRestaurant(),addr=currentAddress();
    if(!state.session||!r||!addr||!state.cart.length||!nativeAvailable("getCheckoutConfiguration")){state.dynamicPricing=fallback;return fallback}
    try{
      const raw=await nativeInvoke("getCheckoutConfiguration",{restaurantId:r.id,addressId:addr.id,items:callableCartItems()},{idToken:state.session.idToken,timeoutMs:15000});
      const preview=raw&&typeof raw==="object"&&raw.feePreview&&typeof raw.feePreview==="object"?raw.feePreview:null;
      const next=preview?{
        rainFee:Math.max(0,Number(preview.rainFee||0)),
        surgeFee:Math.max(0,Number(preview.surgeFee||0)),
        riderIncentiveFee:Math.max(0,Number(preview.riderIncentiveFee||0)),
        riderIncentiveItems:Array.isArray(preview.riderIncentiveItems)?preview.riderIncentiveItems.map(x=>({label:String(x&&x.label||"Surge fee"),amount:Math.max(0,Number(x&&x.amount||0))})).filter(x=>x.amount>0):[],
        weatherSeverity:String(preview.weatherSeverity||""),weatherChecked:true,activeOrders:Math.max(0,Number(preview.activeOrders||0)),
        serverAuthoritative:true,checkedAt:Date.now()
      }:fallback;
      state.dynamicPricing=next;
      return next;
    }catch(_){
      state.dynamicPricing=fallback;
      return fallback;
    }
  }
  function maskPhoneNumbers(value){return String(value||"").replace(/(?:\+?91[\s.()-]*)?[6-9](?:[\s.()-]*\d){9}/g,"[phone number hidden]")}
  function chatPath(o,channel){return DB_ROOT+"/orderChats/"+encodeURIComponent(state.session.uid)+"/"+encodeURIComponent(o.id)+"/"+channel}
  async function openOrderChat(o,channel,title){if(!o)return;try{const raw=await db("GET",chatPath(o,channel));state.chat={orderId:o.id,channel,messages:Object.keys(raw||{}).map(id=>Object.assign({id},raw[id]||{})).sort((a,b)=>Number(a.at||0)-Number(b.at||0)),title:title||"Order chat"};go("chat",{orderId:o.id,channel})}catch(e){toast("Chat could not open. "+friendlyError(e),"danger")}}
  async function sendOrderChat(form){const o=state.orders.find(x=>x.id===state.chat.orderId),original=String(new FormData(form).get("message")||"").trim();if(!o||!original)return;const body=maskPhoneNumbers(original).slice(0,800),id=uid("m_").replace(/-/g,""),record={id,senderId:state.session.uid,senderRole:"customer",body,masked:body!==original,at:Date.now()};try{await db("PUT",chatPath(o,state.chat.channel)+"/"+id,record);state.chat.messages.push(record);form.reset();render({preserveScroll:true});if(record.masked)toast("A phone number was hidden for privacy.","success")}catch(e){toast("Message could not be sent. "+friendlyError(e),"danger")}}


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
      variant:variant&&variant.name||"", variantId:variant&&String(variant.id||variant.name)||"",
      variantPrice:Number(variant&&(variant.priceDelta!=null?variant.priceDelta:variant.price)||0), addOns:addOns,
      addOnIds:addOns.map(x=>String(x.id||x.name||"")).filter(Boolean),
      addOnTotal:addOns.reduce((sum,x)=>sum+Number(x.priceDelta!=null?x.priceDelta:x.price||0),0), note:custom&&custom.note||""
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

  function addressDeletionPlan(addresses,selectedAddressId,addressId){
    const remaining=(Array.isArray(addresses)?addresses:[]).filter(address=>address&&address.id!==addressId);
    const selectedStillExists=remaining.some(address=>address.id===selectedAddressId);
    return {addresses:remaining,selectedAddressId:selectedStillExists?selectedAddressId:(remaining[0]&&remaining[0].id||"")};
  }
  function revalidateCheckoutForAddressChange(){
    state.dynamicPricing={rainFee:0,surgeFee:0,riderIncentiveFee:0,weatherSeverity:"",weatherChecked:false,activeOrders:0,checkedAt:0};
    state.checkout.pendingOrderId="";state.checkout.pendingIdempotencyKey="";persistCheckout();
  }
  async function deleteAddress(addressId){
    const existing=(state.profile.addresses||[]).find(address=>address.id===addressId);if(!existing){closeSheet();return;}
    const previousAddresses=clone(state.profile.addresses||[]),previousSelected=state.profile.selectedAddressId||"",previousCheckout=clone(state.checkout),previousDynamicPricing=clone(state.dynamicPricing),plan=addressDeletionPlan(previousAddresses,previousSelected,addressId),selectionChanged=plan.selectedAddressId!==previousSelected;
    state.profile.addresses=plan.addresses;state.profile.selectedAddressId=plan.selectedAddressId;
    if(selectionChanged)revalidateCheckoutForAddressChange();
    persistProfile();closeSheet();render({preserveScroll:true});
    try{
      await saveProfile();
      if(selectionChanged){
        if(!restoreHomeCache(true)){state.catalog={};state.catalogLoaded=false;state.catalogMode="loading";state.homeStatus="initial";}
        if(state.online)await syncCatalog();
        if(state.online)startRealtime().catch(()=>{});
      }
      toast(plan.selectedAddressId?"Address deleted. Your next saved address is selected.":"Address deleted. Add an address before checkout.","success");
    }catch(error){
      state.profile.addresses=previousAddresses;state.profile.selectedAddressId=previousSelected;state.checkout=previousCheckout;state.dynamicPricing=previousDynamicPricing;persistProfile();persistCheckout();render({preserveScroll:true});
      toast("Address was not deleted. "+friendlyError(error),"danger");
    }
  }

  async function selectAddress(id) {
    const previous=state.profile.selectedAddressId||"";state.profile.selectedAddressId=id;if(previous!==id)revalidateCheckoutForAddressChange();persistProfile();
    if(!restoreHomeCache(true)){state.catalog={};state.catalogLoaded=false;state.catalogMode="loading";state.homeStatus="initial"}
    render({preserveScroll:true});
    const tasks=[saveProfile()];if(state.online)tasks.push(syncCatalog());
    const results=await Promise.allSettled(tasks);
    if(state.online)startRealtime().catch(()=>{});
    if(results[0].status==="fulfilled")toast("Delivery address updated.","success");else toast("Saved on this device; cloud sync will retry.");
  }
  function requestLocation(mode) {
    state.locationMode = mode || "general";
    state.locationBusy = true; render({preserveScroll:true});
    if (window.FeastlyNative && FeastlyNative.requestCurrentLocation) FeastlyNative.requestCurrentLocation();
    else { state.locationBusy=false; toast("Current location is available in the installed Android app.","danger"); render({preserveScroll:true}); }
  }
  window.setDetectedLocation = async function (label, area, city, details, lat, lng) {
    if(state.locationMode==="address"&&state.sheet&&state.sheet.type==="address") {
      state.addressMapDraft={lat:Number(lat),lng:Number(lng)};state.locationBusy=false;state.locationMode="general";
      const draft=state.sheet.address||(state.sheet.address={});draft.lat=Number(lat);draft.lng=Number(lng);
      if(!draft.area&&area)draft.area=area;if(!draft.city&&city)draft.city=city;if(!draft.address&&details)draft.address=details;
      renderSheet();toast("Map pin moved to your phone location.","success");return;
    }
    const addresses=state.profile.addresses||[];
    let current=addresses.find(x=>x.id==="current-location");
    const resolvedCity=city||current&&current.city||area||"",resolvedArea=area||"Nearby",resolvedAddress=details||"Current delivery location";
    const record={id:"current-location",label:label||"Current location",area:resolvedArea,city:resolvedCity,address:resolvedAddress,formattedAddress:resolvedAddress,serviceAreaId:"area-"+searchKey(resolvedCity||resolvedArea),phone:current&&current.phone||state.profile.phone||"",lat:Number(lat),lng:Number(lng),needsLocationPin:false,source:"gps",updatedAt:Date.now()};
    if(current)Object.assign(current,record);else addresses.unshift(record);
    state.profile.addresses=addresses;state.profile.selectedAddressId=record.id;state.locationBusy=false;state.locationMode="general";migrateSavedAddresses();persistProfile();
    if(!restoreHomeCache(true)){state.catalog={};state.catalogLoaded=false;state.catalogMode="loading";state.homeStatus="initial"}render({preserveScroll:true});
    try{await Promise.all([saveProfile(),state.online?syncCatalog():Promise.resolve()]);toast("Current location is ready.","success");}catch(_){toast("Location saved on this device; cloud sync will retry.");}
    if(state.online)startRealtime().catch(()=>{});
  };
  window.locationUnavailable = function(){state.locationBusy=false;state.locationMode="general";toast("Location could not be detected. Check permission and try again.","danger");render({preserveScroll:true});};
  window.locationServicesDisabled = function(){state.locationBusy=false;state.locationMode="general";toast("Turn on phone Location, then try again.","danger");render({preserveScroll:true});};

  function openGoogleSignIn() {
    if (window.FeastlyNative && FeastlyNative.signInWithGoogle) { state.loading=true;render({preserveScroll:true});FeastlyNative.signInWithGoogle(); }
    else toast("Google sign-in is available in the installed Android app.","danger");
  }
  async function completeGoogleSignIn(tokenType, token){
    try{
      const data=await authRequest("accounts:signInWithIdp",{postBody:tokenType+"="+encodeURIComponent(token)+"&providerId=google.com",requestUri:"http://localhost",returnIdpCredential:true,returnSecureToken:true});
      saveAuth(data,data.email);state.profile.name=data.displayName||state.profile.name;state.profile.email=data.email||state.profile.email;await afterAuth();
    }catch(error){toast(friendlyError(error),"danger");}finally{state.loading=false;render();}
  }
  window.googleIdTokenReceived = function(idToken){return completeGoogleSignIn("id_token",idToken);};
  window.googleAccessTokenReceived = function(accessToken){return completeGoogleSignIn("access_token",accessToken);};
  window.googleSignInFailed = function(message){state.loading=false;toast(message||"Google sign-in could not be completed.","danger");render({preserveScroll:true});};
  window.savrivoPushReceived = async function(event){
    const payload=event||{},type=String(payload.type||"");
    if(type==="TOKEN_REFRESH"){registerPushTokenIfAllowed().catch(()=>{});return;}
    if(!state.session)return;
    if(type==="ORDER_STATUS"||type==="RIDER_ASSIGNED"||type==="FCM_MESSAGES_DELETED"){
      await syncOrders(true);
      if(state.route==="review")return;
      if(payload.openedFromNotification===true&&payload.orderId&&orderById(String(payload.orderId))){
        go("order",{orderId:String(payload.orderId)});
      }else if(["home","orders","order","tracking"].includes(state.route))render({preserveScroll:true});
    }
  };

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
    state.reviewSyncSequence++;
    state.reviews=loadJSON(reviewCacheKey(state.session&&state.session.uid),{});
    state.recentSearches=normalizedRecentSearches(loadJSON(searchHistoryKey(state.session&&state.session.uid),[]));
    state.query="";clearTimeout(state.searchDebounceTimer);state.searchDebounceTimer=null;
    // Never infer that a cached delivered order needs another review before
    // the matching account's review records have been checked remotely.
    state.reviewsHydrated=false;
    state.reviewsHydratedUid="";
    migrateSavedAddresses();
    if(!restoreHomeCache(true)){state.catalog={};state.catalogLoaded=false;state.catalogMode="loading";state.homeStatus="initial"}
    state.loading=false;state.route="home";state.history=[];render();
    startPolling();
    Promise.allSettled([syncProfile(false),syncCatalog(),syncOrders(true),syncEmailVerification(),syncSecondaryHomeData()]).then(()=>{
      migrateSavedAddresses();render({preserveScroll:true});
    });
    registerPushTokenIfAllowed().catch(()=>{});
  }
  function signOut(showMessage) {
    unregisterPushTokenBestEffort();
    if(nativeAvailable("clearDeliveryOtps")){try{FeastlyNative.clearDeliveryOtps()}catch(_){}}
    stopPolling();state.session=null;persistSession();
    state.profile={name:"",email:"",phone:"",addresses:[],selectedAddressId:"",favourites:[],preferences:{theme:"system",vegetarian:false,notifications:true}};
    state.catalog={};state.catalogLoaded=false;state.catalogMode="loading";state.homeStatus="initial";
    clearTimeout(state.searchDebounceTimer);state.searchDebounceTimer=null;state.query="";state.recentSearches=[];
    state.orders=[];state.tracking={};state.trackingHydrated={};state.trackingSeenAt={};state.trackingMap=null;state.reviews={};state.reviewsHydrated=false;state.reviewsHydratedUid="";state.reviewSyncSequence++;state.cart=[];state.checkout={deliveryMode:"asap",payment:"cod",instructions:"",contactless:false,pendingOrderId:"",pendingIdempotencyKey:""};state.history=[];state.route="login";
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
    const scrollY = options && options.preserveScroll ? currentPageScrollTop() : 0;
    const renderer = SCREENS[state.route] || screenHome;
    app.innerHTML = renderer(); app.setAttribute("aria-busy",state.loading?"true":"false");
    renderSheet();
    if(options&&options.preserveScroll)setPageScrollTop(scrollY);
  }

  function screenLaunch(){return '<main class="screen no-nav"><div class="launch-placeholder">'+logo()+'<div class="spinner"></div><strong>Preparing your Scraveit home…</strong></div></main>';}

  function screenWelcome() {
    return '<main class="welcome-screen no-nav">'
      +'<div class="cluster">'+logo()+'<div><div class="brand-word">'+BRAND+'</div><div class="caption">Food, thoughtfully delivered</div></div></div>'
      +'<div class="welcome-art" aria-label="A calm delivery route illustration"><div class="route-line"><svg viewBox="0 0 360 270" fill="none" aria-hidden="true"><path d="M47 207C82 118 121 233 169 151c41-70 85-20 144-95" stroke="rgba(255,255,255,.35)" stroke-width="24" stroke-linecap="round"/><path d="M47 207C82 118 121 233 169 151c41-70 85-20 144-95" stroke="white" stroke-width="5" stroke-linecap="round" stroke-dasharray="9 14"/><circle cx="47" cy="207" r="18" fill="#4DD6A4" stroke="white" stroke-width="6"/><path d="M306 44c0-18 27-18 27 0 0 15-13.5 29-13.5 29S306 59 306 44Z" fill="#fff"/><circle cx="319.5" cy="44" r="5" fill="#155EEF"/><rect x="134" y="114" width="74" height="58" rx="18" fill="rgba(7,20,38,.72)"/><path d="M151 144h40m-26-13h26m-40 26h27" stroke="#73D7FF" stroke-width="7" stroke-linecap="round"/></svg></div></div>'
      +'<div class="stack-lg"><div><p class="eyebrow">Made for your neighbourhood</p><h1 class="display" style="margin-top:8px">Good food.<br>Clear journeys.</h1><p class="body muted" style="margin-top:14px">Discover trusted kitchens, order without surprises and follow every step to your door.</p></div><div class="welcome-actions"><button class="button primary full" data-action="welcome-signup">Create your account</button><button class="button tonal full" data-action="welcome-login">I already have an account</button><div class="divider">or</div><button class="button tonal full google-button" data-action="google-signin" '+(state.loading?'disabled':'')+'><span class="google-dot">G</span>Continue with Google</button><p class="caption" style="text-align:center">By continuing, you agree to Scraveit’s Terms and Privacy Notice.</p></div></div>'
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
      +'<p class="supporting" style="text-align:center">New to Scraveit? <button class="text-button" data-action="go" data-route="signup">Create an account</button></p></div>'
      +'<p class="caption" style="text-align:center">Protected by Firebase Authentication. Scraveit never sees your password.</p></main>';
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
    return '<main class="screen no-nav auth-screen"><div class="screen-content auth-card">'+authHeader("Verify your email.","Open the newest Scraveit verification message sent to your account, then return here.")
      +networkBanner()+'<section class="card stack-lg"><div class="notice info">'+icon("shield","small")+'<span>Verification protects your orders, saved addresses and account recovery.</span></div><div><p class="eyebrow">Verification sent to</p><h2 class="section-title" style="margin-top:7px">'+h(state.profile.email||state.session&&state.session.email||"")+'</h2></div><button class="button primary full" data-action="check-verification" '+(state.loading?'disabled':'')+'>'+(state.loading?'<span class="spinner"></span> Checking…':'I verified my email')+'</button><button class="button tonal full" data-action="resend-verification">Send a new verification email</button><button class="text-button" data-action="signout">Use another account</button></section><p class="caption" style="text-align:center">Use only the newest message. If it is not in Inbox, check Spam and mark Scraveit as safe.</p></div></main>';
  }

  function homeHeader() {
    const address=currentAddress();
    return '<header class="cluster between home-header"><button class="location-pill" data-action="go" data-route="addresses" aria-label="Change delivery location"><span class="location-dot">'+icon("target")+'</span><span class="location-copy"><span>Deliver to</span><strong>'+(address?h(address.label||address.area):"Choose a location")+'</strong><small>'+h(address&&(address.city||address.area)||(address?"Add a location pin":"Select a saved address"))+'</small></span>'+icon("chevron","small")+'</button><div class="home-header-actions">'+(cartCount()?'<button class="cart-shortcut" data-action="go" data-route="cart" aria-label="Open cart with '+cartCount()+' items">'+icon("cart")+'<span>'+cartCount()+'</span></button>':'')+'<button class="avatar" data-action="go" data-route="account" aria-label="Open account">'+h(initials())+'</button></div></header>';
  }
  function orderProgress(order) { const progress=Math.min(100,Math.max(6,(statusIndex(order.status)+1)/ORDER_FLOW.length*100)); return progress; }
  function audienceMatch(record){
    const a=currentAddress()||{}, city=keyName(a.city||a.area), area=keyName(a.area), target=record&&record.audience||"all";
    if(target==="all")return true;
    if(target==="city")return keyName(record.city)===city;
    if(target==="area")return keyName(record.area)===area;
    if(target==="restaurant")return state.orders.some(o=>o.restaurantId===record.restaurantId)||Object.prototype.hasOwnProperty.call(state.catalog,record.restaurantId||"");
    return false;
  }
  function processBroadcasts(){
    if(!state.session||state.profile.preferences.notifications===false)return;
    const now=Date.now();
    (state.broadcasts||[]).forEach(n=>{
      if(!n||n.active===false||!audienceMatch(n)||(n.expiresAt&&Number(n.expiresAt)<now)||state.seenBroadcasts[n.id]){if(state.broadcastTimers[n&&n.id]){clearTimeout(state.broadcastTimers[n.id]);delete state.broadcastTimers[n.id]}return;}
      const at=Number(n.scheduledAt||0);
      if(at>now){if(!state.broadcastTimers[n.id])state.broadcastTimers[n.id]=setTimeout(()=>{delete state.broadcastTimers[n.id];processBroadcasts()},Math.min(2147483000,Math.max(1000,at-Date.now())));return;}
      state.seenBroadcasts[n.id]=now;saveJSON("savrivo.customer.seenBroadcasts",state.seenBroadcasts);
      if(state.broadcastTimers[n.id]){clearTimeout(state.broadcastTimers[n.id]);delete state.broadcastTimers[n.id]}
      if(window.FeastlyNative&&FeastlyNative.notifyOrder){try{FeastlyNative.notifyOrder(String(n.title||"Scraveit"),String(n.message||""),Math.abs(hashCode("broadcast-"+n.id)))}catch(_){}}
    });
  }
  function activeLocalAd(){
    const now=Date.now(), a=currentAddress()||{}, city=keyName(a.city||a.area), area=keyName(a.area);
    return (state.localAds||[]).filter(ad=>ad&&ad.active!==false&&Number(ad.startAt||0)<=now&&(!ad.endAt||Number(ad.endAt)>=now))
      .filter(ad=>!ad.city||keyName(ad.city)===city).filter(ad=>!ad.area||keyName(ad.area)===area).sort((x,y)=>Number(y.priority||0)-Number(x.priority||0))[0]||null;
  }
  function localAdMarkup(){const ad=activeLocalAd();if(!ad)return'<section class="card brand-card promo-card"><div><p class="eyebrow" style="color:#bfe9ff">SCRAVEIT STANDARD</p><h2 class="section-title" style="font-size:25px;margin-top:7px">Clear pricing. Careful delivery.</h2><p class="supporting" style="margin-top:8px">Every charge is shown before you place an order.</p></div><span class="promo-code">NO SURPRISES</span></section>';return'<button class="card local-ad" data-action="open-ad" data-ad-id="'+h(ad.id)+'">'+((ad.image||ad.imageUrl)?'<img src="'+h(safeUrl(ad.image||ad.imageUrl,"restaurant-placeholder.svg"))+'" alt="">':'')+'<div class="local-ad-copy"><span class="sponsored-label">Sponsored · '+h(ad.area||ad.city||"Local")+'</span><h2 class="section-title" style="font-size:25px">'+h(ad.title||"Nearby offer")+'</h2><p>'+h(ad.message||"")+'</p><strong>'+h(ad.cta||"Explore")+' →</strong></div></button>'}
  function latestDeliveredNeedingReview(){if(!reviewStateReady())return null;return state.orders.find(o=>o.status==="Delivered"&&!state.reviews[o.id])||null}
  function postDeliveryCard(){const o=latestDeliveredNeedingReview();if(!o)return"";return'<section class="post-order-card"><p class="eyebrow">Delivered</p><h2 class="section-title">How was '+h(o.restaurant||"your order")+'?</h2><p class="supporting">Your rating helps customers, restaurants and delivery partners improve.</p><div class="star-row">'+[1,2,3,4,5].map(n=>'<button class="star-choice" data-action="quick-rate" data-order-id="'+h(o.id)+'" data-rating="'+n+'" aria-label="'+n+' stars">'+icon("star","large")+'</button>').join("")+'</div><button class="button tonal full" data-action="go" data-route="review" data-order-id="'+h(o.id)+'">Rate restaurant & delivery partner</button></section>'}

  function activeOrderCard(order) {
    return '<button class="active-order" data-action="open-order" data-order-id="'+h(order.id)+'"><div class="cluster between"><span class="status-pill" style="background:rgba(255,255,255,.18);color:white">'+h(order.status)+'</span><strong>'+h(etaText(order))+'</strong></div><div><h2 class="section-title">'+h(order.restaurant||"Your order")+'</h2><p class="supporting">'+h((order.items||[]).map(x=>(x.quantity||1)+'× '+x.name).slice(0,2).join(" · "))+'</p></div><div class="status-progress"><span style="width:'+orderProgress(order)+'%"></span></div><div class="cluster between supporting"><span>Order '+h(order.id)+'</span><span>View journey '+icon("chevron","small")+'</span></div></button>';
  }
  function discoveryItems(restaurant){return restaurant&&restaurant.menuLoaded?(restaurant.menu||[]):(restaurant&&restaurant.menuIndex||[])}
  function cuisineList() {
    const all=new Set(["All"]);
    Object.values(state.catalog).forEach(r=>{
      (r.cuisines||[]).forEach(c=>all.add(c));
      discoveryItems(r).filter(i=>i.archived!==true).forEach(i=>all.add(i.category||"Menu"));
    });
    ["Biryani","Fried Rice","Dosa","Pizza","Burgers","Desserts"].forEach(c=>all.add(c));
    return Array.from(all).slice(0,14);
  }
  function isPureVegRestaurant(r){
    if(r&&r.pureVeg===true)return true;
    const items=discoveryItems(r).filter(i=>i.archived!==true&&i.available!==false);
    return items.length>0&&items.every(i=>!["nonveg","egg"].includes(String(i.diet||"").toLowerCase()));
  }
  function personalRestaurantRating(restaurantId){
    const reviews=Object.values(state.reviews||{}).filter(x=>x&&x.restaurantId===restaurantId&&Number(x.restaurantRating||x.rating)>0);
    if(!reviews.length)return 0;const latest=reviews.sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0))[0];return Number(latest.restaurantRating||latest.rating);
  }
  function ratingForRestaurant(r){
    const personal=personalRestaurantRating(r.id),rawOverall=Number(r.rating);
    const count=Math.max(0,Number(r.ratingCount||0));
    const overall=count>0&&Number.isFinite(rawOverall)&&rawOverall>=1&&rawOverall<=5?rawOverall:0;
    return state.ratingView==="mine"?{value:personal,label:personal?"Your rating":"Not rated by you"}:{value:overall,label:overall?count+" customer rating"+(count===1?"":"s"):"No ratings yet"};
  }
  function restaurantHasOffer(r){
    return !!(r.offer||r.discount||r.offerText||(state.promotions||[]).some(p=>p&&p.active===true&&(!Array.isArray(p.restaurantIds)||p.restaurantIds.includes(r.id))));
  }
  function restaurantsFiltered() {
    let list=Object.values(state.catalog).filter(r=>r.archived!==true);

    if(state.cuisine!=="All")
      list=list.filter(r=>(r.cuisines||[]).some(c=>keyName(c)===keyName(state.cuisine))||keyName(r.category)===keyName(state.cuisine)||discoveryItems(r).some(i=>keyName(i.category)===keyName(state.cuisine)));

    if(state.profile.preferences.vegetarian||state.diet==="veg")
      list=list.filter(r=>discoveryItems(r).some(i=>i.diet==="veg"&&i.available!==false));
    if(state.diet==="nonveg")list=list.filter(r=>discoveryItems(r).some(i=>i.diet==="nonveg"&&i.available!==false));
    if(state.homeFilter==="under250")list=list.filter(r=>discoveryItems(r).some(i=>i.available!==false&&Number(i.price)<=250));
    if(state.homeFilter==="offers")list=list.filter(restaurantHasOffer);
    if(state.homeFilter==="pureveg")list=list.filter(isPureVegRestaurant);

    const q=state.query;
    if(searchKey(q))
      list=list.filter(r=>searchMatches([r.name,(r.cuisines||[]).join(" "),...discoveryItems(r).map(i=>i.name+" "+(i.description||""))].join(" "),q));

    const address=currentAddress();
    const customerCity=keyName(address&&address.city||"");
    if(customerCity){
      const cityTagged=list.some(r=>keyName(r.city||""));
      if(cityTagged)list=list.filter(r=>!keyName(r.city||"")||keyName(r.city)===customerCity);
    }
    const pinned=address
      &&Number.isFinite(Number(address.lat))
      &&Number.isFinite(Number(address.lng));

    if(pinned)
      list=list.filter(restaurantServiceable);

    const distanceValue=r=>{
      const d=restaurantDistanceKm(r);
      return d==null ? 999999 : d;
    };

    const openValue=r=>r.open===false?1:0;

    if(state.sort==="nearby") {
      list.sort((a,b)=>
        openValue(a)-openValue(b)
        ||distanceValue(a)-distanceValue(b)
        ||Number(b.rating||0)-Number(a.rating||0)
      );
    } else if(state.sort==="rating") {
      list.sort((a,b)=>
        openValue(a)-openValue(b)
        ||Number(b.rating||0)-Number(a.rating||0)
        ||distanceValue(a)-distanceValue(b)
      );
    } else if(state.sort==="delivery") {
      list.sort((a,b)=>
        openValue(a)-openValue(b)
        ||Number(a.etaMin||99)-Number(b.etaMin||99)
        ||distanceValue(a)-distanceValue(b)
      );
    } else if(state.sort==="fee") {
      list.sort((a,b)=>
        deliveryFeeForRestaurant(a,0)-deliveryFeeForRestaurant(b,0)
        ||distanceValue(a)-distanceValue(b)
      );
    } else {
      list.sort((a,b)=>
        openValue(a)-openValue(b)
        ||Math.floor(distanceValue(a)/2)-Math.floor(distanceValue(b)/2)
        ||Number(b.rating||0)-Number(a.rating||0)
        ||distanceValue(a)-distanceValue(b)
        ||Number(a.etaMin||99)-Number(b.etaMin||99)
      );
    }

    return list;
  }
  function restaurantCard(r,horizontal){const liked=(state.profile.favourites||[]).includes(r.id),distance=restaurantDistanceKm(r),fee=deliveryFeeForRestaurant(r,0),distanceText=distance==null?"":distance.toFixed(distance<10?1:0)+" km",rating=ratingForRestaurant(r),ratingText=rating.value?rating.value.toFixed(1):"New";return'<article class="restaurant-card '+(horizontal?'horizontal':'')+'" data-action="open-restaurant" data-restaurant-id="'+h(r.id)+'" tabindex="0" role="button" aria-label="Open '+h(r.name)+'"><div class="restaurant-media"><img src="'+h(safeUrl(r.image,"restaurant-placeholder.svg"))+'" alt="'+h(r.name)+'" loading="lazy" decoding="async" fetchpriority="auto" onerror="this.onerror=null;this.src=\'restaurant-placeholder.svg\'"><span class="media-badge">'+(r.open?'Open':'Closed')+'</span><button class="heart-button '+(liked?'liked':'')+'" data-action="toggle-favourite" data-restaurant-id="'+h(r.id)+'" aria-label="'+(liked?'Remove from':'Add to')+' favourites">'+icon("heart")+'</button></div><div class="restaurant-copy"><div class="restaurant-title-row"><h3 class="card-title restaurant-name">'+h(r.name)+'</h3><span class="rating compact">'+icon("star","small")+'<strong>'+h(ratingText)+'</strong></span></div><div class="cluster wrap restaurant-badges">'+(isPureVegRestaurant(r)?'<span class="pure-veg-badge">Pure veg</span>':'')+(restaurantHasOffer(r)?'<span class="offer-badge">Offer</span>':'')+'<span class="rating-caption">'+h(rating.label)+'</span></div><p class="supporting restaurant-cuisines">'+h((r.cuisines||[]).join(" · "))+'</p><div class="restaurant-meta"><span>'+icon("clock","small")+' '+h(r.etaMin||25)+'–'+h(r.etaMax||35)+' min</span>'+(distanceText?'<span>'+icon("pin","small")+' '+h(distanceText)+'</span>':'')+'<span>'+(fee===0?'Free delivery':money(fee)+' delivery')+'</span></div></div></article>'}
  function homeSkeletonMarkup(){return'<section class="stack" aria-label="Loading restaurants"><div class="skeleton skeleton-line wide"></div><div class="restaurant-list"><div class="restaurant-card horizontal home-skeleton-card"><div class="skeleton home-skeleton-image"></div><div class="restaurant-copy stack"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line"></div></div></div><div class="restaurant-card horizontal home-skeleton-card"><div class="skeleton home-skeleton-image"></div><div class="restaurant-copy stack"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line"></div></div></div></div><p class="caption">Finding restaurants for this saved address…</p></section>'}
  function menuSkeletonMarkup(){return'<section class="stack" aria-label="Loading menu"><div class="skeleton skeleton-line wide"></div><div class="menu-list"><div class="menu-item"><div class="menu-copy stack"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line"></div></div><div class="skeleton home-skeleton-image"></div></div><div class="menu-item"><div class="menu-copy stack"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line"></div></div><div class="skeleton home-skeleton-image"></div></div></div><p class="caption">Loading this restaurant\'s menu…</p></section>'}
  function screenHome() {
    if(!state.catalogLoaded)return '<main class="screen"><div class="screen-content page-stack">'+homeHeader()+homeSkeletonMarkup()+'</div>'+nav()+'</main>';
    if(state.homeStatus==="errorWithoutCache")return'<main class="screen"><div class="screen-content page-stack">'+homeHeader()+emptyState("warning","Restaurants could not be loaded","Check your connection and try again. Your saved address is still selected.","refresh","Retry")+'</div>'+nav()+'</main>';
    const active=activeOrders()[0], restaurants=restaurantsFiltered(),recommended=restaurants.slice(0,3),address=currentAddress();
    if(!state.homeVisibleLogged){state.homeVisibleLogged=true;perfLog("HOME_RESTAURANTS_VISIBLE",state.homeBootStartedAt,{source:state.catalogMode,restaurants:restaurants.length,scope:homeScope(address)})}
    return '<main class="screen '+(cartCount()?'has-floating-cart':'')+'"><div class="screen-content page-stack">'+networkBanner()+homeHeader()
      +'<section class="home-lead"><p class="eyebrow">'+(new Date().getHours()<12?'Good morning':new Date().getHours()<17?'Good afternoon':'Good evening')+'</p><h1 class="display">What tastes good, '+h(firstName())+'?</h1><p class="supporting">Showing restaurants in '+h(address&&address.city||"your selected city")+'</p></section>'
      +(address&&address.needsLocationPin?'<div class="notice warning">'+icon("pin","small")+'<div><strong>Add a map pin to this saved address</strong><div class="caption">Browsing works now. A pin is required only before checkout.</div></div><button class="text-button" data-action="go" data-route="addresses">Update</button></div>':'')
      +(active?activeOrderCard(active):postDeliveryCard())
      +'<button class="search-trigger" data-action="go" data-route="search">'+icon("search")+'<span>Search dishes, restaurants or cuisines</span></button>'
      +'<div class="home-promo">'+localAdMarkup()+'</div>'
      +'<section class="stack"><div class="cluster between"><h2 class="section-title">Browse categories</h2><button class="text-button" data-action="go" data-route="search">See all</button></div><div class="chip-row">'+cuisineList().map(c=>'<button class="chip '+(state.cuisine===c?'active':'')+'" data-action="cuisine" data-value="'+h(c)+'">'+h(c)+'</button>').join("")+'</div><div class="chip-row discovery-filters"><button class="chip" data-action="open-filters">'+icon("filter","small")+' Filters</button><button class="chip '+(state.homeFilter==="under250"?'active':'')+'" data-action="home-filter" data-value="under250">Under ₹250</button><button class="chip '+(state.homeFilter==="offers"?'active':'')+'" data-action="home-filter" data-value="offers">Offers</button><button class="chip '+(state.homeFilter==="pureveg"?'active':'')+'" data-action="home-filter" data-value="pureveg">Pure veg</button></div></section>'
      +'<section class="stack"><div class="cluster between"><div><h2 class="section-title">Recommended for you</h2><p class="supporting">Nearby, open and highly rated first</p></div><button class="text-button" data-action="go" data-route="search">View all</button></div>'+(recommended.length?'<div class="restaurant-list">'+recommended.map(r=>restaurantCard(r,true)).join("")+'</div>':emptyState("search","No matches in this city","Try another address, category or filter.","open-filters","Change filters"))+'</section>'
      +'<section class="stack"><div class="cluster between rating-view-row"><div><h2 class="section-title">All restaurants</h2><p class="supporting">'+restaurants.length+' available for this address</p></div><button class="rating-toggle" data-action="toggle-rating-view" aria-label="Switch restaurant rating view"><span>My rating</span><span class="toggle-track '+(state.ratingView==="overall"?'on':'')+'"><i></i></span><span>Overall</span></button></div>'
      +(restaurants.length?'<div class="restaurant-list">'+restaurants.map(r=>restaurantCard(r,true)).join("")+'</div>':emptyState("search","No restaurants are live","Choose another saved address or clear the filters.","open-filters","Change filters"))
      +((state.homeStatus==="refreshing"||state.loading)&&restaurants.length?loadingRow("Refreshing restaurants in the background…"):"")+'</section>'
      +(state.catalogMode==="packaged"?'<div class="notice warning">'+icon("info","small")+'<div><strong>Live menu unavailable</strong><div class="caption">Ordering is paused until the latest restaurant catalogue is available.</div></div></div>':'')
      +'</div>'+(cartCount()?'<div class="floating-cart home-cart"><button class="button primary full" data-action="go" data-route="cart"><span>'+cartCount()+' item'+(cartCount()===1?'':'s')+'</span><span>View cart · '+money(orderTotal())+'</span></button></div>':'')+nav()+'</main>';
  }

  function persistRecentSearches(){
    if(state.session&&state.session.uid)saveJSON(searchHistoryKey(state.session.uid),state.recentSearches||[]);
  }
  function recordRecentSearch(value){
    if(!state.session||!state.session.uid)return false;
    const label=String(value||"").trim().replace(/\s+/g," ").slice(0,80),identity=searchKey(label);
    if(label.length<2||!identity)return false;
    state.recentSearches=normalizedRecentSearches([label,...(state.recentSearches||[])]);persistRecentSearches();return true;
  }
  function clearRecentSearches(){state.recentSearches=[];persistRecentSearches();}
  function recentSearchMarkup(){
    if(searchKey(state.query)||(state.recentSearches||[]).length===0)return"";
    return '<section class="stack"><div class="cluster between"><h2 class="section-title">Recent searches</h2><button class="text-button" data-action="clear-search-history">Clear</button></div><div class="chip-row">'+state.recentSearches.map(value=>'<button class="chip" data-action="recent-search" data-value="'+h(value)+'">'+icon("search","small")+' '+h(value)+'</button>').join("")+'</div></section>';
  }
  function searchResultMarkup() {
    if(!state.catalogLoaded)return loadingRow("Loading restaurants for this address…");
    if(state.homeStatus==="errorWithoutCache"&&!Object.keys(state.catalog).length)return emptyState("warning","Search could not be loaded","Check your connection and retry the live catalogue.","refresh","Retry");
    const results=restaurantsFiltered();
    if(results.length)return '<div class="restaurant-list two-column">'+results.map(r=>restaurantCard(r,false)).join("")+'</div>';
    if(searchKey(state.query))return emptyState("search","Nothing matched","Try another dish, cuisine or spelling.","clear-search","Clear search");
    if(state.cuisine!=="All"||state.diet!=="all"||state.homeFilter!=="all")return emptyState("search","No restaurants match these filters","Change a category or filter to see more results.","open-filters","Change filters");
    return emptyState("search","No restaurants are available","Retry the live catalogue or choose another saved address.","refresh","Retry");
  }
  function searchContentMarkup(){return recentSearchMarkup()+searchResultMarkup();}
  function screenSearch() {
    return '<main class="screen"><div class="screen-content page-stack">'+topbar("Find your next meal","Search live menus, cuisines and restaurants.",'<button class="icon-button" data-action="open-filters" aria-label="Open filters">'+icon("filter")+'</button>')+networkBanner()
      +'<div class="input-wrap"><span class="input-icon">'+icon("search")+'</span><input id="search-input" class="input with-icon with-action" value="'+h(state.query)+'" placeholder="Try waffles, desserts or ice cream" autocomplete="off" enterkeyhint="search" aria-label="Search"><button class="icon-button flat input-action" data-action="clear-search" aria-label="Clear search">'+icon("close")+'</button></div>'
      +'<div class="chip-row">'+cuisineList().map(c=>'<button class="chip '+(state.cuisine===c?'active':'')+'" data-action="cuisine" data-value="'+h(c)+'">'+h(c)+'</button>').join("")+'</div>'
      +'<div id="search-results" class="stack-lg">'+searchContentMarkup()+'</div></div>'+nav()+'</main>';
  }

  function restaurantMenu(r) {
    let items=(r.menu||[]).filter(item=>state.selectedMenuCategory==="All"||item.category===state.selectedMenuCategory);
    if(state.diet==="veg"||state.profile.preferences.vegetarian)items=items.filter(x=>x.diet==="veg");
    if(state.diet==="nonveg")items=items.filter(x=>x.diet==="nonveg");
    if(state.menuPrice==="under150")items=items.filter(x=>Number(x.price)<=150);
    if(state.menuPrice==="under250")items=items.filter(x=>Number(x.price)<=250);
    if(state.menuPrice==="above250")items=items.filter(x=>Number(x.price)>250);
    if(state.menuSort==="priceLow")items.sort((a,b)=>Number(a.price)-Number(b.price));
    if(state.menuSort==="priceHigh")items.sort((a,b)=>Number(b.price)-Number(a.price));
    if(state.menuSort==="rating")items.sort((a,b)=>Number(b.rating||b.popular||0)-Number(a.rating||a.popular||0));
    const grouped={};items.forEach(item=>(grouped[item.category||"Menu"]||(grouped[item.category||"Menu"]=[])).push(item));
    return Object.keys(grouped).map(category=>'<section class="stack"><div><h2 class="section-title">'+h(category)+'</h2><p class="supporting">'+grouped[category].length+' item'+(grouped[category].length===1?'':'s')+'</p></div><div class="menu-list">'+grouped[category].map(item=>{
      const inCart=state.cart.filter(x=>x.restaurantId===r.id&&x.itemId===item.id).reduce((n,x)=>n+x.quantity,0);
      return '<article class="menu-item"><div class="menu-copy"><span class="diet-mark '+(item.diet==="nonveg"?'nonveg':'')+'" aria-label="'+(item.diet==="nonveg"?'Non-vegetarian':'Vegetarian')+'"></span><h3 class="card-title">'+h(item.name)+'</h3><strong>'+money(item.price)+'</strong><p class="supporting">'+h(item.description||"")+'</p>'+(item.popular?'<span class="caption success-text">Popular choice</span>':'')+(item.available===false?'<span class="caption danger-text">Unavailable right now</span>':'')+'</div><div class="menu-media"><img src="'+h(safeUrl(item.imageUrl||item.image,r.image))+'" alt="'+h(item.name)+'" loading="lazy" decoding="async" onerror="this.onerror=null;this.src=\''+h(safeUrl(r.image,"restaurant-placeholder.svg"))+'\'">'+(item.available===false?'':inCart?'<button class="add-button" data-action="open-item" data-restaurant-id="'+h(r.id)+'" data-item-id="'+h(item.id)+'">'+inCart+' in cart · Edit</button>':'<button class="add-button" data-action="open-item" data-restaurant-id="'+h(r.id)+'" data-item-id="'+h(item.id)+'">ADD +</button>')+'</div></article>';
    }).join("")+'</div></section>').join("") || emptyState("search","No items in this filter","Try another menu category or dietary filter.","clear-menu-filter","Show full menu");
  }
  function screenRestaurant() {
    const r=restaurant();if(!r)return'<main class="screen"><div class="screen-content">'+topbar("Restaurant unavailable","This restaurant is no longer in the live catalogue.")+emptyState("search","Restaurant unavailable","Return home to find another restaurant.","go-home","Back to home")+'</div>'+nav()+'</main>';
    const categories=["All",...new Set(discoveryItems(r).map(x=>x.category||"Menu"))],pureVeg=isPureVegRestaurant(r);const liked=(state.profile.favourites||[]).includes(r.id),rating=ratingForRestaurant(r);
    const menuContent=state.menuLoading[r.id]&&!r.menuLoaded?menuSkeletonMarkup():state.menuErrors[r.id]&&!r.menuLoaded?emptyState("warning","Menu could not be loaded","The restaurant is visible, but its menu refresh failed.","retry-menu","Retry menu"):restaurantMenu(r);
    return '<main class="screen flush '+(cartCount()?'has-floating-cart':'')+'"><div class="screen-content"><section class="restaurant-hero"><img src="'+h(safeUrl(r.image,"restaurant-placeholder.svg"))+'" alt="'+h(r.name)+' restaurant"><div class="restaurant-hero-actions"><button class="icon-button" data-action="back" aria-label="Go back">'+icon("back")+'</button><button class="icon-button '+(liked?'active':'')+'" data-action="toggle-favourite" data-restaurant-id="'+h(r.id)+'" aria-label="'+(liked?'Remove from':'Add to')+' favourites">'+icon("heart")+'</button></div><div class="restaurant-hero-copy"><h1 class="page-title" style="font-size:30px">'+h(r.name)+'</h1><p class="supporting">'+h((r.cuisines||[]).join(" · "))+'</p></div></section>'
      +'<div class="restaurant-body">'+networkBanner()+'<section class="service-strip"><div class="service-stat"><strong>'+h(rating.value?rating.value.toFixed(1):"New")+' ★</strong><span>'+h(rating.label)+'</span></div><div class="service-stat"><strong>'+h(r.etaMin||25)+'–'+h(r.etaMax||35)+' min</strong><span>Delivery</span></div><div class="service-stat"><strong>'+(deliveryFeeForRestaurant(r,0)===0?'Free':money(deliveryFeeForRestaurant(r,0)))+'</strong><span>Delivery fee</span></div></section>'
      +'<div class="notice '+(r.open?'success':'warning')+'">'+icon(r.open?'check':'clock',"small")+'<div><strong>'+(r.open?'Accepting orders':'Currently closed')+'</strong><div class="caption">'+h(r.address||"Location provided by the restaurant")+(r.opensUntil?' · Until '+h(r.opensUntil):'')+'</div></div></div>'
      +'<section class="stack menu-discovery"><div class="cluster between"><div><h2 class="section-title">Menu</h2><p class="supporting">Choose items and customise before adding.</p></div>'+(pureVeg?'<span class="pure-veg-badge large">Pure vegetarian</span>':'')+'</div><div class="chip-row menu-primary-filters"><button class="chip" data-action="open-menu-filters">'+icon("filter","small")+' Filters</button>'+(!pureVeg?'<button class="chip '+(state.diet==="all"?'active':'')+'" data-action="menu-diet" data-value="all">All</button><button class="chip '+(state.diet==="veg"?'active':'')+'" data-action="menu-diet" data-value="veg">Veg</button><button class="chip '+(state.diet==="nonveg"?'active':'')+'" data-action="menu-diet" data-value="nonveg">Non-veg</button>':'')+'</div><div class="chip-row menu-categories">'+categories.map(c=>'<button class="chip '+(state.selectedMenuCategory===c?'active':'')+'" data-action="menu-category" data-value="'+h(c)+'">'+h(c)+'</button>').join("")+'</div></section>'+menuContent
      +'<section class="card flat stack"><h2 class="section-title">About this restaurant</h2><p class="supporting">'+h(r.description||r.address||"Restaurant information is maintained by Scraveit Control.")+'</p><div class="restaurant-meta"><span>'+icon("clock","small")+' '+(r.open?'Open now':'Closed')+'</span><span>•</span><span>Approx. '+money(r.priceForTwo||500)+' for two</span></div></section></div></div>'
      +(cartCount()?'<div class="floating-cart"><button class="button primary full" data-action="go" data-route="cart"><span>'+cartCount()+' item'+(cartCount()===1?'':'s')+'</span><span>View cart · '+money(orderTotal())+'</span></button></div>':'')+nav()+'</main>';
  }

  function cartItemMarkup(item) {
    return '<article class="cart-item"><img class="cart-thumb" src="'+h(safeUrl(item.image,"restaurant-placeholder.svg"))+'" alt=""><div class="grow"><h3 class="card-title">'+h(item.name)+'</h3><p class="caption">'+h([item.variant,(item.addOns||[]).map(x=>x.name).join(", ")].filter(Boolean).join(" · ")||item.restaurantName)+'</p><strong>'+money((item.price+item.variantPrice+item.addOnTotal)*item.quantity)+'</strong></div><div class="quantity-control"><button data-action="cart-quantity" data-key="'+h(item.key)+'" data-delta="-1" aria-label="Remove one">−</button><span>'+item.quantity+'</span><button data-action="cart-quantity" data-key="'+h(item.key)+'" data-delta="1" aria-label="Add one">+</button></div></article>';
  }
  function priceBreakdown(includeTotal){return'<div class="stack"><div class="price-row"><span>Item subtotal</span><span>'+money(cartSubtotal())+'</span></div>'+(discount()?'<div class="price-row success-text"><span>'+h(state.coupon.code)+' discount</span><span>−'+money(discount())+'</span></div>':'')+'<div class="price-row"><span>Estimated delivery fee</span><span>'+(deliveryFee()?money(deliveryFee()):'<span class="success-text">Free</span>')+'</span></div>'+(rainFee()>0?'<div class="price-row"><span>Verified rain fee</span><span>'+money(rainFee())+'</span></div>':'')+(surgeFee()>0?'<div class="price-row"><span>Demand surge fee</span><span>'+money(surgeFee())+'</span></div>':'')+riderIncentiveItems().map(item=>'<div class="price-row"><span>'+h(item.label)+'</span><span>'+money(item.amount)+'</span></div>').join("")+(smallOrderFee()>0?'<div class="price-row"><span>Estimated small-order fee</span><span>'+money(smallOrderFee())+'</span></div>':'')+(lateNightFee()>0?'<div class="price-row"><span>Estimated late-night fee</span><span>'+money(lateNightFee())+'</span></div>':'')+'<div class="price-row"><span>Platform fee</span><span>'+money(platformFee())+'</span></div>'+(tax()?'<div class="price-row"><span>Estimated taxes</span><span>'+money(tax())+'</span></div>':'')+(state.tip?'<div class="price-row"><span>Delivery partner tip</span><span>'+money(state.tip)+'</span></div>':'')+(includeTotal?'<div class="price-row total"><span>Estimated total</span><span>'+money(orderTotal())+'</span></div>':'')+'</div>'}
  function screenCart() {
    const r=cartRestaurant();
    if(state.cart.length&&!r){
      return '<main class="screen"><div class="screen-content page-stack">'+topbar("Your cart","Restaurant unavailable")+networkBanner()
        +'<div class="notice warning">'+icon("warning","small")+'<div><strong>This restaurant is no longer available</strong><div class="caption">Your saved cart was kept so nothing disappeared silently. Remove it before choosing from the live catalogue.</div></div></div>'
        +'<section class="card stack-lg">'+state.cart.map(cartItemMarkup).join("")+'</section>'
        +'<button class="button danger full" data-action="clear-unavailable-cart">Remove unavailable cart</button>'
        +'<button class="button tonal full" data-action="go-home">Browse live restaurants</button></div>'+nav()+'</main>';
    }
    return '<main class="screen"><div class="screen-content page-stack">'+topbar("Your cart",r?r.name:"Ready when you are")+networkBanner()
      +(state.cart.length?'<section class="card stack-lg">'+state.cart.map(cartItemMarkup).join("")+'<button class="text-button" data-action="open-restaurant" data-restaurant-id="'+h(r.id)+'">+ Add more from '+h(r.name)+'</button></section><section class="card stack"><h2 class="section-title">Savings</h2><div class="coupon-row"><input id="coupon-input" class="input" placeholder="Enter offer code" value="'+h(state.coupon&&state.coupon.code||"")+'"><button class="button secondary" data-action="apply-coupon">Apply</button></div><p class="caption">Only live, eligible Scraveit promotions can be applied.</p></section><section class="card">'+priceBreakdown(true)+'</section><button class="button primary full" data-action="go-checkout" '+(!state.online?'disabled':'')+'>Continue to checkout · '+money(orderTotal())+'</button>':emptyState("cart","Your cart is empty","Browse restaurants and add something you will enjoy.","go-home","Explore restaurants"))+'</div>'+nav()+'</main>';
  }

  function addressSummary(address) {
    if(!address)return'<div class="notice warning">'+icon("warning","small")+'<div><strong>No delivery address selected</strong><div class="caption">Add an address with a mobile number before placing your order.</div></div></div>';
    return '<div class="cluster"><span class="settings-icon">'+icon("address")+'</span><div class="grow"><strong>'+h(address.label||address.area||"Delivery address")+'</strong><p class="supporting">'+h(address.address||address.details||"")+'</p><p class="caption">'+h(address.phone||state.profile.phone||"Mobile number required")+(Number.isFinite(Number(address.lat))?' · Location pin saved':' · Location pin needed for proximity alerts')+'</p></div></div>';
  }
  function isOnlinePaymentMethod(value){return value==="upi"||value==="card";}
  function normalizeCheckoutConfiguration(raw){
    const value=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw:null,methods=value&&value.methods&&typeof value.methods==="object"&&!Array.isArray(value.methods)?value.methods:{},method=(name,provider)=>{const source=methods[name]&&typeof methods[name]==="object"&&!Array.isArray(methods[name])?methods[name]:{};return{enabled:source.enabled===true,available:source.available===true,...(provider?{provider:String(source.provider||provider)===provider?provider:provider}:{})}};
    if(!value)return null;
    return{
      version:Number(value.version||1),
      defaultMethod:["cod","upi","card"].includes(String(value.defaultMethod||""))?String(value.defaultMethod):"cod",
      onlineGatewayConfigured:value.onlineGatewayConfigured===true,
      methods:{
        cod:method("cod"),
        upi:method("upi","phonepe"),
        card:method("card","phonepe")
      }
    };
  }
  function checkoutConfig(){return state.checkoutConfig&&typeof state.checkoutConfig==="object"?state.checkoutConfig:null;}
  function checkoutMethodConfig(value){
    const config=checkoutConfig();
    if(!config||!config.methods||!config.methods[value])return null;
    return config.methods[value];
  }
  function paymentMethodProvider(value){
    const method=checkoutMethodConfig(value);
    return method&&method.provider?String(method.provider):"phonepe";
  }
  function paymentMethodEnabled(value){
    const config=checkoutConfig(),method=checkoutMethodConfig(value);
    if(value==="cod")return method?method.available!==false:true;
    if(!onlinePaymentReady())return false;
    return !!(method&&method.available===true);
  }
  function enabledCheckoutMethods(){return["cod","upi","card"].filter(paymentMethodEnabled)}
  function preferredCheckoutMethod(){
    const config=checkoutConfig(),preferred=config&&paymentMethodEnabled(config.defaultMethod)?config.defaultMethod:"";
    if(preferred)return preferred;
    const enabled=enabledCheckoutMethods();
    return enabled[0]||"";
  }
  function reconcileCheckoutPaymentSelection(){
    const next=preferredCheckoutMethod();
    if(next&&state.checkout.payment!==next){state.checkout.payment=next;persistCheckout();return}
    if(!paymentMethodEnabled(state.checkout.payment)&&next){state.checkout.payment=next;persistCheckout()}
  }
  function paymentIntentOperation(){return nativeAvailable("createPaymentIntent")?"createPaymentIntent":nativeAvailable("createPhonePeIntent")?"createPhonePeIntent":"";}
  function onlinePaymentReady(){return nativeAvailable("createOrder")&&nativeAvailable("openExternalPayment")&&!!paymentIntentOperation();}
  function paymentMethodTitle(value){return value==="cod"?"Cash on delivery":value==="upi"?"UPI":"Card";}
  function paymentMethodCopy(value){
    const config=checkoutConfig(),method=checkoutMethodConfig(value);
    if(value==="cod")return method&&method.enabled===false?"Cash on delivery is disabled right now.":"Pay the rider at delivery.";
    if(!method)return value==="upi"?"UPI checkout settings are loading.":"Card checkout settings are loading.";
    if(method&&method.enabled!==true)return value==="upi"?"UPI payment is currently disabled by Scraveit.":"Card payment is currently disabled by Scraveit.";
    if(!onlinePaymentReady())return value==="upi"?"Update this app to use live UPI checkout.":"Update this app to use live card checkout.";
    if(config&&config.onlineGatewayConfigured!==true)return value==="upi"?"UPI checkout will appear once the secure gateway is fully connected.":"Card checkout will appear once the secure gateway is fully connected.";
    if(value==="upi")return"Pay through any supported UPI app on this phone.";
    return"Pay through the connected secure card gateway.";
  }
  function checkoutPrimaryLabel(){
    const action=state.checkout.payment==="cod"?"Place cash order":state.checkout.payment==="upi"?"Place order & pay with UPI":"Place order & pay by card";
    return action+" · est. "+money(orderTotal());
  }
  function paymentOption(id,title,copy,enabled) {
    return '<button class="settings-row" data-action="select-payment" data-value="'+h(id)+'" '+(enabled?'':'disabled')+'><span class="settings-icon">'+icon(id==="cod"?"receipt":"card")+'</span><span class="grow"><strong>'+h(title)+'</strong><span class="supporting">'+h(copy)+'</span></span><span class="'+(state.checkout.payment===id?'status-pill success':'caption')+'">'+(state.checkout.payment===id?'Selected':enabled?'Choose':'Connect gateway')+'</span></button>';
  }
  function screenCheckout() {
    const address=currentAddress();
    reconcileCheckoutPaymentSelection();
    const paymentAvailable=paymentMethodEnabled(state.checkout.payment),paymentWarning=!enabledCheckoutMethods().length?'<div class="notice warning">'+icon("warning","small")+'<span>No checkout payment method is available right now. Please try again in a moment.</span></div>':"";
    return '<main class="screen"><div class="screen-content page-stack">'+topbar("Review your order","Confirm contact, delivery and payment details.")+networkBanner()
      +'<section class="card stack"><div class="cluster between"><h2 class="section-title">Delivering to</h2><button class="text-button" data-action="go" data-route="addresses">Change</button></div>'+addressSummary(address)+'</section>'
      +'<section class="card stack"><h2 class="section-title">Delivery time</h2><div class="segmented"><button class="segment '+(state.checkout.deliveryMode==="asap"?'active':'')+'" data-action="delivery-mode" data-value="asap">As soon as possible</button><button class="segment '+(state.checkout.deliveryMode==="scheduled"?'active':'')+'" data-action="delivery-mode" data-value="scheduled">Schedule</button></div>'+(state.checkout.deliveryMode==="scheduled"?'<div class="notice info">'+icon("clock","small")+'<span>Scheduled delivery needs restaurant and dispatch scheduling services. It will be activated with the production backend.</span></div>':'')+'</section>'
      +'<section class="card stack"><h2 class="section-title">Delivery preferences</h2><label class="field"><span>Instructions for the rider</span><textarea id="checkout-instructions" class="textarea" maxlength="180" placeholder="Landmark, gate or delivery note">'+h(state.checkout.instructions)+'</textarea></label><button class="settings-row" data-action="toggle-contactless"><span class="settings-icon">'+icon("shield")+'</span><span class="grow"><strong>Contactless delivery</strong><span class="supporting">Leave the order at the door and notify me.</span></span><span class="switch '+(state.checkout.contactless?'on':'')+'" aria-hidden="true"></span></button></section>'
      +'<section class="card stack"><div><h2 class="section-title">Tip your delivery partner</h2><p class="supporting">Choose an optional amount for your Scraveit Partner.</p></div><div class="segmented"><button class="segment '+(Number(state.tip||0)===0?'active':'')+'" data-action="set-tip" data-value="0">No tip</button><button class="segment '+(Number(state.tip)===20?'active':'')+'" data-action="set-tip" data-value="20">₹20</button><button class="segment '+(Number(state.tip)===30?'active':'')+'" data-action="set-tip" data-value="30">₹30</button><button class="segment '+(Number(state.tip)===50?'active':'')+'" data-action="set-tip" data-value="50">₹50</button></div><div class="cluster"><input id="custom-tip" class="input grow" type="number" min="0" max="1000" step="1" placeholder="Custom tip"><button class="button secondary" data-action="apply-custom-tip">Apply</button></div></section>'
      +'<section class="card settings-list"><div style="padding:18px 16px 8px"><h2 class="section-title">Payment</h2><p class="supporting">Only verified payment methods can be selected.</p></div>'+["cod","upi","card"].map(id=>paymentOption(id,paymentMethodTitle(id),paymentMethodCopy(id),paymentMethodEnabled(id))).join("")+'</section>'
      +paymentWarning
      +'<section class="card">'+priceBreakdown(true)+'</section><div class="notice info">'+icon("shield","small")+'<span>The secure Scraveit server validates menu prices, discounts, distance and any weather or demand fee. The server-confirmed order total replaces this estimate in your final receipt.</span></div>'
      +'<button class="button primary full" data-action="place-order" '+(!address||!state.online||state.loading||!state.cart.length||!paymentAvailable?'disabled':'')+'>'+(state.loading?'<span class="spinner"></span> Placing order…':checkoutPrimaryLabel())+'</button></div>'+nav()+'</main>';
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
      +(!state.orders.length&&!state.loading?emptyState("orders","No orders yet","Your first Scraveit order will appear here.","go-home","Explore restaurants"):'')+'</div>'+nav()+'</main>';
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
  function onlinePaymentNotice(order){
    if(!order||!isOnlinePaymentMethod(order.paymentMethod)||order.paymentState==="paid"||order.paymentState==="refunded")return"";
    const retry=order.paymentState==="failed";
    const statusCopy=retry?"The previous payment attempt did not complete.":"Pay this order securely before the restaurant can accept it.";
    return '<section class="card stack"><div class="notice '+(retry?'warning':'info')+'">'+icon(retry?"warning":"shield","small")+'<div><strong>'+(retry?'Retry payment':'Payment pending')+'</strong><div class="caption">'+h(statusCopy)+'</div></div></div><button class="button primary full" data-action="pay-order" data-order-id="'+h(order.id)+'">'+(retry?'Retry payment':'Complete payment')+'</button></section>';
  }
  function screenOrder() {
    const order=orderById();if(!order)return'<main class="screen"><div class="screen-content">'+topbar("Order unavailable","This order is not in your account cache.")+emptyState("orders","Order not found","Refresh your orders and try again.","refresh","Refresh orders")+'</div>'+nav()+'</main>';
    const tracking=state.tracking[order.id];const canTrack=["Assigned","Handed to rider","Out for delivery","Near you","Arrived"].includes(order.status);
    const showDeliveryOtp=["Out for delivery","Near you","Arrived"].includes(order.status),deliveryOtp=state.deliveryOtps[order.id];
    const savedReview=state.reviews[order.id]||null,restaurantReviewRating=Number(savedReview&&savedReview.rating||0),riderReviewRating=Number(savedReview&&savedReview.riderRating||0);
    const submittedReviewMarkup=savedReview?'<section class="card stack"><div><p class="eyebrow">Your feedback</p><h2 class="section-title">Ratings submitted</h2></div><div class="price-row"><span>Restaurant & food</span><strong>'+h(restaurantReviewRating.toFixed(1))+' / 5</strong></div>'+(riderReviewRating>0?'<div class="price-row"><span>Delivery partner</span><strong>'+h(riderReviewRating.toFixed(1))+' / 5</strong></div>':'')+'<p class="caption">Saved to this delivered order.</p></section>':'';
    const reviewAction=order.status!=="Delivered"?'':savedReview?'<button class="button tonal grow" data-action="review-order" data-order-id="'+h(order.id)+'">'+icon("star")+' View your rating</button>':reviewStateReady()?'<button class="button tonal grow" data-action="review-order" data-order-id="'+h(order.id)+'">'+icon("star")+' Rate order</button>':'<button class="button tonal grow" disabled><span class="spinner"></span> Checking feedback…</button>';
    return '<main class="screen"><div class="screen-content page-stack">'+topbar("Order "+order.id,order.restaurant||"Order details")+networkBanner()
      +'<section class="card brand-card stack"><div class="cluster between"><span class="status-pill" style="background:rgba(255,255,255,.17);color:white">'+h(order.status)+'</span><strong>'+h(etaText(order))+'</strong></div><h2 class="section-title" style="font-size:25px">'+(order.status==="Delivered"?'Delivered with care.':order.status==="Cancelled"?'This order was cancelled.':'Your order is moving forward.')+'</h2><p class="supporting">Last updated '+h(timeAgo(order.updatedAt||order.createdAt))+'</p>'+(canTrack?'<button class="button" style="background:white;color:#155eef" data-action="open-tracking" data-order-id="'+h(order.id)+'">'+icon("pin")+' Open live tracking</button>':'')+'</section>'
      +(showDeliveryOtp?'<section class="card stack" aria-label="Delivery verification code"><div><p class="eyebrow">Delivery OTP</p><h2 class="section-title">Share only at your doorstep.</h2><p class="supporting">Give this code to your assigned Scraveit Partner only after you receive the complete order.</p></div>'+(deliveryOtp?'<div style="font-size:36px;line-height:1;font-weight:850;letter-spacing:.24em;color:var(--primary);padding:10px 0" aria-label="Delivery code '+h(deliveryOtp.split("").join(" "))+'">'+h(deliveryOtp)+'</div>':'<div class="notice warning">'+icon("warning","small")+'<span>This code is available only on the device that placed the order. Use in-app support if you changed devices.</span></div>')+'</section>':'')
      +'<section class="card stack"><div><h2 class="section-title">Order journey</h2><p class="supporting">Restaurant and rider events are shown as they happen.</p></div>'+statusTimeline(order)+'</section>'
      +onlinePaymentNotice(order)
      +(order.riderName?'<section class="card cluster"><span class="avatar">'+h(String(order.riderName).slice(0,1).toUpperCase())+'</span><div class="grow"><h2 class="card-title">'+h(order.riderName)+'</h2><p class="supporting">Your assigned Scraveit Partner'+(order.riderPhone?' · '+h(order.riderPhone):'')+'</p></div><span class="status-pill '+(tracking&&tracking.status==="live"?'success':'')+'">'+(tracking&&tracking.status==="live"?'Tracking live':'Assigned')+'</span></section>':'')
      +'<section class="card stack"><h2 class="section-title">Communication</h2><p class="supporting">Call or chat while this order is active.</p><div class="cluster wrap"><button class="button tonal grow" data-action="open-order-chat" data-channel="customerRestaurant" data-order-id="'+h(order.id)+'">Chat restaurant</button>'+(order.restaurantPhone&&!TERMINAL_STATES.has(order.status)?'<a class="button secondary grow" href="tel:'+h(order.restaurantPhone)+'">Call restaurant</a>':'')+(order.riderId?'<button class="button tonal grow" data-action="open-order-chat" data-channel="customerRider" data-order-id="'+h(order.id)+'">Chat rider</button>':'')+(order.riderId&&order.riderPhone&&!TERMINAL_STATES.has(order.status)?'<a class="button secondary grow" href="tel:'+h(order.riderPhone)+'">Call rider</a>':'')+'</div></section>'+'<section class="card stack"><div class="cluster between"><h2 class="section-title">Items</h2><strong>'+money(order.total)+'</strong></div>'+orderItemsSummary(order)+'<div class="price-row total"><span>Paid / due</span><span>'+h(order.paymentMethod==="cod"||order.paymentMethod==="Cash on delivery"?'Cash on delivery':order.paymentMethod||"Payment")+'</span></div></section>'
      +'<section class="card stack"><h2 class="section-title">Delivery details</h2>'+addressSummary(order.address||{})+(order.instructions?'<div class="notice info">'+icon("info","small")+'<span>'+h(order.instructions)+'</span></div>':'')+'</section>'+submittedReviewMarkup
      +(order.status!=="Cancelled"?adminContactMarkup():'')
      +'<div class="cluster wrap">'+(order.status==="Delivered"?'<button class="button secondary grow" data-action="reorder" data-order-id="'+h(order.id)+'">'+icon("refresh")+' Reorder</button>'+reviewAction:'')+(["Order placed","Accepted"].includes(order.status)?'<button class="button danger grow" data-action="cancel-order" data-order-id="'+h(order.id)+'">Request cancellation</button>':'')+'<button class="button tonal grow" data-action="support-order" data-order-id="'+h(order.id)+'">'+icon("help")+' Get help</button></div>'
      +'</div>'+nav()+'</main>';
  }

  const TRACKING_MAP_MIN_ZOOM=12, TRACKING_MAP_MAX_ZOOM=18, TRACKING_MAP_FIT_PX=240, TRACKING_TILE_PX=256, TRACKING_MAX_TILES=80;
  const TRACKING_POLL_MS=5000, TRACKING_STREAM_GRACE_MS=8000;
  // The bottom sheet covers the lower part of the map, so the camera anchor sits
  // at 27% from the top - the middle of the strip that stays visible. This must
  // stay in sync with `.map-world { top: 27% }` in premium.css.
  const TRACKING_MAP_VERTICAL_ANCHOR_PCT=27;
  // One duration for the marker and the camera so they travel in lockstep; a
  // linear curve matches the steady cadence the partner app uploads fixes at.
  const TRACKING_GLIDE_MS=2600;
  function trackingGeoPoints(order,live){
    const riderPoint=coordinatePoint(live);
    const restaurantPoint=coordinatePoint(order.restaurantLocation)||coordinatePoint(restaurant(order.restaurantId));
    const customerPoint=coordinatePoint(order.address);
    return {riderPoint,restaurantPoint,customerPoint};
  }
  function trackingAllPoints(points){
    return [points.restaurantPoint,points.customerPoint,points.riderPoint].filter(Boolean);
  }
  function fitTrackingMapView(points){
    let minLat=points[0].lat,maxLat=points[0].lat,minLng=points[0].lng,maxLng=points[0].lng;
    for(const p of points){minLat=Math.min(minLat,p.lat);maxLat=Math.max(maxLat,p.lat);minLng=Math.min(minLng,p.lng);maxLng=Math.max(maxLng,p.lng);}
    const center={lat:(minLat+maxLat)/2,lng:(minLng+maxLng)/2};
    let zoom=TRACKING_MAP_MAX_ZOOM;
    for(;zoom>TRACKING_MAP_MIN_ZOOM;zoom--){
      const a=mapWorld(minLat,minLng,zoom),b=mapWorld(maxLat,maxLng,zoom);
      if(Math.max(Math.abs(b.x-a.x),Math.abs(a.y-b.y))<=TRACKING_MAP_FIT_PX)break;
    }
    return {center,zoom};
  }
  // While the partner is still collecting the order the restaurant is what
  // matters; once they are carrying it the customer's door is.
  function trackingDestination(points,live){
    if(String(live&&live.phase||"")==="pickup")return points.restaurantPoint||points.customerPoint||null;
    return points.customerPoint||points.restaurantPoint||null;
  }
  function trackingCameraFocus(points,live){
    const rider=points.riderPoint,destination=trackingDestination(points,live);
    if(rider&&destination)return {lat:(rider.lat+destination.lat)/2,lng:(rider.lng+destination.lng)/2};
    return rider||destination||null;
  }
  function trackingMapState(order,points){
    const current=state.trackingMap;
    if(current&&current.orderId===order.id)return current;
    const all=trackingAllPoints(points);
    if(!all.length)return null;
    const fitted=fitTrackingMapView(all);
    state.trackingMap={orderId:order.id,zoom:fitted.zoom,anchorLat:fitted.center.lat,anchorLng:fitted.center.lng,
      panX:0,panY:0,userPanned:false,userZoomed:false,tileKey:"",tilePanX:0,tilePanY:0,tileTimer:null};
    return state.trackingMap;
  }
  function trackingLocalPoint(ms,point){
    const anchor=mapWorld(ms.anchorLat,ms.anchorLng,ms.zoom),p=mapWorld(point.lat,point.lng,ms.zoom);
    return {x:p.x-anchor.x,y:p.y-anchor.y};
  }
  function trackingViewportSize(){
    const card=document.getElementById("tracking-map-card");
    const width=card&&card.clientWidth?card.clientWidth:(window.innerWidth||360);
    const height=card&&card.clientHeight?card.clientHeight:(window.innerHeight||720);
    return {width:Math.max(280,width),height:Math.max(420,height)};
  }
  function trackingTileRange(ms){
    const anchor=mapWorld(ms.anchorLat,ms.anchorLng,ms.zoom),size=trackingViewportSize();
    const above=size.height*(TRACKING_MAP_VERTICAL_ANCHOR_PCT/100),below=size.height-above;
    const minX=anchor.x-ms.panX-size.width/2-TRACKING_TILE_PX,maxX=anchor.x-ms.panX+size.width/2+TRACKING_TILE_PX;
    const minY=anchor.y-ms.panY-above-TRACKING_TILE_PX,maxY=anchor.y-ms.panY+below+TRACKING_TILE_PX;
    return {originX:anchor.x,originY:anchor.y,
      minTileX:Math.floor(minX/TRACKING_TILE_PX),maxTileX:Math.floor(maxX/TRACKING_TILE_PX),
      minTileY:Math.floor(minY/TRACKING_TILE_PX),maxTileY:Math.floor(maxY/TRACKING_TILE_PX)};
  }
  function trackingTileKey(ms){
    const r=trackingTileRange(ms);
    return ms.zoom+":"+r.minTileX+","+r.maxTileX+","+r.minTileY+","+r.maxTileY;
  }
  function trackingTileList(ms){
    const range=trackingTileRange(ms),max=Math.pow(2,ms.zoom),tiles=[];
    for(let ty=range.minTileY;ty<=range.maxTileY;ty++){
      if(ty<0||ty>=max)continue;
      for(let tx=range.minTileX;tx<=range.maxTileX;tx++){
        let wrapped=tx%max;if(wrapped<0)wrapped+=max;
        tiles.push({key:ms.zoom+"/"+tx+"/"+ty,
          src:"https://tile.openstreetmap.org/"+ms.zoom+"/"+wrapped+"/"+ty+".png",
          left:tx*TRACKING_TILE_PX-range.originX,top:ty*TRACKING_TILE_PX-range.originY});
        if(tiles.length>=TRACKING_MAX_TILES)return trackingOrderTiles(ms,tiles);
      }
    }
    return trackingOrderTiles(ms,tiles);
  }
  // Nearest-to-the-middle first, so a fresh view fills in from where the eye is
  // rather than from a corner.
  function trackingOrderTiles(ms,tiles){
    const focusX=-ms.panX,focusY=-ms.panY;
    return tiles.slice().sort((a,b)=>
      (Math.hypot(a.left+TRACKING_TILE_PX/2-focusX,a.top+TRACKING_TILE_PX/2-focusY))
      -(Math.hypot(b.left+TRACKING_TILE_PX/2-focusX,b.top+TRACKING_TILE_PX/2-focusY)));
  }
  function trackingTileMarkup(ms){
    return trackingTileList(ms).map(tile=>'<img alt="" aria-hidden="true" class="ready" data-tile="'+tile.key+'" src="'+tile.src+'" style="left:'+tile.left.toFixed(0)+'px;top:'+tile.top.toFixed(0)+'px">').join("");
  }
  function trackingPinMarkup(ms,variant,point,label,iconName,isLive){
    if(!point)return '<span class="map-pin '+variant+'" style="display:none" aria-label="'+h(label)+'">'+icon(iconName)+'</span>';
    const local=trackingLocalPoint(ms,point);
    return '<span class="map-pin '+variant+(isLive?' live':'')+'" style="transform:translate3d('+local.x.toFixed(1)+'px,'+local.y.toFixed(1)+'px,0)" aria-label="'+h(label)+'">'+icon(iconName)+'</span>';
  }
  // The delivery route (restaurant -> door) is a fixed path for an order, so it
  // is fetched once from OSRM's free routing service and cached. It is drawn
  // for context only; the partner's own position always comes from their GPS.
  const TRACKING_ROUTE_ENDPOINT="https://router.project-osrm.org/route/v1/driving/";
  const TRACKING_ROUTE_CACHE_KEY="savrivo.customer.routes";
  const TRACKING_ROUTE_TTL_MS=30*24*60*60*1000;
  const TRACKING_ROUTE_RETRY_MS=5*60*1000;
  const TRACKING_ROUTE_MAX_CACHED=8;
  function decodePolyline(encoded,precision){
    const factor=Math.pow(10,Number.isFinite(precision)?precision:5),points=[];
    let index=0,lat=0,lng=0;
    while(index<encoded.length){
      let result=1,shift=0,byte;
      do{byte=encoded.charCodeAt(index++)-64;if(!Number.isFinite(byte))return[];result+=byte<<shift;shift+=5;}while(byte>=0x1f&&index<=encoded.length);
      lat+=(result&1)?~(result>>1):(result>>1);
      result=1;shift=0;
      do{byte=encoded.charCodeAt(index++)-64;if(!Number.isFinite(byte))return[];result+=byte<<shift;shift+=5;}while(byte>=0x1f&&index<=encoded.length);
      lng+=(result&1)?~(result>>1):(result>>1);
      points.push({lat:lat/factor,lng:lng/factor});
      if(points.length>4000)break;
    }
    return points;
  }
  function trackingRouteKey(from,to){
    return from.lat.toFixed(5)+","+from.lng.toFixed(5)+">"+to.lat.toFixed(5)+","+to.lng.toFixed(5);
  }
  function readTrackingRouteCache(){
    const raw=loadJSON(TRACKING_ROUTE_CACHE_KEY,{});
    return raw&&typeof raw==="object"?raw:{};
  }
  function writeTrackingRouteCache(key,entry){
    const cache=readTrackingRouteCache();
    cache[key]=entry;
    const keys=Object.keys(cache).sort((a,b)=>Number(cache[b].at||0)-Number(cache[a].at||0));
    const trimmed={};
    keys.slice(0,TRACKING_ROUTE_MAX_CACHED).forEach(k=>{trimmed[k]=cache[k];});
    try{localStorage.setItem(TRACKING_ROUTE_CACHE_KEY,JSON.stringify(trimmed));}catch(_){}
  }
  function cachedTrackingRoute(key){
    const entry=readTrackingRouteCache()[key];
    if(!entry||!entry.polyline||Date.now()-Number(entry.at||0)>TRACKING_ROUTE_TTL_MS)return null;
    return entry.polyline;
  }
  function trackingRoutePoints(order){
    const points=trackingGeoPoints(order,{});
    if(!points.restaurantPoint||!points.customerPoint)return null;
    const key=trackingRouteKey(points.restaurantPoint,points.customerPoint);
    const live=state.trackingRoutes[key];
    if(live&&live.points)return live;
    const polyline=cachedTrackingRoute(key);
    if(polyline){
      const decoded=decodePolyline(polyline);
      if(decoded.length>=2){
        state.trackingRoutes[key]=trackingRouteMetrics(decoded);
        return state.trackingRoutes[key];
      }
    }
    // The free public OSRM router can be slow, rate-limited or briefly unreachable
    // from a mobile connection, and ensureTrackingRoute only retries every
    // TRACKING_ROUTE_RETRY_MS after a failure - rather than showing no line at all
    // in the meantime, draw a straight line between the two points. It is not
    // cached, so it is transparently replaced by the real road-following polyline
    // the moment ensureTrackingRoute succeeds (state.trackingRoutes[key] then has
    // .points and the check above returns it directly).
    return trackingRouteMetrics([points.restaurantPoint,points.customerPoint]);
  }
  async function ensureTrackingRoute(order){
    const points=trackingGeoPoints(order,{});
    if(!points.restaurantPoint||!points.customerPoint||!state.online)return;
    const key=trackingRouteKey(points.restaurantPoint,points.customerPoint);
    const existing=state.trackingRoutes[key];
    if(existing&&(existing.points||existing.pending))return;
    if(existing&&existing.failedAt&&Date.now()-existing.failedAt<TRACKING_ROUTE_RETRY_MS)return;
    if(cachedTrackingRoute(key))return;
    state.trackingRoutes[key]={pending:true};
    try{
      const from=points.restaurantPoint,to=points.customerPoint;
      const url=TRACKING_ROUTE_ENDPOINT
        +from.lng.toFixed(6)+","+from.lat.toFixed(6)+";"+to.lng.toFixed(6)+","+to.lat.toFixed(6)
        +"?overview=full&geometries=polyline";
      const response=await fetch(url,{method:"GET",cache:"force-cache"});
      if(!response.ok)throw new Error("route request failed");
      const payload=await response.json();
      const polyline=payload&&payload.code==="Ok"&&Array.isArray(payload.routes)&&payload.routes[0]?payload.routes[0].geometry:"";
      const decoded=typeof polyline==="string"&&polyline.length>1?decodePolyline(polyline):[];
      if(decoded.length<2)throw new Error("route had no usable geometry");
      state.trackingRoutes[key]=trackingRouteMetrics(decoded);
      writeTrackingRouteCache(key,{polyline:polyline,at:Date.now()});
      if(state.route==="tracking")render({preserveScroll:true});
    }catch(_){
      state.trackingRoutes[key]={failedAt:Date.now()};
    }
  }
  // ---- route geometry -------------------------------------------------------
  // The drawn line is the road still ahead of the partner. Every new fix is
  // projected onto the route, and the trim point is then eased along the road
  // between fixes so the line retracts continuously instead of in steps.
  const TRACKING_ON_ROUTE_TOLERANCE_M=140, TRACKING_MAX_REWIND_M=25;
  function trackingMetres(a,b){
    const km=geoDistanceKm(a.lat,a.lng,b.lat,b.lng);
    return km==null?0:km*1000;
  }
  function trackingRouteMetrics(points){
    const cumulative=[0];
    for(let i=1;i<points.length;i++)cumulative.push(cumulative[i-1]+trackingMetres(points[i-1],points[i]));
    return {points:points,cumulative:cumulative,total:cumulative[cumulative.length-1]||0};
  }
  // Closest point on the route, as a distance along it plus how far off it the
  // fix landed - the offset is what tells us the partner is actually on this road.
  function trackingProjectOnRoute(route,point){
    const cosLat=Math.cos(point.lat*Math.PI/180);
    const toX=lng=>lng*111320*cosLat,toY=lat=>lat*110540;
    const px=toX(point.lng),py=toY(point.lat);
    let bestProgress=0,bestOffset=Infinity;
    for(let i=1;i<route.points.length;i++){
      const a=route.points[i-1],b=route.points[i];
      const ax=toX(a.lng),ay=toY(a.lat),bx=toX(b.lng),by=toY(b.lat);
      const dx=bx-ax,dy=by-ay,lengthSquared=dx*dx+dy*dy;
      let t=lengthSquared>0?((px-ax)*dx+(py-ay)*dy)/lengthSquared:0;
      t=Math.max(0,Math.min(1,t));
      const offset=Math.hypot(px-(ax+dx*t),py-(ay+dy*t));
      if(offset<bestOffset){
        bestOffset=offset;
        bestProgress=route.cumulative[i-1]+(route.cumulative[i]-route.cumulative[i-1])*t;
      }
    }
    return {progress:bestProgress,offset:bestOffset};
  }
  function trackingPointAtProgress(route,progress){
    const target=Math.max(0,Math.min(route.total,progress));
    let i=1;
    while(i<route.cumulative.length&&route.cumulative[i]<target)i++;
    if(i>=route.cumulative.length)return route.points[route.points.length-1];
    const a=route.points[i-1],b=route.points[i],span=route.cumulative[i]-route.cumulative[i-1];
    const t=span>0?(target-route.cumulative[i-1])/span:0;
    return {lat:a.lat+(b.lat-a.lat)*t,lng:a.lng+(b.lng-a.lng)*t};
  }
  function trackingRemainingRoute(route,progress){
    const remaining=[trackingPointAtProgress(route,progress)];
    for(let i=0;i<route.points.length;i++)if(route.cumulative[i]>progress)remaining.push(route.points[i]);
    if(remaining.length<2)remaining.push(route.points[route.points.length-1]);
    return remaining;
  }
  // The line belongs to the delivery leg only. While the partner is still
  // collecting the order they simply move around with no line drawn.
  function trackingDeliveryLegActive(order,live){
    const phase=String(live&&live.phase||"");
    if(phase==="delivery")return true;
    if(phase==="pickup")return false;
    return ["Out for delivery","Near you","Arrived"].indexOf(String(order&&order.status||""))!==-1;
  }
  function trackingRouteView(order,live){
    const route=trackingRoutePoints(order);
    if(!route||route.points.length<2)return null;
    if(!trackingDeliveryLegActive(order,live))return null;
    const ms=state.trackingMap;
    if(!ms)return null;
    const riderLat=Number(live.lat),riderLng=Number(live.lng);
    if(!Number.isFinite(riderLat)||!Number.isFinite(riderLng))return {route:route,progress:ms.routeProgress||0,snapped:false};
    const projected=trackingProjectOnRoute(route,{lat:riderLat,lng:riderLng});
    if(projected.offset>TRACKING_ON_ROUTE_TOLERANCE_M)return {route:route,progress:ms.routeProgress||0,snapped:false};
    return {route:route,progress:projected.progress,snapped:true};
  }
  // The svg keeps a frame sized to the whole route so that trimming the line
  // only rewrites its points - the element itself never has to move or resize.
  function trackingRouteFrame(ms,route){
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    route.points.forEach(point=>{
      const p=trackingLocalPoint(ms,point);
      minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);
    });
    const pad=8;
    return {minX:minX-pad,minY:minY-pad,width:Math.max(1,maxX-minX)+pad*2,height:Math.max(1,maxY-minY)+pad*2};
  }
  function trackingRouteCoords(ms,route,frame,progress){
    return trackingRemainingRoute(route,progress).map(point=>{
      const p=trackingLocalPoint(ms,point);
      return (p.x-frame.minX).toFixed(1)+","+(p.y-frame.minY).toFixed(1);
    }).join(" ");
  }
  function trackingRouteMarkup(ms,order,live){
    const view=trackingRouteView(order,live);
    if(!view)return "";
    if(!Number.isFinite(ms.routeProgress))ms.routeProgress=view.snapped?view.progress:0;
    const route=view.route,frame=trackingRouteFrame(ms,route);
    const coords=trackingRouteCoords(ms,route,frame,ms.routeProgress);
    return '<svg class="map-route" aria-hidden="true" width="'+frame.width.toFixed(0)+'" height="'+frame.height.toFixed(0)+'"'
      +' viewBox="0 0 '+frame.width.toFixed(0)+' '+frame.height.toFixed(0)+'"'
      +' style="left:'+frame.minX.toFixed(1)+'px;top:'+frame.minY.toFixed(1)+'px">'
      +'<polyline class="map-route-casing" points="'+coords+'"/>'
      +'<polyline class="map-route-line" points="'+coords+'"/>'
      +'</svg>';
  }
  // One animation frame of the retracting line: redraw the remaining road and
  // put the scooter exactly on it, so marker and line can never disagree.
  function paintTrackingRoute(){
    const ms=state.trackingMap,card=document.getElementById("tracking-map-card");
    if(!ms||!card)return;
    const order=orderById(ms.orderId);
    if(!order)return;
    const live=state.tracking[ms.orderId]||{};
    const view=trackingRouteView(order,live);
    if(!view)return;
    const route=view.route,progress=Number.isFinite(ms.routeProgress)?ms.routeProgress:0;
    const svg=card.querySelector(".map-route");
    if(svg){
      const coords=trackingRouteCoords(ms,route,trackingRouteFrame(ms,route),progress);
      const lines=svg.querySelectorAll("polyline");
      for(let i=0;i<lines.length;i++)lines[i].setAttribute("points",coords);
    }
    const rider=card.querySelector(".map-pin.rider");
    if(rider){
      const local=trackingLocalPoint(ms,trackingPointAtProgress(route,progress));
      rider.style.transition="none";
      rider.style.display="";
      rider.style.transform='translate3d('+local.x.toFixed(1)+'px,'+local.y.toFixed(1)+'px,0)';
    }
  }
  function startTrackingRouteGlide(target){
    const ms=state.trackingMap;
    if(!ms)return;
    ms.routeFrom=Number.isFinite(ms.routeProgress)?ms.routeProgress:target;
    ms.routeTarget=target;
    ms.routeGlideStart=Date.now();
    if(ms.routeAnim&&typeof cancelAnimationFrame==="function")cancelAnimationFrame(ms.routeAnim);
    ms.routeAnim=typeof requestAnimationFrame==="function"?requestAnimationFrame(stepTrackingRouteGlide):null;
    if(!ms.routeAnim){ms.routeProgress=target;paintTrackingRoute();}
  }
  function stepTrackingRouteGlide(){
    const ms=state.trackingMap;
    if(!ms)return;
    if(state.route!=="tracking"){ms.routeAnim=null;return;}
    const elapsed=Date.now()-ms.routeGlideStart;
    const t=TRACKING_GLIDE_MS>0?Math.min(1,elapsed/TRACKING_GLIDE_MS):1;
    ms.routeProgress=ms.routeFrom+(ms.routeTarget-ms.routeFrom)*t;
    paintTrackingRoute();
    ms.routeAnim=t<1&&typeof requestAnimationFrame==="function"?requestAnimationFrame(stepTrackingRouteGlide):null;
  }
  function stopTrackingRouteGlide(){
    const ms=state.trackingMap;
    if(ms&&ms.routeAnim&&typeof cancelAnimationFrame==="function")cancelAnimationFrame(ms.routeAnim);
    if(ms)ms.routeAnim=null;
  }
  function trackingMapMarkup(order,live,full){
    const points=trackingGeoPoints(order,live);
    const ms=trackingMapState(order,points);
    if(!ms){
      return '<section class="card map-card map-card-empty'+(full?' map-card-full':'')+'"><div class="map-placeholder">'+icon("pin")+'<p class="supporting">The live map will appear once delivery locations are available.</p></div></section>';
    }
    ms.tileKey=trackingTileKey(ms);
    ms.tilePanX=ms.panX;ms.tilePanY=ms.panY;
    const fresh=!!(live.updatedAt&&Date.now()-Number(live.updatedAt)<45000);
    return '<section class="card map-card'+(full?' map-card-full':'')+'" id="tracking-map-card" data-order-id="'+h(order.id)+'">'
      +'<div class="map-world" id="tracking-map-world" style="transform:translate3d('+ms.panX.toFixed(1)+'px,'+ms.panY.toFixed(1)+'px,0)">'
      +'<div class="map-tiles">'+trackingTileMarkup(ms)+'</div>'
      +trackingRouteMarkup(ms,order,live)
      +trackingPinMarkup(ms,"restaurant",points.restaurantPoint,"Restaurant","receipt",false)
      +trackingPinMarkup(ms,"home",points.customerPoint,"Delivery address","home",false)
      +trackingPinMarkup(ms,"rider",points.riderPoint,"Delivery partner","scooter",fresh)
      +'</div>'
      +'<div class="map-overlay"><span class="status-pill map-status-pill '+(fresh?'success':'warning')+'">'+(fresh?'LIVE':'STALE')+'</span><span class="map-attribution">© OpenStreetMap</span></div>'
      +'<div class="map-controls">'
      +'<button type="button" class="map-control" data-action="tracking-zoom" data-delta="1" aria-label="Zoom in">+</button>'
      +'<button type="button" class="map-control" data-action="tracking-zoom" data-delta="-1" aria-label="Zoom out">&#8722;</button>'
      +'<button type="button" class="map-control'+(ms.userPanned||ms.userZoomed?'':' hidden')+'" id="tracking-recenter" data-action="tracking-recenter" aria-label="Recentre the map">'+icon("target")+'</button>'
      +'</div>'
      +'</section>';
  }
  function applyTrackingCamera(animate){
    const world=document.getElementById("tracking-map-world"),ms=state.trackingMap;
    if(!world||!ms)return;
    world.style.transition=animate?("transform "+TRACKING_GLIDE_MS+"ms linear"):"none";
    world.style.transform='translate3d('+ms.panX.toFixed(1)+'px,'+ms.panY.toFixed(1)+'px,0)';
  }
  function refreshTrackingTiles(){
    const ms=state.trackingMap,card=document.getElementById("tracking-map-card");
    if(!ms||!card)return;
    const key=trackingTileKey(ms);
    if(key===ms.tileKey)return;
    const layer=card.querySelector(".map-tiles");
    if(!layer)return;
    ms.tileKey=key;ms.tilePanX=ms.panX;ms.tilePanY=ms.panY;
    // Reconcile rather than re-writing innerHTML. Recreating every <img> on each
    // pan makes tiles that are already on screen blink out and back in, which is
    // what reads as the map "glitching" while it is dragged.
    const wanted=trackingTileList(ms),keep={},existing={};
    let node=layer.firstElementChild;
    while(node){const id=node.getAttribute("data-tile");if(id)existing[id]=node;node=node.nextElementSibling;}
    wanted.forEach(tile=>{
      keep[tile.key]=true;
      const current=existing[tile.key];
      if(current){current.style.left=tile.left.toFixed(0)+"px";current.style.top=tile.top.toFixed(0)+"px";return;}
      const img=document.createElement("img");
      img.alt="";img.setAttribute("aria-hidden","true");img.setAttribute("data-tile",tile.key);
      img.style.left=tile.left.toFixed(0)+"px";img.style.top=tile.top.toFixed(0)+"px";
      img.addEventListener("load",function(){img.classList.add("ready");});
      img.src=tile.src;
      if(img.complete)img.classList.add("ready");
      layer.appendChild(img);
    });
    Object.keys(existing).forEach(id=>{if(!keep[id])existing[id].remove();});
  }
  function trackingCameraFollow(points,live){
    const ms=state.trackingMap;
    if(!ms||ms.userPanned)return;
    const focus=trackingCameraFocus(points,live);
    if(!focus)return;
    const local=trackingLocalPoint(ms,focus),nextX=-local.x,nextY=-local.y;
    if(Math.abs(nextX-ms.panX)<1&&Math.abs(nextY-ms.panY)<1)return;
    ms.panX=nextX;ms.panY=nextY;
    applyTrackingCamera(true);
    clearTimeout(ms.tileTimer);
    ms.tileTimer=setTimeout(refreshTrackingTiles,TRACKING_GLIDE_MS+80);
  }
  function setTrackingPin(card,selector,ms,point,isLive){
    const element=card.querySelector(selector);
    if(!element)return;
    if(!point){element.style.display="none";return;}
    const local=trackingLocalPoint(ms,point);
    element.style.display="";
    element.style.transition="";
    element.style.transform='translate3d('+local.x.toFixed(1)+'px,'+local.y.toFixed(1)+'px,0)';
    if(isLive!=null)element.classList.toggle("live",!!isLive);
  }
  function patchTrackingMap(orderId){
    const card=document.getElementById("tracking-map-card");
    if(!card||card.dataset.orderId!==orderId)return false;
    const ms=state.trackingMap;
    if(!ms||ms.orderId!==orderId)return false;
    const order=orderById(orderId);if(!order)return false;
    const live=state.tracking[orderId]||{};
    const points=trackingGeoPoints(order,live);
    const all=trackingAllPoints(points);
    if(!all.length)return false;
    // Only ever widen the view, and only when the points genuinely no longer
    // fit: auto-zooming back in would undo a manual zoom a couple of seconds
    // after the partner makes it, and would keep nudging the scale around.
    // A zoom change rescales every local coordinate, so that one case still
    // needs a full re-render; everything else is animated in place.
    const fitted=fitTrackingMapView(all);
    if(!ms.userPanned&&!ms.userZoomed&&fitted.zoom<ms.zoom){
      ms.zoom=fitted.zoom;ms.anchorLat=fitted.center.lat;ms.anchorLng=fitted.center.lng;
      ms.panX=0;ms.panY=0;ms.tileKey="";
      return false;
    }
    const fresh=!!(live.updatedAt&&Date.now()-Number(live.updatedAt)<45000);
    setTrackingPin(card,".map-pin.restaurant",ms,points.restaurantPoint,null);
    setTrackingPin(card,".map-pin.home",ms,points.customerPoint,null);
    // On the delivery leg the scooter is driven along the route itself, which
    // both keeps it on the road and lets the line retract in step with it.
    const routeView=trackingRouteView(order,live);
    if(routeView&&routeView.snapped){
      let target=routeView.progress;
      // GPS noise must not make the line grow back; only real backtracking does.
      if(Number.isFinite(ms.routeProgress)&&target<ms.routeProgress-TRACKING_MAX_REWIND_M)target=ms.routeProgress;
      const rider=card.querySelector(".map-pin.rider");
      if(rider)rider.classList.toggle("live",fresh);
      startTrackingRouteGlide(target);
    }else{
      stopTrackingRouteGlide();
      setTrackingPin(card,".map-pin.rider",ms,points.riderPoint,fresh);
    }
    trackingCameraFollow(points,live);
    const pillEl=card.querySelector(".map-status-pill");if(pillEl){pillEl.textContent=fresh?"LIVE":"STALE";pillEl.className="status-pill map-status-pill "+(fresh?"success":"warning");}
    const lastLocEl=document.getElementById("tracking-last-location");if(lastLocEl)lastLocEl.textContent=live.updatedAt?dateTime(live.updatedAt):"Not received";
    const accuracyEl=document.getElementById("tracking-accuracy");if(accuracyEl)accuracyEl.textContent=live.accuracy?Math.round(live.accuracy)+" m":"Not available";
    const sharingEl=document.getElementById("tracking-sharing-state");if(sharingEl)sharingEl.textContent=live.status||"Waiting";
    return true;
  }
  // Zooms about a point in the card's own coordinates, so a pinch or a double
  // tap keeps whatever is under the fingers pinned in place.
  function trackingZoomAround(delta,focusX,focusY){
    const ms=state.trackingMap;
    if(!ms)return false;
    const next=Math.max(TRACKING_MAP_MIN_ZOOM,Math.min(TRACKING_MAP_MAX_ZOOM,ms.zoom+Number(delta||0)));
    if(next===ms.zoom)return false;
    const size=trackingViewportSize();
    const centreX=size.width/2,centreY=size.height*(TRACKING_MAP_VERTICAL_ANCHOR_PCT/100);
    const pointX=Number.isFinite(focusX)?focusX:centreX,pointY=Number.isFinite(focusY)?focusY:centreY;
    const anchor=mapWorld(ms.anchorLat,ms.anchorLng,ms.zoom);
    const under=worldToLatLng(anchor.x+(pointX-centreX-ms.panX),anchor.y+(pointY-centreY-ms.panY),ms.zoom);
    ms.zoom=next;ms.anchorLat=under.lat;ms.anchorLng=under.lng;
    ms.panX=pointX-centreX;ms.panY=pointY-centreY;
    ms.userZoomed=true;ms.tileKey="";
    render({preserveScroll:true});
    return true;
  }
  function trackingZoomBy(delta){
    trackingZoomAround(delta);
  }
  function trackingRecenter(){
    const ms=state.trackingMap;
    if(!ms)return;
    const order=orderById(ms.orderId);
    if(!order)return;
    const points=trackingGeoPoints(order,state.tracking[ms.orderId]||{});
    const all=trackingAllPoints(points);
    if(!all.length)return;
    const fitted=fitTrackingMapView(all);
    ms.userPanned=false;ms.userZoomed=false;ms.zoom=fitted.zoom;ms.anchorLat=fitted.center.lat;ms.anchorLng=fitted.center.lng;
    ms.panX=0;ms.panY=0;ms.tileKey="";
    render({preserveScroll:true});
  }
  let trackingDrag=null,trackingPinch=null,trackingLastTap=0,trackingLastTapX=0,trackingLastTapY=0;
  const trackingPointers=Object.create(null);
  function trackingPointerList(){
    return Object.keys(trackingPointers).map(id=>trackingPointers[id]);
  }
  function trackingCardPoint(card,clientX,clientY){
    const rect=card.getBoundingClientRect();
    return {x:clientX-rect.left,y:clientY-rect.top};
  }
  function trackingMapCard(target){
    return target&&target.closest?target.closest("#tracking-map-card"):null;
  }
  function trackingMapPointerDown(event){
    if(state.route!=="tracking")return;
    const card=trackingMapCard(event.target);
    if(!card)return;
    if(event.target.closest(".map-controls")||event.target.closest(".map-overlay"))return;
    const ms=state.trackingMap;
    if(!ms)return;
    trackingPointers[event.pointerId]={x:event.clientX,y:event.clientY};
    // Capture so a finger that slides off the map still finishes its gesture.
    try{if(card.setPointerCapture)card.setPointerCapture(event.pointerId);}catch(_){}
    const active=trackingPointerList();
    if(active.length>=2){
      trackingDrag=null;
      const a=active[0],b=active[1];
      trackingPinch={startDistance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),scale:1,
        midX:(a.x+b.x)/2,midY:(a.y+b.y)/2};
      applyTrackingPinchPreview();
      return;
    }
    trackingDrag={id:event.pointerId,startX:event.clientX,startY:event.clientY,panX:ms.panX,panY:ms.panY,moved:false};
  }
  function trackingMapPointerMove(event){
    if(!(event.pointerId in trackingPointers))return;
    trackingPointers[event.pointerId]={x:event.clientX,y:event.clientY};
    const ms=state.trackingMap;
    if(!ms)return;
    const active=trackingPointerList();
    if(trackingPinch&&active.length>=2){
      const a=active[0],b=active[1],distance=Math.max(1,Math.hypot(a.x-b.x,a.y-b.y));
      trackingPinch.scale=Math.min(6,Math.max(0.2,distance/trackingPinch.startDistance));
      trackingPinch.midX=(a.x+b.x)/2;trackingPinch.midY=(a.y+b.y)/2;
      applyTrackingPinchPreview();
      if(event.cancelable)event.preventDefault();
      return;
    }
    if(!trackingDrag||event.pointerId!==trackingDrag.id)return;
    const dx=event.clientX-trackingDrag.startX,dy=event.clientY-trackingDrag.startY;
    if(!trackingDrag.moved&&Math.abs(dx)<4&&Math.abs(dy)<4)return;
    trackingDrag.moved=true;
    ms.panX=trackingDrag.panX+dx;ms.panY=trackingDrag.panY+dy;
    if(!ms.userPanned){
      ms.userPanned=true;
      const button=document.getElementById("tracking-recenter");
      if(button)button.classList.remove("hidden");
    }
    clearTimeout(ms.tileTimer);
    applyTrackingCamera(false);
    if(Math.abs(ms.panX-ms.tilePanX)>TRACKING_TILE_PX/2||Math.abs(ms.panY-ms.tilePanY)>TRACKING_TILE_PX/2)refreshTrackingTiles();
    if(event.cancelable)event.preventDefault();
  }
  function trackingMapPointerUp(event){
    const known=event&&(event.pointerId in trackingPointers);
    if(event)delete trackingPointers[event.pointerId];
    if(trackingPinch){
      if(trackingPointerList().length<2){
        const pinch=trackingPinch;
        trackingPinch=null;
        trackingDrag=null;
        commitTrackingPinch(pinch);
      }
      return;
    }
    if(!trackingDrag||(event&&event.pointerId!==trackingDrag.id))return;
    const moved=trackingDrag.moved,drag=trackingDrag;
    trackingDrag=null;
    if(moved){refreshTrackingTiles();return;}
    if(!known||!event)return;
    // A quick second tap in the same spot zooms in, like any other map.
    const card=document.getElementById("tracking-map-card");
    const now=Date.now();
    if(card&&now-trackingLastTap<320&&Math.abs(event.clientX-trackingLastTapX)<32&&Math.abs(event.clientY-trackingLastTapY)<32){
      trackingLastTap=0;
      const point=trackingCardPoint(card,event.clientX,event.clientY);
      trackingZoomAround(1,point.x,point.y);
      return;
    }
    trackingLastTap=now;trackingLastTapX=event.clientX;trackingLastTapY=event.clientY;
    void drag;
  }
  // Live feedback while the fingers are still down: scale the whole world layer
  // about the pinch midpoint. The real zoom (and correct tiles) is applied once
  // the gesture ends.
  function applyTrackingPinchPreview(){
    const world=document.getElementById("tracking-map-world"),card=document.getElementById("tracking-map-card"),ms=state.trackingMap;
    if(!world||!card||!ms||!trackingPinch)return;
    const point=trackingCardPoint(card,trackingPinch.midX,trackingPinch.midY);
    const size=trackingViewportSize();
    const originX=point.x-size.width/2-ms.panX;
    const originY=point.y-size.height*(TRACKING_MAP_VERTICAL_ANCHOR_PCT/100)-ms.panY;
    world.style.transition="none";
    world.style.transformOrigin=originX.toFixed(1)+"px "+originY.toFixed(1)+"px";
    world.style.transform='translate3d('+ms.panX.toFixed(1)+'px,'+ms.panY.toFixed(1)+'px,0) scale('+trackingPinch.scale.toFixed(3)+')';
  }
  function commitTrackingPinch(pinch){
    const world=document.getElementById("tracking-map-world"),card=document.getElementById("tracking-map-card");
    if(world)world.style.transformOrigin="";
    const ms=state.trackingMap;
    if(!ms||!card){applyTrackingCamera(false);return;}
    const steps=Math.round(Math.log(pinch.scale)/Math.LN2);
    const point=trackingCardPoint(card,pinch.midX,pinch.midY);
    // Drop the preview scale first so the map can never be left mid-pinch,
    // whatever the zoom step turns out to be.
    applyTrackingCamera(false);
    if(steps)trackingZoomAround(steps,point.x,point.y);
  }
  function screenChat(){const o=state.orders.find(x=>x.id===state.chat.orderId),messages=state.chat.messages||[];if(!o)return screenOrders();return'<main class="screen"><div class="screen-content page-stack">'+topbar(state.chat.title||"Order chat","Order "+o.id)+'<div class="notice info">'+icon("shield","small")+'<span>Real phone numbers are not displayed. Phone numbers typed in chat are automatically hidden.</span></div><section class="card chat-thread">'+(messages.length?messages.map(m=>'<div class="chat-message '+(m.senderId===state.session.uid?'mine':'')+'"><strong>'+h(m.senderRole||"user")+'</strong><p>'+h(m.body||"")+'</p><span class="caption">'+h(dateTime(m.at))+'</span></div>').join(""):emptyState("help","No messages yet","Use chat to coordinate this order."))+'</section><form id="chat-form" class="card cluster"><input class="input grow" name="message" maxlength="800" placeholder="Type a message" required><button class="button primary" type="submit">Send</button></form></div>'+nav()+'</main>'}
  function trackingPartnerCard(order,live){
    if(!order.riderId)return "";
    const name=order.riderName||live.riderName||"Delivery partner";
    const reachable=!TERMINAL_STATES.has(order.status);
    return '<section class="card cluster between tracking-partner">'
      +'<div class="cluster"><span class="avatar">'+h(String(name).slice(0,1).toUpperCase())+'</span>'
      +'<div><strong>'+h(name)+'</strong><p class="caption">Your delivery partner</p></div></div>'
      +'<div class="cluster">'
      +(order.riderPhone&&reachable?'<a class="icon-button" href="tel:'+h(order.riderPhone)+'" aria-label="Call '+h(name)+'">'+icon("phone")+'</a>':'')
      +'<button class="icon-button" data-action="open-order-chat" data-channel="customerRider" data-order-id="'+h(order.id)+'" aria-label="Chat with '+h(name)+'">'+icon("chat")+'</button>'
      +'</div></section>';
  }
  function screenTracking() {
    const order=orderById();if(!order)return screenOrder();
    const live=state.tracking[order.id]||{};
    ensureTrackingRoute(order);
    return '<main class="screen no-nav tracking-screen">'
      +trackingMapMarkup(order,live,true)
      +'<button class="back-button floating-back" data-action="back" aria-label="Go back">'+icon("back")+'</button>'
      +'<div class="tracking-sheet-scroll">'
      +networkBanner()
      +'<section class="card brand-card stack"><div class="cluster between"><span class="status-pill" style="background:rgba(255,255,255,.17);color:white">'+h(order.status)+'</span><strong>'+h(etaText(order))+'</strong></div><h1 class="page-title">'+(order.status==="Arrived"?'Your partner is at the delivery location.':order.status==="Near you"?'Your partner is nearby.':'Your meal is on the way.')+'</h1><p class="supporting">'+h(order.restaurant||order.id)+(live.riderName?' · '+h(live.riderName)+' is sharing location for this active order.':' · Tracking begins after a partner is assigned and starts delivery.')+'</p></section>'
      +trackingPartnerCard(order,live)
      +'<section class="card stack"><h2 class="section-title">Tracking health</h2><div class="price-row"><span>Last location</span><strong id="tracking-last-location">'+h(live.updatedAt?dateTime(live.updatedAt):"Not received")+'</strong></div><div class="price-row"><span>Accuracy</span><strong id="tracking-accuracy">'+h(live.accuracy?Math.round(live.accuracy)+" m":"Not available")+'</strong></div><div class="price-row"><span>Sharing state</span><strong id="tracking-sharing-state">'+h(live.status||"Waiting")+'</strong></div></section><div class="notice info">'+icon("shield","small")+'<span>Location is visible only for this active order and must be removed by the production retention service after completion.</span></div><button class="button tonal full" data-action="refresh">'+icon("refresh")+' Refresh tracking</button>'
      +'</div></main>';
  }

  function promoCard(promo) {
    const eligibility=promo.minimumOrder?"Minimum order "+money(promo.minimumOrder):"See terms before checkout";
    return '<article class="card brand-card stack"><div class="cluster between"><span class="eyebrow" style="color:#bfe9ff">'+h(promo.label||"LIVE OFFER")+'</span><span class="status-pill" style="background:rgba(255,255,255,.17);color:white">'+h(promo.code||"Offer")+'</span></div><h2 class="section-title" style="font-size:25px">'+h(promo.title||((promo.percent||0)+"% off"))+'</h2><p class="supporting">'+h(promo.description||eligibility)+'</p><button class="button" style="background:white;color:#155eef" data-action="use-promo" data-promo-id="'+h(promo.id)+'">Use '+h(promo.code||"offer")+'</button></article>';
  }
  function screenOffers() {
    return '<main class="screen"><div class="screen-content page-stack">'+networkBanner()+'<header><p class="eyebrow">Savings</p><h1 class="page-title">Offers with clear terms.</h1><p class="supporting" style="margin-top:7px">Only active promotions published by Scraveit Control appear here.</p></header>'
      +(state.promotions.length?'<section class="stack-lg">'+state.promotions.map(promoCard).join("")+'</section>':emptyState("offers","No live offers right now","We will show a promotion here only when its eligibility and discount are actually active.","go-home","Browse restaurants"))
      +'<section class="card stack"><h2 class="section-title">How offers work</h2><div class="notice info">'+icon("info","small")+'<span>Eligibility is checked again against the live promotion at checkout. Expired or restaurant-limited codes are never shown as applied.</span></div></section></div>'+nav()+'</main>';
  }

  function settingsRow(ic,title,copy,route,action,tail) {
    return '<button class="settings-row" '+(route?'data-action="go" data-route="'+h(route)+'"':'data-action="'+h(action||"")+'"')+'><span class="settings-icon">'+icon(ic)+'</span><span class="grow"><strong>'+h(title)+'</strong>'+(copy?'<span class="supporting">'+h(copy)+'</span>':'')+'</span>'+(tail||icon("chevron","small"))+'</button>';
  }
  function screenAccount() {
    return '<main class="screen"><div class="screen-content page-stack">'+networkBanner()+'<header><p class="eyebrow">Your account</p><h1 class="page-title">Details, preferences and help.</h1></header>'
      +'<section class="card brand-card cluster"><span class="avatar" style="width:58px;height:58px;background:rgba(255,255,255,.18)">'+h(initials())+'</span><div class="grow"><h2 class="section-title">'+h(state.profile.name||"Scraveit customer")+'</h2><p class="supporting">'+h(state.profile.email||state.session&&state.session.email||"")+'</p><p class="caption" style="color:rgba(255,255,255,.72)">'+h(state.profile.phone||"Add your mobile number")+'</p></div><button class="icon-button" style="background:rgba(255,255,255,.16);color:white;border:0;box-shadow:none" data-action="edit-profile" aria-label="Edit profile">'+icon("chevron")+'</button></section>'
      +'<section class="card settings-list">'+settingsRow("address","Saved addresses",(state.profile.addresses||[]).length+" saved","addresses")+settingsRow("heart","Favourite restaurants",(state.profile.favourites||[]).length+" saved","favourites")+settingsRow("card","Payment methods","Only verified payment options are shown",null,"payment-info")+'</section>'
      +'<section class="card settings-list">'+settingsRow("settings","Preferences","Theme, dietary and notifications","preferences")+settingsRow("help","Help and support","Order issues and account help","support")+settingsRow("shield","Privacy and terms","Data use, rights and service terms","legal")+'</section>'
      +'<section class="card settings-list">'+settingsRow("logout","Sign out","Remove this account from this device",null,"confirm-signout")+settingsRow("trash","Delete account request","Request permanent account and data deletion",null,"request-deletion",'<span class="danger-text">'+icon("chevron","small")+'</span>')+'</section>'
      +'<p class="caption" style="text-align:center">Scraveit Customer<br>Your account and orders sync securely across sessions.</p></div>'+nav()+'</main>';
  }

  function addressCard(address) {
    const selected=address.id===state.profile.selectedAddressId;
    return '<article class="card stack"><div class="cluster"><span class="settings-icon">'+icon(address.source==="gps"?"target":"address")+'</span><div class="grow"><div class="cluster wrap"><h2 class="card-title">'+h(address.label||"Address")+'</h2>'+(selected?'<span class="status-pill success">Selected</span>':'')+'</div><p class="supporting">'+h(address.address||address.details||"")+'</p><p class="caption">'+h(address.phone||"Mobile number missing")+(Number.isFinite(Number(address.lat))?' · GPS pin saved':' · GPS pin not saved')+'</p></div></div><div class="cluster"><button class="button secondary grow" data-action="select-address" data-address-id="'+h(address.id)+'" '+(selected?'disabled':'')+'>'+(selected?'Current delivery address':'Deliver here')+'</button><button class="icon-button" data-action="edit-address" data-address-id="'+h(address.id)+'" aria-label="Edit '+h(address.label||"address")+'">'+icon("settings")+'</button><button class="icon-button" data-action="delete-address" data-address-id="'+h(address.id)+'" aria-label="Delete '+h(address.label||"address")+'">'+icon("trash")+'</button></div></article>';
  }
  function screenAddresses() {
    const addresses=state.profile.addresses||[];
    return '<main class="screen"><div class="screen-content page-stack">'+topbar("Delivery addresses","A mobile number and location pin make delivery reliable.")+networkBanner()
      +'<button class="button primary full" data-action="detect-location" '+(state.locationBusy?'disabled':'')+'>'+(state.locationBusy?'<span class="spinner"></span> Detecting your location…':icon("target")+' Use my current location')+'</button>'
      +'<div class="notice info">'+icon("info","small")+'<span>If phone Location is off, Scraveit will ask you to turn it on. The pin is used for serviceability and delivery proximity alerts.</span></div>'
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
    return '<main class="screen"><div class="screen-content page-stack">'+topbar("Preferences","Make Scraveit comfortable and relevant for you.")+networkBanner()
      +'<section class="card stack"><h2 class="section-title">Appearance</h2><div class="segmented">'+["light","dark"].map(value=>'<button class="segment '+(themeValue()===value?'active':'')+'" data-action="theme" data-value="'+value+'">'+(value==="light"?'Light':'Dark')+'</button>').join("")+'</div><button class="button tonal full" data-action="theme" data-value="system">Use phone setting</button></section>'
      +'<section class="card settings-list">'+preferenceSwitch("vegetarian","Vegetarian mode","Prioritise vegetarian restaurants and menu items.",prefs.vegetarian===true)+preferenceSwitch("notifications","Order notifications","Show local alerts when a live order status changes.",prefs.notifications!==false)+'</section>'
      +'<section class="notice info">'+icon("info","small")+'<span>Allow notifications in phone settings to receive restaurant, rider and delivery updates even when Scraveit is closed.</span></section></div>'+nav()+'</main>';
  }

  function supportContext(){const o=state.routeData.orderId?orderById(state.routeData.orderId):activeOrders()[0]||null;if(!o)return"No active order is linked.";return"Order "+o.id+" is "+o.status+" from "+(o.restaurant||"the restaurant")+". Last updated "+timeAgo(o.updatedAt||o.createdAt)+"."}
  function adminContactMarkup(){return'<section class="card stack"><div><h2 class="section-title">Contact Scraveit Admin</h2><p class="supporting">Call or WhatsApp support on +91 9652509409.</p></div><div class="cluster wrap"><a class="button secondary grow" href="tel:+919652509409">'+icon("phone")+' Call Admin</a><a class="button success grow" href="https://wa.me/919652509409">WhatsApp Admin</a></div></section>'}
  function assistantAnswer(message){const q=String(message||"").toLowerCase(),o=state.routeData.orderId?orderById(state.routeData.orderId):activeOrders()[0]||null;if(q.includes("where")||q.includes("status")||q.includes("late")||q.includes("delay"))return o?("I checked your order. It is currently “"+o.status+"”. "+etaText(o)+" is the current estimate. If this does not solve your concern, I can send the full order context to Scraveit support."):"I do not see an active order on this account right now.";if(q.includes("cancel"))return o&&!['Handed to rider','Out for delivery','Near you','Arrived','Delivered'].includes(o.status)?"This order may still be eligible for a cancellation request. I can escalate it with the order timeline attached.":"This order is already in a later delivery stage, so cancellation needs human review.";if(q.includes("refund")||q.includes("payment"))return"I can record the payment/refund issue with the order reference and send it to support. No refund is marked complete unless a verified payment event exists.";if(q.includes("missing")||q.includes("wrong")||q.includes("item"))return"Please keep the packaging and order details. I can escalate this as an item issue with your order reference.";return"I can help with order status, delays, cancellation eligibility, missing items and payment questions. If this answer is not enough, choose ‘Still need help’ and Scraveit Admin will receive the context."}
  function screenSupport() {
    const order=state.routeData.orderId?orderById(state.routeData.orderId):null,msgs=state.supportAssistant||[];
    return '<main class="screen"><div class="screen-content page-stack">'+topbar("Scraveit Assistant",order?'About order '+order.id:'Text support first')+networkBanner()
      +'<section class="card stack"><div class="notice info">'+icon("chat","small")+'<span>Start with Scraveit Assistant. If the issue is not resolved, the conversation and order context are sent to Admin.</span></div><p class="caption">'+h(supportContext())+'</p></section>'
      +'<section class="card chat-thread">'+(msgs.length?msgs.map(m=>'<div class="chat-message '+(m.role==='you'?'mine':'')+'"><strong>'+h(m.role==='you'?'You':'Scraveit Assistant')+'</strong><p>'+h(m.body)+'</p></div>').join(""):'<div class="supporting">Ask about a delay, cancellation, missing item, payment or another order issue.</div>')+'</section>'
      +'<form id="assistant-form" class="card cluster"><input class="input grow" name="message" maxlength="800" placeholder="Type your issue" required><button class="button primary" type="submit">Send</button></form>'
      +(msgs.length?'<button class="button danger full" data-action="escalate-support">Still need help · alert Admin</button>':'')
      +adminContactMarkup()
      +'</div>'+nav()+'</main>';
  }

  function screenLegal() {
    return '<main class="screen"><div class="screen-content page-stack">'+topbar("Privacy and terms","A clear summary of how Scraveit works")+'<section class="card stack"><h2 class="section-title">Data used to provide delivery</h2><p class="supporting">Scraveit uses your account details, selected delivery address, order records, support requests and preferences to provide the service. During an active delivery, your assigned rider’s latest location may be shown for that order.</p></section><section class="card stack"><h2 class="section-title">Your controls</h2><p class="supporting">You can edit profile details, manage addresses and favourites, control notifications, sign out, or submit an account-deletion request from this app.</p></section><section class="card stack"><h2 class="section-title">Payments and refunds</h2><p class="supporting">Cash on delivery is currently available. Online payment or refund status is shown only after verification by the connected payment service.</p></section><section class="notice info">'+icon("shield","small")+'<span>Scraveit protects account access with Firebase Authentication and limits order data to the people responsible for fulfilling it.</span></section></div>'+nav()+'</main>';
  }

  function screenReview() {
    const order=orderById();if(!order)return screenOrders();
    const saved=state.reviews[order.id]||null,restaurantRating=Number(saved&&saved.rating||0),riderRating=Number(saved&&saved.riderRating||0);
    if(!saved&&!reviewStateReady())return '<main class="screen"><div class="screen-content page-stack">'+topbar("Rate your delivery",order.restaurant||order.id)+loadingRow("Checking whether feedback was already submitted…")+'</div>'+nav()+'</main>';
    return '<main class="screen"><div class="screen-content page-stack">'+topbar("Rate your delivery",order.restaurant||order.id)
      +'<form id="review-form" class="card form-grid">'
      +(saved?'<div class="notice success">'+icon("check","small")+'<span>Your feedback was submitted and is saved to this order.</span></div>':'')
      +'<fieldset style="border:0;padding:0;margin:0" '+(saved?'disabled':'')+'><legend class="section-title">Restaurant & food</legend><div class="star-row" style="margin-top:12px">'+[1,2,3,4,5].map(n=>'<label class="star-choice '+(n<=restaurantRating?'selected':'')+'"><input class="sr-only" type="radio" name="rating" value="'+n+'" '+(n===restaurantRating?'checked':'')+' required>'+icon("star","large")+'<span class="sr-only">'+n+' stars</span></label>').join("")+'</div></fieldset>'
      +(order.riderId?'<fieldset style="border:0;padding:0;margin:0" '+(saved?'disabled':'')+'><legend class="section-title">Delivery partner</legend><div class="star-row" style="margin-top:12px">'+[1,2,3,4,5].map(n=>'<label class="star-choice '+(n<=riderRating?'selected':'')+'"><input class="sr-only" type="radio" name="riderRating" value="'+n+'" '+(n===riderRating?'checked':'')+' required>'+icon("star","large")+'<span class="sr-only">'+n+' stars</span></label>').join("")+'</div></fieldset>':'')
      +'<div class="field"><label for="review-comment">Comment (optional)</label><textarea id="review-comment" class="textarea" name="comment" maxlength="500" placeholder="Food, packaging or delivery feedback" '+(saved?'readonly':'')+'>'+h(saved&&saved.comment||"")+'</textarea></div>'
      +'<button class="button primary full" type="submit" '+(saved?'disabled':'')+'>'+(saved?'Feedback already submitted':'Submit feedback')+'</button></form></div>'+nav()+'</main>';
  }

  function sheetShell(title,copy,content) {
    return '<div class="sheet-backdrop" data-action="close-sheet"><section class="sheet" data-sheet-surface role="dialog" aria-modal="true" aria-label="'+h(title)+'"><div class="sheet-handle"></div><div class="cluster between"><div><h2 class="sheet-title">'+h(title)+'</h2>'+(copy?'<p class="supporting">'+h(copy)+'</p>':'')+'</div><button class="icon-button flat" data-action="close-sheet" aria-label="Close">'+icon("close")+'</button></div><div style="margin-top:20px">'+content+'</div></section></div>';
  }
  function filterSheet() {
    return sheetShell("Filters and sorting","Choose what matters for this search.",'<div class="stack-lg"><div class="field"><label for="sort-select">Sort restaurants by</label><select id="sort-select" class="select"><option value="recommended" '+(state.sort==="recommended"?'selected':'')+'>Recommended near me</option><option value="nearby" '+(state.sort==="nearby"?'selected':'')+'>Nearest first</option><option value="rating" '+(state.sort==="rating"?'selected':'')+'>Highest rated</option><option value="delivery" '+(state.sort==="delivery"?'selected':'')+'>Fastest delivery</option><option value="fee" '+(state.sort==="fee"?'selected':'')+'>Lowest delivery fee</option></select></div><div><p class="card-title">Dietary filter</p><div class="segmented three" style="margin-top:10px"><button class="segment '+(state.diet==="all"?'active':'')+'" data-action="diet" data-value="all">All</button><button class="segment '+(state.diet==="veg"?'active':'')+'" data-action="diet" data-value="veg">Veg</button><button class="segment '+(state.diet==="nonveg"?'active':'')+'" data-action="diet" data-value="nonveg">Non-veg</button></div></div><button class="button primary full" data-action="apply-filters">Show '+restaurantsFiltered().length+' restaurants</button></div>');
  }
  function menuFilterSheet(){
    return sheetShell("Menu filters","Filter dishes by price and sort the menu.",'<div class="stack-lg"><div class="field"><label for="menu-sort-select">Sort dishes by</label><select id="menu-sort-select" class="select"><option value="recommended" '+(state.menuSort==="recommended"?'selected':'')+'>Recommended</option><option value="rating" '+(state.menuSort==="rating"?'selected':'')+'>Popular first</option><option value="priceLow" '+(state.menuSort==="priceLow"?'selected':'')+'>Price: low to high</option><option value="priceHigh" '+(state.menuSort==="priceHigh"?'selected':'')+'>Price: high to low</option></select></div><div><p class="card-title">Price</p><div class="chip-row" style="margin-top:10px"><button class="chip '+(state.menuPrice==="all"?'active':'')+'" data-action="menu-price" data-value="all">Any price</button><button class="chip '+(state.menuPrice==="under150"?'active':'')+'" data-action="menu-price" data-value="under150">Under ₹150</button><button class="chip '+(state.menuPrice==="under250"?'active':'')+'" data-action="menu-price" data-value="under250">Under ₹250</button><button class="chip '+(state.menuPrice==="above250"?'active':'')+'" data-action="menu-price" data-value="above250">Above ₹250</button></div></div><button class="button primary full" data-action="apply-menu-filters">Apply menu filters</button></div>');
  }
  function itemSheet(sheet) {
    const r=restaurant(sheet.restaurantId),item=menuItem(sheet.restaurantId,sheet.itemId);if(!r||!item)return"";
    const variants=Array.isArray(item.variants)?item.variants:[];const addons=Array.isArray(item.addOns)?item.addOns:[];
    return sheetShell(item.name,item.description||"Customise this item before adding it.",'<form id="item-form" class="form-grid" data-restaurant-id="'+h(r.id)+'" data-item-id="'+h(item.id)+'"><img src="'+h(safeUrl(item.image,r.image))+'" alt="'+h(item.name)+'" style="width:100%;height:190px;object-fit:cover;border-radius:18px"><div class="cluster between"><span class="diet-mark '+(item.diet==="nonveg"?'nonveg':'')+'"></span><strong class="section-title">'+money(item.price)+'</strong></div>'
      +(variants.length?'<fieldset class="stack" style="border:0;padding:0;margin:0"><legend class="card-title">Choose a size</legend>'+variants.map((v,i)=>'<label class="settings-row" style="border:1px solid var(--border);border-radius:14px"><input type="radio" name="variant" value="'+i+'" '+(i===0?'checked':'')+' required><span class="grow"><strong>'+h(v.name)+'</strong></span><span>'+(!v.price?'Included':'+'+money(v.price))+'</span></label>').join("")+'</fieldset>':'')
      +(addons.length?'<fieldset class="stack" style="border:0;padding:0;margin:0"><legend class="card-title">Add extras</legend>'+addons.map((a,i)=>'<label class="settings-row" style="border:1px solid var(--border);border-radius:14px"><input type="checkbox" name="addon" value="'+i+'"><span class="grow"><strong>'+h(a.name)+'</strong></span><span>'+(!a.price?'No charge':'+'+money(a.price))+'</span></label>').join("")+'</fieldset>':'')
      +'<div class="field"><label for="item-note">Kitchen note (optional)</label><textarea class="textarea" id="item-note" name="note" maxlength="140" placeholder="Allergy note or preparation request"></textarea><p class="caption">Allergy requests cannot guarantee an allergen-free kitchen.</p></div><button class="button primary full sheet-submit" type="submit">Add to cart · '+money(item.price)+'</button></form>');
  }
  function replaceCartSheet(sheet) {
    const current=cartRestaurant(),next=restaurant(sheet.restaurantId);
    return sheetShell("Start a new cart?","A delivery order can contain items from only one restaurant.",'<div class="stack-lg"><div class="notice warning">'+icon("warning","small")+'<span>Your '+h(current&&current.name||"current")+' items will be removed before adding '+h(next&&next.name||"the new item")+'.</span></div><button class="button danger full" data-action="confirm-replace-cart">Clear cart and continue</button><button class="button tonal full" data-action="close-sheet">Keep current cart</button></div>');
  }
  function addressFormSheet(sheet) {
    const address=sheet.address||{},point=state.addressMapDraft||{};
    return sheetShell(address.id?"Edit address":"Add address","Place the delivery pin, then add the door/flat details a rider needs.",'<form id="address-form" class="form-grid"><input type="hidden" name="id" value="'+h(address.id||"")+'"><input type="hidden" name="lat" value="'+h(point.lat==null?"":point.lat)+'"><input type="hidden" name="lng" value="'+h(point.lng==null?"":point.lng)+'">'+addressMapMarkup()+'<div class="field"><label for="address-label">Address label</label><input id="address-label" class="input" name="label" value="'+h(address.label||"")+'" placeholder="Home, Work or Other" required></div><div class="field"><label for="address-area">Area</label><input id="address-area" class="input" name="area" value="'+h(address.area||"")+'" placeholder="Neighbourhood or locality" required></div><div class="field"><label for="address-city">City</label><input id="address-city" class="input" name="city" value="'+h(address.city||"")+'" placeholder="Nellore" required></div><div class="field"><label for="address-full">Full delivery address</label><textarea id="address-full" class="textarea" name="address" placeholder="Flat, building, street, landmark and city" required>'+h(address.address||address.details||"")+'</textarea></div><div class="field"><label for="address-phone">Mobile number</label><input id="address-phone" class="input" name="phone" type="tel" inputmode="tel" value="'+h(address.phone||state.profile.phone||"")+'" placeholder="10-digit mobile number" required></div><div class="notice success">'+icon("check","small")+'<span>A map pin will be saved with this address.</span></div><button class="button primary full" type="submit">Save delivery address</button></form>');
  }
  function deleteAddressSheet(sheet){
    const address=(state.profile.addresses||[]).find(value=>value.id===sheet.addressId);
    if(!address)return"";
    return sheetShell("Delete "+(address.label||"address")+"?","This removes the saved address from your Scraveit account.",'<div class="stack-lg"><div class="notice warning">'+icon("warning","small")+'<div><strong>'+h(address.label||"Saved address")+'</strong><div class="caption">'+h(address.address||address.details||"")+'</div></div></div><button class="button danger full" data-action="confirm-delete-address" data-address-id="'+h(address.id)+'">Delete address</button><button class="button tonal full" data-action="close-sheet">Keep address</button></div>');
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
    return sheetShell("Sign out of Scraveit?","Cached account details will be removed from this device.",'<div class="stack"><button class="button danger full" data-action="signout">Sign out</button><button class="button tonal full" data-action="close-sheet">Stay signed in</button></div>');
  }
  function paymentInfoSheet() {
    return sheetShell("Payment methods","Only verified payment options are shown as available.",'<div class="stack"><div class="notice success">'+icon("receipt","small")+'<div><strong>Cash on delivery</strong><div class="caption">Available for eligible orders.</div></div></div><div class="notice info">'+icon("card","small")+'<div><strong>UPI</strong><div class="caption">'+h(paymentMethodCopy("upi"))+'</div></div></div><div class="notice info">'+icon("card","small")+'<div><strong>Cards</strong><div class="caption">'+h(paymentMethodCopy("card"))+'</div></div></div><button class="button primary full" data-action="close-sheet">Done</button></div>');
  }
  function renderSheet() {
    if(!state.sheet){sheetRegion.innerHTML="";return;}
    const sheet=state.sheet;let html="";
    if(sheet.type==="filters")html=filterSheet();
    else if(sheet.type==="menuFilters")html=menuFilterSheet();
    else if(sheet.type==="item")html=itemSheet(sheet);
    else if(sheet.type==="replaceCart")html=replaceCartSheet(sheet);
    else if(sheet.type==="address")html=addressFormSheet(sheet);
    else if(sheet.type==="deleteAddress")html=deleteAddressSheet(sheet);
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
    if(deliveryOtp)state.deliveryOtps[orderId]=deliveryOtp;
    state.cart=[];state.coupon=null;state.tip=0;state.dynamicPricing={rainFee:0,surgeFee:0,riderIncentiveFee:0,weatherSeverity:"",weatherChecked:false,activeOrders:0,checkedAt:0};state.checkout.pendingOrderId="";state.checkout.pendingIdempotencyKey="";state.loading=false;persistCart();persistCheckout();state.selectedOrderId=orderId;
    toast(recovered?"Your existing order was restored safely.":"Order placed successfully.","success");go("order",{orderId:orderId});
  }

  function orderIdempotencyKey(){
    const existing=String(state.checkout.pendingIdempotencyKey||"");
    if(/^[A-Za-z0-9_-]{16,80}$/.test(existing))return existing;
    const generated=("cust_"+Date.now().toString(36)+"_"+uid("").replace(/[^A-Za-z0-9_-]/g,"")).slice(0,80);
    state.checkout.pendingIdempotencyKey=generated;persistCheckout();return generated;
  }

  function callableCartItems(){
    return state.cart.map(item=>{
      const line={
        itemId:String(item.itemId||""),quantity:Math.max(1,Math.floor(Number(item.quantity||1))),
        addOnIds:Array.isArray(item.addOnIds)?item.addOnIds.map(String):(item.addOns||[]).map(x=>String(x.id||x.name||"")).filter(Boolean),
        note:String(item.note||"").slice(0,200)
      };
      const variantId=String(item.variantId||item.variant||"").trim();if(variantId)line.variantId=variantId;
      return line;
    });
  }

  async function startOnlinePayment(order){
    if(!order||!isOnlinePaymentMethod(order.paymentMethod)){toast("This order does not need an online payment step.","danger");return;}
    const paymentOperation=paymentIntentOperation();
    if(!paymentOperation||!nativeAvailable("openExternalPayment")){toast("Online payment is not available in this build.","danger");return;}
    state.loading=true;render({preserveScroll:true});
    try{
      await ensureSession();
      const intent=await nativeInvoke(paymentOperation,{
        customerId:String(state.session.uid||""),
        orderId:String(order.id||""),
        provider:String(order.paymentProvider||"phonepe")
      },{idToken:state.session.idToken,timeoutMs:30000});
      const redirectUrl=String(intent&&intent.redirectUrl||"").trim();
      if(!redirectUrl)throw new Error("PAYMENT_INTENT_INVALID");
      await nativeInvoke("openExternalPayment",{url:redirectUrl},{timeoutMs:10000});
      toast(order.paymentState==="failed"?"Payment retry opened. Complete it in your payment app.":"Payment app opened. Complete the payment to continue your order.","success");
    }catch(error){
      toast((order.paymentState==="failed"?"Payment retry could not start. ":"Payment could not start. ")+friendlyError(error),"danger");
    }finally{
      state.loading=false;render({preserveScroll:true});
    }
  }

  async function submitOrder() {
    if(state.loading||!state.cart.length)return;
    const address=currentAddress(),r=cartRestaurant();
    if(!address){toast("Choose a delivery address first.","danger");go("addresses");return;}
    if(!validPhone(address.phone||state.profile.phone)){toast("Add a reachable mobile number to the delivery address.","danger");go("addresses");return;}
    if(!Number.isFinite(Number(address.lat))||!Number.isFinite(Number(address.lng))){toast("Use your current location to attach a delivery pin before checkout.","danger");go("addresses");return;}
    if(!state.online){toast("Reconnect to place this order safely.","danger");return;}
    if(!r||!r.open){toast("This restaurant is not accepting orders right now.","danger");return;}
    if(!paymentMethodEnabled(state.checkout.payment)){toast("This payment method is not available right now. Choose another option.","danger");reconcileCheckoutPaymentSelection();render({preserveScroll:true});return;}
    state.checkout.instructions=(document.getElementById("checkout-instructions")||{}).value||state.checkout.instructions;
    state.loading=true;render({preserveScroll:true});
    await refreshDynamicPricing();
    const idempotencyKey=orderIdempotencyKey();
    const requestPayload={
      idempotencyKey:idempotencyKey,restaurantId:r.id,addressId:address.id,items:callableCartItems(),
      couponCode:String(eligibleCoupon()&&state.coupon.code||"").trim().toUpperCase(),tip:Number(state.tip||0),
      deliveryMode:"asap",instructions:String(state.checkout.instructions||"").slice(0,500),contactless:state.checkout.contactless===true,
      paymentMethod:String(state.checkout.payment||"cod"),
      ...(isOnlinePaymentMethod(state.checkout.payment)?{paymentProvider:paymentMethodProvider(state.checkout.payment)}:{})
    };
    try{
      await ensureSession();
      if(nativeAvailable("createOrder")){
        const result=await nativeInvoke("createOrder",requestPayload,{idToken:state.session.idToken,timeoutMs:38000});
        if(!result||!result.order||!result.orderId||result.order.id!==result.orderId)throw new Error("INVALID_SERVER_RESPONSE");
        finishOrderPlacement(result.order,String(result.orderId),String(result.deliveryOtp||""),result.recovered===true);
        if(isOnlinePaymentMethod(result.order.paymentMethod||state.checkout.payment)){
          await startOnlinePayment(result.order);
        }
        return;
      }
      if(state.checkout.payment==="cod"&&nativeAvailable("createCodOrder")){
        const result=await nativeInvoke("createCodOrder",requestPayload,{idToken:state.session.idToken,timeoutMs:38000});
        if(!result||!result.order||!result.orderId||result.order.id!==result.orderId)throw new Error("INVALID_SERVER_RESPONSE");
        finishOrderPlacement(result.order,String(result.orderId),String(result.deliveryOtp||""),result.recovered===true);return;
      }
      if(LEGACY_ORDER_WRITE_COMPATIBILITY===true){await submitLegacyCodOrder(address,r,idempotencyKey);return;}
      throw new Error("ORDER_SERVICE_UNAVAILABLE");
    }catch(error){
      toast("Order was not placed. "+friendlyError(error)+" Retrying uses the same protected request and will not duplicate an order.","danger");
    }finally{state.loading=false;render({preserveScroll:true});}
  }

  async function submitLegacyCodOrder(address,r,idempotencyKey){
    if(LEGACY_ORDER_WRITE_COMPATIBILITY!==true)throw new Error("ORDER_SERVICE_UNAVAILABLE");
    const now=Date.now(),orderId=state.checkout.pendingOrderId||("SV-"+uid("").replace(/-/g,"").slice(0,12).toUpperCase());state.checkout.pendingOrderId=orderId;persistCheckout();
    try{const existing=await db("GET",DB_ROOT+"/orders/"+encodeURIComponent(state.session.uid)+"/"+encodeURIComponent(orderId));if(existing){finishOrderPlacement(existing,orderId,state.deliveryOtps[orderId]||"",true);return;}}catch(_){}
    const deliveryOtp=state.deliveryOtps[orderId]||String(Math.floor(1000+Math.random()*9000)),deliveryOtpSalt=uid("salt_").replace(/-/g,"").slice(0,24),deliveryOtpHash=await sha256(deliveryOtp+deliveryOtpSalt);
    state.deliveryOtps[orderId]=deliveryOtp;
    const eventId="e_"+now+"_customer";
    const order={
      id:orderId,schemaVersion:3,idempotencyKey:idempotencyKey,customerId:state.session.uid,customerName:state.profile.name||"Scraveit customer",
      customerPhone:address.phone||state.profile.phone,restaurantId:r.id,restaurant:r.name,
      restaurantLocation:{address:r.address||"",lat:Number.isFinite(Number(r.lat))?Number(r.lat):null,lng:Number.isFinite(Number(r.lng))?Number(r.lng):null},
      items:state.cart.map(item=>({itemId:item.itemId,name:item.name,quantity:item.quantity,price:item.price,variant:item.variant||"",variantPrice:item.variantPrice||0,addOns:item.addOns||[],addOnTotal:item.addOnTotal||0,note:item.note||"",diet:item.diet||""})),
      pricing:{subtotal:cartSubtotal(),discount:discount(),deliveryFee:deliveryFee(),smallOrderFee:smallOrderFee(),lateNightFee:lateNightFee(),rainFee:rainFee(),surgeFee:surgeFee(),riderIncentiveFee:riderIncentiveFee(),platformFee:platformFee(),tax:tax(),tip:Number(state.tip||0),currency:"INR",source:"catalog_snapshot_v3"},
      pricingContext:{distanceKm:Number((restaurantDistanceKm(r)||0).toFixed(2)),platformFeeRule:platformFeeDetails().rule,weatherSeverity:state.dynamicPricing.weatherSeverity||"",surgeActiveOrders:Number(state.dynamicPricing.activeOrders||0),pricedAt:Date.now()},
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
      throw error;
    }
  }

  function optionIdentity(value){return keyName(value&&typeof value==="object"?(value.id||value.name):value)}
  function currentOption(options,id,name){
    const values=Array.isArray(options)?options:[],wantedId=optionIdentity(id),wantedName=optionIdentity(name);
    return values.find(option=>(wantedId&&optionIdentity(option&&option.id)===wantedId)||(wantedName&&optionIdentity(option&&option.name)===wantedName))||null;
  }
  function reconcileReorderItems(order,r){
    const next=[],skipped=[];
    for(const old of order.items||[]){
      const current=(r.menu||[]).find(item=>String(item.id)===String(old.itemId)&&item.available!==false&&item.archived!==true);
      if(!current){skipped.push({item:old,reason:"unavailable"});continue;}
      const variants=Array.isArray(current.variants)?current.variants:[],oldVariantId=old.variantId||"",oldVariantName=old.variant||"";
      let variant=null;
      if(oldVariantId||oldVariantName){
        variant=currentOption(variants,oldVariantId,oldVariantName);
        if(!variant){skipped.push({item:old,reason:"variant"});continue;}
      }else if(variants.length){
        variant=variants.find(value=>value&&value.isDefault===true)||null;
        if(!variant){skipped.push({item:old,reason:"variant"});continue;}
      }
      const requestedAddOns=Array.isArray(old.addOnIds)&&old.addOnIds.length
        ?old.addOnIds.map(id=>({id:id,name:""}))
        :(Array.isArray(old.addOns)?old.addOns:[]).map(value=>typeof value==="object"?value:{id:value,name:value});
      const addOns=requestedAddOns.map(value=>currentOption(current.addOns,value.id,value.name)).filter(Boolean);
      if(addOns.length!==requestedAddOns.length){skipped.push({item:old,reason:"addon"});continue;}
      const variantId=variant&&String(variant.id||variant.name)||"",variantName=variant&&String(variant.name||variant.id)||"";
      const addOnIds=addOns.map(value=>String(value.id||value.name||"")).filter(Boolean);
      const key=r.id+"::"+current.id+"::"+variantId+"::"+addOnIds.slice().sort().join("|");
      next.push({
        key:key,restaurantId:r.id,restaurantName:r.name,itemId:current.id,name:current.name,price:Number(current.price||0),image:safeUrl(current.image,r.image),diet:current.diet||"veg",quantity:Math.max(1,Math.floor(Number(old.quantity||1))),
        variant:variantName,variantId:variantId,variantPrice:Number(variant&&(variant.priceDelta!=null?variant.priceDelta:variant.price)||0),addOns:addOns,addOnIds:addOnIds,
        addOnTotal:addOns.reduce((sum,value)=>sum+Number(value.priceDelta!=null?value.priceDelta:value.price||0),0),note:String(old.note||"").slice(0,140)
      });
    }
    return {items:next,skipped:skipped};
  }
  async function reorder(order) {
    if(state.loading)return;
    if(!state.online){toast("Reconnect to refresh the menu before reordering.","danger");return;}
    if(!currentAddress()){toast("Choose a delivery address before reordering.","danger");go("addresses");return;}
    state.loading=true;render({preserveScroll:true});
    try{
      // Reorder never trusts the historical price/customization snapshot as a
      // current cart. Refresh discovery and the selected restaurant's menu,
      // then rebuild each line from the latest catalogue identifiers/prices.
      await syncCatalog();
      let r=restaurant(order.restaurantId);
      if(!r||r.archived===true)throw Object.assign(new Error("NOT_FOUND"),{code:"NOT_FOUND"});
      if(r.open===false||r.acceptingOrders===false){toast("This restaurant is not accepting orders right now.","danger");return;}
      if(!restaurantServiceable(r)){toast("This restaurant does not deliver to your selected address.","danger");return;}
      await ensureRestaurantMenu(r.id,{force:true,throwOnError:true});
      r=restaurant(order.restaurantId);
      const reconciled=reconcileReorderItems(order,r);
      if(!reconciled.items.length){toast("Those items or customisations are not currently available.","danger");return;}
      state.cart=reconciled.items;state.coupon=null;state.tip=0;persistCart();
      toast(reconciled.skipped.length?"Available items were added at current prices. Some changed items were skipped.":"Order added at current menu prices.","success");
      go("cart");
    }catch(error){toast("Reorder could not be refreshed. "+friendlyError(error),"danger");}
    finally{state.loading=false;if(state.route!=="cart")render({preserveScroll:true});}
  }

  Object.assign(SCREENS, {
    launch:screenLaunch, welcome:screenWelcome, login:screenLogin, signup:screenSignup, verifyEmail:screenVerifyEmail, home:screenHome, search:screenSearch,
    restaurant:screenRestaurant, cart:screenCart, checkout:screenCheckout, orders:screenOrders,
    order:screenOrder, chat:screenChat, tracking:screenTracking, offers:screenOffers, account:screenAccount,
    addresses:screenAddresses, favourites:screenFavourites, preferences:screenPreferences,
    support:screenSupport, legal:screenLegal, review:screenReview
  });

  async function refreshAll() {
    if(!state.session||state.loading)return;state.loading=true;render({preserveScroll:true});
    try{await Promise.all([syncOrders(true),syncCatalog(),syncProfile(true),syncSecondaryHomeData()]);state.lastSync=Date.now();state.syncError="";toast("Scraveit is up to date.","success");}
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
    const node=document.getElementById("search-results");if(node)node.innerHTML=searchContentMarkup();
  }
  function scheduleSearchUpdate() {
    clearTimeout(state.searchDebounceTimer);
    state.searchDebounceTimer=setTimeout(()=>{state.searchDebounceTimer=null;updateSearchResults();},180);
  }
  function applyRecentSearch(value) {
    const next=String(value||"").trim().replace(/\s+/g," ").slice(0,80);
    if(!next)return;
    clearTimeout(state.searchDebounceTimer);state.searchDebounceTimer=null;state.query=next;recordRecentSearch(next);
    const input=document.getElementById("search-input");if(input)input.value=next;
    updateSearchResults();
  }

  async function handleActionClick(event){
    const control=event.target.closest("[data-action]");if(!control)return;
    const action=control.dataset.action;
    if(action==="close-sheet"){
      if(control.classList.contains("sheet-backdrop")&&event.target.closest("[data-sheet-surface]"))return;
      closeSheet();return;
    }
    if(action==="go"){const data={};if(control.dataset.orderId)data.orderId=control.dataset.orderId;go(control.dataset.route,data);if(control.dataset.route==="cart"&&state.cart.length){refreshDynamicPricing().then(()=>{if(state.route==="cart")render({preserveScroll:true})}).catch(()=>{});}return;}
    if(action==="open-ad"){const ad=(state.localAds||[]).find(x=>x.id===control.dataset.adId);if(ad&&ad.restaurantId){go("restaurant",{restaurantId:ad.restaurantId});}else if(ad&&ad.deepLink==="offers")go("offers");else go("search");return;}
    if(action==="quick-rate"){go("review",{orderId:control.dataset.orderId});return;}
    if(action==="escalate-support"){escalateSupport();return;}
    if(action==="back"){goBack();return;}
    if(action==="tracking-zoom"){trackingZoomBy(Number(control.dataset.delta||0));return;}
    if(action==="tracking-recenter"){trackingRecenter();return;}
    if(action==="welcome-signup"){localStorage.setItem("savrivo.customer.seenWelcome","1");go("signup");return;}
    if(action==="welcome-login"){localStorage.setItem("savrivo.customer.seenWelcome","1");go("login");return;}
    if(action==="google-signin"){openGoogleSignIn();return;}
    if(action==="forgot-password"){setSheet({type:"forgot"});return;}
    if(action==="check-verification"){
      state.loading=true;render({preserveScroll:true});
      try{await ensureSession();if(await syncEmailVerification()){toast("Email verified. Welcome to Scraveit.","success");go("home",{},true);}else toast("Verification is not complete yet. Open the newest email and try again.","danger");}
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
    if(action==="open-restaurant"){const restaurantId=control.dataset.restaurantId;if(state.route==="search")recordRecentSearch(state.query);state.selectedMenuCategory="All";state.menuPrice="all";state.menuSort="recommended";state.diet="all";go("restaurant",{restaurantId});ensureRestaurantMenu(restaurantId);return;}
    if(action==="retry-menu"){ensureRestaurantMenu(state.selectedRestaurantId);return;}
    if(action==="toggle-favourite"){event.preventDefault();event.stopPropagation();toggleFavourite(control.dataset.restaurantId);return;}
    if(action==="cuisine"){state.cuisine=control.dataset.value||"All";if(state.route==="home")render({preserveScroll:true});else{document.querySelectorAll('[data-action="cuisine"]').forEach(x=>x.classList.toggle("active",x.dataset.value===state.cuisine));updateSearchResults();}return;}
    if(action==="clear-search"){clearTimeout(state.searchDebounceTimer);state.searchDebounceTimer=null;state.query="";const input=document.getElementById("search-input");if(input){input.value="";input.focus();}updateSearchResults();return;}
    if(action==="recent-search"){applyRecentSearch(control.dataset.value);return;}
    if(action==="clear-search-history"){clearRecentSearches();updateSearchResults();return;}
    if(action==="open-filters"){setSheet({type:"filters"});return;}
    if(action==="home-filter"){const value=control.dataset.value||"all";state.homeFilter=state.homeFilter===value?"all":value;render({preserveScroll:true});return;}
    if(action==="toggle-rating-view"){state.ratingView=state.ratingView==="overall"?"mine":"overall";saveJSON("savrivo.customer.ratingView",state.ratingView);render({preserveScroll:true});return;}
    if(action==="diet"){state.diet=control.dataset.value;renderSheet();return;}
    if(action==="apply-filters"){const select=document.getElementById("sort-select");if(select)state.sort=select.value;closeSheet();render({preserveScroll:true});return;}
    if(action==="toggle-veg"){state.diet=state.diet==="veg"?"all":"veg";render({preserveScroll:true});return;}
    if(action==="menu-diet"){state.diet=control.dataset.value||"all";render({preserveScroll:true});return;}
    if(action==="open-menu-filters"){setSheet({type:"menuFilters"});return;}
    if(action==="menu-price"){state.menuPrice=control.dataset.value||"all";renderSheet();return;}
    if(action==="apply-menu-filters"){const select=document.getElementById("menu-sort-select");if(select)state.menuSort=select.value;closeSheet();render({preserveScroll:true});return;}
    if(action==="menu-category"){state.selectedMenuCategory=control.dataset.value||"All";render({preserveScroll:true});return;}
    if(action==="clear-menu-filter"){state.diet="all";state.menuPrice="all";state.menuSort="recommended";state.selectedMenuCategory="All";render({preserveScroll:true});return;}
    if(action==="open-item"){setSheet({type:"item",restaurantId:control.dataset.restaurantId,itemId:control.dataset.itemId});return;}
    if(action==="confirm-replace-cart"){const pending=state.sheet;state.cart=[];persistCart();addCartItem(pending.restaurantId,pending.itemId,pending.custom||{});return;}
    if(action==="clear-unavailable-cart"){state.cart=[];state.coupon=null;state.tip=0;persistCart();toast("Unavailable cart removed.","success");go("home");return;}
    if(action==="cart-quantity"){updateCart(control.dataset.key,Number(control.dataset.delta||0));return;}
    if(action==="go-checkout"){if(!state.cart.length)return;go("checkout");refreshDynamicPricing().then(()=>{if(state.route==="checkout")render({preserveScroll:true})}).catch(()=>{});return;}
    if(action==="apply-coupon"){
      const code=String((document.getElementById("coupon-input")||{}).value||"").trim().toUpperCase();const promo=state.promotions.find(p=>String(p.code||"").toUpperCase()===code&&p.active===true);
      if(!promo){state.coupon=null;toast("That code is not an active Scraveit offer.","danger");render({preserveScroll:true});return;}
      if(promo.expiresAt&&Date.now()>Number(promo.expiresAt)){toast("That offer has expired.","danger");return;}
      if(promo.minimumOrder&&cartSubtotal()<Number(promo.minimumOrder)){toast("This offer needs a minimum item total of "+money(promo.minimumOrder)+".","danger");return;}
      if(Array.isArray(promo.restaurantIds)&&!promo.restaurantIds.includes(state.cart[0].restaurantId)){toast("That offer is not eligible for this restaurant.","danger");return;}
      state.coupon=promo;toast("Offer applied.","success");render({preserveScroll:true});return;
    }
    if(action==="set-tip"){
      state.tip=Math.max(0,Math.min(1000,Number(control.dataset.value||0)));
      render({preserveScroll:true});
      return;
    }
    if(action==="apply-custom-tip"){
      const input=document.getElementById("custom-tip");
      const value=Math.max(0,Math.min(1000,Number(input&&input.value||0)));
      state.tip=Number.isFinite(value)?value:0;
      render({preserveScroll:true});
      return;
    }
    if(action==="delivery-mode"){if(control.dataset.value==="scheduled"){toast("Scheduling activates with the production dispatch backend.");return;}state.checkout.deliveryMode="asap";render({preserveScroll:true});return;}
    if(action==="toggle-contactless"){state.checkout.contactless=!state.checkout.contactless;render({preserveScroll:true});return;}
    if(action==="select-payment"){const value=String(control.dataset.value||"cod");if(!paymentMethodEnabled(value)){toast(paymentMethodCopy(value),"warning");return;}state.checkout.payment=value;render({preserveScroll:true});return;}
    if(action==="place-order"){submitOrder();return;}
    if(action==="open-order"){go("order",{orderId:control.dataset.orderId});return;}if(action==="open-order-chat"){const o=state.orders.find(x=>x.id===control.dataset.orderId);if(o)openOrderChat(o,control.dataset.channel,control.dataset.channel==="customerRider"?"Chat with delivery partner":"Chat with restaurant");return;}
    if(action==="pay-order"){const o=orderById(control.dataset.orderId);if(o)startOnlinePayment(o);return;}
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
    if(action==="add-address"){openAddressSheet({});return;}
    if(action==="edit-address"){const address=(state.profile.addresses||[]).find(x=>x.id===control.dataset.addressId);if(address)openAddressSheet(clone(address));return;}
    if(action==="delete-address"){const address=(state.profile.addresses||[]).find(x=>x.id===control.dataset.addressId);if(address)setSheet({type:"deleteAddress",addressId:address.id});return;}
    if(action==="confirm-delete-address"){await deleteAddress(control.dataset.addressId);return;}
    if(action==="detect-address-location"){requestLocation("address");return;}
    if(action==="address-map-zoom"){state.addressMapZoom=Math.max(12,Math.min(18,state.addressMapZoom+Number(control.dataset.delta||0)));renderSheet();return;}
    if(action==="address-map-pick"){const rect=control.getBoundingClientRect(),point=state.addressMapDraft||addressMapSeed(null),world=mapWorld(point.lat,point.lng,state.addressMapZoom),next=worldToLatLng(world.x+(event.clientX-rect.left-rect.width/2),world.y+(event.clientY-rect.top-rect.height/2),state.addressMapZoom);state.addressMapDraft=next;if(state.sheet&&state.sheet.address){state.sheet.address.lat=next.lat;state.sheet.address.lng=next.lng;}renderSheet();return;}
    if(action==="select-address"){selectAddress(control.dataset.addressId);return;}
    if(action==="toggle-preference"){
      const key=control.dataset.key;state.profile.preferences[key]=!state.profile.preferences[key];persistProfile();applyTheme();render({preserveScroll:true});
      if(key==="notifications"){
        if(state.profile.preferences.notifications===false)unregisterPushTokenBestEffort();
        else registerPushTokenIfAllowed().catch(()=>toast("Notifications could not be enabled yet.","danger"));
      }
      try{await saveProfile();}catch(_){toast("Preference saved on this device.");}return;
    }
    if(action==="theme"){state.profile.preferences.theme=control.dataset.value;persistProfile();applyTheme();render({preserveScroll:true});try{await saveProfile();}catch(_){}return;}
  }
  app.addEventListener("click",handleActionClick);
  sheetRegion.addEventListener("click",handleActionClick);
  // Bound to #app rather than the map itself: every render replaces the map's
  // DOM, but #app survives, so these stay attached for the life of the session.
  // Safety net for the live map. The realtime stream is the primary source, but
  // a WebView loses long-lived connections on network handovers and app
  // switches, which strands the map on a stale position. If no frame has
  // arrived recently while the tracking screen is open, re-read the record
  // directly. Costs one small request every few seconds, and only then.
  async function pollTrackingFallback(){
    if(state.route!=="tracking"||!state.session||!state.online)return;
    const orderId=state.selectedOrderId;
    if(!orderId)return;
    if(Date.now()-Number(state.trackingSeenAt[orderId]||0)<TRACKING_STREAM_GRACE_MS)return;
    try{
      const value=await db("GET",DB_ROOT+"/tracking/"+encodeURIComponent(orderId));
      applyTrackingEvent(orderId,{path:"/",data:value===undefined?null:value},"put");
    }catch(_){}
  }
  setInterval(pollTrackingFallback,TRACKING_POLL_MS);
  document.addEventListener("visibilitychange",function(){
    if(document.visibilityState==="visible"&&state.route==="tracking")pollTrackingFallback();
  });
  app.addEventListener("pointerdown",trackingMapPointerDown);
  document.addEventListener("pointermove",trackingMapPointerMove,{passive:false});
  document.addEventListener("pointerup",trackingMapPointerUp);
  document.addEventListener("pointercancel",trackingMapPointerUp);

  app.addEventListener("input",function(event){
    if(event.target.id==="search-input"){state.query=event.target.value;scheduleSearchUpdate();}
    if(event.target.id==="checkout-instructions")state.checkout.instructions=event.target.value;
  });
  app.addEventListener("change",function(event){
    const input=event.target;
    if(!input||!input.matches||!input.matches('#review-form input[type="radio"]'))return;
    const value=Number(input.value),row=input.closest('.star-row');
    if(!row)return;
    row.querySelectorAll('.star-choice').forEach(label=>{
      const radio=label.querySelector('input[type="radio"]'),selected=radio&&Number(radio.value)<=value;
      label.classList.toggle('selected',!!selected);
    });
  });
  app.addEventListener("keydown",function(event){
    if(event.target.id==="search-input"&&event.key==="Enter"){
      event.preventDefault();clearTimeout(state.searchDebounceTimer);state.searchDebounceTimer=null;state.query=event.target.value;recordRecentSearch(state.query);updateSearchResults();return;
    }
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
      toast("Account created successfully.","success");await afterAuth();
    }catch(error){toast(friendlyError(error),"danger");state.loading=false;render({preserveScroll:true});}
  }

  async function submitReset(form) {
    const email=form.elements["email"].value.trim().toLowerCase();if(!validEmail(email)){toast("Enter the email used for your Scraveit account.","danger");return;}
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
    const existingId=String(values.get("id")||""),fullAddress=String(values.get("address")||"").trim(),city=String(values.get("city")||"").trim(),area=String(values.get("area")||"").trim(),record={id:existingId||uid("addr_"),label:String(values.get("label")||"").trim(),area,city,address:fullAddress,formattedAddress:fullAddress,serviceAreaId:"area-"+searchKey(city||area),phone:phone,source:existingId==="current-location"?"gps":"manual",updatedAt:Date.now()};
    const lat=Number(values.get("lat")),lng=Number(values.get("lng"));if(Number.isFinite(lat)&&Number.isFinite(lng)&&String(values.get("lat"))!==""){record.lat=lat;record.lng=lng;}
    if(!record.label||!record.area||!record.city||!record.address){toast("Complete the label, area, city and full address.","danger");return;}
    record.needsLocationPin=!(Number.isFinite(Number(record.lat))&&Number.isFinite(Number(record.lng)));
    const list=state.profile.addresses||[],index=list.findIndex(x=>x.id===record.id);if(index>=0)list[index]=record;else list.push(record);state.profile.addresses=list;state.profile.selectedAddressId=record.id;if(!state.profile.phone)state.profile.phone=phone;migrateSavedAddresses();persistProfile();state.addressMapDraft=null;closeSheet();
    if(!restoreHomeCache(true)){state.catalog={};state.catalogLoaded=false;state.catalogMode="loading";state.homeStatus="initial"}render({preserveScroll:true});
    try{await Promise.all([saveProfile(),state.online?syncCatalog():Promise.resolve()]);toast("Delivery address saved.","success");}catch(_){toast("Address saved on this device; cloud sync will retry.");}
    if(state.online)startRealtime().catch(()=>{});
  }
  async function submitProfile(form) {
    const name=form.elements["name"].value.trim(),phone=form.elements["phone"].value.trim();if(name.length<2||!validPhone(phone)){toast("Enter your full name and a valid mobile number.","danger");return;}
    state.profile.name=name;state.profile.phone=phone;persistProfile();closeSheet();render({preserveScroll:true});try{await saveProfile();toast("Profile updated.","success");}catch(_){toast("Profile saved on this device; cloud sync will retry.");}
  }
  function submitAssistant(form){const message=String(new FormData(form).get("message")||"").trim();if(!message)return;state.supportAssistant=state.supportAssistant||[];state.supportAssistant.push({role:"you",body:message,at:Date.now()});state.supportAssistant.push({role:"assistant",body:assistantAnswer(message),at:Date.now()+1});form.reset();render({preserveScroll:true})}
  async function escalateSupport(){const transcript=(state.supportAssistant||[]).map(m=>(m.role==='you'?'Customer: ':'Assistant: ')+m.body).join("\n"),o=state.routeData.orderId?orderById(state.routeData.orderId):activeOrders()[0]||null,id=uid("ticket_"),rawMessage=(state.supportAssistant||[]).filter(x=>x.role==='you').map(x=>x.body).join(" | ").slice(0,4000),ticket={id,uid:state.session.uid,customerName:state.profile.name||"",email:state.profile.email||"",orderId:o&&o.id||"",topic:"AI escalation",message:rawMessage.length>=10?rawMessage:"Customer wrote: "+(rawMessage||"needs help"),aiSummary:(supportContext()+" Customer used Scraveit Assistant and requested human help.").slice(0,1000),assistantTranscript:transcript.slice(0,4000),priority:o&&["Arrived","Near you"].includes(o.status)?"high":"normal",seenAt:0,status:"open",createdAt:Date.now(),updatedAt:Date.now()};try{await db("PUT",DB_ROOT+"/support/"+state.session.uid+"/"+id,ticket);state.supportAssistant=[];toast("Admin support has been alerted. Reference "+id.slice(-8).toUpperCase()+".","success");go("home",{},true)}catch(e){toast("Could not alert support. "+friendlyError(e),"danger")}}

  async function submitSupport(form) {
    const message=form.elements["message"].value.trim();if(message.length<10){setFieldError("support-message","Please add a little more detail.");return;}
    const id=uid("ticket_"),ticket={id:id,uid:state.session.uid,customerName:state.profile.name||"",email:state.profile.email||"",orderId:state.routeData.orderId||"",topic:form.elements["topic"].value,message:message,status:"open",createdAt:Date.now(),updatedAt:Date.now()};
    const button=form.querySelector("button");button.disabled=true;button.innerHTML='<span class="spinner"></span> Submitting…';
    try{await db("PUT",DB_ROOT+"/support/"+state.session.uid+"/"+id,ticket);form.reset();toast("Support request submitted. Reference "+id.slice(-8).toUpperCase()+".","success");}
    catch(error){toast("Request could not be saved. "+friendlyError(error),"danger");}
    finally{button.disabled=false;button.textContent="Submit support request";}
  }
  function buildReviewPayload(order,rating,riderRating,comment) {
    return {orderId:order.id,restaurantId:order.restaurantId,riderId:order.riderId||"",rating,riderRating,comment,postDeliveryTip:0,growthContribution:0,createdAt:Date.now(),status:"published"};
  }
  async function submitReview(form) {
    if(!reviewStateReady()){toast("Feedback status is still syncing. Please wait a moment.");syncOrders(false);return;}
    const data=new FormData(form),rating=Number(data.get("rating"));if(!rating){toast("Choose a restaurant rating.","danger");return;}
    const order=orderById();if(!order)return;if(state.reviews[order.id]){toast("Feedback was already submitted for this order.");render({preserveScroll:true});return;}
    const riderRating=Number(data.get("riderRating")||0);
    const review=buildReviewPayload(order,rating,riderRating,String(data.get("comment")||"").trim());
    try{await db("PUT",DB_ROOT+"/reviews/"+state.session.uid+"/"+order.id,review);state.reviews[order.id]=review;state.reviewsHydrated=true;state.reviewsHydratedUid=String(state.session.uid||"");persistReviews();toast("Thank you for helping Scraveit improve.","success");go("home",{},true);}
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
    else if(form.id==="assistant-form")submitAssistant(form);
    else if(form.id==="chat-form")sendOrderChat(form);
    else if(form.id==="review-form")submitReview(form);
    else if(form.id==="cancel-form")submitCancellation(form);
    else if(form.id==="deletion-form")submitDeletion(form);
  });

  function installCustomerViewportGuards(){
    let largestViewport=Math.max(window.innerHeight||0,(window.visualViewport&&window.visualViewport.height)||0);
    function updateViewport(){
      const vv=window.visualViewport;
      const height=Math.max(1,Math.round(vv?vv.height:window.innerHeight||document.documentElement.clientHeight||1));
      if(height>largestViewport)largestViewport=height;
      const keyboardOpen=(largestViewport-height)>120;
      const root=document.documentElement;
      if(root&&root.style&&root.style.setProperty)root.style.setProperty("--visual-viewport-height",height+"px");
      if(root&&root.classList&&root.classList.toggle)root.classList.toggle("keyboard-open",keyboardOpen);
    }
    function revealFocusedField(target){
      if(!target||!target.matches||!target.matches('input,textarea,select,[contenteditable="true"]'))return;
      const reveal=()=>{
        try{target.scrollIntoView({block:"center",inline:"nearest",behavior:"auto"})}
        catch(_){try{target.scrollIntoView(false)}catch(__){}}
        const scroller=pageScroller();
        if(scroller){
          const sr=scroller.getBoundingClientRect(),tr=target.getBoundingClientRect();
          const topGuard=sr.top+24,bottomGuard=sr.bottom-28;
          if(tr.bottom>bottomGuard)scroller.scrollTop+=tr.bottom-bottomGuard;
          else if(tr.top<topGuard)scroller.scrollTop-=topGuard-tr.top;
        }
      };
      setTimeout(reveal,120);
      setTimeout(reveal,320);
    }
    document.addEventListener("focusin",event=>{updateViewport();revealFocusedField(event.target)});
    document.addEventListener("focusout",()=>setTimeout(updateViewport,180));
    window.addEventListener("resize",updateViewport,{passive:true});
    if(window.visualViewport){
      window.visualViewport.addEventListener("resize",updateViewport,{passive:true});
      window.visualViewport.addEventListener("scroll",updateViewport,{passive:true});
    }
    updateViewport();
  }
  installCustomerViewportGuards();

  window.addEventListener("online",function(){state.online=true;state.syncError="";render({preserveScroll:true});if(state.session)refreshAll();});
  window.addEventListener("offline",function(){state.online=false;render({preserveScroll:true});});
  document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible"&&state.session&&state.online)syncOrders(false);});
  if(window.matchMedia){const media=matchMedia("(prefers-color-scheme: dark)");if(media.addEventListener)media.addEventListener("change",function(){if((state.profile.preferences||{}).theme==="system"){applyTheme();render({preserveScroll:true});}});}

  bootstrap();
})();
