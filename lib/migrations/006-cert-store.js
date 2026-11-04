'use strict';
// Central certificate store: certificates that belong to no site (typically a Cloudflare origin
// wildcard such as *.rhc.pw). A new site takes the best matching one at creation; any site can
// pull one from here; a renewed cert is deployed to every site that still serves the old one.
exports.up = (db) => {
  db.exec(`
    CREATE TABLE cert_store (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT,                           -- free label, defaults to the SAN list
      type            TEXT NOT NULL,                  -- cloudflare_origin | letsencrypt | custom
      subject         TEXT,
      sans            TEXT NOT NULL,                  -- JSON array
      issuer          TEXT,
      not_before      TEXT,
      expires_at      TEXT,
      fingerprint     TEXT NOT NULL UNIQUE,           -- sha256 of the leaf
      certificate     TEXT NOT NULL,
      chain           TEXT,
      private_key_enc TEXT NOT NULL,                  -- secrets.encrypt()
      source          TEXT,                           -- upload | site:<domain> | disk:<file>
      created_at      TEXT NOT NULL
    );
  `);
};
