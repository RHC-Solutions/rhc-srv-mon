# Disconnect ssh logins. Arguments: "<logind-session-id-or-dash>:<leader-pid>".
# MODE=hangup (default) ends the login only: its sshd process is signalled and anything the user
#   left running (pm2 daemons, screen/tmux, build jobs) keeps running.
# MODE=kill also terminates the logind session scope, which stops those processes too. That is the
#   only way to clear a login whose leader is already dead but whose children hold the session open.
set -u
: "${MODE:=hangup}"
has_loginctl(){ command -v loginctl >/dev/null 2>&1; }
listed(){ [ "$1" != "-" ] && has_loginctl && loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}' | grep -qx "$1"; }

if [ "$MODE" = hangup ]; then
  # 1. hang up the login itself; leave the rest of the session alone
  for spec in "$@"; do
    pid="${spec##*:}"
    kill -HUP "$pid" 2>/dev/null
  done
  sleep 2
  for spec in "$@"; do
    pid="${spec##*:}"
    kill -0 "$pid" 2>/dev/null && kill -TERM "$pid" 2>/dev/null
  done
  sleep 1
  for spec in "$@"; do
    pid="${spec##*:}"
    if kill -0 "$pid" 2>/dev/null; then echo "ALIVE $pid"; else echo "GONE $pid"; fi
  done
  exit 0
fi

alive(){ sid="$1"; pid="$2"; if kill -0 "$pid" 2>/dev/null; then return 0; fi; if listed "$sid"; then return 0; fi; return 1; }

# MODE=kill: ask nicely, then take the whole session scope
for spec in "$@"; do
  sid="${spec%%:*}"; pid="${spec##*:}"
  [ "$sid" != "-" ] && has_loginctl && loginctl terminate-session "$sid" >/dev/null 2>&1
  kill -HUP "$pid" 2>/dev/null
done
sleep 2
for spec in "$@"; do
  sid="${spec%%:*}"; pid="${spec##*:}"
  if alive "$sid" "$pid"; then
    [ "$sid" != "-" ] && has_loginctl && loginctl kill-session --signal=KILL --kill-whom=all "$sid" >/dev/null 2>&1
    kill -KILL "$pid" 2>/dev/null
  fi
done
sleep 2
for spec in "$@"; do
  sid="${spec%%:*}"; pid="${spec##*:}"
  if alive "$sid" "$pid" && [ "$sid" != "-" ] && command -v systemctl >/dev/null 2>&1; then
    systemctl stop "session-$sid.scope" >/dev/null 2>&1
  fi
done
sleep 1
for spec in "$@"; do
  sid="${spec%%:*}"; pid="${spec##*:}"
  if alive "$sid" "$pid"; then echo "ALIVE $pid"; else echo "GONE $pid"; fi
done
