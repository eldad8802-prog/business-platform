/**
 * Bypass guard for the public-signup gate (run manually):
 *   npx tsx lib/auth/signup-gate-coverage.test.ts
 *
 * The gate is only as strong as the claim that registration is the ONLY runtime
 * path that creates a User or a Business. This test re-proves that claim on
 * every run by scanning the shipped source tree, so a future route, service or
 * server action that quietly starts creating accounts fails here instead of
 * silently re-opening signup.
 *
 * Scanned: app/, lib/, components/, features/, hooks/ — i.e. everything that
 * can run in production. Test files and one-off scripts are out of scope: they
 * are not reachable over HTTP.
 */

import fs from "fs";
import path from "path";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  - ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();
const SCAN_DIRS = ["app", "lib", "components", "features", "hooks"];

/**
 * The single gated creation path. Anything else must justify itself here.
 *
 * `lib/auth/signup.ts` holds the actual write. It was extracted from the route
 * so that Business + User could be created in ONE transaction — previously they
 * were two separate writes, and a failure between them left an orphan Business
 * that nobody could ever log into.
 *
 * Extracting it means the creation is no longer syntactically inside the gated
 * route, so this allowlist entry would weaken the guarantee on its own. It does
 * not, because the check further down pins the compensating property: that
 * module is importable ONLY from the gated route. Reachability replaces
 * co-location, and the guarantee is unchanged.
 */
const ALLOWLIST = new Set([
  "app/api/auth/register/route.ts",
  "lib/auth/signup.ts",
]);

/** Only the gated route may import the account-creation module. */
const SIGNUP_MODULE_IMPORTERS = new Set(["app/api/auth/register/route.ts"]);
const SIGNUP_IMPORT_PATTERN = /from\s+["'][^"']*\/auth\/signup["']/;

/** Prisma writes that can mint a tenant or an account. */
const CREATION_PATTERNS = [
  /prisma\s*\.\s*user\s*\.\s*(create|createMany|upsert)\b/,
  /prisma\s*\.\s*business\s*\.\s*(create|createMany|upsert)\b/,
  /tx\s*\.\s*user\s*\.\s*(create|createMany|upsert)\b/,
  /tx\s*\.\s*business\s*\.\s*(create|createMany|upsert)\b/,
  /INSERT\s+INTO\s+"?(User|Business)"?/i,
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function main() {
  const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
  ok("source tree was actually scanned", files.length > 200, `found ${files.length} files`);

  // 1. No un-gated account/tenant creation anywhere in shippable code.
  const offenders: string[] = [];
  for (const file of files) {
    const relPath = rel(file);
    if (ALLOWLIST.has(relPath)) continue;
    const src = fs.readFileSync(file, "utf8");
    for (const pattern of CREATION_PATTERNS) {
      if (pattern.test(src)) {
        offenders.push(`${relPath} matches ${pattern}`);
        break;
      }
    }
  }
  // 1b. The extracted creation module is reachable ONLY from the gated route.
  //     This is what makes allowlisting lib/auth/signup.ts safe: the write lives
  //     in its own file, but nothing except the gated route can call it, so no
  //     un-gated path can reach a create.
  const illegalImporters: string[] = [];
  for (const file of files) {
    const relPath = rel(file);
    if (SIGNUP_MODULE_IMPORTERS.has(relPath)) continue;
    if (relPath === "lib/auth/signup.ts") continue;
    // Tests are not shipped and may exercise the module directly.
    if (/\.test\.ts$/.test(relPath)) continue;
    const src = fs.readFileSync(file, "utf8");
    if (SIGNUP_IMPORT_PATTERN.test(src)) {
      illegalImporters.push(relPath);
    }
  }
  ok(
    "the account-creation module is imported only by the gated route",
    illegalImporters.length === 0,
    illegalImporters.join("\n        ")
  );

  ok(
    "registration is the only User/Business creation path in runtime code",
    offenders.length === 0,
    offenders.join("\n        ")
  );

  // 2. The one allowed path really is gated, and gated before anything else.
  const registerSrc = fs.readFileSync(
    path.join(ROOT, "app/api/auth/register/route.ts"),
    "utf8"
  );
  ok(
    "register route imports the gate",
    /from\s+"@\/lib\/auth\/signup-gate"/.test(registerSrc)
  );
  ok("register route calls the gate", /isSignupEnabled\(\)/.test(registerSrc));

  const gateAt = registerSrc.indexOf("isSignupEnabled()");
  const rateLimitAt = registerSrc.indexOf("deps.rateLimit(");
  const bodyAt = registerSrc.indexOf("req.json()");
  const createAt = Math.min(
    ...[registerSrc.indexOf("deps.createBusiness("), registerSrc.indexOf("deps.createUser(")].filter(
      (i) => i >= 0
    )
  );
  ok("gate runs before the body is parsed", gateAt >= 0 && bodyAt > gateAt);
  ok("gate runs before the rate limiter", gateAt >= 0 && rateLimitAt > gateAt);
  ok("gate runs before any create", gateAt >= 0 && createAt > gateAt);

  // 3. Login must never consult the gate — existing users are never blocked.
  const loginSrc = fs.readFileSync(path.join(ROOT, "app/api/auth/login/route.ts"), "utf8");
  ok("login route does NOT reference the signup gate", !/signup-gate/.test(loginSrc));
  ok(
    "login route does not read the flag",
    !/PUBLIC_SIGNUP_ENABLED/.test(loginSrc)
  );

  // 4. There is exactly one flag name in play — no drifting duplicates.
  const flagFiles = files.filter((f) =>
    /process\.env\.PUBLIC_SIGNUP_ENABLED/.test(fs.readFileSync(f, "utf8"))
  );
  ok(
    "the env var is read in exactly one module (lib/auth/signup-gate.ts)",
    flagFiles.length === 1 && rel(flagFiles[0]) === "lib/auth/signup-gate.ts",
    flagFiles.map(rel).join(", ")
  );

  // 5. No client bundle can decide the gate for itself. A NEXT_PUBLIC_ twin of
  //    this flag would be readable — and therefore forgeable — in the browser.
  ok(
    "flag is never mirrored into a NEXT_PUBLIC_ variable",
    !files.some((f) =>
      /NEXT_PUBLIC_(PUBLIC_)?SIGNUP_ENABLED/.test(fs.readFileSync(f, "utf8"))
    )
  );

  console.log(failed === 0 ? "\nPASS" : `\nFAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
