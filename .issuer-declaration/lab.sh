#!/usr/bin/env bash
# Issuer declaration (#1081) / migration 20261126100000_issuer_declaration — Production-topology lab.
#
#   .issuer-declaration/lab.sh <db-name>                the P4 lab (.sd3p4/lab.sh + --deploy-only) with the purge's
#                                                       prerequisites (.sdf/erasure-prereq.sh), then every migration
#                                                       sorting before this one: #1105
#                                                       (20261126090000_auth_issuer_declaration_link, applied alone in
#                                                       Production on 2026-11-14) and any other one still pending on
#                                                       main (today 20261124090000_service_user_same_business_fix,
#                                                       #1131) — release-migrate applies only the first pending
#                                                       migrations, so they precede this one: 20261126100000 pending
#   .issuer-declaration/lab.sh <db-name> --deploy-only  on that lab, `prisma migrate deploy` — the release-migrate
#                                                       mechanism — applies exactly 20261126100000
#
# A migration that sorts between 1.3-0 and P4 (today 20261121090000_business_documents_po_sheets) is neither recorded nor
# applied, exactly as in .sd3p4/lab.sh: the base lab does not build the business-documents objects it needs.
#
# Only migrations on the base ref (ISSUER_LAB_BASE_REF, default origin/main) are staged, plus this one: the release
# gate's rule — Production can only receive what is on main. A migration that exists only on the branch under test (a
# stacked Draft, e.g. another track's 20261126090000_service_desk_case_charge) is NOT staged; it is reported as a
# warning, because it would collide with the base lab and is not part of the order this migration is released in.
# Every base-ref migration that sorts before this one (outside the P4 gap) must end up recorded in the lab ledger, so
# the filter cannot hide a real order failure.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional), ISSUER_LAB_BASE_REF (optional). Synthetic only. ZERO secrets.
# Network: none, except a git fetch of origin/main when a shallow checkout lacks it.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ME="20261126100000_issuer_declaration"
LINK="20261126090000_auth_issuer_declaration_link"
P4="20261122090000_service_desk_audit_journal"
SD3="20261120090000_service_desk_ui_foundation"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"

[ -f "$ROOT/prisma/migrations/$ME/migration.sql" ] || { echo "missing prisma/migrations/$ME"; exit 1; }

# The migration directories on the base ref (read with git; a shallow CI checkout fetches origin/main first).
BASE_REF="${ISSUER_LAB_BASE_REF:-origin/main}"
if ! git -C "$ROOT" rev-parse -q --verify "$BASE_REF^{commit}" >/dev/null; then
  [ "$BASE_REF" = "origin/main" ] || { echo "base ref $BASE_REF is not available"; exit 1; }
  git -C "$ROOT" fetch -q --no-tags --depth=1 origin "+refs/heads/main:refs/remotes/origin/main" \
    || { echo "cannot fetch origin/main — the staged migration set cannot be established"; exit 1; }
fi
BASE_LIST="$(mktemp)"
git -C "$ROOT" ls-tree --name-only "$BASE_REF" prisma/migrations/ | sed 's#^prisma/migrations/##' | grep -E '^[0-9]{14}_' > "$BASE_LIST" || true
[ -s "$BASE_LIST" ] || { echo "no migrations found on $BASE_REF"; exit 1; }
# staged <name>: on the base ref, or this migration itself.
staged() { [ "$1" = "$ME" ] || grep -qxF "$1" "$BASE_LIST"; }

# `prisma migrate deploy` of every migration up to and including <target> (the P4 gap left out), asserting it applies
# exactly <target> — the release-migrate mechanism, one migration per run.
deploy_upto() {
  local target="$1" TMP; TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
  cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
  cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
  for d in "$ROOT"/prisma/migrations/*/; do
    n="$(basename "$d")"
    [[ "$n" > "$target" ]] && continue
    [[ "$n" > "$SD3" && "$n" < "$P4" ]] && continue
    staged "$n" || { echo "::warning::$n is not on $BASE_REF — not staged (branch-only migration)" >&2; continue; }
    cp -r "$d" "$TMP/prisma/migrations/$n"
  done
  ( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) | tee /tmp/issuer-decl-deploy.log
  rm -rf "$TMP"
  grep -q "Applying migration \`$target\`" /tmp/issuer-decl-deploy.log || { echo "$target was not applied"; exit 1; }
  test "$(grep -c 'Applying migration' /tmp/issuer-decl-deploy.log)" = "1" || { echo "more than one migration was applied"; exit 1; }
  test "$(psql -X -At "$OWNER_URL" -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")" = "0"
}

# `prisma migrate deploy` of every migration sorting BEFORE this one (the P4 gap left out): the state Production must
# reach before this migration can be the first pending one. Asserts #1105 is recorded and the ledger is clean.
deploy_before_me() {
  local TMP; TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
  cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
  cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
  for d in "$ROOT"/prisma/migrations/*/; do
    n="$(basename "$d")"
    [[ "$n" < "$ME" ]] || continue
    [[ "$n" > "$SD3" && "$n" < "$P4" ]] && continue
    staged "$n" || { echo "::warning::$n is not on $BASE_REF — not staged (branch-only migration)" >&2; continue; }
    cp -r "$d" "$TMP/prisma/migrations/$n"
  done
  ( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) | tee /tmp/issuer-decl-before.log
  rm -rf "$TMP"
  ! grep -q "Applying migration \`$ME\`" /tmp/issuer-decl-before.log || { echo "$ME was applied too early"; exit 1; }
  test "$(psql -X -At "$OWNER_URL" -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$LINK' AND finished_at IS NOT NULL")" = "1" \
    || { echo "$LINK is not applied"; exit 1; }
  test "$(psql -X -At "$OWNER_URL" -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")" = "0"
  # No hidden order failure: every base-ref migration sorting before this one (outside the P4 gap) is recorded.
  local missing=""
  while read -r n; do
    [[ "$n" < "$ME" ]] || continue
    [[ "$n" > "$SD3" && "$n" < "$P4" ]] && continue
    [ -d "$ROOT/prisma/migrations/$n" ] || { missing="$missing $n(absent-from-checkout)"; continue; }
    [ "$(psql -X -At "$OWNER_URL" -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$n' AND finished_at IS NOT NULL")" = "1" ] \
      || missing="$missing $n"
  done < "$BASE_LIST"
  [ -z "$missing" ] || { echo "base-ref migrations sorting before $ME are not recorded:$missing" >&2; exit 1; }
}

if [ "$MODE" != "--deploy-only" ]; then
  bash "$ROOT/.sd3p4/lab.sh" "$DB" >/dev/null
  bash "$ROOT/.sd3p4/lab.sh" "$DB" --deploy-only >/dev/null
  bash "$ROOT/.sdf/erasure-prereq.sh" "$DB" >/dev/null
  # Production on 2026-11-14: #1105 applied alone (release-migrate 43617171163), before this migration; any migration
  # still pending that sorts before this one is applied before it too (release-migrate's first-pending rule).
  # The case charge (20261126090000_service_desk_case_charge, on main since #1104) sorts before this migration and is
  # applied by deploy_before_me. When the code under test models its tables (the Service Desk charge code), db push
  # already built copies of them: drop those copies so the migration builds them. No-op when nothing was pushed or the
  # charge is already recorded. Lab-only; the declaration flow and its migration are unchanged.
  CHARGE="20261126090000_service_desk_case_charge"
  if staged "$CHARGE" && [ "$(psql -X -At "$OWNER_URL" -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$CHARGE'")" = "0" ]; then
    if [ "$(psql -X -At "$OWNER_URL" -c "SELECT count(*) FROM pg_constraint WHERE conname = 'ServiceCaseEvent_charge_in_place'")" = "1" ]; then
      # .sdf/erasure-prereq.sh already applied the migration VERBATIM (the purge needs its erase function): record it,
      # exactly as release-migrate would, instead of applying it twice.
      ( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate resolve --applied "$CHARGE" --schema prisma/schema.prisma ) >/dev/null
    else
      psql -X -q -v ON_ERROR_STOP=1 "$OWNER_URL" -c 'DROP TABLE IF EXISTS "ServiceCaseBillingLink", "ServiceCaseCharge" CASCADE; DROP TYPE IF EXISTS "ServiceBillingLinkRole", "ServiceChargeSource", "ServiceChargeMode";' >/dev/null
    fi
  fi
  deploy_before_me >/dev/null
  # The code PR models the declaration tables: drop what db push built, so the migration builds them (no-op otherwise).
  psql -X -q -v ON_ERROR_STOP=1 "$OWNER_URL" -f "$ROOT/.issuer-declaration/drop-pushed.sql" >/dev/null 2>&1
  [ "$(psql -X -At "$OWNER_URL" -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$ME'")" = "0" ] \
    || { echo "$ME is already recorded"; exit 1; }
  echo "LAB READY: $DB (P4 applied, erasure prerequisites in place, $LINK + every earlier migration applied; $ME pending)"
  exit 0
fi

deploy_upto "$ME"
echo "LAB READY: $DB ($ME applied)"
