/*
 * Sample partner stores for the website before the FSSAI licence is issued.
 * Every product carries every field the FSSAI (Labelling and Display)
 * Regulations, 2020 require on an e-commerce product page. Values that only a
 * real seller or manufacturer can give are stated as placeholders and every
 * listing is marked as a sample, so nothing here claims to be a real product.
 * Real stores are added in the Admin app once they are onboarded.
 */
(function () {
  const PENDING_SELLER = "Shown here once this partner store is onboarded (seller's own FSSAI licence)";
  const PENDING_MFR = "Taken from the product label when a real product is listed";
  const PENDING_MFR_LIC = "Manufacturer's FSSAI licence number, taken from the product label";

  function item(o) {
    return Object.assign({diet: "veg", available: true}, o, {
      sample: true,
      compliance: Object.assign({
        brand: "Sample brand",
        countryOfOrigin: "India",
        manufacturer: PENDING_MFR,
        manufacturerFssai: PENDING_MFR_LIC,
        packer: PENDING_MFR,
        sellerFssai: PENDING_SELLER,
        bestBefore: "Printed on the pack. We deliver only with at least 30% of shelf life (or 45 days) remaining.",
        customerCare: "balaji@scraveit.in · Grievance officer details on the Grievance page",
      }, o.compliance || {}, {sampleValues: true}),
    });
  }

  const n = (energy, protein, carb, sugar, addedSugar, fat, satFat, transFat, sodium) =>
    ({per: "100 g", energyKcal: energy, proteinG: protein, carbohydrateG: carb, totalSugarsG: sugar,
      addedSugarsG: addedSugar, fatG: fat, saturatedFatG: satFat, transFatG: transFat, sodiumMg: sodium});

  const stores = [
    {
      id: "sample-grocery",
      storeType: "grocery",
      name: "Scraveit Grocery Partner",
      tagline: "Staples, pantry and snacks from a partner grocery store",
      city: "Nellore",
      etaMin: 25, etaMax: 40,
      sample: true,
      sellerFssai: PENDING_SELLER,
      items: [
        item({id: "atta-5kg", name: "Whole Wheat Atta", category: "Atta, rice & dal", price: 285,
          description: "Stone-ground whole wheat flour for rotis and parathas.",
          compliance: {netQuantity: "5 kg", mrp: 299, ingredients: "Whole wheat (100%).",
            allergens: "Contains gluten (wheat).", storage: "Store in a cool, dry place in an airtight container.",
            shelfLife: "4 months from packing", foodCategory: "06 - Cereals and cereal products",
            nutrition: n(341, 12.1, 69.4, 1.2, 0, 1.7, 0.3, 0, 2)}}),
        item({id: "basmati-1kg", name: "Basmati Rice", category: "Atta, rice & dal", price: 145,
          description: "Long-grain aged basmati rice.",
          compliance: {netQuantity: "1 kg", mrp: 160, ingredients: "Basmati rice (100%).", allergens: "None declared.",
            storage: "Store in a cool, dry place.", shelfLife: "12 months from packing",
            foodCategory: "06 - Cereals and cereal products", nutrition: n(349, 8.1, 77.2, 0.2, 0, 0.6, 0.2, 0, 5)}}),
        item({id: "toor-dal-1kg", name: "Toor Dal", category: "Atta, rice & dal", price: 168,
          description: "Unpolished split pigeon peas.",
          compliance: {netQuantity: "1 kg", mrp: 180, ingredients: "Toor dal (pigeon pea) (100%).", allergens: "None declared.",
            storage: "Store in a cool, dry place.", shelfLife: "9 months from packing",
            foodCategory: "06 - Cereals and cereal products (pulses)", nutrition: n(335, 22.3, 57.6, 2.9, 0, 1.7, 0.4, 0, 17)}}),
        item({id: "sunflower-oil-1l", name: "Refined Sunflower Oil", category: "Oils & ghee", price: 155,
          description: "Light refined sunflower oil for everyday cooking.",
          compliance: {netQuantity: "1 L (910 g)", mrp: 170, ingredients: "Refined sunflower oil.", allergens: "None declared.",
            storage: "Store away from direct sunlight.", shelfLife: "9 months from packing",
            foodCategory: "02 - Fats and oils", nutrition: Object.assign(n(900, 0, 0, 0, 0, 100, 11, 0, 0), {per: "100 g"})}}),
        item({id: "salt-1kg", name: "Iodised Salt", category: "Salt, spices & masala", price: 28,
          description: "Free-flowing iodised salt.",
          compliance: {netQuantity: "1 kg", mrp: 30, ingredients: "Salt, potassium iodate, anticaking agent (INS 551).",
            allergens: "None declared.", storage: "Store in a dry place.", shelfLife: "24 months from packing",
            foodCategory: "12 - Salts, spices, soups, sauces", nutrition: n(0, 0, 0, 0, 0, 0, 0, 0, 38758)}}),
        item({id: "turmeric-100g", name: "Turmeric Powder", category: "Salt, spices & masala", price: 38,
          description: "Ground turmeric for daily cooking.",
          compliance: {netQuantity: "100 g", mrp: 42, ingredients: "Turmeric (100%).", allergens: "None declared.",
            storage: "Store in an airtight container away from moisture.", shelfLife: "12 months from packing",
            foodCategory: "12 - Salts, spices, soups, sauces", nutrition: n(312, 9.7, 67.1, 3.2, 0, 3.3, 1.8, 0, 27)}}),
        item({id: "sugar-1kg", name: "Sugar", category: "Sugar, honey & spreads", price: 48,
          description: "Crystal white sugar.",
          compliance: {netQuantity: "1 kg", mrp: 52, ingredients: "Sugar (100%).", allergens: "None declared.",
            storage: "Store in a dry place.", shelfLife: "24 months from packing",
            foodCategory: "11 - Sweeteners, including honey", nutrition: n(400, 0, 100, 100, 100, 0, 0, 0, 0)}}),
        item({id: "honey-250g", name: "Honey", category: "Sugar, honey & spreads", price: 125,
          description: "Multi-floral honey.",
          compliance: {netQuantity: "250 g", mrp: 135, ingredients: "Honey (100%).",
            allergens: "Not suitable for infants under 12 months.", storage: "Store at room temperature. Crystallisation is natural.",
            shelfLife: "24 months from packing", foodCategory: "11 - Sweeteners, including honey",
            nutrition: n(320, 0.3, 79.8, 79.8, 0, 0, 0, 0, 4)}}),
        item({id: "tea-250g", name: "Tea (CTC)", category: "Tea & beverages", price: 130,
          description: "Strong CTC tea leaves.",
          compliance: {netQuantity: "250 g", mrp: 140, ingredients: "Tea (100%).", allergens: "None declared.",
            storage: "Store in an airtight container.", shelfLife: "18 months from packing",
            foodCategory: "14 - Beverages, excluding dairy", nutrition: n(0, 0, 0, 0, 0, 0, 0, 0, 0)}}),
        item({id: "marie-biscuit-250g", name: "Marie Biscuits", category: "Biscuits & snacks", price: 36,
          description: "Light tea-time biscuits.",
          compliance: {netQuantity: "250 g", mrp: 40,
            ingredients: "Refined wheat flour (maida), sugar, edible vegetable oil (palm), invert syrup, milk solids, raising agents (INS 503(ii), INS 500(ii)), salt, emulsifier (INS 322).",
            allergens: "Contains gluten (wheat) and milk. May contain soy.", storage: "Store in a cool, dry place.",
            shelfLife: "9 months from packing", foodCategory: "07 - Bakery products",
            nutrition: n(445, 7.8, 76.1, 22.5, 20.1, 12.3, 6.1, 0.1, 380)}}),
        item({id: "mixture-200g", name: "Spicy Mixture Namkeen", category: "Biscuits & snacks", price: 52,
          description: "Crunchy savoury mixture.",
          compliance: {netQuantity: "200 g", mrp: 55,
            ingredients: "Bengal gram flour, edible vegetable oil (rice bran), peanuts, rice flakes, curry leaves, salt, chilli powder, turmeric, asafoetida.",
            allergens: "Contains peanuts. May contain other tree nuts.", storage: "Store in a cool, dry place. Consume soon after opening.",
            shelfLife: "4 months from packing", foodCategory: "15 - Ready-to-eat savouries",
            nutrition: n(560, 15.1, 44.2, 2.1, 0, 36.4, 8.2, 0.1, 720)}}),
        item({id: "laddu-250g", name: "Besan Laddu", category: "Sweets", price: 140,
          description: "Traditional gram flour laddu.",
          compliance: {netQuantity: "250 g", mrp: 150, ingredients: "Bengal gram flour, sugar, ghee, cardamom, cashew.",
            allergens: "Contains milk (ghee) and tree nuts (cashew).", storage: "Store in a cool, dry place.",
            shelfLife: "30 days from manufacture", foodCategory: "18 - Indian sweets and snacks",
            nutrition: n(505, 9.2, 58.4, 38.1, 36.0, 26.3, 13.8, 0.2, 45)}}),
      ],
    },
    {
      id: "sample-dairy",
      storeType: "dairy",
      name: "Scraveit Dairy Partner",
      tagline: "Milk, curd, paneer and ghee from a partner dairy",
      city: "Nellore",
      etaMin: 20, etaMax: 35,
      sample: true,
      sellerFssai: PENDING_SELLER,
      items: [
        item({id: "toned-milk-500ml", name: "Toned Milk", category: "Milk", price: 28,
          description: "Pasteurised toned milk.",
          compliance: {netQuantity: "500 ml", mrp: 29, ingredients: "Toned milk (3.0% fat, 8.5% SNF).", allergens: "Contains milk.",
            storage: "Keep refrigerated at or below 4 °C. Boil before use.", shelfLife: "2 days from packing (use by date on pack)",
            foodCategory: "01 - Dairy products", nutrition: Object.assign(n(58, 3.1, 4.7, 4.7, 0, 3.0, 1.9, 0.1, 44), {per: "100 ml"})}}),
        item({id: "curd-400g", name: "Fresh Curd", category: "Curd & buttermilk", price: 40,
          description: "Thick set curd.",
          compliance: {netQuantity: "400 g", mrp: 42, ingredients: "Pasteurised toned milk, active cultures.", allergens: "Contains milk.",
            storage: "Keep refrigerated at or below 4 °C.", shelfLife: "5 days from packing",
            foodCategory: "01 - Dairy products", nutrition: n(62, 3.2, 4.8, 4.8, 0, 3.2, 2.0, 0.1, 46)}}),
        item({id: "buttermilk-200ml", name: "Spiced Buttermilk", category: "Curd & buttermilk", price: 15,
          description: "Buttermilk with ginger, green chilli and curry leaves.",
          compliance: {netQuantity: "200 ml", mrp: 15, ingredients: "Curd, water, salt, ginger, green chilli, curry leaves, coriander.",
            allergens: "Contains milk.", storage: "Keep refrigerated at or below 4 °C.", shelfLife: "3 days from packing",
            foodCategory: "01 - Dairy products", nutrition: Object.assign(n(18, 1.0, 1.4, 1.4, 0, 0.9, 0.6, 0, 210), {per: "100 ml"})}}),
        item({id: "paneer-200g", name: "Malai Paneer", category: "Paneer & cheese", price: 95,
          description: "Soft fresh paneer.",
          compliance: {netQuantity: "200 g", mrp: 100, ingredients: "Milk solids, citric acid (INS 330).", allergens: "Contains milk.",
            storage: "Keep refrigerated at or below 4 °C.", shelfLife: "7 days from packing",
            foodCategory: "01 - Dairy products", nutrition: n(290, 18.1, 3.9, 3.0, 0, 22.5, 14.6, 0.5, 30)}}),
        item({id: "ghee-500ml", name: "Cow Ghee", category: "Ghee & butter", price: 355,
          description: "Granular cow ghee.",
          compliance: {netQuantity: "500 ml (455 g)", mrp: 375, ingredients: "Milk fat.", allergens: "Contains milk.",
            storage: "Store in a cool, dry place away from sunlight.", shelfLife: "9 months from packing",
            foodCategory: "01 - Dairy products (ghee)", nutrition: n(897, 0, 0, 0, 0, 99.7, 62.0, 2.5, 0)}}),
        item({id: "butter-100g", name: "Salted Table Butter", category: "Ghee & butter", price: 58,
          description: "Pasteurised salted butter.",
          compliance: {netQuantity: "100 g", mrp: 60, ingredients: "Milk fat, common salt.", allergens: "Contains milk.",
            storage: "Keep refrigerated at or below 4 °C.", shelfLife: "6 months from packing",
            foodCategory: "01 - Dairy products", nutrition: n(722, 0.6, 0, 0, 0, 80.0, 50.3, 2.9, 590)}}),
        item({id: "rose-milk-200ml", name: "Rose Flavoured Milk", category: "Flavoured milk", price: 30,
          description: "Chilled rose flavoured milk.",
          compliance: {netQuantity: "200 ml", mrp: 30,
            ingredients: "Toned milk, sugar, rose flavour (nature identical), permitted synthetic food colour (INS 122), stabiliser (INS 407).",
            allergens: "Contains milk.", storage: "Keep refrigerated at or below 4 °C.", shelfLife: "5 days from packing",
            foodCategory: "01 - Dairy products (flavoured milk)", nutrition: Object.assign(n(92, 3.0, 13.5, 13.5, 8.8, 2.9, 1.8, 0.1, 42), {per: "100 ml"})}}),
      ],
    },
  ];

  window.SCRAVEIT_SAMPLE_STORES = stores;
})();

/*
 * Sample menus for partner restaurants whose own menu is not in the catalogue
 * yet. Dishes and details are examples for the pre-licence website.
 */
(function () {
  const dish = (id, name, category, price, diet, description, ingredients, allergens, calories, servingSize) =>
    ({id, name, category, price, diet, description, ingredients, allergens, calories, servingSize, available: true, sample: true, preparationTime: 20});
  window.SCRAVEIT_SAMPLE_MENUS = {
    "highway-cross-hh1d": [
      dish("veg-manchow-soup", "Veg Manchow Soup", "Soups & starters", 110, "veg", "Spicy Indo-Chinese soup with crispy noodles.",
        "Cabbage, carrot, beans, capsicum, garlic, ginger, soy sauce, cornflour, fried noodles.", "Contains gluten (wheat) and soy.", 140, "1 bowl (300 ml)"),
      dish("paneer-65", "Paneer 65", "Soups & starters", 220, "veg", "Crisp fried paneer tossed with curry leaves and chilli.",
        "Paneer, rice flour, cornflour, ginger-garlic paste, chilli, curry leaves, yoghurt, oil.", "Contains milk.", 420, "8 pieces"),
      dish("chicken-65", "Chicken 65", "Soups & starters", 260, "nonveg", "Andhra-style spicy fried chicken.",
        "Chicken, ginger-garlic paste, chilli, curry leaves, yoghurt, cornflour, oil.", "Contains milk.", 480, "250 g"),
      dish("apollo-fish", "Apollo Fish", "Soups & starters", 290, "nonveg", "Boneless fish tossed in a tangy chilli sauce.",
        "Fish, egg, cornflour, green chilli, garlic, yoghurt, curry leaves, oil.", "Contains fish, egg and milk.", 450, "250 g"),
      dish("veg-biryani", "Veg Dum Biryani", "Biryani", 220, "veg", "Basmati rice and vegetables cooked on dum with whole spices.",
        "Basmati rice, mixed vegetables, onion, yoghurt, mint, whole spices, ghee.", "Contains milk.", 610, "1 plate"),
      dish("chicken-dum-biryani", "Chicken Dum Biryani", "Biryani", 280, "nonveg", "Hyderabadi-style biryani with marinated chicken.",
        "Basmati rice, chicken, onion, yoghurt, mint, whole spices, ghee, saffron.", "Contains milk.", 780, "1 plate"),
      dish("mutton-biryani", "Mutton Biryani", "Biryani", 360, "nonveg", "Slow-cooked mutton biryani.",
        "Basmati rice, mutton, onion, yoghurt, mint, whole spices, ghee.", "Contains milk.", 850, "1 plate"),
      dish("paneer-butter-masala", "Paneer Butter Masala", "Curries", 240, "veg", "Paneer in a rich tomato and butter gravy.",
        "Paneer, tomato, butter, cream, cashew, onion, spices.", "Contains milk and tree nuts (cashew).", 520, "1 bowl"),
      dish("dal-tadka", "Dal Tadka", "Curries", 170, "veg", "Yellow lentils tempered with cumin and garlic.",
        "Toor dal, onion, tomato, garlic, cumin, ghee, spices.", "Contains milk (ghee).", 280, "1 bowl"),
      dish("andhra-chicken-curry", "Andhra Chicken Curry", "Curries", 270, "nonveg", "Spicy home-style chicken curry.",
        "Chicken, onion, tomato, chilli, coriander, poppy seeds, spices, oil.", "None declared.", 460, "1 bowl"),
      dish("butter-naan", "Butter Naan", "Breads", 50, "veg", "Soft tandoor-baked naan brushed with butter.",
        "Refined wheat flour, yoghurt, milk, butter, yeast, salt.", "Contains gluten (wheat) and milk.", 260, "1 piece"),
      dish("tandoori-roti", "Tandoori Roti", "Breads", 30, "veg", "Whole wheat roti from the tandoor.",
        "Whole wheat flour, water, salt.", "Contains gluten (wheat).", 120, "1 piece"),
      dish("veg-fried-rice", "Veg Fried Rice", "Rice & noodles", 180, "veg", "Wok-tossed rice with vegetables.",
        "Rice, cabbage, carrot, beans, spring onion, soy sauce, oil.", "Contains soy.", 520, "1 plate"),
      dish("egg-noodles", "Egg Hakka Noodles", "Rice & noodles", 190, "nonveg", "Hakka noodles tossed with egg and vegetables.",
        "Noodles (wheat), egg, cabbage, carrot, spring onion, soy sauce, oil.", "Contains gluten (wheat), egg and soy.", 560, "1 plate"),
      dish("gulab-jamun", "Gulab Jamun", "Desserts", 80, "veg", "Two warm gulab jamuns in cardamom syrup.",
        "Milk solids, refined wheat flour, sugar, ghee, cardamom.", "Contains milk and gluten (wheat).", 300, "2 pieces"),
      dish("fresh-lime-soda", "Fresh Lime Soda", "Beverages", 70, "veg", "Sweet or salted, freshly made.",
        "Lime, soda water, sugar or salt.", "None declared.", 90, "300 ml"),
    ],
  };
})();
