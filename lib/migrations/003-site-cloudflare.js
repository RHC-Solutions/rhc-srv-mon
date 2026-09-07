'use strict';
// Cloudflare binding per site. A panel manages domains that live in different Cloudflare accounts
// (an account-owned token can only ever see its own account's zones), so the token belongs to the
// site, not to the panel. A site with no row falls back to the account-wide token in settings.
exports.up = (db) => {
  db.exec(`
    CREATE TABLE site_cloudflare (
      site_id      INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
      token_enc    TEXT,                 -- secrets.encrypt(); NULL = use the account-wide token
      zone_id      TEXT,
      zone_name    TEXT,
      account_id   TEXT,
      account_name TEXT,
      checked_at   TEXT,
      last_error   TEXT
    );
  `);
};
