/*
 * The website's catalogue before SCRAVEIT's FSSAI licence is issued.
 *
 * Restaurants: the two onboarded partner restaurants, each with a short sample
 * menu, laid out the way food is sold on SCRAVEIT (FSS (Labelling and Display)
 * Regulations, 2020 and FSSAI Order dated 18.03.2026, Annexure 1 item 11).
 * Groceries and dairy: one sample store each, with a few pre-packed products
 * carrying every particular the regulations require on an e-commerce page.
 * Everything is marked as a sample; nothing here can be ordered.
 * Dish photos: Wikimedia Commons, credited in PHOTO_CREDITS. Packaged products are drawn packs.
 */
(function () {
  const PENDING_SELLER = "Shown here once this partner store is onboarded (seller's own FSSAI licence)";
  const PENDING_MFR = "Taken from the product label when a real product is listed";
  const PENDING_MFR_LIC = "Manufacturer's FSSAI licence number, taken from the product label";

  window.SCRAVEIT_PHOTO_CREDITS = {"chicken-dum-biryani": {"a": "Vis M", "l": "CC BY-SA 4.0", "s": "https://commons.wikimedia.org/wiki/File:Chicken_Dum_Biryani_03.jpg"}, "chicken-65": {"a": "Amiyashrivastava", "l": "CC BY-SA 3.0", "s": "https://commons.wikimedia.org/wiki/File:Chicken_65_(Dish).jpg"}, "paneer-butter-masala": {"a": "Ganesh Mohan T", "l": "CC BY-SA 4.0", "s": "https://commons.wikimedia.org/wiki/File:Rotti_and_Paneer_Butter_Masala.jpg"}, "butter-naan": {"a": "Ganesh Mohan T", "l": "CC BY-SA 4.0", "s": "https://commons.wikimedia.org/wiki/File:Butter_Naan_2.jpg"}, "gulab-jamun": {"a": "Suyash.dwivedi", "l": "CC BY-SA 4.0", "s": "https://commons.wikimedia.org/wiki/File:Two_Gulab_Jamun_in_a_plate_01.jpg"}, "belgian-waffle": {"a": "Paul Lowry", "l": "CC BY 2.0", "s": "https://commons.wikimedia.org/wiki/File:Waffle_with_fleur-de-lis,_Metairie,_Louisiana.jpg"}, "chocolate-waffle": {"a": "Gpkp", "l": "CC BY-SA 4.0", "s": "https://commons.wikimedia.org/wiki/File:Chocolate_Waffle_(2026).jpg"}, "pancakes": {"a": "Maffeth.opiana", "l": "CC BY-SA 4.0", "s": "https://commons.wikimedia.org/wiki/File:Pancake_with_maple_syrup_1.jpg"}, "vanilla-ice-cream": {"a": "a.pasquier from bellingham, washington", "l": "CC BY-SA 2.0", "s": "https://commons.wikimedia.org/wiki/File:Vanilla_bean_ice_cream_(3086700978).jpg"}, "brownie-ice-cream": {"a": "Dr. Chinchu C.", "l": "CC BY-SA 4.0", "s": "https://commons.wikimedia.org/wiki/File:Brownies_with_Ice_cream.jpg"}};

  const n = (energy, protein, carb, sugar, addedSugar, fat, satFat, transFat, sodium, per) =>
    ({per: per || "100 g", energyKcal: energy, proteinG: protein, carbohydrateG: carb, totalSugarsG: sugar,
      addedSugarsG: addedSugar, fatG: fat, saturatedFatG: satFat, transFatG: transFat, sodiumMg: sodium});

  function product(o) {
    return Object.assign({diet: "veg", available: true}, o, {
      sample: true,
      imageUrl: o.photo ? "/shop/img/" + o.photo + ".jpg" : "",
      compliance: Object.assign({
        brand: "Sample brand",
        countryOfOrigin: "India",
        manufacturer: PENDING_MFR,
        manufacturerFssai: PENDING_MFR_LIC,
        sellerFssai: PENDING_SELLER,
        bestBefore: "Printed on the pack. Delivered with at least 30% of shelf life, or 45 days, remaining.",
        customerCare: "balaji@scraveit.in · +91 9652509409 · Grievance officer: www.scraveit.in/grievance",
      }, o.compliance || {}, {sampleValues: true}),
    });
  }

  window.SCRAVEIT_SAMPLE_STORES = [
    {
      id: "sample-grocery", storeType: "grocery", name: "Scraveit Grocery Partner",
      tagline: "Atta, dal, baking needs and health foods", city: "Nellore",
      address: "Sample partner kirana store, Nellore, Andhra Pradesh",
      etaMin: 25, etaMax: 40, sample: true, sellerFssai: PENDING_SELLER,
      items: [
        product({id: "atta-5kg", name: "Whole Wheat Atta", category: "Atta, rice & dal", price: 285, icon: "wheat", pack: "pouch", packColor: "#c9852f",
          description: "Stone-ground whole wheat flour for soft rotis and parathas.",
          compliance: {serving: "40 g (1 roti)", servingG: 40, netQuantity: "5 kg", mrp: 299, ingredients: "Whole wheat (100%).",
            allergens: "Contains gluten (wheat).", storage: "Store in a cool, dry place in an airtight container.",
            shelfLife: "4 months from packing", foodCategory: "06 - Cereals and cereal products",
            nutrition: n(341, 12.1, 69.4, 1.2, 0, 1.7, 0.3, 0, 2)}}),
        product({id: "toor-dal-1kg", name: "Toor Dal", category: "Atta, rice & dal", price: 168, icon: "grains", pack: "pouch", packColor: "#d9a521",
          description: "Unpolished split pigeon peas for sambar and pappu.",
          compliance: {serving: "30 g", servingG: 30, netQuantity: "1 kg", mrp: 180, ingredients: "Toor dal (split pigeon pea) (100%).", allergens: "None declared.",
            storage: "Store in a cool, dry place.", shelfLife: "9 months from packing",
            foodCategory: "06 - Cereals and cereal products (pulses)", nutrition: n(335, 22.3, 57.6, 2.9, 0, 1.7, 0.4, 0, 17)}}),
        product({id: "baking-powder-100g", name: "Baking Powder", category: "Baking needs", price: 38, icon: "cake", pack: "box", packColor: "#3d6fb6",
          description: "Double-acting raising agent for cakes and idli batter.",
          compliance: {serving: "2 g (½ tsp)", servingG: 2, netQuantity: "100 g", mrp: 40,
            ingredients: "Raising agents (INS 500(ii), INS 341(i)), corn starch.", allergens: "None declared.",
            storage: "Store in a cool, dry place. Close the lid tightly after use.", shelfLife: "12 months from packing",
            foodCategory: "99 - Substances added to food (99.1 food additives, sold sealed for home use)",
            nutrition: n(53, 0, 13, 0, 0, 0, 0, 0, 10600)}}),
        product({id: "protein-supplement-500g", name: "Whey Protein Health Supplement", category: "Health foods", price: 1199, icon: "scoop", pack: "jar", packColor: "#5b3a8c",
          description: "HEALTH SUPPLEMENT. NOT FOR MEDICINAL USE. Mix 30 g in 200 ml water or milk, once a day. Not for children, pregnant or lactating women.",
          compliance: {serving: "30 g (1 scoop)", servingG: 30, directions: "HEALTH SUPPLEMENT. NOT FOR MEDICINAL USE. Mix 1 scoop (30 g) in 200 ml water or milk, once a day. Do not exceed the recommended daily usage. Not for children, pregnant or lactating women.", netQuantity: "500 g", mrp: 1299,
            ingredients: "Whey protein concentrate (milk), cocoa powder, emulsifier (INS 322 (soy lecithin)), sweetener (INS 960).",
            allergens: "Contains milk and soy.", storage: "Store in a cool, dry place away from sunlight.", shelfLife: "18 months from manufacture",
            foodCategory: "13 - Foodstuffs intended for particular nutritional uses (13.6 health supplements), sold sealed, as packed by a licensed manufacturer",
            nutrition: n(390, 72, 10, 6, 0, 6.5, 4, 0.1, 210)}}),
      ],
    },
    {
      id: "sample-dairy", storeType: "dairy", name: "Scraveit Dairy Partner",
      tagline: "Milk, curd, paneer and ghee", city: "Nellore",
      address: "Sample partner dairy, Nellore, Andhra Pradesh",
      etaMin: 20, etaMax: 35, sample: true, sellerFssai: PENDING_SELLER,
      items: [
        product({id: "toned-milk-500ml", name: "Toned Milk", category: "Milk", price: 29, icon: "drop", pack: "sachet", packColor: "#2a7bc0",
          description: "Pasteurised toned milk. Boil before use.",
          compliance: {serving: "200 ml (1 glass)", servingG: 200, netQuantity: "500 ml", mrp: 29, ingredients: "Toned milk (3.0% fat, 8.5% SNF).", allergens: "Contains milk.",
            storage: "Keep refrigerated below 4°C. Use within 2 days of packing.", shelfLife: "2 days from packing (refrigerated)",
            foodCategory: "01 - Dairy products and analogues", nutrition: n(58, 3.1, 4.7, 4.7, 0, 3.0, 1.9, 0.1, 45, "100 ml")}}),
        product({id: "curd-400g", name: "Fresh Curd", category: "Curd & paneer", price: 45, icon: "cup", pack: "tub", packColor: "#2f8f5b",
          description: "Thick set curd made from pasteurised toned milk.",
          compliance: {serving: "100 g", servingG: 100, netQuantity: "400 g", mrp: 45, ingredients: "Pasteurised toned milk, active cultures.", allergens: "Contains milk.",
            storage: "Keep refrigerated below 4°C.", shelfLife: "4 days from packing (refrigerated)",
            foodCategory: "01 - Dairy products and analogues", nutrition: n(60, 3.2, 4.5, 4.5, 0, 3.1, 2.0, 0.1, 46)}}),
        product({id: "paneer-200g", name: "Fresh Paneer", category: "Curd & paneer", price: 92, icon: "cube", pack: "box", packColor: "#b8862b",
          description: "Soft malai paneer for curries and tikka.",
          compliance: {serving: "50 g", servingG: 50, netQuantity: "200 g", mrp: 95, ingredients: "Milk solids, citric acid (INS 330).", allergens: "Contains milk.",
            storage: "Keep refrigerated below 4°C. Use within 2 days of opening.", shelfLife: "7 days from packing (refrigerated)",
            foodCategory: "01 - Dairy products and analogues", nutrition: n(292, 18.3, 1.2, 1.2, 0, 23.5, 15.2, 0.6, 30)}}),
        product({id: "ghee-500ml", name: "Cow Ghee", category: "Ghee & butter", price: 349, icon: "drop", pack: "jar", packColor: "#d4a017",
          description: "Pure cow ghee with a rich, grainy texture.",
          compliance: {serving: "10 g (1 tsp)", servingG: 10, netQuantity: "500 ml (455 g)", mrp: 365, ingredients: "Milk fat (100%).", allergens: "Contains milk.",
            storage: "Store in a cool, dry place. Use a dry spoon.", shelfLife: "12 months from packing",
            foodCategory: "01 - Dairy products and analogues", nutrition: n(897, 0, 0, 0, 0, 99.7, 62, 2.5, 0)}}),
      ],
    },
  ];

  // Restaurant facts the catalogue does not hold yet, shown in the page header.
  window.SCRAVEIT_RESTAURANT_INFO = {
    "highway-cross-hh1d": {cuisines: "North Indian, Biryani, Chinese", priceForTwo: 400, area: "Pellakur, Naidupeta", opens: "11:00 am", closes: "11:00 pm"},
    "the-waffle-spot-naidupeta": {cuisines: "Waffles, Pancakes, Desserts", priceForTwo: 250, area: "L.A. Sagaram, Naidupeta", opens: "12:00 pm", closes: "11:00 pm"},
  };

  // Short sample menus. Every dish states serving size, energy, ingredients and
  // allergens, as provided by the restaurant.
  const dish = (o) => Object.assign({available: true, sample: true, preparationTime: 20}, o,
    {imageUrl: o.photo ? "/shop/img/" + o.photo + ".jpg" : ""});
  window.SCRAVEIT_SAMPLE_MENUS = {
    "highway-cross-hh1d": [
      dish({id: "chicken-dum-biryani", name: "Chicken Dum Biryani", category: "Biryani", price: 280, diet: "nonveg", recommended: true, photo: "chicken-dum-biryani",
        description: "Hyderabadi-style dum biryani with marinated chicken, served with raita and salan.",
        ingredients: "Basmati rice, chicken, onion, yoghurt, mint, whole spices, ghee, saffron.", allergens: "Contains milk.",
        calories: 780, servingSize: "Serves 1", preparationTime: 25}),
      dish({id: "chicken-65", name: "Chicken 65", category: "Starters", price: 260, diet: "nonveg", recommended: true, photo: "chicken-65",
        description: "Andhra-style spicy fried chicken tossed with curry leaves and green chilli.",
        ingredients: "Chicken, ginger-garlic paste, red chilli, curry leaves, yoghurt, cornflour, oil.", allergens: "Contains milk.",
        calories: 480, servingSize: "Serves 1 (250 g)"}),
      dish({id: "paneer-butter-masala", name: "Paneer Butter Masala", category: "Main course", price: 240, diet: "veg", recommended: true, photo: "paneer-butter-masala",
        description: "Soft paneer in a rich tomato, butter and cashew gravy.",
        ingredients: "Paneer, tomato, butter, cream, cashew, onion, spices.", allergens: "Contains milk and tree nuts (cashew).",
        calories: 520, servingSize: "Serves 1"}),
      dish({id: "butter-naan", name: "Butter Naan", category: "Main course", price: 50, diet: "veg", photo: "butter-naan",
        description: "Soft tandoor-baked naan brushed with butter.",
        ingredients: "Refined wheat flour, yoghurt, milk, butter, yeast, salt.", allergens: "Contains gluten (wheat) and milk.",
        calories: 260, servingSize: "1 piece", preparationTime: 10}),
      dish({id: "gulab-jamun", name: "Gulab Jamun", category: "Desserts", price: 80, diet: "veg", photo: "gulab-jamun",
        description: "Two warm gulab jamuns in cardamom sugar syrup.",
        ingredients: "Milk solids, refined wheat flour, sugar, ghee, cardamom.", allergens: "Contains milk and gluten (wheat).",
        calories: 300, servingSize: "Serves 1 (2 pieces)", preparationTime: 5}),
    ],
    "the-waffle-spot-naidupeta": [
      dish({id: "classic-butter-waffle", name: "Classic Butter Waffle", category: "Waffles", price: 149, diet: "veg", recommended: true, photo: "belgian-waffle",
        description: "Crisp eggless Belgian waffle with butter and honey.",
        ingredients: "Refined wheat flour, milk, butter, sugar, baking powder, honey.", allergens: "Contains gluten (wheat) and milk.",
        calories: 380, servingSize: "Serves 1"}),
      dish({id: "chocolate-waffle", name: "Chocolate Overload Waffle", category: "Waffles", price: 179, diet: "veg", recommended: true, photo: "chocolate-waffle",
        description: "Eggless waffle loaded with chocolate sauce.",
        ingredients: "Refined wheat flour, milk, butter, sugar, cocoa, chocolate sauce, baking powder.", allergens: "Contains gluten (wheat), milk and soy.",
        calories: 520, servingSize: "Serves 1"}),
      dish({id: "maple-pancakes", name: "Maple Pancakes", category: "Pancakes", price: 159, diet: "veg", photo: "pancakes",
        description: "Two fluffy eggless pancakes with maple-flavoured syrup and a scoop of ice cream.",
        ingredients: "Refined wheat flour, milk, butter, sugar, baking powder, maple-flavoured syrup, ice cream.", allergens: "Contains gluten (wheat) and milk.",
        calories: 450, servingSize: "Serves 1 (2 pieces)"}),
      dish({id: "bean-vanilla", name: "Bean Vanilla Ice Cream", category: "Ice creams", price: 77, diet: "veg", recommended: true, photo: "vanilla-ice-cream",
        description: "One scoop of classic vanilla bean ice cream.",
        ingredients: "Milk, cream, sugar, milk solids, vanilla, stabiliser (INS 412).", allergens: "Contains milk.",
        calories: 140, servingSize: "1 scoop (60 g)", preparationTime: 5}),
      dish({id: "brownie-ice-cream", name: "Brownie with Ice Cream", category: "Ice creams", price: 149, diet: "veg", photo: "brownie-ice-cream",
        description: "Warm eggless chocolate brownie with a scoop of vanilla ice cream.",
        ingredients: "Refined wheat flour, dark chocolate, butter, sugar, cocoa, milk, vanilla ice cream.", allergens: "Contains gluten (wheat), milk and soy.",
        calories: 430, servingSize: "Serves 1", preparationTime: 10}),
    ],
  };
})();
