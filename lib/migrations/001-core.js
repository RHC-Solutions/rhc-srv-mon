'use strict';
// Core tables: key/value settings and the audit/event log.
exports.up = (db) => {
  db.exec(`
    CREATE TABLE kv (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      TEXT NOT NULL,                 -- ISO 8601 UTC
      level   TEXT NOT NULL DEFAULT 'info',  -- info | warn | error
      type    TEXT NOT NULL,                 -- dotted: auth.login, updates.run, sites.vhost.save, ...
      user    TEXT,                          -- panel login, 'system' for schedulers, 'local' for loopback
      ip      TEXT,
      site    TEXT,                          -- domain when the event concerns one site
      target  TEXT,                          -- component / host / project the action touched
      message TEXT NOT NULL,
      data    TEXT                           -- JSON blob with details (command output, before/after, ...)
    );
    CREATE INDEX events_ts   ON events (ts);
    CREATE INDEX events_type ON events (type, ts);
    CREATE INDEX events_site ON events (site, ts);
    CREATE INDEX events_user ON events (user, ts);
  `);
};
