# Release approvals for authority-changing migrations

`release-migrate` (once the gate in `docs/security/RELEASE_MIGRATE_AUTHORITY_GATE.md` is adopted) refuses to apply a migration that `scripts/ci/migration-security-classifier.mjs` classifies as **authority-changing** unless this directory holds `<migration_name>.json` **on the dispatched SHA**:

```json
{
  "migration": "20261006090000_business_tenant_write_rls",
  "sha256": "<sha256 of prisma/migrations/<name>/migration.sql, LF>",
  "decision": "https://github.com/<owner>/<repo>/pull/<n>#issuecomment-<id>",
  "approvedBy": "eldad8802-prog",
  "approvedAt": "2026-10-02T00:00:00Z",
  "preflightRun": 123456789,
  "preflightFile": "ops/evidence/business-runtime-columns-preflight.sql"
}
```

The gate checks four things:

1. `sha256` equals the file. Any edit to the migration invalidates the approval.
2. `decision` links the owner's written decision.
3. `preflightRun` is a successful, manually dispatched `prod-readonly-evidence.yml` run from `main`, whose title (its run-name) names `preflightFile`. Runs from before the gate have no run-name and never qualify.
4. That run started after the migration reached `main`.
5. Optional `releaseSet`: the complete set, in Prisma order, that the owner approved to be released **together in one run**. When present, any release touching it must name exactly that set (a subset, a superset or another order is refused), and a later change or removal of the binding must carry `"supersedes": "<previous decision URL>"` and a new `decision` link. Absent: the generic prefix behaviour is unchanged. **Tombstone rule:** a record that has ever carried `releaseSet` must never be deleted (not even after a valid supersession). Deleting it refuses every release touching its migration or any set it ever bound, until the file is restored. Change or drop a binding inside the file instead. Records that never carried `releaseSet` may be deleted. The gate needs full git history; a shallow clone is refused. See `docs/security/RELEASE_MIGRATE_AUTHORITY_GATE.md` §8.
Separately, the run's `verify` step refuses unless `expected_migrations` equals exactly the migrations still pending.

Ordering rules:

- A record lands in its own PR, reviewed by the code owner.
- It never lands in the PR that adds its migration, because the evidence has to exist first.
- Migrations that are not authority-changing need no record. They still must be listed in `expected_migrations`.
