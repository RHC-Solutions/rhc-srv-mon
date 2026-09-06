# rhc-srv-mon

Zero-dependency Node.js (>= 22) server-management panel, on the road to replacing CloudPanel on this host.
Runs as root under pm2 (`rhc-srv-mon`, cwd `/root`), binds 127.0.0.1:8899, exposed by nginx at `/rhc-srv-mon/`.

## Layout

- `server.js` — entry point: HTTP dispatcher (legacy if/else routes + `lib/http.js` router), `/ws/ssh` upgrade, boot.
- `lib/` — one module per feature: `auth` (login + TOTP + sessions), `history`/`collect` (PM2 heartbeats), `postgres`,
  `updates`, `sites` (health), `modules` (scan / auto-update / cleanup), `backups`, `ssh` (terminal + remote installer),
  `notify` (Telegram), `cloudpanel` (read-only CLP SQLite), `http` (helpers + router), `page` (UI assembly), `util`, `config`.
- `ui/` — the browser app: `index.html` shell, `app.css`, `core.js` (helpers, state, tabs, refresh), `tabs/*.js`, `boot.js`,
  `login.html`. `lib/page.js` concatenates all JS into one `<script>` (shared scope) and syntax-checks it at boot.
- `scripts/check-page.js` (UI assembly + duplicate top-level identifiers), `scripts/check-refs.js` (no dangling references
  after moving code between modules). Run both before landing.
- State files stay next to `server.js`: `auth.json`, `updates.json`, `modules.json`, `backups.json`, `ssh-hosts.json`,
  `history.json`, `.helpers/`, `.sessions/` (all gitignored).

## Development

Work in the `v2` worktree, never in the live checkout (an auto-commit cron pushes `main` every 15 minutes):

```sh
git worktree add /opt/rhc-srv-mon-v2 v2          # once
cd /root && PORT=8898 RHC_NO_JOBS=1 RHC_DEV=1 node /opt/rhc-srv-mon-v2/server.js
```

`RHC_NO_JOBS=1` disables every scheduler (update checks, module scans, auto-update, cleanup, backups) — request-triggered
actions still run against the real box. `RHC_DEV=1` rebuilds the page from `ui/` on every request. Landing:

```sh
flock /var/lock/rhc-autocommit sh -c 'git merge --no-edit v2 && pm2 restart rhc-srv-mon'
pm2 logs rhc-srv-mon --lines 30      # expect "re-adopted" lines for open SSH sessions
```

## Reverse proxy: WebSocket for the SSH tab

The 🖥️ SSH tab uses a WebSocket at `/ws/ssh`. Behind nginx the `Connection` header must be the literal
`Upgrade` when the client asks for one — **not** `$http_upgrade` (which is `websocket`); with the wrong
value Node never emits its `upgrade` event, the app answers 404/426 and the browser only sees close code 1006.

```nginx
server {
  set $rhc_connection_upgrade "";
  if ($http_upgrade) { set $rhc_connection_upgrade "Upgrade"; }

  location ^~ /rhc-srv-mon/ {
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $rhc_connection_upgrade;
    proxy_read_timeout 86400;  proxy_send_timeout 86400;  proxy_buffering off;
    proxy_pass http://127.0.0.1:8899/;
  }
}
```

If a terminal tab dies right after opening, the page fetches the same URL over HTTP and shows the server's
diagnosis in the red bar. Sessions survive transport drops (Cloudflare/proxy cut, laptop sleep): the pty
is kept for 10 minutes and the page re-attaches automatically.

## Telegram alerts for web logins

With Telegram enabled (Updates tab), failed logins, wrong authenticator codes, lockouts and successful
logins to this UI are pushed to the same chat (checkbox "Notify on web login attempts"). Bursts from one IP
are collapsed to one message per minute.

## SSH tab: persistent sessions, keys, uploads

- Sessions live on the server until the tab's × (or `DELETE /api/ssh/sessions/:id`). Refresh, closed browser,
  Cloudflare cut or laptop sleep only detach them; the page re-attaches on load and replays the last 512 KB of output.
- Keys are Windows-style: Ctrl+C copies a selection (otherwise ^C), Ctrl+V pastes text or uploads a file/screenshot
  from the clipboard, Ctrl+Z is swallowed unless "Unix style" is chosen in ⚙ Terminal settings (font, size, theme, colors).
- Drag & drop / paste files → `POST /api/ssh/sessions/:id/upload?name=` → written to `~/rhc-uploads/` on the remote
  host over a second ssh connection; the path is typed into the terminal (handy for Claude Code).
- Host option "Become root (sudo -i)" for non-root logins; the installer accepts a sudo password (SUDO_ASKPASS, not stored).

## pnpm shared store (/var/lib/pnpm-store)

Owned `root:pnpmstore`, dirs 2775, files g+rw; every site user is in `pnpmstore`. Projects set
`packageImportMethod: copy` in `pnpm-workspace.yaml` (and the updater passes `--config.package-import-method=copy`)
so node_modules are copies, not hard links into the shared store. The fix-perms auto-fix skips files with >1 link.

## SSH tab: split layouts · installer on appliances

- Tab bar buttons ▭ / ▭▭ / ▭▭▭ / ⊞ show 1, 2, 3 or 4 (2×2) terminals at once; tabs still list every session,
  the green-bordered pane is the focused one and receives the next host you click. ⤢ on a pane goes back to single view.
- Installer option "Private Node.js inside the install dir" (default on) downloads the official Node tarball into
  `<appDir>/.node` and installs pm2 into that prefix, so the target's system Node.js (FreePBX, appliances) is untouched.
  Non-root targets need the sudo password typed in the dialog (SUDO_ASKPASS, never stored).
