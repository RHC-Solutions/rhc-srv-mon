#!/usr/bin/env bash
# Land a work branch (default: dev) into the live checkout and restart the panel. Safe from any cwd;
# serialised against the auto-commit via /var/lock/rhc-autocommit.
#   scripts/land.sh [branch]
# The live checkout is the repo's main worktree and the pm2 app is the one running its server.js, so
# this works whatever the server calls them (web01: /opt/rhc-srv-mon + rhc-srv-mon; older: sb-srv-mon).
set -euo pipefail
BRANCH=${1:-dev}
LIVE=$(git -C "$(dirname "$0")" worktree list --porcelain | awk '/^worktree /{print $2; exit}')
[ -n "$LIVE" ] && [ -f "$LIVE/server.js" ] || { echo "cannot find the live checkout"; exit 1; }
NAME=$(pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s).find(x=>x.pm2_env&&x.pm2_env.pm_exec_path===process.argv[1]);if(p)console.log(p.name)}catch(_){}})' "$LIVE/server.js")
[ -n "$NAME" ] || { echo "no pm2 app runs $LIVE/server.js"; exit 1; }
exec 9>/var/lock/rhc-autocommit
flock -w 120 9
cd "$LIVE"
if ! git diff --quiet || ! git diff --cached --quiet; then echo "live checkout has uncommitted changes:"; git status --short; exit 1; fi
before=$(git rev-parse --short HEAD)
git merge --ff-only "$BRANCH"
after=$(git rev-parse --short HEAD)
if [ "$before" = "$after" ]; then echo "nothing to land (main already at $after)"; exit 0; fi
node --check server.js
pm2 restart "$NAME" --update-env >/dev/null
sleep 3
pm2 describe "$NAME" | grep -E "status|restarts" | sed 's/│//g;s/  */ /g'
echo "landed $BRANCH: $before → $after ($NAME)"
