#!/usr/bin/env bash
# Subscriptions stage C — concurrency lab. Run AFTER the migration (and the SQL lab), as the migration owner, with the
# PG* environment of the lab database. Proves under real parallel connections:
#   A. 40 consumers race for a quota of 5 under ENFORCE: exactly 5 are COUNTED, 35 DENIED; counter = ledger = 5.
#   B. 20 parallel retries of ONE unit: it is counted once (1 COUNTED, 19 DUPLICATE; counter = 1).
#   C. 30 parallel distinct units in SHADOW for the same customer: all recorded, the counter equals the ledger sum.
# Leaves nothing behind. Prints CONCURRENCY_LAB_OK.
set -euo pipefail
B=930050
psql -v ON_ERROR_STOP=1 -q \
  -c "INSERT INTO \"Business\" (\"id\", \"name\", \"createdAt\", \"updatedAt\") VALUES ($B, 'lab race', now(), now());" \
  -c "INSERT INTO \"PlatformSubscription\" (\"businessId\", \"accountType\", \"status\", \"plan\", \"catalogVersion\", \"source\", \"updatedAt\") VALUES ($B, 'CUSTOMER', 'ACTIVE', 'BASIC', '2026-11-20', 'ADMIN', now());"

consume() { # metric unit enforce
  psql -tA -q -v ON_ERROR_STOP=1 \
    -c "SET ROLE app_runtime" \
    -c "SELECT set_config('app.current_business_id', '$B', false)" \
    -c "SELECT outcome FROM public.usage_consume('$1', '$2', 1, 'lab.race', false, $3)" | tail -n 1
}

workdir=$(mktemp -d)
# A. BASIC accountant_emails quota = 5
for i in $(seq 1 40); do consume accountant_emails "race:$i" true > "$workdir/a$i" & done; wait
counted=$(cat "$workdir"/a* | grep -c '^COUNTED$' || true)
denied=$(cat "$workdir"/a* | grep -c '^DENIED$' || true)
used=$(psql -tAc "SELECT \"used\" FROM \"BusinessUsageCounter\" WHERE \"businessId\" = $B AND \"metric\" = 'accountant_emails'")
ledger=$(psql -tAc "SELECT count(*) FROM \"BusinessUsageEvent\" WHERE \"businessId\" = $B AND \"metric\" = 'accountant_emails'")
echo "A: counted=$counted denied=$denied used=$used ledger=$ledger"
test "$counted" = 5 && test "$denied" = 35 && test "$used" = 5 && test "$ledger" = 5

# B. one unit, 20 parallel retries
for i in $(seq 1 20); do consume document_uploads "same-unit" true > "$workdir/b$i" & done; wait
counted=$(cat "$workdir"/b* | grep -c '^COUNTED$' || true)
dup=$(cat "$workdir"/b* | grep -c '^DUPLICATE$' || true)
used=$(psql -tAc "SELECT \"used\" FROM \"BusinessUsageCounter\" WHERE \"businessId\" = $B AND \"metric\" = 'document_uploads'")
echo "B: counted=$counted duplicate=$dup used=$used"
test "$counted" = 1 && test "$dup" = 19 && test "$used" = 1

# C. shadow: 30 distinct units over a quota of 5 → all recorded, counter = ledger
for i in $(seq 1 30); do consume accountant_packages "pkg:$i" false > "$workdir/c$i" & done; wait
counted=$(cat "$workdir"/c* | grep -c '^COUNTED$' || true)
used=$(psql -tAc "SELECT \"used\" FROM \"BusinessUsageCounter\" WHERE \"businessId\" = $B AND \"metric\" = 'accountant_packages'")
over=$(psql -tAc "SELECT count(*) FROM \"BusinessUsageEvent\" WHERE \"businessId\" = $B AND \"metric\" = 'accountant_packages' AND \"verdict\" = 'OVER_SHADOW'")
echo "C: counted=$counted used=$used over_shadow=$over"
test "$counted" = 30 && test "$used" = 30 && test "$over" = 27

psql -v ON_ERROR_STOP=1 -q -c "DELETE FROM \"Business\" WHERE \"id\" = $B;"
rm -rf "$workdir"
echo CONCURRENCY_LAB_OK
