'use strict';
// Sites and everything attached to a site. Mirrors what CloudPanel keeps in db.sq3 so the
// importer is a straight mapping; `managed_by` records whether CLP or this panel owns a row.
exports.up = (db) => {
  db.exec(`
    CREATE TABLE sites (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      domain            TEXT NOT NULL UNIQUE,
      type              TEXT NOT NULL,                -- php | nodejs | static | reverse-proxy | python
      user              TEXT NOT NULL UNIQUE,         -- unix site user
      root_dir          TEXT NOT NULL,                -- relative to /home/<user>/htdocs (like CLP)
      application       TEXT,                         -- template name (Generic, WordPress, Nodejs, …)
      vhost_template    TEXT NOT NULL,                -- stage-1 template (literal server_name, remaining {{placeholders}})
      varnish_cache     INTEGER NOT NULL DEFAULT 0,
      cf_only           INTEGER NOT NULL DEFAULT 0,   -- allow_traffic_from_cloudflare_only
      pagespeed_enabled INTEGER NOT NULL DEFAULT 0,
      pagespeed_settings TEXT,
      reverse_proxy_url TEXT,
      user_password_enc TEXT,                         -- secrets.encrypt()
      ssh_keys          TEXT,
      managed_by        TEXT NOT NULL DEFAULT 'rhc',  -- clp | rhc
      vhost_source      TEXT NOT NULL DEFAULT 'template', -- template (has placeholders) | disk (imported verbatim, no placeholders)
      clp_id            INTEGER,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
    CREATE TABLE site_php (
      site_id            INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
      php_version        TEXT NOT NULL,
      pool_port          INTEGER NOT NULL UNIQUE,
      memory_limit       TEXT NOT NULL DEFAULT '256M',
      max_execution_time TEXT NOT NULL DEFAULT '60',
      max_input_time     TEXT NOT NULL DEFAULT '60',
      max_input_vars     TEXT NOT NULL DEFAULT '1000',
      post_max_size      TEXT NOT NULL DEFAULT '32M',
      upload_max_filesize TEXT NOT NULL DEFAULT '32M',
      additional_configuration TEXT              -- extra ini lines appended to PHP_VALUE (date.timezone=UTC; …)
    );
    CREATE TABLE site_nodejs (
      site_id      INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
      node_version TEXT NOT NULL,
      port         INTEGER NOT NULL UNIQUE,
      runtime      TEXT NOT NULL DEFAULT 'nvm'        -- nvm | system
    );
    CREATE TABLE site_python (
      site_id        INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
      python_version TEXT NOT NULL,
      port           INTEGER NOT NULL UNIQUE
    );
    CREATE TABLE certificates (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      type            TEXT NOT NULL,                  -- self_signed | cloudflare_origin | letsencrypt | custom
      subject         TEXT,
      sans            TEXT,                           -- JSON array
      issuer          TEXT,
      expires_at      TEXT,
      private_key_enc TEXT,                           -- secrets.encrypt()
      certificate     TEXT NOT NULL,
      chain           TEXT,
      fingerprint     TEXT,                           -- sha256 of the leaf, for matching the on-disk file
      is_active       INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL
    );
    CREATE INDEX certificates_site ON certificates (site_id);
    CREATE TABLE basic_auth (
      site_id      INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
      is_active    INTEGER NOT NULL DEFAULT 1,
      username     TEXT,
      password_enc TEXT,                              -- kept to regenerate the htpasswd file / show in UI
      allowed_ips  TEXT                               -- JSON array, always allowed without auth
    );
    CREATE TABLE blocked_ips  (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE, ip TEXT NOT NULL, UNIQUE (site_id, ip));
    CREATE TABLE blocked_bots (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE, ua TEXT NOT NULL, UNIQUE (site_id, ua));
    CREATE TABLE ssh_users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      username   TEXT NOT NULL UNIQUE,
      ssh_keys   TEXT,
      password_enc TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE ftp_users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      username   TEXT NOT NULL UNIQUE,
      home       TEXT NOT NULL,
      password_enc TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE cron_jobs (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id  INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      minute   TEXT NOT NULL, hour TEXT NOT NULL, day TEXT NOT NULL, month TEXT NOT NULL, weekday TEXT NOT NULL,
      command  TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX cron_jobs_site ON cron_jobs (site_id);
    CREATE TABLE database_servers (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      engine             TEXT NOT NULL,               -- mariadb | postgres
      host               TEXT NOT NULL,
      port               INTEGER NOT NULL,
      admin_user         TEXT NOT NULL,
      admin_password_enc TEXT,
      is_default         INTEGER NOT NULL DEFAULT 0,
      UNIQUE (engine, host, port)
    );
    CREATE TABLE databases (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      server_id  INTEGER NOT NULL REFERENCES database_servers(id),
      name       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (server_id, name)
    );
    CREATE TABLE database_users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      database_id  INTEGER NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
      username     TEXT NOT NULL,
      password_enc TEXT,
      permissions  TEXT NOT NULL DEFAULT 'rw',        -- rw | ro
      created_at   TEXT NOT NULL
    );
    CREATE TABLE vhost_templates (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL UNIQUE,
      type             TEXT NOT NULL,                 -- php | nodejs | static | reverse-proxy | python
      php_version      TEXT,
      root_dir         TEXT,                          -- suffix appended to the docroot (public, web, …)
      template         TEXT NOT NULL,
      varnish_settings TEXT,
      source           TEXT NOT NULL DEFAULT 'clp',   -- clp | builtin | custom
      updated_at       TEXT NOT NULL
    );
  `);
};
