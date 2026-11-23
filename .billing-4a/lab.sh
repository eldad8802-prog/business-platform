#!/usr/bin/env bash
# 4a T5 — numbering continuity across "מעבר לעוסק מורשה": Production-topology lab.
#
#   .billing-4a/lab.sh <db-name> [--with-t1] [--with-t1-wiring]
#
#   --with-t1         also applies the 4a T1/T1a migrations (DRAFT, not approved) in the same migrate deploy:
#                       20261223090000  IssuerReauthMethod + GOOGLE (T1a);
#                       20261223100000  the issuer declaration STATUS_CHANGE writer + its origin guard (T1).
#   --with-t1-wiring  implies --with-t1, then applies .billing-4a/t1-wiring.proposed.sql: the LAB-ONLY simulation of
#                     the legal identity follow-up (the transition calls the writer). Never a migration.
#
# Builds on the signup legal identity lab (.sli/lab.sh <db> --with-sli: non-superuser BYPASSRLS owner, NOLOGIN
# app_runtime + LOGIN app_runtime_prod, app_auth + te_auth_login, BusinessProfile under FORCE RLS with the runtime's
# real grants, the signup lock DZL04). Then ONE `prisma migrate deploy` — the release-migrate mechanism — applies, in
# Production's order, the three migrations whose objects T5 exercises:
#   20260926140000  DZ010: issued billing documents are immutable (only if not already in the lab ledger);
#   20261126100000  issuer declaration + BillingSeriesOpening + series_opening_apply on the number counter;
#   20261221090000  the business kind transition (definer function, append-only history).
# Their tables come from `db push` in the base lab without Production's policies, triggers and grants, so they are
# dropped first and built by the migrations themselves. Every other billing table keeps the base lab's shape; the
# battery replays every RLS statement the repository ships before it runs.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional), T5_BASE_TEMPLATE (optional: an already built .sli lab database
# to clone instead of rebuilding it). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; shift
WITH_T1=0; WITH_WIRING=0
for a in "$@"; do
  case "$a" in
    --with-t1) WITH_T1=1 ;;
    --with-t1-wiring) WITH_T1=1; WITH_WIRING=1 ;;
    *) echo "unknown option $a"; exit 2 ;;
  esac
done
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DZ010="20260926140000_sec_f_append_only_audit_fiscal_immutability_security_events"
DECL="20261126100000_issuer_declaration"
BKT="20261221090000_business_kind_transition"
T1A="20261223090000_issuer_reauth_google"
T1="20261223100000_issuer_declaration_status_change"
EXTRA=""
if [ $WITH_T1 = 1 ]; then EXTRA="$T1A $T1"; fi
SUPER_URL="postgresql://${SUPER}@${PGHOST}:${PGPORT}/postgres"
if [ -n "${T5_BASE_TEMPLATE:-}" ]; then
  psql -X -q -v ON_ERROR_STOP=1 "$SUPER_URL" -c "DROP DATABASE IF EXISTS \"$DB\"" -c "CREATE DATABASE \"$DB\" TEMPLATE \"$T5_BASE_TEMPLATE\" OWNER lab_owner"
else
  bash "$ROOT/.sli/lab.sh" "$DB" --with-sli >/dev/null
fi
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

psql_owner -c 'DROP TABLE IF EXISTS "BusinessKindTransition", "BillingSeriesOpening", "IssuerDeclarationEnforcement", "BusinessIssuerDeclaration" CASCADE'
# db push created the enums the declaration migration creates itself.
for t in IssuerTrack IssuerLegalForm IssuerVatStatus IssuerIdType IssuerDeclarationKind IssuerAuthorityBasis IssuerReauthMethod SeriesOpeningSource; do
  psql_owner -c "DROP TYPE IF EXISTS \"$t\" CASCADE"
done

LEDGER="$(psql_owner -At -c 'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')"
TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for name in $LEDGER "$DZ010" "$DECL" "$BKT" $EXTRA; do
  cp -r "$ROOT/prisma/migrations/$name" "$TMP/prisma/migrations/$name"
done
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "Applying migration|have been successfully applied|Error|error|ERROR" "$TMP/deploy.log" | head -12
[ $rc -eq 0 ] || { tail -40 "$TMP/deploy.log"; rm -rf "$TMP"; echo "deploy failed"; exit 1; }
rm -rf "$TMP"
# The base lab records DZ010 in its ledger without building its objects (its billing tables come from `db push`).
# Build them now, from the migration file itself, so issued documents are immutable as in Production.
if [ "$(psql_owner -At -c "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = 'BillingDocument' AND t.tgname = 'secf_fiscal_immutable'")" = "0" ]; then
  # It grants to the repository's NOLOGIN roles (the RLS replay creates the same ones, same attributes).
  for r in app_admin app_auth app_ctlplane app_runtime; do
    psql -X -q -v ON_ERROR_STOP=1 "$SUPER_URL" -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$r') THEN
      CREATE ROLE $r NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION; END IF; END \$\$"
  done
  psql_owner --single-transaction -f "$ROOT/prisma/migrations/$DZ010/migration.sql" >/dev/null
fi
for m in "$DECL" "$BKT" $EXTRA; do
  [ "$(psql_owner -At -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$m' AND finished_at IS NOT NULL AND rolled_back_at IS NULL")" = "1" ] \
    || { echo "$m not recorded"; exit 1; }
done
if [ $WITH_WIRING = 1 ]; then
  psql_owner --single-transaction -f "$ROOT/.billing-4a/t1-wiring.proposed.sql" >/dev/null
  echo "LAB-ONLY: proposed T1 wiring applied (simulated legal identity follow-up, not a migration)"
fi
echo "LAB READY: $DB (signup identity + DZ010 + issuer declaration/series opening + business kind transition${EXTRA:+ + 4a T1/T1a}, migrate deploy)"
