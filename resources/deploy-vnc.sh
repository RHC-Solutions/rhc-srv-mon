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
have(){ command -v "$1" >/dev/null 2>&1; }
PORT=$((5900+DISPLAY_NUM))
id "$VNC_USER" >/dev/null 2>&1 || { log "no such user on the target: $VNC_USER"; exit 3; }
HOME_DIR=$(getent passwd "$VNC_USER" | cut -d: -f6)
[ -n "$HOME_DIR" ] || { log "user $VNC_USER has no home directory"; exit 3; }

# Identify the target before touching it, so a failure names the distro it happened on.
OS_ID=""; OS_VER=""; OS_NAME="unknown"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-}"; OS_VER="${VERSION_ID:-}"; OS_NAME="${PRETTY_NAME:-$OS_ID $OS_VER}"
fi
log "target: $OS_NAME · display :$DISPLAY_NUM (port $PORT) for $VNC_USER, home $HOME_DIR"

# The unit is systemd — say so plainly rather than failing later with something cryptic.
have systemctl || { log "this target has no systemd (systemctl not found); the deploy installs a systemd unit and cannot continue"; exit 2; }
[ -d /run/systemd/system ] || log "WARN: systemd does not look like the running init - the unit may not start"

# ---- one package-manager abstraction, so every distro gets the same prerequisites ----
PM=""
for c in apt-get dnf yum zypper pacman; do if have "$c"; then PM="$c"; break; fi; done
[ -n "$PM" ] || { log "no supported package manager (apt-get/dnf/yum/zypper/pacman) - install a VNC server manually"; exit 2; }
log "package manager: $PM"
PM_UPDATED=0
pm_refresh(){
  [ "$PM_UPDATED" = 1 ] && return 0
  PM_UPDATED=1
  case "$PM" in
    apt-get) DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || log "WARN: apt-get update failed; continuing with the cached index" ;;
    zypper)  zypper --non-interactive refresh >/dev/null 2>&1 || log "WARN: zypper refresh failed" ;;
    pacman)  pacman -Sy --noconfirm >/dev/null 2>&1 || log "WARN: pacman -Sy failed" ;;
  esac
}
# Install packages, tolerating names that do not exist on this distro (they are listed per-family
# below, but minor versions move things around). Returns non-zero only if nothing could be installed.
pm_install(){
  [ $# -gt 0 ] || return 0
  pm_refresh
  case "$PM" in
    apt-get) DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@" >/dev/null 2>&1 ;;
    dnf)     dnf install -y -q --setopt=install_weak_deps=False "$@" >/dev/null 2>&1 ;;
    yum)     yum install -y -q "$@" >/dev/null 2>&1 ;;
    zypper)  zypper --non-interactive install -y --no-recommends "$@" >/dev/null 2>&1 ;;
    pacman)  pacman -S --noconfirm --needed "$@" >/dev/null 2>&1 ;;
  esac
}
# Same, one package at a time, so one bad name does not sink the whole set.
pm_install_each(){
  for p in "$@"; do pm_install "$p" || log "WARN: could not install $p (not available on $OS_NAME?)"; done
}
is_rhel(){ case "$PM" in dnf|yum) return 0 ;; *) return 1 ;; esac; }

# ---- 1. prerequisites ----
# Xvnc will not start without fonts ("could not open default font 'fixed'") and X sessions expect
# xauth; neither is guaranteed by the VNC package on any of these distros. xterm is the fallback
# session when no desktop is installed, so without it a DESKTOP=none deploy shows a blank screen.
if have Xvnc || have Xtigervnc; then
  log "VNC server already installed"
else
  log "installing a VNC server with $PM..."
  case "$PM" in
    apt-get) pm_install tigervnc-standalone-server tigervnc-common || { log "apt install of tigervnc failed"; exit 2; } ;;
    dnf|yum) pm_install tigervnc-server || { log "$PM install of tigervnc-server failed"; exit 2; } ;;
    zypper)  pm_install tigervnc xorg-x11-Xvnc || { log "zypper install of tigervnc failed"; exit 2; } ;;
    pacman)  pm_install tigervnc || { log "pacman install of tigervnc failed"; exit 2; } ;;
  esac
fi
XVNC=$(command -v Xvnc || command -v Xtigervnc)
[ -n "$XVNC" ] || { log "no Xvnc binary after install"; exit 2; }
log "Xvnc: $XVNC"

log "installing prerequisites (fonts, xauth, xterm)..."
case "$PM" in
  apt-get) pm_install_each xfonts-base xauth xterm dbus-x11 ;;
  dnf|yum) pm_install_each xorg-x11-fonts-misc xorg-x11-xauth xterm dbus-daemon ;;
  zypper)  pm_install_each xorg-x11-fonts-core xauth xterm dbus-1-x11 ;;
  pacman)  pm_install_each xorg-fonts-misc xorg-xauth xterm dbus ;;
esac
have xauth || log "WARN: no xauth on the target; the X session may refuse to start"

# ---- 2. desktop (optional) ----
if [ "$DESKTOP" != none ] && ! have startxfce4; then
  log "installing xfce - this can take several minutes..."
  case "$PM" in
    apt-get) pm_install xfce4 xfce4-terminal dbus-x11 || log "WARN: xfce install failed, falling back to a bare session" ;;
    dnf|yum)
      # On RHEL rebuilds the xfce group's packages come from EPEL. `group info` can list the group
      # from base metadata and still fail to install it, so try first and add EPEL only if needed.
      if ! pm_install "@xfce-desktop" && ! pm_install "@Xfce"; then
        log "xfce group not installable; enabling EPEL and retrying..."
        if pm_install epel-release; then
          PM_UPDATED=0
          pm_install "@xfce-desktop" || pm_install "@Xfce" || log "WARN: xfce install failed even with EPEL, falling back to a bare session"
        else
          log "WARN: could not enable EPEL, falling back to a bare session"
        fi
      fi ;;
    zypper)  pm_install xfce4-session xfce4-panel xfdesktop || log "WARN: xfce install failed" ;;
    pacman)  pm_install xfce4 || log "WARN: xfce install failed" ;;
  esac
fi
if ! have xterm && ! have startxfce4; then log "WARN: neither xfce nor xterm is installed - the display will come up empty"; fi

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
if ! have ss && ! have netstat; then
  log "no ss/netstat to verify the port with; installing iproute..."
  case "$PM" in apt-get) pm_install iproute2 ;; dnf|yum) pm_install iproute ;; zypper) pm_install iproute2 ;; pacman) pm_install iproute2 ;; esac
fi
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
