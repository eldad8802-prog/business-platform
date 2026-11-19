# Tax-classification readiness lab (PR-0)

Tests only. No product code, no baseline, no migration. Synthetic data on a throwaway PostgreSQL.

| file | what it exercises | via |
|---|---|---|
| `battery.mts` | every supported classification (exempt dealer, licensed dealer, company, missing, incomplete) × every billing document type: create → edit → issue → numbering → saved state → PDF (real route) → re-read; classification change with open drafts; allocation outcomes; settlement receipt; parallel issuance; isolation | API route handlers (signed tokens), services where no route exists, a few static reads |
| `ui.e2e.mts` | what the owner is offered and told on screen | a real browser against `next dev` |
| `lab-kit.mts` | verdict ledger, RLS replay, network trap, evidence | — |

## Verdicts

- **OK** — the needed behaviour, observed.
- **DEFECT** — a reproduced defect. The check *passes because the defect reproduced*; a fix turns it red and the
  expectation is updated on purpose in the fixing PR.
- **OBSERVED** — current behaviour recorded for a product or legal decision. Not a verdict.
- **UNTESTED** — a gap this lab cannot exercise. Never counted as passing.

Checks tagged `legal` depend on a rule that still needs an official source or the accountant.

## Isolation

- Battery connected as a NOBYPASSRLS role; every RLS statement the migrations ship is replayed first.
- Production's pilot settings: `BILLING_AUTHORITY_RUNTIME_ENVIRONMENT=PRODUCTION`, pilot list `9`,
  `OPERATIONS=oauth`. Lab businesses start at id 1000 — never the pilot business.
- Allocation outcomes: the real execution service and state transitions, only the HTTP request replaced by a
  local fake (calls counted).
- Network: in-process socket/fetch trap (the battery fails on any attempt); in CI, iptables rejects every
  non-loopback packet from group `labnet`, under which the battery and the app run.

## Run locally

```
DATABASE_URL=<runtime NOBYPASSRLS> DIRECT_URL=… AUTH_DATABASE_URL=… RLS_ADMIN_URL=<owner> \
AUTH_TOKEN_SECRET=<synthetic ≥32> STORAGE_PROVIDER=local LOCAL_STORAGE_ROOT=… BILLING_PDF_STORAGE_ROOT=… \
LAB_EVIDENCE_DIR=… npx tsx .tax-classification-lab/battery.mts
```

Evidence: `results.json`, `results.md`, `pdf/*.pdf` + extracted text, `allocation/*.json`, `settlement/*.json`,
`ui/*.png`, `ui/ui-results.json`.
