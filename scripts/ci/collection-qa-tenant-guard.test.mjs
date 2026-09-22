#!/usr/bin/env node
/**
 * Negative proof for the Collection QA tenant guard.
 *
 * A guard that has never refused anything is a guard nobody has tested. This
 * file takes the real provisioning SQL and the real identity file, mutates them
 * the ways a widened or misaimed change would, and requires the guard to exit
 * non-zero for every one of them — then requires it to PASS on the pristine
 * pair, so the refusals are not simply "this guard always fails".
 *
 * The identity now committed to the repository is the approved one, so the
 * pristine trio must PASS as it stands. "Unset" remains one of the refusals
 * below, reconstructed explicitly rather than read from the file — a refusal
 * that depends on the repository still being in an earlier state stops testing
 * anything the moment that state changes.
 *
 * Run: node scripts/ci/collection-qa-tenant-guard.test.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD = "scripts/ci/collection-qa-tenant-guard.mjs";
const SQL = "ops/tenant/collection-qa-tenant.sql";
const VERIFY = "ops/tenant/collection-qa-tenant-verify.sql";
const IDENTITY = "ops/tenant/collection-qa-tenant.identity.env";
const WORKFLOW = ".github/workflows/prod-create-collection-qa-tenant.yml";

const FIXTURE_EMAIL = "collection-qa-sandbox@example.test";

const dir = mkdtempSync(join(tmpdir(), "qa-tenant-guard-"));
const pristineSql = readFileSync(SQL, "utf8");
const pristineVerify = readFileSync(VERIFY, "utf8");
const pristineIdentity = readFileSync(IDENTITY, "utf8");
const pristineWorkflow = readFileSync(WORKFLOW, "utf8");

/** The identity file as it will look once the owner fixes the address. */
const resolvedIdentity = pristineIdentity.replace(
  /^COLLECTION_QA_EMAIL=.*$/m,
  `COLLECTION_QA_EMAIL=${FIXTURE_EMAIL}`
);

let failures = 0;
let passed = 0;

function runGuard({ sql, verify, identity, workflow }) {
  const sqlPath = join(dir, "provision.sql");
  const verifyPath = join(dir, "verify.sql");
  const identityPath = join(dir, "identity.env");
  const workflowPath = join(dir, "workflow.yml");
  writeFileSync(sqlPath, sql);
  writeFileSync(verifyPath, verify);
  writeFileSync(identityPath, identity);
  writeFileSync(workflowPath, workflow);

  try {
    const stdout = execFileSync(
      process.execPath,
      [
        GUARD,
        "--sql", sqlPath,
        "--verify", verifyPath,
        "--identity", identityPath,
        "--workflow", workflowPath,
      ],
      { encoding: "utf8" }
    );
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function mustRefuse(label, mutation) {
  const input = {
    sql: pristineSql,
    verify: pristineVerify,
    identity: resolvedIdentity,
    workflow: pristineWorkflow,
    ...mutation,
  };
  const { code, stdout } = runGuard(input);
  if (code === 0) {
    failures += 1;
    console.log(`  FAIL  the guard ACCEPTED: ${label}`);
    console.log(stdout.split("\n").filter((l) => l.includes("CONTAINMENT")).join("\n"));
  } else {
    passed += 1;
    console.log(`  ok    refused: ${label}`);
  }
}

function mustAccept(label, input) {
  const { code, stdout } = runGuard(input);
  if (code === 0) {
    passed += 1;
    console.log(`  ok    accepted: ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  the guard REFUSED: ${label}`);
    console.log(stdout);
  }
}

console.log("Collection QA tenant guard — negative proof\n");

// 1. The files exactly as the repository ships them must pass — identity
//    included. This is the case that says the tenant is provisionable at all,
//    and everything below is a deviation from it.
mustAccept("the repository's own files, unmodified", {
  sql: pristineSql,
  verify: pristineVerify,
  identity: pristineIdentity,
  workflow: pristineWorkflow,
});

mustAccept("the approved provisioning SQL with a fixture address", {
  sql: pristineSql,
  verify: pristineVerify,
  identity: resolvedIdentity,
  workflow: pristineWorkflow,
});

// 2. Widening the SQL to another kind of mutation.
mustRefuse("an UPDATE added to the transaction", {
  sql: pristineSql.replace(
    /COMMIT;/,
    'UPDATE "User" SET "role" = \'ADMIN\' WHERE "email" = :\'qa_email\';\n\nCOMMIT;'
  ),
});

mustRefuse("a DELETE added to the transaction", {
  sql: pristineSql.replace(
    /COMMIT;/,
    'DELETE FROM "AuthSession" WHERE "userId" IS NOT NULL;\n\nCOMMIT;'
  ),
});

mustRefuse("an ALTER added to the transaction", {
  sql: pristineSql.replace(
    /COMMIT;/,
    'ALTER TABLE "User" DISABLE ROW LEVEL SECURITY;\n\nCOMMIT;'
  ),
});

mustRefuse("a TRUNCATE added to the transaction", {
  sql: pristineSql.replace(/COMMIT;/, 'TRUNCATE "PaymentRequest";\n\nCOMMIT;'),
});

mustRefuse("a GRANT added to the transaction", {
  sql: pristineSql.replace(/COMMIT;/, "GRANT ALL ON \"User\" TO PUBLIC;\n\nCOMMIT;"),
});

// NOTE: this replacement is written as a FUNCTION, not a string. In a JS
// replacement string "$$" means a literal "$" and "$2" means a capture group,
// so a string here inserts something other than the mutation being tested — and
// the guard gets credited with catching a defect that was never present. That
// is exactly what happened here: the case passed while the guard was blind to
// real dollar-quoted blocks.
mustRefuse("a DO block, which would hide arbitrary SQL from this guard", {
  sql: pristineSql.replace(
    /COMMIT;/,
    () => "DO $$ BEGIN PERFORM 1; END $$;\n\nCOMMIT;"
  ),
});

// 3. Widening the SQL to write a third table — the "while we are in there" edit.
mustRefuse("a third INSERT, into an unrelated table", {
  sql: pristineSql.replace(
    /COMMIT;/,
    'INSERT INTO "BusinessProfile" ("businessId", "updatedAt") SELECT 1, now();\n\nCOMMIT;'
  ),
});

// 4. Breaking idempotency — the mutation that yields two QA tenants.
mustRefuse("the NOT EXISTS guards removed", {
  sql: pristineSql.replace(/NOT EXISTS/g, "EXISTS"),
});

mustRefuse("the user row no longer drawn from the business this run created", {
  sql: pristineSql.replace(/FROM new_business nb/i, 'FROM "Business" nb'),
});

mustRefuse("ON CONFLICT turning the insert into an in-place write", {
  sql: pristineSql.replace(
    /RETURNING id, "businessId"/,
    'ON CONFLICT ("email") DO UPDATE SET "password" = :\'qa_password_hash\' RETURNING id, "businessId"'
  ),
});

// 5. Breaking atomicity or leaving the transaction open.
mustRefuse("the COMMIT removed", {
  sql: pristineSql.replace(/COMMIT;/, ""),
});

mustRefuse("the BEGIN removed, leaving two autocommitted writes", {
  sql: pristineSql.replace(/BEGIN;/, ""),
});

// 6. Secrets baked into git.
mustRefuse("the email baked into the SQL as a literal", {
  sql: pristineSql.replace(/:'qa_email'/g, `'${FIXTURE_EMAIL}'`),
});

mustRefuse("a bcrypt hash baked into the SQL as a literal", {
  sql: pristineSql.replace(
    /:'qa_password_hash'/,
    () => "'$2b$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012'"
  ),
});

// 7. The stop gate itself: the address must be fixed before anything runs.
mustRefuse("the login email left as the placeholder", {
  identity: resolvedIdentity.replace(
    /^COLLECTION_QA_EMAIL=.*$/m,
    () => 'COLLECTION_QA_EMAIL="__COLLECTION_QA_EMAIL_NOT_SET__"'
  ),
});

mustRefuse("the login email emptied", {
  identity: resolvedIdentity.replace(
    /^COLLECTION_QA_EMAIL=.*$/m,
    () => 'COLLECTION_QA_EMAIL=""'
  ),
});

mustRefuse("an unfolded (mixed-case) login email that login would not find", {
  identity: resolvedIdentity.replace(FIXTURE_EMAIL, "Collection-QA-Sandbox@Example.Test"),
});

mustRefuse("a login email that is not shaped like an address", {
  identity: resolvedIdentity.replace(FIXTURE_EMAIL, "collection-qa-sandbox"),
});

// 8. Repurposing the workflow for a different tenant — the whole reason the
//    approved names live in the guard rather than in the data file.
mustRefuse("a different business name", {
  identity: resolvedIdentity.replace(
    /^COLLECTION_QA_BUSINESS_NAME=.*$/m,
    "COLLECTION_QA_BUSINESS_NAME=הוביז"
  ),
});

mustRefuse("a login email pointed at a person's mailbox", {
  identity: resolvedIdentity.replace(FIXTURE_EMAIL, "eldad@example.com"),
});

// 9. How the workflow HANDS the variables to psql. These are not hypothetical:
//    the first production run failed at the pre-flight step because it was
//    written as `psql -c "... = :'qa_email'"`, and psql expands its variables
//    only in input it reads. Nothing was written — the provisioning step never
//    started — but a machine could have caught it here, so now it does.
mustRefuse("a psql -c carrying a psql variable, as the failed run had", {
  workflow: pristineWorkflow.replace(
    /- name: Install psql client/,
    () =>
      `- name: Careless pre-flight\n        run: |\n          psql "$DIRECT_URL" -tAX -c "SELECT count(*) FROM \\"User\\" WHERE \\"email\\" = :'qa_email'"\n\n      - name: Install psql client`
  ),
});

// A plain string, not a regex: the line being replaced is dense with
// backslashes, and an escaping mistake here would leave the mutation unapplied
// and the guard credited with a refusal it never made. (That is what happened
// on the first attempt.)
mustRefuse("the credential passed to psql as an argument", {
  workflow: pristineWorkflow.replace(
    'printf "\\\\set qa_password_hash',
    () => '--set=qa_password_hash="$QA_PASSWORD_HASH" # printf "\\\\set unused'
  ),
});

mustRefuse("the production-db environment gate removed", {
  workflow: pristineWorkflow.replace(/environment: production-db/, () => "# ungated"),
});

mustRefuse("the host allowlist removed", {
  workflow: pristineWorkflow.replace(/ep-flat-brook-am4bhq1y/g, () => "any-host"),
});

mustRefuse("an input added, making it a generic provisioning tool", {
  workflow: pristineWorkflow.replace(
    /  workflow_dispatch:/,
    () => "  workflow_dispatch:\n    inputs:\n      email:\n        required: true"
  ),
});

// 10. The verification file must stay read-only and must never return the hash.
mustRefuse("a write added to the read-only verification file", {
  verify: pristineVerify.replace(
    /ROLLBACK;/,
    'INSERT INTO "User" ("email") SELECT :\'qa_email\';\n\nROLLBACK;'
  ),
});

mustRefuse("the verification file selecting the password hash itself", {
  verify: pristineVerify.replace(/length\(u\."password"\)/, 'u."password"'),
});

console.log(
  `\n${passed} passed, ${failures} failed — ${failures === 0 ? "NEGATIVE PROOF: PASS" : "NEGATIVE PROOF: FAIL"}`
);
process.exit(failures === 0 ? 0 : 1);
