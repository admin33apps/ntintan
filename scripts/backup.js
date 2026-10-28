'use strict';
// Online, consistent backup of the SQLite database (safe while the app runs).
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');
const { DatabaseSync } = require('node:sqlite');
fs.mkdirSync(config.BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(config.BACKUP_DIR, `ntintan-${stamp}.db`);
const db = new DatabaseSync(config.DATABASE_PATH);
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();
// Keep the 30 most recent backups
const files = fs.readdirSync(config.BACKUP_DIR).filter((f) => /^ntintan-.*\.db$/.test(f)).sort();
files.slice(0, Math.max(0, files.length - 30)).forEach((f) => fs.unlinkSync(path.join(config.BACKUP_DIR, f)));
console.log(`Backup written: ${target}`);
