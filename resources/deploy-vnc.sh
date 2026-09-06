set -u
# Deploy a VNC server, invoked by rhc-srv-mon over SSH with:
#   DISPLAY_NUM  display number (1 => port 5901)
#   VNC_USER     unix user the desktop runs as
#   GEOMETRY     e.g. 1280x800
#   DESKTOP      xfce | none
#   PASSWD_B64   base64 of the 8-byte VNC password file
# It always installs one predictable systemd unit (rhc-vnc@:N) rather than the distro's own wrapper,
# because Debian and RHEL disagree about config format, password path and session selection.
log(){ echo "[remote] $*"; }
PORT=$((5900+DISPLAY_NUM))
id "$VNC_USER" >/dev/null 2>&1 || { log "no such user on the target: $VNC_USER"; exit 3; }
HOME_DIR=$(getent passwd "$VNC_USER" | cut -d: -f6)
[ -n "$HOME_DIR" ] || { log "user $VNC_USER has no home directory"; exit 3; }
log "display :$DISPLAY_NUM (port $PORT) for $VNC_USER, home $HOME_DIR"

# 1. the VNC server
if command -v Xvnc >/dev/null 2>&1 || command -v Xtigervnc >/dev/null 2>&1; then
  log "VNC server already installed"
elif command -v apt-get >/dev/null 2>&1; then
  log "installing tigervnc with apt..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y -qq --no-install-recommends tigervnc-standalone-server tigervnc-common >/dev/null 2>&1 || { log "apt install failed"; exit 2; }
elif command -v dnf >/dev/null 2>&1; then
  log "installing tigervnc with dnf..."
  dnf install -y -q tigervnc-server >/dev/null 2>&1 || { log "dnf install failed"; exit 2; }
elif command -v yum >/dev/null 2>&1; then
  yum install -y -q tigervnc-server >/dev/null 2>&1 || { log "yum install failed"; exit 2; }
else
  log "no apt/dnf/yum on the target - install a VNC server manually"; exit 2
fi
XVNC=$(command -v Xvnc || command -v Xtigervnc)
[ -n "$XVNC" ] || { log "no Xvnc binary after install"; exit 2; }

# 2. desktop (optional)
if [ "$DESKTOP" != none ] && ! command -v startxfce4 >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    log "installing xfce - this can take several minutes..."
    apt-get install -y -qq --no-install-recommends xfce4 xfce4-terminal dbus-x11 >/dev/null 2>&1 || log "WARN: xfce install failed, falling back to a bare session"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q @xfce-desktop >/dev/null 2>&1 || log "WARN: xfce install failed"
  fi
fi
if ! command -v xterm >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
  apt-get install -y -qq --no-install-recommends xterm >/dev/null 2>&1 || true
fi

# 3. password (classic path + the one Debian's tigervnc reads) and session script
install -d -m 700 -o "$VNC_USER" "$HOME_DIR/.vnc"
install -d -m 700 -o "$VNC_USER" "$HOME_DIR/.config/tigervnc" 2>/dev/null || true
printf '%s' "$PASSWD_B64" | base64 -d > "$HOME_DIR/.vnc/passwd" || { log "could not write the password file"; exit 4; }
chmod 600 "$HOME_DIR/.vnc/passwd"; chown "$VNC_USER" "$HOME_DIR/.vnc/passwd"
if cp -f "$HOME_DIR/.vnc/passwd" "$HOME_DIR/.config/tigervnc/passwd" 2>/dev/null; then
  chmod 600 "$HOME_DIR/.config/tigervnc/passwd"; chown "$VNC_USER" "$HOME_DIR/.config/tigervnc/passwd"
fi
cat > "$HOME_DIR/.vnc/rhc-xstartup" <<'XEOF'
#!/bin/sh
# session started inside the VNC display by rhc-srv-mon
unset SESSION_MANAGER DBUS_SESSION_BUS_ADDRESS
if command -v startxfce4 >/dev/null 2>&1; then
  if command -v dbus-run-session >/dev/null 2>&1; then exec dbus-run-session -- startxfce4; fi
  exec startxfce4
fi
if command -v xterm >/dev/null 2>&1; then exec xterm -geometry 100x30+40+40; fi
exec sleep infinity
XEOF
chmod 755 "$HOME_DIR/.vnc/rhc-xstartup"; chown "$VNC_USER" "$HOME_DIR/.vnc/rhc-xstartup"
log "wrote the password file and $HOME_DIR/.vnc/rhc-xstartup"

# 4. one predictable unit
cat > /usr/local/bin/rhc-vnc-run <<'REOF'
#!/bin/sh
# rhc-srv-mon VNC runner: Xvnc bound to loopback + the user's session script
set -u
DISP="$1"; N="${DISP#:}"; PORT=$((5900+N))
: "${GEOMETRY:=1280x800}"
XVNC=$(command -v Xvnc || command -v Xtigervnc)
export DISPLAY="$DISP"
"$XVNC" "$DISP" -rfbport "$PORT" -rfbauth "$HOME/.vnc/passwd" -localhost -geometry "$GEOMETRY" -depth 24 -SecurityTypes VncAuth -AlwaysShared &
XPID=$!
sleep 2
if [ -x "$HOME/.vnc/rhc-xstartup" ]; then "$HOME/.vnc/rhc-xstartup" >> "$HOME/.vnc/rhc-session.log" 2>&1 & fi
wait $XPID
REOF
chmod 755 /usr/local/bin/rhc-vnc-run
cat > /etc/systemd/system/rhc-vnc@.service <<UEOF
[Unit]
Description=VNC server %i (deployed by rhc-srv-mon)
After=network.target

[Service]
Type=simple
User=$VNC_USER
Environment=HOME=$HOME_DIR
Environment=GEOMETRY=$GEOMETRY
ExecStart=/usr/local/bin/rhc-vnc-run %i
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UEOF
INSTANCE="rhc-vnc@:$DISPLAY_NUM.service"
log "wrote /etc/systemd/system/rhc-vnc@.service and /usr/local/bin/rhc-vnc-run"

# a distro unit on the same display would fight ours for the port
for u in tigervncserver vncserver; do systemctl disable --now "$u@:$DISPLAY_NUM.service" >/dev/null 2>&1 || true; done
rm -f "/tmp/.X$DISPLAY_NUM-lock" "/tmp/.X11-unix/X$DISPLAY_NUM" 2>/dev/null || true

systemctl daemon-reload
systemctl enable "$INSTANCE" >/dev/null 2>&1 || log "WARN: could not enable $INSTANCE"
systemctl restart "$INSTANCE" || { log "failed to start $INSTANCE"; systemctl status "$INSTANCE" --no-pager -l 2>&1 | tail -15; exit 5; }
i=0
while [ $i -lt 15 ]; do
  if command -v ss >/dev/null 2>&1 && ss -tln 2>/dev/null | grep -q ":$PORT "; then
    log "listening on 127.0.0.1:$PORT"; echo "RHC_VNC_OK $PORT $INSTANCE"; exit 0
  fi
  if command -v netstat >/dev/null 2>&1 && netstat -tln 2>/dev/null | grep -q ":$PORT "; then
    log "listening on 127.0.0.1:$PORT"; echo "RHC_VNC_OK $PORT $INSTANCE"; exit 0
  fi
  i=$((i+1)); sleep 1
done
log "the service started but nothing is listening on $PORT after 15s"
systemctl status "$INSTANCE" --no-pager -l 2>&1 | tail -15
tail -20 "$HOME_DIR/.vnc/rhc-session.log" 2>/dev/null
exit 6
