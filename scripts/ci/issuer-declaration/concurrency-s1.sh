#!/usr/bin/env bash
# S1 (owner 2026-11-12) — two REAL sessions: a user joins a one-user business while its sole user is declaring.
#   Session A: BEGIN; INSERT a second "User" into the business; hold 3 s; COMMIT.
#   Session B (1 s later, as the NOBYPASSRLS runtime): files a SOLE_USER_VERIFIED declaration.
# With the business-row lock in issuer_declaration_chain_guard, B waits for A and then counts 2 users → refused.
# Without it, B counts 1 (A's row is not committed yet) and a "sole user" declaration is stored next to a second user.
#   usage: concurrency-s1.sh <owner database url> <business id> <expect: REFUSED|ACCEPTED>
set -uo pipefail
URL="$1"; B="$2"; WANT="$3"
PSQL="${PSQL:-psql}"
U1=$((B * 10 + 1)); U2=$((B * 10 + 2))
"$PSQL" "$URL" -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO "Business"("id","name","createdAt","updatedAt") VALUES ($B,'s1-lab',now(),now());
INSERT INTO "User"("id","email","password","businessId","role","createdAt","updatedAt") VALUES ($U1,'s1-$B-a@example.test','x',$B,'USER',now(),now());
SQL
( "$PSQL" "$URL" -v ON_ERROR_STOP=1 -q -c "BEGIN" \
    -c "INSERT INTO \"User\"(\"id\",\"email\",\"password\",\"businessId\",\"role\",\"createdAt\",\"updatedAt\") VALUES ($U2,'s1-$B-b@example.test','x',$B,'USER',now(),now())" \
    -c "SELECT pg_sleep(3)" -c "COMMIT" > /dev/null ) &
A=$!
sleep 1
OUT=$("$PSQL" "$URL" -q -At 2>&1 <<SQL
SET ROLE app_runtime;
SELECT set_config('app.current_business_id', '$B', false);
INSERT INTO "BusinessIssuerDeclaration"("businessId","version","kind","track","legalForm","vatStatus","legalName","idType","idNumber","address","phone","email","effectiveFrom","authorizedUserId","authorityBasis","declaredByUserId","declarantName","declarantCapacity","statementVersion","statementSha256","reauthMethod","reauthAt")
VALUES ($B,1,'INITIAL','EXEMPT_DEALER','INDIVIDUAL','EXEMPT','פלוני','ISRAELI_ID','000000018','רחוב 1','050','s1@example.test',now(),$U1,'SOLE_USER_VERIFIED',$U1,'בעל העסק','בעל העסק','issuer-declaration-he-v1',repeat('a',64),'EMAIL_LINK',now());
SQL
)
wait $A
USERS=$("$PSQL" "$URL" -At -c "SELECT count(*) FROM \"User\" WHERE \"businessId\" = $B")
DECLS=$("$PSQL" "$URL" -At -c "SELECT count(*) FROM \"BusinessIssuerDeclaration\" WHERE \"businessId\" = $B")
if echo "$OUT" | grep -q "ISSUER_AUTHORITY_SOLE_USER_REQUIRED"; then GOT=REFUSED; else GOT=ACCEPTED; fi
echo "S1 business $B: users=$USERS declarations=$DECLS outcome=$GOT (expected $WANT)"
[ "$GOT" = "$WANT" ] || { echo "$OUT"; exit 1; }
