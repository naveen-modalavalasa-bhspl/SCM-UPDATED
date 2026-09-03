#!/bin/sh
# Scheduled logical backup of the SCM database.
#
# There was NO backup job, no replica and no snapshot before 2026-09-03. The database
# holds stock balances, an append-only ledger, approval history and every document in
# the business, and the only copy of it lived on one container's volume. That is the
# real data-loss risk in this deployment — ahead of every permission bug — because
# every other fault is recoverable from a backup and this one is not.
#
# Runs in the `backup` compose service, which loops on BACKUP_INTERVAL_SECONDS
# (default: daily). mysqldump rather than Percona XtraBackup: the dataset is small
# enough that a logical dump restores in minutes, it needs no extra image, and it can
# be read and partially restored by hand — which is what an operator actually does at
# 2 a.m. Move to XtraBackup when a full dump stops finishing inside its window.
#
# --single-transaction gives a consistent snapshot of the InnoDB tables WITHOUT
# locking writers out for the duration, which matters because this runs against a live
# database. Everything here is InnoDB.
set -eu

: "${MYSQL_HOST:=db}"
: "${MYSQL_DATABASE:?MYSQL_DATABASE is required}"
: "${MYSQL_USER:?MYSQL_USER is required}"
: "${MYSQL_PASSWORD:?MYSQL_PASSWORD is required}"
: "${BACKUP_DIR:=/backups}"
: "${BACKUP_KEEP_DAYS:=14}"

stamp=$(date -u +%Y%m%d_%H%M%S)
target="${BACKUP_DIR}/${MYSQL_DATABASE}_${stamp}.sql.gz"
partial="${target}.partial"

mkdir -p "$BACKUP_DIR"
echo "[backup] ${stamp} starting -> ${target}"

# Written to .partial and renamed only on success: a dump interrupted half way is not
# a backup, and a directory of truncated files that LOOK like backups is worse than an
# empty one — it is discovered during a restore.
mysqldump \
  --host="$MYSQL_HOST" \
  --user="$MYSQL_USER" \
  --password="$MYSQL_PASSWORD" \
  --single-transaction \
  --quick \
  --routines \
  --triggers \
  --events \
  --set-gtid-purged=OFF \
  --default-character-set=utf8mb4 \
  "$MYSQL_DATABASE" | gzip -6 > "$partial"

mv "$partial" "$target"
size=$(wc -c < "$target")
echo "[backup] ${stamp} done, ${size} bytes"

# A zero-length or tiny dump means mysqldump failed in a way the pipe swallowed.
# Better to shout now than to find out during a restore.
if [ "$size" -lt 10000 ]; then
  echo "[backup] WARNING: ${target} is only ${size} bytes -- check credentials"
fi

find "$BACKUP_DIR" -name "${MYSQL_DATABASE}_*.sql.gz" -type f \
  -mtime "+${BACKUP_KEEP_DAYS}" -print -delete
# Anything left half-written by a killed container.
find "$BACKUP_DIR" -name '*.partial' -type f -mtime +1 -print -delete
