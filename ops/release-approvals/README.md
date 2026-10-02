# Release approvals for authority-changing migrations

`release-migrate` (once the gate in `docs/security/RELEASE_MIGRATE_AUTHORITY_GATE.md` is adopted) refuses to apply a migration that `scripts/ci/migration-security-classifier.mjs` classifies as **authority-changing** unless this directory holds `<migration_name>.json` **on the dispatched SHA**:

```json
{
  "migration": "20261005090000_business_tenant_write_rls",
  "sha256": "<sha256 of prisma/migrations/<name>/migration.sql, LF>",
  "decision": "https://github.com/<owner>/<repo>/pull/<n>#issuecomment-<id>",
  "approvedBy": "eldad8802-prog",
  "approvedAt": "2026-10-02T00:00:00Z",
  "preflightRun": 36925655282
}
```

The gate checks five things:

1. `sha256` equals the file. Any edit to the migration invalidates the approval.
2. `decision` links the owner's written decision.
3. `preflightRun` is a successful `prod-readonly-evidence.yml` run.
4. That run started after the migration reached `main`.
Separately, the run's `verify` step refuses unless `expected_migrations` equals exactly the migrations still pending.

Ordering rules:

- A record lands in its own PR, reviewed by the code owner.
- It never lands in the PR that adds its migration, because the evidence has to exist first.
- Migrations that are not authority-changing need no record. They still must be listed in `expected_migrations`.
