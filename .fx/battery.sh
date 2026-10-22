#!/usr/bin/env bash
# Currency settings + FX rates — battery AS THE REAL ROLES on a migrated lab database (.fx/lab.sh build + apply).
#
#   .fx/battery.sh <db> <business P> <business Q>
#
# P and Q were seeded BEFORE the migration (Q with a financial row). Proves, as app_runtime_prod (LOGIN member
# of the NOLOGIN NOBYPASSRLS app_runtime), as a LOGIN member of fx_rate_writer, as the owner and as a superuser:
#   B1  pre-existing businesses / users: no settings row, no preference row (⇒ he / IL / Asia/Jerusalem / ILS /
#       ILS / Hebrew); a row created with nothing but its key carries exactly those defaults
#   B2  BusinessLocaleSettings tenant isolation (read / add / change / move across businesses, no context),
#       no removal, no emptying, every CHECK
#   B3  the base-currency guard: free without financial rows, refused with them (insert and change), display
#       currency always free, the tenant-scoped probe, isolation level, and two real concurrent races
#   B4  UserLocalePreference per-user isolation inside one business, across businesses, without a user context,
#       the same-business user guard, no removal
#   B5  FxRate: the runtime reads only; the writer appends only (no read, no RETURNING, nothing else anywhere);
#       CHECKs; append-only for the owner and a superuser too (UPDATE / DELETE / TRUNCATE)
#   B6  EXECUTE: the tenant probe for app_runtime alone; the internal check for nobody
#
# env: PGHOST, PGPORT, SUPER, PGPASSWORD (superuser), LAB_PASSWORD. Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; P="$2"; Q="$3"
pass=0
ok() { pass=$((pass + 1)); echo "  [PASS] $1"; }
die() { echo "  [FAIL] $1"; exit 1; }
su() { psql -X -q -At -v ON_ERROR_STOP=1 -U "$SUPER" -d "$DB" -c "$1"; }
own() { PGPASSWORD="$LAB_PASSWORD" psql -X -q -At -v ON_ERROR_STOP=1 -U lab_owner -d "$DB" "$@"; }
rt() {  # rt <business or ''> <user or ''> <sql> — the runtime login, one transaction, tenant (+ user) context
  PGPASSWORD="$LAB_PASSWORD" psql -X -q -At -v ON_ERROR_STOP=1 -U app_runtime_prod -d "$DB" \
    -c "BEGIN" -c "SELECT set_config('app.current_business_id', '$1', true), set_config('app.current_user_id', '$2', true)" \
    -c "$3" -c "COMMIT" | tail -n +2
}
wr() { PGPASSWORD="$LAB_PASSWORD" psql -X -q -At -v ON_ERROR_STOP=1 -U fx_rate_writer_lab -d "$DB" -c "$1"; }
refused() {  # refused <label> <pattern> <command...>
  local label="$1" pat="$2"; shift 2
  if "$@" >/tmp/fx.out 2>/tmp/fx.err; then echo "NOT REFUSED: $label"; cat /tmp/fx.out; exit 1; fi
  grep -qiE "$pat" /tmp/fx.err || { echo "$label: refused for another reason:"; cat /tmp/fx.err; exit 1; }
  ok "refused: $label"
}
eq() { [ "$2" = "$3" ] || die "$1 — expected '$3', got '$2'"; ok "$1"; }

# A LOGIN member of the writer group, as the owner's future credential will be.
su "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fx_rate_writer_lab') THEN
      CREATE ROLE fx_rate_writer_lab LOGIN NOSUPERUSER NOBYPASSRLS INHERIT PASSWORD '$LAB_PASSWORD' IN ROLE fx_rate_writer; END IF; END \$\$"

echo "B1 — pre-existing rows and defaults"
eq "no settings row for the pre-existing businesses" "$(su "SELECT count(*) FROM \"BusinessLocaleSettings\" WHERE \"businessId\" IN ($P, $Q)")" "0"
eq "no preference row for the pre-existing users" "$(su "SELECT count(*) FROM \"UserLocalePreference\" u JOIN \"User\" x ON x.\"id\" = u.\"userId\" WHERE x.\"businessId\" IN ($P, $Q)")" "0"
eq "absent row reads as the defaults (LEFT JOIN + column defaults)" \
  "$(rt "$P" "" "SELECT coalesce(s.\"locale\", 'he') || '|' || coalesce(s.\"baseCurrency\", 'ILS') || '|' || coalesce(s.\"displayCurrency\", 'ILS') FROM (SELECT $P AS id) b LEFT JOIN \"BusinessLocaleSettings\" s ON s.\"businessId\" = b.id")" "he|ILS|ILS"
eq "a row with only its key carries he / IL / Asia/Jerusalem / ILS / ILS / version 1" \
  "$(rt "$P" "" "INSERT INTO \"BusinessLocaleSettings\" (\"businessId\", \"updatedAt\") VALUES ($P, now()) RETURNING \"locale\" || '|' || \"region\" || '|' || \"timeZone\" || '|' || \"baseCurrency\" || '|' || \"displayCurrency\" || '|' || \"version\"")" \
  "he|IL|Asia/Jerusalem|ILS|ILS|1"
eq "the same for Q, which already has financial rows (ILS is its effective base: no change, allowed)" \
  "$(rt "$Q" "" "INSERT INTO \"BusinessLocaleSettings\" (\"businessId\", \"updatedAt\") VALUES ($Q, now()) RETURNING \"baseCurrency\" || '|' || \"displayCurrency\"")" "ILS|ILS"

echo "B2 — BusinessLocaleSettings isolation and CHECKs"
A=$(su "INSERT INTO \"Business\" (\"name\", \"updatedAt\") VALUES ('fx-A', now()) RETURNING \"id\"")
B=$(su "INSERT INTO \"Business\" (\"name\", \"updatedAt\") VALUES ('fx-B', now()) RETURNING \"id\"")
C=$(su "INSERT INTO \"Business\" (\"name\", \"updatedAt\") VALUES ('fx-C', now()) RETURNING \"id\"")
D=$(su "INSERT INTO \"Business\" (\"name\", \"updatedAt\") VALUES ('fx-D', now()) RETURNING \"id\"")
bls() { echo "INSERT INTO \"BusinessLocaleSettings\" (\"businessId\", \"updatedAt\"$2) VALUES ($1, now()$3)"; }
rt "$A" "" "$(bls "$A")" >/dev/null; ok "A adds its own settings"
refused "add for another business" "row-level security" rt "$A" "" "$(bls "$B")"
refused "add without tenant context" "row-level security" rt "" "" "$(bls "$B")"
eq "B sees nothing of A" "$(rt "$B" "" 'SELECT count(*) FROM "BusinessLocaleSettings"')" "0"
eq "no context sees nothing" "$(rt "" "" 'SELECT count(*) FROM "BusinessLocaleSettings"')" "0"
eq "A sees exactly its own row" "$(rt "$A" "" "SELECT count(*) FILTER (WHERE \"businessId\" = $A) || '/' || count(*) FROM \"BusinessLocaleSettings\"")" "1/1"
eq "B cannot change A" "$(rt "$B" "" "UPDATE \"BusinessLocaleSettings\" SET \"locale\" = 'en', \"updatedAt\" = now() WHERE \"businessId\" = $A RETURNING 1" | wc -l | tr -d ' ')" "0"
rt "$A" "" "UPDATE \"BusinessLocaleSettings\" SET \"locale\" = 'en', \"version\" = \"version\" + 1, \"updatedAt\" = now() WHERE \"businessId\" = $A" >/dev/null; ok "A changes its own language"
refused "move a row to another business" "row-level security" rt "$A" "" "UPDATE \"BusinessLocaleSettings\" SET \"businessId\" = $B WHERE \"businessId\" = $A"
refused "removal" "permission denied" rt "$A" "" "DELETE FROM \"BusinessLocaleSettings\" WHERE \"businessId\" = $A"
refused "emptying" "permission denied" rt "$A" "" 'TRUNCATE "BusinessLocaleSettings"'
refused "unknown locale" "BusinessLocaleSettings_locale" rt "$B" "" "$(bls "$B" ', "locale"' ", 'fr'")"
refused "lower-case region" "BusinessLocaleSettings_region" rt "$B" "" "$(bls "$B" ', "region"' ", 'il'")"
refused "malformed time zone" "BusinessLocaleSettings_timeZone" rt "$B" "" "$(bls "$B" ', "timeZone"' ", 'Asia/Jerusalem; x'")"
refused "unsupported base currency" "BusinessLocaleSettings_baseCurrency" rt "$B" "" "$(bls "$B" ', "baseCurrency"' ", 'GBP'")"
refused "lower-case display currency" "BusinessLocaleSettings_displayCurrency" rt "$B" "" "$(bls "$B" ', "displayCurrency"' ", 'usd'")"
refused "version 0" "BusinessLocaleSettings_version" rt "$B" "" "$(bls "$B" ', "version"' ", 0")"

echo "B3 — the base-currency guard"
obl() { echo "INSERT INTO \"BusinessObligation\" (\"businessId\", \"obligeeName\", \"amount\", \"dueAt\", \"updatedAt\") VALUES ($1, 'fx-lab', 10.00, now(), now())"; }
rt "$A" "" "UPDATE \"BusinessLocaleSettings\" SET \"baseCurrency\" = 'USD', \"updatedAt\" = now() WHERE \"businessId\" = $A" >/dev/null; ok "no financial row: base ILS → USD allowed"
rt "$A" "" "UPDATE \"BusinessLocaleSettings\" SET \"baseCurrency\" = 'ILS', \"updatedAt\" = now() WHERE \"businessId\" = $A" >/dev/null; ok "no financial row: base USD → ILS allowed"
rt "$B" "" "$(bls "$B" ', "baseCurrency", "displayCurrency"' ", 'EUR', 'EUR'")" >/dev/null; ok "no financial row: a new row with base EUR allowed"
eq "probe: A not fixed" "$(rt "$A" "" 'SELECT public.business_base_currency_locked()')" "f"
eq "probe: Q (financial rows before the migration) fixed" "$(rt "$Q" "" 'SELECT public.business_base_currency_locked()')" "t"
refused "probe without tenant context" "DZF03|BASE_CURRENCY_NO_CONTEXT" rt "" "" 'SELECT public.business_base_currency_locked()'
refused "Q: change base ILS → USD" "DZF02|BASE_CURRENCY_LOCKED" rt "$Q" "" "UPDATE \"BusinessLocaleSettings\" SET \"baseCurrency\" = 'USD', \"updatedAt\" = now() WHERE \"businessId\" = $Q"
rt "$Q" "" "UPDATE \"BusinessLocaleSettings\" SET \"displayCurrency\" = 'USD', \"updatedAt\" = now() WHERE \"businessId\" = $Q" >/dev/null; ok "Q: display currency is free"
refused "Q (owner too): change base" "DZF02|BASE_CURRENCY_LOCKED" own -c "UPDATE \"BusinessLocaleSettings\" SET \"baseCurrency\" = 'EUR' WHERE \"businessId\" = $Q"
# a business whose first financial row exists but no settings row yet: a row created with another base is refused
su "$(obl "$D")" >/dev/null
refused "D (financial row, no settings row): new row with base USD" "DZF02|BASE_CURRENCY_LOCKED" rt "$D" "" "$(bls "$D" ', "baseCurrency"' ", 'USD'")"
rt "$D" "" "$(bls "$D" ', "baseCurrency", "displayCurrency"' ", 'ILS', 'EUR'")" >/dev/null; ok "D: new row keeping ILS (display EUR) allowed"
refused "B (EUR): change base under REPEATABLE READ" "DZF03|BASE_CURRENCY_CHANGE_ISOLATION" \
  env PGPASSWORD="$LAB_PASSWORD" psql -X -q -At -v ON_ERROR_STOP=1 -U app_runtime_prod -d "$DB" \
    -c "BEGIN ISOLATION LEVEL REPEATABLE READ" -c "SELECT set_config('app.current_business_id', '$B', true)" \
    -c "UPDATE \"BusinessLocaleSettings\" SET \"baseCurrency\" = 'USD', \"updatedAt\" = now() WHERE \"businessId\" = $B" -c "COMMIT"
# Race 1: the first financial row is being written (uncommitted) while the runtime changes the base currency.
# The change must wait for that commit, then see the row and refuse.
( PGPASSWORD="$LAB_PASSWORD" psql -X -q -At -v ON_ERROR_STOP=1 -U lab_owner -d "$DB" \
    -c "BEGIN" -c "$(obl "$A")" -c "SELECT pg_sleep(3)" -c "COMMIT" >/dev/null ) &
bg=$!
sleep 1
t0=$(date +%s)
refused "race 1: base change while the first financial row commits" "DZF02|BASE_CURRENCY_LOCKED" \
  rt "$A" "" "UPDATE \"BusinessLocaleSettings\" SET \"baseCurrency\" = 'EUR', \"updatedAt\" = now() WHERE \"businessId\" = $A"
waited=$(( $(date +%s) - t0 )); wait "$bg"
[ "$waited" -ge 1 ] || die "race 1: the change did not wait for the financial row (${waited}s)"
ok "race 1: the change waited ${waited}s for the concurrent financial row, then refused"
eq "race 1: A's base currency is still ILS" "$(rt "$A" "" "SELECT \"baseCurrency\" FROM \"BusinessLocaleSettings\" WHERE \"businessId\" = $A")" "ILS"
# Race 2: the base currency change is in flight (uncommitted); a first financial row arrives. The row waits for
# the change to commit (FOR KEY SHARE vs FOR UPDATE on the Business row) — the serial order "change, then row".
rt "$C" "" "$(bls "$C")" >/dev/null
( PGPASSWORD="$LAB_PASSWORD" psql -X -q -At -v ON_ERROR_STOP=1 -U app_runtime_prod -d "$DB" \
    -c "BEGIN" -c "SELECT set_config('app.current_business_id', '$C', true)" \
    -c "UPDATE \"BusinessLocaleSettings\" SET \"baseCurrency\" = 'USD', \"updatedAt\" = now() WHERE \"businessId\" = $C" \
    -c "SELECT pg_sleep(3)" -c "COMMIT" >/dev/null ) &
bg=$!
sleep 1
t0=$(date +%s); own -c "$(obl "$C")" >/dev/null; waited=$(( $(date +%s) - t0 )); wait "$bg"
[ "$waited" -ge 1 ] || die "race 2: the financial row did not wait for the base change (${waited}s)"
ok "race 2: the financial row waited ${waited}s for the in-flight base change (serialised)"
eq "race 2: C is USD and now fixed" "$(rt "$C" "" "SELECT \"baseCurrency\" || '|' || public.business_base_currency_locked()::text FROM \"BusinessLocaleSettings\"")" "USD|true"
refused "race 2: C can no longer change base" "DZF02|BASE_CURRENCY_LOCKED" rt "$C" "" "UPDATE \"BusinessLocaleSettings\" SET \"baseCurrency\" = 'ILS', \"updatedAt\" = now() WHERE \"businessId\" = $C"

echo "B4 — UserLocalePreference: per user"
U1=$(su "INSERT INTO \"User\" (\"email\", \"password\", \"businessId\", \"updatedAt\") VALUES ('u1@fx.lab', 'x', $A, now()) RETURNING \"id\"")
U2=$(su "INSERT INTO \"User\" (\"email\", \"password\", \"businessId\", \"updatedAt\") VALUES ('u2@fx.lab', 'x', $A, now()) RETURNING \"id\"")
UB=$(su "INSERT INTO \"User\" (\"email\", \"password\", \"businessId\", \"updatedAt\") VALUES ('ub@fx.lab', 'x', $B, now()) RETURNING \"id\"")
pref() { echo "INSERT INTO \"UserLocalePreference\" (\"userId\", \"businessId\", \"locale\", \"updatedAt\") VALUES ($1, $2, '$3', now())"; }
rt "$A" "$U1" "$(pref "$U1" "$A" en)" >/dev/null; ok "U1 stores its own language"
refused "U1 stores a language for U2 (same business)" "row-level security" rt "$A" "$U1" "$(pref "$U2" "$A" en)"
eq "U2 sees nothing of U1 (same business)" "$(rt "$A" "$U2" 'SELECT count(*) FROM "UserLocalePreference"')" "0"
eq "U2 cannot change U1's row" "$(rt "$A" "$U2" "UPDATE \"UserLocalePreference\" SET \"locale\" = 'he', \"updatedAt\" = now() WHERE \"userId\" = $U1 RETURNING 1" | wc -l | tr -d ' ')" "0"
eq "tenant context without a user sees nothing" "$(rt "$A" "" 'SELECT count(*) FROM "UserLocalePreference"')" "0"
refused "tenant context without a user cannot add" "row-level security" rt "$A" "" "$(pref "$U2" "$A" he)"
eq "U1 under another business's context sees nothing" "$(rt "$B" "$U1" 'SELECT count(*) FROM "UserLocalePreference"')" "0"
eq "U1 reads its own row" "$(rt "$A" "$U1" 'SELECT "locale" FROM "UserLocalePreference"')" "en"
rt "$A" "$U1" "UPDATE \"UserLocalePreference\" SET \"locale\" = 'he', \"updatedAt\" = now() WHERE \"userId\" = $U1" >/dev/null; ok "U1 changes its own language"
refused "a user of another business filed under A" "DZT03|TASK_USER_OTHER_BUSINESS" rt "$A" "$UB" "$(pref "$UB" "$A" en)"
refused "move U1's row to another business" "row-level security|DZT03" rt "$A" "$U1" "UPDATE \"UserLocalePreference\" SET \"businessId\" = $B WHERE \"userId\" = $U1"
refused "unknown locale" "UserLocalePreference_locale" rt "$B" "$UB" "$(pref "$UB" "$B" fr)"
refused "removal" "permission denied" rt "$A" "$U1" "DELETE FROM \"UserLocalePreference\" WHERE \"userId\" = $U1"

echo "B5 — FxRate"
fx() { echo "INSERT INTO \"FxRate\" (\"base\", \"quote\", \"rate\", \"kind\", \"source\", \"rateDate\", \"fetchedAt\", \"verification\", \"sourceRef\") VALUES ($1)"; }
GOOD="'USD', 'ILS', 3.0910000000, 'REPRESENTATIVE', 'BANK_OF_ISRAEL', DATE '2026-10-21', TIMESTAMP '2026-10-21 14:00:00', 'VERIFIED', 'RER_USD_ILS'"
wr "$(fx "$GOOD")" >/dev/null; ok "the writer appends a Bank of Israel rate (no RETURNING)"
eq "the runtime reads it, exactly" "$(rt "" "" 'SELECT "rate"::text FROM "FxRate"')" "3.0910000000"
refused "runtime appends" "permission denied" rt "" "" "$(fx "'EUR', 'ILS', 3.5, 'REPRESENTATIVE', 'BANK_OF_ISRAEL', DATE '2026-10-21', TIMESTAMP '2026-10-21 12:00:00', 'VERIFIED', NULL")"
refused "runtime changes" "permission denied" rt "" "" 'UPDATE "FxRate" SET "rate" = 1'
refused "runtime removes" "permission denied" rt "" "" 'DELETE FROM "FxRate"'
refused "runtime empties" "permission denied" rt "" "" 'TRUNCATE "FxRate"'
refused "writer reads" "permission denied" wr 'SELECT count(*) FROM "FxRate"'
refused "writer appends with RETURNING" "permission denied" wr "$(fx "'EUR', 'ILS', 3.6, 'REPRESENTATIVE', 'BANK_OF_ISRAEL', DATE '2026-10-21', TIMESTAMP '2026-10-21 12:00:00', 'VERIFIED', NULL") RETURNING \"id\""
refused "writer changes" "permission denied" wr 'UPDATE "FxRate" SET "rate" = 1'
refused "writer removes" "permission denied" wr 'DELETE FROM "FxRate"'
refused "writer empties" "permission denied" wr 'TRUNCATE "FxRate"'
refused "writer touches a tenant table" "permission denied" wr "INSERT INTO \"BusinessLocaleSettings\" (\"businessId\", \"updatedAt\") VALUES ($B, now())"
refused "writer reads Business" "permission denied" wr 'SELECT count(*) FROM "Business"'
refused "rate 0" "FxRate_rate_positive" wr "$(fx "'EUR', 'ILS', 0, 'DISPLAY', 'MANUAL', DATE '2026-10-21', TIMESTAMP '2026-10-21 12:00:00', 'UNVERIFIED', NULL")"
refused "same currency twice" "FxRate_currencies" wr "$(fx "'ILS', 'ILS', 1, 'DISPLAY', 'MANUAL', DATE '2026-10-21', TIMESTAMP '2026-10-21 12:00:00', 'UNVERIFIED', NULL")"
refused "unsupported currency" "FxRate_currencies" wr "$(fx "'GBP', 'ILS', 4, 'DISPLAY', 'MANUAL', DATE '2026-10-21', TIMESTAMP '2026-10-21 12:00:00', 'UNVERIFIED', NULL")"
refused "a TRANSACTION rate" "FxRate_kind" wr "$(fx "'USD', 'ILS', 3.1, 'TRANSACTION', 'MANUAL', DATE '2026-10-21', TIMESTAMP '2026-10-21 12:00:00', 'UNVERIFIED', NULL")"
refused "a Bank of Israel rate quoted in USD" "FxRate_boi_shape" wr "$(fx "'EUR', 'USD', 1.1, 'REPRESENTATIVE', 'BANK_OF_ISRAEL', DATE '2026-10-21', TIMESTAMP '2026-10-21 12:00:00', 'VERIFIED', NULL")"
refused "a rate for a future day" "FxRate_not_future" wr "$(fx "'EUR', 'ILS', 3.6, 'DISPLAY', 'MANUAL', DATE '2026-10-25', TIMESTAMP '2026-10-21 12:00:00', 'UNVERIFIED', NULL")"
refused "unknown verification" "FxRate_verification" wr "$(fx "'EUR', 'ILS', 3.6, 'DISPLAY', 'MANUAL', DATE '2026-10-21', TIMESTAMP '2026-10-21 12:00:00', 'MAYBE', NULL")"
refused "the same identity twice" "FxRate_base_quote_kind_source_rateDate_fetchedAt_key" wr "$(fx "$GOOD")"
wr "$(fx "'USD', 'ILS', 3.0920000000, 'REPRESENTATIVE', 'BANK_OF_ISRAEL', DATE '2026-10-21', TIMESTAMP '2026-10-21 15:00:00', 'VERIFIED', 'RER_USD_ILS correction'")" >/dev/null
ok "a correction is a new row with a later fetchedAt"
refused "owner changes a rate" "DZF01|FX_RATE_APPEND_ONLY" own -c 'UPDATE "FxRate" SET "rate" = 1'
refused "owner removes a rate" "DZF01|FX_RATE_APPEND_ONLY" own -c 'DELETE FROM "FxRate"'
refused "owner empties the table" "DZF01|FX_RATE_APPEND_ONLY" own -c 'TRUNCATE "FxRate"'
refused "superuser changes a rate" "DZF01|FX_RATE_APPEND_ONLY" su 'UPDATE "FxRate" SET "rate" = 1'
refused "superuser removes a rate" "DZF01|FX_RATE_APPEND_ONLY" su 'DELETE FROM "FxRate"'
eq "both rows are intact" "$(su "SELECT count(*) FILTER (WHERE \"rate\" IN (3.091, 3.092)) || '/' || count(*) FROM \"FxRate\"")" "2/2"

echo "B6 — EXECUTE"
refused "app_auth runs the tenant probe" "permission denied" su "SET ROLE app_auth; SELECT public.business_base_currency_locked()"
refused "runtime runs the internal check" "permission denied" rt "$A" "" "SELECT public.business_financial_data_exists($Q)"
refused "writer runs the tenant probe" "permission denied" wr 'SELECT public.business_base_currency_locked()'

echo "battery: PASS ($pass checks)"
