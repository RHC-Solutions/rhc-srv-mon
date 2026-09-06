# Disconnect ssh logins. Each argument is "<logind-session-id-or-dash>:<leader-pid>".
# Hanging up sshd is not enough on its own: when a child outlives the login (an editor server, a
# stray daemon) logind keeps the session in state "closing" for ever, and a session whose leader is
# already dead cannot be signalled at all. So this escalates and only reports GONE when the session
# is out of `loginctl list-sessions` and the leader pid is dead.
set -u
has_loginctl(){ command -v loginctl >/dev/null 2>&1; }
listed(){ [ "$1" != "-" ] && has_loginctl && loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}' | grep -qx "$1"; }
alive(){ sid="$1"; pid="$2"; if kill -0 "$pid" 2>/dev/null; then return 0; fi; if listed "$sid"; then return 0; fi; return 1; }

# 1. ask nicely
for spec in "$@"; do
  sid="${spec%%:*}"; pid="${spec##*:}"
  [ "$sid" != "-" ] && has_loginctl && loginctl terminate-session "$sid" >/dev/null 2>&1
  kill -HUP "$pid" 2>/dev/null
done
sleep 2

# 2. anything still there gets SIGKILL, session scope included
for spec in "$@"; do
  sid="${spec%%:*}"; pid="${spec##*:}"
  if alive "$sid" "$pid"; then
    [ "$sid" != "-" ] && has_loginctl && loginctl kill-session --signal=KILL --kill-whom=all "$sid" >/dev/null 2>&1
    kill -KILL "$pid" 2>/dev/null
  fi
done
sleep 2

# 3. last resort: stop the session scope itself
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
