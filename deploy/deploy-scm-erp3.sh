#!/usr/bin/env bash
# Deploy scm_erp3 on 10.2.1.143 (port 8023 -> backend 7012). Run ON THE SERVER:
#   ./deploy/deploy-scm-erp3.sh          interactive (asks before applying migrations)
#   ./deploy/deploy-scm-erp3.sh -y       no prompts
#   ./deploy/deploy-scm-erp3.sh --force  rebuild everything even if the pull brought nothing new
set -euo pipefail

APP=/home/user/scm-erp3
CONTAINER=scm_erp3_backend
COMPOSE="docker compose -f docker-compose.yml"   # NOT compose.yaml (the repo's own stack)
BACKUP_DIR=$HOME/backups
KEEP_TWEAKS="backend/Dockerfile backend/requirements.txt"   # server-only edits

YES=0; FORCE=0
for a in "$@"; do
  case "$a" in -y|--yes) YES=1 ;; --force) FORCE=1 ;; *) echo "unknown option: $a"; exit 2 ;; esac
done

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mXX %s\033[0m\n' "$*"; exit 1; }
ask()  { [ "$YES" = 1 ] && return 0; read -r -p "$1 [y/N] " r; [ "$r" = y ] || [ "$r" = Y ]; }

cd "$APP"

# ---------------------------------------------------------------- 0. preflight
say "0. Preflight"
[ "$(git branch --show-current)" = development ] || die "not on branch development"
OTHER=$(git status --porcelain --untracked-files=no | awk '{print $2}' | grep -vxF -f <(echo $KEEP_TWEAKS | tr ' ' '\n') || true)
[ -z "$OTHER" ] || die "unexpected local changes (only $KEEP_TWEAKS allowed):
$OTHER"
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || warn "$CONTAINER is not running right now"

# ------------------------------------------------------------------ 1. backup
say "1. Database backup"
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
CNF=$(mktemp); INFO=$(mktemp); chmod 600 "$CNF"
trap 'rm -f "$CNF" "$INFO"' EXIT
python3 - "$CNF" > "$INFO" <<'PY'
import sys
from urllib.parse import urlparse, unquote
BS = chr(92); Q = chr(34)
for l in open('backend/.env'):
    if l.startswith('DATABASE_URL='):
        u = urlparse(l.split('=', 1)[1].strip().strip(Q + "'"))
        h = u.hostname
        if h == 'host.docker.internal':
            h = '127.0.0.1'
        pw = unquote(u.password).replace(BS, BS + BS).replace(Q, BS + Q)
        open(sys.argv[1], 'w').write(
            '[client]\nuser=%s\npassword=%s%s%s\nhost=%s\nport=%s\n'
            % (unquote(u.username), Q, pw, Q, h, u.port or 3306))
        print(u.path.lstrip('/'))
PY
read -r DB < "$INFO"
[ -n "$DB" ] || die "could not read DATABASE_URL from backend/.env"
OUT="$BACKUP_DIR/${DB}_pre-deploy_$(date +%Y%m%d_%H%M%S).sql.gz"
mysqldump --defaults-extra-file="$CNF" --single-transaction --routines --triggers \
          --events --no-tablespaces "$DB" | gzip > "$OUT"
gzip -t "$OUT" || die "backup failed verification: $OUT"
TABLES=$(zcat "$OUT" | grep -c '^CREATE TABLE')
[ "$TABLES" -gt 0 ] || die "backup has no tables: $OUT"
echo "backup OK: $OUT ($(du -h "$OUT" | cut -f1), $TABLES tables)"

# -------------------------------------------------------------------- 2. pull
say "2. Pull origin/development"
OLD=$(git rev-parse HEAD)
STASHED=0
if ! git diff --quiet -- $KEEP_TWEAKS; then
  git stash push -m "deploy-tweaks-$(date +%F)" -- $KEEP_TWEAKS >/dev/null
  STASHED=1
fi
if ! git pull --ff-only origin development; then
  [ "$STASHED" = 1 ] && git stash pop
  die "pull failed (not a fast-forward?); local tweaks restored"
fi
if [ "$STASHED" = 1 ]; then
  git stash pop || die "stash pop conflicted - resolve by hand, then rerun (nothing deployed yet)"
fi
NEW=$(git rev-parse HEAD)
git log -1 --format='now at %h %s (%cd)' --date=short
if [ "$OLD" = "$NEW" ] && [ "$FORCE" = 0 ]; then
  echo "Nothing new was pulled. Use --force to rebuild anyway."; exit 0
fi

# Sanity: the server Dockerfile must keep a real HEALTHCHECK (a past edit clobbered it)
grep -A2 '^HEALTHCHECK' backend/Dockerfile | grep -q 'urlopen' \
  || die "backend/Dockerfile HEALTHCHECK looks wrong - fix before deploying"

# ---------------------------------------------------------------- 3. what changed
say "3. What changed ($(git rev-parse --short "$OLD")..$(git rev-parse --short "$NEW"))"
changed() { ! git diff --quiet "$OLD" "$NEW" -- "$@"; }
echo "new migrations:"; git diff --name-status "$OLD" "$NEW" -- backend/alembic/versions | sed 's/^/  /' || true
echo "requirements.txt diff:"; git diff "$OLD" "$NEW" -- backend/requirements.txt | grep '^[+-][^+-]' | sed 's/^/  /' || true
changed backend/.env.example && warn "backend/.env.example changed - check backend/.env has the new keys"
changed frontend/package.json frontend/package-lock.json && echo "frontend dependencies changed (npm ci must succeed)"
git diff --name-only "$OLD" "$NEW" -- backend/scripts | sed 's/^/  script changed: /' || true
echo "(data scripts are NEVER run here - preview them by hand first)"

BACKEND_CHANGED=0; FRONTEND_CHANGED=0
{ changed backend || [ "$FORCE" = 1 ]; } && BACKEND_CHANGED=1
{ changed frontend || [ "$FORCE" = 1 ]; } && FRONTEND_CHANGED=1

# ---------------------------------------------------------------- 4. backend
if [ "$BACKEND_CHANGED" = 1 ]; then
  say "4. Rebuild and restart backend"
  $COMPOSE up -d --build backend
  echo -n "waiting for healthy"
  for i in $(seq 1 40); do
    s=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo none)
    [ "$s" = healthy ] && break
    echo -n "."; sleep 3
  done
  echo " $s"
  [ "$s" = healthy ] || { docker logs --tail 40 "$CONTAINER"; die "backend did not become healthy"; }

  say "5. Migrations (scripts.bootstrap: alembic upgrade heads + missing columns + admin top-up)"
  if ask "Apply migrations to $DB now?"; then
    docker exec "$CONTAINER" sh -c "cd /app && python -m scripts.bootstrap"
    CUR=$(docker exec "$CONTAINER" sh -c "cd /app && python -m alembic current 2>&1 | tail -1")
    echo "alembic current: $CUR"
    echo "$CUR" | grep -q '(head)' || die "database is NOT at head after bootstrap"
  else
    warn "skipped migrations - the new code is running on the OLD schema until you run bootstrap"
  fi
else
  say "4/5. Backend unchanged - skipping rebuild and migrations"
fi

# --------------------------------------------------------------- 6. frontend
if [ "$FRONTEND_CHANGED" = 1 ]; then
  say "6. Rebuild frontend"
  cd "$APP/frontend"
  [ -d dist ] && cp -a dist "dist.backup-$(date +%Y%m%d-%H%M%S)"
  npm ci --no-audit --no-fund       # set -e: a failed install stops here
  npm run build
  cd "$APP"
  # keep only the 3 newest dist backups
  ls -dt frontend/dist.backup-* 2>/dev/null | tail -n +4 | xargs -r rm -rf
else
  say "6. Frontend unchanged - skipping build"
fi

# ----------------------------------------------------------------- 7. verify
say "7. Verify"
curl -s -m 8 -o /dev/null -w "backend ready : HTTP %{http_code}\n" http://127.0.0.1:7012/health/ready
curl -s -m 8 -o /dev/null -w "frontend 8023 : HTTP %{http_code}\n" http://127.0.0.1:8023/
echo "recent backend errors (last 10 min):"
docker logs --since 10m "$CONTAINER" 2>&1 | grep -iE 'error|1054|1146|traceback' | tail -5 || true
echo
echo "DONE. Hard-refresh the browser (Ctrl+Shift+R)."
echo "Rollback DB : zcat $OUT | mysql -u <dbuser> -p $DB"
