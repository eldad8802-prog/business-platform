# CI coverage inventory for `verify:*` — v1

Written during the D2/P7-W4D post-merge regression closure (PR #283), after a
W4D codemod leaked two unused `import type { Prisma }` lines into the
business-memory evidence adapter and **every branch check stayed green**. The
invariant that forbids those imports was ratified and has a working verifier —
it simply ran in no workflow.

## The blind spot, measured

At the time of writing: **64 `verify:*` scripts in `package.json`; exactly 1
(`verify:prisma-centralization`) is referenced by any workflow.** The only
workflow that runs on every PR besides the guard job is `release-ci-verify`,
which is explicitly REPORT-ONLY (`continue-on-error` on every step, non-required
status). So a ratified invariant can fail locally while PR CI is fully green.

## Classification (evidence-based)

Each script was executed in a worktree with **no `.env`**, no `DATABASE_URL`,
and a generated Prisma client. Passing under those conditions is the evidence
for "deterministic, offline, CI-wireable".

| Class | Count | Meaning |
| --- | --- | --- |
| Mandatory deterministic invariant | 52 | Static source scans / pure unit fixtures. No DB, no network, no secrets. Safe on every PR. |
| Environment-dependent / integration-only | 11 | Need a live Postgres. Several deliberately `ABORT (DB safety guard)` unless `TEST_DATABASE_URL` names an approved non-production DB — correct behavior, not a failure. |
| Broken verifier (baseline debt) | 1 | `verify:ria-policy-lineage-schema` — static, but its `RiaCanonicalReferent still has no @@unique` regex is greedy (`[\s\S]*` runs past the model's closing brace), so ANY later `@@unique` in `schema.prisma` trips it. The model itself has only `@@index([businessId])`. Failing since W4A added `Message @@unique(...)` (#270). |
| Obsolete / dead | 0 | None found. |

Integration-only set: `billing-issue-tenant-isolation`, `coupon-tenant`,
`gmail-refresh-token-upgrade`, `crm-attachments`, `crm-customer`,
`crm-customer-card`, `crm-notes`, `crm-subject`, `supplier`,
`whatsapp-webhook-pr2`, `whatsapp-webhook-pr3`.

## Wired in this PR

`verify:business-memory-evidence-adapter` now runs in the CI-1 guard job (the
canonical blocking workflow: pushes to `main` + all PRs to `main`), with a
negative self-proof that a synthetic leaked `import type { Prisma }` is caught.
It qualifies on every axis: pure `node:fs` + in-memory mappers, no DB, no
network, no secrets, sub-second.

## Follow-up ownership item (NOT done here)

The remaining **51** deterministic verifiers are still unwired. Wiring them is
deliberately out of scope for a regression-closure PR: it is a large change and
would surface unrelated pre-existing failures. Owner decision needed on
(a) wiring them as one aggregate CI job vs. per-domain jobs, (b) whether the
resulting check becomes branch-protection-required, and (c) fixing the
`ria-policy-lineage-schema` regex before it is wired, since it fails today.
