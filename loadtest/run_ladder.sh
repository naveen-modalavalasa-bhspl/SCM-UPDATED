#!/bin/sh
# Ramp one server configuration through a ladder of concurrency levels.
#
# Separate runs per level rather than one shaped run: Locust aggregates a shaped run's
# statistics across every stage, so the p95 at 100 users and the p95 at 1,000 come back
# as one number and the knee — the only thing worth finding — is averaged away.
#
# Each level pays its own sign-in storm at spawn. That is deliberate and it is why the
# spawn rate is held down: 500 simultaneous bcrypts is a different test (SignInRush),
# and letting it land inside the working profile would report the login queue as the
# steady-state latency of the whole application.
#
# Usage: sh loadtest/run_ladder.sh <label> <host> "<levels>"
#   sh loadtest/run_ladder.sh before http://127.0.0.1:8900 "50 200 500"
set -eu

LABEL="$1"
HOST="$2"
LEVELS="${3:-50 200 500 1000}"
DURATION="${DURATION:-120s}"
SPAWN="${SPAWN:-25}"

OUT="loadtest/results/${LABEL}"
mkdir -p "$OUT"

for users in $LEVELS; do
  echo "=== ${LABEL}: ${users} users for ${DURATION} ==="
  backend/.venv/Scripts/locust \
    -f loadtest/locustfile.py \
    --headless \
    --host "$HOST" \
    --users "$users" \
    --spawn-rate "$SPAWN" \
    --run-time "$DURATION" \
    --csv "${OUT}/u${users}" \
    --only-summary \
    --loglevel WARNING \
    || echo "  (locust exited non-zero -- failure ratio threshold or crash)"
  # Let the pool drain and TIME_WAIT sockets clear before the next level, so one
  # level's backlog is not measured as the next level's latency.
  sleep 10
done
echo "=== ${LABEL} done -> ${OUT} ==="
