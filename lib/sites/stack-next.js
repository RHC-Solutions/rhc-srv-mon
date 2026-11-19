'use strict';
// The default stack for a new Node.js site/app (New site → Node.js → Stack):
//   Next.js (App Router, src/) + TypeScript + Tailwind CSS + shadcn/ui + PostgreSQL through Drizzle ORM
//
// Made as the site user with the official generators (create-next-app, shadcn), then the panel adds
// its own small part: Drizzle config + schema + client, .env with DATABASE_URL (the site's own
// PostgreSQL database, created by lib/sites/create.js), a start page that shows the database answers,
// db:* npm scripts, and ecosystem.config.js running `next start` on the site's port. Then one build.
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

const DRIZZLE_CONFIG = `import { defineConfig } from "drizzle-kit";

// drizzle-kit does not read .env by itself (Next.js does, at build and run time)
try { process.loadEnvFile(".env"); } catch {}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
`;
const SCHEMA = `import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// Your tables. After a change: \`npm run db:push\` (dev) or \`npm run db:generate\` + \`npm run db:migrate\`.
export const notes = pgTable("notes", {
  id: serial("id").primaryKey(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
`;
const DB_INDEX = `import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// One pool per server process; DATABASE_URL comes from .env (never committed).
const client = postgres(process.env.DATABASE_URL!, { max: 5 });
export const db = drizzle(client, { schema });
`;
function page(site, hasUi) {
  const dbLine = '<p>Database: <Suspense fallback={<strong>checking…</strong>}><DbState /></Suspense></p>';
  return `import { Suspense } from "react";
import { connection } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
${hasUi ? 'import { buttonVariants } from "@/components/ui/button";\nimport { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";\n' : ''}
// The database line is checked on every request (connection() = render at request time, inside
// Suspense as cacheComponents wants); the rest of the page is prerendered at build time.
async function DbState() {
  await connection();
  if (!process.env.DATABASE_URL) return <strong>not configured — set DATABASE_URL in .env</strong>;
  try {
    await db.execute(sql\`select 1\`);
    return <strong>connected</strong>;
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
          <CardDescription>Next.js · TypeScript · Tailwind CSS · shadcn/ui · PostgreSQL + Drizzle</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          ${dbLine}
          <p className="text-sm text-muted-foreground">Start in <code>src/app/page.tsx</code>, tables in <code>src/db/schema.ts</code>.</p>
          <a className={buttonVariants()} href="https://nextjs.org/docs" target="_blank" rel="noreferrer">Next.js docs</a>
        </CardContent>
      </Card>` : `      <h1 className="text-3xl font-semibold">${site.domain}</h1>
      <p>Next.js · TypeScript · Tailwind CSS · PostgreSQL + Drizzle</p>
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
const README = (site, db) => `# ${site.domain}

Stack: **Next.js** (App Router, \`src/\`) · **TypeScript** · **Tailwind CSS** · **shadcn/ui** · **PostgreSQL** + **Drizzle ORM**

| | |
|---|---|
| Pages / API routes | \`src/app/\` |
| UI components | \`src/components/ui/\` — add more: \`npx shadcn@latest add dialog\` |
| Database tables | \`src/db/schema.ts\` · client: \`import { db } from "@/db"\` |
| Database | ${db ? 'PostgreSQL \`' + db.name + '\` (user \`' + db.user + '\`) — \`DATABASE_URL\` in \`.env\`' : 'none yet — create one under the site\'s Databases tab and put DATABASE_URL in .env'} |

Commands (in this directory, as the site user):

    npm run dev              # dev server on :3000 (http://127.0.0.1:3000)
    npm run build            # production build — then: pm2 reload ${site.domain}
    npm run db:push          # sync src/db/schema.ts to the database (dev)
    npm run db:generate      # write a migration to ./drizzle …
    npm run db:migrate       # … and apply it (production)
    npm run db:studio        # browse the data

pm2 runs \`next start\` on the site's port (ecosystem.config.js); nginx proxies the domain to it.
`;

async function scaffold(site, port, db) {
  const notes = [];
  const empty = await sh(site, 'test -z "$(ls -A)"', 15_000);
  if (!empty.ok) return { ok: false, output: 'the document root is not empty — left as it is' };

  const cna = await sh(site, 'npx --yes create-next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --disable-git --yes 2>&1', 15 * 60_000);
  if (!cna.ok) return { ok: false, output: 'create-next-app failed: ' + cna.output };
  notes.push('create-next-app');

  // shadcn/ui is nice to have: without it the start page simply does not use its components
  const ui = await sh(site, 'npx --yes shadcn@latest init --defaults --yes 2>&1 && npx --yes shadcn@latest add button card --yes 2>&1', 10 * 60_000);
  if (ui.ok) notes.push('shadcn/ui (button, card)'); else notes.push('shadcn/ui FAILED (' + ui.output.split('\n').pop() + ')');

  const dz = await sh(site, 'npm install drizzle-orm postgres 2>&1 && npm install -D drizzle-kit 2>&1', 10 * 60_000);
  if (!dz.ok) return { ok: false, output: 'installing Drizzle failed: ' + dz.output };
  notes.push('drizzle-orm + postgres + drizzle-kit');

  await mkdirp(site, 'src/db');
  await write(site, 'drizzle.config.ts', DRIZZLE_CONFIG);
  await write(site, 'src/db/schema.ts', SCHEMA);
  await write(site, 'src/db/index.ts', DB_INDEX);
  await write(site, 'src/app/page.tsx', page(site, ui.ok));
  await write(site, 'README.md', README(site, db));
  const pkg = JSON.parse((await files.op(site, { op: 'read', path: rel(site, 'package.json') })).content);
  pkg.scripts = Object.assign({}, pkg.scripts, { 'db:push': 'drizzle-kit push', 'db:generate': 'drizzle-kit generate', 'db:migrate': 'drizzle-kit migrate', 'db:studio': 'drizzle-kit studio' });
  await write(site, 'package.json', JSON.stringify(pkg, null, 2) + '\n');
  // .env: the database URL and nothing else — git-ignored by create-next-app (.env*), owner-only
  await write(site, '.env', db ? 'DATABASE_URL=' + db.url + '\n' : '# DATABASE_URL=postgres://user:password@127.0.0.1:5432/dbname\n');
  await sh(site, 'chmod 600 .env', 15_000);

  if (db) {
    const push = await sh(site, 'npx drizzle-kit push --force 2>&1', 5 * 60_000);
    notes.push(push.ok ? 'tables created (drizzle-kit push)' : 'drizzle-kit push FAILED (' + push.output.split('\n').pop() + ')');
  }

  const build = await sh(site, 'npm run build 2>&1', 20 * 60_000);
  if (!build.ok) return { ok: false, output: 'next build failed (the code stays; the placeholder runs until it builds): ' + build.output };
  notes.push('built');
  // only now: pm2 must not be pointed at `next start` before there is a build to start
  await write(site, 'ecosystem.config.js', ecosystem(site, port));
  return { ok: true, output: notes.join(' · ') };
}

module.exports = { scaffold };
