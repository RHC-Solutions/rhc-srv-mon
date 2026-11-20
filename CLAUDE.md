# RHC SRV MAN — working on this repo

Server-management panel (Node >= 22, zero dependencies). Details: README.md.

- **One repo:** https://github.com/RHC-Solutions/rhc-srv-mon, branch `main`. Every server updates from it and pushes only
  to it (`lib/panelrepo.js`, `resources/rhc-autocommit.sh`). Never add another remote; roman-synergybeam/sbsrvman is retired.
  Work branches get merged into `main` and deleted (keep an `archive/*` tag if history matters).
- **Auto-commit:** the checkout commits and pushes itself every 15 min (web01: cron `rhc-srv-mon-autocommit.sh`,
  commits `Auto-commit <time> (<host>)`; elsewhere `rhc-autocommit.timer`). Check `git status` before committing; a clean
  tree means the work is already pushed — never rewrite those commits.
- **Stack stays minimal:** Node built-ins only (no npm deps, no build step), SQLite for panel state, plain JS UI.
  No framework rewrite (Next.js/Postgres considered and rejected 2026-11-20, see README "Stack"); TypeScript only via
  Node's built-in type stripping.
- **Edits go live by themselves** (`lib/selfreload.js`): UI rebuilt in place; backend syntax/load-checked, then the panel
  restarts. Keep every intermediate save loadable and never tell the user to restart pm2 by hand.
- **Names:** product name "RHC SRV MAN" (`lib/page.js` DEFAULT_NAME, per-host override in Settings). Folder and
  pm2 name differ per server — web01: `/opt/rhc-srv-mon` / `rhc-srv-mon`; older servers: `/opt/sb-srv-mon` / `sb-srv-mon`.
  Never hard-code either: use `APP_ROOT` and `process.env.name`. `rhc-*` units and `/var/lib/sb-srv-mon/` keep their names.
- **Sites run as their own users** (`/home/<user>/htdocs/<domain>`). Touch site files through `lib/sites/files.js`
  (runs as the site user) or `sudo -u <user>`, never as root directly — a site-owned symlink must not redirect a root write.
- **Checks before landing:** `node --check` changed files, `node scripts/ui-smoke.js http://127.0.0.1:8899 <domain>`,
  `node scripts/qa.js` against a dev instance (`PORT=8898 RHC_NO_JOBS=1 RHC_DEV=1`).
