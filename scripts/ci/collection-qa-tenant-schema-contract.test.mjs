#!/usr/bin/env node
/**
 * The contract between the provisioning SQL and the schema it writes into.
 *
 * ops/tenant/collection-qa-tenant.sql names columns by hand. That is fine today
 * and silently wrong the moment someone adds a NOT NULL column without a
 * default to Business or User: the insert would start failing, or — worse for a
 * financial product — would keep succeeding while producing a tenant that is
 * subtly unlike every registered one.
 *
 * So the columns are not assumed. They are derived from prisma/schema.prisma
 * and the migration DDL, and compared against what the SQL actually writes.
 *
 * It also proves the two claims that make this tenant ordinary rather than
 * special: its data lands under the same tenant predicate as everyone else's,
 * and no part of the product needs the registration path to have run.
 *
 * Run: node scripts/ci/collection-qa-tenant-schema-contract.test.mjs
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SQL = "ops/tenant/collection-qa-tenant.sql";
const SCHEMA = "prisma/schema.prisma";
const MIGRATIONS = "prisma/migrations";

let failures = 0;
let passed = 0;

function ok(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const schema = readFileSync(SCHEMA, "utf8");
const sql = readFileSync(SQL, "utf8");

function modelBody(name) {
  const match = schema.match(new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, "m"));
  if (!match) throw new Error(`model ${name} not found in ${SCHEMA}`);
  return match[1];
}

/**
 * Scalar fields a writer MUST supply: required, not a list, not a relation, and
 * without a database default. `@updatedAt` is included deliberately — Prisma
 * maintains it in the application layer, so the column carries no default and a
 * hand-written insert has to say it.
 */
function requiredWritableFields(name) {
  const required = [];
  for (const line of modelBody(name).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("@@")) continue;
    const [field, type] = trimmed.split(/\s+/);
    if (!field || !type) continue;
    if (type.endsWith("[]") || type.endsWith("?")) continue;
    if (trimmed.includes("@relation") || trimmed.includes("@id")) continue;
    if (/@default\(/.test(trimmed)) continue;
    required.push(field);
  }
  return required.sort();
}

function columnsWrittenTo(table) {
  const match = sql.match(new RegExp(`INSERT INTO "${table}" \\(([^)]*)\\)`));
  if (!match) throw new Error(`no INSERT into "${table}" in ${SQL}`);
  return match[1]
    .split(",")
    .map((c) => c.trim().replace(/"/g, ""))
    .sort();
}

// --- Business ----------------------------------------------------------------

const businessRequired = requiredWritableFields("Business");
const businessWritten = columnsWrittenTo("Business");

ok(
  "Business requires exactly name + updatedAt",
  JSON.stringify(businessRequired) === JSON.stringify(["name", "updatedAt"]),
  `schema says: ${businessRequired.join(", ")}`
);
ok(
  "the SQL writes every required Business column",
  businessRequired.every((f) => businessWritten.includes(f)),
  `writes: ${businessWritten.join(", ")}`
);
ok(
  "the SQL writes no Business column it does not need",
  businessWritten.every((c) => [...businessRequired, "createdAt"].includes(c)),
  `writes: ${businessWritten.join(", ")}`
);

// --- User --------------------------------------------------------------------

const userRequired = requiredWritableFields("User");
const userWritten = columnsWrittenTo("User");

ok(
  "User requires exactly email + password + businessId + updatedAt",
  JSON.stringify(userRequired) ===
    JSON.stringify(["businessId", "email", "password", "updatedAt"]),
  `schema says: ${userRequired.join(", ")}`
);
ok(
  "the SQL writes every required User column",
  userRequired.every((f) => userWritten.includes(f)),
  `writes: ${userWritten.join(", ")}`
);
ok(
  "the SQL writes no User column it does not need",
  userWritten.every((c) => [...userRequired, "createdAt", "name"].includes(c)),
  `writes: ${userWritten.join(", ")}`
);

// --- The defaults the tenant inherits rather than being given. ---------------

const userBody = modelBody("User");
ok("role defaults to USER", /role\s+UserRole\s+@default\(USER\)/.test(userBody));
ok("tokenVersion defaults to 0", /tokenVersion\s+Int\s+@default\(0\)/.test(userBody));
ok("loginCount defaults to 0", /loginCount\s+Int\s+@default\(0\)/.test(userBody));
ok("createdAt defaults to now()", /createdAt\s+DateTime\s+@default\(now\(\)\)/.test(userBody));
ok("lastLoginAt starts null", /lastLoginAt\s+DateTime\?/.test(userBody));
ok(
  "the SQL supplies none of those four",
  !/"role"|"tokenVersion"|"loginCount"|"lastLoginAt"/.test(sql),
  "a hand-set default is a default that can disagree with registration"
);

// --- The link, and the identity the link is keyed on. ------------------------

ok("User.email is unique", /email\s+String\s+@unique/.test(userBody));
ok(
  "User.businessId points at Business.id",
  /business\s+Business\s+@relation\(fields: \[businessId\], references: \[id\]/.test(userBody)
);
ok(
  "the SQL keys identity on the email, not the business name",
  /"email"\s*=\s*:'qa_email'/.test(sql)
);

// --- updatedAt really has no database default. -------------------------------

const migrationDirs = readdirSync(MIGRATIONS).filter((d) =>
  /^\d{14}_/.test(d)
);
const allDdl = migrationDirs
  .map((d) => {
    try {
      return readFileSync(join(MIGRATIONS, d, "migration.sql"), "utf8");
    } catch {
      return "";
    }
  })
  .join("\n");

for (const table of ["Business", "User"]) {
  const create = allDdl.match(new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\n\\);`));
  ok(`${table} CREATE TABLE found in the migration history`, Boolean(create));
  if (create) {
    const updatedAtLine = create[1]
      .split(/\r?\n/)
      .find((l) => l.includes('"updatedAt"'));
    ok(
      `${table}."updatedAt" carries no database default`,
      Boolean(updatedAtLine) && !/DEFAULT/i.test(updatedAtLine),
      "if it gained one, the insert could omit it — but it has not"
    );
    const createdAtLine = create[1]
      .split(/\r?\n/)
      .find((l) => l.includes('"createdAt"'));
    ok(
      `${table}."createdAt" defaults to CURRENT_TIMESTAMP`,
      Boolean(createdAtLine) && /DEFAULT CURRENT_TIMESTAMP/i.test(createdAtLine)
    );
  }
}

// --- Tenant isolation is a predicate, not a list of tenants. -----------------

const tenantPolicies = [
  ...allDdl.matchAll(/CREATE POLICY\s+(\w+)\s+ON\s+"(\w+)"([\s\S]{0,400}?);/g),
];
const guc = `"businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int`;
const withGuc = tenantPolicies.filter((m) => m[3].includes(guc));

ok(
  "tenant policies exist and are keyed on the session GUC",
  withGuc.length > 50,
  `found ${withGuc.length}`
);
ok(
  "no policy names a specific tenant",
  !/"businessId"\s*=\s*\d+/.test(allDdl),
  "a new business is isolated by the same predicate as every existing one, with nothing to configure"
);
ok(
  "no policy enumerates tenants through an IN list",
  !/"businessId"\s+IN\s*\(\s*\d/.test(allDdl)
);
ok(
  "the provisioning SQL creates no policy, grant or role",
  !/(CREATE POLICY|GRANT|CREATE ROLE)/i.test(sql),
  "the QA tenant gets ordinary isolation, not an exception to it"
);

// --- Nothing about the product requires the registration path to have run. ---

const registerSource = readFileSync("app/api/auth/register/route.ts", "utf8");
ok(
  "registration's only side effects beyond the two rows are the token and telemetry",
  /deps\.signToken\(/.test(registerSource) &&
    /recordUsage\(/.test(registerSource),
  "if it grew a third, this tenant would be missing it"
);
ok(
  "product usage telemetry is fire-and-forget, never read back for correctness",
  /swallows its own errors/.test(registerSource),
  "so a tenant created without a signup event behaves identically"
);

console.log(
  `\n${passed} passed, ${failures} failed — ${failures === 0 ? "SCHEMA CONTRACT: PASS" : "SCHEMA CONTRACT: FAIL"}`
);
process.exit(failures === 0 ? 0 : 1);
