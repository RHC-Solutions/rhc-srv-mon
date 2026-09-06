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
  after moving code between modules), `scripts/ui-smoke.js` (drives every tab in a DOM stub) and `scripts/qa.js`
  (functional sweep over every HTTP endpoint: `node scripts/qa.js http://127.0.0.1:8898 [--slow] [--net]`). Run them
  against the dev instance before landing — qa.js only makes no-op or self-restoring changes, since /etc/nginx,
  /etc/cron.d and /home are shared with production.
- State files stay next to `server.js`: `auth.json`, `updates.json`, `modules.json`, `backups.json`, `ssh-hosts.json`,
  `history.json`, `.helpers/`, `.sessions/` (all gitignored).
- `rhc.sqlite` (node:sqlite, WAL) holds the event log and key/value settings; schema changes are numbered migrations in
  `lib/migrations/` applied at boot. `secret.key` (AES-256-GCM, 0600) encrypts stored credentials — it is excluded from
  git *and* from the config backup on purpose: **back it up out of band**, a restored DB without it cannot decrypt anything.

## Sites tab (CloudPanel replacement, phase 1)

Sites live in `rhc.sqlite` (`sites`, `site_php`, `site_nodejs`, `certificates`, `ssh_users`, `cron_jobs`, …). While CloudPanel is
still installed, `lib/clp-import.js` runs at boot and on "Sync from CloudPanel": it copies CLP's sites/templates/SSH users and
**re-templates the vhost file nginx actually serves** (CLP's stored copy drops blank lines and misses hand edits) so that our
`render()` reproduces the file byte for byte while `{{ssl_certificate}} {{root}} {{settings}} {{app_port}} {{php_settings}}…`
stay editable. Imported sites are `managed_by = 'clp'`; the first change made here flips them to `rhc` — **after that, do not
touch the site in CloudPanel** (it would overwrite the vhost / pool from its stale copy). The active certificate is whatever is
in `/etc/nginx/ssl-certificates/<domain>.crt` (all current sites: Cloudflare Origin CA, valid to 2040+).

Per-site tabs: Settings (root dir, site-user password + authorized_keys, PHP version/limits or Node version/port), Vhost
(template editor — save runs `nginx -t`, reloads, restores the previous file on failure; backups in
`/var/lib/rhc-srv-mon/vhost-bak/`), SSL/TLS (stored certificates, upload PEM, self-signed, activate), Security (basic auth,
blocked IPs/bots, Cloudflare-only → `{{settings}}`), SSH/FTP (SSH users: own uid, site group, symlinked htdocs/logs/backups),
File Manager (`bin/fileop.js` runs **as the site user**, so the kernel enforces what can be read/written; uploads/downloads
stream through it), Cron Jobs (`/etc/cron.d/<siteUser>`), Logs (tail with filter/follow). Databases and New Site/Delete come
with the next slices. `scripts/ui-smoke.js` drives every tab and sub-tab against a dev instance with a DOM stub.

## Settings tab

General (panel domain, IP, timezone, event retention, ACME e-mail), **Telegram** and **Slack** notifications (every alert —
update results, backups, cleanup, login attempts, "updates available" — fans out through `lib/notify.js` `send(text, kind)` to
each enabled channel; the Telegram block was migrated out of `updates.json` into the kv table), **Cloudflare** API token
(verified on save, stored encrypted; the Domains card shows every site's DNS record / proxy state per zone; DNS management and
origin certificates are next), and the **Cleanup** card that used to sit on the Modules tab.

## Remote desktops (VNC) and SSH sessions

An SSH host entry can open either a **terminal** or a **VNC viewer** (`protocol` on the host record).
The viewer is noVNC in a pane next to the terminals; the byte stream goes through `/ws/vnc`, a WebSocket↔RFB
bridge (`lib/vnc.js`) that reaches the server either directly or — the default — with `ssh -W` over the host's
existing SSH credentials, so a VNC server bound to localhost needs nothing exposed. The target is probed before
the viewer opens, so a wrong port or a stopped server is reported with its reason.

**🖵 Deploy VNC** (in a host's edit dialog) installs a VNC server on that host over SSH: tigervnc via apt/dnf/yum,
optionally XFCE, a password file generated locally (`lib/vnc-passwd.js` — Debian ships no `vncpasswd`), and one
predictable `rhc-vnc@:N` systemd unit (`resources/deploy-vnc.sh`) listening on loopback only. On success the host
entry is switched to VNC with the password stored, so it opens with a click.

**RDP** has no pure-JS client and Debian ships no `guacd`, so each RDP viewer gets a throwaway X display on
*this* server: `Xvnc` on a free loopback port (`:60`–`:99`, random per-session password) with `xfreerdp3` drawing
into it (`lib/rdp.js`), streamed to the browser through the same bridge. The display is torn down when the tab
closes or either process exits; a failed connection keeps its log, so the viewer can say
`ERRCONNECT_CONNECT_TRANSPORT_FAILED` instead of showing a blank screen. Needs `tigervnc-standalone-server` and
`freerdp3-x11` on the panel host — `GET /api/ssh/rdp` reports whether they are installed.

**👥 Sessions** lists this panel's open terminals (closable) and, per host, who is logged in over SSH right now —
from logind, falling back to `who`/`ss` — with **Disconnect** per login and **Disconnect all other sessions**, which
the server resolves itself so the panel's own logins (its probe and open terminals) are always spared. Disconnecting has two modes, because a login's session scope holds everything it started — on a box where
nobody enabled lingering, that includes pm2 daemons and the sites they run. **Disconnect** hangs up the login only
and leaves those running; **Kill** terminates the whole session scope. The list shows, per session, whether the
login is still live and which services its scope holds, and the bulk action only ever hangs up live logins.
Killing escalates
(`resources/disconnect-sessions.sh`): `loginctl terminate-session`, then `kill-session --signal=KILL --kill-whom=all`,
then stopping the session scope — the only way to clear a login whose leader is already dead while a child keeps the
logind session in state `closing` for ever. A session only
counts as gone when it has left `loginctl list-sessions` and its leader pid is dead. Only a pid present in the current
listing is ever signalled.

## Events tab

Every user action and scheduler run is written to the `events` table (`lib/events.js` → `emit(type, {…})`): logins and
failures, update runs, module updates / auto-update / cleanup, backups, pm2 start/stop/restart, SSH host changes and
remote installs, settings saves. The tab filters by type group, level, user, site and free text, expands the JSON details
of a row, and pages backwards. Retention defaults to 90 days (`PUT /api/events/settings {retentionDays}`); pruning runs daily.

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
