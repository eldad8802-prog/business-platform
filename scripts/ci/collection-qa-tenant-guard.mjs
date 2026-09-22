#!/usr/bin/env node
/**
 * Containment guard for the Collection QA tenant provisioning run.
 *
 * WHY A STATIC GUARD
 *
 * ops/tenant/collection-qa-tenant.sql is the only file in this repository that
 * COMMITS a write to Production outside a migration. What makes that acceptable
 * is not that it is short today — it is that a machine reads it before any
 * connection is opened and refuses the run unless it is still exactly what was
 * approved: two INSERTs, one transaction, one named tenant, nothing else.
 *
 * The guard therefore checks properties, not prose, and it FAILS CLOSED. Every
 * unknown is a refusal: an unrecognised statement, a widened file, an email
 * that is still the placeholder, a name that drifted from the approved literal.
 * Widening the SQL to touch anything else makes this guard exit non-zero, and
 * scripts/ci/collection-qa-tenant-guard.test.mjs proves that by doing it.
 *
 * It is deliberately specific to this one tenant. The approved names are
 * carried HERE, as constants, so the workflow cannot be repurposed into a
 * generic tenant-provisioning tool by editing a data file alone.
 *
 * Usage:
 *   node scripts/ci/collection-qa-tenant-guard.mjs
 *   node scripts/ci/collection-qa-tenant-guard.mjs --sql X --verify Y --identity Z
 */

import { readFileSync } from "node:fs";

/** The approved tenant. Changing these is a code change, reviewed as one. */
const APPROVED_BUSINESS_NAME = "QA COLLECTION SANDBOX — אין להשתמש";
const APPROVED_USER_NAME = "QA Collection Sandbox";
const EMAIL_PLACEHOLDER = "__COLLECTION_QA_EMAIL_NOT_SET__";
/** The local part every QA address must start with, so it can never be a person's mailbox. */
const EMAIL_LOCAL_PREFIX = "collection-qa";
/** Same permissive shape signup uses (lib/auth/signup-identity.ts). */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULTS = {
  sql: "ops/tenant/collection-qa-tenant.sql",
  verify: "ops/tenant/collection-qa-tenant-verify.sql",
  identity: "ops/tenant/collection-qa-tenant.identity.env",
  workflow: ".github/workflows/prod-create-collection-qa-tenant.yml",
  passwordSql: "ops/tenant/collection-qa-tenant-password.sql",
  passwordVerify: "ops/tenant/collection-qa-tenant-password-verify.sql",
  passwordWorkflow: ".github/workflows/prod-set-collection-qa-tenant-password.yml",
};

/**
 * The rows provisioning created. Pinned HERE, as the names are, so the repair
 * cannot be aimed at another account by editing a data file.
 */
const APPROVED_BUSINESS_ID = "38";
const APPROVED_USER_ID = "33";

/**
 * Statements that have no business in either file, whatever the transaction
 * does around them. Checked after comments are stripped: this is a claim about
 * what runs, and a sentence in a comment never runs. (The evidence guards check
 * prose too, and it has cost real time — a rule that fails on the word
 * "alter" in an explanation teaches people to stop explaining.)
 */
const FORBIDDEN = [
  ["UPDATE", /\bupdate\s+(?:only\s+)?["a-z_]/i],
  ["DELETE", /\bdelete\s+from\b/i],
  ["DROP", /\bdrop\s+/i],
  ["ALTER", /\balter\s+/i],
  ["TRUNCATE", /\btruncate\b/i],
  ["GRANT", /\bgrant\s+/i],
  ["REVOKE", /\brevoke\s+/i],
  ["CREATE", /\bcreate\s+/i],
  ["COPY", /\bcopy\s+/i],
  ["MERGE", /\bmerge\s+into\b/i],
  // Any dollar-quoted body, not just DO: a function body or an anonymous block
  // is SQL this guard cannot read, which is the same as no guard at all.
  ["DO block", /\bdo\s*\$/i],
  ["dollar-quoted body", /\$[a-z_]*\$/i],
  ["SET ROLE", /\bset\s+(?:local\s+)?role\b/i],
  ["SECURITY DEFINER", /\bsecurity\s+definer\b/i],
  // A conflict clause would turn an insert that must be a no-op into an
  // in-place write on a row this run did not create.
  ["ON CONFLICT", /\bon\s+conflict\b/i],
  ["shell escape", /^\s*\\!/m],
  ["file read", /\bpg_read_file\b/i],
];

const failures = [];
const passes = [];

function check(label, condition, detail = "") {
  if (condition) {
    passes.push(label);
  } else {
    failures.push(detail ? `${label} — ${detail}` : label);
  }
}

/** The un-prefixed recorder, for helpers that label their own checks. */
const globalCheck = check;

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (key && value && key in out) out[key] = value;
  }
  return out;
}

/** Remove line and block comments. What remains is what the server executes. */
function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

/** Every single-quoted literal in the statement text. */
function quotedLiterals(sql) {
  return [...sql.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]);
}

function countOccurrences(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function readIdentity(path) {
  const raw = readFileSync(path, "utf8");
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    // Values are quoted in the file because the workflow sources it with `.`:
    // the business name contains spaces, and an unquoted one would be read as a
    // variable assignment followed by a command. The quotes are shell syntax,
    // not part of the value, so they come off here.
    const raw = trimmed.slice(eq + 1);
    values[trimmed.slice(0, eq).trim()] = raw.replace(/^"([\s\S]*)"$/, "$1");
  }
  return values;
}

// ---------------------------------------------------------------- identity --

function checkIdentity(path) {
  const id = readIdentity(path);
  const email = id.COLLECTION_QA_EMAIL ?? "";

  check(
    "business name is the approved literal",
    id.COLLECTION_QA_BUSINESS_NAME === APPROVED_BUSINESS_NAME,
    "this workflow provisions one named tenant and no other"
  );
  check(
    "user name is the approved literal",
    id.COLLECTION_QA_USER_NAME === APPROVED_USER_NAME
  );
  check(
    "login email is set",
    email !== "" && email !== EMAIL_PLACEHOLDER,
    "the owner has not fixed the final address yet — refusing to provision"
  );
  check(
    "login email is already normalized",
    email === email.trim().toLowerCase(),
    "signup folds case before storing; an unfolded address would not be found by login"
  );
  check("login email is shaped like an address", EMAIL_SHAPE.test(email.trim()));
  check(
    "login email is unmistakably the QA tenant's",
    email.startsWith(`${EMAIL_LOCAL_PREFIX}`),
    `must begin with "${EMAIL_LOCAL_PREFIX}"`
  );
  check(
    "business id is the provisioned one",
    id.COLLECTION_QA_BUSINESS_ID === APPROVED_BUSINESS_ID,
    `expected ${APPROVED_BUSINESS_ID}`
  );
  check(
    "user id is the provisioned one",
    id.COLLECTION_QA_USER_ID === APPROVED_USER_ID,
    `expected ${APPROVED_USER_ID}`
  );
  return id;
}

// ---------------------------------------------------------------- password --

/**
 * The repair statement: one UPDATE, one column, one row.
 *
 * This is the only file in the repository allowed to UPDATE a Production row
 * outside a migration, so its rules are narrower than the provisioning file's,
 * not looser. In particular the target is pinned four ways — id, address,
 * business id, business name — and the SET clause may assign exactly one
 * column. An UPDATE that quietly grew a second assignment is the failure this
 * refuses, and the negative proof performs it.
 */
function checkPasswordSql(path) {
  const raw = readFileSync(path, "utf8");
  const sql = stripComments(raw);

  for (const [label, pattern] of FORBIDDEN) {
    if (label === "UPDATE") continue; // the one statement this file exists for
    check(`password: no ${label}`, !pattern.test(sql), "forbidden statement found");
  }
  check("password: no INSERT", !/\binsert\s+into\b/i.test(sql));
  check("password: no DELETE", !/\bdelete\s+from\b/i.test(sql));

  check("password: exactly one BEGIN", countOccurrences(sql, /\bbegin\s*;/gi) === 1);
  check("password: exactly one COMMIT", countOccurrences(sql, /\bcommit\s*;/gi) === 1);
  check("password: no ROLLBACK", countOccurrences(sql, /\brollback\b/gi) === 0);

  const updates = [...sql.matchAll(/update\s+"([A-Za-z]+)"/gi)].map((m) => m[1]);
  check("password: exactly one UPDATE", updates.length === 1, `found ${updates.length}`);
  check('password: the UPDATE targets "User"', updates[0] === "User", String(updates[0]));

  // Everything between SET and the next clause. One assignment, and it is the
  // credential — "sets exactly one column" is the claim, so it is measured.
  const setClause = sql.match(/\bset\s+([\s\S]*?)\bfrom\b/i)?.[1] ?? "";
  const assignments = [...setClause.matchAll(/"([A-Za-z]+)"\s*=/g)].map((m) => m[1]);
  check(
    "password: the UPDATE assigns exactly one column",
    assignments.length === 1,
    `assigns: ${assignments.join(", ") || "nothing"}`
  );
  check(
    "password: that column is the credential",
    assignments[0] === "password",
    String(assignments[0])
  );
  check(
    "password: the credential comes from the bound variable",
    /"password"\s*=\s*:'qa_password_hash'/.test(sql)
  );

  // The target, pinned four ways. Any one of these alone would be enough for
  // the database; together they are enough for a reviewer.
  check("password: pinned by user id", /u\."id"\s*=\s*:qa_user_id/.test(sql));
  check("password: pinned by address", /u\."email"\s*=\s*:'qa_email'/.test(sql));
  check("password: pinned by business id", /u\."businessId"\s*=\s*:qa_business_id/.test(sql));
  check("password: pinned by business name", /b\."name"\s*=\s*:'qa_business_name'/.test(sql));
  check(
    "password: the UPDATE has a WHERE clause",
    /\bwhere\b/i.test(sql),
    "an UPDATE without one rewrites the table"
  );
  check("password: the row it changed is returned", /\breturning\b/i.test(sql));

  const literals = quotedLiterals(sql);
  check(
    "password: no email literal in the file",
    literals.every((l) => !l.includes("@"))
  );
  check(
    "password: no credential literal in the file",
    literals.every((l) => !/^\$2[aby]\$/.test(l))
  );
}

function checkPasswordVerifySql(path) {
  const raw = readFileSync(path, "utf8");
  const sql = stripComments(raw);

  for (const [label, pattern] of FORBIDDEN) {
    check(`password verify: no ${label}`, !pattern.test(sql));
  }
  check("password verify: no INSERT", !/\binsert\s+into\b/i.test(sql));
  check("password verify: declares READ ONLY", /begin\s+transaction\s+read\s+only\s*;/i.test(sql));
  check("password verify: ends in ROLLBACK", /\brollback\s*;/i.test(sql));
  check("password verify: never COMMITs", !/\bcommit\s*;/i.test(sql));

  // The fingerprint proves the value moved; the value itself stays unread.
  const allowed = [
    `(u."password" ~ '^\\$2[aby]\\$10\\$')`,
    `length(u."password")`,
    `left(md5(u."password"), 8)`,
  ];
  let remaining = sql;
  for (const snippet of allowed) remaining = remaining.split(snippet).join(" ");
  check(
    "password verify: the hash is never selected",
    !/"password"/i.test(remaining),
    "only its shape, length and fingerprint may be read"
  );
}

// ------------------------------------------------------------ provisioning --

function checkProvisioningSql(path) {
  const raw = readFileSync(path, "utf8");
  const sql = stripComments(raw);

  for (const [label, pattern] of FORBIDDEN) {
    check(`no ${label}`, !pattern.test(sql), "forbidden statement found");
  }

  check("exactly one BEGIN", countOccurrences(sql, /\bbegin\s*;/gi) === 1);
  check("exactly one COMMIT", countOccurrences(sql, /\bcommit\s*;/gi) === 1);
  check("no ROLLBACK", countOccurrences(sql, /\brollback\b/gi) === 0);

  const inserts = [...sql.matchAll(/insert\s+into\s+"([A-Za-z]+)"/gi)].map(
    (m) => m[1]
  );
  check("exactly two INSERT statements", inserts.length === 2, `found ${inserts.length}`);
  check(
    'one INSERT into "Business"',
    inserts.filter((t) => t === "Business").length === 1
  );
  check('one INSERT into "User"', inserts.filter((t) => t === "User").length === 1);
  check(
    "no INSERT targets any other table",
    inserts.every((t) => t === "Business" || t === "User"),
    `targets: ${inserts.join(", ")}`
  );

  check(
    "no VALUES form",
    !/\bvalues\s*\(/i.test(sql),
    "both inserts must be INSERT ... SELECT so they can carry their own guards"
  );
  check(
    "idempotency guard on the business insert",
    countOccurrences(sql, /not\s+exists/gi) >= 2,
    "the business must be guarded on both the email and the name"
  );
  // Scoped to the user insert itself. Looking for the phrase anywhere in the
  // file is not the same claim: the closing SELECT also counts new_business,
  // so a user insert rewritten to read the Business table directly would slip
  // through a whole-file search while being exactly the defect — a second run
  // attaching a user to a tenant it did not create.
  const userInsert = sql.slice(sql.search(/insert\s+into\s+"User"/i));
  check(
    "the user row is drawn only from the business this run created",
    /from\s+new_business\b/i.test(userInsert),
    "the user INSERT must select FROM new_business"
  );
  check(
    "the user insert reads no table directly",
    !/from\s+"[A-Za-z]+"/i.test(userInsert),
    "selecting from a table here would defeat the idempotency argument"
  );
  check(
    "identity is the login email",
    /"email"\s*=\s*:'qa_email'/i.test(sql)
  );

  for (const variable of ["qa_email", "qa_business_name", "qa_user_name", "qa_password_hash"]) {
    check(`binds :${variable}`, sql.includes(`:'${variable}'`));
  }

  check(
    'both inserts write "updatedAt"',
    countOccurrences(sql, /"updatedAt"/g) === 2,
    "the column has no database default; Prisma maintains it in the app layer"
  );

  const literals = quotedLiterals(sql);
  check(
    "no email literal in the file",
    literals.every((l) => !l.includes("@")),
    "the address arrives as a bound variable, never baked in"
  );
  check(
    "no credential literal in the file",
    literals.every((l) => !/^\$2[aby]\$/.test(l)),
    "the hash arrives from the protected secret, never from git"
  );
}

// ------------------------------------------------------------------ verify --

function checkVerifySql(path) {
  const raw = readFileSync(path, "utf8");
  const sql = stripComments(raw);

  for (const [label, pattern] of FORBIDDEN) {
    check(`verify: no ${label}`, !pattern.test(sql));
  }
  check("verify: no INSERT", !/\binsert\s+into\b/i.test(sql));
  check("verify: declares READ ONLY", /begin\s+transaction\s+read\s+only\s*;/i.test(sql));
  check("verify: ends in ROLLBACK", /\brollback\s*;/i.test(sql));
  check("verify: never COMMITs", !/\bcommit\s*;/i.test(sql));

  // The hash may be characterised, never returned. Each mention of the column
  // must be one of the two shapes that yield a boolean or a length.
  const allowed = [`(u."password" ~ '^\\$2[aby]\\$10\\$')`, `length(u."password")`];
  let remaining = sql;
  for (const snippet of allowed) remaining = remaining.split(snippet).join(" ");
  check(
    "verify: the password hash is never selected",
    !/"password"/i.test(remaining),
    "only its bcrypt shape and length may be read"
  );
}

// ------------------------------------------------------------------ caller --

/**
 * How the production workflow HANDS the variables to psql.
 *
 * This exists because of a real failure: the pre-flight step wrote its query as
 * `psql -c "... = :'qa_email'"`. psql expands its variables only in input it
 * READS — a file, or stdin — and forwards a -c string to the server verbatim,
 * so the server received a literal colon and refused it. The run stopped at
 * that step, which is the system working, but it stopped a production run over
 * something a machine can see from here.
 *
 * The credential check is the same shape of claim: the hash must arrive on
 * stdin, never as an argument, because arguments are visible in the process
 * list of a machine this repository does not own.
 */
function checkWorkflow(path, label = "workflow") {
  const yaml = readFileSync(path, "utf8");
  const check = (name, condition, detail = "") =>
    globalCheck(`${label}: ${name}`, condition, detail);

  // Scanned to end of LINE, not to the closing quote: the query is likely to
  // contain escaped quotes of its own (\"User\"), and a pattern that stops at
  // the first one walks straight past the defect it is looking for.
  const dashCWithVariable = [...yaml.matchAll(/-c\s+"[^\n]*:'/g)];
  check(
    "no psql -c carries a psql variable",
    dashCWithVariable.length === 0,
    "psql expands :'var' only in input it reads — use a piped \\set and -f -"
  );

  check(
    "the credential is never passed as an argument",
    !/--set=qa_password_hash|--body[= ]/.test(yaml),
    "an argument is visible in the runner's process list"
  );
  check(
    "the credential reaches psql through stdin",
    /printf "\\\\set qa_password_hash/.test(yaml)
  );

  check(
    "the production run is manual only",
    /on:\s*\n\s*workflow_dispatch:/.test(yaml) && !/\bon:\s*\n\s*push:/.test(yaml)
  );
  check(
    "the production run is gated on the protected environment",
    /environment:\s*production-db/.test(yaml)
  );
  check(
    "the production run asserts the verified host",
    /ep-flat-brook-am4bhq1y/.test(yaml)
  );
  check(
    "the production run takes no inputs",
    !/\binputs:/.test(yaml),
    "an input would make this a generic provisioning tool"
  );
  check(
    "the production run calls this guard before connecting",
    yaml.indexOf("collection-qa-tenant-guard.mjs") <
      yaml.indexOf("psql"),
    "the guard must run before any connection is opened"
  );
}

// -------------------------------------------------------------------- main --

function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    checkIdentity(args.identity);
    checkProvisioningSql(args.sql);
    checkVerifySql(args.verify);
    checkWorkflow(args.workflow, "provision workflow");
    checkPasswordSql(args.passwordSql);
    checkPasswordVerifySql(args.passwordVerify);
    checkWorkflow(args.passwordWorkflow, "password workflow");
  } catch (error) {
    failures.push(`guard could not complete: ${error.message}`);
  }

  for (const pass of passes) console.log(`  ok   ${pass}`);
  for (const failure of failures) console.log(`  FAIL ${failure}`);

  if (failures.length > 0) {
    console.log(
      `\nCONTAINMENT GUARD: FAIL (${failures.length} of ${passes.length + failures.length})`
    );
    process.exit(1);
  }

  console.log(`\nCONTAINMENT GUARD: PASS (${passes.length} checks)`);
}

main();
