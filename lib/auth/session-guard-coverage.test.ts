/**
 * Session guard coverage — a source lock (no browser, no DB):
 *   npx tsx lib/auth/session-guard-coverage.test.ts
 *
 * Two regressions this exists to stop, both found on a device:
 *
 *   1. A screen that deletes the token itself. Every such site decided on its
 *      own — signing people out on a 401 a refresh would have fixed, or clearing
 *      the token and staying on a page full of business data. Only the auth
 *      modules may remove it; everyone else calls redirectToLogin().
 *
 *   2. An authenticated page with no session coordinator. /settings/team sat
 *      outside (shell), so nothing refreshed there and nothing noticed when the
 *      server ended the session. Every page that reads the token must be under a
 *      layout (or render a component) that mounts the coordinator — ShellChrome,
 *      RefreshCoordinator — or be on the explicit public allowlist.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  ok  - ${name}`);
  else {
    failed += 1;
    console.error(`FAIL  - ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\.(tsx?|jsx?)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, "/");

// ── 1. who may remove the token ─────────────────────────────────────────────
const MAY_REMOVE = new Set(["lib/client-session.ts", "lib/auth/refresh-client.ts", "lib/auth/session-guard.ts"]);
const REMOVE = /removeItem\(\s*["']token["']\s*\)/;
const sources = ["app", "components", "lib", "hooks", "features"].filter((d) => existsSync(join(ROOT, d))).flatMap((d) => walk(join(ROOT, d)));
const removers = sources.filter((f) => REMOVE.test(readFileSync(f, "utf8"))).map(rel);
const strays = removers.filter((f) => !MAY_REMOVE.has(f));
ok("only the auth modules remove the token", strays.length === 0, strays.join(", "));
ok("detector bites: it sees a removal", REMOVE.test('localStorage.removeItem("token")') && REMOVE.test("window.localStorage.removeItem('token')"));

// ── 2. every token-reading page is under the session coordinator ────────────
const READS_TOKEN = /getItem\(\s*["']token["']\s*\)|getClientAuthToken\(|buildClientAuthHeaders\(|redirectToLogin\(/;
const COVERS = /\bShellChrome\b|\bRefreshCoordinator\b/;
/** Public by design: signing in, signing up, account links, the public booking/landing pages, marketing. */
const PUBLIC = [/^app\/login\//, /^app\/register\//, /^app\/auth\//, /^app\/link\//, /^app\/book\//, /^app\/a\//,
  /^app\/verify-email\//, /^app\/reset-password\//, /^app\/forgot-password\//, /^app\/\(corporate\)\//, /^app\/test-upload\//, /^app\/dev\//];

const appDir = join(ROOT, "app");
const pages = walk(appDir).filter((f) => /\/page\.tsx$/.test(rel(f)) && !rel(f).startsWith("app/api/"));
const uncovered: string[] = [];
let checked = 0;
for (const page of pages) {
  const r = rel(page);
  if (PUBLIC.some((re) => re.test(r))) continue;
  // The page, or any module in its own directory, reads the token?
  const dir = dirname(page);
  const local = readdirSync(dir).filter((n) => /\.(tsx?|jsx?)$/.test(n)).map((n) => readFileSync(join(dir, n), "utf8")).join("\n");
  if (!READS_TOKEN.test(local)) continue;
  checked += 1;
  if (r.startsWith("app/(shell)/")) continue; // (shell)/layout mounts ShellChrome
  if (COVERS.test(local)) continue;
  let covered = false;
  for (let d = dir; rel(d).startsWith("app"); d = dirname(d)) {
    const layout = ["layout.tsx", "layout.ts"].map((n) => join(d, n)).find((p) => existsSync(p));
    if (layout && COVERS.test(readFileSync(layout, "utf8"))) { covered = true; break; }
    if (rel(d) === "app") break;
  }
  if (!covered) uncovered.push(r);
}
console.log(`  [measured] token-reading pages checked: ${checked}`);
ok("every token-reading page is under the session coordinator (or explicitly public)", uncovered.length === 0, uncovered.join(", "));
// Rendered, not merely imported: the JSX element itself must be there.
const MOUNTS = /<RefreshCoordinator>/;
ok("the coordinator is mounted by ShellChrome", MOUNTS.test(readFileSync(join(ROOT, "components/navigation/shell-chrome.tsx"), "utf8")));
ok("...and by the admin console layout", MOUNTS.test(readFileSync(join(ROOT, "app/(platform-admin)/layout.tsx"), "utf8")));
ok("...and by the onboarding layout", MOUNTS.test(readFileSync(join(ROOT, "app/onboarding/layout.tsx"), "utf8")));

// ── 3. the guard reads the SAME pending-sign-out marker the sign-out writes ──
// lib/client-session.ts owns it (PENDING_REVOKE_KEY, the "clear this device
// anyway" flow). Until that lands here the check is vacuous; once it does, a
// renamed key on either side would silently let recovery resume a session the
// person asked this device to forget.
{
  const guard = readFileSync(join(ROOT, "lib/auth/session-guard.ts"), "utf8").match(/PENDING_REVOKE_KEY = "([^"]+)"/)?.[1];
  const writer = readFileSync(join(ROOT, "lib/client-session.ts"), "utf8").match(/PENDING_REVOKE_KEY = "([^"]+)"/)?.[1];
  ok("the guard names the pending-sign-out marker", typeof guard === "string" && guard.length > 0);
  ok("...and it is the key the sign-out writes (when the sign-out flow is present)", writer === undefined || writer === guard, `${guard} vs ${writer}`);
}

// ── 4. every sign-in drops a pending sign-out marker it has made moot ──
// A new sign-in replaces the refresh cookie that proved the older pending
// sign-out. A marker left behind is later "completed" against the NEW cookie
// and shows the new account a false "sign-out not confirmed" (and disables the
// guard's no-token recovery). Each path that stores a NEW session must clear it;
// the two form paths first try to finish it while the proof is still in the jar.
{
  const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
  const login = read("app/login/login-form.tsx");
  const register = read("app/register/register-form.tsx");
  const google = read("components/auth/google-sign-in.tsx");
  const order = (s: string, before: RegExp, after: RegExp) => {
    const a = s.search(before);
    const b = s.search(after);
    return a >= 0 && b >= 0 && a < b;
  };
  ok("sign-in: login finishes a pending sign-out BEFORE it posts the credentials",
    order(login, /await finishPendingRevokeBeforeSignIn\(\)/, /fetch\("\/api\/auth\/login"/));
  ok("...and drops the marker once the new token is stored",
    order(login, /setItem\("token", data\.token\)/, /clearPendingRevoke\(\);/));
  ok("sign-up: the same, before /api/auth/register and after the token",
    order(register, /await finishPendingRevokeBeforeSignIn\(\)/, /fetch\("\/api\/auth\/register"/) &&
      order(register, /setItem\("token", registerData\.token\)/, /clearPendingRevoke\(\);/));
  ok("Google (web): the marker is dropped once the session from the new cookie is established",
    order(google, /const token = readToken\(\);/, /clearPendingRevoke\(\);/));
  ok("/login re-checks a kept session when the device comes back online",
    /addEventListener\("online", onOnline\)/.test(login) && /getItem\("token"\)\) void boot\(\)/.test(login));
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
if (failed > 0) process.exit(1);
