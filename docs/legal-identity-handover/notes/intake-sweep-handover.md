# Handover: `/api/intake/sweep` fails intermittently in Production

From: session dd (legal identity). Read-only observation only — no code was changed and no investigation was done
inside the intake code. Owner: the leads / intake track (L1 #654, #661, 81f5e24d); no session currently active on it.

## What the Production logs show (Vercel, read-only, 2026-11-10 → 2026-11-16)
- 27 log entries for `[intake-sweep]` in 7 days; failures several times a day (e.g. 11-16 02:30, 10:00, 22:10 UTC;
  11-15 20:30; 11-14 16:10, 16:30; 11-13 08:30, 22:10).
- Each failure: `[intake-sweep] run failed { error: 'PrismaClientKnownRequestError' }`.
- Around them: `prisma:error Invalid prisma.whatsAppConnection.findMany() invocation` and
  `prisma:error Error in PostgreSQL connection: Error { kind: Closed, … }`.
- 11-10 00:20: `[intake-sweep] unhealthy { via: 'qstash', job: ['business_errors', …] }`.

## Not related to the legal-identity migration
The failures start at least 6 days before `20261128090000` was applied (11-16 22:21 UTC) and recur at the same rate
before and after it. The migration does not touch WhatsAppConnection or the intake tables.

## Likely direction (hypothesis, unverified)
The same shape as the task-reminder failure fixed by the notifications track in #1141 ("reminder dispatch survives
dead pooled connections"): a pooled connection closed by the server is reused by the sweep's first query. Worth
checking the sweep with the same approach (retry once on a closed connection / per-business isolation).

## What is needed
An owner decision on which session takes it (the leads/intake track, or the notifications session that fixed the
same pattern), then a read-only diagnosis of the Prisma error code (P1017 / P2024 / …) before any change.
