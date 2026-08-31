# Supplier domain — runtime verification harness

Service-level tests live next to the services (`npm run verify:supplier-domain-wiring`).
These three scripts are the layer above that: they drive a **running server over real
HTTP** and a **real browser**, because the four bugs this work fixed were all wiring
bugs — every individual function was fine, and only the connections between them were
broken. A test that imports a service directly cannot see that class of failure.

## Running

```bash
# 1. Start the app (production build gives honest timings)
npm run build && npx next start -p 3721

# 2. Seed two isolated tenants and mint tokens
export E2E_TOKENS=$(npx tsx --env-file=.env .e2e/seed-tenants.ts | tail -1)

# 3. API end-to-end: supplier → PO → receipt → inventory → supplier card
E2E_BASE=http://localhost:3721 node .e2e/supplier-e2e.mjs

# 4. Mobile at 390px (add E2E_SUPPLIER_ID=<id> to include a supplier card)
E2E_BASE=http://localhost:3721 node .e2e/mobile-check.mjs
```

`seed-tenants.ts` creates the accounts directly because `/api/auth/register` is
rate-limited to 3/hour/IP — correct for a public signup route, unusable as test
setup. Everything the run actually asserts still goes over HTTP.

## Known environment limitation (NOT a product bug)

The dev `DATABASE_URL` ends in `pgbouncer=true&connection_limit=1`. The supplier
card fires four requests in parallel (supplier, purchase history, notes,
attachments) and each opens a tenant transaction, so with a single pooled
connection some of them fail to acquire one:

```
400 {"error":"Transaction API error: Unable to start a transaction in the given time."}
```

This reproduces with **none** of the supplier endpoints involved — four concurrent
requests to `/api/inventory/items`, `/api/inventory/suppliers`, etc. produce the
same error — so it is a property of the local pooled URL, not of this code. Raising
`connection_limit` locally makes the card render completely.

Sequential runs (both scripts above) are unaffected.
