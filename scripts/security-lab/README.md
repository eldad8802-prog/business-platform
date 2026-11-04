# Shared security lab

A database with Production's privilege model, built from **every** migration on the checkout. Use it to test
RLS, grants, SECURITY DEFINER functions and new migrations as the real roles, and to compare environments.

| File | What it is |
|---|---|
| `build-lab.sh <db>` | Builds the lab: non-superuser `lab_owner` (CREATEROLE + BYPASSRLS, the shape of `neondb_owner`), the NOLOGIN groups `app_runtime`, `app_auth`, `app_admin`, `app_ctlplane`, `task_maintenance` (created before the first migration), Production's default privileges, one LOGIN role per group (`<group>_lab`, INHERIT), then every migration with psql, in order, recorded in `_prisma_migrations`. |
| `privilege-model.sql` | The canonical model: one normalised line per fact (RLS flags, policies, table / column / sequence privileges, SECURITY DEFINER functions, EXECUTE, owner default privileges, direct grants to LOGIN roles, BYPASSRLS roles). Privileges are ACL letters: `r` read, `a` append, `w` write, `d` remove, `U` usage. |
| `gen-production-assert.mjs` | Generates `ops/evidence/privilege-model-production-assert.sql` from the baseline: Production vs the lab, section by section, printing only PASS / FAIL, counts and booleans (the repository is public). |
| `../../ops/security/privilege-model.baseline.txt` | The model of a lab built from this checkout. CI (`security-lab.yml`) rebuilds the lab and fails when the model differs. |

## Run it locally

```bash
export PGHOST=localhost PGPORT=5432 SUPER=postgres PGPASSWORD=<superuser password> LAB_PASSWORD=lab
bash scripts/security-lab/build-lab.sh seclab
{ cat scripts/security-lab/privilege-model.sql; echo 'SELECT line FROM model ORDER BY line COLLATE "C";'; } > /tmp/pm.sql
PGPASSWORD=lab psql -X -A -t -q -U lab_owner -d seclab -f /tmp/pm.sql > /tmp/pm-lab.txt
diff -u ops/security/privilege-model.baseline.txt /tmp/pm-lab.txt
```

Connect as the application would: `app_runtime_lab`, `app_auth_lab`, `app_admin_lab`, `app_ctlplane_lab`
(password `$LAB_PASSWORD`). Never test tenant isolation as `lab_owner`: it bypasses RLS, like `neondb_owner`.

## When a migration changes privileges

1. Build the lab from your branch and dump the model (above).
2. Read the diff. Every added line must follow `docs/architecture/permissions-contract.md`.
3. Replace the baseline with the lab's model and regenerate the Production file:
   `node scripts/security-lab/gen-production-assert.mjs ops/security/privilege-model.baseline.txt`.
4. After the migration is applied in Production, run `prod-readonly-evidence.yml` with
   `ops/evidence/privilege-model-production-assert.sql`: every section PASS.

## Known differences between environments

Production and Preview may hold privileges that no migration gives. They are listed in `EXTRA` in
`gen-production-assert.mjs`, reported one by one (`extra_NN_present`) and left out of the hashes. Today that is
18 `app_admin` / `app_ctlplane` read privileges applied by `scripts/security/d2-*-grants.sql`, plus the direct
grants of Preview's legacy `app_runtime_preview_p4b` login role (section L). Closing them is part of the Admin
narrowing (Part 2).
