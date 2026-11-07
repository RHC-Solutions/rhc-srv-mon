'use strict';
// Vault: passwords, tokens, API keys and notes kept by the panel. The secret and the notes are
// encrypted with secrets.encrypt() (AES-256-GCM, key in secret.key); name, kind, username, URL and
// tags stay readable so the list can be searched without decrypting anything.
exports.up = (db) => {
  db.exec(`
    CREATE TABLE vault (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'password',   -- password | token | api-key | ssh-key | certificate | note | other
      username    TEXT,
      url         TEXT,
      tags        TEXT,                               -- comma separated
      secret_enc  TEXT NOT NULL,                      -- secrets.encrypt(secret)
      notes_enc   TEXT,                               -- secrets.encrypt(notes) or NULL
      created_at  TEXT NOT NULL,
      created_by  TEXT,
      updated_at  TEXT NOT NULL,
      updated_by  TEXT
    );
  `);
};
