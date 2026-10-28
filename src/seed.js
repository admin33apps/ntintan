'use strict';
/**
 * Reference data supplied by Ntintan (categories, local units, master
 * product list, farmer directory, market prices, price history).
 * Prices are stored in pesewas. Rule: 100 OGY = 1 GHS → OGY value = pesewas.
 */
const { tx } = require('./db');

const GHS = (n) => Math.round(n * 100);

const categories = [
  [1, 'Roots, Tubers & Plantains', 'roots-tubers', 'Staples — yam, cassava, plantain, cocoyam'],
  [2, 'Fresh Vegetables & Leafy Greens', 'vegetables', 'Tomatoes, onions, peppers, garden eggs, okra, kontomire'],
  [3, 'Grains, Cereals & Legumes', 'grains-legumes', 'Maize, rice, beans, groundnuts'],
  [4, 'Fish, Meat & Proteins', 'proteins', 'Smoked/dried fish, meats, eggs'],
  [5, 'Oils, Spices & Processed Goods', 'oils-spices', 'Gari, palm oil, ginger, dawadawa, shito'],
  [6, 'Cash Crops & Industrial', 'cash-crops', 'Cocoa, rubber, cotton, oil palm'],
  [7, 'Fruits', 'fruits', 'Avocado, mango, pineapple, banana, citrus, watermelon'],
  [8, 'Livestock & Poultry', 'livestock', 'Beef, goat, sheep, poultry, pork, dairy, camel'],
  [9, 'Dry Grains & Powders (bulk)', 'dry-bulk', 'Rice, gari, beans, maize, millet, tiger nuts']
];

const units = [
  [1, 'Olonka / Amerika Tin', 'Olonka', '~2.5 kg', 'Rice, Gari, Beans, Dried Maize, Millet, Tiger Nuts'],
  [2, 'Margarine Tin', null, '~0.5–0.6 kg (1/4–1/5 Olonka)', 'Small portions of Beans, Gari, Groundnuts'],
  [3, 'Mini Olonka', null, '~1.2 kg', 'Same dry goods'],
  [4, 'Bag / Sack', 'Kotokuo', '50 kg or 100 kg', 'Wholesale Rice, Maize, Beans, Gari'],
  [5, 'Pyramid / Stack', 'Ololo', '4–5 pieces', 'Tomatoes, Onions, Shallots, Garden Eggs, Oranges, Limes'],
  [6, 'Paint Bucket', null, '4.5 L', 'Onions, Tomatoes, Hot Peppers'],
  [7, 'Wooden Crate', 'Chena', 'Wholesale volume', 'Tomatoes'],
  [8, 'Sack / Net Bag', null, 'Bulk', 'Onions, Cabbage, Garden Eggs'],
  [9, 'Bunch', 'Suro', '1 bunch', 'Plantains, Bananas'],
  [10, 'Heap', null, '3, 5 or 10 tubers', 'Yams, Cassava, Cocoyam'],
  [11, 'Beer / Spirit Bottle', null, '~0.5–1 L', 'Palm Oil, Coconut Oil, Groundnut Oil, Honey'],
  [12, 'Gallon / Jerrycan', 'Kufuor Gallon', '5 L or 25 L', 'Vegetable & Palm Oils (bulk)'],
  [13, 'Finger / Knob', null, 'Handful', 'Ginger, Garlic'],
  [14, 'Patty / Ball', null, 'Individual', 'Dawadawa, Groundnut paste'],
  [15, 'Egg Crate', null, '30 eggs', 'Eggs'],
  [16, 'Single / Pile', null, '1 or 3–5 pieces', 'Smoked Fish, Koobi'],
  [17, 'Metric Tonne', null, '1,000 kg', 'Wholesale grain pricing']
];

// [id, name, local_name, category_id, default_unit_id, notes, emoji]
const products = [
  [1, 'Yam', 'Bayere', 1, 10, 'Heaps; boil, fry or pound into fufu', '🍠'],
  [2, 'Cassava', 'Duade', 1, 10, 'Banku & fufu dough', '🥔'],
  [3, 'Plantain', 'Borɔdeɛ', 1, 9, 'Green (boil/fufu) to ripe (kelewele/red-red)', '🍌'],
  [4, 'Cocoyam', 'Mankani', 1, 10, 'Smooth fufu texture', '🥔'],
  [5, 'Tomatoes', null, 2, 6, 'Backbone of Ghanaian cooking', '🍅'],
  [6, 'Onions & Shallots', null, 2, 6, 'Red, white and brown varieties', '🧅'],
  [7, 'Hot Peppers (Scotch Bonnet)', 'Atarodo', 2, 6, 'Fiery pepper sauce base', '🌶️'],
  [8, 'Green Kpakpo Shito', 'Kpakpo Shito', 2, 6, 'Essential local pepper sauce', '🫑'],
  [9, 'Garden Eggs', 'Nyaadewa', 2, 5, 'White/yellow African eggplant', '🍆'],
  [10, 'Okra', 'Nkruma', 2, 6, 'Okro stew and soup', '🫛'],
  [11, 'Kontomire (Cocoyam leaves)', 'Kontomire', 2, 5, 'Palava sauce', '🥬'],
  [12, 'Maize / Corn (white)', 'Aburoo', 3, 4, 'Banku and kenkey dough', '🌽'],
  [13, 'Maize / Corn (yellow)', 'Aburoo', 3, 4, '', '🌽'],
  [14, 'Rice (local & imported)', null, 3, 1, 'Sold by Olonka or branded bags', '🍚'],
  [15, 'Black-eyed Peas / Beans', null, 3, 1, 'Gobɛ (red-red), waakye', '🫘'],
  [16, 'Groundnuts', 'Nkateɛ', 3, 1, 'Raw, boiled or roasted', '🥜'],
  [17, 'Smoked & Dried Fish', 'Amane (herring)', 4, 16, 'Herring, salmon, mackerel, river fish', '🐟'],
  [18, 'Koobi & Momoni', 'Koobi / Momoni', 4, 16, 'Salted sun-dried tilapia — flavouring', '🐠'],
  [19, 'Assorted Meats', 'Mogyanam', 4, null, 'Beef, goat, pork, tripe (wele)', '🥩'],
  [20, 'Eggs', 'Nkosua', 4, 15, '30-egg crate', '🥚'],
  [21, 'Gari', 'Gari', 5, 1, 'Roasted cassava flakes', '🥣'],
  [22, 'Palm Oil (unrefined)', null, 5, 12, 'Orange-red, for stews', '🫗'],
  [23, 'Vegetable Oil', null, 5, 12, 'Clear cooking oil', '🫙'],
  [24, 'Local Ginger & Garlic', null, 5, 13, 'Marinade flavour base', '🧄'],
  [25, 'Dawadawa', 'Dawadawa', 5, 14, 'Fermented locust bean cakes', '🟤'],
  [26, 'Shito', 'Shito', 5, null, 'Spicy pepper sauce (jars)', '🫙'],
  [27, 'Amaranth', null, 7, null, 'Leafy green and grain', '🌿'],
  [28, 'Avocados', null, 7, null, 'Kenya and South Africa leading producers', '🥑'],
  [29, 'Bambara Groundnut', null, 3, null, 'Drought-resistant legume', '🥜'],
  [30, 'Bananas & Matooke', null, 7, 9, 'Uganda staple', '🍌'],
  [31, 'Barley', null, 3, null, 'North/East Africa highlands', '🌾'],
  [32, 'Cashew Nuts', null, 6, null, "Côte d'Ivoire, Tanzania, Guinea-Bissau", '🥜'],
  [33, 'Citrus Fruits', null, 7, 5, 'Oranges, lemons, grapefruits', '🍊'],
  [34, 'Cocoa Beans', null, 6, 4, "Côte d'Ivoire & Ghana", '🫘'],
  [35, 'Coconuts', null, 7, null, 'Coastal', '🥥'],
  [36, 'Coffee', null, 6, null, 'Ethiopia origin', '☕'],
  [37, 'Cotton', null, 6, null, 'Benin, Burkina Faso, Mali, Egypt', '☁️'],
  [38, 'Cowpeas', null, 3, null, 'Indigenous legume', '🫘'],
  [39, 'Dates', null, 7, null, 'Egypt, Algeria, Tunisia', '🌴'],
  [40, 'Fonio', null, 3, null, 'Ancient Sahel grain', '🌾'],
  [41, 'Grapes', null, 7, null, 'South Africa, North Africa', '🍇'],
  [42, 'Kola Nuts', null, 6, null, 'West African rainforest', '🌰'],
  [43, 'Livestock (Beef, Goats, Sheep)', null, 8, null, 'Pastoral zones', '🐐'],
  [44, 'Mangoes', null, 7, null, 'Seasonal tropical fruit', '🥭'],
  [45, 'Millet (Pearl & Finger)', null, 3, 1, 'Sahel & Horn', '🌾'],
  [46, 'Oil Palm', null, 6, null, 'Nigeria, Central Africa', '🌴'],
  [47, 'Pineapples', null, 7, null, 'Ghana, Kenya, Guinea', '🍍'],
  [48, 'Potatoes (Irish & Sweet)', null, 1, null, 'Egypt/South Africa; OFSP East Africa', '🥔'],
  [49, 'Poultry', null, 8, null, 'South Africa, Nigeria, Ghana', '🐔'],
  [50, 'Rubber', null, 6, null, "Liberia, Côte d'Ivoire", '🌳'],
  [51, 'Sesame Seeds', null, 6, null, 'Sudan, Ethiopia, Nigeria', '🌱'],
  [52, 'Shea Nuts', null, 6, null, 'West African savanna', '🌰'],
  [53, 'Sisal', null, 6, null, 'Tanzania, Kenya', '🌵'],
  [54, 'Snails', null, 8, null, 'West African humid forest', '🐌'],
  [55, 'Sorghum', null, 3, null, 'Drought-resilient grain', '🌾'],
  [56, 'Soybeans', null, 3, 4, 'Feed & oil', '🫘'],
  [57, 'Sugarcane', null, 6, null, 'South Africa, Egypt, Sudan', '🎋'],
  [58, 'Tea', null, 6, null, 'Kenya black tea', '🍵'],
  [59, 'Teff', null, 3, null, 'Ethiopia/Eritrea', '🌾'],
  [60, 'Tobacco', null, 6, null, 'Zimbabwe, Malawi, Tanzania', '🍂'],
  [61, 'Vanilla Beans', null, 6, null, 'Madagascar', '🌸'],
  [62, 'Watermelons', null, 7, null, 'Indigenous', '🍉'],
  [63, 'Wheat', null, 3, null, 'North Africa, Ethiopia', '🌾'],
  [64, 'Camel Meat & Milk', null, 8, null, 'Horn of Africa, Sahara', '🐪'],
  [65, 'Chickpeas', null, 3, null, 'Ethiopia highlands', '🫘'],
  [66, 'Dairy (Milk)', null, 8, null, 'Kenya, South Africa', '🥛'],
  [67, 'Farmed Fish (Tilapia, Catfish)', null, 4, null, 'Aquaculture', '🐟'],
  [68, 'Goat Meat & Milk', null, 8, null, 'Smallholder farms', '🐐'],
  [69, 'Lentils', null, 3, null, 'North/East Africa winter', '🫘'],
  [70, 'Pigeon Peas', null, 3, null, 'East Africa', '🫛'],
  [71, 'Pork', null, 8, null, 'South Africa, Nigeria', '🐖'],
  [72, 'Tiger Nuts', null, 9, 1, 'Measured by Olonka', '🌰']
];

// Retail prices from the market_prices table → become shop prices.
// [product_id, price_ghs, price_unit_id, unit_label]
const shopPrices = [
  [2, 340, 4, 'Sack'],
  [5, 69, 6, '4.5 L paint bucket'],
  [3, 44, 9, 'Average bunch'],
  [6, 95, 6, '4.5 L paint bucket']
];

// [id, product_id, type, unit_label, min_ghs, max_ghs, approximate, market, notes]
const marketPrices = [
  [1, 12, 'wholesale', 'Metric tonne', 1100, 4645, 0, 'National', ''],
  [2, 12, 'spot', '50 kg bag', 135, 190, 0, 'Tamale vs. southern hubs', ''],
  [3, 13, 'wholesale', 'Metric tonne', 1000, 3795, 0, 'National warehouses', ''],
  [4, 56, 'wholesale', 'Metric tonne', 2800, 7418, 0, 'Kumasi, Tamale, Wa', 'Actively traded'],
  [5, 14, 'wholesale', 'Metric tonne (Local Rice, Grade 2)', 11110, 11110, 1, 'Bolgatanga hub', ''],
  [6, 51, 'wholesale', 'Metric tonne (Grade 4)', 3200, 3200, 1, 'Sandema delivery', ''],
  [7, 2, 'retail', 'Sack', 340, 340, 0, '', '▼25% from peak GH₵454'],
  [8, 5, 'retail', '4.5 L bucket', 69, 69, 0, 'Rural Accra / Adoga belts', '▼>50% from peak GH₵149'],
  [9, 3, 'retail', 'Average bunch', 44, 44, 0, '', '▲10% (transport costs)'],
  [10, 6, 'retail', '4.5 L bucket', 95, 95, 0, '', '']
];

// [id, product_id, unit_label, previous_peak_ghs, current_ghs, change_bps, reason, implied]
const priceHistory = [
  [1, 2, 'per sack', 454, 340, -2510, 'Increased root harvest volumes', 0],
  [2, 5, 'per bucket', 149, 69, -5369, 'Seasonal supply influx (rural Accra/Adoga)', 0],
  [3, 3, 'per bunch', 40, 44, 1000, 'Distribution & transport cost adjustments', 1]
];

// [id, name, enterprise, location, region, focus_category_ids, notes, verified]
const farmers = [
  [1, 'Joseph Kusi', 'Unique Time Tells Enterprise', 'Nipa Nyiaye, near Adiembra, Atwima Mponua District', 'Ashanti', '6,1', 'Cocoa beans + plantain & cassava', 1],
  [2, 'Tay Lemawu', 'Ghana Rubber Estates', null, null, '6', 'Natural rubber latex (industrial/export)', 1],
  [3, 'Christian Gbeti', 'Chrisgeecoltd', null, null, '2,8', 'Organic vegetables (cucumber, green pepper, carrot, cabbage) + livestock', 1],
  [4, 'Eric Anane', 'Erico Farms', 'Greater Accra supply', 'Greater Accra', '2', 'Tomatoes, peppers, onions (open-field/greenhouse)', 1],
  [5, 'Joel Botwe', 'Green Lands', 'Greater Accra supply', 'Greater Accra', '2', 'Tomatoes, peppers, onions', 1],
  [6, 'Franklin Mensah', 'Bejack Farms', null, null, '8', 'Poultry (broilers & layer eggs) + livestock', 1],
  [7, 'Thomas Evans', 'Paco Farm', null, null, '8', 'Poultry (broilers & layer eggs) + livestock', 1],
  [8, 'Kingprotocol1 Rahman', 'Protocol Farms', null, null, '8', 'Poultry, pork, feed production', 1],
  [9, 'Bright Agbonyitor', null, null, 'Volta', '1,3', 'Self-employed smallholder: cassava, yams; maize, millet, beans. Region/enterprise to be confirmed.', 0],
  [10, 'Kwame Opoku', null, null, null, '1,3', 'Self-employed smallholder: tubers/roots; cereals & legumes. Region/enterprise to be confirmed.', 0],
  [11, 'Lucas Abilla', null, null, null, '1,3', 'Self-employed smallholder: tubers/roots; cereals & legumes. Region/enterprise to be confirmed.', 0]
];

// ---------------------------------------------------------------- drinks (v3)
// Sub-categories: wine | alcoholic | non_alcoholic | water. Prices are set by admins (price on request until then).
const drinkUnits = [
  [18, 'Bottle (750 ml)', null, '750 ml', 'Wine, spirits, premium glass-bottled water'],
  [19, 'Case / Crate', null, '12 or 24 bottles', 'Beer, malt, water, soft drinks (wholesale)'],
  [20, 'Small bottle (330 ml)', null, '~330 ml', 'Beer, malt, juices, water']
];
// [id, name, local_name, subcategory, unit_id, notes, emoji, age_restricted]
const drinks = [
  [73, 'South African Red Wine', null, 'wine', 18, 'Dry red wine from the Western Cape. 750 ml glass bottle.', '🍷', 1],
  [74, 'South African White Wine', null, 'wine', 18, 'Crisp dry or semi-sweet white from the Western Cape. Serve chilled.', '🍷', 1],
  [75, 'South African Sweet Rosé', null, 'wine', 18, 'Light, sweet rosé. Serve chilled.', '🍷', 1],
  [76, 'Cape Sparkling Wine', null, 'wine', 18, 'Méthode cap classique or charmat sparkling wine from South Africa.', '🥂', 1],
  [77, 'Fresh Palm Wine', 'Nsafufuo', 'wine', 11, 'Freshly tapped oil-palm sap, naturally fermented. Perishable: kept chilled and best enjoyed on the day of delivery.', '🍶', 1],
  [78, 'Marula Cream Liqueur', null, 'wine', 18, 'Cream liqueur made with marula fruit, South Africa. Serve over ice.', '🥃', 1],
  [79, 'Ghanaian Lager Beer', null, 'alcoholic', 19, 'Lager brewed in Ghana. Sold by the crate of returnable glass bottles.', '🍺', 1],
  [80, 'Ghanaian Stout', null, 'alcoholic', 19, 'Dark stout brewed in Ghana. Sold by the crate.', '🍺', 1],
  [81, 'Ghanaian Herbal Bitters', null, 'alcoholic', 11, 'Spirit drink made with local botanicals. FDA-registered brands only.', '🥃', 1],
  [82, 'Akpeteshie', 'Akpeteshie', 'alcoholic', 11, 'Traditional Ghanaian spirit distilled from palm wine or sugarcane. We sell sealed, FDA-registered bottles only.', '🥃', 1],
  [83, 'Pito', 'Pito', 'alcoholic', 11, 'Traditional fermented millet or sorghum drink from Northern Ghana. Perishable: kept chilled.', '🍶', 1],
  [84, 'Ghanaian Dry Gin', null, 'alcoholic', 18, 'Dry gin distilled in Ghana.', '🍸', 1],
  [85, 'Sobolo', 'Sobolo', 'non_alcoholic', 20, 'Chilled hibiscus drink with ginger, cloves and pineapple. Made fresh, no alcohol.', '🧃', 0],
  [86, 'Asaana', 'Asaana', 'non_alcoholic', 20, 'Caramelised fermented-corn drink, served chilled. No alcohol.', '🧋', 0],
  [87, 'Brukina', 'Burkina', 'non_alcoholic', 20, 'Millet and fresh milk drink. Keep refrigerated.', '🥛', 0],
  [88, 'Lamugin', 'Lamugin', 'non_alcoholic', 20, 'Spicy ginger and pineapple drink from Northern Ghana.', '🫚', 0],
  [89, 'Ghanaian Malt Drink', null, 'non_alcoholic', 19, 'Non-alcoholic malt beverage brewed in Ghana. Sold by the crate.', '🧃', 0],
  [90, 'Tiger Nut Milk', 'Atadwe milkye', 'non_alcoholic', 20, 'Creamy drink pressed from tiger nuts. Dairy-free. Keep refrigerated.', '🥛', 0],
  [91, 'Fresh Coconut Water', null, 'non_alcoholic', 20, 'Pure coconut water from coastal farms, bottled fresh.', '🥥', 0],
  [92, 'Sugarloaf Pineapple Juice', null, 'non_alcoholic', 20, 'Cold-pressed from Ghanaian sugarloaf pineapples. No added sugar.', '🍍', 0],
  [93, 'Fresh Orange Juice', null, 'non_alcoholic', 20, 'Freshly squeezed Ghanaian oranges.', '🍊', 0],
  [94, 'Ghanaian Cocoa Drink', null, 'non_alcoholic', null, 'Drinking-chocolate powder made from Ghanaian cocoa.', '☕', 0],
  [95, 'Premium Still Spring Water (750 ml glass)', null, 'water', 18, 'Still natural water in a 750 ml glass bottle. For tables, hotels and events.', '💧', 0],
  [96, 'Premium Sparkling Mineral Water (750 ml glass)', null, 'water', 18, 'Naturally carbonated mineral water in a 750 ml glass bottle.', '🫧', 0],
  [97, 'Premium Still Water (330 ml glass, case of 24)', null, 'water', 19, 'Single-serve 330 ml glass bottles, case of 24.', '💧', 0],
  [98, 'Premium Sparkling Water (330 ml glass, case of 24)', null, 'water', 19, 'Single-serve sparkling 330 ml glass bottles, case of 24.', '🫧', 0]
];

/** Idempotent: adds the drinks category, measures and products to new and existing databases. */
function seedDrinks(db) {
  tx(db, () => {
    db.prepare("INSERT OR IGNORE INTO categories (id, name, slug, description) VALUES (10, 'Wine & African Drinks', 'drinks', 'Wine, African-made beers and spirits, local soft drinks and premium glass-bottled water')").run();
    const u = db.prepare('INSERT OR IGNORE INTO units (id, name, local_name, approx_weight, used_for) VALUES (?, ?, ?, ?, ?)');
    drinkUnits.forEach((r) => u.run(...r));
    const p = db.prepare('INSERT OR IGNORE INTO products (id, name, local_name, category_id, subcategory, default_unit_id, notes, emoji, age_restricted) VALUES (?, ?, ?, 10, ?, ?, ?, ?, ?)');
    drinks.forEach((r) => p.run(...r));
  });
}

// ---------------------------------------------------------------- halal (v5)
// Sourced to order from halal-certified abattoirs and suppliers (price on request until an admin sets one).
// [id, name, local_name, category_id, notes, emoji]
const halalProducts = [
  [301, 'Halal Beef', 'Nantwi nam', 4, 'Fresh beef from halal-certified abattoirs. Ask for the certificate with your order.', '🥩'],
  [302, 'Halal Goat Meat', 'Aponkye nam', 4, 'Fresh goat meat, slaughtered the halal way by a certified butcher.', '🐐'],
  [303, 'Halal Mutton (Sheep)', 'Odwan nam', 4, 'Fresh mutton from halal-certified abattoirs.', '🐑'],
  [304, 'Halal Whole Chicken', 'Akokɔ', 4, 'Dressed whole chicken from a halal-certified processor. Chilled or frozen.', '🍗'],
  [305, 'Halal Guinea Fowl', 'Akɔmfem', 4, 'Dressed guinea fowl from Northern Ghana, halal slaughtered.', '🐓'],
  [306, 'Live Ram for Eid & Naming Ceremonies', 'Odwennini', 8, 'Healthy live rams for Eid al-Adha, naming ceremonies and celebrations. Halal slaughter and dressing can be arranged.', '🐏']
];

/** Idempotent: adds the halal products to new and existing databases (admins can untick them later). */
function seedHalal(db) {
  tx(db, () => {
    const p = db.prepare('INSERT OR IGNORE INTO products (id, name, local_name, category_id, notes, emoji, halal) VALUES (?, ?, ?, ?, ?, ?, 1)');
    halalProducts.forEach((r) => p.run(...r));
  });
}

function seed(db) {
  const has = db.prepare('SELECT COUNT(*) AS n FROM categories WHERE id = 1').get().n;
  if (has > 0) return false;
  tx(db, () => {
    const c = db.prepare('INSERT INTO categories (id, name, slug, description) VALUES (?, ?, ?, ?)');
    categories.forEach((r) => c.run(...r));
    const u = db.prepare('INSERT INTO units (id, name, local_name, approx_weight, used_for) VALUES (?, ?, ?, ?, ?)');
    units.forEach((r) => u.run(...r));
    const p = db.prepare('INSERT INTO products (id, name, local_name, category_id, default_unit_id, notes, emoji) VALUES (?, ?, ?, ?, ?, ?, ?)');
    products.forEach((r) => p.run(...r));
    const sp = db.prepare('UPDATE products SET price_pesewas = ?, price_unit_id = ?, price_unit_label = ?, featured = 1 WHERE id = ?');
    shopPrices.forEach(([id, ghs, unitId, label]) => sp.run(GHS(ghs), unitId, label, id));
    const mp = db.prepare('INSERT INTO market_prices (id, product_id, price_type, unit_label, min_pesewas, max_pesewas, approximate, market, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    marketPrices.forEach(([id, pid, type, unit, min, max, approx, market, notes]) => mp.run(id, pid, type, unit, GHS(min), GHS(max), approx, market, notes));
    const ph = db.prepare('INSERT INTO price_history (id, product_id, unit_label, previous_peak_pesewas, current_pesewas, change_bps, reason, previous_is_implied) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    priceHistory.forEach(([id, pid, unit, prev, cur, bps, reason, implied]) => ph.run(id, pid, unit, GHS(prev), GHS(cur), bps, reason, implied));
    const f = db.prepare('INSERT INTO farmers (id, name, enterprise, location, region, focus_category_ids, notes, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    farmers.forEach((r) => f.run(...r));
  });
  return true;
}

module.exports = { seed, seedDrinks, seedHalal, REGIONS: ['Ahafo', 'Ashanti', 'Bono', 'Bono East', 'Central', 'Eastern', 'Greater Accra', 'North East', 'Northern', 'Oti', 'Savannah', 'Upper East', 'Upper West', 'Volta', 'Western', 'Western North'] };
