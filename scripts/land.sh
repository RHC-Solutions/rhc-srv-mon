#!/usr/bin/env bash
# Land the v2 branch into the live checkout and restart the panel. Safe from any cwd; serialised
# against the auto-commit cron via /var/lock/rhc-autocommit.
set -euo pipefail
LIVE=/opt/sb-srv-mon
exec 9>/var/lock/rhc-autocommit
flock -w 120 9
cd "$LIVE"
if ! git diff --quiet || ! git diff --cached --quiet; then echo "live checkout has uncommitted changes:"; git status --short; exit 1; fi
before=$(git rev-parse --short HEAD)
git merge --ff-only v2
after=$(git rev-parse --short HEAD)
if [ "$before" = "$after" ]; then echo "nothing to land (main already at $after)"; exit 0; fi
node --check server.js
pm2 restart sb-srv-mon --update-env >/dev/null
sleep 3
pm2 describe sb-srv-mon | grep -E "status|restarts" | sed 's/│//g;s/  */ /g'
echo "landed $before → $after"
