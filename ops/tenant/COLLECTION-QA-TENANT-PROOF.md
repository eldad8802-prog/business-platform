# Collection QA tenant — pre-execution proof

One permanent tenant, created once, for proving that a payment reaches the
settlement engine in Production. This document is what the owner approves
before the production-db gate, and it records what was established **before**
anything was written, not after.

Everything below is derived from `origin/main` and from runs that are part of
this PR's CI. Nothing here is an inference from the Production database: the
tenant does not exist yet.

## What will be created

| | |
|---|---|
| Business | `QA COLLECTION SANDBOX — אין להשתמש` |
| User | one, role `USER`, linked to that business |
| Login address | fixed in `collection-qa-tenant.identity.env` before execution |
| Credential | bcrypt cost 10, from the `production-db` secret `COLLECTION_QA_PASSWORD_HASH` |
| Anything else | nothing — no billing identity, no provider connection, no customer, no document |

## Why not registration

`POST /api/auth/register` is the only path in the product that creates a
Business and a User. A search of `origin/main` outside tests finds exactly one
other `user.create` — none: the route's own, in `lib/auth/signup.ts:98`. There
is no onboarding path, no invitation, no seed, and `platform-admin/businesses`
is `GET` only.

That route is closed. `PUBLIC_SIGNUP_ENABLED` is `false` in Production and the
gate is fail-closed and evaluated before the body is parsed. Opening it to
create one account would accept registrations from anyone for as long as it
stayed open, so it stays shut, and this file writes the same two rows the route
would have written.

## The columns, and where they come from

Derived mechanically in `scripts/ci/collection-qa-tenant-schema-contract.test.mjs`
from `prisma/schema.prisma` and the migration DDL — not read once and copied.

**Business** — required with no default: `name`, `updatedAt`.
**User** — required with no default: `email`, `password`, `businessId`, `updatedAt`.

`updatedAt` carries no database default on either table (`CREATE TABLE` in
`20260330142739_core_data_layer_v1` and `20260408175347_add_user_foundation`);
Prisma maintains it in the application layer, so a hand-written insert must
supply it. `createdAt` defaults to `CURRENT_TIMESTAMP` and is written anyway,
for symmetry with what `createAccount` produces.

**Inherited, never set by the SQL**: `role` → `USER`, `tokenVersion` → `0`,
`loginCount` → `0`, `lastLoginAt` → `null`. A hand-set default is a default that
can disagree with registration, so the SQL supplies none of them and the guard
refuses the file if it starts to.

**The link**: `User.businessId` → `Business.id`, and `User.email` is unique.
Identity is keyed on the address, not on the business name.

## The credential

`lib/auth/signup.ts` hashes at `BCRYPT_ROUNDS = 10`;
`app/api/auth/login/route.ts` verifies with `bcrypt.compare(password, user.password)`
after folding the address with `normalizeEmail`. The shape the workflow enforces
lives in one module, `scripts/ci/collection-qa-tenant-hash-shape.mjs`, so the
check in the workflow and the test that justifies it cannot drift.

`scripts/ci/collection-qa-tenant-hash-compat.test.mjs` hashes with the same
library and cost, verifies with the same call, and proves the shape refuses an
empty secret, a truncated hash, a hash with a stray newline or surrounding
whitespace, a plaintext password, and a hash at any other cost.

The plaintext never exists anywhere but the owner's machine. The hash reaches
`psql` through stdin, never as an argument, and is never echoed.

## That the account can actually log in

`ops/tenant/collection-qa-tenant-lab.mts` runs the real SQL against a throwaway
PostgreSQL and then calls the **real login route** against the row it produced:
login succeeds, returns this tenant, mints a token, sets the refresh cookie,
writes exactly one `AuthSession`, stamps `loginCount = 1`, leaves the generation
at 0 — and refuses a wrong password. 38 assertions, all green.

## That nothing else is required for correctness

Registration's only side effects beyond the two rows are the session token it
mints for the browser and a `ProductUsageEvent`. The telemetry writer swallows
its own errors and nothing reads it back for correctness, so an account created
without a signup event behaves identically. The token is minted at login
instead.

## Tenant isolation

Every tenant policy in the migration history is the same predicate:

```
"businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
```

No policy names a tenant, and none enumerates tenants through an `IN` list —
asserted, not assumed. A new business is therefore isolated by exactly the same
rule as every existing one, with nothing to configure and no exception to grant.
`Business` and `User` themselves sit outside RLS by design (see
`lib/prisma-auth.ts`): login resolves a user before any tenant id exists.

## Containment

`scripts/ci/collection-qa-tenant-guard.mjs` reads the SQL before a connection is
opened and refuses unless it is still: one `BEGIN`, one `COMMIT`, exactly two
`INSERT`s (one `Business`, one `User`), both `INSERT ... SELECT` with their
idempotency guards, no `UPDATE`/`DELETE`/`DROP`/`ALTER`/`TRUNCATE`/`GRANT`, no
dollar-quoted block, no `ON CONFLICT`, and no email or credential literal in the
file. It also pins the approved names itself, so the workflow cannot be aimed at
another tenant by editing a data file.

`scripts/ci/collection-qa-tenant-guard.test.mjs` proves the refusals are real by
making each of those mutations and requiring a non-zero exit — 22 cases,
including one that reads the guard's own blind spot: a widened SQL that a
whole-file search would have accepted.

## Idempotency

The user row is inserted `FROM new_business` — the business row this statement
itself created. If the business is not created, the user cannot be. The business
is created only when neither the address nor the name already exists. Proven in
the lab: a second identical run inserts nothing, and a run against a half-state
(the business present, no user) inserts nothing either, rather than attaching an
owner to a tenant it did not create.

## After provisioning — the owner's steps, through the product

1. Log in with the QA credentials.
2. Complete the billing identity at `/business` (required before any receipt).
3. Connect CardCom **test terminal 1000** at `/settings/connections`.
4. Create a small request at `/collection/new` and pay it with a test card.

## Standing facts about this tenant

- It is **never deleted**. Deleting a `Business` cascades its `User` and would
  take financial rows with it. If it is ever retired, it is archived.
- Its documents are permanent and numbered in **its own** sequence. No real
  business's numbering is affected.
- It **will appear** in cross-tenant evidence queries, which count every
  business. The name is deliberately unmistakable so it can be filtered.
- It is an ordinary tenant in every other respect: no bypass, no special-case
  code, no feature override.
