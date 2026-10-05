/**
 * Session-bound token guard (pure, no database):
 *   npx tsx lib/auth/session-bound-token-guard.test.ts
 *
 * There is one kind of authenticated user: one whose access token NAMES an
 * AuthSession row — refreshable, listed among their devices, revocable on its
 * own. Signup used to be the exception: it minted a bare token with no session
 * behind it, so every new owner was a second, weaker kind of user, signed out
 * after 24 hours and unreachable by device revocation.
 *
 * `getAuthContext` still tolerates a sid-less token, because test and QA
 * harnesses mint them. This guard is what makes that tolerance unreachable from
 * the product: every call to `signAuthToken` in code that can run in production
 * must pass a session id. A new route that forgets one fails here, not in front
 * of a customer.
 *
 * Scanned: app/, lib/, components/, features/, hooks/. Test files are out of
 * scope: they are not reachable over HTTP.
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
/** The definition itself, which names the optional parameter. */
const DEFINITION = "lib/auth-token.ts";

/**
 * The direct minting paths. If one disappears the scan proves less. Signup
 * mints through an injected `signToken` (so its route test needs no secret);
 * the checks at the bottom pin that call, and `RegisterDeps` types the session
 * id as required.
 */
const EXPECTED_MINTERS = ["app/api/auth/login/route.ts", "app/api/auth/refresh/route.ts"];

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

/** Top-level arguments of the call whose "(" sits at `open`. */
function callArguments(src: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) {
        if (current.trim()) args.push(current.trim());
        return args;
      }
      depth--;
    }
    if (c === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  return args;
}

/** Comments stripped so a call quoted in prose is never counted. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const minters = new Map<string, number>();
const violations: string[] = [];

for (const dir of SCAN_DIRS) {
  for (const file of walk(path.join(ROOT, dir))) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    if (rel === DEFINITION) continue;
    const src = stripComments(fs.readFileSync(file, "utf8"));
    const re = /\bsignAuthToken\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const open = m.index + m[0].length - 1;
      const args = callArguments(src, open);
      minters.set(rel, (minters.get(rel) ?? 0) + 1);
      if (args.length < 3) {
        const line = src.slice(0, m.index).split("\n").length;
        violations.push(`${rel}:${line} signAuthToken(${args.join(", ")})`);
      }
    }
  }
}

for (const expected of EXPECTED_MINTERS) {
  ok(`${expected} mints a token (scan is not vacuous)`, (minters.get(expected) ?? 0) > 0);
}
ok(
  "every production signAuthToken call names a session",
  violations.length === 0,
  violations.join("\n        ")
);

// Signup specifically: the session it names is the one its own transaction
// wrote, and the refresh credential is set exactly as login sets it.
{
  const route = fs.readFileSync(path.join(ROOT, "app/api/auth/register/route.ts"), "utf8");
  ok(
    "signup signs with the account's own AuthSession id",
    /signToken\(\s*account\.userId,\s*account\.tokenVersion,\s*account\.session\.sessionId\s*\)/.test(route)
  );
  ok("signup sets the refresh cookie", /setRefreshCookie\(\s*res,\s*account\.session\.credential/.test(route));
  const signup = fs.readFileSync(path.join(ROOT, "lib/auth/signup.ts"), "utf8");
  ok(
    "signup issues the session inside the account transaction",
    /\$transaction\(async \(tx\)[\s\S]*issueRefreshSession\(tx,/.test(signup)
  );
}

if (failed > 0) {
  console.error(`\nsession-bound-token-guard: ${failed} FAILED`);
  process.exit(1);
}
console.log("\nPASS");
