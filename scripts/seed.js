'use strict';
// Creates/migrates the database and loads reference data (safe to run repeatedly).
const config = require('../src/config');
const db = require('../src/db').open(config.DATABASE_PATH);
const { seed, seedDrinks, seedHalal } = require('../src/seed');
const created = seed(db);
seedDrinks(db);
require('../src/seed-brands').seedBrands(db);
seedHalal(db);
console.log(created ? `Seeded ${config.DATABASE_PATH}` : 'Database already seeded — nothing to do.');
db.close();
