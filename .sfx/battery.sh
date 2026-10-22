#!/usr/bin/env bash
# Payment settlement facts — battery AS THE REAL ROLES on a migrated lab database (.sfx/lab.sh build + apply).
#
#   .sfx/battery.sh <db>
#
# Proves, as app_runtime_prod (LOGIN member of the NOLOGIN NOBYPASSRLS app_runtime), as the owner (BYPASSRLS) and as
# a superuser:
#   S1  tenant isolation: read / append only inside the tenant context; nothing without one; nothing across
#   S2  the transaction must belong to the row's business — refused for the runtime (invisible) AND for the
#       BYPASSRLS owner (explicit comparison, not only RLS); only PAID transactions have facts
#   S3  CHARGED equals the transaction's amount and currency; signs (payment vs reversal); a reversal keeps the
#       payment's original currency and its facts are negative
#   S4  the provider rate: only on SETTLED, only across currencies, from the charged currency, positive
#   S5  sources: BANK needs a bank line of the same business and currency; PROVIDER a reference; MANUAL a note
#       and a user of the same business; CHARGED never from BANK; registry currencies / kinds / sources only
#   S6  versions: one first version per kind; a correction supersedes exactly one fact of the same kind and
#       transaction; the current fact is the one nothing supersedes; idempotency key
#   S7  NET = SETTLED − FEE at commit when all three share a currency (incl. corrections); nothing computed
#       across currencies; a real concurrent race (two writers) is serialised and still refused
#   S8  append-only: UPDATE / DELETE / TRUNCATE refused for the runtime (no privilege), the owner and a superuser
#       (trigger); recordedAt is the database's clock; a user's erasure blanks recordedByUserId and keeps the row;
#       financial parents cannot be deleted under a fact
#   S9  privileges: app_runtime SELECT + INSERT only; no other role, no PUBLIC; READ COMMITTED only
#
# env: PGHOST, PGPORT, SUPER, PGPASSWORD (superuser), LAB_PASSWORD. Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"
pass=0
ok() { pass=$((pass + 1)); echo "  [PASS] $1"; }
die() { echo "  [FAIL] $1"; exit 1; }
su() { psql -X -q -At -v ON_ERROR_STOP=1 -U "$SUPER" -d "$DB" -c "$1"; }
own() { PGPASSWORD="$LAB_PASSWORD" psql -X -q -At -v ON_ERROR_STOP=1 -U lab_owner -d "$DB" -c "$1"; }
rt() {  # rt <business or ''> <sql>... — the runtime login, ONE transaction, tenant context
  local b="$1"; shift
  local args=(-c "BEGIN" -c "SELECT set_config('app.current_business_id', '$b', true)")
  for s in "$@"; do args+=(-c "$s"); done
  args+=(-c "COMMIT")
  PGPASSWORD="$LAB_PASSWORD" psql -X -q -At -v ON_ERROR_STOP=1 -U app_runtime_prod -d "$DB" "${args[@]}" | tail -n +2
}
refused() {  # refused <label> <pattern> <command...>
  local label="$1" pat="$2"; shift 2
  if "$@" >/tmp/sfx.out 2>/tmp/sfx.err; then echo "NOT REFUSED: $label"; cat /tmp/sfx.out; exit 1; fi
  grep -qiE "$pat" /tmp/sfx.err || { echo "$label: refused for another reason:"; cat /tmp/sfx.err; exit 1; }
  ok "refused: $label"
}
eq() { [ "$2" = "$3" ] || die "$1 — expected '$3', got '$2'"; ok "$1"; }
T='"PaymentSettlementFact"'
# f <business> <txn> <kind> <amount> <currency> <source> [<extra columns> <extra values>] — one INSERT statement
f() {
  local cols='"businessId", "paymentTransactionId", "kind", "amount", "currency", "source"'
  local vals="$1, $2, '$3', $4, '$5', '$6'"
  [ "$6" = "PROVIDER" ] && { cols="$cols, \"sourceRef\""; vals="$vals, 'cc-deal-$2-$3'"; }
  echo "INSERT INTO $T ($cols${7:-}) VALUES ($vals${8:-})"
}

# ── seed: businesses A, B; users; payment requests + transactions; bank lines (as the superuser) ──────────────
A=$(su "INSERT INTO \"Business\" (\"name\", \"updatedAt\") VALUES ('sfx-A', now()) RETURNING \"id\"")
B=$(su "INSERT INTO \"Business\" (\"name\", \"updatedAt\") VALUES ('sfx-B', now()) RETURNING \"id\"")
UA=$(su "INSERT INTO \"User\" (\"email\", \"password\", \"businessId\", \"updatedAt\") VALUES ('a@sfx.lab', 'x', $A, now()) RETURNING \"id\"")
UB=$(su "INSERT INTO \"User\" (\"email\", \"password\", \"businessId\", \"updatedAt\") VALUES ('b@sfx.lab', 'x', $B, now()) RETURNING \"id\"")
UE=$(su "INSERT INTO \"User\" (\"email\", \"password\", \"businessId\", \"updatedAt\") VALUES ('erase@sfx.lab', 'x', $A, now()) RETURNING \"id\"")
req() { su "INSERT INTO \"PaymentRequest\" (\"businessId\", \"provider\", \"amount\", \"currency\", \"status\", \"updatedAt\") VALUES ($1, 'CARDCOM', $2, '$3', 'PAID', now()) RETURNING \"id\""; }
txn() { su "INSERT INTO \"PaymentTransaction\" (\"paymentRequestId\", \"provider\", \"providerTransactionId\", \"amount\", \"currency\", \"status\") VALUES ($1, 'CARDCOM', 'cc-$RANDOM-$RANDOM-$2', $2, '$3', '${4:-PAID}') RETURNING \"id\""; }
bank() { su "INSERT INTO \"ExternalTransaction\" (\"businessId\", \"source\", \"externalId\", \"direction\", \"amount\", \"currency\", \"bookedAt\", \"updatedAt\") VALUES ($1, 'OWNER_ENTRY', 'sfx-$RANDOM-$RANDOM', 'CREDIT', $2, '$3', now(), now()) RETURNING \"id\""; }
RA=$(req "$A" 100.00 USD); RB=$(req "$B" 50.00 EUR); RI=$(req "$A" 200.00 ILS)
TA=$(txn "$RA" 100.00 USD)            # A: a USD card payment
TR=$(txn "$RA" -40.00 USD)            # A: a partial reversal of it, in its own (USD) currency
TP=$(txn "$RA" 10.00 USD PENDING)     # A: not settled
TI=$(txn "$RI" 200.00 ILS)            # A: an ILS payment
TB=$(txn "$RB" 50.00 EUR)             # B: a EUR payment
TX=$(txn "$RI" 30.00 ILS)             # A: for the race
TK=$(txn "$RI" 20.00 ILS)             # A: for the idempotency key
TM=$(txn "$RI" 75.00 ILS)             # A: for the manual fact of an erased user
BA=$(bank "$A" 355.00 ILS); BU=$(bank "$A" 98.00 USD); BB=$(bank "$B" 180.00 ILS)
echo "seed: A=$A B=$B users $UA/$UB/$UE txns USD=$TA rev=$TR pending=$TP ILS=$TI B-EUR=$TB race=$TX key=$TK manual=$TM bank A-ILS=$BA A-USD=$BU B-ILS=$BB"

echo "S1 — tenant isolation"
rt "$A" "$(f "$A" "$TA" CHARGED 100.00 USD PROVIDER)" >/dev/null; ok "A records CHARGED 100.00 USD from the provider"
eq "A sees exactly its fact" "$(rt "$A" "SELECT count(*) FROM $T")" "1"
eq "B sees nothing of A" "$(rt "$B" "SELECT count(*) FROM $T")" "0"
eq "no tenant context sees nothing" "$(rt "" "SELECT count(*) FROM $T")" "0"
refused "append without tenant context (the transaction is invisible, or RLS)" "row-level security|DZS02|SETTLEMENT_FACT_OTHER_BUSINESS" rt "" "$(f "$A" "$TI" CHARGED 200.00 ILS PROVIDER)"
refused "append a row of another business (A's context, businessId B)" "row-level security|DZS02|SETTLEMENT_FACT_OTHER_BUSINESS" rt "$A" "$(f "$B" "$TB" CHARGED 50.00 EUR PROVIDER)"

echo "S2 — the transaction belongs to the row's business; PAID only"
refused "runtime, B's context: B's businessId on A's transaction (invisible)" "DZS02|SETTLEMENT_FACT_OTHER_BUSINESS" rt "$B" "$(f "$B" "$TA" FEE 1.00 USD PROVIDER)"
refused "owner (BYPASSRLS): B's businessId on A's transaction" "DZS02|SETTLEMENT_FACT_OTHER_BUSINESS" own "$(f "$B" "$TA" FEE 1.00 USD PROVIDER)"
refused "superuser: A's businessId on B's transaction" "DZS02|SETTLEMENT_FACT_OTHER_BUSINESS" su "$(f "$A" "$TB" FEE 1.00 EUR PROVIDER)"
refused "a PENDING transaction" "DZS03|SETTLEMENT_FACT_NOT_PAID" rt "$A" "$(f "$A" "$TP" CHARGED 10.00 USD PROVIDER)"
refused "a transaction that does not exist" "DZS02|SETTLEMENT_FACT_OTHER_BUSINESS|foreign key" rt "$A" "$(f "$A" 999999 CHARGED 1.00 USD PROVIDER)"

echo "S3 — CHARGED and signs"
refused "CHARGED in another currency than the transaction" "DZS04|CHARGED_MISMATCH" rt "$A" "$(f "$A" "$TI" CHARGED 200.00 USD PROVIDER)"
refused "CHARGED of another amount" "DZS04|CHARGED_MISMATCH" rt "$A" "$(f "$A" "$TI" CHARGED 199.99 ILS PROVIDER)"
refused "SETTLED negative on a payment" "DZS04|SETTLEMENT_FACT_SIGN" rt "$A" "$(f "$A" "$TI" SETTLED -200.00 ILS PROVIDER)"
refused "SETTLED zero" "PaymentSettlementFact_amount_nonzero|DZS04|SETTLEMENT_FACT_SIGN" rt "$A" "$(f "$A" "$TI" SETTLED 0 ILS PROVIDER)"
refused "NET negative on a payment" "DZS04|SETTLEMENT_FACT_SIGN" rt "$A" "$(f "$A" "$TI" NET -1.00 ILS PROVIDER)"
rt "$A" "$(f "$A" "$TR" CHARGED -40.00 USD PROVIDER)" >/dev/null; ok "reversal: CHARGED -40.00 in the payment's own USD"
refused "reversal: CHARGED in ILS (a refund keeps the original currency)" "DZS04|CHARGED_MISMATCH" rt "$A" "$(f "$A" "$TR" CHARGED -148.00 ILS MANUAL ', "note", "recordedByUserId"' ", 'x', $UA")"
refused "reversal: SETTLED positive" "DZS04|SETTLEMENT_FACT_SIGN" rt "$A" "$(f "$A" "$TR" SETTLED 148.00 ILS PROVIDER)"
rt "$A" "$(f "$A" "$TR" SETTLED -148.40 ILS PROVIDER ', "providerRate", "rateBase", "rateQuote"' ", 3.71, 'USD', 'ILS'")" \
       "$(f "$A" "$TR" FEE 0 ILS PROVIDER)" "$(f "$A" "$TR" NET -148.40 ILS PROVIDER)" >/dev/null
ok "reversal: SETTLED -148.40 ILS at 3.71, FEE 0, NET -148.40 (adds up)"
rt "$A" "$(f "$A" "$TI" NET 0 ILS MANUAL ', "note", "recordedByUserId"' ", 'nothing transferred yet', $UA")" >/dev/null; ok "NET zero is a fact"

echo "S4 — the provider rate"
refused "rate on FEE" "PaymentSettlementFact_rate_shape" rt "$A" "$(f "$A" "$TA" FEE 3.00 USD PROVIDER ', "providerRate", "rateBase", "rateQuote"' ", 3.7, 'USD', 'ILS'")"
refused "rate without its currencies" "PaymentSettlementFact_rate_shape" rt "$A" "$(f "$A" "$TA" SETTLED 370.00 ILS PROVIDER ', "providerRate"' ", 3.7")"
refused "rate quoted in another currency than the settlement" "PaymentSettlementFact_rate_shape" rt "$A" "$(f "$A" "$TA" SETTLED 370.00 ILS PROVIDER ', "providerRate", "rateBase", "rateQuote"' ", 0.92, 'USD', 'EUR'")"
refused "rate within one currency" "PaymentSettlementFact_rate_shape" rt "$A" "$(f "$A" "$TI" SETTLED 200.00 ILS PROVIDER ', "providerRate", "rateBase", "rateQuote"' ", 1, 'ILS', 'ILS'")"
refused "rate from a currency that was not charged" "DZS04|SETTLEMENT_FACT_RATE_BASE" rt "$A" "$(f "$A" "$TA" SETTLED 370.00 ILS PROVIDER ', "providerRate", "rateBase", "rateQuote"' ", 4.0, 'EUR', 'ILS'")"
refused "rate zero" "PaymentSettlementFact_rate_shape" rt "$A" "$(f "$A" "$TA" SETTLED 370.00 ILS PROVIDER ', "providerRate", "rateBase", "rateQuote"' ", 0, 'USD', 'ILS'")"

echo "S5 — sources"
refused "BANK without a bank line" "PaymentSettlementFact_bank_line|DZS05|SETTLEMENT_FACT_BANK_LINE" rt "$A" "$(f "$A" "$TA" NET 355.00 ILS BANK)"
refused "a bank line on a PROVIDER fact" "PaymentSettlementFact_bank_line" rt "$A" "$(f "$A" "$TA" NET 355.00 ILS PROVIDER ', "externalTransactionId"' ", $BA")"
refused "BANK: another business's bank line (runtime: invisible)" "DZS05|SETTLEMENT_FACT_BANK_LINE" rt "$A" "$(f "$A" "$TA" NET 180.00 ILS BANK ', "externalTransactionId"' ", $BB")"
refused "BANK: another business's bank line (owner)" "DZS05|SETTLEMENT_FACT_BANK_LINE" own "$(f "$A" "$TA" NET 180.00 ILS BANK ', "externalTransactionId"' ", $BB")"
refused "BANK: in another currency than the bank line" "DZS05|SETTLEMENT_FACT_BANK_CURRENCY" rt "$A" "$(f "$A" "$TA" NET 355.00 USD BANK ', "externalTransactionId"' ", $BA")"
refused "CHARGED from a bank line" "PaymentSettlementFact_charged_source" rt "$A" "$(f "$A" "$TI" CHARGED 200.00 ILS BANK ', "externalTransactionId"' ", $BA")"
refused "PROVIDER without a reference" "PaymentSettlementFact_provider_ref" rt "$A" "INSERT INTO $T (\"businessId\", \"paymentTransactionId\", \"kind\", \"amount\", \"currency\", \"source\") VALUES ($A, $TI, 'FEE', 1.00, 'ILS', 'PROVIDER')"
refused "MANUAL without a note" "PaymentSettlementFact_manual_note" rt "$A" "$(f "$A" "$TI" FEE 1.00 ILS MANUAL ', "recordedByUserId"' ", $UA")"
refused "MANUAL with a blank note" "PaymentSettlementFact_manual_note" rt "$A" "$(f "$A" "$TI" FEE 1.00 ILS MANUAL ', "recordedByUserId", "note"' ", $UA, '   '")"
refused "MANUAL without the user who entered it" "DZS06|SETTLEMENT_FACT_MANUAL_ACTOR" rt "$A" "$(f "$A" "$TI" FEE 1.00 ILS MANUAL ', "note"' ", 'from the statement'")"
refused "MANUAL by a user of another business" "DZT03|TASK_USER_OTHER_BUSINESS" rt "$A" "$(f "$A" "$TI" FEE 1.00 ILS MANUAL ', "note", "recordedByUserId"' ", 'x', $UB")"
refused "a source for a representative / computed rate" "PaymentSettlementFact_source" rt "$A" "$(f "$A" "$TA" SETTLED 370.00 ILS BANK_OF_ISRAEL)"
refused "an unsupported currency" "PaymentSettlementFact_currency" rt "$A" "$(f "$A" "$TA" SETTLED 80.00 GBP PROVIDER)"
refused "a lower-case currency" "PaymentSettlementFact_currency" rt "$A" "$(f "$A" "$TA" SETTLED 370.00 ils PROVIDER)"
refused "an unknown kind" "PaymentSettlementFact_kind" rt "$A" "$(f "$A" "$TA" RECEIVED 370.00 ILS PROVIDER)"

echo "S6 — versions"
S1=$(rt "$A" "$(f "$A" "$TA" SETTLED 368.00 ILS PROVIDER ', "providerRate", "rateBase", "rateQuote"' ", 3.68, 'USD', 'ILS'") RETURNING \"id\"")
ok "A: SETTLED 368.00 ILS at 3.68 for the USD charge (fact $S1)"
refused "a second first version of SETTLED" "PaymentSettlementFact_first_version_key" rt "$A" "$(f "$A" "$TA" SETTLED 369.00 ILS PROVIDER)"
S2=$(rt "$A" "$(f "$A" "$TA" SETTLED 370.00 ILS PROVIDER ', "providerRate", "rateBase", "rateQuote", "supersedesId"' ", 3.70, 'USD', 'ILS', $S1") RETURNING \"id\"")
ok "a correction supersedes it (fact $S2)"
refused "superseding the same fact twice" "PaymentSettlementFact_supersedesId_key" rt "$A" "$(f "$A" "$TA" SETTLED 371.00 ILS PROVIDER ', "supersedesId"' ", $S1")"
refused "superseding with another kind" "DZS07|SETTLEMENT_FACT_SUPERSEDES" rt "$A" "$(f "$A" "$TA" FEE 1.00 ILS PROVIDER ', "supersedesId"' ", $S2")"
refused "superseding a fact of another transaction" "DZS07|SETTLEMENT_FACT_SUPERSEDES" rt "$A" "$(f "$A" "$TI" SETTLED 200.00 ILS PROVIDER ', "supersedesId"' ", $S2")"
eq "the current SETTLED is the correction" \
  "$(rt "$A" "SELECT f.\"id\" || '|' || f.\"amount\" FROM $T f WHERE f.\"paymentTransactionId\" = $TA AND f.\"kind\" = 'SETTLED' AND NOT EXISTS (SELECT 1 FROM $T s WHERE s.\"supersedesId\" = f.\"id\")")" "$S2|370.00"
rt "$A" "$(f "$A" "$TI" CHARGED 200.00 ILS PROVIDER ', "idempotencyKey"' ", 'cardcom:deal:1'")" >/dev/null; ok "idempotency key recorded"
refused "the same idempotency key again" "PaymentSettlementFact_businessId_idempotencyKey_key" rt "$A" "$(f "$A" "$TK" CHARGED 20.00 ILS PROVIDER ', "idempotencyKey"' ", 'cardcom:deal:1'")"

echo "S7 — NET = SETTLED − FEE (same currency), at commit"
refused "FEE 10.00 + NET 350.00 against SETTLED 370.00 (one transaction)" "DZS08|NET_MISMATCH" rt "$A" "$(f "$A" "$TA" FEE 10.00 ILS PROVIDER)" "$(f "$A" "$TA" NET 350.00 ILS BANK ', "externalTransactionId"' ", $BA")"
eq "nothing of the refused transaction is left" "$(rt "$A" "SELECT count(*) FROM $T WHERE \"paymentTransactionId\" = $TA AND \"kind\" IN ('FEE', 'NET')")" "0"
F1=$(rt "$A" "$(f "$A" "$TA" FEE 15.00 ILS PROVIDER) RETURNING \"id\"")
N1=$(rt "$A" "$(f "$A" "$TA" NET 355.00 ILS BANK ', "externalTransactionId"' ", $BA") RETURNING \"id\"")
ok "FEE 15.00 then NET 355.00 from the bank line (370.00 − 15.00): accepted"
refused "a correction of FEE alone that breaks the sum" "DZS08|NET_MISMATCH" rt "$A" "$(f "$A" "$TA" FEE 16.00 ILS MANUAL ', "note", "recordedByUserId", "supersedesId"' ", 'statement', $UA, $F1")"
rt "$A" "$(f "$A" "$TA" FEE 16.00 ILS MANUAL ', "note", "recordedByUserId", "supersedesId"' ", 'statement', $UA, $F1")" \
       "$(f "$A" "$TA" NET 354.00 ILS MANUAL ', "note", "recordedByUserId", "supersedesId"' ", 'statement', $UA, $N1")" >/dev/null
ok "FEE and NET corrected together (370.00 − 16.00 = 354.00): accepted"
rt "$B" "$(f "$B" "$TB" SETTLED 180.00 ILS PROVIDER ', "providerRate", "rateBase", "rateQuote"' ", 3.6, 'EUR', 'ILS'")" \
       "$(f "$B" "$TB" FEE 1.50 EUR PROVIDER)" "$(f "$B" "$TB" NET 180.00 ILS BANK ', "externalTransactionId"' ", $BB")" >/dev/null
ok "B: SETTLED ILS, FEE in EUR, NET ILS — different currencies, nothing computed, accepted"
# Race: writer 1 records SETTLED + FEE and holds its transaction open; writer 2 records an inconsistent NET.
# Writer 2 must wait for writer 1 (advisory lock), then see its committed facts and be refused at commit.
( PGPASSWORD="$LAB_PASSWORD" psql -X -q -At -v ON_ERROR_STOP=1 -U app_runtime_prod -d "$DB" \
    -c "BEGIN" -c "SELECT set_config('app.current_business_id', '$A', true)" \
    -c "$(f "$A" "$TX" SETTLED 30.00 ILS PROVIDER)" -c "$(f "$A" "$TX" FEE 1.00 ILS PROVIDER)" \
    -c "SELECT pg_sleep(3)" -c "COMMIT" >/dev/null ) &
bg=$!
sleep 1
t0=$(date +%s)
refused "race: NET 30.00 while SETTLED 30.00 + FEE 1.00 commit concurrently" "DZS08|NET_MISMATCH" rt "$A" "$(f "$A" "$TX" NET 30.00 ILS PROVIDER)"
waited=$(( $(date +%s) - t0 )); wait "$bg"
[ "$waited" -ge 1 ] || die "race: the second writer did not wait (${waited}s)"
ok "race: the second writer waited ${waited}s for the first, then was refused"
rt "$A" "$(f "$A" "$TX" NET 29.00 ILS PROVIDER)" >/dev/null; ok "race: NET 29.00 afterwards: accepted"
refused "REPEATABLE READ writer" "DZS09|SETTLEMENT_FACT_ISOLATION" \
  env PGPASSWORD="$LAB_PASSWORD" psql -X -q -At -v ON_ERROR_STOP=1 -U app_runtime_prod -d "$DB" \
    -c "BEGIN ISOLATION LEVEL REPEATABLE READ" -c "SELECT set_config('app.current_business_id', '$A', true)" \
    -c "$(f "$A" "$TI" FEE 2.00 ILS PROVIDER)" -c "COMMIT"

echo "S8 — append-only"
refused "runtime UPDATE" "permission denied" rt "$A" "UPDATE $T SET \"note\" = 'x' WHERE \"id\" = $S2"
refused "runtime DELETE" "permission denied" rt "$A" "DELETE FROM $T WHERE \"id\" = $S2"
refused "runtime TRUNCATE" "permission denied" rt "$A" "TRUNCATE $T"
refused "owner UPDATE" "DZS01|APPEND_ONLY" own "UPDATE $T SET \"amount\" = 1 WHERE \"id\" = $S2"
refused "owner DELETE" "DZS01|APPEND_ONLY" own "DELETE FROM $T WHERE \"id\" = $S2"
refused "superuser UPDATE" "DZS01|APPEND_ONLY" su "UPDATE $T SET \"recordedByUserId\" = NULL WHERE \"recordedByUserId\" IS NOT NULL"
refused "superuser TRUNCATE" "DZS01|APPEND_ONLY" su "TRUNCATE $T"
eq "recordedAt is the database's clock, not the writer's" \
  "$(rt "$A" "$(f "$A" "$TI" FEE 0 ILS PROVIDER ', "recordedAt"' ", '2000-01-01'") RETURNING (\"recordedAt\" > now() - interval '1 minute')::text")" "true"
M=$(rt "$A" "$(f "$A" "$TM" SETTLED 75.00 ILS MANUAL ', "note", "recordedByUserId"' ", 'deposit seen in the bank app', $UE") RETURNING \"id\"")
su "DELETE FROM \"User\" WHERE \"id\" = $UE"
eq "a user's erasure blanks recordedByUserId and keeps the fact" "$(su "SELECT coalesce(\"recordedByUserId\"::text, 'null') || '|' || \"amount\" || '|' || \"source\" FROM $T WHERE \"id\" = $M")" "null|75.00|MANUAL"
refused "deleting a transaction that has facts" "foreign key|violates" su "DELETE FROM \"PaymentTransaction\" WHERE \"id\" = $TI"
refused "deleting a bank line that a fact rests on" "foreign key|violates|immutable" su "DELETE FROM \"ExternalTransaction\" WHERE \"id\" = $BA"

echo "S9 — privileges"
eq "app_runtime: SELECT, INSERT and nothing else" \
  "$(su "SELECT string_agg(p, ',' ORDER BY p) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE has_table_privilege('app_runtime', 'public.\"PaymentSettlementFact\"', p)")" "INSERT,SELECT"
eq "app_auth: nothing" \
  "$(su "SELECT count(*) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE has_table_privilege('app_auth', 'public.\"PaymentSettlementFact\"', p)")" "0"
eq "PUBLIC: nothing on the table, the sequence or the functions" \
  "$(su "SELECT count(*) FROM (SELECT relacl FROM pg_class WHERE relname IN ('PaymentSettlementFact', 'PaymentSettlementFact_id_seq') UNION ALL SELECT proacl FROM pg_proc WHERE proname LIKE 'payment\_settlement\_fact\_%') a CROSS JOIN LATERAL aclexplode(a.relacl) x WHERE x.grantee = 0")" "0"
eq "no function of the migration is SECURITY DEFINER" "$(su "SELECT count(*) FROM pg_proc WHERE proname LIKE 'payment\_settlement\_fact\_%' AND prosecdef")" "0"
eq "app_runtime_prod is NOBYPASSRLS (the battery ran under RLS)" "$(su "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'app_runtime_prod'")" "f"

echo "BATTERY: $pass PASS, 0 FAIL"
