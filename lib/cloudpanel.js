'use strict';
// Read-only access to CloudPanel's SQLite while we coexist with it. Opened per query with
// node:sqlite (no sqlite3 CLI dependency). CLP's DB is journal_mode=delete, so a hot journal or
// a concurrent CLP write can make the open/read fail — callers get [] in that case, as before.
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const CLP_DB = '/home/clp/htdocs/app/data/db.sq3';

const SITES_SQL = "SELECT s.id, s.domain_name, s.type, s.user, s.root_directory, s.reverse_proxy_url, s.varnish_cache, "
  + "n.port AS node_port, n.nodejs_version, "
  + "p.php_version, p.pool_port, p.memory_limit "
  + "FROM site s "
  + "LEFT JOIN nodejs_settings n ON n.site_id = s.id "
  + "LEFT JOIN php_settings p ON p.site_id = s.id "
  + "ORDER BY s.domain_name";

function exists() { return fs.existsSync(CLP_DB); }

// Run fn(db) against CLP's DB read-only; returns fn's result or `def` on any failure.
function withDb(fn, def) {
  if (!exists()) return def;
  let db;
  try {
    db = new DatabaseSync(CLP_DB, { readOnly: true, timeout: 5000 });
    return fn(db);
  } catch (_) { return def; }
  finally { try { if (db) db.close(); } catch (_) {} }
}

// Same shape the old `sqlite3 | split('|')` parser produced: every field a string ('' → null
// for the optional ones), ids included, so the /api/sites payload is unchanged.
const str = (v) => (v == null ? '' : String(v));
const opt = (v) => (v == null || v === '' ? null : String(v));
function querySitesDb() {
  return withDb((db) => db.prepare(SITES_SQL).all().map((r) => ({
    id: str(r.id), domain: str(r.domain_name), type: str(r.type), user: str(r.user), root: str(r.root_directory),
    revProxy: str(r.reverse_proxy_url), varnish: str(r.varnish_cache) === '1',
    nodePort: opt(r.node_port), nodeVer: opt(r.nodejs_version), phpVer: opt(r.php_version), poolPort: opt(r.pool_port), phpMem: opt(r.memory_limit),
  })), []);
}

module.exports = { CLP_DB, exists, withDb, querySitesDb };
