'use strict';
// Postgres app credentials for the DB tab's "show password". Stored here only (password is
// AES-GCM encrypted via secrets.js) — no db-credentials.json, no scraping of .env files.
exports.up = (db) => {
  db.exec(`
    CREATE TABLE db_credentials (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      role         TEXT NOT NULL,
      database     TEXT NOT NULL,
      host         TEXT NOT NULL DEFAULT '127.0.0.1',
      port         TEXT NOT NULL DEFAULT '5432',
      password_enc TEXT NOT NULL,
      source       TEXT,
      updated_at   TEXT NOT NULL,
      UNIQUE (role, database)
    );
  `);
};
