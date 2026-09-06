# rhc-srv-mon

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
