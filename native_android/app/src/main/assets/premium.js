(function () {
  "use strict";

  const BRAND = "Scraveit";
  // DB_ROOT/dbUrl stay: tracking/{orderId} (live rider GPS during delivery) is
  // still RTDB-authoritative until the rider app's presence-write path itself
  // moves (a later phase) - everything else here moved to Firestore.
  const DB_ROOT = "feastly";
  const CONFIG = window.FEASTLY_FIREBASE || {};
  firebase.initializeApp(CONFIG);
  const fbAuth = firebase.auth(), fs = firebase.firestore();
  function userDoc(uidValue){return fs.collection("users").doc(uidValue)}
  function restaurantsCollectionRef(){return fs.collection("restaurants")}
  function restaurantDocRef(restaurantId){return restaurantsCollectionRef().doc(restaurantId)}
  function menuItemsCollectionRef(restaurantId){return fs.collection("menus").doc(restaurantId).collection("items")}
  function searchTokensCollectionRef(cityKey){return fs.collection("catalogSearchTokens").doc(cityKey).collection("tokens")}
  function ordersQuery(customerId){return fs.collection("orders").where("customerId","==",customerId)}
  function orderDocRef(orderId){return fs.collection("orders").doc(orderId)}
  function reviewsQuery(customerId){return fs.collection("reviews").where("customerId","==",customerId)}
  function reviewDocRef(customerId,orderId){return fs.collection("reviews").doc(customerId+"_"+orderId)}
  function orderChatQuery(orderId,channel){return fs.collection("orderChats").where("orderId","==",orderId).where("channel","==",channel)}
  function orderChatMessageDoc(orderId,channel,messageId){return fs.collection("orderChats").doc(orderId+"_"+channel+"_"+messageId)}
  function supportDoc(id){return fs.collection("support").doc(id)}
  function privacyRequestDoc(id){return fs.collection("privacyRequests").doc(id)}
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
    expand: '<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/>',
    minimize: '<path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5"/>',
    orders: '<path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/>',
    offers: '<path d="M20 13 13 20 4 11V4h7z"/><circle cx="8.5" cy="8.5" r="1"/>',
    wallet: '<path d="M4 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4z"/><path d="M4 7V6a2 2 0 0 1 2-2h10v3M15 13.5h2"/>',
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
    bike: '<circle cx="5.5" cy="14.9" r="3"/><circle cx="18.5" cy="14.9" r="3"/><circle cx="12" cy="14.9" r=".9"/><path d="M9 7.5 12 14.9M9 7.5 15.5 7.5M15.5 7.5 12 14.9M15.5 7.5 18.5 14.9M5.5 14.9 12 14.9M7.6 6.8 10.4 6.8M14.3 5.8 16.8 6.6"/>',
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
  // Empty until the Cloudflare edge cache in front of Firebase Storage is live
  // (see cloudflare/image-cdn/). Once set (e.g. "img.scraveit.in"), every
  // Storage image URL is served from the nearest edge instead of round-tripping
  // to the database's us-central1 origin on every load.
  const IMAGE_CDN_HOST = "savrivo-image-cdn.tirumurunbalu.workers.dev";
  function cdnUrl(url) {
    if (!IMAGE_CDN_HOST) return url;
    return url.replace(/^https:\/\/firebasestorage\.googleapis\.com\//i, "https://" + IMAGE_CDN_HOST + "/");
  }
  function safeUrl(value, fallback) {
    const url = String(value || "").trim();
    if (/^(?:[a-z0-9._-]+\.(?:jpg|jpeg|png|webp|svg)|data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+)$/i.test(url)) return url;
    if (/^https:\/\/firebasestorage\.googleapis\.com\//i.test(url)) return cdnUrl(url);
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
    // Paging state for the customer's own city. catalogCursor is the citySort
    // value of the last restaurant loaded, not an offset, so pages stay stable
    // even when the catalogue changes underneath.
    catalogCursor:"", catalogHasMore:false, catalogLoadingMore:false, catalogPages:1, catalogCity:"",
    // Name matches fetched from the server for the whole city. Kept apart from
    // the catalogue so browsing still shows the city in its own order.
    searchCatalog:{}, searchFetched:{}, searchLoading:false, searchSequence:0,
    promotions: [], settings: {platformFee:15, taxRate:0, freeDeliveryAbove:0, maxDeliveryKm:15, deliverySlabs:{"0":{maxKm:2,fee:29},"1":{maxKm:4,fee:39},"2":{maxKm:6,fee:59},"3":{maxKm:8,fee:79},"4":{maxKm:10,fee:99},"5":{maxKm:12,fee:119},"6":{maxKm:15,fee:139}}, platformFeeOverrides:{cities:{},categories:{},restaurants:{},orderValueRules:{}}, rainFeeEnabled:true,rainLightFee:9,rainModerateFee:19,rainHeavyFee:29,rainSevereFee:39,rainMinProbability:35,rainLightMm:0.1,rainModerateMm:1,rainHeavyMm:4,rainSevereMm:10,surgeEnabled:true,surgeLowOrders:4,surgeMediumOrders:8,surgeHighOrders:12,surgeLowFee:9,surgeMediumFee:19,surgeHighFee:29,maxSurgeFee:39,smallOrderFeeEnabled:true,smallOrderThreshold:149,smallOrderFee:19,lateNightFeeEnabled:true,lateNightStartHour:23,lateNightEndHour:5,lateNightFee:19}, checkoutConfig:null,
    orders: loadJSON("savrivo.customer.orders", []), ordersHydrated:false, ordersHydratedUid:"", tracking: {}, deliveryOtps:{}, reviews:loadJSON(reviewCacheKey(cachedSession&&cachedSession.uid),{}), reviewsHydrated:false, reviewsHydratedUid:"", reviewSyncSequence:0, localAds:[], broadcasts:[], seenBroadcasts:loadJSON("savrivo.customer.seenBroadcasts",{}), broadcastTimers:{},
    cart: loadJSON("savrivo.customer.cart", []), coupon: null, tip: 0,
    // couponAuto: this offer was chosen for the customer, so a better one may
    // replace it. couponDismissedFor: the restaurant whose auto-offer they
    // removed, so it is not silently re-applied under them.
    couponAuto: false, couponDismissedFor: "",
    query: "", recentSearches:normalizedRecentSearches(loadJSON(searchHistoryKey(cachedSession&&cachedSession.uid),[])), searchDebounceTimer:null, cuisine: "All", diet: "all", sort: "recommended", homeFilter: "all",
    menuPrice: "all", menuSort: "recommended", ratingView: loadJSON("savrivo.customer.ratingView", "overall"),
    selectedRestaurantId: "the-waffle-spot-naidupeta", selectedOrderId: "", selectedMenuCategory: "All", timelineExpanded: false,
    online: navigator.onLine, loading: false, syncError: "", lastSync: 0,
    sheet: null, toastTimer: null, timers: [], watchers:{catalog:null,orders:null}, watcherStarts:{catalog:null,orders:null}, watcherScopes:{catalog:"",orders:""}, trackingWatchers:{}, trackingWatcherStarts:{}, trackingHydrated:{}, trackingReconnectTimers:{}, trackingSeenAt:{}, trackingMap:null, trackingRoutes:{}, trackingMapCollapsed:false, syncTimers:{catalog:null,orders:null,reconnectCatalog:null,reconnectOrders:null}, locationBusy: false, dynamicPricing:{rainFee:0,surgeFee:0,riderIncentiveFee:0,weatherSeverity:"",weatherChecked:false,activeOrders:0,checkedAt:0}, chat:{orderId:"",channel:"",messages:[],title:"Chat"},
    addressMapDraft: null, addressMapZoom: 16, locationMode: "general", menuLoading:{}, menuRequests:{}, menuErrors:{}, homeBootStartedAt:perfNow(), homeVisibleLogged:false, locationPromptShown:false,
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
  // Every cart mutation funnels through here, which makes it the one place
  // that can keep the auto-applied offer honest as the basket changes - an
  // offer that stops qualifying (basket dropped below its minimum) has to be
  // dropped too, or checkout would send a code the server then rejects.
  function persistCart() { refreshAutoOffer(); saveJSON("savrivo.customer.cart", state.cart); }
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
    ["id","name","image","imageUrl","imageThumb","imageThumbUrl","cuisines","city","category","description","address","lat","lng","etaMin","etaMax","deliveryFee","platformFee","opensUntil","open","active","archived","rating","ratingCount","pureVeg","offer","offerText","discount","deliveryRadiusKm","priceForTwo","serviceAreaId","serviceAreaIds","updatedAt"].forEach(key=>{
      if(restaurant[key]!==undefined)summary[key]=restaurant[key];
    });
    summary.menuIndex=discoveryIndex((restaurant.menu&&restaurant.menu.length)?restaurant.menu:restaurant.menuIndex);
    return summary;
  }

  function cacheMap(){const value=loadJSON(HOME_CACHE_KEY,{});return value&&typeof value==="object"?value:{}}
  function saveHomeCache(){
    const scope=homeScope(currentAddress()),cache=cacheMap(),catalog={};
    // Only the first page is cached, in the order the server returns it. A
    // customer who paged deep would otherwise see the restored list shrink
    // back to one page the moment the live refresh landed, and storing every
    // page of every saved address is what fills up local storage.
    Object.keys(state.catalog||{})
      .sort((a,b)=>String((state.catalog[a]||{}).citySort||a).localeCompare(String((state.catalog[b]||{}).citySort||b)))
      .slice(0,CATALOG_PAGE_SIZE)
      .forEach(id=>catalog[id]=homeSummary(state.catalog[id]));
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
        } else if (operation === "getCustomerWallet") {
          FeastlyNative.getCustomerWallet(requestId, firebaseIdToken, JSON.stringify(payload || {}));
        } else if (operation === "applyCustomerReferral") {
          FeastlyNative.applyCustomerReferral(requestId, firebaseIdToken, JSON.stringify(payload || {}));
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

  // Firebase Auth SDK owns session persistence/refresh now - applyAuthUser
  // mirrors the signed-in user into state.session (still read pervasively
  // throughout this file) instead of the old raw-REST saveAuth().
  function applyAuthUser(user) {
    if (!user) { state.session = null; return null; }
    state.session = Object.assign({}, state.session, {uid: user.uid, email: user.email || ""});
    persistSession();
    state.profile.email = state.session.email;
    persistProfile();
    return state.session;
  }
  async function ensureSession() {
    const user = fbAuth.currentUser;
    if (!user) throw new Error("AUTH_REQUIRED");
    const idToken = await user.getIdToken();
    state.session = Object.assign({}, state.session, {uid: user.uid, email: user.email || (state.session && state.session.email) || "", idToken});
    return state.session;
  }

  // tracking/{orderId} is still RTDB-authoritative (see header comment) -
  // kept as its own small helper now that every other collection moved to
  // Firestore.
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

  async function rtdb(method, path, body) {
    const session = await ensureSession();
    const token = session && session.idToken;
    const options = {method:method, headers:{"Content-Type":"application/json"}};
    if (body !== undefined) options.body = JSON.stringify(body);
    return request(dbUrl(path, token), options, 18000);
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
    const remoteSnap = await userDoc(state.session.uid).get();
    const remote = remoteSnap.exists ? remoteSnap.data() : null;
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
    await userDoc(state.session.uid).set(payload);
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
    // Firebase Storage serves exactly the bytes it was given - there is no
    // resize-on-request URL parameter, unlike a CDN. So a small list card
    // showing this at ~120-150px was downloading the same file a full-width
    // hero needs at ~900-1300px, which for a detailed food photo is 300-400KB+
    // just to shrink it back down in CSS. imageThumb is a dedicated small
    // copy generated at upload time; falling back to the full image keeps
    // every restaurant displaying correctly before it has one (existing
    // uploads, or an upload path that hasn't started producing one yet).
    data.imageThumb = data.imageThumbUrl || data.imageThumb || data.image;
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
      const cover=safeUrl(restaurant.imageThumb||restaurant.image,"");if(cover)urls.push(cover);
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

  // ---- catalogue index ---------------------------------------------------
  // These must produce values byte-identical to functions/src/domain/
  // catalogIndex.ts, because both address the same citySort range. A
  // divergence here does not surface as a wrong number - it silently returns
  // the wrong restaurants, or none at all.
  const CATALOG_RANGE_END="";
  const CATALOG_PAGE_SIZE=40;
  // Hard ceiling on how much of one city is ever held in memory or rebuilt on
  // a refresh. Nobody scrolls 320 restaurants; anyone looking for a specific
  // one searches, which queries the whole city on the server regardless.
  const CATALOG_MAX_PAGES=8;
  function catalogCityKey(value){
    return String(value==null?"":value).trim().toLowerCase()
      .replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,80)||"unknown";
  }
  function catalogNameKey(value){
    return String(value==null?"":value).trim().toLowerCase()
      .replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,120);
  }
  function cityListingRange(city){
    const key=catalogCityKey(city);
    return {startAt:key+"|",endAt:key+"|"+CATALOG_RANGE_END};
  }
  function cityListingRangeAfter(city,cursor){
    const range=cityListingRange(city),value=String(cursor||"");
    return value>range.startAt&&value<range.endAt?{startAt:value,endAt:range.endAt}:range;
  }
  function citySearchRange(city,query){
    const key=catalogCityKey(city),prefix=catalogNameKey(query);
    return prefix?{startAt:key+"|"+prefix,endAt:key+"|"+prefix+CATALOG_RANGE_END}:cityListingRange(city);
  }

  /** The city every catalogue query is scoped to. Empty means the customer has
   *  no address yet, which is the one case that cannot be paged or searched on
   *  the server - there is no range to walk. */
  function catalogCity(){
    const address=currentAddress();
    return String(address&&address.city||"").trim();
  }

  // ---- proximity index -----------------------------------------------------
  // Mirrors functions/src/domain/catalogGeoIndex.ts, query side only - the
  // client never computes or writes geoSort, it only reads with a range built
  // from the same geohash. See that file for why the alphabetical listing
  // above is the wrong key to load by once a city outgrows its delivery
  // radius: it loads the alphabetically-first restaurants, not the nearest
  // ones, so a restaurant two kilometres away whose name starts with Z can
  // never appear.
  const GEOHASH_ALPHABET="0123456789bcdefghjkmnpqrstuvwxyz";
  // Two precisions, because one fixed cell size cannot serve both a dense city
  // and the platform's delivery radius. A level-5 cell (~4.7km) stays
  // selective in a dense city but under-covers the 15km default delivery
  // radius; a level-4 cell (~19.5km+) covers it but in a city no bigger than
  // that itself, its "neighbourhood" is the whole city. So the tight tier is
  // tried first, and the wide tier only when it comes back thin - which is
  // the uncommon case.
  const GEO_QUERY_PRECISION_TIGHT=5;
  const GEO_QUERY_PRECISION_WIDE=4;
  // Per cell, per tier. Bounds the request however dense the area is; a
  // legitimately large deliverable set is revealed to the customer in full
  // once fetched (see fetchGeoCatalogRecords), not paged further.
  const GEO_CELL_FETCH_LIMIT=60;

  // Deliberately not Number(value): Number(null) and Number("") are both 0,
  // which would silently geocode a missing coordinate to Null Island instead
  // of failing - the same trap geoDistanceKm and coordinatePoint already
  // guard against elsewhere in this file.
  function geoCoordinate(value){
    if(typeof value==="number")return value;
    if(typeof value==="string"&&value.trim()!=="")return Number(value);
    return NaN;
  }
  function geohashEncode(latitude,longitude,precision){
    const lat=geoCoordinate(latitude),lng=geoCoordinate(longitude);
    if(!Number.isFinite(lat)||!Number.isFinite(lng))return "";
    if(lat<-90||lat>90||lng<-180||lng>180)return "";
    let latMin=-90,latMax=90,lngMin=-180,lngMax=180,hash="",bits=0,bitCount=0,longitudeTurn=true;
    while(hash.length<precision){
      if(longitudeTurn){
        const mid=(lngMin+lngMax)/2;
        if(lng>=mid){bits=(bits<<1)+1;lngMin=mid}else{bits<<=1;lngMax=mid}
      }else{
        const mid=(latMin+latMax)/2;
        if(lat>=mid){bits=(bits<<1)+1;latMin=mid}else{bits<<=1;latMax=mid}
      }
      longitudeTurn=!longitudeTurn;
      if(++bitCount===5){hash+=GEOHASH_ALPHABET[bits];bits=0;bitCount=0}
    }
    return hash;
  }
  function geohashBounds(hash){
    const value=String(hash||"");
    if(!value)return null;
    let latMin=-90,latMax=90,lngMin=-180,lngMax=180,longitudeTurn=true;
    for(let i=0;i<value.length;i++){
      const index=GEOHASH_ALPHABET.indexOf(value[i]);
      if(index<0)return null;
      for(let shift=4;shift>=0;shift--){
        const bit=(index>>shift)&1;
        if(longitudeTurn){
          const mid=(lngMin+lngMax)/2;
          if(bit)lngMin=mid;else lngMax=mid;
        }else{
          const mid=(latMin+latMax)/2;
          if(bit)latMin=mid;else latMax=mid;
        }
        longitudeTurn=!longitudeTurn;
      }
    }
    return {latMin,latMax,lngMin,lngMax};
  }
  /** The customer's cell plus its eight neighbours, at `precision`. Stepping
   *  one cell width out from the centre and re-encoding, same as the server -
   *  the identical answer with no neighbour-lookup table to get subtly wrong
   *  in only one of the two copies. */
  function geohashNeighborhood(latitude,longitude,precision){
    const center=geohashEncode(latitude,longitude,precision);
    if(!center)return [];
    const bounds=geohashBounds(center);
    if(!bounds)return [];
    const latStep=bounds.latMax-bounds.latMin,lngStep=bounds.lngMax-bounds.lngMin;
    const centerLat=(bounds.latMin+bounds.latMax)/2,centerLng=(bounds.lngMin+bounds.lngMax)/2;
    const cells={};
    [-1,0,1].forEach(latOffset=>{
      [-1,0,1].forEach(lngOffset=>{
        const lat=centerLat+latOffset*latStep;
        if(lat>90||lat<-90)return;
        let lng=centerLng+lngOffset*lngStep;
        if(lng>180)lng-=360;
        if(lng<-180)lng+=360;
        const cell=geohashEncode(lat,lng,precision);
        if(cell)cells[cell]=true;
      });
    });
    return Object.keys(cells).sort();
  }
  function geoCellRange(city,cell){
    const key=catalogCityKey(city);
    return {startAt:key+"|"+cell,endAt:key+"|"+cell+CATALOG_RANGE_END};
  }
  /** Same cell, with no city to scope it to - see geoSortGlobal in
   *  functions/src/domain/catalogGeoIndex.ts for why this exists. */
  function geoGlobalCellRange(cell){
    return {startAt:cell,endAt:cell+CATALOG_RANGE_END};
  }

  /** One page of the customer's own city, ordered by name. `cursor` is the
   *  citySort value of the last restaurant already shown; Firestore returns
   *  that row again, so one extra is requested and the caller drops it.
   *  Returns null (no range) when there is no city to scope to at all. */
  function restaurantSummaryRange(cursor){
    const city=catalogCity();
    if(!city)return null;
    return cursor?cityListingRangeAfter(city,cursor):cityListingRange(city);
  }
  /** citySort's stored value is itself a city-prefixed compound key (e.g.
   *  "naidupeta|waffle-spot" - see citySortValue() in
   *  functions/src/domain/catalogIndex.ts), so ranging over that one field
   *  already scopes to the city; no separate where("city",...) filter or
   *  composite index is needed. */
  function restaurantSummaryFirestoreQuery(cursor){
    const range=restaurantSummaryRange(cursor);
    if(!range)return restaurantsCollectionRef().orderBy(firebase.firestore.FieldPath.documentId()).limit(CATALOG_PAGE_SIZE);
    return restaurantsCollectionRef().orderBy("citySort").startAt(range.startAt).endAt(range.endAt).limit(CATALOG_PAGE_SIZE+(cursor?1:0));
  }

  async function fetchRestaurantSummaries(cursor){
    const snap=await restaurantSummaryFirestoreQuery(cursor).get();
    const records={};
    snap.forEach(doc=>{records[doc.id]=doc.data()});
    return records;
  }

  /** Walks the customer's city from the top for `pages` pages.
   *
   *  A refresh has to rebuild everything the customer already scrolled
   *  through, not just the first page - otherwise a live catalogue update
   *  snaps the list back to 40 restaurants underneath them. The page count is
   *  capped so that however far anyone scrolls, a refresh stays a bounded
   *  number of requests rather than growing with the size of the city. */
  async function fetchCatalogPages(pages){
    const pageable=!!catalogCity();
    const wanted=pageable?Math.max(1,Math.min(CATALOG_MAX_PAGES,Number(pages)||1)):1;
    const merged={};
    let cursor="",loaded=0,hasMore=false;
    for(let page=0;page<wanted;page++){
      const records=await fetchRestaurantSummaries(cursor)||{};
      const size=Object.keys(records).length;
      Object.keys(records).forEach(id=>{merged[id]=records[id]});
      loaded=page+1;
      const next=catalogCursorFrom(records);
      // A resumed page replays the cursor row, so it only advanced if the
      // highest value came back higher than the one asked for.
      const advanced=next>cursor;
      if(advanced)cursor=next;
      // A full page back means there is very likely another one.
      hasMore=pageable&&advanced&&loaded<CATALOG_MAX_PAGES&&size>=CATALOG_PAGE_SIZE+(page?1:0);
      if(!hasMore)break;
    }
    return {records:merged,cursor,hasMore,pages:loaded};
  }

  function recordsFromSnapshot(snap){
    const records={};
    snap.forEach(doc=>{records[doc.id]=doc.data()});
    return records;
  }
  /** Every restaurant in one geohash cell of one city, capped per cell.
   *  geoSort's stored value is itself a city-prefixed compound key (see
   *  restaurantSummaryFirestoreQuery's comment), so this needs no
   *  where("city",...) filter or composite index either. */
  async function fetchGeoCell(city,cell,limit){
    const range=geoCellRange(city,cell);
    try{
      const snap=await restaurantsCollectionRef().orderBy("geoSort").startAt(range.startAt).endAt(range.endAt).limit(limit).get();
      return recordsFromSnapshot(snap);
    }catch(error){return null}
  }

  /** Every restaurant in one geohash cell, with no city to scope it to. */
  async function fetchGeoCellGlobal(cell,limit){
    const range=geoGlobalCellRange(cell);
    try{
      const snap=await restaurantsCollectionRef().orderBy("geoSortGlobal").startAt(range.startAt).endAt(range.endAt).limit(limit).get();
      return recordsFromSnapshot(snap);
    }catch(error){return null}
  }

  /** The customer's neighbourhood at one precision: up to nine small parallel
   *  range queries, merged. One cell failing must not take the rest down with
   *  it - a customer's own cell missing a network blip should still see their
   *  eight neighbours. */
  async function fetchGeoNeighborhood(city,address,precision,limitPerCell){
    const cells=geohashNeighborhood(address.lat,address.lng,precision);
    const results=await Promise.all(cells.map(cell=>fetchGeoCell(city,cell,limitPerCell)));
    const merged={};
    results.forEach(records=>{
      if(!records)return;
      Object.keys(records).forEach(id=>{merged[id]=records[id]});
    });
    return merged;
  }

  /** Same neighbourhood, no city required. Only reached when the city-scoped
   *  tiers come back thin - see fetchGeoCatalogRecords. */
  async function fetchGeoNeighborhoodGlobal(address,precision,limitPerCell){
    const cells=geohashNeighborhood(address.lat,address.lng,precision);
    const results=await Promise.all(cells.map(cell=>fetchGeoCellGlobal(cell,limitPerCell)));
    const merged={};
    results.forEach(records=>{
      if(!records)return;
      Object.keys(records).forEach(id=>{merged[id]=records[id]});
    });
    return merged;
  }

  /** Loads by proximity instead of by name, for a customer who has pinned an
   *  exact location. Tight first - selective in a dense city - and only wide
   *  when tight comes back thin, which is the uncommon case (see the comment
   *  on GEO_QUERY_PRECISION_TIGHT/WIDE for why neither tier alone is right).
   *
   *  A third, city-agnostic tier only runs when the city-scoped tiers are
   *  STILL thin after that: a restaurant owner's and a GPS geocoder's
   *  spelling of the same real place do not always match character for
   *  character ("Naidupet" vs "Naidupeta" is a real one this app hit), and a
   *  customer standing right next to a restaurant must not see nothing over
   *  a spelling difference neither side can control. This tier costs nothing
   *  for the common case - a matching city name with restaurants nearby
   *  never reaches it - and restaurantServiceable()'s real distance check
   *  still excludes anything this widens to that is not actually
   *  deliverable, exactly as it already does for the city-scoped tiers.
   *
   *  Returns the whole neighbourhood in one shot rather than a cursor to page
   *  through: unlike an alphabetical listing, there is no "next" restaurant to
   *  reveal by walking further - what's deliverable to this address is what
   *  it is, and existing sort/filter already reorders it for display. */
  async function fetchGeoCatalogRecords(address){
    const city=catalogCity();
    if(!city)return {records:{},cursor:"",hasMore:false,pages:1};
    let merged=await fetchGeoNeighborhood(city,address,GEO_QUERY_PRECISION_TIGHT,GEO_CELL_FETCH_LIMIT);
    if(Object.keys(merged).length<CATALOG_PAGE_SIZE){
      const wide=await fetchGeoNeighborhood(city,address,GEO_QUERY_PRECISION_WIDE,GEO_CELL_FETCH_LIMIT);
      merged=Object.assign({},merged,wide);
    }
    if(Object.keys(merged).length<CATALOG_PAGE_SIZE){
      const globalTight=await fetchGeoNeighborhoodGlobal(address,GEO_QUERY_PRECISION_TIGHT,GEO_CELL_FETCH_LIMIT);
      merged=Object.assign({},merged,globalTight);
    }
    if(Object.keys(merged).length<CATALOG_PAGE_SIZE){
      const globalWide=await fetchGeoNeighborhoodGlobal(address,GEO_QUERY_PRECISION_WIDE,GEO_CELL_FETCH_LIMIT);
      merged=Object.assign({},merged,globalWide);
    }
    // A hard ceiling, same reasoning as the alphabetical path's page cap: a
    // request must stay bounded however dense the deliverable area gets.
    const ids=Object.keys(merged),max=CATALOG_PAGE_SIZE*CATALOG_MAX_PAGES;
    const records=ids.length<=max?merged:ids.slice(0,max).reduce((out,id)=>{out[id]=merged[id];return out},{});
    return {records,cursor:"",hasMore:false,pages:1};
  }

  /** Everything the home screen needs to load one batch of restaurants,
   *  branching on whether the customer has pinned an exact location. A pin
   *  means real coordinates to search by proximity; without one there is
   *  nothing to measure distance from, so the alphabetical listing - the only
   *  one this app has ever shown before today - is what a customer sees while
   *  choosing or confirming their address. */
  async function fetchCatalogRecords(pages){
    const address=currentAddress();
    if(addressIsPinned(address))return fetchGeoCatalogRecords(address);
    return fetchCatalogPages(pages);
  }

  async function fetchCollectionMap(collectionName){
    const snap=await fs.collection(collectionName).get();
    return recordsFromSnapshot(snap);
  }
  async function syncSecondaryHomeData(){
    const started=perfNow();
    const result=await Promise.allSettled([
      fetchCollectionMap("promotions"),fs.collection("settings").doc("customer").get().then(snap=>snap.exists?snap.data():null),
      fetchCollectionMap("localAds"),fetchCollectionMap("customerBroadcasts"),
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
        const menuSnap=await menuItemsCollectionRef(restaurantId).get();
        const map=recordsFromSnapshot(menuSnap);
        const items=Object.keys(map||{}).map(itemId=>{const item=Object.assign({id:itemId},map[itemId]||{});item.image=item.imageUrl||item.image;item.imageThumb=item.imageThumbUrl||item.imageThumb||item.image;return item}).filter(item=>item.archived!==true);
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

  /** Highest citySort value in a page - the resume point for the next one. */
  function catalogCursorFrom(records){
    let cursor="";
    Object.keys(records||{}).forEach(id=>{
      const value=String((records[id]||{}).citySort||"");
      if(value>cursor)cursor=value;
    });
    return cursor;
  }

  /** Clears everything that only made sense for the previous city. */
  function resetCatalogPaging(city){
    state.catalogCity=String(city||"");
    state.catalogPages=1;state.catalogCursor="";state.catalogHasMore=false;
    state.searchCatalog={};state.searchFetched={};
  }

  // ---- word index --------------------------------------------------------
  // Mirrors functions/src/domain/catalogSearchTokens.ts. The server writes
  // /catalog/searchTokens/<cityKey>/<word>|<restaurantId>, so a key-ordered
  // prefix range answers "which restaurants in this city use this word",
  // which is what makes a middle-of-the-name search work at all.
  const SEARCH_TOKEN_LIMIT=40;
  // Each hit costs one record read, so this bounds a search to a predictable
  // amount of work however common the word is.
  const SEARCH_TOKEN_FETCH_LIMIT=20;

  function searchTokenRange(city,query){
    const cityKey=catalogCityKey(city);
    const prefix=String(query==null?"":query).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0];
    if(!prefix)return null;
    return {cityKey,startAt:prefix.slice(0,40),endAt:prefix.slice(0,40)+CATALOG_RANGE_END};
  }
  function restaurantIdFromTokenKey(key){
    const value=String(key==null?"":key),separator=value.indexOf("|");
    return separator<0?"":value.slice(separator+1);
  }

  /** Restaurant records matching any word of `query` within the city.
   *  Resolves to [] rather than rejecting: a word-index miss must never take
   *  down the name search running alongside it. */
  async function searchCityTokens(city,query){
    const range=searchTokenRange(city,query);
    if(!range||!range.cityKey)return [];
    let keys=[];
    try{
      // Each token entry is its own document (id: "token|restaurantId") in a
      // per-city subcollection, not a field on one shared document - a
      // prefix range needs to run over the key space itself, which Firestore
      // only supports via document-id range queries.
      const snap=await searchTokensCollectionRef(range.cityKey)
        .orderBy(firebase.firestore.FieldPath.documentId())
        .startAt(range.startAt).endAt(range.endAt).limit(SEARCH_TOKEN_LIMIT).get();
      keys=snap.docs.map(doc=>doc.id);
    }catch(error){return []}
    const ids=[];
    keys.forEach(key=>{
      const id=restaurantIdFromTokenKey(key);
      // One restaurant matches several words of the same query; already
      // knowing it means no read at all.
      if(id&&ids.indexOf(id)<0&&!state.catalog[id]&&!state.searchCatalog[id])ids.push(id);
    });
    const wanted=ids.slice(0,SEARCH_TOKEN_FETCH_LIMIT);
    const loaded=await Promise.all(wanted.map(async id=>{
      try{const snap=await restaurantDocRef(id).get();if(!snap.exists)throw new Error("NOT_FOUND");return {id,record:snap.data()}}
      catch(error){return {id,record:null}}
    }));
    return loaded.filter(entry=>entry.record);
  }

  /** The device only holds the pages the customer actually scrolled through,
   *  so filtering that locally cannot find a restaurant further down the
   *  city's list - it would report "nothing matched" for a restaurant that is
   *  open and deliverable. This asks the server for name matches across the
   *  whole city and merges them into the search screen only. */
  async function searchCityCatalog(query){
    const city=catalogCity(),prefix=catalogNameKey(query);
    if(!city||!prefix||!state.session)return;
    const key=catalogCityKey(city)+"|"+prefix;
    if(state.searchFetched[key])return;
    state.searchFetched[key]=true;
    const sequence=++state.searchSequence;
    state.searchLoading=true;
    try{
      const range=citySearchRange(city,query);
      const [byNameSnap,byWord]=await Promise.all([
        restaurantsCollectionRef().orderBy("citySort").startAt(range.startAt).endAt(range.endAt).limit(CATALOG_PAGE_SIZE).get(),
        // The name range only matches the start of a name, so "waffle" would
        // miss "The Waffle Spot". The word index covers the rest.
        searchCityTokens(city,query),
      ]);
      const records=recordsFromSnapshot(byNameSnap);
      if(sequence!==state.searchSequence)return;
      // Typing walks through many prefixes; without a ceiling a long session
      // would accumulate every restaurant the customer ever half-typed.
      if(Object.keys(state.searchCatalog).length>CATALOG_PAGE_SIZE*CATALOG_MAX_PAGES)state.searchCatalog={};
      Object.keys(records).forEach(id=>{
        if(state.catalog[id])return;
        const restaurant=normalizeRestaurantSummary(id,records[id]);
        if(restaurant.archived!==true)state.searchCatalog[id]=restaurant;
      });
      (byWord||[]).forEach(entry=>{
        if(state.catalog[entry.id]||!entry.record)return;
        const restaurant=normalizeRestaurantSummary(entry.id,entry.record);
        if(restaurant.archived!==true)state.searchCatalog[entry.id]=restaurant;
      });
    }catch(error){
      // Leave it retryable rather than remembering a failure as "no matches".
      delete state.searchFetched[key];
    }finally{
      if(sequence===state.searchSequence)state.searchLoading=false;
      if(state.route==="search")updateSearchResults();
    }
  }

  /** Appends the next page of the customer's city to what is already shown.
   *  Never replaces the catalogue, so scrolling further can't discard what the
   *  customer is already looking at. */
  async function loadMoreRestaurants(){
    if(state.catalogLoadingMore||!state.catalogHasMore||!state.catalogCursor)return;
    state.catalogLoadingMore=true;render({preserveScroll:true});
    try{
      const records=await fetchRestaurantSummaries(state.catalogCursor)||{};
      const cursor=state.catalogCursor;
      let added=0;
      Object.keys(records).forEach(id=>{
        // Firebase returns the cursor row itself again; it is already shown.
        if(String((records[id]||{}).citySort||"")===cursor)return;
        const restaurant=normalizeRestaurantSummary(id,records[id]);
        if(restaurant.archived!==true){state.catalog[id]=restaurant;added++;}
      });
      const nextCursor=catalogCursorFrom(records);
      if(nextCursor>cursor){state.catalogCursor=nextCursor;state.catalogPages=(state.catalogPages||1)+1;}
      state.catalogHasMore=added>0&&nextCursor>cursor&&state.catalogPages<CATALOG_MAX_PAGES;
      saveHomeCache();
    }catch(error){
      toast("More restaurants could not be loaded. Check your connection.","danger");
    }finally{
      state.catalogLoadingMore=false;render({preserveScroll:true});
    }
  }

  function catalogFingerprint(map){
    return Object.keys(map).sort().map(id=>id+":"+(map[id]&&map[id].updatedAt||0)).join("|");
  }
  async function syncCatalog() {
    if (!state.session) return;
    const sequence=++state.catalogRequestSequence,started=perfNow(),hadCache=state.catalogLoaded&&Object.keys(state.catalog).length>0;
    // A realtime watcher reconnect (common on a flaky mobile connection)
    // always resends a full snapshot, so this fires far more often than the
    // data actually changes. Skipping the repaint when nothing did is what
    // stops that from reading as the whole home screen blinking.
    const previousFingerprint=catalogFingerprint(state.catalog),hadSyncError=!!state.syncError,previousHasMore=state.catalogHasMore;
    let skipRender=false;
    state.homeStatus=hadCache?"refreshing":"loadingWithoutCache";
    // Moving to another city invalidates the pages and the searches held for
    // the old one. Checking it here rather than in each place an address can
    // change means no path can leave another city's restaurants on screen.
    const city=catalogCity();
    if(city!==state.catalogCity)resetCatalogPaging(city);
    const pages=state.catalogPages||1;
    perfLog("REMOTE_CATALOG_STARTED",started,{sequence,scope:homeScope(currentAddress()),cachedRestaurants:Object.keys(state.catalog).length,pages});
    try {
      const page=await fetchCatalogRecords(pages);
      const records=page.records;
      if(sequence<state.catalogRequestSequence){perfLog("STALE_CATALOG_IGNORED",started,{sequence,latest:state.catalogRequestSequence});return}
      const next={};
      Object.keys(records).forEach(id=>{const restaurant=normalizeRestaurantSummary(id,records[id]);if(restaurant.archived!==true)next[id]=restaurant});
      skipRender=hadCache&&!hadSyncError&&previousHasMore===page.hasMore&&previousFingerprint===catalogFingerprint(next);
      state.catalogHasMore=page.hasMore;
      state.catalogCursor=page.cursor;
      state.catalogPages=page.pages;
      state.catalog=next;state.catalogMode="live";state.catalogLoaded=true;state.homeStatus=Object.keys(next).length?"success":"empty";
      state.appliedCatalogSequence=sequence;state.lastSync=Date.now();state.syncError="";saveHomeCache();warmCatalogImages();
      const payloadBytes=(()=>{try{return JSON.stringify(records).length}catch(_){return 0}})();
      perfLog("REMOTE_CATALOG_APPLIED",started,{sequence,downloaded:Object.keys(records).length,displayable:Object.keys(next).length,payloadBytes,skipRender});
    } catch (error) {
      if(sequence<state.catalogRequestSequence)return;
      state.catalogLoaded=true;state.homeStatus=Object.keys(state.catalog).length?"errorWithCache":"errorWithoutCache";
      state.syncError=Object.keys(state.catalog).length?"Live catalogue refresh failed. Showing saved restaurants.":"Restaurants could not be loaded. Check your connection and retry.";
      perfLog("REMOTE_CATALOG_FAILED",started,{sequence,cacheRetained:Object.keys(state.catalog).length>0,code:String(error&&error.message||"unknown")});
    } finally {
      if(sequence===state.catalogRequestSequence&&["home","search","restaurant"].includes(state.route)&&!skipRender)render({preserveScroll:true});
    }
  }

  function normalizeOrders(map) {
    return Object.keys(map || {}).map(id=>Object.assign({id:id},map[id]||{})).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
  }

  function ordersFingerprint(list){
    return list.map(order=>order.id+":"+order.status+":"+(order.updatedAt||order.createdAt||0)).sort().join("|");
  }
  async function syncOrders(silent) {
    if (!state.session) return false;
    const sessionUid=String(state.session.uid||""),reviewSequence=++state.reviewSyncSequence,previousFingerprint=ordersFingerprint(state.orders);
    try {
      const pair = await Promise.all([
        ordersQuery(sessionUid).get().then(snap=>recordsFromSnapshot(snap)),
        reviewsQuery(sessionUid).get().then(snap=>{
          const byOrderId={};
          snap.forEach(doc=>{const data=doc.data();byOrderId[data.orderId||doc.id]=data});
          return {ok:true,value:byOrderId};
        }).catch(()=>({ok:false,value:null})),
      ]);
      if(!state.session||String(state.session.uid||"")!==sessionUid||reviewSequence!==state.reviewSyncSequence)return;
      const map = pair[0];
      // Keep the per-account local review cache when the review request is
      // temporarily unavailable. Clearing it here made an already-reviewed
      // delivery flash on the home screen during every cold start.
      if(pair[1].ok)applyReviewSnapshot(sessionUid,reviewSequence,pair[1].value);
      const before = {};
      state.orders.forEach(order=>before[order.id]=order.status);
      state.orders = normalizeOrders(map);
      // The cached order list cannot prove a customer is new - a returning
      // customer on a fresh install starts with an empty one. Only a completed
      // remote read can, and a first-order offer depends on knowing which.
      state.ordersHydrated = true;
      state.ordersHydratedUid = String(state.session&&state.session.uid||"");
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
      if(deliveredForReview){go("review",{orderId:deliveredForReview.id});return true;}
      const changed=previousFingerprint!==ordersFingerprint(state.orders);
      if (!silent && ["home","orders","order","tracking"].includes(state.route)) render({preserveScroll:true});
      return changed;
    } catch (error) {
      state.syncError = "Live order updates are temporarily unavailable.";
      if (!silent) render({preserveScroll:true});
      return true;
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

  // A watcher is either a Firestore onSnapshot() unsubscribe function
  // (catalog/orders) or an RTDB EventSource (tracking, still RTDB-authoritative).
  function closeWatcher(watcher) { try { if (typeof watcher === "function") watcher(); else if (watcher) watcher.close(); } catch (_) {} }
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
        // syncCatalog() already renders itself when its result actually
        // changes (see catalogFingerprint) - rendering again here regardless
        // was the second unconditional repaint on every watcher event, on
        // top of syncCatalog()'s own. For orders, syncOrders(true) never
        // renders (silent), so this still owns that decision - but only when
        // something changed, for the same reason.
        if (kind === "catalog") { await syncCatalog(); return; }
        const changed = await syncOrders(true);
        if (changed && ["home","orders","order","tracking"].includes(state.route)) render({preserveScroll:true});
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
  function firestoreWatchQuery(kind){
    return kind==="catalog"?restaurantSummaryFirestoreQuery():ordersQuery(state.session.uid);
  }
  async function ensureRealtimeWatcher(kind) {
    if(!state.session||!state.online||!["catalog","orders"].includes(kind))return null;
    const scope=kind==="catalog"?JSON.stringify(restaurantSummaryRange()||{}):String(state.session.uid||"");
    if(state.watchers[kind]&&state.watcherScopes[kind]===scope)return state.watchers[kind];
    if(state.watchers[kind]){closeWatcher(state.watchers[kind]);state.watchers[kind]=null;state.watcherScopes[kind]="";}
    if(state.watcherStarts[kind])return state.watcherStarts[kind];
    const started=(async()=>{
      const unsubscribe=firestoreWatchQuery(kind).onSnapshot(()=>scheduleScopedSync(kind),()=>{
        if(state.watchers[kind]===unsubscribe){state.watchers[kind]=null;state.watcherScopes[kind]="";}
        scheduleRealtimeReconnect(kind);
      });
      const currentScope=kind==="catalog"?JSON.stringify(restaurantSummaryRange()||{}):String(state.session&&state.session.uid||"");
      if(!state.session||!state.online||currentScope!==scope){closeWatcher(unsubscribe);if(state.session&&state.online)scheduleRealtimeReconnect(kind);return null;}
      state.watchers[kind]=unsubscribe;state.watcherScopes[kind]=scope;
      return unsubscribe;
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
    if (liveOrderRoute() && state.selectedOrderId === orderId) {
      if (!patchTrackingMap(orderId)) render({preserveScroll:true});
    }
  }
  async function hydrateInitialTracking(activeOrders){
    const missing=(activeOrders||[]).filter(order=>!state.trackingHydrated[order.id]);
    const results=await Promise.all(missing.map(async order=>{
      try{return {id:order.id,ok:true,value:await rtdb("GET",DB_ROOT+"/tracking/"+encodeURIComponent(order.id))};}
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
    // catalog/orders use Firestore's onSnapshot(), not EventSource - only the
    // tracking stream (still RTDB) needs that check, and it makes its own
    // (see ensureTrackingWatcher).
    if (!state.session || !state.online) return;
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
      // The Firebase Auth SDK restores a persisted session asynchronously
      // (from IndexedDB) - fbAuth.currentUser can still be null for a moment
      // after script load even for an already-signed-in user. Waiting for
      // onAuthStateChanged's first callback avoids treating that startup gap
      // as a real sign-out.
      const authUser=await new Promise(resolve=>{const unsubscribe=fbAuth.onAuthStateChanged(user=>{unsubscribe();resolve(user)})});
      if(!authUser)throw new Error("AUTH_REQUIRED");
      applyAuthUser(authUser);
      await ensureSession();
      perfLog("AUTH_SESSION_READY",authStarted,{});
      const profilePromise=syncProfile(false).then(()=>{migrateSavedAddresses();return true});
      const results=await Promise.allSettled([profilePromise,syncCatalog(),syncOrders(true),syncEmailVerification(),syncSecondaryHomeData()]);
      const failed=results.filter(result=>result.status==="rejected").length;
      if(failed)perfLog("NON_BLOCKING_STARTUP_FAILURES",started,{failed});
      // Not `state.route="home"` here: the only way this line is reached is
      // a signed-in session, which already set state.route to "home" back at
      // line ~1406 before any of the awaits above. If the person tapped into
      // another screen (an order, tracking, a restaurant) while this
      // background sync was still running, forcing "home" here overwrote
      // their navigation the instant this promise settled - the app looked
      // like it "bounced back to home" on the first thing they opened after
      // launch, every time, because that tap almost always landed inside
      // this exact window.
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
  // Without this, an uncaught exception inside an event handler (a form
  // submit, a tap action) is swallowed by the browser with no on-screen
  // trace at all - the WebView's console isn't wired to logcat, so it looks
  // to the user like the tap did nothing. Surfacing it as a toast turns a
  // silent freeze into a diagnosable error message.
  window.addEventListener("error", event=>{toast("App error: "+String(event&&event.message||event),"danger")});
  window.addEventListener("unhandledrejection", event=>{toast("App error: "+String(event&&event.reason&&(event.reason.message||event.reason)||event.reason),"danger")});

  function pageScroller() {
    return document.querySelector("#app > main");
  }
  function currentPageScrollTop() {
    const scroller=pageScroller();
    return scroller ? Number(scroller.scrollTop||0) : Number(window.scrollY||0);
  }
  // Several background syncs on app open (catalog, secondary home data,
  // realtime listeners) can each finish within the same second or two and
  // every one calls render({preserveScroll:true}). The restore below is
  // deferred to the next animation frame, so if two of these renders land
  // close together, the second render's scrollY capture (in render(), via
  // currentPageScrollTop()) can happen AFTER the first render's innerHTML
  // swap already reset scrollTop to 0 but BEFORE that first render's own
  // deferred restore ran - capturing a stale 0 that then gets applied,
  // snapping the page back to the top even though the user never scrolled
  // away. pendingScrollTarget is "where we're about to put the scroll
  // position, if that hasn't happened yet" - render() prefers it over a
  // live DOM read exactly when a restore is still in flight, so a chain of
  // back-to-back renders all agree on the same real position instead of
  // each other's transient post-reset 0.
  let pendingScrollTarget = null;
  function setPageScrollTop(value) {
    const target = Math.max(0, Number(value || 0));
    pendingScrollTarget = target;
    requestAnimationFrame(()=>{
      const scroller=pageScroller();
      if(scroller){scroller.scrollTop=target;}
      else{try{window.scrollTo(0,target)}catch(_){}}
      if(pendingScrollTarget===target)pendingScrollTarget=null;
    });
  }
  function resetPageScroll(){setPageScrollTop(0);}

  // The live map and the order detail are one screen now, reachable as either
  // route, so everything that used to be gated on "tracking" has to accept
  // both - otherwise the map stops receiving tile/pin updates on the route
  // it actually renders on.
  function liveOrderRoute() { return state.route === "order" || state.route === "tracking"; }
  function go(route, data, replace) {
    const wasLive = liveOrderRoute();
    if (!replace && state.route !== route) state.history.push({route:state.route,data:state.routeData});
    state.route = route; state.routeData = data || {};
    if (data && data.restaurantId) state.selectedRestaurantId = data.restaurantId;
    if (data && data.orderId) state.selectedOrderId = data.orderId;
    if (route === "order") state.timelineExpanded = false;
    if (wasLive && !liveOrderRoute()) stopTrackingCollapseCycle();
    if (liveOrderRoute()) startTrackingCollapseCycle();
    closeSheet();
    render(); resetPageScroll();
  }
  function goBack() {
    const wasLive = liveOrderRoute();
    const previous = state.history.pop();
    if (previous) {
      state.route = previous.route; state.routeData = previous.data || {};
      if (wasLive && !liveOrderRoute()) stopTrackingCollapseCycle();
      if (liveOrderRoute()) startTrackingCollapseCycle();
      closeSheet(); render(); resetPageScroll(); return true;
    }
    if (wasLive) stopTrackingCollapseCycle();
    if (["home","orders","offers","account"].includes(state.route)) return false;
    state.route = state.session ? "home" : "login"; state.routeData={}; closeSheet(); render(); return true;
  }
  window.handleAndroidBack = function () {
    if (state.sheet) { closeSheet(); return "handled"; }
    return goBack() ? "handled" : "root";
  };

  function locationReady(){
    try{ return !!(window.FeastlyNative && typeof FeastlyNative.isLocationReady==="function" && FeastlyNative.isLocationReady()); }
    catch(_){ return false; }
  }
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

  function addressIsPinned(address){
    return !!(address&&Number.isFinite(Number(address.lat))&&Number.isFinite(Number(address.lng)));
  }
  // Fails closed once the delivery address has a pin: a restaurant we cannot
  // locate cannot be promised a delivery, and showing it only leads the
  // customer to build a cart the server then refuses at checkout. Before a pin
  // exists nothing can be measured, so everything stays visible and the app's
  // existing "add a map pin" prompt is what moves the customer forward.
  function restaurantServiceable(r) {
    if(!addressIsPinned(currentAddress()))return true;
    const d=restaurantDistanceKm(r);
    if(d==null)return false;
    return d<=deliveryRadiusKm(r);
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
  // ---- offers -----------------------------------------------------------
  // The discount maths below mirrors calculateDiscount() in
  // functions/src/services/catalog.ts exactly. The server decides what is
  // actually charged, so any figure shown here that disagrees with it quotes
  // the customer one price and bills another. Two divergences were live: a
  // missing cap fell back to 99999 here but to the subtotal on the server,
  // and a promotion saved with maxDiscount:0 showed a discount here while the
  // server correctly gave none.
  function roundMoney(value){return Math.round((Number(value)+Number.EPSILON)*100)/100;}
  function promotionMinimum(promotion){return promotion&&promotion.minimumOrderPaise!=null?Number(promotion.minimumOrderPaise)/100:Number(promotion&&promotion.minimumOrder||0)}
  function promotionDiscount(promotion,subtotal){
    if(!promotion)return 0;
    // Same maths as the server: flat or percentage, capped, never more than the food.
    const capPaise=promotion.maxDiscountPaise!=null?Number(promotion.maxDiscountPaise):Math.round(Number(promotion.maxDiscount)*100);
    const raw=promotion.kind==="flat"?Number(promotion.flatAmountPaise||0)/100:subtotal*Number(promotion.percent||0)/100;
    const capped=Number.isFinite(capPaise)&&capPaise>0?Math.min(raw,capPaise/100):raw;
    return roundMoney(Math.max(0,Math.min(subtotal,capped)));
  }
  /** Who pays for the offer, in the customer's words. */
  function promotionSponsor(promotion){if(!promotion)return"";const f=promotion.fundingSource||"restaurant";if(f==="platform")return"Scraveit offer";if(f==="shared")return"Scraveit and restaurant offer";const rid=(promotion.restaurantIds||[])[0],r=rid&&restaurant(rid);return r?"Offer from "+r.name:"Restaurant offer"}
  /** Whether this account can still claim a first-order offer. Fails closed:
   *  until the order list has actually been read back for THIS account, a
   *  returning customer on a fresh install looks identical to a new one, and
   *  offering them a first-order code only to have the server reject it would
   *  fail their whole order. */
  function firstOrderOfferAvailable(){
    const uid=String(state.session&&state.session.uid||"");
    if(!uid||!state.ordersHydrated||state.ordersHydratedUid!==uid)return false;
    return state.orders.length===0;
  }
  function promotionEligible(promotion,restaurantId,subtotal,now){
    if(!promotion||promotion.active!==true)return false;
    if(promotion.approvalStatus==="pending"||promotion.approvalStatus==="rejected")return false;
    if(promotion.startsAt&&Number(now)<Number(promotion.startsAt))return false;
    if(promotion.expiresAt&&Number(now)>Number(promotion.expiresAt))return false;
    if(promotion.firstOrderOnly===true&&!firstOrderOfferAvailable())return false;
    if(promotionMinimum(promotion)&&subtotal<promotionMinimum(promotion))return false;
    if(promotion.budgetPaise&&promotion.fundingSource!=="restaurant"&&Number(promotion.usedBudgetPaise||0)>=Number(promotion.budgetPaise))return false;
    // An empty restaurantIds list means "every restaurant", which is how the
    // server reads it. Treating it as "no restaurant" silently hid offers.
    const scoped=Array.isArray(promotion.restaurantIds)?promotion.restaurantIds:[];
    return !(scoped.length&&!scoped.includes(restaurantId));
  }
  function bestOfferFor(restaurantId,subtotal,now){
    let best=null,bestValue=0;
    (state.promotions||[]).forEach(promotion=>{
      if(!promotionEligible(promotion,restaurantId,subtotal,now))return;
      const value=promotionDiscount(promotion,subtotal);
      if(value>bestValue){best=promotion;bestValue=value;}
    });
    return best;
  }
  /** Highest advertised discount for a restaurant while browsing, where there
   *  is no cart yet - so a minimum-order rule cannot be checked and is instead
   *  enforced and shown once the customer has items. */
  function restaurantOfferPercent(restaurant){
    let best=0;
    (state.promotions||[]).forEach(promotion=>{
      if(!promotionEligible(promotion,restaurant&&restaurant.id,Infinity,Date.now()))return;
      const percent=Number(promotion.percent||0);
      if(percent>best)best=percent;
    });
    return best;
  }
  /** A customer should not have to know a code exists to get the best price.
   *  A code they typed themselves always wins, and an offer they removed stays
   *  removed until they change restaurant or empty the cart. */
  function refreshAutoOffer(){
    if(!state.cart.length){state.coupon=null;state.couponAuto=false;state.couponDismissedFor="";return;}
    const restaurantId=state.cart[0].restaurantId;
    if(state.coupon&&!state.couponAuto)return;
    if(state.couponDismissedFor&&state.couponDismissedFor===restaurantId)return;
    const best=bestOfferFor(restaurantId,cartSubtotal(),Date.now());
    if(!best){if(state.couponAuto){state.coupon=null;state.couponAuto=false;}return;}
    if(state.coupon&&state.coupon.code===best.code)return;
    state.coupon=best;state.couponAuto=true;
  }
  function eligibleCoupon(){
    if(!state.coupon||!state.cart.length)return null;
    return promotionEligible(state.coupon,state.cart[0].restaurantId,cartSubtotal(),Date.now())?state.coupon:null;
  }
  /** The server's own answer for this exact cart and code, when it has one:
   *  it applies the profitability cap and who-pays split the order will get. */
  function serverOffer(){const coupon=eligibleCoupon(),p=state.dynamicPricing&&state.dynamicPricing.offer;if(!coupon||!p||p.valid!==true||String(p.code)!==String(coupon.code)||Math.abs(Number(p.subtotal)-cartSubtotal())>0.001)return null;return p}
  function discount(){const server=serverOffer();return server?Math.max(0,Number(server.discount||0)):promotionDiscount(eligibleCoupon(),cartSubtotal());}
  function tax(){return Math.max(0,(cartSubtotal()-discount())*Number(state.settings.taxRate||0)/100);}
  function smallOrderFee(){return state.settings.smallOrderFeeEnabled===true&&cartSubtotal()>0&&cartSubtotal()<Number(state.settings.smallOrderThreshold||149)?Math.max(0,Number(state.settings.smallOrderFee||19)):0;}
  function lateNightFee(){if(state.settings.lateNightFeeEnabled!==true)return 0;const hNow=new Date().getHours(),start=Number(state.settings.lateNightStartHour==null?23:state.settings.lateNightStartHour),end=Number(state.settings.lateNightEndHour==null?5:state.settings.lateNightEndHour),active=start>end?(hNow>=start||hNow<end):(hNow>=start&&hNow<end);return active?Math.max(0,Number(state.settings.lateNightFee||19)):0;}
  function rainFee(){return Math.max(0,Number(state.dynamicPricing&&state.dynamicPricing.rainFee||0));}
  function surgeFee(){return Math.max(0,Number(state.dynamicPricing&&state.dynamicPricing.surgeFee||0));}
  function riderIncentiveFee(){return Math.max(0,Number(state.dynamicPricing&&state.dynamicPricing.riderIncentiveFee||0));}
  function riderIncentiveItems(){return(state.dynamicPricing&&Array.isArray(state.dynamicPricing.riderIncentiveItems))?state.dynamicPricing.riderIncentiveItems:[];}
  /** The server-computed bill, but only while it still matches this exact cart. */
  function serverCheckout(){const c=state.dynamicPricing&&state.dynamicPricing.checkout,coupon=eligibleCoupon();if(!c||c.serverAuthoritative!==true)return null;if(Math.abs(Number(c.subtotalAtRequest)-cartSubtotal())>0.001||String(c.couponAtRequest)!==String(coupon?coupon.code||"":"")||Number(c.tipAtRequest)!==Number(state.tip||0)||c.walletAtRequest!==(state.useWallet===true))return null;return c}
  function orderTotal(){const server=serverCheckout();if(server)return Math.max(0,Number(server.total||0));return Math.max(0,cartSubtotal()+deliveryFee()+platformFee()+smallOrderFee()+lateNightFee()+rainFee()+surgeFee()+riderIncentiveFee()+Number(state.tip||0)+tax()-discount());}
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
      const coupon=eligibleCoupon(),subtotalAtRequest=cartSubtotal();
      const raw=await nativeInvoke("getCheckoutConfiguration",{restaurantId:r.id,addressId:addr.id,items:callableCartItems(),couponCode:coupon?String(coupon.code||""):"",tip:Number(state.tip||0),paymentMethod:state.checkout&&["cod","upi","card"].includes(state.checkout.payment)?state.checkout.payment:"cod",useWallet:state.useWallet===true},{idToken:state.session.idToken,timeoutMs:15000});
      const preview=raw&&typeof raw==="object"&&raw.feePreview&&typeof raw.feePreview==="object"?raw.feePreview:null;
      const offerRaw=raw&&typeof raw==="object"&&raw.offerPreview&&typeof raw.offerPreview==="object"?raw.offerPreview:null;
      const offer=offerRaw?{valid:offerRaw.valid===true,code:String(offerRaw.code||""),subtotal:subtotalAtRequest,discount:Math.max(0,Number(offerRaw.discount||0)),restaurantFunded:Math.max(0,Number(offerRaw.restaurantFunded||0)),platformFunded:Math.max(0,Number(offerRaw.platformFunded||0)),limited:Number(offerRaw.withheldPlatformPaise||0)>0,message:String(offerRaw.message||"")}:null;
      const next=preview?{
        rainFee:Math.max(0,Number(preview.rainFee||0)),
        surgeFee:Math.max(0,Number(preview.surgeFee||0)),
        riderIncentiveFee:Math.max(0,Number(preview.riderIncentiveFee||0)),
        riderIncentiveItems:Array.isArray(preview.riderIncentiveItems)?preview.riderIncentiveItems.map(x=>({label:String(x&&x.label||"Surge fee"),amount:Math.max(0,Number(x&&x.amount||0))})).filter(x=>x.amount>0):[],
        weatherSeverity:String(preview.weatherSeverity||""),weatherChecked:true,activeOrders:Math.max(0,Number(preview.activeOrders||0)),
        serverAuthoritative:true,checkedAt:Date.now(),offer,
        // The server's own bill for exactly this cart, coupon, tip and wallet choice.
        checkout:raw&&raw.checkoutPreview&&typeof raw.checkoutPreview==="object"?Object.assign({},raw.checkoutPreview,{subtotalAtRequest:subtotalAtRequest,couponAtRequest:coupon?String(coupon.code||""):"",tipAtRequest:Number(state.tip||0),walletAtRequest:state.useWallet===true}):null
      }:fallback;
      state.dynamicPricing=next;
      return next;
    }catch(_){
      state.dynamicPricing=fallback;
      return fallback;
    }
  }
  function maskPhoneNumbers(value){return String(value||"").replace(/(?:\+?91[\s.()-]*)?[6-9](?:[\s.()-]*\d){9}/g,"[phone number hidden]")}
  async function openOrderChat(o,channel,title){if(!o)return;try{const snap=await orderChatQuery(o.id,channel).orderBy("at","asc").get();state.chat={orderId:o.id,channel,messages:snap.docs.map(doc=>doc.data()),title:title||"Order chat"};go("chat",{orderId:o.id,channel})}catch(e){toast("Chat could not open. "+friendlyError(e),"danger")}}
  async function sendOrderChat(form){const o=state.orders.find(x=>x.id===state.chat.orderId),original=String(new FormData(form).get("message")||"").trim();if(!o||!original)return;const body=maskPhoneNumbers(original).slice(0,800),id=uid("m_").replace(/-/g,""),record={id,orderId:o.id,customerId:state.session.uid,restaurantId:o.restaurantId||"",riderId:o.riderId||"",channel:state.chat.channel,senderId:state.session.uid,senderRole:"customer",body,masked:body!==original,at:Date.now()};try{await orderChatMessageDoc(o.id,state.chat.channel,id).set(record);state.chat.messages.push(record);form.reset();render({preserveScroll:true});if(record.masked)toast("A phone number was hidden for privacy.","success")}catch(e){toast("Message could not be sent. "+friendlyError(e),"danger")}}


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
      image:safeUrl(item.imageThumb||item.image,r.imageThumb||r.image), diet:item.diet||"veg", quantity:1,
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
      const credential=tokenType==="id_token"?firebase.auth.GoogleAuthProvider.credential(token):firebase.auth.GoogleAuthProvider.credential(null,token);
      const result=await fbAuth.signInWithCredential(credential),authUser=result.user;
      applyAuthUser(authUser);state.profile.name=authUser.displayName||state.profile.name;state.profile.email=authUser.email||state.profile.email;await afterAuth();
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
    const authUser = fbAuth.currentUser;
    if (!authUser) return false;
    await authUser.reload();
    const verified = !!authUser.emailVerified;
    if(verified)await ensureSession();
    state.profile.emailVerified = verified;
    persistProfile();
    try { await userDoc(state.session.uid).set({emailVerified:verified,updatedAt:Date.now()},{merge:true}); } catch (_) {}
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
    fbAuth.signOut().catch(()=>{});
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
  // The backend now quotes a real delivery window computed from distance,
  // kitchen load, rider supply and peak hour, so this counts that promise
  // down instead of throwing etaMin away and inventing a "+6 min" spread
  // around etaMax. When an order runs past its window it says so rather than
  // showing a number that is already known to be wrong.
  function etaText(order) {
    if(!order)return"";
    if(order.status==="Delivered")return"Delivered";
    if(order.status==="Cancelled")return"Cancelled";
    const promisedMin=Number(order.etaMin||0),promisedMax=Number(order.etaMax||0);
    if(!(promisedMax>0))return"";
    const elapsed=Math.max(0,Math.floor((Date.now()-Number(order.createdAt||Date.now()))/60000));
    const lower=promisedMin-elapsed,upper=promisedMax-elapsed;
    if(upper<=-5)return"Taking longer than expected";
    if(upper<=0)return"Arriving any moment";
    if(lower<=0)return"Under "+upper+" min";
    return lower+"–"+upper+" min";
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

  // ---------------------------------------------------------------------
  // In-place DOM reconciliation.
  //
  // Replacing app.innerHTML wholesale on every render destroys and recreates
  // the <main> scroller and every <img> inside it. That forces the scroll
  // position to be captured and restored around each render (racy, and it
  // interrupts an in-progress touch drag), and it makes already-decoded
  // images re-attach and repaint - which is why background syncs during
  // startup read as the page "pulling" while it is being scrolled.
  //
  // Reconciling instead keeps the scroller element itself alive, so
  // scrollTop is simply never disturbed, and leaves any <img> whose src has
  // not changed completely untouched so it never repaints. Every listener in
  // this file is delegated to #app / document rather than bound per node, so
  // updating nodes in place cannot drop or duplicate handlers.
  // ---------------------------------------------------------------------
  // Routes that manage part of their own DOM imperatively (the tracking map's
  // tiles/markers/transforms, and the search screen's #search-results panel)
  // are rebuilt wholesale exactly as before - reconciling them would fight
  // those hand-written updates.
  const MORPH_BLOCKED_ROUTES = {order:true, tracking:true, search:true};
  const LIVE_VALUE_TAGS = {INPUT:true, TEXTAREA:true, SELECT:true};

  function sameNodeShape(oldNode, newNode) {
    if (oldNode.nodeType !== newNode.nodeType) return false;
    if (oldNode.nodeType !== 1) return true;
    if (oldNode.tagName !== newNode.tagName) return false;
    return (oldNode.getAttribute("id") || "") === (newNode.getAttribute("id") || "");
  }

  function syncAttributes(oldEl, newEl) {
    const next = newEl.attributes;
    for (let i = 0; i < next.length; i++) {
      const name = next[i].name, value = next[i].value;
      // Comparing first matters most for <img src>: re-setting an identical
      // src can restart the image load, which is the repaint we are avoiding.
      if (oldEl.getAttribute(name) !== value) oldEl.setAttribute(name, value);
    }
    const current = oldEl.attributes;
    for (let i = current.length - 1; i >= 0; i--) {
      const name = current[i].name;
      if (!newEl.hasAttribute(name)) oldEl.removeAttribute(name);
    }
  }

  function morphNode(oldNode, newNode) {
    if (oldNode.nodeType !== 1) {
      if (oldNode.nodeValue !== newNode.nodeValue) oldNode.nodeValue = newNode.nodeValue;
      return;
    }
    if (LIVE_VALUE_TAGS[oldNode.tagName]) {
      // What the customer has typed/picked lives on the property, not the
      // attribute, so only follow the attribute when the render actually
      // changed it - otherwise an unrelated background sync would wipe
      // half-entered input.
      const hadValue = oldNode.getAttribute("value"), nextValue = newNode.getAttribute("value");
      const hadChecked = oldNode.hasAttribute("checked"), nextChecked = newNode.hasAttribute("checked");
      syncAttributes(oldNode, newNode);
      if (nextValue !== null && nextValue !== hadValue) oldNode.value = nextValue;
      if (nextChecked !== hadChecked) oldNode.checked = nextChecked;
    } else {
      syncAttributes(oldNode, newNode);
    }
    morphChildren(oldNode, newNode);
  }

  function morphChildren(target, source) {
    let oldNode = target.firstChild, newNode = source.firstChild;
    while (newNode) {
      const nextNew = newNode.nextSibling;
      if (!oldNode) { target.appendChild(newNode); newNode = nextNew; continue; }
      const nextOld = oldNode.nextSibling;
      if (sameNodeShape(oldNode, newNode)) morphNode(oldNode, newNode);
      else target.replaceChild(newNode, oldNode);
      oldNode = nextOld; newNode = nextNew;
    }
    while (oldNode) { const nextOld = oldNode.nextSibling; target.removeChild(oldNode); oldNode = nextOld; }
  }

  let lastRenderedHtml = null;
  let lastRenderedRoute = null;
  function render(options) {
    applyTheme();
    const preserving = !!(options && options.preserveScroll);
    const renderer = SCREENS[state.route] || screenHome;
    const html = renderer();
    // Nothing on screen would change: leave the DOM (and any active gesture)
    // strictly alone.
    if (preserving && html === lastRenderedHtml) { renderSheet(); return; }

    const canMorph = lastRenderedHtml !== null
      && state.route === lastRenderedRoute
      && !MORPH_BLOCKED_ROUTES[state.route]
      && !!app.firstElementChild;
    // Only meaningful when the scroller is about to be destroyed; must be read
    // before any DOM write.
    const scrollY = (!canMorph && preserving)
      ? (pendingScrollTarget !== null ? pendingScrollTarget : currentPageScrollTop())
      : 0;

    lastRenderedHtml = html;
    lastRenderedRoute = state.route;

    if (canMorph) {
      const incoming = document.createElement("div");
      incoming.innerHTML = html;
      morphChildren(app, incoming);
    } else {
      app.innerHTML = html;
    }
    app.setAttribute("aria-busy", state.loading ? "true" : "false");
    // trackingTileMarkup() intentionally renders no tiles (see its comment) so
    // that every tile - including the very first batch - is created the same
    // way, starting hidden and fading in on its own "load" event. "tracking"
    // is in MORPH_BLOCKED_ROUTES, so the branch above just replaced the whole
    // subtree - any <img> elements a previous refreshTrackingTiles() call had
    // built are gone now, even if the map's own pan/zoom didn't change. Force
    // the key stale so refreshTrackingTiles() always rebuilds them against
    // the DOM that actually exists post-write, instead of comparing against
    // a state.trackingMap.tileKey left over from before this rewrite and
    // concluding (wrongly) that nothing needs to be done.
    syncStatusBar();
    if (liveOrderRoute()) {
      if (state.trackingMap) state.trackingMap.tileKey = "";
      refreshTrackingTiles();
      refreshTrackingCarousel();
    }
    renderSheet();
    // After a reconcile the scroller survived untouched, so there is no
    // position to restore - only an explicit non-preserving render still has
    // to send it back to the top.
    if (canMorph) { if (!preserving) setPageScrollTop(0); }
    else setPageScrollTop(scrollY);
  }

  // The window is fitted to the system insets (SOFT_INPUT_ADJUST_RESIZE, which
  // the keyboard handling depends on), so web content cannot be drawn under
  // the status bar. Colour the bar to match the screen instead: the seam
  // disappears without touching the keyboard behaviour.
  const STATUS_BAR_HERO="#0B3F96", STATUS_BAR_CANVAS="#F6F9FD";
  let statusBarApplied="";
  // The live map (restaurant, home, dotted plan line, then the partner) shows
  // from the moment an order is placed, not only once a partner is assigned.
  function orderShowsLiveMap(order){
    if(!order||TERMINAL_STATES.has(order.status))return false;
    const points=trackingGeoPoints(order,state.tracking[order.id]||{});
    return !!(points.restaurantPoint&&points.customerPoint);
  }
  function syncStatusBar(){
    const order=liveOrderRoute()?orderById():null;
    const hero=orderShowsLiveMap(order);
    const dark=document.documentElement.dataset.theme==="dark";
    // The app draws beneath the status bar, so its icons follow what is
    // behind them: white on the blue live hero and on the dark theme.
    const darkIcons=!hero&&!dark;
    const next=(hero?STATUS_BAR_HERO:STATUS_BAR_CANVAS)+(darkIcons?":dark":":light");
    updateStatusScrim(hero);
    if(next===statusBarApplied)return;
    statusBarApplied=next;
    try{ if(window.FeastlyNative&&FeastlyNative.setStatusBarStyle)FeastlyNative.setStatusBarStyle(hero?STATUS_BAR_HERO:STATUS_BAR_CANVAS,darkIcons); }catch(_){}
  }
  // A blurred strip behind the status bar that fades in once the page is
  // scrolled, so the clock and battery never sit on top of moving content.
  let statusScrimHero=false, statusScrimFrame=0;
  function statusScrimElement(){
    let el=document.getElementById("status-scrim");
    if(!el&&document.body){
      el=document.createElement("div");el.id="status-scrim";el.setAttribute("aria-hidden","true");document.body.appendChild(el);
      window.addEventListener("scroll",()=>{if(!statusScrimFrame)statusScrimFrame=requestAnimationFrame(()=>{statusScrimFrame=0;updateStatusScrim(statusScrimHero)})},{passive:true});
    }
    return el;
  }
  function updateStatusScrim(hero){
    statusScrimHero=!!hero;
    const el=statusScrimElement();
    if(!el)return;
    const y=window.scrollY||(document.documentElement&&document.documentElement.scrollTop)||0;
    el.classList.toggle("hero",statusScrimHero);
    el.classList.toggle("visible",y>12);
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
    return '<header class="cluster between home-header"><button class="location-pill" data-action="open-address-picker" aria-label="Change delivery location"><span class="location-dot">'+icon("target")+'</span><span class="location-copy"><span>Deliver to</span><strong>'+(address?h(address.label||address.area):"Choose a location")+'</strong><small>'+h(address&&(address.city||address.area)||(address?"Add a location pin":"Select a saved address"))+'</small></span>'+icon("chevron","small")+'</button><div class="home-header-actions">'+(cartCount()?'<button class="cart-shortcut" data-action="go" data-route="cart" aria-label="Open cart with '+cartCount()+' items">'+icon("cart")+'<span>'+cartCount()+'</span></button>':'')+'<button class="avatar" data-action="go" data-route="account" aria-label="Open account">'+h(initials())+'</button></div></header>';
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
  function activeLocalAds(){
    const now=Date.now(), a=currentAddress()||{}, city=keyName(a.city||a.area), area=keyName(a.area);
    return (state.localAds||[]).filter(ad=>ad&&ad.active!==false&&Number(ad.startAt||0)<=now&&(!ad.endAt||Number(ad.endAt)>=now))
      .filter(ad=>!ad.city||keyName(ad.city)===city).filter(ad=>!ad.area||keyName(ad.area)===area).sort((x,y)=>Number(y.priority||0)-Number(x.priority||0)).slice(0,8);
  }
  function activeLocalAd(){ return activeLocalAds()[0]||null; }
  function localAdMarkup(){const ad=activeLocalAd();if(!ad)return'<section class="card brand-card promo-card"><div><p class="eyebrow" style="color:#bfe9ff">SCRAVEIT STANDARD</p><h2 class="section-title" style="font-size:25px;margin-top:7px">Clear pricing. Careful delivery.</h2><p class="supporting" style="margin-top:8px">Every charge is shown before you place an order.</p></div><span class="promo-code">NO SURPRISES</span></section>';return'<button class="card local-ad" data-action="open-ad" data-ad-id="'+h(ad.id)+'">'+((ad.image||ad.imageUrl)?'<img src="'+h(safeUrl(ad.image||ad.imageUrl,"restaurant-placeholder.svg"))+'" alt="">':'')+'<div class="local-ad-copy"><span class="sponsored-label">Sponsored · '+h(ad.area||ad.city||"Local")+'</span><h2 class="section-title" style="font-size:25px">'+h(ad.title||"Nearby offer")+'</h2><p>'+h(ad.message||"")+'</p><strong>'+h(ad.cta||"Explore")+' →</strong></div></button>'}
  function latestDeliveredNeedingReview(){if(!reviewStateReady())return null;return state.orders.find(o=>o.status==="Delivered"&&!state.reviews[o.id])||null}
  function postDeliveryCard(){const o=latestDeliveredNeedingReview();if(!o)return"";return'<section class="post-order-card"><p class="eyebrow">Delivered</p><h2 class="section-title">How was '+h(o.restaurant||"your order")+'?</h2><p class="supporting">Your rating helps customers, restaurants and delivery partners improve.</p><div class="star-row">'+[1,2,3,4,5].map(n=>'<button class="star-choice" data-action="quick-rate" data-order-id="'+h(o.id)+'" data-rating="'+n+'" aria-label="'+n+' stars">'+icon("star","large")+'</button>').join("")+'</div><button class="button tonal full" data-action="go" data-route="review" data-order-id="'+h(o.id)+'">Rate restaurant & delivery partner</button></section>'}

  function activeOrderCard(order) {
    return '<button class="active-order" data-action="open-order" data-order-id="'+h(order.id)+'"><div class="cluster between"><span class="status-pill" style="background:rgba(255,255,255,.18);color:white">'+h(order.status)+'</span><strong>'+h(etaText(order))+'</strong></div><div><h2 class="section-title">'+h(order.restaurant||"Your order")+'</h2><p class="supporting">'+h((order.items||[]).map(x=>(x.quantity||1)+'× '+x.name).slice(0,2).join(" · "))+'</p></div><div class="status-progress"><span style="width:'+orderProgress(order)+'%"></span></div><div class="cluster between supporting"><span>Order '+h(order.id)+'</span><span>View journey '+icon("chevron","small")+'</span></div></button>';
  }
  function discoveryItems(restaurant){return restaurant&&restaurant.menuLoaded?(restaurant.menu||[]):(restaurant&&restaurant.menuIndex||[])}
  // -----------------------------------------------------------------------
  // Browse categories.
  //
  // Every chip is derived from what the catalogue actually contains and is
  // counted with the same rule the filter uses, so a category can never be
  // offered that leads to an empty screen. This previously hard-coded
  // Biryani/Fried Rice/Dosa/Pizza/Burgers/Desserts unconditionally, so a
  // customer could tap food nobody sells and land on "No restaurants match".
  //
  // Labels are taken only from the fields that describe a restaurant's food
  // (its cuisine tags and category). Menu-section names still count towards a
  // category's matches - the filter matches them - but are never offered as a
  // chip of their own: across a large catalogue they collapse into generic
  // sections ("Starters", "Main Course", the default "Menu") that nobody
  // browses by, and they would crowd out real cuisines.
  // -----------------------------------------------------------------------
  const NON_BROWSABLE_CATEGORY_KEYS = {
    "multi-cuisine":true,"multicuisine":true,"restaurant":true,"restaurants":true,
    "menu":true,"food":true,"foods":true,"other":true,"others":true,"misc":true,
    "miscellaneous":true,"general":true,"default":true,"uncategorized":true,
    "uncategorised":true,"none":true,"na":true,"n-a":true,"test":true,
  };
  const MAX_CATEGORY_CHIPS = 14;

  /** A cuisine worth offering, or null for placeholder/meaningless values. */
  function browsableCategory(value) {
    const label=String(value==null?"":value).trim().replace(/\s+/g," ");
    const key=keyName(label);
    if(!key||NON_BROWSABLE_CATEGORY_KEYS[key])return null;
    // Two characters or fewer, or nothing alphabetic at all, is placeholder
    // data ("Gg", "--", "1") rather than something a customer would tap.
    if(label.length<3||!/[a-z]/i.test(label))return null;
    return {key,label};
  }

  /** Restaurants reachable from the saved address, before any chip or toggle
   *  is applied. Mirrors the address scoping inside restaurantsFiltered(). */
  function restaurantsAtAddress() {
    let list=Object.values(state.catalog).filter(r=>r.archived!==true);
    const address=currentAddress();
    const pinned=!!(address&&Number.isFinite(Number(address.lat))&&Number.isFinite(Number(address.lng)));
    // Once pinned, restaurantServiceable() below is the real, distance-based
    // answer to "can this reach the customer" - a restaurant's own city field
    // and the customer's own address city field are two independently typed
    // strings for the same real place (a GPS geocoder and a restaurant owner
    // rarely spell a town identically - "Naidupet" vs "Naidupeta" is a real
    // one this app hit) and requiring them to match exactly hid a restaurant
    // that was genuinely next door. Without a pin there is no distance to
    // check yet, so the city string is the only scoping available.
    if(!pinned){
      const customerCity=keyName(address&&address.city||"");
      if(customerCity){
        const cityTagged=list.some(r=>keyName(r.city||""));
        if(cityTagged)list=list.filter(r=>!keyName(r.city||"")||keyName(r.city)===customerCity);
      }
    }
    if(pinned)list=list.filter(restaurantServiceable);
    return list;
  }

  let categoryCache={signature:null,list:[]};
  function browsableCategories() {
    const list=restaurantsAtAddress(),address=currentAddress()||{};
    // Counting walks every menu, which is wasted work on the many renders
    // where nothing about the catalogue changed. The signature covers only
    // restaurants, so it stays cheap as the catalogue grows.
    let signature=keyName(address.city||"")+"|"+(address.lat||"")+","+(address.lng||"")+"|"+list.length;
    for(let i=0;i<list.length;i++)
      signature+="|"+list[i].id+":"+(list[i].updatedAt||0)+":"+(list[i].menuLoaded?1:0);
    if(signature===categoryCache.signature)return categoryCache.list;

    const counts={},labels={};
    list.forEach(r=>{
      const matched={};
      const offer=value=>{
        const category=browsableCategory(value);
        if(!category)return;
        if(!labels[category.key])labels[category.key]=category.label;
        matched[category.key]=true;
      };
      (r.cuisines||[]).forEach(offer);
      offer(r.category);
      // Counted, never labelled - see the note above.
      discoveryItems(r).forEach(item=>{
        const key=keyName(item&&item.category||"");
        if(key&&!NON_BROWSABLE_CATEGORY_KEYS[key])matched[key]=true;
      });
      Object.keys(matched).forEach(key=>{counts[key]=(counts[key]||0)+1;});
    });

    const result=Object.keys(labels)
      .filter(key=>counts[key]>0)
      .map(key=>({key,label:labels[key],count:counts[key]}))
      .sort((left,right)=>right.count-left.count||left.label.localeCompare(right.label))
      .slice(0,MAX_CATEGORY_CHIPS);
    categoryCache={signature,list:result};
    return result;
  }

  function categoryChipsHtml() {
    const categories=browsableCategories();
    // A single category cannot narrow anything down, so the row would only be
    // noise. It appears by itself once the catalogue carries more than one.
    if(categories.length<2)return"";
    // Counts only earn their space once they actually tell categories apart.
    const showCounts=categories.some(category=>category.count>1);
    const chip=(value,label,count)=>'<button class="chip '+(keyName(state.cuisine)===keyName(value)?'active':'')
      +'" data-action="cuisine" data-value="'+h(value)+'">'+h(label)
      +(count?'<span class="chip-count">'+h(count)+'</span>':'')+'</button>';
    return '<div class="chip-row">'+chip("All","All",0)
      +categories.map(category=>chip(category.label,category.label,showCounts?category.count:0)).join("")+'</div>';
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
  // Previously badged a restaurant whenever any active promotion existed,
  // ignoring expiry and restaurant scoping - so a long-expired offer kept
  // advertising itself. promotionEligible() applies the same rules the server
  // uses to honour the code.
  function restaurantHasOffer(r){
    return !!(r.offer||r.discount||r.offerText||restaurantOfferPercent(r)>0);
  }
  function restaurantOfferLabel(r){
    const percent=restaurantOfferPercent(r);
    if(percent>0)return Math.round(percent)+"% OFF";
    return restaurantHasOffer(r)?"Offer":"";
  }
  function restaurantsFiltered() {
    // While searching, the server's city-wide name matches join the pages
    // already on the device. Every filter below still applies to them, so a
    // restaurant found this way is still only shown if it is deliverable.
    const source=state.route==="search"&&searchKey(state.query)&&Object.keys(state.searchCatalog).length
      ? Object.assign({},state.catalog,state.searchCatalog)
      : state.catalog;
    let list=Object.values(source).filter(r=>r.archived!==true);

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
    const pinned=!!(address
      &&Number.isFinite(Number(address.lat))
      &&Number.isFinite(Number(address.lng)));

    // Once pinned, restaurantServiceable() below is the real, distance-based
    // gate - see the matching comment in restaurantsAtAddress() for why a
    // customer's and a restaurant's independently-typed city strings must
    // not be required to match exactly once there is a real distance to
    // check instead.
    if(!pinned){
      const customerCity=keyName(address&&address.city||"");
      if(customerCity){
        const cityTagged=list.some(r=>keyName(r.city||""));
        if(cityTagged)list=list.filter(r=>!keyName(r.city||"")||keyName(r.city)===customerCity);
      }
    }

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
  function restaurantCard(r,horizontal){const liked=(state.profile.favourites||[]).includes(r.id),distance=restaurantDistanceKm(r),fee=deliveryFeeForRestaurant(r,0),distanceText=distance==null?"":distance.toFixed(distance<10?1:0)+" km",rating=ratingForRestaurant(r),ratingText=rating.value?rating.value.toFixed(1):"New";return'<article class="restaurant-card '+(horizontal?'horizontal':'')+'" data-action="open-restaurant" data-restaurant-id="'+h(r.id)+'" tabindex="0" role="button" aria-label="Open '+h(r.name)+'"><div class="restaurant-media"><img src="'+h(safeUrl(r.imageThumb||r.image,"restaurant-placeholder.svg"))+'" alt="'+h(r.name)+'" loading="lazy" decoding="async" fetchpriority="auto" onerror="this.onerror=null;this.src=\'restaurant-placeholder.svg\'"><span class="media-badge">'+(r.open?'Open':'Closed')+'</span><button class="heart-button '+(liked?'liked':'')+'" data-action="toggle-favourite" data-restaurant-id="'+h(r.id)+'" aria-label="'+(liked?'Remove from':'Add to')+' favourites">'+icon("heart")+'</button></div><div class="restaurant-copy"><div class="restaurant-title-row"><h3 class="card-title restaurant-name">'+h(r.name)+'</h3><span class="rating compact">'+icon("star","small")+'<strong>'+h(ratingText)+'</strong></span></div><div class="cluster wrap restaurant-badges">'+(isPureVegRestaurant(r)?'<span class="pure-veg-badge">Pure veg</span>':'')+(restaurantOfferLabel(r)?'<span class="offer-badge">'+h(restaurantOfferLabel(r))+'</span>':'')+'<span class="rating-caption">'+h(rating.label)+'</span></div><p class="supporting restaurant-cuisines">'+h((r.cuisines||[]).join(" · "))+'</p><div class="restaurant-meta"><span>'+icon("clock","small")+' '+h(r.etaMin||25)+'–'+h(r.etaMax||35)+' min</span>'+(distanceText?'<span>'+icon("pin","small")+' '+h(distanceText)+'</span>':'')+'<span>'+(fee===0?'Free delivery':money(fee)+' delivery')+'</span></div></div></article>'}
  function homeSkeletonMarkup(){return'<section class="stack" aria-label="Loading restaurants"><div class="skeleton skeleton-line wide"></div><div class="restaurant-list"><div class="restaurant-card horizontal home-skeleton-card"><div class="skeleton home-skeleton-image"></div><div class="restaurant-copy stack"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line"></div></div></div><div class="restaurant-card horizontal home-skeleton-card"><div class="skeleton home-skeleton-image"></div><div class="restaurant-copy stack"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line"></div></div></div></div><p class="caption">Finding restaurants for this saved address…</p></section>'}
  function menuSkeletonMarkup(){return'<section class="stack" aria-label="Loading menu"><div class="skeleton skeleton-line wide"></div><div class="menu-list"><div class="menu-item"><div class="menu-copy stack"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line"></div></div><div class="skeleton home-skeleton-image"></div></div><div class="menu-item"><div class="menu-copy stack"><div class="skeleton skeleton-line wide"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line"></div></div><div class="skeleton home-skeleton-image"></div></div></div><p class="caption">Loading this restaurant\'s menu…</p></section>'}
  function screenHome() {
    if(!state.catalogLoaded)return '<main class="screen"><div class="screen-content page-stack">'+homeHeader()+homeSkeletonMarkup()+'</div>'+nav()+'</main>';
    if(state.homeStatus==="errorWithoutCache")return'<main class="screen"><div class="screen-content page-stack">'+homeHeader()+emptyState("warning","Restaurants could not be loaded","Check your connection and try again. Your saved address is still selected.","refresh","Retry")+'</div>'+nav()+'</main>';
    const active=activeOrders()[0], restaurants=restaurantsFiltered(),recommended=restaurants.slice(0,3),address=currentAddress();
    if(!state.homeVisibleLogged){state.homeVisibleLogged=true;perfLog("HOME_RESTAURANTS_VISIBLE",state.homeBootStartedAt,{source:state.catalogMode,restaurants:restaurants.length,scope:homeScope(address)})}
    if(!state.locationPromptShown&&!locationReady()){state.locationPromptShown=true;setTimeout(()=>{if(state.route==="home"&&!state.sheet)setSheet({type:"addressPicker"})},0)}
    return '<main class="screen '+(cartCount()?'has-floating-cart':'')+'"><div class="screen-content page-stack">'+networkBanner()+homeHeader()+(locationReady()?'':'<div class="notice warning">'+icon("target","small")+'<div><strong>Location is off</strong><div class="caption">Turn it on for accurate address detection and faster delivery.</div></div><button class="text-button" data-action="detect-location">Enable</button></div>')
      +'<section class="home-lead"><p class="eyebrow">'+(new Date().getHours()<12?'Good morning':new Date().getHours()<17?'Good afternoon':'Good evening')+'</p><h1 class="display">What tastes good, '+h(firstName())+'?</h1><p class="supporting">Showing restaurants in '+h(address&&address.city||"your selected city")+'</p></section>'
      +(address&&address.needsLocationPin?'<div class="notice warning">'+icon("pin","small")+'<div><strong>Add a map pin to this saved address</strong><div class="caption">Browsing works now. A pin is required only before checkout.</div></div><button class="text-button" data-action="go" data-route="addresses">Update</button></div>':'')
      +(active?activeOrderCard(active):postDeliveryCard())
      +'<button class="search-trigger" data-action="go" data-route="search">'+icon("search")+'<span>Search dishes, restaurants or cuisines</span></button>'
      +'<div class="home-promo">'+localAdMarkup()+'</div>'
      +'<section class="stack">'
      // The heading only earns its place when there is something under it to
      // browse; the filter row below stands on its own either way.
      +(categoryChipsHtml()?'<div class="cluster between"><h2 class="section-title">Browse categories</h2><button class="text-button" data-action="go" data-route="search">See all</button></div>'+categoryChipsHtml():'')
      +'<div class="chip-rowdiscovery-filters"><button class="chip" data-action="open-filters">'+icon("filter","small")+' Filters</button><button class="chip '+(state.homeFilter==="under250"?'active':'')+'" data-action="home-filter" data-value="under250">Under ₹250</button><button class="chip '+(state.homeFilter==="offers"?'active':'')+'" data-action="home-filter" data-value="offers">Offers</button><button class="chip '+(state.homeFilter==="pureveg"?'active':'')+'" data-action="home-filter" data-value="pureveg">Pure veg</button></div></section>'
      +'<section class="stack"><div class="cluster between"><div><h2 class="section-title">Recommended for you</h2><p class="supporting">Nearby, open and highly rated first</p></div><button class="text-button" data-action="go" data-route="search">View all</button></div>'+(recommended.length?'<div class="restaurant-list">'+recommended.map(r=>restaurantCard(r,true)).join("")+'</div>':emptyState("search","No matches in this city","Try another address, category or filter.","open-filters","Change filters"))+'</section>'
      +'<section class="stack"><div class="cluster between rating-view-row"><div><h2 class="section-title">All restaurants</h2><p class="supporting">'+restaurants.length+' available for this address</p></div><button class="rating-toggle" data-action="toggle-rating-view" aria-label="Switch restaurant rating view"><span>My rating</span><span class="toggle-track '+(state.ratingView==="overall"?'on':'')+'"><i></i></span><span>Overall</span></button></div>'
      +(restaurants.length?'<div class="restaurant-list">'+restaurants.map(r=>restaurantCard(r,true)).join("")+'</div>':emptyState("search","No restaurants are live","Choose another saved address or clear the filters.","open-filters","Change filters"))
      +((state.homeStatus==="refreshing"||state.loading)&&restaurants.length?loadingRow("Refreshing restaurants in the background…"):"")
      // Only offered when the server actually has another page for this city,
      // so it never appears at the end of a short catalogue.
      +(state.catalogHasMore?(state.catalogLoadingMore
        ?loadingRow("Loading more restaurants…")
        :'<button class="button secondary full" data-action="load-more-restaurants">Show more restaurants</button>'):"")+'</section>'
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
    // Saying "nothing matched" before the city-wide lookup has answered would
    // be wrong for exactly the restaurants this lookup exists to find.
    if(state.searchLoading)return loadingRow("Searching restaurants near you…");
    if(searchKey(state.query))return emptyState("search","Nothing matched","Try another dish, cuisine or spelling.","clear-search","Clear search");
    if(state.cuisine!=="All"||state.diet!=="all"||state.homeFilter!=="all")return emptyState("search","No restaurants match these filters","Change a category or filter to see more results.","open-filters","Change filters");
    return emptyState("search","No restaurants are available","Retry the live catalogue or choose another saved address.","refresh","Retry");
  }
  function searchContentMarkup(){return recentSearchMarkup()+searchResultMarkup();}
  function screenSearch() {
    return '<main class="screen"><div class="screen-content page-stack">'+topbar("Find your next meal","Search live menus, cuisines and restaurants.",'<button class="icon-button" data-action="open-filters" aria-label="Open filters">'+icon("filter")+'</button>')+networkBanner()
      +'<div class="input-wrap"><span class="input-icon">'+icon("search")+'</span><input id="search-input" class="input with-icon with-action" value="'+h(state.query)+'" placeholder="Try waffles, desserts or ice cream" autocomplete="off" enterkeyhint="search" aria-label="Search"><button class="icon-button flat input-action" data-action="clear-search" aria-label="Clear search">'+icon("close")+'</button></div>'
      +categoryChipsHtml()
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
      return '<article class="menu-item"><div class="menu-copy"><span class="diet-mark '+(item.diet==="nonveg"?'nonveg':'')+'" aria-label="'+(item.diet==="nonveg"?'Non-vegetarian':'Vegetarian')+'"></span><h3 class="card-title">'+h(item.name)+'</h3><strong>'+money(item.price)+'</strong><p class="supporting">'+h(item.description||"")+'</p>'+(item.popular?'<span class="caption success-text">Popular choice</span>':'')+(item.available===false?'<span class="caption danger-text">Unavailable right now</span>':'')+'</div><div class="menu-media"><img src="'+h(safeUrl(item.imageThumb||item.imageUrl||item.image,r.imageThumb||r.image))+'" alt="'+h(item.name)+'" loading="lazy" decoding="async" onerror="this.onerror=null;this.src=\''+h(safeUrl(r.imageThumb||r.image,"restaurant-placeholder.svg"))+'\'">'+(item.available===false?'':inCart?'<button class="add-button" data-action="open-item" data-restaurant-id="'+h(r.id)+'" data-item-id="'+h(item.id)+'">'+inCart+' in cart · Edit</button>':'<button class="add-button" data-action="open-item" data-restaurant-id="'+h(r.id)+'" data-item-id="'+h(item.id)+'">ADD +</button>')+'</div></article>';
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
  /** One line per funder, so a saving is never shown as Scraveit's when the
   *  restaurant is paying for it, or the other way round. */
  function discountRows(){const server=serverOffer(),code=h(state.coupon.code);if(server&&server.restaurantFunded>0&&server.platformFunded>0)return'<div class="price-row success-text"><span>'+code+' · restaurant offer</span><span>−'+money(server.restaurantFunded)+'</span></div><div class="price-row success-text"><span>'+code+' · Scraveit offer</span><span>−'+money(server.platformFunded)+'</span></div>'+(server.limited?limitedOfferNote():'');const label=server?(server.platformFunded>0?"Scraveit offer":"Restaurant offer"):promotionSponsor(state.coupon);return'<div class="price-row success-text"><span>'+code+' · '+h(label)+'</span><span>−'+money(discount())+'</span></div>'+(server&&server.limited?limitedOfferNote():'')}
  function walletRows(){const server=serverCheckout();const used=server?Number(server.walletRedeem||0):0;return used>0?'<div class="price-row success-text"><span>Paid from wallet</span><span>−'+money(used)+'</span></div>':''}
  function cashbackRow(){const server=serverCheckout(),c=server&&server.cashbackEstimate;return c&&Number(c.amount)>0?'<p class="caption success-text">You will get '+money(c.amount)+' cashback ('+h(c.title)+') in your wallet after delivery.</p>':''}
  function walletToggle(){const server=serverCheckout(),balance=server?Number(server.walletBalance||0):walletBalance()/100,max=server?Number(server.walletMaxForOrder||0):0;if(balance<=0)return"";return'<section class="card"><button class="settings-row" data-action="toggle-wallet"><span class="settings-icon">'+icon("wallet")+'</span><span class="grow"><strong>Use wallet balance</strong><span class="supporting">'+money(balance)+' available'+(server&&max<=0?' · this order is below the minimum for wallet use':'')+'</span></span><span class="switch '+(state.useWallet?'on':'')+'" aria-hidden="true"></span></button></section>'}
  function limitedOfferNote(){return'<p class="caption">This offer is capped on this order. The discount shown is exactly what you will get.</p>'}
  function priceBreakdown(includeTotal){return'<div class="stack"><div class="price-row"><span>Item subtotal</span><span>'+money(cartSubtotal())+'</span></div>'+(discount()?discountRows():'')+'<div class="price-row"><span>Estimated delivery fee</span><span>'+(deliveryFee()?money(deliveryFee()):'<span class="success-text">Free</span>')+'</span></div>'+(rainFee()>0?'<div class="price-row"><span>Verified rain fee</span><span>'+money(rainFee())+'</span></div>':'')+(surgeFee()>0?'<div class="price-row"><span>Demand surge fee</span><span>'+money(surgeFee())+'</span></div>':'')+riderIncentiveItems().map(item=>'<div class="price-row"><span>'+h(item.label)+'</span><span>'+money(item.amount)+'</span></div>').join("")+(smallOrderFee()>0?'<div class="price-row"><span>Estimated small-order fee</span><span>'+money(smallOrderFee())+'</span></div>':'')+(lateNightFee()>0?'<div class="price-row"><span>Estimated late-night fee</span><span>'+money(lateNightFee())+'</span></div>':'')+'<div class="price-row"><span>Platform fee</span><span>'+money(platformFee())+'</span></div>'+(tax()?'<div class="price-row"><span>Estimated taxes</span><span>'+money(tax())+'</span></div>':'')+(state.tip?'<div class="price-row"><span>Delivery partner tip<small class="caption" style="display:block">100% goes to your delivery partner</small></span><span>'+money(state.tip)+'</span></div>':'')+walletRows()+(includeTotal?'<div class="price-row total"><span>'+(serverCheckout()?'To pay':'Estimated total')+'</span><span>'+money(orderTotal())+'</span></div>'+cashbackRow():'')+'</div>'}
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
      +(state.cart.length?'<section class="card stack-lg">'+state.cart.map(cartItemMarkup).join("")+'<button class="text-button" data-action="open-restaurant" data-restaurant-id="'+h(r.id)+'">+ Add more from '+h(r.name)+'</button></section><section class="card stack"><h2 class="section-title">Savings</h2>'+(eligibleCoupon()?'<div class="applied-offer"><div class="grow"><strong>'+h(state.coupon.code)+' · you save '+money(discount())+'</strong><div class="caption">'+(state.couponAuto?'Best available offer, applied for you':'Offer applied')+'</div></div><button class="text-button" data-action="remove-coupon">Remove</button></div>':'')+'<div class="coupon-row"><input id="coupon-input" class="input" placeholder="Enter offer code" value="'+h(state.coupon&&state.coupon.code||"")+'"><button class="button secondary" data-action="apply-coupon">Apply</button></div><p class="caption">Only live, eligible Scraveit promotions can be applied.</p></section><section class="card">'+priceBreakdown(true)+'</section><button class="button primary full" data-action="go-checkout" '+(!state.online?'disabled':'')+'>Continue to checkout · '+money(orderTotal())+'</button>':emptyState("cart","Your cart is empty","Browse restaurants and add something you will enjoy.","go-home","Explore restaurants"))+'</div>'+nav()+'</main>';
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
      +walletToggle()+'<section class="card">'+priceBreakdown(true)+'</section><div class="notice info">'+icon("shield","small")+'<span>The secure Scraveit server validates menu prices, discounts, distance and any weather or demand fee. The server-confirmed order total replaces this estimate in your final receipt.</span></div>'
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
    const full=ORDER_FLOW.filter((status,index)=>index<=Math.max(current+1,3)||index===ORDER_FLOW.length-1);
    // Every stage keeps its own full-height, timestamped row, so once an
    // order has moved through several of them this card gets very long.
    // Collapse everything before the most recent few stages behind a toggle
    // by default - the page opens short, and the complete history (still
    // useful for support disputes etc.) is one tap away, not lost.
    const RECENT_STEPS=3;
    const hiddenCount=Math.max(0,full.length-RECENT_STEPS);
    const expanded=!!state.timelineExpanded;
    const visible=(!cancelled&&hiddenCount>0&&!expanded)?full.slice(full.length-RECENT_STEPS):full;
    const toggle=(!cancelled&&hiddenCount>0)?'<button type="button" class="text-button timeline-toggle" data-action="toggle-order-timeline">'+(expanded?'Show recent steps only':'Show earlier steps')+icon("chevron","small "+(expanded?"chevron-up":"chevron-down"))+'</button>':'';
    return '<div class="timeline">'+visible.map((status,index)=>{
      const fullIndex=ORDER_FLOW.indexOf(status),done=!cancelled&&fullIndex<current,active=!cancelled&&fullIndex===current;
      const event=order.statusHistory&&Object.values(order.statusHistory).find(x=>x.status===status);
      return '<div class="timeline-step '+(done?'done':active?'active':'')+'"><span class="timeline-dot"></span><div class="timeline-copy"><strong>'+h(status)+'</strong><span>'+(event?h(dateTime(event.at||event.createdAt)):active?'Current status':'')+'</span></div></div>';
    }).join("")+(cancelled?'<div class="timeline-step active"><span class="timeline-dot" style="border-color:var(--danger)"></span><div class="timeline-copy"><strong class="danger-text">Cancelled</strong><span>'+h(order.cancelReason||"Order was cancelled")+'</span></div></div>':'')+'</div>'+toggle;
  }
  function onlinePaymentNotice(order){
    if(!order||!isOnlinePaymentMethod(order.paymentMethod)||order.paymentState==="paid"||order.paymentState==="refunded")return"";
    const retry=order.paymentState==="failed";
    const statusCopy=retry?"The previous payment attempt did not complete.":"Pay this order securely before the restaurant can accept it.";
    return '<section class="card stack"><div class="notice '+(retry?'warning':'info')+'">'+icon(retry?"warning":"shield","small")+'<div><strong>'+(retry?'Retry payment':'Payment pending')+'</strong><div class="caption">'+h(statusCopy)+'</div></div></div><button class="button primary full" data-action="pay-order" data-order-id="'+h(order.id)+'">'+(retry?'Retry payment':'Complete payment')+'</button></section>';
  }
  /** Only used when there is no hero to float the controls over (a
   *  delivered or cancelled order), so back is never unreachable. */
  function orderTopbar(order){
    return '<header class="order-topbar"><button class="back-button" data-action="back" aria-label="Go back">'+icon("back")+'</button>'
      +'<div class="order-topbar-title"><strong>'+h(order.restaurant||"Your order")+'</strong><span>'+h(order.id)+'</span></div>'
      +'<button class="icon-button flat" data-action="refresh" aria-label="Refresh order">'+icon("refresh")+'</button></header>';
  }
  /**
   * Map (or, once it has idled down, the sponsored carousel) and the status
   * band as one attached block rather than two floating cards - the map's
   * bottom edge runs straight into the status it belongs to, which is both
   * tighter and reads as a single live thing.
   */
  function orderLiveModule(order,live,canTrack){
    const collapsed=!!state.trackingMapCollapsed;
    const headline=({
      "Order placed":"Order received. Sending it to the kitchen.",
      "Accepted":"The kitchen has your order.",
      "Preparing":"Your meal is being freshly prepared.",
      "Ready for pickup":"Packed and waiting for your partner.",
      "Assigned":"Your partner is heading to the restaurant.",
      "Handed to rider":"Your meal is on its way.",
      "Out for delivery":"Your meal is on its way.",
      "Near you":"Almost there. Your partner is close by.",
      "Arrived":"Your partner is at your door.",
      "Delivered":"Delivered with care.",
      "Cancelled":"This order was cancelled.",
    })[order.status]||(canTrack?'Your meal is on its way.':'Your order is being prepared.');
    const hero=!canTrack?"":(collapsed?trackingAdCarouselMarkup():trackingMapMarkup(order,live,false));
    const meta=(order.restaurant?order.restaurant+' · ':'')+(live.updatedAt&&order.riderId?'Location updated '+timeAgo(live.updatedAt)
      :'Updated '+timeAgo(order.updatedAt||order.createdAt));
    // With a hero to sit on, back and refresh float over it instead of
    // occupying a bar of their own above the fold, and the restaurant this
    // order came from moves down to head the status it belongs to.
    const heroBlock=hero?'<div class="live-hero">'+hero
      +'<button type="button" class="hero-float back" data-action="back" aria-label="Go back">'+icon("back")+'</button>'
      +'<button type="button" class="hero-float refresh" data-action="refresh" aria-label="Refresh order">'+icon("refresh")+'</button>'
      +'</div>':"";
    return '<section class="live-module'+(hero?'':' no-hero')+'">'+heroBlock
      +'<div class="live-status"><div class="grow">'
      +'<h1 class="live-headline">'+headline+'</h1>'
      +'<div class="live-chips"><span class="live-chip">'+h(order.status)+'</span>'+arrivalPillMarkup(order,live)+'</div>'
      +'<p class="live-meta">'+h(meta)+'</p></div>'
      +(canTrack&&collapsed?trackingMapThumbMarkup(order,live):'')
      +'</div></section>';
  }
  /** One row builder for both people. The restaurant's row is rendered with
   *  its own order content further down, not beside the delivery partner. */
  function riderCardCaption(order){
    const parts=[];
    const rating=Number(order.riderRating);
    if(rating>=1&&rating<=5)parts.push('★ '+rating.toFixed(1));
    const delivered=Number(order.riderDeliveredCount);
    if(Number.isFinite(delivered)&&delivered>0)parts.push(delivered.toLocaleString("en-IN")+(delivered===1?' delivery':' deliveries'));
    return parts.length?'Your delivery partner · '+parts.join(' · '):'Your delivery partner';
  }
  function orderContactRow(order,who){
    if(TERMINAL_STATES.has(order.status))return"";
    const rider=who==="rider";
    if(rider&&!order.riderId)return"";
    const name=rider?(order.riderName||"Delivery partner"):(order.restaurant||"Restaurant");
    const phone=rider?order.riderPhone:order.restaurantPhone;
    return '<div class="contact-row"><span class="avatar">'+h(String(name).slice(0,1).toUpperCase())+'</span>'
      +'<div class="grow"><strong>'+h(name)+'</strong><span class="caption">'+(rider?riderCardCaption(order):'Restaurant')+'</span></div>'
      +(phone?'<a class="icon-button" href="tel:'+h(phone)+'" aria-label="Call '+h(name)+'">'+icon("phone")+'</a>':'')
      +'<button class="icon-button" data-action="open-order-chat" data-channel="'+(rider?'customerRider':'customerRestaurant')+'" data-order-id="'+h(order.id)+'" aria-label="Chat with '+h(name)+'">'+icon("chat")+'</button></div>';
  }
  function screenOrder() {
    const order=orderById();if(!order)return'<main class="screen"><div class="screen-content">'+topbar("Order unavailable","This order is not in your account cache.")+emptyState("orders","Order not found","Refresh your orders and try again.","refresh","Refresh orders")+'</div>'+nav()+'</main>';
    const canTrack=orderShowsLiveMap(order);
    const riderLive=["Assigned","Handed to rider","Out for delivery","Near you","Arrived"].includes(order.status);
    const showDeliveryOtp=["Out for delivery","Near you","Arrived"].includes(order.status),deliveryOtp=state.deliveryOtps[order.id];
    const savedReview=state.reviews[order.id]||null,restaurantReviewRating=Number(savedReview&&savedReview.rating||0),riderReviewRating=Number(savedReview&&savedReview.riderRating||0);
    const submittedReviewMarkup=savedReview?'<section class="card stack"><div><p class="eyebrow">Your feedback</p><h2 class="section-title">Ratings submitted</h2></div><div class="price-row"><span>Restaurant & food</span><strong>'+h(restaurantReviewRating.toFixed(1))+' / 5</strong></div>'+(riderReviewRating>0?'<div class="price-row"><span>Delivery partner</span><strong>'+h(riderReviewRating.toFixed(1))+' / 5</strong></div>':'')+'<p class="caption">Saved to this delivered order.</p></section>':'';
    const reviewAction=order.status!=="Delivered"?'':savedReview?'<button class="button tonal grow" data-action="review-order" data-order-id="'+h(order.id)+'">'+icon("star")+' View your rating</button>':reviewStateReady()?'<button class="button tonal grow" data-action="review-order" data-order-id="'+h(order.id)+'">'+icon("star")+' Rate order</button>':'<button class="button tonal grow" disabled><span class="spinner"></span> Checking feedback…</button>';
    const live=state.tracking[order.id]||{};
    if(riderLive)ensureTrackingRoute(order,live);
    return '<main class="screen"><div class="screen-content page-stack order-screen">'+(canTrack?'':orderTopbar(order))+networkBanner()
      +orderLiveModule(order,live,canTrack)
      +(orderContactRow(order,'rider')?'<section class="card contact-card">'+orderContactRow(order,'rider')+'</section>':'')
      +(showDeliveryOtp?'<section class="card stack" aria-label="Delivery verification code"><div><p class="eyebrow">Delivery OTP</p><h2 class="section-title">Share only at your doorstep.</h2><p class="supporting">Give this code to your assigned Scraveit Partner only after you receive the complete order.</p></div>'+(deliveryOtp?'<div style="font-size:36px;line-height:1;font-weight:850;letter-spacing:.24em;color:var(--primary);padding:10px 0" aria-label="Delivery code '+h(deliveryOtp.split("").join(" "))+'">'+h(deliveryOtp)+'</div>':'<div class="notice warning">'+icon("warning","small")+'<span>This code is available only on the device that placed the order. Use in-app support if you changed devices.</span></div>')+'</section>':'')
      +'<section class="card stack" id="order-journey-card"><div><h2 class="section-title">Order journey</h2><p class="supporting">Restaurant and rider events are shown as they happen.</p></div>'+statusTimeline(order)+'</section>'
      +onlinePaymentNotice(order)
      +(canTrack&&!state.trackingMapCollapsed?trackingAdCarouselMarkup():'')
      +'<section class="card stack order-items-card">'+orderContactRow(order,'restaurant')+'<div class="cluster between"><h2 class="section-title">Items</h2><strong>'+money(order.total)+'</strong></div>'+orderItemsSummary(order)+'<div class="price-row total"><span>Paid / due</span><span>'+h(order.paymentMethod==="cod"||order.paymentMethod==="Cash on delivery"?'Cash on delivery':order.paymentMethod||"Payment")+'</span></div></section>'
      +'<section class="card stack"><h2 class="section-title">Delivery details</h2>'+addressSummary(order.address||{})+(order.instructions?'<div class="notice info">'+icon("info","small")+'<span>'+h(order.instructions)+'</span></div>':'')+'</section>'+submittedReviewMarkup
      +(order.status!=="Cancelled"?adminContactMarkup():'')
      +'<div class="cluster wrap">'+(order.status==="Delivered"?'<button class="button secondary grow" data-action="reorder" data-order-id="'+h(order.id)+'">'+icon("refresh")+' Reorder</button>'+reviewAction:'')+(["Order placed","Accepted"].includes(order.status)?'<button class="button danger grow" data-action="cancel-order" data-order-id="'+h(order.id)+'">Request cancellation</button>':'')+'<button class="button tonal grow" data-action="support-order" data-order-id="'+h(order.id)+'">'+icon("help")+' Get help</button></div>'
      +'</div>'+nav()+'</main>';
  }

  // The map is a fixed-height hero card, not the whole screen, so both the
  // fit margin and the "fit all points" box shrink proportionally from the
  // old full-screen tuning - unchanged values would zoom out far more than a
  // card this size needs to stay legible.
  const TRACKING_MAP_MIN_ZOOM=12, TRACKING_MAP_MAX_ZOOM=16, TRACKING_MAP_FIT_PX=140, TRACKING_TILE_PX=256, TRACKING_MAX_TILES=80;
  const TRACKING_POLL_MS=5000, TRACKING_STREAM_GRACE_MS=8000;
  // The map card has nothing overlapping it now (no floating bottom sheet),
  // so the camera anchor is just the card's vertical centre. This must stay
  // in sync with `.map-world { top: 50% }` in premium.css.
  const TRACKING_MAP_VERTICAL_ANCHOR_PCT=50;
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
  // The camera's job is to follow the partner, not to keep the destination
  // centred too - on a long "Out for delivery" leg the midpoint between rider
  // and door sits nowhere near either of them, which read as the map not
  // following the rider at all even though it was panning correctly toward
  // that midpoint on every update.
  function trackingCameraFocus(points,live){
    return points.riderPoint||trackingDestination(points,live)||null;
  }
  /** Re-aim the camera when the map changes size, so the switch does not
   *  leave the partner parked outside the frame it moved into. */
  function recentreTrackingForMode(){
    const ms=state.trackingMap,order=orderById();
    if(!ms||!order)return;
    const live=state.tracking[order.id]||{};
    const focus=trackingCameraFocus(trackingGeoPoints(order,live),live);
    if(!focus)return;
    const local=trackingLocalPoint(ms,focus);
    ms.panX=-local.x;ms.panY=-local.y;ms.userPanned=false;ms.userZoomed=false;ms.tileKey="";
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
  // Deliberately empty: baking `class="ready"` into this string (the old
  // behaviour) put every tile at its final opacity before the browser had
  // fetched a single one, so images just popped in one at a time as they
  // finished loading - the "patchy" look on first open. refreshTrackingTiles()
  // (called right after this screen mounts, see render()) creates every tile
  // the same way it already does for tiles revealed by panning: starting
  // hidden, then adding .ready on the image's own "load" event, so the CSS
  // opacity transition actually has something to animate.
  function trackingTileMarkup(ms){
    return "";
  }
  function trackingPinMarkup(ms,variant,point,label,iconName,isLive){
    // The rider marker is a full illustration (its own colors/shadow), not a
    // small glyph on a solid badge like the restaurant/home pins - it gets an
    // <img> instead of the shared icon-in-circle treatment.
    const content=variant==="rider"?'<img src="rider-marker.png" alt="" draggable="false" style="transform:'+trackingRiderTransform(ms)+'">':icon(iconName);
    if(!point)return '<span class="map-pin '+variant+'" style="display:none" aria-label="'+h(label)+'">'+content+'</span>';
    const local=trackingLocalPoint(ms,point);
    return '<span class="map-pin '+variant+(isLive?' live':'')+'" style="transform:translate3d('+local.x.toFixed(1)+'px,'+local.y.toFixed(1)+'px,0)" aria-label="'+h(label)+'">'+content+'</span>';
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
  // The route line runs from the partner's live position to the delivery
  // leg's destination, not a leg baked in once from the restaurant - so it
  // actually reflects where the partner is right now. Re-fetching on every
  // GPS fix would hammer the free OSRM router for no visible benefit, so the
  // rider side of the key is snapped to a coarse grid: the route only
  // refetches once the partner has moved roughly a city block, and
  // trackingProjectOnRoute/trackingRemainingRoute already smooth out
  // everything smaller than that between refetches.
  const TRACKING_ROUTE_RIDER_GRID_DEG=0.003;
  function trackingRouteRiderAnchor(point){
    const g=TRACKING_ROUTE_RIDER_GRID_DEG;
    return {lat:Math.round(point.lat/g)*g,lng:Math.round(point.lng/g)*g};
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
  function trackingRoutePoints(order,live){
    const points=trackingGeoPoints(order,live);
    const destination=trackingDestination(points,live);
    if(!points.riderPoint||!destination)return null;
    const key=trackingRouteKey(trackingRouteRiderAnchor(points.riderPoint),destination);
    const cached=state.trackingRoutes[key];
    if(cached&&cached.points)return cached;
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
    return trackingRouteMetrics([points.riderPoint,destination]);
  }
  async function ensureTrackingRoute(order,live){
    const points=trackingGeoPoints(order,live);
    const destination=trackingDestination(points,live);
    if(!points.riderPoint||!destination||!state.online)return;
    const key=trackingRouteKey(trackingRouteRiderAnchor(points.riderPoint),destination);
    const existing=state.trackingRoutes[key];
    if(existing&&(existing.points||existing.pending))return;
    if(existing&&existing.failedAt&&Date.now()-existing.failedAt<TRACKING_ROUTE_RETRY_MS)return;
    if(cachedTrackingRoute(key))return;
    state.trackingRoutes[key]={pending:true};
    try{
      const from=points.riderPoint,to=destination;
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
      if(liveOrderRoute())render({preserveScroll:true});
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
    const route=trackingRoutePoints(order,live);
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
  // A fixed-duration ease per GPS fix looked like "glide, then hold still for
  // a second or two, then glide again" whenever fixes arrived slower than
  // that duration - which is most of the time at realistic GPS/network
  // cadence. Every documented source for this exact problem (Uber's own
  // description of their client, Google's reference Android implementation,
  // general tutorials) converges on the same fix, and it's simpler than a
  // speed-estimate-and-coast model: animate between the last confirmed
  // position and the new one over a duration equal to how long that gap
  // actually took, eased rather than linear. Since both endpoints are always
  // real, already-confirmed fixes, this can never overshoot and needs no
  // separate correction term - the animation just finishes exactly when the
  // next fix's duration begins.
  const TRACKING_ROUTE_MIN_DURATION_MS=450, TRACKING_ROUTE_MAX_DURATION_MS=6000;
  function easeInOutQuad(t){ return t<0.5 ? 2*t*t : 1-Math.pow(-2*t+2,2)/2; }
  function startTrackingRouteGlide(target,fixAt){
    const ms=state.trackingMap;
    if(!ms)return;
    const now=Number.isFinite(fixAt)?fixAt:Date.now();
    const prevProgress=Number.isFinite(ms.routeProgress)?ms.routeProgress:target;
    const prevFixAt=Number.isFinite(ms.routeLastFixAt)?ms.routeLastFixAt:now;
    // The animation window is the real gap between this fix and the last one
    // - not a fixed constant - clamped so a near-simultaneous pair of fixes
    // doesn't snap instantly and a long stationary gap doesn't crawl for
    // minutes once movement resumes.
    const gapMs=Math.max(TRACKING_ROUTE_MIN_DURATION_MS,Math.min(TRACKING_ROUTE_MAX_DURATION_MS,now-prevFixAt));
    ms.routeFrom=prevProgress;
    ms.routeTarget=target;
    ms.routeDurationMs=gapMs;
    ms.routeGlideStart=Date.now();
    ms.routeLastFixAt=now;
    if(!ms.routeAnim&&typeof requestAnimationFrame==="function"){
      ms.routeAnim=requestAnimationFrame(stepTrackingRouteGlide);
    }else if(!ms.routeAnim){
      ms.routeProgress=target;paintTrackingRoute();
    }
  }
  function stepTrackingRouteGlide(){
    const ms=state.trackingMap;
    if(!ms)return;
    if(!liveOrderRoute()){ms.routeAnim=null;return;}
    const elapsed=Date.now()-ms.routeGlideStart;
    const t=Math.min(1,elapsed/(ms.routeDurationMs||TRACKING_ROUTE_MIN_DURATION_MS));
    const eased=easeInOutQuad(t);
    ms.routeProgress=ms.routeFrom+(ms.routeTarget-ms.routeFrom)*eased;
    paintTrackingRoute();
    // Stop once this segment is actually finished rather than idling the
    // loop at 60fps doing no-op repaints - the next fix cold-starts a fresh
    // one via startTrackingRouteGlide()'s own !ms.routeAnim check, which
    // costs nothing extra.
    ms.routeAnim=t<1&&typeof requestAnimationFrame==="function"?requestAnimationFrame(stepTrackingRouteGlide):null;
  }
  function stopTrackingRouteGlide(){
    const ms=state.trackingMap;
    if(ms&&ms.routeAnim&&typeof cancelAnimationFrame==="function")cancelAnimationFrame(ms.routeAnim);
    if(ms)ms.routeAnim=null;
  }
  // ---- rider marker: size and direction ------------------------------------
  // The marker shrinks as the map zooms out so it never covers the streets it
  // is travelling along, and stays modest even fully zoomed in.
  function trackingRiderWidth(zoom){
    return ({16:46,15:40,14:34,13:30})[zoom]||26;
  }
  function trackingBearing(a,b){
    const r=Math.PI/180,dLng=(b.lng-a.lng)*r;
    const y=Math.sin(dLng)*Math.cos(b.lat*r);
    const x=Math.cos(a.lat*r)*Math.sin(b.lat*r)-Math.sin(a.lat*r)*Math.cos(b.lat*r)*Math.cos(dLng);
    return (Math.atan2(y,x)/r+360)%360;
  }
  // The marker art is a three-quarter view riding toward the lower right, so
  // it cannot simply spin: it mirrors to face left or right and tilts up to
  // 30 degrees toward the road. Due north/south keeps the last facing, so a
  // rider on a straight road never flips back and forth.
  function trackingRiderTransform(ms){
    const heading=ms&&ms.riderHeading;
    if(!Number.isFinite(heading))return"";
    let left=!!ms.riderFacingLeft;
    if(heading>=195&&heading<=345)left=true;else if(heading>=15&&heading<=165)left=false;
    ms.riderFacingLeft=left;
    const base=left?235:125;
    const tilt=Math.max(-30,Math.min(30,((heading-base+540)%360)-180));
    return "rotate("+tilt.toFixed(0)+"deg)"+(left?" scaleX(-1)":"");
  }
  function updateTrackingHeading(ms,routeView,riderPoint){
    if(!ms||!riderPoint)return;
    if(routeView&&routeView.snapped&&routeView.route.total>0){
      const at=Math.min(routeView.progress,Math.max(0,routeView.route.total-20));
      const a=trackingPointAtProgress(routeView.route,at),b=trackingPointAtProgress(routeView.route,at+20);
      if(trackingMetres(a,b)>3)ms.riderHeading=trackingBearing(a,b);
      ms.headingFrom=riderPoint;
      return;
    }
    const from=ms.headingFrom;
    if(from&&trackingMetres(from,riderPoint)>=8){ms.riderHeading=trackingBearing(from,riderPoint);ms.headingFrom=riderPoint;}
    else if(!from)ms.headingFrom=riderPoint;
  }
  function applyTrackingRiderHeading(card,ms){
    const img=card&&card.querySelector(".map-pin.rider img");
    if(img)img.style.transform=trackingRiderTransform(ms);
  }
  // Before pickup there is no road route yet, only the plan: a dotted line
  // from the kitchen to the door, so the customer sees where it is all going.
  function trackingPlannedLineMarkup(ms,points){
    if(!points.restaurantPoint||!points.customerPoint)return"";
    const a=trackingLocalPoint(ms,points.restaurantPoint),b=trackingLocalPoint(ms,points.customerPoint),pad=8;
    const minX=Math.min(a.x,b.x)-pad,minY=Math.min(a.y,b.y)-pad;
    const width=Math.max(1,Math.abs(a.x-b.x))+pad*2,height=Math.max(1,Math.abs(a.y-b.y))+pad*2;
    return '<svg class="map-plan" aria-hidden="true" width="'+width.toFixed(0)+'" height="'+height.toFixed(0)+'" viewBox="0 0 '+width.toFixed(0)+' '+height.toFixed(0)+'" style="left:'+minX.toFixed(1)+'px;top:'+minY.toFixed(1)+'px">'
      +'<polyline points="'+(a.x-minX).toFixed(1)+','+(a.y-minY).toFixed(1)+' '+(b.x-minX).toFixed(1)+','+(b.y-minY).toFixed(1)+'"/></svg>';
  }
  // ---- arrival estimate -------------------------------------------------------
  // Minutes to the door from where the partner actually is: the road still
  // ahead on the delivery leg, or partner -> kitchen -> door before pickup, at
  // an average town speed. Before the kitchen is done the promised window is
  // the floor, since the partner cannot leave before the food does.
  const ARRIVAL_METRES_PER_MIN=300, ARRIVAL_ROAD_FACTOR=1.3;
  function liveArrivalMinutes(order,live){
    const status=String(order&&order.status||"");
    if(status==="Arrived")return 0;
    const promisedMax=Number(order.etaMax||0);
    const promiseLeft=promisedMax>0?Math.ceil((Number(order.createdAt||Date.now())+promisedMax*60000-Date.now())/60000):null;
    const points=trackingGeoPoints(order,live||{});
    let metres=null,extra=0;
    if(points.customerPoint&&points.riderPoint){
      if(trackingDeliveryLegActive(order,live||{})){
        const ms=state.trackingMap,view=ms&&ms.orderId===order.id?trackingRouteView(order,live||{}):null;
        metres=view&&view.snapped?Math.max(0,view.route.total-(Number.isFinite(ms.routeProgress)?ms.routeProgress:view.progress))
          :trackingMetres(points.riderPoint,points.customerPoint)*ARRIVAL_ROAD_FACTOR;
        extra=1;
      }else if(points.restaurantPoint){
        metres=(trackingMetres(points.riderPoint,points.restaurantPoint)+trackingMetres(points.restaurantPoint,points.customerPoint))*ARRIVAL_ROAD_FACTOR;
        extra=2;
      }
    }
    let minutes=metres==null?null:Math.max(1,Math.ceil(metres/ARRIVAL_METRES_PER_MIN+extra));
    const kitchenBusy=["Order placed","Accepted","Preparing"].includes(status);
    if(promiseLeft!=null&&(minutes==null||kitchenBusy))minutes=Math.max(minutes||0,promiseLeft);
    return minutes;
  }
  // The countdown only moves down on small wobbles; a genuine delay of two
  // minutes or more is shown as it is, together with an honest "running late".
  function arrivalPill(order,live){
    if(!order||TERMINAL_STATES.has(order.status))return null;
    if(order.status==="Arrived")return {text:"At your door",tone:"now"};
    const computed=liveArrivalMinutes(order,live);
    if(computed==null)return null;
    state.arrivalShown=state.arrivalShown||{};
    const previous=state.arrivalShown[order.id];
    let minutes=computed;
    if(previous&&computed>previous.minutes&&computed-previous.minutes<2)minutes=previous.minutes;
    state.arrivalShown[order.id]={minutes};
    const promisedMax=Number(order.etaMax||0);
    const promisedBy=promisedMax>0?Number(order.createdAt||0)+promisedMax*60000:0;
    const overBy=promisedBy?Math.round((Date.now()+Math.max(0,minutes)*60000-promisedBy)/60000):0;
    const timing=!promisedBy||overBy<=1?"On time":overBy<=10?"Running a little late":"Running late";
    if(minutes<=0)return {text:"Arriving any moment",tone:overBy>1?"late":"now"};
    if(minutes<=1&&["Near you","Out for delivery"].includes(order.status))return {text:"Arriving now · "+timing,tone:overBy>1?"late":"now"};
    return {text:"Arriving in "+minutes+" min · "+timing,tone:overBy>1?"late":"ok"};
  }
  function arrivalPillMarkup(order,live){
    const pill=arrivalPill(order,live);
    if(!pill)return '<span class="live-chip eta" id="tracking-eta">'+h(etaText(order))+'</span>';
    return '<span class="live-chip eta'+(pill.tone==="late"?' late':'')+'" id="tracking-eta">'+h(pill.text)+'</span>';
  }
  function patchArrivalPill(order,live){
    const chip=document.getElementById("tracking-eta");
    const pill=arrivalPill(order,live);
    if(!chip||!pill)return;
    chip.textContent=pill.text;
    chip.classList.toggle("late",pill.tone==="late");
  }
  function trackingMapMarkup(order,live,compact){
    const points=trackingGeoPoints(order,live);
    const ms=trackingMapState(order,points);
    if(!ms){
      // Idle-collapse only ever fires once tracking data already exists (see
      // startTrackingCollapseCycle/armTrackingIdleTimer), so a compact card
      // with nothing to show yet is not a real path today - skip it rather
      // than build and maintain an untested placeholder for it.
      if(compact)return"";
      return '<section class="card map-card map-card-empty"><div class="map-placeholder">'+icon("pin")+'<p class="supporting">The live map will appear once delivery locations are available.</p></div></section>';
    }
    // Do NOT stamp ms.tileKey/tilePanX/tilePanY here: trackingTileMarkup(ms)
    // below returns no <img> tags (see its comment), so the real tile layer
    // is built afterwards by refreshTrackingTiles(), which is what should own
    // this stamp - once it has actually created the images that match it.
    // Stamping it here made refreshTrackingTiles() see a key that already
    // "matched" and skip building anything, leaving the map blank on first
    // load and after every zoom/pan that forces a full re-render.
    const fresh=!!(live.updatedAt&&Date.now()-Number(live.updatedAt)<45000);
    // Same #tracking-map-card id and inner structure whether compact or not,
    // so patchTrackingMap()/refreshTrackingTiles() (which locate it by that
    // id) keep patching pins and tiles in place while it is shrunk down -
    // tapping it back open shows the map already current, not stale.
    // In compact mode the tap target is the .map-thumb wrapper around this,
    // not the card itself - see trackingMapThumbMarkup().
    return '<section class="card map-card'+(compact?' compact':'')+'" id="tracking-map-card" data-order-id="'+h(order.id)+'" style="--rider-w:'+trackingRiderWidth(ms.zoom)+'px">'
      +'<div class="map-world" id="tracking-map-world" style="transform:translate3d('+ms.panX.toFixed(1)+'px,'+ms.panY.toFixed(1)+'px,0)">'
      +'<div class="map-tiles">'+trackingTileMarkup(ms)+'</div>'
      +(trackingDeliveryLegActive(order,live)?trackingRouteMarkup(ms,order,live):trackingPlannedLineMarkup(ms,points))
      +trackingPinMarkup(ms,"restaurant",points.restaurantPoint,"Restaurant","receipt",false)
      +trackingPinMarkup(ms,"home",points.customerPoint,"Delivery address","home",false)
      +trackingPinMarkup(ms,"rider",points.riderPoint,"Delivery partner","bike",fresh)
      +'</div>'
      // Zoom/recentre controls and the LIVE/STALE badge only make sense at
      // full size - omitting them in compact mode (rather than hiding with
      // CSS) also means a tap anywhere on the thumbnail always resolves to
      // the section's own tracking-expand-map action, never a stray control.
      +(compact?"":'<button type="button" class="map-control map-minimize" data-action="tracking-collapse-map" aria-label="Minimise map">'+icon("minimize")+'</button>'
      +'<div class="map-overlay"><span class="status-pill map-status-pill '+(fresh?'success':'warning')+'">'+(fresh?'LIVE':'STALE')+'</span><span class="map-attribution">© OpenStreetMap</span></div>'
      +'<div class="map-controls">'
      +'<button type="button" class="map-control" data-action="tracking-zoom" data-delta="1" aria-label="Zoom in">+</button>'
      +'<button type="button" class="map-control" data-action="tracking-zoom" data-delta="-1" aria-label="Zoom out">&#8722;</button>'
      +'<button type="button" class="map-control'+(ms.userPanned||ms.userZoomed?'':' hidden')+'" id="tracking-recenter" data-action="tracking-recenter" aria-label="Recentre the map">'+icon("target")+'</button>'
      +'</div>')
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
    // Only re-fit when the rider has actually moved outside the visible
    // card, not on every tick. fitTrackingMapView(all) fits the restaurant,
    // the door AND the rider into a fixed pixel budget - on a long "Out for
    // delivery" leg the restaurant-to-door span is static, but the rider's
    // own movement keeps nudging that same box past the threshold, so this
    // used to re-fit (a full, unanimated re-render - the "jump") on nearly
    // every GPS update. The camera now follows the rider (see
    // trackingCameraFocus), so what actually matters is only whether the
    // rider is still on screen at the current zoom - a genuinely rare event,
    // not a per-tick one.
    // Close to the door the map moves in, once, so the last few streets are
    // easy to follow. A customer who has zoomed or panned keeps their view.
    const nearDoor=["Near you","Arrived"].includes(order.status)||(points.riderPoint&&points.customerPoint
      &&trackingDeliveryLegActive(order,live)&&trackingMetres(points.riderPoint,points.customerPoint)<350);
    if(nearDoor&&!ms.arrivalZoomed&&!ms.userPanned&&!ms.userZoomed&&points.riderPoint&&points.customerPoint){
      ms.arrivalZoomed=true;
      if(ms.zoom<TRACKING_MAP_MAX_ZOOM){
        ms.zoom=TRACKING_MAP_MAX_ZOOM;
        ms.anchorLat=(points.riderPoint.lat+points.customerPoint.lat)/2;ms.anchorLng=(points.riderPoint.lng+points.customerPoint.lng)/2;
        ms.panX=0;ms.panY=0;ms.tileKey="";
        return false;
      }
    }
    if(!ms.userPanned&&!ms.userZoomed&&points.riderPoint){
      const size=trackingViewportSize(),margin=48;
      const above=size.height*(TRACKING_MAP_VERTICAL_ANCHOR_PCT/100),below=size.height-above;
      const local=trackingLocalPoint(ms,points.riderPoint);
      // trackingLocalPoint() is anchor-relative; the camera pan (ms.panX/Y)
      // is what actually places the rider on screen, so that has to be added
      // back in before comparing against the viewport edges.
      const screenX=local.x+ms.panX,screenY=local.y+ms.panY;
      const riderOffScreen=Math.abs(screenX)>size.width/2-margin
        ||screenY<-(above-margin)||screenY>below-margin;
      if(riderOffScreen){
        const fitted=fitTrackingMapView(all);
        if(fitted.zoom<ms.zoom){
          ms.zoom=fitted.zoom;ms.anchorLat=fitted.center.lat;ms.anchorLng=fitted.center.lng;
          ms.panX=0;ms.panY=0;ms.tileKey="";
          return false;
        }
      }
    }
    const fresh=!!(live.updatedAt&&Date.now()-Number(live.updatedAt)<45000);
    setTrackingPin(card,".map-pin.restaurant",ms,points.restaurantPoint,null);
    setTrackingPin(card,".map-pin.home",ms,points.customerPoint,null);
    // On the delivery leg the scooter is driven along the route itself, which
    // both keeps it on the road and lets the line retract in step with it.
    const routeView=trackingRouteView(order,live);
    updateTrackingHeading(ms,routeView,points.riderPoint);
    applyTrackingRiderHeading(card,ms);
    patchArrivalPill(order,live);
    if(routeView&&routeView.snapped){
      let target=routeView.progress;
      // GPS noise must not make the line grow back; only real backtracking does.
      if(Number.isFinite(ms.routeProgress)&&target<ms.routeProgress-TRACKING_MAX_REWIND_M)target=ms.routeProgress;
      const rider=card.querySelector(".map-pin.rider");
      if(rider)rider.classList.toggle("live",fresh);
      startTrackingRouteGlide(target,Number(live.updatedAt)||Date.now());
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
    if(!liveOrderRoute())return;
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
  // ---- tracking map auto-collapse + ad carousel -----------------------------
  // The ad carousel is the default view, not a fallback the map decays into:
  // the screen opens straight into it. Each time the customer taps the
  // thumbnail to bring the map back, it earns a longer stay before it
  // auto-collapses again - 6s the first time, 16s the second time, and from
  // the third expand on it stays open until they minimise it themselves.
  // Manually minimising never resets that progression; only leaving the
  // screen and coming back (startTrackingCollapseCycle) does. These handles
  // live outside `state` on purpose: they are timer ids / counters, not data
  // that should ever be persisted, diffed, or trigger a render by themselves.
  let trackingIdleTimer=null, trackingCarouselTimer=null, trackingCarouselIndex=0, trackingExpandCount=0;
  const TRACKING_IDLE_SCHEDULE_MS=[6000,16000], TRACKING_CAROUSEL_INTERVAL_MS=4500;
  function stopTrackingCollapseCycle(){
    clearTimeout(trackingIdleTimer);trackingIdleTimer=null;
    clearInterval(trackingCarouselTimer);trackingCarouselTimer=null;
  }
  function armTrackingIdleTimer(delayMs){
    clearTimeout(trackingIdleTimer);
    trackingIdleTimer=setTimeout(()=>{
      if(!liveOrderRoute()||state.trackingMapCollapsed)return;
      state.trackingMapCollapsed=true;
      recentreTrackingForMode();
      render({preserveScroll:true});
    },delayMs);
  }
  // Called once, from go()/goBack(), on the transition into the tracking
  // route - never from inside screenOrder() itself, which renders on every
  // collapse/expand and must not restart the progression each time. Opens
  // straight into the ad carousel: nothing to idle out of, so no timer here.
  function startTrackingCollapseCycle(){
    state.trackingMapCollapsed=true;
    trackingCarouselIndex=0;
    trackingExpandCount=0;
    stopTrackingCollapseCycle();
  }
  function collapseTrackingMap(){
    if(state.trackingMapCollapsed)return;
    state.trackingMapCollapsed=true;
    recentreTrackingForMode();
    stopTrackingCollapseCycle();
    render({preserveScroll:true});
  }
  function expandTrackingMap(){
    if(!state.trackingMapCollapsed)return;
    state.trackingMapCollapsed=false;
    recentreTrackingForMode();
    trackingExpandCount++;
    stopTrackingCollapseCycle();
    // Past the scheduled expands, undefined -> no timer armed -> stays open
    // until the customer minimises it themselves.
    const delay=TRACKING_IDLE_SCHEDULE_MS[trackingExpandCount-1];
    if(delay!=null)armTrackingIdleTimer(delay);
    render({preserveScroll:true});
  }
  function trackingAdCarouselMarkup(){
    const ads=activeLocalAds();
    if(trackingCarouselIndex>=ads.length)trackingCarouselIndex=0;
    // No campaign published yet: keep the identical full-bleed hero shape so
    // the page composition doesn't change the moment the first ad goes live.
    const slides=ads.length?ads:[null];
    return '<section class="tracking-ad-hero'+(ads.length?'':' is-fallback')+'"><div class="tracking-ad-track" id="tracking-ad-track">'
      +slides.map(ad=>ad
        ?'<button type="button" class="tracking-ad-slide" data-action="open-ad" data-ad-id="'+h(ad.id)+'">'
          +((ad.image||ad.imageUrl)?'<img src="'+h(safeUrl(ad.image||ad.imageUrl,"restaurant-placeholder.svg"))+'" alt="">':'')
          +'<div class="tracking-ad-copy"><span class="sponsored-label">Sponsored'+(ad.area||ad.city?' · '+h(ad.area||ad.city):'')+'</span><h2 class="tracking-ad-title">'+h(ad.title||"Nearby offer")+'</h2>'+(ad.message?'<p>'+h(ad.message)+'</p>':'')+'<span class="tracking-ad-cta">'+h(ad.cta||"Explore")+'</span></div></button>'
        :'<div class="tracking-ad-slide is-brand"><div class="tracking-ad-copy"><span class="sponsored-label">Scraveit standard</span><h2 class="tracking-ad-title">Clear pricing.<br>Careful delivery.</h2><p>Every charge is shown before you place an order.</p></div></div>').join("")
      +'</div>'
      +(slides.length>1?'<div class="tracking-ad-dots" id="tracking-ad-dots">'+slides.map((_,i)=>'<button type="button" class="ad-dot'+(i===trackingCarouselIndex?' active':'')+'" data-action="tracking-ad-dot" data-index="'+i+'" aria-label="Show ad '+(i+1)+'"></button>').join("")+'</div>':'')
      +'</section>';
  }
  /**
   * The map at thumbnail size, scaled rather than merely shrunk: at 84px the
   * card cropped so tight that the rider pin alone filled it and it read as a
   * photo of a scooter, not a map. trackingViewportSize() already clamps tile
   * loading to a 280x420 minimum, so the surrounding tiles are loaded either
   * way - rendering the card at full thumbnail scale and transforming it down
   * just makes them visible.
   */
  function trackingMapThumbMarkup(order,live){
    const map=trackingMapMarkup(order,live,true);
    if(!map)return"";
    return '<div class="map-thumb" data-action="tracking-expand-map" role="button" tabindex="0" aria-label="Expand live map">'
      +map
      +'<span class="map-thumb-expand">'+icon("expand")+'</span>'
      +'</div>';
  }
  // Advances the carousel by direct DOM writes rather than a full render() -
  // this ticks every few seconds purely for ambient rotation, and a full
  // re-render on that cadence is exactly the kind of self-inflicted "page
  // glitching" this app has already been burned by elsewhere.
  function applyTrackingCarouselFrame(track){
    track.style.transform="translateX(-"+(trackingCarouselIndex*100)+"%)";
    document.querySelectorAll("#tracking-ad-dots .ad-dot").forEach((dot,i)=>dot.classList.toggle("active",i===trackingCarouselIndex));
  }
  // Called after every render() while on the tracking route (mirrors
  // refreshTrackingTiles() immediately below it) - idempotent, so it is safe
  // to call whether or not the carousel is even in the DOM right now.
  function refreshTrackingCarousel(){
    clearInterval(trackingCarouselTimer);trackingCarouselTimer=null;
    const track=document.getElementById("tracking-ad-track");
    if(!track)return;
    const slides=track.children.length;
    if(trackingCarouselIndex>=slides)trackingCarouselIndex=0;
    applyTrackingCarouselFrame(track);
    if(slides<=1)return;
    trackingCarouselTimer=setInterval(()=>{
      const liveTrack=document.getElementById("tracking-ad-track");
      if(!liveTrack){clearInterval(trackingCarouselTimer);trackingCarouselTimer=null;return;}
      trackingCarouselIndex=(trackingCarouselIndex+1)%liveTrack.children.length;
      applyTrackingCarouselFrame(liveTrack);
    },TRACKING_CAROUSEL_INTERVAL_MS);
  }

  function promoCard(promo) {
    const eligibility=(promotionMinimum(promo)?"Minimum order "+money(promotionMinimum(promo)):"No minimum order")+" · "+promotionSponsor(promo);
    return '<article class="card brand-card stack"><div class="cluster between"><span class="eyebrow" style="color:#bfe9ff">'+h(promo.label||"LIVE OFFER")+'</span><span class="status-pill" style="background:rgba(255,255,255,.17);color:white">'+h(promo.code||"Offer")+'</span></div><h2 class="section-title" style="font-size:25px">'+h(promo.title||(promo.kind==="flat"?money(Number(promo.flatAmountPaise||0)/100)+" off":(promo.percent||0)+"% off"))+'</h2><p class="supporting">'+h(promo.description||eligibility)+'</p>'+(promo.description?'<p class="caption" style="color:#dbeafe">'+h(eligibility)+'</p>':'')+'<button class="button" style="background:white;color:#155eef" data-action="use-promo" data-promo-id="'+h(promo.id)+'">Use '+h(promo.code||"offer")+'</button></article>';
  }
  function offersCashbackSection(){if(!state.walletData&&!state.walletLoading)setTimeout(()=>loadWallet(false),0);const w=state.walletData&&state.walletData.wallet;if(!w)return"";return(w.cashbackCampaigns.length?'<section class="stack"><h2 class="section-title">Cashback</h2>'+w.cashbackCampaigns.map(cashbackOfferCard).join("")+'</section>':'')+'<button class="settings-row card" data-action="go" data-route="wallet"><span class="settings-icon">'+icon("wallet")+'</span><span class="grow"><strong>Wallet '+paise(w.balancePaise)+'</strong><span class="supporting">Cashback, referral rewards and expiry dates</span></span>'+icon("chevron","small")+'</button>'}
  function screenOffers() {
    return '<main class="screen"><div class="screen-content page-stack">'+networkBanner()+'<header><p class="eyebrow">Savings</p><h1 class="page-title">Offers with clear terms.</h1><p class="supporting" style="margin-top:7px">Only active promotions published by Scraveit Control appear here.</p></header>'
      +(state.promotions.length?'<section class="stack-lg">'+state.promotions.map(promoCard).join("")+'</section>':emptyState("offers","No live offers right now","We will show a promotion here only when its eligibility and discount are actually active.","go-home","Browse restaurants"))
      +offersCashbackSection()
      +'<section class="card stack"><h2 class="section-title">How offers work</h2><div class="notice info">'+icon("info","small")+'<span>Eligibility is checked again against the live promotion at checkout. Expired or restaurant-limited codes are never shown as applied.</span></div></section></div>'+nav()+'</main>';
  }

  function settingsRow(ic,title,copy,route,action,tail) {
    return '<button class="settings-row" '+(route?'data-action="go" data-route="'+h(route)+'"':'data-action="'+h(action||"")+'"')+'><span class="settings-icon">'+icon(ic)+'</span><span class="grow"><strong>'+h(title)+'</strong>'+(copy?'<span class="supporting">'+h(copy)+'</span>':'')+'</span>'+(tail||icon("chevron","small"))+'</button>';
  }
  function screenAccount() {
    return '<main class="screen"><div class="screen-content page-stack">'+networkBanner()+'<header><p class="eyebrow">Your account</p><h1 class="page-title">Details, preferences and help.</h1></header>'
      +'<section class="card brand-card cluster"><span class="avatar" style="width:58px;height:58px;background:rgba(255,255,255,.18)">'+h(initials())+'</span><div class="grow"><h2 class="section-title">'+h(state.profile.name||"Scraveit customer")+'</h2><p class="supporting">'+h(state.profile.email||state.session&&state.session.email||"")+'</p><p class="caption" style="color:rgba(255,255,255,.72)">'+h(state.profile.phone||"Add your mobile number")+'</p></div><button class="icon-button" style="background:rgba(255,255,255,.16);color:white;border:0;box-shadow:none" data-action="edit-profile" aria-label="Edit profile">'+icon("chevron")+'</button></section>'
      +'<section class="card settings-list">'+settingsRow("address","Saved addresses",(state.profile.addresses||[]).length+" saved","addresses")+settingsRow("heart","Favourite restaurants",(state.profile.favourites||[]).length+" saved","favourites")+settingsRow("card","Payment methods","Only verified payment options are shown",null,"payment-info")+settingsRow("wallet","Wallet & rewards",state.walletData?paise(walletBalance())+" balance · invite friends":"Cashback, referral rewards and expiry","wallet")+'</section>'
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
  // "Home"/"Work" need no free text at all; anything else is "Other" with
  // its own label typed in. Defaulting a brand-new address to "Home" (instead
  // of an empty required text field, which is what silently blocked saving
  // before - the input just sat empty until entering the mobile number then
  // tapping save re-triggered the same unnoticed validation toast) means the
  // label can never be blank, so this class of stuck-on-save is gone by
  // construction, not by a stronger validation message.
  function addressLabelIsOther(label){return !!label&&label!=="Home"&&label!=="Work"}
  function addressFormSheet(sheet) {
    const address=sheet.address||{},point=state.addressMapDraft||{},label=address.label||"Home",isOther=addressLabelIsOther(label);
    // No `required` attributes here (deliberately) - submitAddress() already
    // re-validates every one of these fields itself and shows a toast naming
    // exactly what's missing. Relying on the browser's own constraint
    // validation instead is what caused the real bug: this WebView blocks
    // the submit before any JS runs when a required field fails, with no
    // bubble, no console output, nothing - "tap Save, nothing happens at
    // all" for both the person testing it and any code trying to observe
    // what went wrong.
    return sheetShell(address.id?"Edit address":"Add address","Place the delivery pin, then add the door/flat details a rider needs.",'<form id="address-form" class="form-grid"><input type="hidden" name="id" value="'+h(address.id||"")+'"><input type="hidden" name="lat" value="'+h(point.lat==null?"":point.lat)+'"><input type="hidden" name="lng" value="'+h(point.lng==null?"":point.lng)+'">'+addressMapMarkup()+'<div class="field"><label>Save address as</label><div class="segmented three">'+["Home","Work","Other"].map(opt=>'<button type="button" class="segment '+((opt==="Other"?isOther:label===opt)?'active':'')+'" data-action="address-label-chip" data-value="'+opt+'">'+opt+'</button>').join("")+'</div></div>'+(isOther?'<div class="field"><label for="address-label-custom">Label</label><input id="address-label-custom" class="input" name="label" value="'+h(label)+'" placeholder="e.g. Friend\'s place"></div>':'<input type="hidden" name="label" value="'+h(label)+'">')+'<div class="field"><label for="address-area">Area</label><input id="address-area" class="input" name="area" value="'+h(address.area||"")+'" placeholder="Neighbourhood or locality"></div><div class="field"><label for="address-city">City</label><input id="address-city" class="input" name="city" value="'+h(address.city||"")+'" placeholder="Nellore"></div><div class="field"><label for="address-full">Full delivery address</label><textarea id="address-full" class="textarea" name="address" placeholder="Flat, building, street, landmark and city">'+h(address.address||address.details||"")+'</textarea></div><div class="field"><label for="address-phone">Mobile number</label><input id="address-phone" class="input" name="phone" type="tel" inputmode="tel" value="'+h(address.phone||state.profile.phone||"")+'" placeholder="10-digit mobile number"></div><div class="notice success">'+icon("check","small")+'<span>A map pin will be saved with this address.</span></div><button class="button primary full" type="button" data-action="submit-address">Save delivery address</button></form>');
  }
  function addressPickerCard(address){
    const selected=address.id===state.profile.selectedAddressId;
    return '<button class="settings-row" data-action="select-address-and-close" data-address-id="'+h(address.id)+'"><span class="settings-icon">'+icon(address.source==="gps"?"target":"address")+'</span><span class="grow"><strong>'+h(address.label||"Address")+'</strong><span class="supporting">'+h(address.address||address.details||"")+'</span></span>'+(selected?icon("check","small"):'')+'</button>';
  }
  function addressPickerSheet(){
    const addresses=state.profile.addresses||[],shown=addresses.slice(0,4);
    const permissionNotice=locationReady()?'':'<div class="notice warning">'+icon("target","small")+'<div><strong>Device location is off</strong><div class="caption">Enable it for accurate address detection.</div></div><button class="text-button" data-action="detect-location">Enable</button></div>';
    const list=shown.length?'<div class="stack">'+shown.map(addressPickerCard).join("")+'</div>':emptyState("address","No saved addresses yet","Add a delivery address to get started.");
    return sheetShell("Select delivery address","",permissionNotice
      +'<div class="cluster between" style="margin-top:16px"><h2 class="section-title" style="font-size:16px">Select a saved address</h2>'+(addresses.length?'<button class="text-button" data-action="go" data-route="addresses">'+(addresses.length>4?'See all':'Manage')+'</button>':'')+'</div>'
      +list
      +'<button class="button tonal full" data-action="add-address" style="margin-top:16px">'+icon("search","small")+' Enter location manually</button>');
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
    else if(sheet.type==="addressPicker")html=addressPickerSheet();
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
      paymentMethod:String(state.checkout.payment||"cod"),useWallet:state.useWallet===true&&walletBalance()>0,
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

  // Unreachable (LEGACY_ORDER_WRITE_COMPATIBILITY is permanently false) - kept
  // only as a disabled emergency-rollback path, so its RTDB-shaped internals
  // were left as rtdb() calls rather than converted to Firestore. If this is
  // ever re-enabled, it needs the same conversion every other order-writing
  // path here already got.
  async function submitLegacyCodOrder(address,r,idempotencyKey){
    if(LEGACY_ORDER_WRITE_COMPATIBILITY!==true)throw new Error("ORDER_SERVICE_UNAVAILABLE");
    const now=Date.now(),orderId=state.checkout.pendingOrderId||("SV-"+uid("").replace(/-/g,"").slice(0,12).toUpperCase());state.checkout.pendingOrderId=orderId;persistCheckout();
    try{const existing=await rtdb("GET",DB_ROOT+"/orders/"+encodeURIComponent(state.session.uid)+"/"+encodeURIComponent(orderId));if(existing){finishOrderPlacement(existing,orderId,state.deliveryOtps[orderId]||"",true);return;}}catch(_){}
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
      await rtdb("PATCH",DB_ROOT,changes);finishOrderPlacement(order,orderId,deliveryOtp,false);
    }catch(error){
      try{const existing=await rtdb("GET",DB_ROOT+"/orders/"+encodeURIComponent(state.session.uid)+"/"+encodeURIComponent(orderId));if(existing){finishOrderPlacement(existing,orderId,deliveryOtp,true);return;}}catch(_){}
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

  // ---- Wallet, cashback and referrals. Balances, rewards and eligibility all
  // come from the server (getCustomerWallet); this screen only shows them.
  function installId(){try{let id=localStorage.getItem("scraveit.installId");if(!id){id=uid("inst_").replace(/[^A-Za-z0-9_-]/g,"").slice(0,40);localStorage.setItem("scraveit.installId",id)}return id}catch(_){return""}}
  function paise(v){return money(Number(v||0)/100)}
  async function loadWallet(force){if(!state.session||state.walletLoading||!nativeAvailable("getCustomerWallet"))return;if(!force&&state.walletData&&Date.now()-state.walletLoadedAt<60000)return;state.walletLoading=true;state.walletError="";try{const raw=await nativeInvoke("getCustomerWallet",{installId:installId()},{timeoutMs:15000});state.walletData=raw&&raw.wallet?raw:null;state.walletLoadedAt=Date.now()}catch(e){state.walletError=friendlyError(e)}finally{state.walletLoading=false;if(["wallet","checkout","offers","account"].includes(state.route))render({preserveScroll:true})}}
  function walletBalance(){return Number(state.walletData&&state.walletData.wallet&&state.walletData.wallet.balancePaise||0)}
  function walletEntryLabel(type){return({cashback:"Cashback earned",customer_referral:"Referral reward",redeem:"Used on an order",restore:"Returned (order cancelled)",cashback_reversal:"Cashback reversed",expiry:"Expired"})[type]||"Wallet update"}
  function cashbackOfferCard(c){const amount=c.kind==="flat"?paise(c.flatAmountPaise)+" cashback":c.percent+"% cashback"+(c.maxCashbackPaise?" up to "+paise(c.maxCashbackPaise):"");return'<article class="card stack wallet-offer"><div class="cluster between"><span class="eyebrow">'+(c.funding==="restaurant"?"Restaurant cashback":"Scraveit cashback")+'</span><span class="status-pill">'+h(amount)+'</span></div><h3 class="card-title">'+h(c.title)+'</h3><p class="caption">'+(c.minimumOrderPaise?"On orders above "+paise(c.minimumOrderPaise)+" · ":"")+'Added to your wallet after delivery · usable for '+h(c.expiryDays)+' days</p></article>'}
  function screenWallet(){if(!state.walletData&&!state.walletLoading&&!state.walletError)setTimeout(()=>loadWallet(false),0);const data=state.walletData,w=data&&data.wallet,ref=data&&data.referral;
    const head='<main class="screen"><div class="screen-content page-stack">'+topbar("Wallet & rewards","Cashback, referral rewards and when they expire.")+networkBanner()+(state.walletError?'<div class="notice warning">'+icon("warning","small")+'<span>'+h(state.walletError)+'</span></div>':'');
    if(!w)return head+(state.walletLoading?loadingRow("Loading your wallet…"):emptyState("card","Wallet unavailable","Try again in a moment.","wallet-refresh","Retry"))+'</div>'+nav()+'</main>';
    const soon=w.lots.find(l=>l.expiresAt-Date.now()<7*86400000);
    const balance='<section class="card brand-card stack"><p class="eyebrow" style="color:#bfe9ff">Wallet balance</p><strong class="page-title" style="color:white">'+paise(w.balancePaise)+'</strong><p class="supporting" style="color:rgba(255,255,255,.8)">Use up to '+(w.rules.maxRedeemBpsOfSubtotal/100)+'% of an order (max '+paise(w.rules.maxRedeemPerOrderPaise)+') on orders above '+paise(w.rules.minOrderForRedeemPaise)+'.</p>'+(soon?'<p class="caption" style="color:#ffe7b3">'+paise(soon.remainingPaise)+' expires on '+h(new Date(soon.expiresAt).toLocaleDateString("en-IN",{day:"numeric",month:"short"}))+'</p>':'')+'</section>';
    const lots=w.lots.length?'<section class="card stack"><h2 class="section-title">Money in your wallet</h2>'+w.lots.map(l=>'<div class="price-row"><span>'+h(l.source==="customer_referral"?"Referral reward":"Cashback")+'<small class="caption" style="display:block">Use by '+h(new Date(l.expiresAt).toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"}))+'</small></span><span>'+paise(l.remainingPaise)+'</span></div>').join("")+'</section>':'';
    const offers=w.cashbackCampaigns.length?'<section class="stack"><h2 class="section-title">Cashback offers</h2>'+w.cashbackCampaigns.map(cashbackOfferCard).join("")+'</section>':'';
    let refCard="";if(ref){const p=ref.program;refCard='<section class="card stack"><h2 class="section-title">Invite friends</h2>'+(p.active?'<p class="supporting">Your friend gets '+paise(p.refereeRewardPaise)+' and you get '+paise(p.referrerRewardPaise)+' in your wallets after their first delivered order'+(p.minOrderValuePaise?' above '+paise(p.minOrderValuePaise):'')+'.</p><div class="referral-code"><span>Your code</span><strong>'+h(ref.code)+'</strong></div><button class="button primary full" data-action="share-referral">'+icon("chat")+' Share invite</button><p class="caption">'+h(ref.invited.total)+' invited · '+h(ref.invited.rewarded)+' rewarded · '+h(ref.invited.waiting)+' waiting for their first order</p>':'<p class="supporting">The referral programme is not running right now.</p>')+'</section>';
      if(p.active&&!ref.myReferral&&!state.orders.length)refCard+='<form id="referral-form" class="card stack"><h2 class="section-title">Got a code from a friend?</h2><label class="field"><span>Referral code</span><input id="referral-code" class="input" name="code" placeholder="SCXXXXXX" maxlength="120" required></label><button class="button secondary full" type="submit">Apply code</button><p class="caption">Rewards arrive after your first delivered order, not at signup.</p></form>';
      else if(ref.myReferral)refCard+='<div class="notice info">'+icon("info","small")+'<span>'+h(({pending:"Your friend's code is linked. Your reward arrives after your first qualifying delivered order.",review:"Your referral is being checked by Scraveit.",approved:"Your referral is approved. Your reward arrives after your first qualifying delivered order.",rewarded:"Referral reward received.",rejected:"This referral could not be approved.",expired:"This referral expired before a qualifying order."})[ref.myReferral.status]||"Referral linked.")+'</span></div>'}
    const history=w.entries.length?'<section class="card stack"><h2 class="section-title">History</h2>'+w.entries.map(e=>'<div class="price-row"><span>'+h(walletEntryLabel(e.type))+'<small class="caption" style="display:block">'+h(new Date(Number(e.at)).toLocaleDateString("en-IN",{day:"numeric",month:"short"}))+(e.orderId?' · '+h(e.orderId):'')+'</small></span><span class="'+(Number(e.amountPaise)>=0?'success-text':'')+'">'+(Number(e.amountPaise)>=0?'+':'−')+paise(Math.abs(Number(e.amountPaise)))+'</span></div>').join("")+'</section>':'';
    return head+balance+lots+offers+refCard+history+'</div>'+nav()+'</main>'}
  async function applyReferral(form){const code=String(new FormData(form).get("code")||"").trim();if(!code)return;try{const res=await nativeInvoke("applyCustomerReferral",{code,installId:installId()},{timeoutMs:15000});toast(res&&res.status==="review"?"Code linked. Scraveit will check it before rewarding.":"Code linked. Your reward arrives after your first delivered order.","success");await loadWallet(true)}catch(e){toast(friendlyError(e),"danger")}}
  function shareReferral(){const ref=state.walletData&&state.walletData.referral;if(!ref)return;const text=ref.shareText;if(navigator.share){navigator.share({text}).catch(()=>{});return}try{navigator.clipboard.writeText(text);toast("Invite copied. Paste it in any chat.","success")}catch(_){toast(text,"info")}}
  Object.assign(SCREENS, {
    launch:screenLaunch, welcome:screenWelcome, login:screenLogin, signup:screenSignup, verifyEmail:screenVerifyEmail, home:screenHome, search:screenSearch,
    restaurant:screenRestaurant, cart:screenCart, checkout:screenCheckout, orders:screenOrders,
    order:screenOrder, chat:screenChat, tracking:screenOrder, offers:screenOffers, account:screenAccount,
    addresses:screenAddresses, favourites:screenFavourites, preferences:screenPreferences,
    support:screenSupport, legal:screenLegal, review:screenReview, wallet:screenWallet
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
    // Re-entrant by design: this returns immediately once the term has been
    // looked up, and its own re-render is what lands the results.
    searchCityCatalog(state.query);
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
    if(action==="tracking-expand-map"){expandTrackingMap();return;}
    if(action==="tracking-collapse-map"){collapseTrackingMap();return;}
    if(action==="tracking-ad-dot"){
      trackingCarouselIndex=Number(control.dataset.index||0);
      const track=document.getElementById("tracking-ad-track");
      if(track)applyTrackingCarouselFrame(track);
      // A manual jump shouldn't be immediately undone by the auto-advance
      // tick mid-look - restart the rotation from here instead.
      refreshTrackingCarousel();
      return;
    }
    if(action==="toggle-order-timeline"){
      state.timelineExpanded=!state.timelineExpanded;
      render({preserveScroll:true});
      // Collapsing/expanding changes the card's height a lot, so keeping the
      // previous raw scrollY leaves the viewport pointed at whatever content
      // now happens to sit at that pixel offset - not the card the person
      // just tapped. Re-anchor on the card itself instead.
      requestAnimationFrame(()=>{
        const card=document.getElementById("order-journey-card");
        if(card&&card.scrollIntoView)card.scrollIntoView({block:"start"});
      });
      return;
    }
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
      try{const authUser=fbAuth.currentUser;if(!authUser)throw new Error("AUTH_REQUIRED");await authUser.sendEmailVerification();toast("A new verification email was requested. Use the newest message.","success");}
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
      if(promotionMinimum(promo)&&cartSubtotal()<promotionMinimum(promo)){toast("This offer needs a minimum item total of "+money(promotionMinimum(promo))+".","danger");return;}
      if(Array.isArray(promo.restaurantIds)&&promo.restaurantIds.length&&!promo.restaurantIds.includes(state.cart[0].restaurantId)){toast("That offer is not eligible for this restaurant.","danger");return;}
      if(!promotionEligible(promo,state.cart[0].restaurantId,cartSubtotal(),Date.now())){toast("That offer is not available on this order.","danger");return;}
      // A code the customer typed is theirs, not ours: it must never be
      // replaced by an automatically chosen one, even a larger one.
      state.coupon=promo;state.couponAuto=false;state.couponDismissedFor="";
      toast("Offer applied.","success");render({preserveScroll:true});refreshDynamicPricing().then(()=>render({preserveScroll:true})).catch(()=>{});return;
    }
    if(action==="load-more-restaurants"){loadMoreRestaurants();return;}
    if(action==="remove-coupon"){
      state.couponDismissedFor=state.cart.length?state.cart[0].restaurantId:"";
      state.coupon=null;state.couponAuto=false;
      toast("Offer removed.","success");render({preserveScroll:true});return;
    }
    if(action==="toggle-wallet"){state.useWallet=!state.useWallet;render({preserveScroll:true});refreshDynamicPricing().then(()=>{if(state.route==="checkout")render({preserveScroll:true})}).catch(()=>{});return;}
    if(action==="wallet-refresh"){loadWallet(true);return;}
    if(action==="share-referral"){shareReferral();return;}
    if(action==="set-tip"){
      state.tip=Math.max(0,Math.min(1000,Number(control.dataset.value||0)));
      render({preserveScroll:true});
      if(state.route==="checkout")refreshDynamicPricing().then(()=>{if(state.route==="checkout")render({preserveScroll:true})}).catch(()=>{});
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
    if(action==="open-tracking"){go("order",{orderId:control.dataset.orderId});return;}
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
    if(action==="address-label-chip"){const value=control.dataset.value,address=state.sheet&&state.sheet.address;if(address)address.label=value==="Other"?(addressLabelIsOther(address.label)?address.label:""):value;renderSheet();return;}
    // Routed through the same data-action click dispatcher every other
    // control in this sheet already uses (X, chips, map zoom, "Use phone
    // location") instead of a native <button type="submit"> - this WebView
    // silently drops the form's "submit" event for reasons never fully
    // pinned down (not a required-field block: removing every `required`
    // attribute on this form did not fix it either), so nothing downstream
    // - not even a global window "error"/"unhandledrejection" listener -
    // ever saw a failure to report. Every other control here works reliably
    // with this exact dispatcher, so this sidesteps the broken mechanism
    // rather than chasing it further.
    if(action==="submit-address"){const form=document.getElementById("address-form");if(form)await submitAddress(form);return;}
    if(action==="detect-address-location"){requestLocation("address");return;}
    if(action==="address-map-zoom"){state.addressMapZoom=Math.max(12,Math.min(18,state.addressMapZoom+Number(control.dataset.delta||0)));renderSheet();return;}
    if(action==="address-map-pick"){const rect=control.getBoundingClientRect(),point=state.addressMapDraft||addressMapSeed(null),world=mapWorld(point.lat,point.lng,state.addressMapZoom),next=worldToLatLng(world.x+(event.clientX-rect.left-rect.width/2),world.y+(event.clientY-rect.top-rect.height/2),state.addressMapZoom);state.addressMapDraft=next;if(state.sheet&&state.sheet.address){state.sheet.address.lat=next.lat;state.sheet.address.lng=next.lng;}renderSheet();return;}
    if(action==="select-address"){selectAddress(control.dataset.addressId);return;}
    if(action==="open-address-picker"){setSheet({type:"addressPicker"});return;}
    if(action==="select-address-and-close"){await selectAddress(control.dataset.addressId);closeSheet();return;}
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
    if(!liveOrderRoute()||!state.session||!state.online)return;
    const orderId=state.selectedOrderId;
    if(!orderId)return;
    if(Date.now()-Number(state.trackingSeenAt[orderId]||0)<TRACKING_STREAM_GRACE_MS)return;
    try{
      const value=await rtdb("GET",DB_ROOT+"/tracking/"+encodeURIComponent(orderId));
      applyTrackingEvent(orderId,{path:"/",data:value===undefined?null:value},"put");
    }catch(_){}
  }
  setInterval(pollTrackingFallback,TRACKING_POLL_MS);
  document.addEventListener("visibilitychange",function(){
    if(document.visibilityState==="visible"&&liveOrderRoute())pollTrackingFallback();
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
    try{const cred=await fbAuth.signInWithEmailAndPassword(email,password);applyAuthUser(cred.user);await afterAuth();}
    catch(error){toast(friendlyError(error),"danger");state.loading=false;render({preserveScroll:true});}
  }
  async function submitSignup(form) {
    const name=form.elements["name"].value.trim(),email=form.elements["email"].value.trim().toLowerCase(),phone=form.elements["phone"].value.trim(),password=form.elements["signup-password"].value,confirm=form.elements["signup-confirm"].value,consent=document.getElementById("signup-consent").checked;
    setFieldError("signup-name",name.length>=2?"":"Enter your full name.");setFieldError("signup-email",validEmail(email)?"":"Enter a valid email.");setFieldError("signup-phone",validPhone(phone)?"":"Enter a valid mobile number.");
    const strong=password.length>=8&&/[A-Za-z]/.test(password)&&/\d/.test(password);setFieldError("signup-password",strong?"":"Use 8+ characters with letters and numbers.");setFieldError("signup-confirm",password===confirm?"":"Passwords do not match.");
    if(name.length<2||!validEmail(email)||!validPhone(phone)||!strong||password!==confirm||!consent){if(!consent)toast("Accept the Terms and Privacy Notice to continue.","danger");return;}
    state.loading=true;render({preserveScroll:true});
    try{
      const cred=await fbAuth.createUserWithEmailAndPassword(email,password);applyAuthUser(cred.user);state.profile.name=name;state.profile.email=email;state.profile.phone=phone;state.profile.addresses=[];state.profile.favourites=[];state.profile.emailVerified=false;persistProfile();await saveProfile();
      toast("Account created successfully.","success");await afterAuth();
    }catch(error){toast(friendlyError(error),"danger");state.loading=false;render({preserveScroll:true});}
  }

  async function submitReset(form) {
    const email=form.elements["email"].value.trim().toLowerCase();if(!validEmail(email)){toast("Enter the email used for your Scraveit account.","danger");return;}
    const button=form.querySelector("button[type=submit]");button.disabled=true;button.innerHTML='<span class="spinner"></span> Sending…';
    try{await fbAuth.sendPasswordResetEmail(email);closeSheet();toast("If the account exists, the newest reset link has been sent. Check Inbox and Spam.","success");}
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
  async function escalateSupport(){const transcript=(state.supportAssistant||[]).map(m=>(m.role==='you'?'Customer: ':'Assistant: ')+m.body).join("\n"),o=state.routeData.orderId?orderById(state.routeData.orderId):activeOrders()[0]||null,id=uid("ticket_"),rawMessage=(state.supportAssistant||[]).filter(x=>x.role==='you').map(x=>x.body).join(" | ").slice(0,4000),ticket={id,uid:state.session.uid,customerName:state.profile.name||"",email:state.profile.email||"",orderId:o&&o.id||"",topic:"AI escalation",message:rawMessage.length>=10?rawMessage:"Customer wrote: "+(rawMessage||"needs help"),aiSummary:(supportContext()+" Customer used Scraveit Assistant and requested human help.").slice(0,1000),assistantTranscript:transcript.slice(0,4000),priority:o&&["Arrived","Near you"].includes(o.status)?"high":"normal",seenAt:0,status:"open",createdAt:Date.now(),updatedAt:Date.now()};try{await supportDoc(id).set(ticket);state.supportAssistant=[];toast("Admin support has been alerted. Reference "+id.slice(-8).toUpperCase()+".","success");go("home",{},true)}catch(e){toast("Could not alert support. "+friendlyError(e),"danger")}}

  async function submitSupport(form) {
    const message=form.elements["message"].value.trim();if(message.length<10){setFieldError("support-message","Please add a little more detail.");return;}
    const id=uid("ticket_"),ticket={id:id,uid:state.session.uid,customerName:state.profile.name||"",email:state.profile.email||"",orderId:state.routeData.orderId||"",topic:form.elements["topic"].value,message:message,status:"open",createdAt:Date.now(),updatedAt:Date.now()};
    const button=form.querySelector("button");button.disabled=true;button.innerHTML='<span class="spinner"></span> Submitting…';
    try{await supportDoc(id).set(ticket);form.reset();toast("Support request submitted. Reference "+id.slice(-8).toUpperCase()+".","success");}
    catch(error){toast("Request could not be saved. "+friendlyError(error),"danger");}
    finally{button.disabled=false;button.textContent="Submit support request";}
  }
  function buildReviewPayload(order,rating,riderRating,comment) {
    return {orderId:order.id,customerId:state.session.uid,restaurantId:order.restaurantId,riderId:order.riderId||"",rating,riderRating,comment,postDeliveryTip:0,growthContribution:0,createdAt:Date.now(),status:"published"};
  }
  async function submitReview(form) {
    if(!reviewStateReady()){toast("Feedback status is still syncing. Please wait a moment.");syncOrders(false);return;}
    const data=new FormData(form),rating=Number(data.get("rating"));if(!rating){toast("Choose a restaurant rating.","danger");return;}
    const order=orderById();if(!order)return;if(state.reviews[order.id]){toast("Feedback was already submitted for this order.");render({preserveScroll:true});return;}
    const riderRating=Number(data.get("riderRating")||0);
    const review=buildReviewPayload(order,rating,riderRating,String(data.get("comment")||"").trim());
    try{await reviewDocRef(state.session.uid,order.id).set(review);state.reviews[order.id]=review;state.reviewsHydrated=true;state.reviewsHydratedUid=String(state.session.uid||"");persistReviews();toast("Thank you for helping Scraveit improve.","success");go("home",{},true);}
    catch(error){toast("Review could not be saved. "+friendlyError(error),"danger");}
  }
  async function submitCancellation(form) {
    const orderId=form.dataset.orderId,id=uid("cancel_"),requestData={id:id,type:"cancellation",orderId:orderId,reason:form.elements["reason"].value,status:"requested",createdAt:Date.now(),uid:state.session.uid,customerId:state.session.uid};
    try{await supportDoc(id).set(requestData);closeSheet();toast("Cancellation request sent for restaurant review.","success");}
    catch(error){toast("Cancellation request could not be sent. "+friendlyError(error),"danger");}
  }
  async function submitDeletion(form) {
    if(String(new FormData(form).get("confirmation")||"").trim().toUpperCase()!=="DELETE"){toast("Type DELETE exactly to confirm.","danger");return;}
    const id=uid("privacy_"),record={id:id,type:"account_deletion",uid:state.session.uid,email:state.profile.email||state.session.email,status:"requested",createdAt:Date.now()};
    try{await privacyRequestDoc(id).set(record);closeSheet();toast("Deletion request submitted. Keep reference "+id.slice(-8).toUpperCase()+".","success");}
    catch(error){toast("Deletion request could not be saved. "+friendlyError(error),"danger");}
  }

  document.addEventListener("submit",function(event){
    const form=event.target;if(!(form instanceof HTMLFormElement))return;event.preventDefault();
    if(form.id==="referral-form")applyReferral(form);
    else if(form.id==="login-form")submitLogin(form);
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
  document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible"&&state.session&&state.online)syncOrders(false);if(document.visibilityState==="visible"&&state.route==="home")render({preserveScroll:true});});
  if(window.matchMedia){const media=matchMedia("(prefers-color-scheme: dark)");if(media.addEventListener)media.addEventListener("change",function(){if((state.profile.preferences||{}).theme==="system"){applyTheme();render({preserveScroll:true});}});}

  bootstrap();
})();
