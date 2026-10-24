/*
 * SCRAVEIT privacy notice and consent, shared by the Customer, Store
 * (restaurant, grocery, dairy) and Partner apps and the website.
 *
 * Digital Personal Data Protection Act, 2023: s.5 and DPDP Rules, 2025 r.3
 * (an itemised notice before consent is asked for, with how to withdraw it,
 * exercise rights and complain to the Board), s.5(3) (English or a Schedule
 * VIII language: Telugu here), s.6(1) (consent by a clear affirmative act:
 * an unticked box). Bump VERSION whenever the notice changes so every
 * signed-in account is asked again.
 */
(function () {
  "use strict";
  var VERSION = "2026-10-23.2";
  var LINKS = {
    policy: "https://www.scraveit.in/privacy",
    terms: "https://www.scraveit.in/terms",
    deletion: "https://www.scraveit.in/account-deletion",
    grievance: "https://www.scraveit.in/grievance",
  };
  var GRIEVANCE = {
    en: "Tirumuru Balaji, Grievance Officer, SCRAVEIT PRIVATE LIMITED, 20-4-656, Macleans Road, Revenue Ward No 20-I, Nellore, Andhra Pradesh 524004. Email balaji@scraveit.in",
    te: "తిరుమూరు బాలాజీ, గ్రీవెన్స్ ఆఫీసర్, SCRAVEIT PRIVATE LIMITED, 20-4-656, మెక్లీన్స్ రోడ్, రెవెన్యూ వార్డ్ నం. 20-I, నెల్లూరు, ఆంధ్రప్రదేశ్ 524004. ఈమెయిల్ balaji@scraveit.in",
  };

  // Itemised data and purpose for each kind of account: [data, purpose].
  var ITEMS = {
    customer: {
      en: [
        ["Name, email address and mobile number", "To create and protect your account, sign you in, send order updates and help you recover your account."],
        ["Date of birth", "To check you are 13 or older and, if you are under 18, to ask your parent or guardian to approve your account."],
        ["Delivery addresses and map pin (your precise location only when you tap “use my location”)", "To deliver your order, show stores near you and work out the delivery fee."],
        ["Orders, bills, payment status, tips, ratings and reviews", "To fulfil orders, issue bills, handle refunds and complaints, and show your order history."],
        ["Order chat and support messages", "To coordinate your delivery and resolve problems."],
        ["Only if you use them: username, profile photo, friends, chats and stories (Friends & chat), and gender (About you)", "To run those features. You can switch them off or remove them at any time."],
        ["Device details: notification token, crash and performance reports, and a device-integrity check", "To send notifications, fix crashes and stop fraud and fake accounts."],
        ["What is in your cart, the store you picked and your past orders", "To remind you about a cart you leave and to suggest food at breakfast, lunch and dinner. Turn these off in Account › Preferences."],
      ],
      te: [
        ["పేరు, ఈమెయిల్ చిరునామా, మొబైల్ నంబర్", "మీ ఖాతా సృష్టించి భద్రంగా ఉంచడానికి, సైన్ ఇన్ చేయడానికి, ఆర్డర్ అప్‌డేట్‌లు పంపడానికి, ఖాతా తిరిగి పొందడంలో సహాయం చేయడానికి."],
        ["పుట్టిన తేదీ", "మీకు 13 ఏళ్లు నిండాయో చూడటానికి; 18 ఏళ్ల లోపు అయితే మీ తల్లిదండ్రులు లేదా సంరక్షకుల ఆమోదం అడగడానికి."],
        ["డెలివరీ చిరునామాలు, మ్యాప్ పిన్ (“నా లొకేషన్ వాడు” నొక్కినప్పుడు మాత్రమే మీ ఖచ్చితమైన లొకేషన్)", "మీ ఆర్డర్ అందించడానికి, దగ్గరలోని స్టోర్‌లు చూపడానికి, డెలివరీ ఫీజు లెక్కించడానికి."],
        ["ఆర్డర్లు, బిల్లులు, చెల్లింపు స్థితి, టిప్‌లు, రేటింగ్‌లు, రివ్యూలు", "ఆర్డర్లు పూర్తి చేయడానికి, బిల్లులు ఇవ్వడానికి, రీఫండ్‌లు, ఫిర్యాదులు చూసుకోవడానికి, మీ ఆర్డర్ చరిత్ర చూపడానికి."],
        ["ఆర్డర్ చాట్, సపోర్ట్ సందేశాలు", "మీ డెలివరీ సమన్వయం చేయడానికి, సమస్యలు పరిష్కరించడానికి."],
        ["మీరు వాడితే మాత్రమే: యూజర్‌నేమ్, ప్రొఫైల్ ఫోటో, స్నేహితులు, చాట్‌లు, స్టోరీలు (ఫ్రెండ్స్ & చాట్), లింగం (మీ గురించి)", "ఆ ఫీచర్లు నడపడానికి. ఎప్పుడైనా వాటిని ఆపవచ్చు లేదా తొలగించవచ్చు."],
        ["పరికర వివరాలు: నోటిఫికేషన్ టోకెన్, క్రాష్, పనితీరు రిపోర్టులు, పరికర భద్రత తనిఖీ", "నోటిఫికేషన్‌లు పంపడానికి, క్రాష్‌లు సరిచేయడానికి, మోసం, నకిలీ ఖాతాలు ఆపడానికి."],
        ["మీ కార్ట్‌లో ఉన్నవి, మీరు ఎంచుకున్న స్టోర్, మీ గత ఆర్డర్లు", "మీరు వదిలేసిన కార్ట్ గురించి గుర్తు చేయడానికి, ఉదయం, మధ్యాహ్నం, రాత్రి భోజన సమయాల్లో ఆహారం సూచించడానికి. ఖాతా › ప్రాధాన్యతలు లో వీటిని ఆపవచ్చు."],
      ],
    },
    store: {
      en: [
        ["Owner and staff names, email addresses and mobile numbers", "To create accounts, sign you in and contact you about orders and payouts."],
        ["Store name, address, map location, opening hours, menu, prices and photos", "To list your store and show it to customers nearby."],
        ["FSSAI licence and certificate, PAN, GSTIN and your signed partner agreement", "To check the business may sell food (Food Safety and Standards Act, 2006) and to meet tax law."],
        ["Bank account and IFSC, or UPI ID", "To pay you and send settlement statements."],
        ["Orders, settlements, commission, tax collected and invoices", "To run orders, pay you, and file GST and TCS returns."],
        ["Order chat and support messages", "To coordinate orders and resolve problems."],
        ["Device details: notification token, crash reports and a device-integrity check", "To ring new-order alarms, fix crashes and stop fraud."],
      ],
      te: [
        ["యజమాని, సిబ్బంది పేర్లు, ఈమెయిల్ చిరునామాలు, మొబైల్ నంబర్లు", "ఖాతాలు సృష్టించడానికి, సైన్ ఇన్ చేయడానికి, ఆర్డర్లు, చెల్లింపుల గురించి మిమ్మల్ని సంప్రదించడానికి."],
        ["స్టోర్ పేరు, చిరునామా, మ్యాప్ లొకేషన్, పని వేళలు, మెనూ, ధరలు, ఫోటోలు", "మీ స్టోర్‌ను జాబితాలో చేర్చి దగ్గరలోని కస్టమర్లకు చూపడానికి."],
        ["FSSAI లైసెన్స్, సర్టిఫికెట్, PAN, GSTIN, మీరు సంతకం చేసిన భాగస్వామ్య ఒప్పందం", "వ్యాపారం ఆహారం అమ్మడానికి అనుమతి ఉందో చూడటానికి (ఆహార భద్రత, ప్రమాణాల చట్టం, 2006), పన్ను చట్టం పాటించడానికి."],
        ["బ్యాంక్ ఖాతా, IFSC లేదా UPI ID", "మీకు చెల్లించడానికి, సెటిల్‌మెంట్ స్టేట్‌మెంట్‌లు పంపడానికి."],
        ["ఆర్డర్లు, సెటిల్‌మెంట్‌లు, కమీషన్, వసూలు చేసిన పన్ను, ఇన్‌వాయిస్‌లు", "ఆర్డర్లు నడపడానికి, మీకు చెల్లించడానికి, GST, TCS రిటర్న్‌లు దాఖలు చేయడానికి."],
        ["ఆర్డర్ చాట్, సపోర్ట్ సందేశాలు", "ఆర్డర్లు సమన్వయం చేయడానికి, సమస్యలు పరిష్కరించడానికి."],
        ["పరికర వివరాలు: నోటిఫికేషన్ టోకెన్, క్రాష్ రిపోర్టులు, పరికర భద్రత తనిఖీ", "కొత్త ఆర్డర్ అలారం మోగించడానికి, క్రాష్‌లు సరిచేయడానికి, మోసం ఆపడానికి."],
      ],
    },
    rider: {
      en: [
        ["Name, email address, mobile number, date of birth and gender", "To create your account, check you are 18 or older and contact you."],
        ["Aadhaar secure QR details (name, date of birth, gender, district, state and the last 4 digits only; the QR photo is deleted 7 days after your application is decided), a live face photo, PAN, driving licence number, validity and photos, and vehicle details", "To confirm who you are and that you may legally ride, keep one account per person, and meet tax law."],
        ["Your live location while you are online and during deliveries", "To offer you nearby orders, show customers their delivery’s progress and calculate your pay."],
        ["Bank account and IFSC, or UPI ID, earnings and incentives", "To pay you, deduct and report tax, and register you as a platform worker (Code on Social Security, 2020)."],
        ["Order chat, support messages and ratings", "To coordinate deliveries and resolve problems."],
        ["Device details: notification token, crash reports and a device-integrity check", "To ring delivery offers, fix crashes and stop fraud."],
      ],
      te: [
        ["పేరు, ఈమెయిల్ చిరునామా, మొబైల్ నంబర్, పుట్టిన తేదీ, లింగం", "మీ ఖాతా సృష్టించడానికి, మీకు 18 ఏళ్లు నిండాయో చూడటానికి, మిమ్మల్ని సంప్రదించడానికి."],
        ["ఆధార్ సెక్యూర్ QR వివరాలు (పేరు, పుట్టిన తేదీ, లింగం, జిల్లా, రాష్ట్రం, చివరి 4 అంకెలు మాత్రమే; మీ దరఖాస్తుపై నిర్ణయం అయిన 7 రోజుల్లో QR ఫోటో తొలగిస్తాం), లైవ్ ఫేస్ ఫోటో, PAN, డ్రైవింగ్ లైసెన్స్ నంబర్, చెల్లుబాటు తేదీ, ఫోటోలు, వాహన వివరాలు", "మీరు ఎవరో, చట్టబద్ధంగా వాహనం నడపవచ్చో నిర్ధారించడానికి, ఒక్కరికి ఒకే ఖాతా ఉండేలా చూడటానికి, పన్ను చట్టం పాటించడానికి."],
        ["మీరు ఆన్‌లైన్‌లో ఉన్నప్పుడు, డెలివరీ చేస్తున్నప్పుడు మీ లైవ్ లొకేషన్", "దగ్గరలోని ఆర్డర్లు ఇవ్వడానికి, కస్టమర్లకు డెలివరీ ఎక్కడుందో చూపడానికి, మీ చెల్లింపు లెక్కించడానికి."],
        ["బ్యాంక్ ఖాతా, IFSC లేదా UPI ID, సంపాదన, ప్రోత్సాహకాలు", "మీకు చెల్లించడానికి, పన్ను కోసి నివేదించడానికి, మిమ్మల్ని ప్లాట్‌ఫామ్ వర్కర్‌గా నమోదు చేయడానికి (సామాజిక భద్రత కోడ్, 2020)."],
        ["ఆర్డర్ చాట్, సపోర్ట్ సందేశాలు, రేటింగ్‌లు", "డెలివరీలు సమన్వయం చేయడానికి, సమస్యలు పరిష్కరించడానికి."],
        ["పరికర వివరాలు: నోటిఫికేషన్ టోకెన్, క్రాష్ రిపోర్టులు, పరికర భద్రత తనిఖీ", "డెలివరీ ఆఫర్ అలారం మోగించడానికి, క్రాష్‌లు సరిచేయడానికి, మోసం ఆపడానికి."],
      ],
    },
  };

  // Who receives the data, per kind of account.
  var SHARED = {
    customer: {
      en: ["The store you order from: your name, the items and your order notes.", "The delivery partner for that order: your name, phone number and delivery address, only for that delivery."],
      te: ["మీరు ఆర్డర్ చేసే స్టోర్: మీ పేరు, వస్తువులు, ఆర్డర్ నోట్స్.", "ఆ ఆర్డర్ డెలివరీ భాగస్వామి: మీ పేరు, ఫోన్ నంబర్, డెలివరీ చిరునామా, ఆ డెలివరీకి మాత్రమే."],
    },
    store: {
      en: ["Customers: your store name, address, FSSAI number, menu, prices and photos.", "The delivery partner for an order: your store name, address and pickup details.", "Tax authorities: your GSTIN and sales through SCRAVEIT, in our GST and TCS returns."],
      te: ["కస్టమర్లు: మీ స్టోర్ పేరు, చిరునామా, FSSAI నంబర్, మెనూ, ధరలు, ఫోటోలు.", "ఆర్డర్ డెలివరీ భాగస్వామి: మీ స్టోర్ పేరు, చిరునామా, పికప్ వివరాలు.", "పన్ను అధికారులు: మా GST, TCS రిటర్న్‌లలో మీ GSTIN, SCRAVEIT ద్వారా జరిగిన అమ్మకాలు."],
    },
    rider: {
      en: ["The customer of an order: your name, vehicle and live location, only during their delivery.", "The store you pick up from: your name, for the handover.", "Amazon Web Services in Mumbai, India: your face photo, to match it to your Aadhaar photo and to check for duplicate accounts. The face record is kept while your account exists.", "Government: details needed to register you as a platform worker and to report tax."],
      te: ["ఆర్డర్ కస్టమర్: మీ పేరు, వాహనం, లైవ్ లొకేషన్, వారి డెలివరీ సమయంలో మాత్రమే.", "మీరు పికప్ చేసే స్టోర్: అప్పగింత కోసం మీ పేరు.", "ముంబై, భారతదేశంలోని అమెజాన్ వెబ్ సర్వీసెస్: మీ ఫేస్ ఫోటోను ఆధార్ ఫోటోతో సరిపోల్చడానికి, నకిలీ ఖాతాలు లేకుండా చూడటానికి. మీ ఖాతా ఉన్నంత వరకు ఫేస్ రికార్డ్ ఉంచుతాం.", "ప్రభుత్వం: మిమ్మల్ని ప్లాట్‌ఫామ్ వర్కర్‌గా నమోదు చేయడానికి, పన్ను నివేదించడానికి అవసరమైన వివరాలు."],
    },
  };

  var T = {
    en: {
      title: "Privacy Notice",
      intro: "SCRAVEIT PRIVATE LIMITED (“SCRAVEIT”, the Data Fiduciary) asks for your consent to use the personal data below, only for the purpose given next to each item, under the Digital Personal Data Protection Act, 2023.",
      dataHead: "What we collect and why",
      colData: "Your data",
      colWhy: "Why we use it",
      sharedHead: "Who receives it",
      processors: "Companies that process data for us: Google Firebase and Google Cloud (accounts, our database in Mumbai, India, photo storage in the United States, notifications and crash reports), Cloudflare (photo delivery), and OpenStreetMap and OSRM (maps and routes; only map coordinates are sent).",
      law: "Authorities, when the law requires it.",
      noSale: "We never sell your personal data.",
      keepHead: "How long we keep it",
      keep: "While your account is open. When you delete your account, we erase your profile, addresses, preferences, chats and photos within 30 days. Records the law makes us keep (invoices, tax, food-safety and verification records) are kept for the period it sets, up to 8 years, with nothing more than that law needs.",
      rightsHead: "Your rights",
      rights: [
        "See a summary of your data and who it has been shared with.",
        "Correct, complete or update your data, or ask us to erase it.",
        "Withdraw your consent at any time, as easily as you gave it: in the app, Account › Privacy, or at scraveit.in/account-deletion. We then stop using your data and delete your account. Use before withdrawal stays lawful.",
        "Nominate someone to exercise these rights for you if you die or can’t act yourself.",
      ],
      complainHead: "Questions and complaints",
      complain: "Contact our Grievance Officer: ",
      reply: "We reply within 30 days. If you are not satisfied, you can complain to the Data Protection Board of India.",
      breach: "If a data breach affects you, we will tell you and the Data Protection Board without delay.",
      minor: "If you are under 18, your parent or guardian must approve your account before you can use it.",
      full: "Full Privacy Policy",
      terms: "Terms of Service",
      version: "Notice version ",
      lang: "Read in",
      agree: "I have read this Privacy Notice and I agree to SCRAVEIT using my personal data for the purposes it lists. I also agree to the ",
      agreeEnd: ".",
      readNotice: "Read the Privacy Notice",
      gateTitle: "Before you continue",
      gateCopy: "Please read how SCRAVEIT uses your data and give your consent.",
      gateAgree: "Agree and continue",
      gateSignOut: "Don’t agree, sign out",
      close: "Close",
      tickFirst: "Tick the box to agree to the Privacy Notice first.",
    },
    te: {
      title: "గోప్యతా నోటీసు",
      intro: "డిజిటల్ వ్యక్తిగత డేటా సంరక్షణ చట్టం, 2023 ప్రకారం, SCRAVEIT PRIVATE LIMITED (“SCRAVEIT”, డేటా ఫిడ్యూషియరీ) కింది వ్యక్తిగత డేటాను, ప్రతి అంశం పక్కన ఇచ్చిన ప్రయోజనం కోసం మాత్రమే వాడటానికి మీ సమ్మతి కోరుతోంది.",
      dataHead: "మేము ఏమి సేకరిస్తాం, ఎందుకు",
      colData: "మీ డేటా",
      colWhy: "ఎందుకు వాడతాం",
      sharedHead: "ఎవరికి అందుతుంది",
      processors: "మా కోసం డేటా ప్రాసెస్ చేసే సంస్థలు: Google Firebase, Google Cloud (ఖాతాలు, ముంబై, భారతదేశంలో మా డేటాబేస్, అమెరికాలో ఫోటో నిల్వ, నోటిఫికేషన్‌లు, క్రాష్ రిపోర్టులు), Cloudflare (ఫోటోలు చూపడం), OpenStreetMap, OSRM (మ్యాప్‌లు, రూట్‌లు; మ్యాప్ కోఆర్డినేట్‌లు మాత్రమే పంపుతాం).",
      law: "చట్టం కోరినప్పుడు అధికారులకు.",
      noSale: "మీ వ్యక్తిగత డేటాను మేము ఎప్పుడూ అమ్మము.",
      keepHead: "ఎంత కాలం ఉంచుతాం",
      keep: "మీ ఖాతా ఉన్నంత కాలం. మీరు ఖాతా తొలగిస్తే, 30 రోజుల్లో మీ ప్రొఫైల్, చిరునామాలు, ప్రాధాన్యతలు, చాట్‌లు, ఫోటోలు తొలగిస్తాం. చట్టం ఉంచమని చెప్పే రికార్డులు (ఇన్‌వాయిస్‌లు, పన్ను, ఆహార భద్రత, ధృవీకరణ రికార్డులు) ఆ చట్టం చెప్పిన కాలం, గరిష్ఠంగా 8 ఏళ్లు, ఆ చట్టానికి అవసరమైనంత మాత్రమే ఉంచుతాం.",
      rightsHead: "మీ హక్కులు",
      rights: [
        "మీ డేటా సారాంశం, అది ఎవరితో పంచుకున్నామో చూడటం.",
        "మీ డేటాను సరిచేయడం, పూర్తి చేయడం, అప్‌డేట్ చేయడం, లేదా తొలగించమని అడగడం.",
        "ఇచ్చినంత సులభంగా ఎప్పుడైనా సమ్మతి ఉపసంహరించుకోవడం: యాప్‌లో ఖాతా › గోప్యత, లేదా scraveit.in/account-deletion లో. అప్పుడు మీ డేటా వాడటం ఆపి మీ ఖాతా తొలగిస్తాం. ఉపసంహరణకు ముందు వాడినది చట్టబద్ధంగానే ఉంటుంది.",
        "మీరు మరణించినా లేదా స్వయంగా చేయలేకపోయినా, మీ తరఫున ఈ హక్కులు వాడటానికి ఒకరిని నామినేట్ చేయడం.",
      ],
      complainHead: "ప్రశ్నలు, ఫిర్యాదులు",
      complain: "మా గ్రీవెన్స్ ఆఫీసర్‌ను సంప్రదించండి: ",
      reply: "30 రోజుల్లో జవాబిస్తాం. సంతృప్తి లేకపోతే భారత డేటా సంరక్షణ బోర్డుకు ఫిర్యాదు చేయవచ్చు.",
      breach: "డేటా ఉల్లంఘన మీపై ప్రభావం చూపితే, ఆలస్యం లేకుండా మీకు, డేటా సంరక్షణ బోర్డుకు తెలియజేస్తాం.",
      minor: "మీకు 18 ఏళ్ల లోపు అయితే, మీరు వాడే ముందు మీ తల్లిదండ్రులు లేదా సంరక్షకులు మీ ఖాతాను ఆమోదించాలి.",
      full: "పూర్తి గోప్యతా విధానం",
      terms: "సేవా నిబంధనలు",
      version: "నోటీసు వెర్షన్ ",
      lang: "ఈ భాషలో చదవండి",
      agree: "ఈ గోప్యతా నోటీసు చదివాను. ఇందులో చెప్పిన ప్రయోజనాల కోసం SCRAVEIT నా వ్యక్తిగత డేటా వాడటానికి అంగీకరిస్తున్నాను. ",
      agreeEnd: "కు కూడా అంగీకరిస్తున్నాను.",
      readNotice: "గోప్యతా నోటీసు చదవండి",
      gateTitle: "కొనసాగే ముందు",
      gateCopy: "SCRAVEIT మీ డేటాను ఎలా వాడుతుందో చదివి మీ సమ్మతి ఇవ్వండి.",
      gateAgree: "అంగీకరించి కొనసాగండి",
      gateSignOut: "అంగీకరించను, సైన్ అవుట్",
      close: "మూసివేయి",
      tickFirst: "ముందుగా గోప్యతా నోటీసుకు అంగీకరిస్తూ బాక్స్ టిక్ చేయండి.",
    },
  };

  function pick(lang) { return lang === "te" ? "te" : "en"; }
  function aud(a) { return a === "store" || a === "rider" ? a : "customer"; }
  function link(href, text) {
    return '<a href="' + href + '" target="_blank" rel="noopener">' + text + "</a>";
  }

  function ensureStyle() {
    if (document.getElementById("sp-style")) return;
    var style = document.createElement("style");
    style.id = "sp-style";
    style.textContent = [
      ".sp{--sp-brand:var(--brand,var(--accent,#e4572e));--sp-ink:var(--ink,#1b1b1f);--sp-muted:var(--muted,var(--ink-soft,#5d6068));--sp-line:var(--border,var(--line,#e3e3e8));--sp-soft:var(--brand-soft,rgba(0,0,0,.04));color:var(--sp-ink);font-size:14px;line-height:1.5}",
      ".sp h3{font-size:15px;font-weight:800;margin:18px 0 6px}",
      ".sp p{margin:6px 0}",
      ".sp ul{margin:6px 0;padding-left:20px}.sp li{margin:4px 0}",
      ".sp .sp-muted{color:var(--sp-muted);font-size:12.5px}",
      ".sp .sp-items{display:grid;gap:8px;margin:8px 0}",
      ".sp .sp-item{border:1px solid var(--sp-line);border-radius:12px;padding:10px 12px}",
      ".sp .sp-item b{display:block;font-weight:700}",
      ".sp .sp-item span{display:block;color:var(--sp-muted);margin-top:3px}",
      ".sp .sp-langs{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0 8px}",
      ".sp .sp-langs button{border:1px solid var(--sp-line);background:transparent;color:inherit;border-radius:999px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}",
      ".sp .sp-langs button[aria-pressed=true]{background:var(--sp-brand);border-color:var(--sp-brand);color:#fff}",
      ".sp a{color:var(--sp-brand);font-weight:700}",
      ".sp-consent{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--border,var(--line,#e3e3e8));border-radius:12px;padding:12px;font-size:13.5px;line-height:1.45}",
      ".sp-consent input{width:20px;height:20px;flex:0 0 auto;margin-top:1px;accent-color:var(--brand,var(--accent,#e4572e))}",
      ".sp-consent a{color:var(--brand,var(--accent,#e4572e));font-weight:700}",
      ".sp-read{background:none;border:0;padding:0;color:var(--brand,var(--accent,#e4572e));font:inherit;font-weight:800;text-decoration:underline;cursor:pointer}",
      ".sp-modal{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center}",
      ".sp-modal-card{background:var(--surface,var(--card,var(--paper,#fff)));width:100%;max-width:640px;max-height:88vh;overflow:auto;border-radius:20px 20px 0 0;padding:18px 18px calc(18px + env(safe-area-inset-bottom))}",
      "@media(min-width:700px){.sp-modal{align-items:center}.sp-modal-card{border-radius:20px}}",
      ".sp-modal-head{display:flex;justify-content:space-between;align-items:center;gap:12px}",
      ".sp-modal-head h2{font-size:20px;font-weight:800;margin:0}",
      ".sp-x{border:0;background:var(--sp-soft,rgba(0,0,0,.06));color:inherit;width:36px;height:36px;border-radius:50%;font-size:18px;cursor:pointer}",
      ".sp-gate{min-height:100vh;box-sizing:border-box;padding:calc(20px + env(safe-area-inset-top)) 18px calc(24px + env(safe-area-inset-bottom));max-width:640px;margin:0 auto;display:flex;flex-direction:column;gap:14px}",
      ".sp-gate h1{font-size:26px;font-weight:800;margin:0}",
      ".sp-gate .sp-box{border:1px solid var(--border,var(--line,#e3e3e8));border-radius:16px;padding:4px 14px 14px;background:var(--surface,var(--card,#fff))}",
      ".sp-btn{display:block;width:100%;border:0;border-radius:14px;padding:14px;font:inherit;font-weight:800;font-size:15px;cursor:pointer}",
      ".sp-btn.primary{background:var(--brand,var(--accent,#e4572e));color:#fff}",
      ".sp-btn.primary[disabled]{opacity:.45}",
      ".sp-btn.ghost{background:transparent;color:inherit;border:1px solid var(--border,var(--line,#e3e3e8))}",
    ].join("\n");
    document.head.appendChild(style);
  }

  function noticeHtml(audience, lang) {
    var a = aud(audience), l = pick(lang), t = T[l];
    var items = ITEMS[a][l].map(function (row) {
      return '<div class="sp-item"><b>' + row[0] + "</b><span>" + row[1] + "</span></div>";
    }).join("");
    var shared = SHARED[a][l].concat([t.processors, t.law]).map(function (s) { return "<li>" + s + "</li>"; }).join("");
    var rights = t.rights.map(function (s) { return "<li>" + s + "</li>"; }).join("");
    return '<div class="sp" translate="no">'
      + '<div class="sp-langs" role="group" aria-label="' + t.lang + '"><span class="sp-muted">' + t.lang + '</span>'
      + '<button type="button" data-sp-action="lang" data-sp-lang="en" aria-pressed="' + (l === "en") + '">English</button>'
      + '<button type="button" data-sp-action="lang" data-sp-lang="te" aria-pressed="' + (l === "te") + '">తెలుగు</button></div>'
      + "<p>" + t.intro + "</p>"
      + "<h3>" + t.dataHead + '</h3><div class="sp-items">' + items + "</div>"
      + "<h3>" + t.sharedHead + "</h3><ul>" + shared + "</ul><p><b>" + t.noSale + "</b></p>"
      + "<h3>" + t.keepHead + "</h3><p>" + t.keep + "</p>"
      + "<h3>" + t.rightsHead + "</h3><ul>" + rights + "</ul>"
      + (a === "customer" ? "<p>" + t.minor + "</p>" : "")
      + "<h3>" + t.complainHead + "</h3><p>" + t.complain + GRIEVANCE[l] + ". " + t.reply + "</p><p>" + t.breach + "</p>"
      + "<p>" + link(LINKS.policy, t.full) + " · " + link(LINKS.terms, t.terms) + "</p>"
      + '<p class="sp-muted">' + t.version + VERSION + "</p>"
      + "</div>";
  }

  /** The unticked consent box for a sign-up form. */
  function consentLabel(audience, lang, id) {
    var l = pick(lang), t = T[l];
    ensureStyle();
    return '<div class="sp-consent-wrap" translate="no" style="display:grid;gap:8px">'
      + '<button type="button" class="sp-read" data-sp-action="open" data-sp-audience="' + aud(audience) + '">' + t.readNotice + "</button>"
      + '<label class="sp-consent"><input type="checkbox" id="' + (id || "sp-consent") + '" name="privacyConsent">'
      + "<span>" + t.agree + link(LINKS.terms, t.terms) + t.agreeEnd + " " + link(LINKS.policy, t.full) + "</span></label></div>";
  }

  /** A full-screen screen shown to a signed-in account that has not agreed to this version. */
  function gateHtml(audience, lang, busy) {
    var l = pick(lang), t = T[l];
    ensureStyle();
    return '<main class="sp-gate" translate="no" data-sp-gate="' + aud(audience) + '"><div><h1>' + t.gateTitle + '</h1><p class="sp-muted" style="margin-top:6px;font-size:14px">' + t.gateCopy + "</p></div>"
      + '<div class="sp-box"><h2 style="font-size:18px;font-weight:800;margin:14px 0 4px">' + t.title + "</h2>" + noticeHtml(audience, l) + "</div>"
      + '<label class="sp-consent"><input type="checkbox" id="sp-gate-box" data-sp-action="tick"><span>' + t.agree + link(LINKS.terms, t.terms) + t.agreeEnd + "</span></label>"
      + '<button type="button" class="sp-btn primary" data-sp-action="agree" disabled' + (busy ? ' aria-busy="true"' : "") + ">" + t.gateAgree + "</button>"
      + '<button type="button" class="sp-btn ghost" data-sp-action="signout">' + t.gateSignOut + "</button></main>";
  }

  var handlers = {}, modalAudience = "customer", modalLang = "en";
  function currentLang() {
    var chosen = "";
    try { chosen = localStorage.getItem("scraveit.privacy.lang") || ""; } catch (_) { }
    if (chosen === "te" || chosen === "en") return chosen;
    try { if (handlers.lang) return pick(handlers.lang()); } catch (_) { }
    try { if (window.ScraveitLanguage && window.ScraveitLanguage.get) return pick(window.ScraveitLanguage.get()); } catch (_) { }
    return "en";
  }
  function setLang(lang) {
    try { localStorage.setItem("scraveit.privacy.lang", pick(lang)); } catch (_) { }
  }

  function openNotice(audience) {
    ensureStyle();
    modalAudience = aud(audience);
    modalLang = currentLang();
    closeNotice();
    var t = T[modalLang], overlay = document.createElement("div");
    overlay.className = "sp-modal";
    overlay.setAttribute("translate", "no");
    overlay.id = "sp-modal";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", t.title);
    overlay.innerHTML = '<div class="sp-modal-card"><div class="sp-modal-head"><h2>' + t.title + '</h2><button type="button" class="sp-x" data-sp-action="close" aria-label="' + t.close + '">✕</button></div>'
      + noticeHtml(modalAudience, modalLang)
      + '<button type="button" class="sp-btn primary" style="margin-top:14px" data-sp-action="close">' + t.close + "</button></div>";
    overlay.addEventListener("click", function (event) { if (event.target === overlay) closeNotice(); });
    document.body.appendChild(overlay);
    return true;
  }
  function closeNotice() {
    var existing = document.getElementById("sp-modal");
    if (existing) existing.remove();
  }
  function modalOpen() { return !!document.getElementById("sp-modal"); }

  document.addEventListener("click", function (event) {
    var control = event.target.closest && event.target.closest("[data-sp-action]");
    if (!control) return;
    var action = control.getAttribute("data-sp-action");
    if (action === "tick") return;
    event.preventDefault();
    if (action === "open") { openNotice(control.getAttribute("data-sp-audience")); return; }
    if (action === "close") { closeNotice(); return; }
    if (action === "lang") {
      var lang = pick(control.getAttribute("data-sp-lang"));
      setLang(lang);
      if (modalOpen()) { openNotice(modalAudience); return; }
      if (handlers.onLang) handlers.onLang(lang);
      return;
    }
    if (action === "agree") {
      var box = document.getElementById("sp-gate-box");
      if (!box || !box.checked) { if (handlers.toast) handlers.toast(T[currentLang()].tickFirst); return; }
      control.disabled = true;
      if (handlers.onAgree) handlers.onAgree(currentLang());
      return;
    }
    if (action === "signout" && handlers.onSignOut) handlers.onSignOut();
  }, true);
  document.addEventListener("change", function (event) {
    if (event.target && event.target.id === "sp-gate-box") {
      var button = document.querySelector('[data-sp-action="agree"]');
      if (button) button.disabled = !event.target.checked;
    }
  }, true);

  /** The record saved when someone agrees: which notice, when, in which language and how. */
  function consentRecord(uid, audience, lang, method, appName) {
    return {
      uid: String(uid || ""),
      audience: aud(audience),
      version: VERSION,
      lang: pick(lang),
      method: method === "gate" ? "gate" : "signup",
      app: String(appName || "").slice(0, 40),
      acceptedAt: Date.now(),
    };
  }
  function consentDocId(uid, audience) { return String(uid || "") + "_" + aud(audience); }
  function isCurrent(record) { return !!(record && record.version === VERSION); }

  window.ScraveitPrivacy = {
    VERSION: VERSION,
    LINKS: LINKS,
    noticeHtml: noticeHtml,
    consentLabel: consentLabel,
    gateHtml: gateHtml,
    openNotice: openNotice,
    closeNotice: closeNotice,
    consentRecord: consentRecord,
    consentDocId: consentDocId,
    isCurrent: isCurrent,
    lang: currentLang,
    tickFirstMessage: function () { return T[currentLang()].tickFirst; },
    /** handlers: {onAgree(lang), onSignOut(), onLang(lang), toast(message), lang()} */
    bind: function (next) { handlers = next || {}; },
  };
})();
