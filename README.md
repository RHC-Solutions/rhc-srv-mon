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
