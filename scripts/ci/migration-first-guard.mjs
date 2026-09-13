#!/usr/bin/env node
// migration-first-guard — the whole of Dubiz's release safety, in one file.
//
// WHAT IT PREVENTS
//
// On 2026-09-02 a PR added `User.tokenVersion` to prisma/schema.prisma, the
// runtime code that reads it, and its migration — all in one commit. Vercel
// auto-deploys `main`, so the code was live minutes later while the column did
// not exist. Prisma emits an explicit column list, so every User read asked for
// a missing column, getCurrentUser returned null, and every authenticated
// request 401'd. It happened a second time on 2026-09-04: main 2380093 went
// live 86 minutes before its migration was applied.
//
// THE RULE
//
//   PR-1  prisma/migrations/** only. Expand-only. No schema.prisma, no runtime.
//         -> release-migrate (workflow_dispatch, production-db, human approval)
//         -> migration applied and verified
//   PR-2  prisma/schema.prisma + the code that depends on it. Now safe.
//
// WHAT THIS FILE DOES — AND DELIBERATELY DOES NOT
//
// It reads the PR's own diff with `git` and decides. That is all. No Vercel
// call, no GitHub API call, no attestation, no token, no secret, no network,
// no database. It cannot fail open on a network error because it never opens a
// socket. Replacing ~1,400 lines of release control plane, on purpose.
//
// EXIT CODES: 0 = allowed, 1 = blocked, 2 = could not evaluate (blocks too).

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const APP_CODE = [/^app\//, /^lib\//, /^components\//, /^features\//, /^src\//];
const NOT_APP_CODE = [/\.test\.[cm]?[jt]sx?$/, /\.spec\.[cm]?[jt]sx?$/, /\.md$/,
                      /(^|\/)__tests__\//, /(^|\/)__mocks__\//];
const EXEMPT_MARKER = "MIGRATION-EXEMPT";

// ── pure helpers (exercised by --self-test) ────────────────────────────────

// Reduce a schema to the things a database can tell apart: model/enum/type/view
// blocks and their member lines. Comments, blank lines, formatting, and the
// generator/datasource blocks are invisible here by construction — those never
// need a migration, and a guard that fired on them would be turned off.
export function structuralShape(src) {
  const out = [];
  let cur = null;
  for (const raw of String(src).split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    const open = line.match(/^(model|enum|type|view)\s+([A-Za-z0-9_]+)\s*\{$/);
    if (open) { cur = `${open[1]} ${open[2]}`; out.push(`${cur} {`); continue; }
    if (line === "}") { if (cur) out.push(`${cur} }`); cur = null; continue; }
    if (cur) out.push(`${cur} :: ${line.replace(/\s+/g, " ")}`);
  }
  return out;
}

export function schemaStructurallyChanged(baseSrc, headSrc) {
  return structuralShape(baseSrc).join("\n") !== structuralShape(headSrc).join("\n");
}

// Identifiers a structural change introduces: new model/enum/type/view names and
// new field names. Used to ask "does a migration for this exist ANYWHERE?" —
// not "does this PR contain one". PR-2 of the rule legitimately contains no
// migration: PR-1 already landed it and release-migrate already applied it.
export function newIdentifiers(baseSrc, headSrc) {
  const before = new Set(structuralShape(baseSrc));
  const models = modelNames(headSrc);
  const out = new Set();
  for (const line of structuralShape(headSrc)) {
    if (before.has(line)) continue;
    const decl = line.match(/^(?:model|enum|type|view) ([A-Za-z0-9_]+) \{$/);
    if (decl) { out.add(decl[1]); continue; }
    const member = line.match(/^[a-z]+ [A-Za-z0-9_]+ :: (.+)$/);
    if (!member) continue;
    const body = member[1];
    const name = body.match(/^([A-Za-z_][A-Za-z0-9_]*)\s/);
    if (!name || name[1].startsWith("@")) continue;
    // A RELATION field has no column to be backed by, so no migration can ever
    // mention it and the question has no honest answer. Excluding it is not
    // leniency: it removes the one class this check can never decide, and a
    // guard whose false positives push people into contorting a schema is a
    // guard that eventually gets switched off. 344 fields in this schema are
    // relations; none of them shares a name with a real column on its own table.
    if (isRelationField(body, models)) continue;
    out.add(name[1]);
  }
  return [...out];
}

// Every model name a schema declares. Needed because whether a field is a
// COLUMN or a relation depends entirely on whether its type is a model.
export function modelNames(src) {
  return new Set([...String(src).matchAll(/^\s*model\s+([A-Za-z0-9_]+)\s*\{/gm)].map((m) => m[1]));
}

/**
 * Is this field a Prisma RELATION rather than a column?
 *
 * THE TEST IS THE TYPE, not the decorations. "is a list" misses
 * `profile BusinessProfile?`; "carries @relation" misses the back-reference
 * side, which carries none. Fifteen fields in this schema are exactly those two
 * shapes, and treating them as columns is what produced the false positives.
 *
 * Enums and builtins stay columns, because an enum-typed field IS a column. The
 * foreign key is still checked: it is declared separately as its own scalar
 * field (`userId Int`) and is caught on that line.
 */
export function isRelationField(line, models) {
  const m = String(line).match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9_]+)\s*(\[\])?\s*\??/);
  return Boolean(m && models.has(m[2]));
}

export function isAppCode(path) {
  if (NOT_APP_CODE.some((re) => re.test(path))) return false;
  return APP_CODE.some((re) => re.test(path));
}

export function addedMigrations(nameStatus) {
  return nameStatus
    .filter((e) => e.status.startsWith("A") && /^prisma\/migrations\/[^/]+\/migration\.sql$/.test(e.path))
    .map((e) => e.path.split("/")[2]);
}

// The decision. Pure: everything it needs is in `facts`.
export function decide(facts) {
  const { migrations, schemaChanged, appFiles, exempt, unbackedIdentifiers = [] } = facts;
  if (exempt) {
    return { blocked: false, code: "EXEMPT",
      detail: `${EXEMPT_MARKER} declared on the PR — guard bypassed deliberately.` };
  }
  if (migrations.length > 0 && schemaChanged && appFiles.length > 0) {
    return { blocked: true, code: "COMBINED_MIGRATION_AND_CODE",
      detail: `This PR adds ${migrations.length} migration(s) (${migrations.join(", ")}), changes ` +
        `prisma/schema.prisma, AND changes ${appFiles.length} application file(s). That is the ` +
        `2026-09-02 incident shape: the code deploys the moment this merges, the migration does not. ` +
        `Split it — migration-only PR first, then release-migrate, then the code.` };
  }
  if (schemaChanged && migrations.length === 0) {
    if (unbackedIdentifiers.length > 0) {
      return { blocked: true, code: "SCHEMA_WITHOUT_MIGRATION",
        detail: `prisma/schema.prisma introduces ${unbackedIdentifiers.join(", ")}, and NO migration in ` +
          `prisma/migrations mentions ${unbackedIdentifiers.length > 1 ? "them" : "it"}. Production would ` +
          `not have the shape this code expects. Land the migration first (PR-1), run release-migrate, ` +
          `then bring this PR.` };
    }
    return { blocked: false, code: "SCHEMA_BACKED_BY_EXISTING_MIGRATION",
      detail: `schema.prisma changed, but every new identifier is already covered by a migration in the ` +
        `tree. This is PR-2 of the rule — the shape is already in Production.` };
  }
  if (migrations.length > 0 && schemaChanged) {
    return { blocked: false, code: "MIGRATION_AND_SCHEMA_NO_CODE",
      detail: `Migration + schema, no dependent application code. Allowed — nothing reads the new shape yet.` };
  }
  if (migrations.length > 0) {
    return { blocked: false, code: "MIGRATION_ONLY", detail: `Migration-only PR. This is PR-1 of the rule.` };
  }
  return { blocked: false, code: "NO_SCHEMA_SURFACE", detail: `No migration and no structural schema change.` };
}

// ── git plumbing ───────────────────────────────────────────────────────────

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function parseNameStatus(raw) {
  return raw.split("\n").filter(Boolean).map((line) => {
    const parts = line.split("\t");
    return { status: parts[0], path: parts[parts.length - 1] };
  });
}

/**
 * Read the migration tree at a SHA as ONE string of SQL, with comments removed.
 *
 * This replaced `git grep -F -i` over raw files, which had three independent
 * ways of saying yes to something it had never seen:
 *
 *   COMMENTS   the word `secrets` appears twice in English prose inside
 *              20260908120000's header, so a field by that name was ruled
 *              migration-backed by a sentence. Eight more plausible column
 *              names — grace, selector, ceiling, rotation, device, secret,
 *              expires, hash — pass the same way today.
 *   SUBSTRING  `-F` with no boundaries let `token` match `tokenVersion`.
 *   CASE       `-i` let `secrethash` match `secretHash`.
 *
 * Each one lets a REAL new column reach Production against a shape the database
 * does not have, which is the 2026-09-02 incident this whole file exists for.
 *
 * String literals survive on purpose: a `--` or a comment marker inside
 * '...' is data, not a comment, and eating it would corrupt the SQL around it.
 */
export function stripSqlComments(sql) {
  let out = "";
  let i = 0;
  let inLine = false, inBlock = false, inString = false;
  const s = String(sql);
  while (i < s.length) {
    const two = s.slice(i, i + 2);
    if (inLine) {
      if (s[i] === "\n") { inLine = false; out += "\n"; }
      i += 1; continue;
    }
    if (inBlock) {
      if (two === "*/") { inBlock = false; i += 2; continue; }
      i += 1; continue;
    }
    if (inString) {
      // '' inside a string is an escaped quote, not the end of one.
      if (s[i] === "'" && s[i + 1] === "'") { out += "''"; i += 2; continue; }
      if (s[i] === "'") inString = false;
      out += s[i]; i += 1; continue;
    }
    if (two === "--") { inLine = true; i += 2; continue; }
    if (two === "/*") { inBlock = true; i += 2; continue; }
    if (s[i] === "'") { inString = true; out += s[i]; i += 1; continue; }
    out += s[i]; i += 1;
  }
  return out;
}

/**
 * Does this identifier appear in real SQL, as a whole identifier, in this case?
 *
 * Prisma quotes every identifier it emits, so the quoted form is the precise
 * answer and is tried first. The bare form is the fallback for hand-written
 * SQL, and it is bounded on both sides so `token` can no longer be satisfied by
 * `tokenVersion`. Neither form folds case.
 */
export function ddlMentions(ddl, id) {
  if (String(ddl).includes(`"${id}"`)) return true;
  const esc = String(id).replace(/[^A-Za-z0-9_]/g, (c) => "\\" + c);
  return new RegExp(`(^|[^A-Za-z0-9_])${esc}([^A-Za-z0-9_]|$)`).test(String(ddl));
}

// Offline, deterministic, no network. One read of the migration tree, then a
// pure string question per identifier.
function identifiersWithoutMigration(sha, identifiers) {
  if (identifiers.length === 0) return [];
  let files = [];
  try {
    files = git("ls-tree", "-r", "--name-only", sha, "--", "prisma/migrations")
      .split("\n")
      .filter((f) => f.endsWith(".sql"));
  } catch { files = []; }
  const ddl = files.map((f) => stripSqlComments(fileAt(sha, f))).join("\n");
  return identifiers.filter((id) => !ddlMentions(ddl, id));
}

function fileAt(sha, path) {
  try { return git("show", `${sha}:${path}`); } catch { return ""; }
}

function main() {
  const base = process.env.BASE_SHA || "";
  const head = process.env.HEAD_SHA || "";
  const title = process.env.PR_TITLE || "";

  if (!base || !head) {
    console.log("migration-first-guard: no BASE_SHA/HEAD_SHA (not a pull request) — skipping.");
    process.exit(0);
  }
  let nameStatus;
  try {
    nameStatus = parseNameStatus(git("diff", "--name-status", base, head));
  } catch (err) {
    console.error(`migration-first-guard: CANNOT EVALUATE — git diff ${base}..${head} failed.`);
    console.error("Check that the workflow checks out with fetch-depth: 0.");
    console.error(String(err && err.message).slice(0, 400));
    process.exit(2);
  }

  const migrations = addedMigrations(nameStatus);
  const schemaTouched = nameStatus.some((e) => e.path === "prisma/schema.prisma");
  const schemaChanged = schemaTouched &&
    schemaStructurallyChanged(fileAt(base, "prisma/schema.prisma"), fileAt(head, "prisma/schema.prisma"));
  const appFiles = nameStatus.map((e) => e.path).filter(isAppCode);
  const exempt = title.includes(EXEMPT_MARKER);
  const unbacked = (schemaChanged && migrations.length === 0)
    ? identifiersWithoutMigration(head,
        newIdentifiers(fileAt(base, "prisma/schema.prisma"), fileAt(head, "prisma/schema.prisma")))
    : [];

  const verdict = decide({ migrations, schemaChanged, appFiles, exempt, unbackedIdentifiers: unbacked });

  console.log(`migrations added        : ${migrations.length}${migrations.length ? " -> " + migrations.join(", ") : ""}`);
  console.log(`schema.prisma structural: ${schemaChanged}${schemaTouched && !schemaChanged ? " (touched, but no structural change)" : ""}`);
  console.log(`application files       : ${appFiles.length}${appFiles.length ? " -> " + appFiles.slice(0, 8).join(", ") + (appFiles.length > 8 ? " …" : "") : ""}`);
  if (schemaChanged && migrations.length === 0) {
    console.log(`identifiers w/o migration: ${unbacked.length}${unbacked.length ? " -> " + unbacked.join(", ") : ""}`);
  }
  console.log(`verdict                 : ${verdict.blocked ? "BLOCKED" : "ALLOWED"} (${verdict.code})`);
  console.log(verdict.detail);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `\n### migration-first guard: ${verdict.blocked ? "BLOCKED" : "passed"}\n\n` +
      `- migrations added: ${migrations.length}\n- schema.prisma structural change: ${schemaChanged}\n` +
      `- application files changed: ${appFiles.length}\n\n${verdict.detail}\n`);
  }
  process.exit(verdict.blocked ? 1 : 0);
}

// ── self-test (runs in the same CI step; no orphan test files) ─────────────

function selfTest() {
  let pass = 0, fail = 0;
  const is = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++; else { fail++; console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  };
  const SCHEMA_A = `datasource db { provider = "postgresql"\n url = env("DATABASE_URL") }\nmodel User {\n id String @id\n email String @unique\n}\n`;
  const SCHEMA_B = `datasource db { provider = "postgresql"\n url = env("DATABASE_URL") }\nmodel User {\n id String @id\n email String @unique\n tokenVersion Int @default(0)\n}\n`;
  const SCHEMA_A_COMMENTED = `// a new comment\ndatasource db { provider = "postgresql"\n url = env("DATABASE_URL") }\n\nmodel User {\n  id    String @id\n  email String @unique // trailing note\n}\n`;

  is("structural: added field is a change", schemaStructurallyChanged(SCHEMA_A, SCHEMA_B), true);
  is("structural: comments/whitespace are NOT a change", schemaStructurallyChanged(SCHEMA_A, SCHEMA_A_COMMENTED), false);
  is("structural: identical is not a change", schemaStructurallyChanged(SCHEMA_A, SCHEMA_A), false);
  is("structural: generator/datasource edits are invisible",
    schemaStructurallyChanged(SCHEMA_A, SCHEMA_A.replace('"postgresql"', '"postgres"')), false);

  is("appcode: app route counts", isAppCode("app/api/x/route.ts"), true);
  is("appcode: lib counts", isAppCode("lib/auth/session.ts"), true);
  is("appcode: test file does not", isAppCode("lib/auth/session.test.ts"), false);
  is("appcode: markdown does not", isAppCode("lib/auth/README.md"), false);
  is("appcode: scripts do not", isAppCode("scripts/ci/x.sh"), false);
  is("appcode: prisma does not", isAppCode("prisma/schema.prisma"), false);

  is("added: picks up new migration dir",
    addedMigrations([{ status: "A", path: "prisma/migrations/20260902100000_auth_token_version/migration.sql" }]),
    ["20260902100000_auth_token_version"]);
  is("added: modified migration is not an add",
    addedMigrations([{ status: "M", path: "prisma/migrations/20260902100000_x/migration.sql" }]), []);

  // The incident, exactly as it happened.
  is("decide: migration + schema + code is BLOCKED",
    decide({ migrations: ["m1"], schemaChanged: true, appFiles: ["lib/auth/session.ts"], exempt: false }).code,
    "COMBINED_MIGRATION_AND_CODE");
  is("decide: schema change whose identifier has NO migration is BLOCKED",
    decide({ migrations: [], schemaChanged: true, appFiles: [], exempt: false,
             unbackedIdentifiers: ["tokenVersion"] }).code, "SCHEMA_WITHOUT_MIGRATION");
  // 318144a: PR-2 of the rule. Migration already landed in ea2fbe3 and was
  // already applied. Blocking this would make the prescribed workflow illegal.
  is("decide: PR-2 (schema + code, migration already in tree) is ALLOWED",
    decide({ migrations: [], schemaChanged: true, appFiles: ["lib/auth.ts"], exempt: false,
             unbackedIdentifiers: [] }).code, "SCHEMA_BACKED_BY_EXISTING_MIGRATION");
  is("newIdentifiers: picks up an added field",
    newIdentifiers(SCHEMA_A, SCHEMA_B), ["tokenVersion"]);
  is("newIdentifiers: picks up an added model",
    newIdentifiers(SCHEMA_A, SCHEMA_A + "model Audit {\n id String @id\n}\n").sort(), ["Audit","id"]);
  is("newIdentifiers: nothing for a comment-only edit",
    newIdentifiers(SCHEMA_A, SCHEMA_A_COMMENTED), []);
  // The corrected shape: ea2fbe3 then 318144a.
  is("decide: migration-only is ALLOWED (PR-1)",
    decide({ migrations: ["m1"], schemaChanged: false, appFiles: [], exempt: false }).blocked, false);
  is("decide: migration + schema, no code is ALLOWED",
    decide({ migrations: ["m1"], schemaChanged: true, appFiles: [], exempt: false }).blocked, false);
  is("decide: ordinary code PR is ALLOWED",
    decide({ migrations: [], schemaChanged: false, appFiles: ["app/page.tsx"], exempt: false }).blocked, false);
  is("decide: exemption bypasses the block",
    decide({ migrations: ["m1"], schemaChanged: true, appFiles: ["lib/x.ts"], exempt: true }).blocked, false);

  // ── identifier matching: the false negative that let #412 through ────────
  //
  // Every case below is a real shape from this repository, not an invention.
  // The DDL fixture reproduces the two prose mentions of `secrets` in
  // 20260908120000's header that made a relation field look migration-backed.
  const DDL = `
-- \`AuthSessionSecret\` holds the secrets this session has rotated away, with the
-- instant each stopped being current. A selector is not a grace ceiling.
/* a block comment mentioning rotation and device and expires */
CREATE TABLE "AuthSession" (
    "id" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "secretHash" TEXT NOT NULL,
    "tokenVersionAtIssue" INTEGER NOT NULL
);
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'PAYPLUS';
INSERT INTO "Note" ("body") VALUES ('a literal -- that is data, not a comment');
`;
  const CLEAN = stripSqlComments(DDL);

  is("strip: line comments are gone", /secrets/.test(CLEAN), false);
  is("strip: block comments are gone", /rotation|device|expires/.test(CLEAN), false);
  is("strip: a string literal survives intact",
    CLEAN.includes("'a literal -- that is data, not a comment'"), true);
  is("strip: the DDL itself survives", CLEAN.includes('CREATE TABLE "AuthSession"'), true);

  // NEGATIVE — each of these must be reported as unbacked.
  is("match: a name that appears ONLY in a line comment is NOT backed",
    ddlMentions(CLEAN, "secrets"), false);
  is("match: a name that appears ONLY in a block comment is NOT backed",
    ddlMentions(CLEAN, "rotation"), false);
  is("match: `grace` — comment-only — is NOT backed", ddlMentions(CLEAN, "grace"), false);
  is("match: `selector` — comment-only — is NOT backed", ddlMentions(CLEAN, "selector"), false);
  is("match: a substring of a real identifier is NOT backed",
    ddlMentions(CLEAN, "token"), false);
  is("match: a different case of a real identifier is NOT backed",
    ddlMentions(CLEAN, "secrethash"), false);
  is("match: a model with no CREATE TABLE is NOT backed",
    ddlMentions(CLEAN, "DeviceLabel"), false);
  is("match: an enum with no CREATE TYPE is NOT backed",
    ddlMentions(CLEAN, "DeviceKind"), false);

  // POSITIVE — each of these is genuinely in DDL and must stay allowed.
  is("match: a column from CREATE TABLE is backed", ddlMentions(CLEAN, "secretHash"), true);
  is("match: a column from ALTER TABLE ADD COLUMN is backed",
    ddlMentions(CLEAN, "tokenVersion"), true);
  is("match: the table itself is backed", ddlMentions(CLEAN, "AuthSession"), true);
  is("match: an enum type from ALTER TYPE ADD VALUE is backed",
    ddlMentions(CLEAN, "PaymentProvider"), true);

  // ── relation fields: the false POSITIVE, and the reason #414 contorted ───
  const REL_BEFORE = `model AuthSession {\n id String @id\n userId Int\n}\nmodel AuthSessionSecret {\n id String @id\n sessionId String\n}\n`;
  const REL_AFTER = `model AuthSession {\n id String @id\n userId Int\n user User @relation(fields: [userId], references: [id])\n secrets AuthSessionSecret[]\n profile BusinessProfile?\n}\nmodel AuthSessionSecret {\n id String @id\n sessionId String\n}\nmodel User {\n id Int @id\n}\nmodel BusinessProfile {\n id Int @id\n}\n`;
  const relNew = newIdentifiers(REL_BEFORE, REL_AFTER).filter((x) => !["User", "BusinessProfile"].includes(x));
  is("relation: a list back-reference is not asked about", relNew.includes("secrets"), false);
  is("relation: an @relation field is not asked about", relNew.includes("user"), false);
  is("relation: an OPTIONAL one-to-one back-reference is not asked about",
    relNew.includes("profile"), false);

  const models = modelNames(REL_AFTER);
  is("relation: type-is-a-model detects a list", isRelationField("secrets AuthSessionSecret[]", models), true);
  is("relation: type-is-a-model detects an optional", isRelationField("profile BusinessProfile?", models), true);
  is("relation: an enum-typed field is still a column",
    isRelationField("status CouponStatus @default(ACTIVE)", models), false);
  is("relation: a builtin-typed field is still a column",
    isRelationField("secretHash String", models), false);
  is("relation: the FK scalar is still a column", isRelationField("userId Int", models), false);

  // A new SCALAR is still asked about — the guard must not have gone quiet.
  const SCALAR_AFTER = REL_BEFORE.replace("userId Int", "userId Int\n grace DateTime");
  is("scalar: a genuinely new column is still asked about",
    newIdentifiers(REL_BEFORE, SCALAR_AFTER).includes("grace"), true);

  console.log(`migration-first-guard self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
