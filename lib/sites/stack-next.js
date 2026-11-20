'use strict';
// The default stack for a new Node.js site/app (New site → Node.js → Stack):
//   Next.js (App Router, src/) + TypeScript + Tailwind CSS + shadcn/ui + SQLite (Node's built-in node:sqlite)
//
// Made as the site user with the official generators (create-next-app, shadcn), then the panel adds
// its own small part: src/db (one SQLite file, data/app.db, plus a settings table whose secret values
// are AES-256-GCM encrypted with data/.secret.key), a start page that shows the database answers, and
// ecosystem.config.js running `next start` on the site's port. Then one build. No database server, no
// connection string, no .env file and no environment variables for the app's configuration.
//
// Returns { ok, output }; ok:false leaves the caller to seed the placeholder app instead, so a failed
// download never leaves a site that does not answer. Site files are only ever written as the site
// user (lib/sites/files.js, sudo -u) — never by root.
const files = require('./files');

const NVM = '. ~/.nvm/nvm.sh >/dev/null 2>&1 || true; ';
const rel = (site, p) => '/htdocs/' + site.domain + (p ? '/' + p : '');

function sh(site, script, timeout) {
  const docroot = '/home/' + site.user + '/htdocs/' + site.domain;
  return require('./runtime').asUser(site.user, NVM + 'export NEXT_TELEMETRY_DISABLED=1 CI=1 npm_config_fund=false npm_config_audit=false; cd ' + JSON.stringify(docroot) + ' && ' + script, { timeout: timeout || 10 * 60_000, lines: 8 });
}
async function write(site, p, content) { return files.op(site, { op: 'write', path: rel(site, p), content }); }
async function mkdirp(site, dir) {
  let cur = rel(site);
  for (const part of dir.split('/')) {
    try { await files.op(site, { op: 'mkdir', path: cur, name: part }); } catch (e) { if (!/exist/i.test(e.message)) throw e; }
    cur += '/' + part;
  }
}

const DB_INDEX = `// The app's database: one SQLite file (data/app.db, git-ignored) through Node's built-in node:sqlite.
// No database server, no connection string, no environment variables. Settings live in the settings
// table; secret ones are AES-256-GCM encrypted with data/.secret.key (random, mode 600, made on first use).
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DATA = path.join(process.cwd(), "data");
fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });

// One connection per server process (kept across dev-mode reloads).
const g = globalThis as { __db?: DatabaseSync };
export const db = (g.__db ??= open());

function open() {
  const d = new DatabaseSync(path.join(DATA, "app.db"));
  d.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  // Your tables: add CREATE TABLE IF NOT EXISTS statements here.
  d.exec(\`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  \`);
  try { fs.chmodSync(path.join(DATA, "app.db"), 0o600); } catch {}
  return d;
}

function key(): Buffer {
  const f = path.join(DATA, ".secret.key");
  try { return Buffer.from(fs.readFileSync(f, "utf8").trim(), "hex"); } catch {}
  const k = crypto.randomBytes(32);
  fs.writeFileSync(f, k.toString("hex") + "\\n", { mode: 0o600, flag: "wx" });
  return k;
}

export function getSetting(name: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(name) as { value: string } | undefined;
  if (!row) return null;
  if (!row.value.startsWith("enc1:")) return row.value;
  const [, iv, tag, ct] = row.value.split(":");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"), { authTagLength: 16 });
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

/** secret: true encrypts the value (API keys, tokens, passwords). null removes the setting. */
export function setSetting(name: string, value: string | null, { secret = false } = {}): void {
  if (value === null) { db.prepare("DELETE FROM settings WHERE key = ?").run(name); return; }
  let v = value;
  if (secret) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
    const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
    v = ["enc1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
  }
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(name, v);
}
`;
// Turnstile files of the Next.js stack: keys come from the app's own encrypted settings (written by the
// panel when it makes the site's widget, lib/sites/turnstile.js), never from the environment.
const TURNSTILE_LIB = `import { getSetting } from "@/db";

// Cloudflare Turnstile for this site. The panel made the widget and stored its keys in data/app.db
// (settings: turnstileSiteKey, turnstileSecret — the secret encrypted). Protect a form like this:
//   page (server):  <TurnstileWidget siteKey={turnstileSiteKey()} />   inside the <form>
//   action/route:   if (!(await verifyTurnstile(form.get("cf-turnstile-response"), ip))) → reject
export const turnstileSiteKey = () => getSetting("turnstileSiteKey");

/** true only when Cloudflare confirms the token. No keys configured → false (fails closed). */
export async function verifyTurnstile(token: FormDataEntryValue | string | null | undefined, ip?: string | null): Promise<boolean> {
  const secret = getSetting("turnstileSecret");
  if (!secret || typeof token !== "string" || !token) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body, signal: AbortSignal.timeout(10000) });
    const j = (await r.json()) as { success?: boolean };
    return j.success === true;
  } catch {
    return false;
  }
}
`;
const TURNSTILE_WIDGET = `"use client";
import Script from "next/script";

// Renders the Turnstile checkbox; the form then posts its token as "cf-turnstile-response".
export function TurnstileWidget({ siteKey }: { siteKey: string | null }) {
  if (!siteKey) return null;
  return (
    <>
      <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />
      <div className="cf-turnstile" data-sitekey={siteKey} />
    </>
  );
}
`;
function page(site, hasUi) {
  const dbLine = '<p>Database: <Suspense fallback={<strong>checking…</strong>}><DbState /></Suspense></p>';
  return `import { Suspense } from "react";
import { connection } from "next/server";
import { db } from "@/db";
${hasUi ? 'import { buttonVariants } from "@/components/ui/button";\nimport { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";\n' : ''}
// The database line is checked on every request (connection() = render at request time, inside
// Suspense as cacheComponents wants); the rest of the page is prerendered at build time.
async function DbState() {
  await connection();
  try {
    const row = db.prepare("select sqlite_version() as v").get() as { v: string };
    return <strong>SQLite {row.v} — data/app.db</strong>;
  } catch (e) {
    return <strong>error: {e instanceof Error ? e.message : String(e)}</strong>;
  }
}

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 p-8">
${hasUi ? `      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">${site.domain}</CardTitle>
          <CardDescription>Next.js · TypeScript · Tailwind CSS · shadcn/ui · SQLite</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          ${dbLine}
          <p className="text-sm text-muted-foreground">Start in <code>src/app/page.tsx</code>, tables in <code>src/db/index.ts</code>.</p>
          <a className={buttonVariants()} href="https://nextjs.org/docs" target="_blank" rel="noreferrer">Next.js docs</a>
        </CardContent>
      </Card>` : `      <h1 className="text-3xl font-semibold">${site.domain}</h1>
      <p>Next.js · TypeScript · Tailwind CSS · SQLite</p>
      ${dbLine}`}
    </main>
  );
}
`;
}
function ecosystem(site, port) {
  const docroot = '/home/' + site.user + '/htdocs/' + site.domain;
  return `// pm2 process definition for ${site.domain} (Next.js). After a code change: \`npm run build && pm2 reload ${site.domain}\`.
module.exports = {
  apps: [{
    name: ${JSON.stringify(site.domain)},
    script: "node_modules/next/dist/bin/next",
    args: "start -H 127.0.0.1 -p ${port}",
    cwd: ${JSON.stringify(docroot)},
    instances: 1,
    exec_mode: "fork",
    max_memory_restart: "768M",
    env: { NODE_ENV: "production", PORT: ${port}, NEXT_TELEMETRY_DISABLED: "1" },
    out_file: ${JSON.stringify('/home/' + site.user + '/logs/nodejs/out.log')},
    error_file: ${JSON.stringify('/home/' + site.user + '/logs/nodejs/error.log')},
  }],
};
`;
}
const README = (site) => `# ${site.domain}

Stack: **Next.js** (App Router, \`src/\`) · **TypeScript** · **Tailwind CSS** · **shadcn/ui** · **SQLite** (Node's built-in \`node:sqlite\`)

| | |
|---|---|
| Pages / API routes | \`src/app/\` |
| UI components | \`src/components/ui/\` — add more: \`npx shadcn@latest add dialog\` |
| Database | \`data/app.db\` (git-ignored) · tables in \`src/db/index.ts\` · \`import { db } from "@/db"\` |
| Settings & secrets | \`import { getSetting, setSetting } from "@/db"\` — stored in the database, secrets encrypted with \`data/.secret.key\` (mode 600, git-ignored; back it up with the database) |

No environment variables and no \`.env\` file: configuration lives in the database.

Cloudflare Turnstile: the panel made a widget for this domain and stored its keys in the settings table. Protect a form with \`<TurnstileWidget siteKey={turnstileSiteKey()} />\` (\`src/components/turnstile.tsx\`) and check it server-side with \`verifyTurnstile(token, ip)\` (\`src/lib/turnstile.ts\`).

Commands (in this directory, as the site user):

    npm run dev              # dev server on :3000 (http://127.0.0.1:3000)
    npm run build            # production build — then: pm2 reload ${site.domain}

pm2 runs \`next start\` on the site's port (ecosystem.config.js); nginx proxies the domain to it.
`;

async function scaffold(site, port) {
  const notes = [];
  const empty = await sh(site, 'test -z "$(ls -A)"', 15_000);
  if (!empty.ok) return { ok: false, output: 'the document root is not empty — left as it is' };

  const cna = await sh(site, 'npx --yes create-next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --disable-git --yes 2>&1', 15 * 60_000);
  if (!cna.ok) return { ok: false, output: 'create-next-app failed: ' + cna.output };
  notes.push('create-next-app');

  // shadcn/ui is nice to have: without it the start page simply does not use its components
  const ui = await sh(site, 'npx --yes shadcn@latest init --defaults --yes 2>&1 && npx --yes shadcn@latest add button card --yes 2>&1', 10 * 60_000);
  if (ui.ok) notes.push('shadcn/ui (button, card)'); else notes.push('shadcn/ui FAILED (' + ui.output.split('\n').pop() + ')');

  await mkdirp(site, 'src/db');
  await write(site, 'src/db/index.ts', DB_INDEX);
  await mkdirp(site, 'src/lib');
  await mkdirp(site, 'src/components');
  await write(site, 'src/lib/turnstile.ts', TURNSTILE_LIB);
  await write(site, 'src/components/turnstile.tsx', TURNSTILE_WIDGET);
  notes.push('SQLite (node:sqlite, data/app.db)');
  await write(site, 'src/app/page.tsx', page(site, ui.ok));
  await write(site, 'README.md', README(site));
  // the database file and its key never go to git
  await sh(site, 'printf "\\n# data: SQLite database and its encryption key\\n/data/\\n" >> .gitignore', 15_000);

  const build = await sh(site, 'npm run build 2>&1', 20 * 60_000);
  if (!build.ok) return { ok: false, output: 'next build failed (the code stays; the placeholder runs until it builds): ' + build.output };
  notes.push('built');
  // only now: pm2 must not be pointed at `next start` before there is a build to start
  await write(site, 'ecosystem.config.js', ecosystem(site, port));
  return { ok: true, output: notes.join(' · ') };
}

module.exports = { scaffold };
