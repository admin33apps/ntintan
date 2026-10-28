'use strict';
/**
 * African beverage makers and their key products (data supplied by Ntintan, Oct 2026).
 * Every product starts as "price on request" — admins set prices once stock is sourced
 * from an authorised distributor and the product is registered with FDA Ghana.
 *
 * Alcohol flag (A = 18+, N = no alcohol, W = water). Where the alcohol content of a
 * product was not certain, it is treated as 18+ (safer) and marked `verifyAbv` so an
 * admin can confirm the label and untick 18+ if it is alcohol-free.
 */
const { tx } = require('./db');

// [id, maker name, country label, ISO codes, notes]
const makers = [
  [1, 'Accra Brewery Limited (ABL)', 'Ghana', 'GH', ''],
  [2, 'Adonko Bitters Limited', 'Ghana', 'GH', ''],
  [3, 'Almarai (Western Bakeries / International Refreshments)', 'Egypt / North Africa Regional', 'EG', 'Country as supplied; please verify (Almarai is headquartered in Saudi Arabia).'],
  [4, 'Bayab Spirits', 'South Africa', 'ZA', ''],
  [5, 'Boissons du Cameroun (SABC Group)', 'Cameroon', 'CM', ''],
  [6, 'Bralirwa PLC', 'Rwanda', 'RW', ''],
  [7, 'Distell Group Limited (Heineken Beverages SA)', 'South Africa (Distributed Continent-Wide)', 'ZA', ''],
  [8, 'East African Breweries PLC (EABL)', 'Kenya / East Africa Regional', 'KE', ''],
  [9, 'Edward Snell & Co.', 'South Africa', 'ZA', '“Glenryck” was listed as a key product but is not a beverage, so it is not in the drinks catalogue.'],
  [10, 'Egyptian International Beverage Company (EIBCO)', 'Egypt', 'EG', ''],
  [11, 'GIHOC Distilleries Company Limited', 'Ghana', 'GH', ''],
  [12, 'Guinness Nigeria PLC', 'Nigeria', 'NG', ''],
  [13, 'Joy Industries Limited', 'Ghana', 'GH', ''],
  [14, 'Kakira Distillery', 'Uganda', 'UG', ''],
  [15, 'Kasapreko Company PLC', 'Ghana (Exported Continent-Wide)', 'GH', ''],
  [16, 'Kenya Breweries Limited (KBL)', 'Kenya', 'KE', ''],
  [17, 'Keroche Industries', 'Kenya', 'KE', ''],
  [18, 'KWV South Africa', 'South Africa', 'ZA', ''],
  [19, "Les Eaux Minérales d'Oulmès", 'Morocco', 'MA', ''],
  [20, 'Namibia Breweries Limited (NBL)', 'Namibia', 'NA', ''],
  [21, 'Nairobi Distillers', 'Kenya', 'KE', ''],
  [22, 'Nigerian Breweries PLC', 'Nigeria', 'NG', ''],
  [23, 'Phoenix Beverages', 'Mauritius', 'MU', ''],
  [24, 'Seven-Up Bottling Company (SBC Nigeria)', 'Nigeria', 'NG', 'Bottles international brands (7Up, Pepsi, Mirinda, Aquafina) under licence in Nigeria.'],
  [25, 'Société de Fabrication des Boissons de Tunisie (SFBT)', 'Tunisia', 'TN', ''],
  [26, 'South African Breweries (SAB)', 'South Africa', 'ZA', ''],
  [27, 'Takamaka (Trois Frères Distillery)', 'Seychelles', 'SC', ''],
  [28, 'Tanzania Breweries Limited (TBL)', 'Tanzania', 'TZ', ''],
  [29, 'The Beverage Company (BevCo)', 'South Africa', 'ZA', ''],
  [30, 'Twellium Industrial Company', "Ghana / Côte d'Ivoire", 'GH,CI', '']
];

// [maker id, product name, type, kind-hint, verifyAbv?]
// type: A = alcoholic (18+), N = non-alcoholic, W = water, WINE = wine (18+)
// kind: beer | stout | cider | spirit | gin | rum | whisky | brandy | bitters | liqueur | rtd | malt | soda | energy | juice | dairy | mixer | water | sparkling
const items = [
  [1, 'Club Premium Lager', 'A', 'beer'], [1, 'Eagle Lager', 'A', 'beer'], [1, 'Beta Malt', 'N', 'malt'], [1, 'Club Shandy', 'A', 'rtd', true],
  [2, 'Adonko Herbal Bitters', 'A', 'bitters'], [2, 'Adonko 123', 'A', 'bitters'], [2, 'Adonko Next Level Energy Drink', 'N', 'energy'],
  [3, 'Almarai Juices', 'N', 'juice'], [3, 'Teaba Juices', 'N', 'juice'], [3, 'Joho Dairy Beverages', 'N', 'dairy'],
  [4, 'Bayab Classic Dry Gin', 'A', 'gin'], [4, 'Bayab Burnt Orange & Marula Gin', 'A', 'gin'],
  [5, 'Castel Beer', 'A', 'beer'], [5, '"33" Export', 'A', 'beer'], [5, 'Beaufort Light', 'A', 'beer'], [5, 'Top Soft Drinks', 'N', 'soda'], [5, 'Source Tangui Mineral Water', 'W', 'water'],
  [6, 'Primus', 'A', 'beer'], [6, 'Mützig', 'A', 'beer'], [6, 'Amstel', 'A', 'beer'], [6, 'Turbo King', 'A', 'stout'], [6, 'Vitalo Soda', 'N', 'soda'],
  [7, 'Amarula Cream Liqueur', 'A', 'liqueur'], [7, 'Klipdrift Brandy', 'A', 'brandy'], [7, 'Savanna Dry Cider', 'A', 'cider'], [7, 'Hunters Gold Cider', 'A', 'cider'], [7, 'Viceroy Brandy', 'A', 'brandy'],
  [8, 'Tusker Lager', 'A', 'beer'], [8, 'White Cap', 'A', 'beer'], [8, 'Serengeti Lager', 'A', 'beer'], [8, 'Uganda Waragi', 'A', 'gin'], [8, 'Alvaro (Non-Alcoholic)', 'N', 'malt'],
  [9, 'Stretton’s Gin', 'A', 'gin'], [9, 'First Watch Whisky', 'A', 'whisky'],
  [10, 'Shahrazad Wines', 'WINE', 'wine'], [10, 'Sphinx Beer', 'A', 'beer'], [10, 'Edge Energy Drink', 'N', 'energy'],
  [11, 'Castle Bridge Dry Gin', 'A', 'gin'], [11, 'Mandingo Bitters', 'A', 'bitters'], [11, 'Herb Afrik', 'A', 'bitters'], [11, 'Takai Liqueur', 'A', 'liqueur'],
  [12, 'Guinness Foreign Extra Stout', 'A', 'stout'], [12, 'Malta Guinness', 'N', 'malt'], [12, 'Orijin Herbal Bitters', 'A', 'bitters'], [12, 'Dubic Malt', 'A', 'beer', true],
  [13, 'Joy Dadi Bitters', 'A', 'bitters'], [13, 'Joy Twedie Ginger', 'A', 'bitters', true], [13, 'Sokoo Alcohol Appetizer', 'A', 'bitters'],
  [14, 'Kakira Dark Rum', 'A', 'rum'], [14, 'Kakira Vodka', 'A', 'spirit'], [14, 'Kakira Gin', 'A', 'gin'],
  [15, 'Alomo Bitters', 'A', 'bitters'], [15, 'Awake Purified Water', 'W', 'water'], [15, 'Storm Energy Drink', 'N', 'energy'], [15, 'K20 Whiskey', 'A', 'whisky'],
  [16, 'Tusker Cider', 'A', 'cider'], [16, 'Pilsner Lager', 'A', 'beer'], [16, 'Senator Keg', 'A', 'beer'], [16, 'Balozi Lager', 'A', 'beer'],
  [17, 'Summit Lager', 'A', 'beer'], [17, 'Summit Malt', 'A', 'beer', true], [17, 'Crescent Gin', 'A', 'gin'], [17, 'Viena Ice', 'A', 'rtd'],
  [18, 'KWV 3/5/10 Year Old Brandy', 'A', 'brandy'], [18, 'Laborie Wines', 'WINE', 'wine'], [18, 'Roodeberg Blends', 'WINE', 'wine'], [18, 'Wild Africa Cream', 'A', 'liqueur'],
  [19, 'Oulmès Sparkling Water', 'W', 'sparkling'], [19, 'Sidi Ali Spring Water', 'W', 'water'], [19, 'Bahia Water', 'W', 'water'],
  [20, 'Windhoek Lager', 'A', 'beer'], [20, 'Tafel Lager', 'A', 'beer'], [20, 'King Lager', 'A', 'beer'], [20, 'McKane Mixers', 'N', 'mixer'],
  [21, 'Procera Gin', 'A', 'gin'],
  [22, 'Star Lager', 'A', 'beer'], [22, 'Gulder', 'A', 'beer'], [22, 'Legend Extra Stout', 'A', 'stout'], [22, 'Maltina', 'N', 'malt'], [22, 'Amstel Malta', 'N', 'malt'],
  [23, 'Phoenix Beer', 'A', 'beer'], [23, 'Blue Marlin', 'A', 'beer'], [23, 'Grapetiser (local bottling)', 'N', 'juice'], [23, 'Crystal Table Water', 'W', 'water'],
  [24, '7Up', 'N', 'soda'], [24, 'Pepsi', 'N', 'soda'], [24, 'Mirinda', 'N', 'soda'], [24, 'Aquafina', 'W', 'water'], [24, 'Supa Komando Energy Drink', 'N', 'energy'],
  [25, 'Celtia Beer', 'A', 'beer'], [25, 'Stella Beer', 'A', 'beer'], [25, 'Boga Soft Drinks', 'N', 'soda'], [25, 'Safia Mineral Water', 'W', 'water'],
  [26, 'Carling Black Label', 'A', 'beer'], [26, 'Castle Lager', 'A', 'beer'], [26, 'Hansa Pilsener', 'A', 'beer'], [26, 'Flying Fish', 'A', 'beer'], [26, 'Brutal Fruit', 'A', 'rtd'],
  [27, 'Takamaka Rum (Pti Lakaz, St André, Coco Rum)', 'A', 'rum'],
  [28, 'Safari Lager', 'A', 'beer'], [28, 'Kilimanjaro Premium Lager', 'A', 'beer'], [28, 'Ndovu Special Malt', 'A', 'beer'], [28, 'Grand Malt', 'N', 'malt'],
  [29, 'Refreshhh Flavour Soda', 'N', 'soda'], [29, 'Reboost Energy', 'N', 'energy'], [29, 'JiVE Soda', 'N', 'soda'], [29, 'Coo-ee', 'N', 'soda'],
  [30, 'Verna Mineral Water', 'W', 'water'], [30, 'Rush Energy Drink', 'N', 'energy'], [30, 'Planet Soda', 'N', 'soda'], [30, 'Bigoo', 'N', 'soda']
];

const KIND = {
  beer: ['🍺', 'Lager / beer', 20], stout: ['🍺', 'Stout / dark beer', 20], cider: ['🍏', 'Cider', 20], rtd: ['🍹', 'Ready-to-drink', 20],
  spirit: ['🥃', 'Spirit', 18], gin: ['🍸', 'Gin', 18], rum: ['🥃', 'Rum', 18], whisky: ['🥃', 'Whisky', 18], brandy: ['🥃', 'Brandy', 18],
  bitters: ['🥃', 'Herbal bitters (spirit drink)', 18], liqueur: ['🥃', 'Cream liqueur', 18], wine: ['🍷', 'Wine', 18],
  malt: ['🧃', 'Malt drink (non-alcoholic)', 20], soda: ['🥤', 'Soft drink', 20], energy: ['⚡', 'Energy drink', 20], juice: ['🧃', 'Juice', 20],
  dairy: ['🥛', 'Dairy drink', 20], mixer: ['🫧', 'Mixer', 20], water: ['💧', 'Still water', 20], sparkling: ['🫧', 'Sparkling water', 20]
};
const SUB = { A: 'alcoholic', N: 'non_alcoholic', W: 'water', WINE: 'wine' };
const FIRST_ID = 101;

// Generic drinks seeded earlier that are now covered by named brands (hidden if never priced)
const SUPERSEDED = [73, 74, 75, 76, 78, 79, 80, 81, 84, 89];

function brandProducts() {
  return items.map(([makerId, name, type, kind, verifyAbv], i) => {
    const [emoji, label, unitId] = KIND[kind];
    const maker = makers.find((m) => m[0] === makerId);
    const country = maker[2];
    const notes = `${label} by ${maker[1]}, ${country}.` +
      (type === 'A' || type === 'WINE' ? ' Not for sale to persons under 18.' : '') +
      (verifyAbv ? ' Alcohol content to be confirmed from the label — listed as 18+ until verified.' : '');
    return { id: FIRST_ID + i, makerId, name, sub: SUB[type], unitId, notes, emoji, ageRestricted: type === 'A' || type === 'WINE' ? 1 : 0, verifyAbv: Boolean(verifyAbv) };
  });
}

function seedBrands(db) {
  tx(db, () => {
    const b = db.prepare('INSERT OR IGNORE INTO brands (id, name, country, country_codes, notes) VALUES (?, ?, ?, ?, ?)');
    makers.forEach((m) => b.run(...m));
    const p = db.prepare(`INSERT OR IGNORE INTO products (id, name, category_id, subcategory, default_unit_id, notes, emoji, age_restricted, brand_id, verify_abv)
      VALUES (?, ?, 10, ?, ?, ?, ?, ?, ?, ?)`);
    for (const x of brandProducts()) p.run(x.id, x.name, x.sub, x.unitId, x.notes, x.emoji, x.ageRestricted, x.makerId, x.verifyAbv ? 1 : 0);
    db.prepare(`UPDATE products SET active = 0 WHERE id IN (${SUPERSEDED.join(',')}) AND price_pesewas IS NULL
      AND id NOT IN (SELECT product_id FROM order_items)`).run();
  });
}

module.exports = { seedBrands, makers, items, brandProducts, FIRST_ID, SUPERSEDED };
