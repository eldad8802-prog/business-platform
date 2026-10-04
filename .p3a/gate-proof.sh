#!/usr/bin/env bash
# The REAL release gate (scripts/ci/release-migrate-gate.mjs `verify`, APPROVED-PREFIX semantics) against
# Production today: 168 applied, P3-A #1 + P3-A #2 + M6 pending (.p3a/lab.sh <db>, no mode).
# The Production plan (owner, Option B): the P3-A pair is released as the approved prefix; M6 stays
# pending and has its own release. The staged apply that keeps a held migration from running is proven
# by .release-gate/prefix-lab.sh.
#
#   G1  expected = the three, in order                  → ALLOWED (the exact set; nothing held)
#   G2  expected = the P3-A pair                        → ALLOWED, M6 held (the P3-A release)
#   G2b expected = the pair in the wrong order          → REFUSED
#   G3  expected = M6 only                              → REFUSED (the P3-A pair runs before it)
#   G3b expected = P3-A #1 + M6                         → REFUSED (P3-A #2 inside the run)
#   G4  expected = the three + a name not pending       → REFUSED (approved but not pending)
#   G5  a fourth migration, sorting after M6, merged    → the pair: ALLOWED, M6 + the fourth held
#   G6  expected = the pair, ledger holds an unfinished row → REFUSED
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

held() { grep -q "stays pending (not applied by this run): $1$" /tmp/p3a-gate.out || { echo "FAIL: held set is not [$1]"; exit 1; }; }
expect "G1 the three, in order (exact set)"  allowed "$TMP/main" "$THREE"
expect "G2 the P3-A pair (approved prefix)"  allowed "$TMP/main" "$P1,$P2"; held "$M6"
expect "G2b the pair in the wrong order"     refused "$TMP/main" "$P2,$P1"
expect "G3 M6 only"                          refused "$TMP/main" "$M6"
expect "G3b P3-A #1 + M6"                    refused "$TMP/main" "$P1,$M6"
expect "G4 the three + one not pending"      refused "$TMP/main" "$THREE,20261011090000_lab_not_pending"
expect "G5 the pair, a fourth merged after M6" allowed "$TMP/late" "$P1,$P2"; held "$M6, $LATE"
PGPASSWORD="$LAB_PASSWORD" psql -X -q -U lab_owner -d "$DB" -v ON_ERROR_STOP=1 -c \
  "INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, applied_steps_count) VALUES ('p3a-gate-proof-unfinished', repeat('0',64), '$P1', 0)"
expect "G6 an unfinished ledger row"         refused "$TMP/main" "$P1,$P2"
PGPASSWORD="$LAB_PASSWORD" psql -X -q -U lab_owner -d "$DB" -v ON_ERROR_STOP=1 -c \
  "DELETE FROM \"_prisma_migrations\" WHERE id = 'p3a-gate-proof-unfinished'"
expect "G2 again after the lab row is gone"  allowed "$TMP/main" "$P1,$P2"; held "$M6"
rm -rf "$TMP"
echo "RELEASE GATE APPROVED-PREFIX PROOF: PASS"
