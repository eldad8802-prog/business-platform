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
  const out = new Set();
  for (const line of structuralShape(headSrc)) {
    if (before.has(line)) continue;
    const decl = line.match(/^(?:model|enum|type|view) ([A-Za-z0-9_]+) \{$/);
    if (decl) { out.add(decl[1]); continue; }
    const member = line.match(/^[a-z]+ [A-Za-z0-9_]+ :: ([A-Za-z_][A-Za-z0-9_]*)\s/);
    if (member && !member[1].startsWith("@")) out.add(member[1]);
  }
  return [...out];
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

// One `git grep` per new identifier, scoped to prisma/migrations at HEAD.
// Offline, deterministic, no network.
function identifiersWithoutMigration(sha, identifiers) {
  return identifiers.filter((id) => {
    try {
      const hit = execFileSync("git", ["grep", "-F", "-i", "-l", "--", id, sha, "--", "prisma/migrations"],
        { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
      return hit.trim() === "";
    } catch { return true; } // git grep exits 1 when nothing matched
  });
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

  console.log(`migration-first-guard self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
