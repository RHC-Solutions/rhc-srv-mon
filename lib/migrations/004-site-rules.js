'use strict';
// Per-site nginx rules that all render into the vhost's {{settings}} block: extra domain names,
// redirects, rewrites, hotlink protection and traffic limits.
exports.up = (db) => {
  db.exec(`
    CREATE TABLE site_aliases (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      domain     TEXT NOT NULL,
      redirect   INTEGER NOT NULL DEFAULT 0,   -- 1 = 301 to the primary domain instead of serving
      created_at TEXT NOT NULL,
      UNIQUE (site_id, domain)
    );
    CREATE TABLE site_redirects (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL DEFAULT 'exact',  -- exact | prefix | regex
      source     TEXT NOT NULL,
      target     TEXT NOT NULL,
      code       INTEGER NOT NULL DEFAULT 301,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE site_rewrites (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      pattern     TEXT NOT NULL,
      replacement TEXT NOT NULL,
      flag        TEXT NOT NULL DEFAULT 'last', -- last | break | redirect | permanent
      position    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL
    );
    CREATE TABLE site_hotlink (
      site_id    INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
      enabled    INTEGER NOT NULL DEFAULT 0,
      extensions TEXT NOT NULL DEFAULT 'jpg,jpeg,png,gif,webp,svg,bmp,ico,mp4,webm,mp3,pdf',
      allowed    TEXT,                          -- extra referer hosts, one per line
      action     INTEGER NOT NULL DEFAULT 403,  -- 403 | 444
      updated_at TEXT NOT NULL
    );
    CREATE TABLE site_traffic (
      site_id     INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
      enabled     INTEGER NOT NULL DEFAULT 0,
      req_per_sec INTEGER,                       -- limit_req_zone rate
      req_burst   INTEGER NOT NULL DEFAULT 20,
      conn_limit  INTEGER,                       -- limit_conn per client address
      rate_kb     INTEGER,                       -- limit_rate, KB/s per connection
      updated_at  TEXT NOT NULL
    );
  `);
};
