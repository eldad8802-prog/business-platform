#!/usr/bin/env bash
# The REAL release gate (scripts/ci/release-migrate-gate.mjs `verify`) against the joint-release lab:
# 168 applied, P3-A #1 + P3-A #2 + M6 pending (.p3a/lab.sh <db>, no mode).
#
#   G1  expected = exactly the three                   → ALLOWED
#   G2  expected = the P3-A pair only                   → REFUSED (M6 would ride along)
#   G3  expected = M6 only                              → REFUSED (the P3-A pair would ride along)
#   G4  expected = the three + a name not pending       → REFUSED (approved but not pending)
#   G5  a fourth migration merged while a run waits     → REFUSED (pending but not approved)
#   G6  expected = the three, ledger holds an unfinished row → REFUSED
#
#   .p3a/gate-proof.sh <db>     env: PGHOST, PGPORT, LAB_PASSWORD. Synthetic only. ZERO network.
set -euo pipefail
DB="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$ROOT/scripts/ci/release-migrate-gate.mjs"
URL="postgresql://lab_owner:${LAB_PASSWORD}@${PGHOST}:${PGPORT}/${DB}"
P1="20261008090000_p3a_identity_enum_values"
P2="20261008090100_p3a_trust_claims"
M6="20261009090000_m6_acquisition_connections"
LATE="20261010090000_lab_merged_while_waiting"
THREE="$P1,$P2,$M6"

# checkout <dir> [extra]: main's migration directories as a release-migrate run would see them.
checkout() {
  rm -rf "$1"; mkdir -p "$1/prisma/migrations"
  cp "$ROOT/prisma/migrations/migration_lock.toml" "$1/prisma/migrations/"
  for d in "$ROOT"/prisma/migrations/*/; do cp -r "$d" "$1/prisma/migrations/"; done
  if [ -n "${2:-}" ]; then
    mkdir -p "$1/prisma/migrations/$2"
    printf -- '-- lab: a migration merged to main while the run waited for approval\nSELECT 1;\n' > "$1/prisma/migrations/$2/migration.sql"
  fi
}
verify() {  # verify <checkout> <expected> → gate exit code; output indented
  set +e
  ( cd "$1" && DIRECT_URL="$URL" node "$GATE" verify --expected "$2" ) > /tmp/p3a-gate.out 2>&1
  local rc=$?; set -e
  sed 's/^/    | /' /tmp/p3a-gate.out
  return $rc
}
expect() {  # expect <label> <allowed|refused> <checkout> <expected>
  if verify "$3" "$4"; then got=allowed; else got=refused; fi
  [ "$got" = "$2" ] || { echo "FAIL $1: expected $2, got $got"; exit 1; }
  echo "PASS $1 → $got"
}
TMP="$(mktemp -d)"
checkout "$TMP/main"
checkout "$TMP/late" "$LATE"

expect "G1 the exact three"                  allowed "$TMP/main" "$THREE"
expect "G2 the P3-A pair only"               refused "$TMP/main" "$P1,$P2"
expect "G3 M6 only"                          refused "$TMP/main" "$M6"
expect "G4 the three + one not pending"      refused "$TMP/main" "$THREE,20261011090000_lab_not_pending"
expect "G5 a fourth merged while waiting"    refused "$TMP/late" "$THREE"
PGPASSWORD="$LAB_PASSWORD" psql -X -q -U lab_owner -d "$DB" -v ON_ERROR_STOP=1 -c \
  "INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, applied_steps_count) VALUES ('p3a-gate-proof-unfinished', repeat('0',64), '$P1', 0)"
expect "G6 an unfinished ledger row"         refused "$TMP/main" "$THREE"
PGPASSWORD="$LAB_PASSWORD" psql -X -q -U lab_owner -d "$DB" -v ON_ERROR_STOP=1 -c \
  "DELETE FROM \"_prisma_migrations\" WHERE id = 'p3a-gate-proof-unfinished'"
expect "G1 again after the lab row is gone"  allowed "$TMP/main" "$THREE"
rm -rf "$TMP"
echo "RELEASE GATE EXACT-MATCH PROOF: PASS"
