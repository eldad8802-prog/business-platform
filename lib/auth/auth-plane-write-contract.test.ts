/**
 * AUTH-PLANE WRITE CONTRACT — source lock (no database).
 *
 *   npx tsx lib/auth/auth-plane-write-contract.test.ts
 *
 * The incident this exists to prevent, stated once:
 *
 *   D2 E4 replaced the auth plane's table-level SELECT on "User" with a column
 *   list. A Prisma write with no `select` appends RETURNING over EVERY scalar
 *   column of the model, and RETURNING needs SELECT on what it returns. So a
 *   write whose SET columns are all granted still fails with 42501, on a
 *   correct password, because of the read back nobody wrote.
 *
 * A privilege battery cannot catch that: every statement it issues is one
 * someone chose to write. The gap is in the statement the ORM adds. So this
 * checks the shape of the CODE against the shipped grants, and the companion
 * PG17 battery proves the ORM behaviour end to end.
 *
 * What is locked:
 *   1-4  each known auth-plane write carries an explicit `select`
 *   5    NO auth-plane write anywhere is left with an implicit full-model return
 *   6    every selected column is inside the auth plane's granted SELECT set,
 *        parsed from the shipped E4 migration rather than retyped here
 *   7    the detector is shown to FAIL on a source that drops the `select`
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: a percent-encoded segment in the checkout
// path (a non-ASCII user directory, for instance) would otherwise be handed to
// fs verbatim and fail with a confusing ENOENT.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const E4_MIGRATION = join(
  ROOT,
  "prisma/migrations/20260908180000_d2_user_business_privilege_narrowing/migration.sql"
);

const WRITE_VERBS = [
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
];

/** Verbs that return rows, and therefore emit RETURNING. `*Many` return counts. */
const RETURNING_VERBS = new Set(["create", "update", "upsert", "delete"]);

let failed = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  - ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ---------------------------------------------------------------- grants -- */

/**
 * The granted SELECT columns come from the migration that is actually applied,
 * so widening or narrowing the contract moves this test with it. Retyping the
 * list here would let the two drift in exactly the way that caused the outage.
 */
function grantedSelectColumns(model: "User" | "Business"): Set<string> {
  const sql = readFileSync(E4_MIGRATION, "utf8");
  const re = new RegExp(
    `GRANT\\s+SELECT\\s*\\(([^)]*)\\)\\s*\\n?\\s*ON\\s+public\\."${model}"\\s+TO\\s+app_auth\\s*;`,
    "i"
  );
  const m = sql.replace(/--.*$/gm, "").match(re);
  if (!m) return new Set();
  return new Set([...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]));
}

/* ---------------------------------------------------------------- parsing -- */

type WriteCall = {
  file: string;
  model: "user" | "business";
  verb: string;
  body: string;
  hasSelect: boolean;
  selected: string[];
};

/** Slice from an opening brace to its match, ignoring braces inside strings. */
function balanced(src: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

/** `select:` at the top level of the call object, not nested inside `where`. */
function topLevelSelect(body: string): { has: boolean; keys: string[] } {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    else if (depth === 1 && body.startsWith("select:", i)) {
      const brace = body.indexOf("{", i);
      if (brace === -1) return { has: true, keys: [] };
      const inner = balanced(body, brace);
      const keys = [...inner.matchAll(/(\w+)\s*:\s*true/g)].map((m) => m[1]);
      return { has: true, keys };
    }
  }
  return { has: false, keys: [] };
}

function findWrites(src: string, file: string): WriteCall[] {
  const out: WriteCall[] = [];
  const re = new RegExp(`\\.(user|business)\\.(${WRITE_VERBS.join("|")})\\s*\\(`, "g");
  for (const m of src.matchAll(re)) {
    const brace = src.indexOf("{", (m.index ?? 0) + m[0].length - 1);
    if (brace === -1) continue;
    const body = balanced(src, brace);
    const sel = topLevelSelect(body);
    out.push({
      file,
      model: m[1] as "user" | "business",
      verb: m[2],
      body,
      hasSelect: sel.has,
      selected: sel.keys,
    });
  }
  return out;
}

/* ------------------------------------------------------------ discovery --- */

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(p);
  }
  return acc;
}

/**
 * A file belongs to the auth plane when it reaches the database through
 * `authDb()` or `getPrismaAuth()`. Discovered rather than listed, so a NEW auth
 * write site is covered the day it is written.
 */
function authPlaneFiles(): string[] {
  return walk(join(ROOT, "app"))
    .concat(walk(join(ROOT, "lib")))
    .filter((p) => {
      const rel = relative(ROOT, p).replace(/\\/g, "/");
      if (rel === "lib/prisma-auth.ts") return false;
      const src = readFileSync(p, "utf8");
      return /\bauthDb\(\)|\bgetPrismaAuth\(\)/.test(src);
    });
}

/* ---------------------------------------------------------------- checks -- */

const userSelectable = grantedSelectColumns("User");
const businessSelectable = grantedSelectColumns("Business");

console.log("== auth-plane write contract ==");
console.log(`  granted SELECT on User     : ${[...userSelectable].sort().join(", ")}`);
console.log(`  granted SELECT on Business : ${[...businessSelectable].sort().join(", ")}\n`);

ok("the E4 grant lists were parsed, not assumed", userSelectable.size > 0 && businessSelectable.size > 0);

const files = authPlaneFiles();
const writes = files.flatMap((f) => findWrites(readFileSync(f, "utf8"), relative(ROOT, f).replace(/\\/g, "/")));

const REQUIRED = [
  { file: "app/api/auth/login/route.ts", verb: "update", label: "login" },
  { file: "app/api/auth/logout/route.ts", verb: "update", label: "logout" },
  { file: "lib/auth/signup.ts", verb: "create", label: "signup", model: "user" },
  { file: "lib/auth/signup.ts", verb: "create", label: "signup", model: "business" },
];

for (const r of REQUIRED) {
  const hit = writes.find(
    (w) => w.file === r.file && w.verb === r.verb && (!r.model || w.model === r.model)
  );
  ok(
    `${r.label} ${r.model ?? "user"}.${r.verb} carries an explicit select`,
    Boolean(hit?.hasSelect),
    hit ? "found the call, no top-level select" : "call site not found at all"
  );
}

// 5 — nothing anywhere is left returning the whole model implicitly.
{
  const offenders = writes.filter((w) => RETURNING_VERBS.has(w.verb) && !w.hasSelect);
  ok(
    "no auth-plane write returns the full model implicitly",
    offenders.length === 0,
    offenders.map((o) => `${o.file}:${o.model}.${o.verb}`).join(", ")
  );
}

// 6 — every selected column is one this identity may actually read.
for (const w of writes.filter((x) => x.hasSelect)) {
  const allowed = w.model === "user" ? userSelectable : businessSelectable;
  const outside = w.selected.filter((c) => !allowed.has(c));
  ok(
    `${w.file}: ${w.model}.${w.verb} selects only granted columns`,
    outside.length === 0,
    outside.length ? `not granted SELECT: ${outside.join(", ")}` : ""
  );
  ok(`${w.file}: ${w.model}.${w.verb} selects at least one column`, w.selected.length > 0);
}

// 7 — the detector is shown to bite. A passing detector that cannot fail is
// worth nothing, and this is the exact edit a future refactor would make.
{
  const withSelect = `await authDb().user.update({ where: { id: 1 }, data: { loginCount: { increment: 1 } }, select: { id: true } });`;
  const without = `await authDb().user.update({ where: { id: 1 }, data: { loginCount: { increment: 1 } } });`;
  const nestedOnly = `await authDb().user.update({ where: { id: 1, business: { select: { id: true } } }, data: {} });`;
  ok("detector: sees a real select", findWrites(withSelect, "x.ts")[0]?.hasSelect === true);
  ok("detector: flags a removed select", findWrites(without, "x.ts")[0]?.hasSelect === false);
  ok(
    "detector: is not fooled by a nested select",
    findWrites(nestedOnly, "x.ts")[0]?.hasSelect === false
  );
}

console.log(
  `\n[auth-plane-write-contract] files scanned=${files.length} writes=${writes.length} FAIL=${failed}`
);
if (failed > 0) process.exit(1);
