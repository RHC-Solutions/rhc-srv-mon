#!/bin/bash
# Managed by sb-srv-mon (resources/rhc-autocommit.sh → /usr/local/sbin/rhc-autocommit, installed by the
# panel at start). Every 15 min (rhc-autocommit.timer): commit the panel's own changes and keep EVERY
# GitHub remote of /opt/sb-srv-mon identical — roman-synergybeam/sbsrvman and RHC-Solutions/rhc-srv-mon
# must always hold the same main.
#
#   1. commit local changes ("auto: <host> <time> UTC")
#   2. fetch every remote; commits a remote has that this server does not (pushed from another server)
#      are merged in — only when the merge is clean and every changed .js file passes `node --check`;
#      otherwise the merge is undone, NOTHING is pushed anywhere (the remotes stay as they are) and it is
#      logged for a deliberate fix
#   3. push the same HEAD to every remote, so they all end up on one commit
# Serialised with panel landings/self-updates via /var/lock/rhc-autocommit. Secrets stay out through .gitignore.
set -uo pipefail
D=/opt/sb-srv-mon
exec 9>/var/lock/rhc-autocommit
flock -w 300 9 || { echo "lock busy — skipped"; exit 0; }
cd "$D" || exit 1
[ -d .git ] || exit 0
export GIT_TERMINAL_PROMPT=0
rc=0
REMOTES=$(git remote)
[ -n "$REMOTES" ] || { echo "no remotes"; exit 0; }

# 1. local changes
if [ -n "$(git status --porcelain)" ]; then
  git add -A && git commit -q -m "auto: $(hostname) $(date -u +'%Y-%m-%d %H:%M') UTC" && echo "committed local changes"
fi
branch=$(git branch --show-current)
[ "$branch" = "main" ] || { echo "checkout is on '$branch', not main — not syncing"; exit 1; }

# 2. bring in what any remote has that we do not
fetched=""
for r in $REMOTES; do
  if git fetch -q "$r" 2>/tmp/rhc-autocommit.err; then fetched="$fetched $r"
  else echo "fetch $r FAILED: $(tail -1 /tmp/rhc-autocommit.err)"; rc=1; fi
done
for r in $fetched; do
  git rev-parse -q --verify "$r/main" >/dev/null || continue
  behind=$(git rev-list --count "HEAD..$r/main")
  [ "$behind" -gt 0 ] || continue
  before=$(git rev-parse HEAD)
  if ! git merge -q --no-edit -m "auto: merge $r/main on $(hostname) $(date -u +'%Y-%m-%d %H:%M') UTC" "$r/main" >/tmp/rhc-autocommit.err 2>&1; then
    git merge --abort 2>/dev/null; git reset -q --keep "$before" 2>/dev/null
    echo "MERGE CONFLICT with $r/main ($behind commit(s)) — nothing pushed anywhere; merge by hand: $(tail -1 /tmp/rhc-autocommit.err)"
    exit 1
  fi
  bad=""
  for f in $(git diff --name-only --diff-filter=AM "$before" HEAD -- '*.js'); do
    [ -f "$f" ] && ! node --check "$f" 2>/dev/null && bad="$bad $f"
  done
  if [ -n "$bad" ]; then
    git reset -q --keep "$before"
    echo "merging $r/main breaks:$bad — undone, nothing pushed anywhere; fix by hand"
    exit 1
  fi
  echo "merged $behind commit(s) from $r/main"
done

# 3. every remote on the same HEAD
head=$(git rev-parse HEAD)
for r in $fetched; do
  if [ "$(git rev-parse -q --verify "$r/main" 2>/dev/null)" = "$head" ]; then echo "in sync with $r ($(git rev-parse --short HEAD))"; continue; fi
  if git push -q "$r" HEAD:main 2>/tmp/rhc-autocommit.err; then echo "pushed $(git rev-parse --short HEAD) to $r"
  else echo "push to $r FAILED: $(tail -1 /tmp/rhc-autocommit.err)"; rc=1; fi
done
exit $rc
