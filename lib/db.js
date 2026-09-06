'use strict';
// SQLite store (node:sqlite, built into Node >= 22.13) for everything that outgrows the JSON
// files: events, sites, users, settings. One file, WAL mode, numbered migrations in
// lib/migrations/NNN-<name>.js each exporting `up(db)`.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR } = require('./config');

const DB_FILE = path.join(DATA_DIR, 'rhc.sqlite');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let db = null;

function open() {
  if (db) return db;
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  try { fs.chmodSync(DB_FILE, 0o600); } catch (_) {}
  migrate();
  return db;
}

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT id FROM migrations').all().map((r) => r.id));
  const files = fs.existsSync(MIGRATIONS_DIR) ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}-.*\.js$/.test(f)).sort() : [];
  for (const f of files) {
    const id = parseInt(f.slice(0, 3), 10);
    if (done.has(id)) continue;
    const mod = require(path.join(MIGRATIONS_DIR, f));
    db.exec('BEGIN');
    try {
      mod.up(db);
      db.prepare('INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)').run(id, f, new Date().toISOString());
      db.exec('COMMIT');
      console.log('db: applied migration ' + f);
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error('migration ' + f + ' failed: ' + e.message);
    }
  }
}

// Key/value settings (JSON values). settings.get('events.retentionDays', 90)
const settings = {
  get(key, def) {
    const r = open().prepare('SELECT value FROM kv WHERE key = ?').get(key);
    if (!r) return def;
    try { return JSON.parse(r.value); } catch (_) { return def; }
  },
  set(key, value) {
    open().prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(value), new Date().toISOString());
  },
  del(key) { open().prepare('DELETE FROM kv WHERE key = ?').run(key); },
  // every key under a prefix, as an object without the prefix ("notify." → { telegram: {...}, slack: {...} })
  list(prefix) {
    const out = {};
    for (const r of open().prepare('SELECT key, value FROM kv WHERE key LIKE ?').all(prefix + '%')) {
      try { out[r.key.slice(prefix.length)] = JSON.parse(r.value); } catch (_) {}
    }
    return out;
  },
};

// Consistent snapshot for backups (never tar the live WAL file).
function snapshotTo(file) {
  try { fs.unlinkSync(file); } catch (_) {}
  open().exec("VACUUM INTO '" + String(file).replace(/'/g, "''") + "'");
  return file;
}

function transaction(fn) {
  const d = open();
  d.exec('BEGIN');
  try { const r = fn(d); d.exec('COMMIT'); return r; }
  catch (e) { d.exec('ROLLBACK'); throw e; }
}

module.exports = { DB_FILE, open, settings, snapshotTo, transaction };
