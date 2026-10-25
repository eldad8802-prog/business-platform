/**
 * OAuth signup tickets + the Google sign-in policy — the pure half (no database, no network).
 *   npx tsx lib/auth/oauth-ticket.test.ts
 *
 * The database half (single use under concurrency, replay, rollback, attach guards, privileges) is proved
 * against PostgreSQL by .agl/battery.ts and .agl/app-battery.ts (oauth-identity-lab.yml). Here:
 *   - the secret: 32 random bytes, base64url, never repeated; the hash is exactly the database's;
 *   - a cookie value that cannot be a ticket never reaches the database;
 *   - static scope: the module reaches the tables ONLY through the six definer functions, spends a ticket
 *     only for SIGNUP, logs nothing, and no route imports it yet (milestone 1: nothing is reachable);
 *   - the policy: a platform admin and a business in deletion get no session through Google; the
 *     password login route does not use the policy (F-1 is a separate decision).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UserRole } from "@prisma/client";

import { hashTicketSecret, isTicketSecret, mintTicketSecret } from "./oauth-ticket";
import { googleSignInRefusal } from "./google-sign-in-policy";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok  - ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  - ${name}${detail ? ` (${detail})` : ""}`);
  }
}

// ── the secret ────────────────────────────────────────────────────────────────
const minted = Array.from({ length: 200 }, () => mintTicketSecret());
ok("a minted secret is 43 base64url characters (32 bytes)", minted.every((m) => /^[A-Za-z0-9_-]{43}$/.test(m.secret)));
ok("200 minted secrets are all distinct", new Set(minted.map((m) => m.secret)).size === 200);
ok("the hash is sha256(secret) hex — what encode(sha256(convert_to(s,'UTF8')),'hex') computes",
  minted.every((m) => m.secretHash === createHash("sha256").update(m.secret, "utf8").digest("hex") && /^[0-9a-f]{64}$/.test(m.secretHash)));
ok("known vector", hashTicketSecret("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
for (const v of [undefined, null, 42, "", "x".repeat(42), "x".repeat(44), `${"x".repeat(42)}=`, `${"x".repeat(42)}+`, "' OR 1=1 --"]) {
  ok(`not a ticket secret: ${JSON.stringify(v)?.slice(0, 30)}`, !isTicketSecret(v));
}
ok("a minted secret is a ticket secret", isTicketSecret(minted[0].secret));

// ── static scope ──────────────────────────────────────────────────────────────
const ROOT = process.cwd();
const src = fs.readFileSync(path.join(ROOT, "lib/auth/oauth-ticket.ts"), "utf8");
const called = [...src.matchAll(/public\.(auth_[a-z_]+)\(/g)].map((m) => m[1]);
ok("the module calls exactly the seven definer functions (purge through its sweep entry too; cancel of 20261101090000)",
  [...new Set(called)].sort().join(",") === [
    "auth_oauth_identity_attach", "auth_oauth_identity_resolve", "auth_oauth_ticket_cancel", "auth_oauth_ticket_consume",
    "auth_oauth_ticket_issue", "auth_oauth_ticket_purge", "auth_oauth_ticket_read",
  ].join(","), called.join(","));
ok("it never names a table (no direct read or write of OAuthSignupTicket / UserIdentity)",
  !/"OAuthSignupTicket"|"UserIdentity"|\.oAuthSignupTicket\.|\.userIdentity\./.test(src));
ok("it spends and reads tickets for SIGNUP only (LINK arrives with milestone 3)",
  /auth_oauth_ticket_consume\(\$\{secret\}, 'SIGNUP'\)/.test(src) && /auth_oauth_ticket_read\(\$\{secret\}, 'SIGNUP'\)/.test(src) && !/'LINK'/.test(src));
ok("it uses tagged $queryRaw only (no Unsafe interpolation)", /\$queryRaw</.test(src) && !/\$queryRawUnsafe|\$executeRawUnsafe/.test(src));
ok("it logs nothing", !/console\./.test(src));
ok("it rejects a malformed secret before any query", /if \(!isTicketSecret\(secret\)\) throw new SignupTicketRefusedError\(\)/.test(src)
  && /if \(!isTicketSecret\(secret\)\) return null/.test(src));

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const importers = [...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "lib"))]
  .filter((f) => !/\.test\.ts$/.test(f))
  .filter((f) => /from ["']@\/lib\/auth\/(oauth-ticket|google-id-token|google-sign-in-policy)["']|from ["']\.\/(oauth-ticket|google-id-token|google-sign-in-policy)["']/.test(fs.readFileSync(f, "utf8")))
  .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"));
// Milestone 2: the Google modules are reachable through exactly these files — the four Google routes, the
// account transaction, the callback decision and the scheduled sweep. Anything else importing them fails.
const ALLOWED_IMPORTERS = new Set([
  "app/api/auth/google/callback/route.ts",
  "app/api/auth/google/complete/route.ts",
  "app/api/auth/google/ticket/route.ts",
  "app/api/transactional-email/sweep/route.ts",
  "lib/auth/google-sign-in.ts",
  "lib/auth/oauth-ticket.ts", // the GoogleIdentity type
  "lib/auth/signup.ts",
]);
ok("the Google modules are imported only by the Google routes, the account transaction, the decision and the sweep",
  importers.every((f) => ALLOWED_IMPORTERS.has(f)), importers.filter((f) => !ALLOWED_IMPORTERS.has(f)).join(", "));

// ── the Google sign-in policy ─────────────────────────────────────────────────
const alive = { deletionRequestedAt: null, deletedAt: null };
ok("an owner of a live business may sign in with Google", googleSignInRefusal({ role: UserRole.USER, business: alive }) === null);
ok("a platform admin may not (v1)", googleSignInRefusal({ role: UserRole.PLATFORM_ADMIN, business: alive }) === "PLATFORM_ADMIN");
ok("deletion requested → no session", googleSignInRefusal({ role: UserRole.USER, business: { deletionRequestedAt: new Date(), deletedAt: null } }) === "BUSINESS_UNAVAILABLE");
ok("purged → no session", googleSignInRefusal({ role: UserRole.USER, business: { deletionRequestedAt: new Date(), deletedAt: new Date() } }) === "BUSINESS_UNAVAILABLE");
ok("no business → no session", googleSignInRefusal({ role: UserRole.USER, business: null }) === "BUSINESS_UNAVAILABLE");
const loginSrc = fs.readFileSync(path.join(ROOT, "app/api/auth/login/route.ts"), "utf8");
ok("F-1 stays separate: the password login route does not use the Google policy", !/google-sign-in-policy|googleSignInRefusal/.test(loginSrc));
ok("the login route answers a missing password like a wrong one (equaliser compare + null check)",
  /bcrypt\.compare\(password, user\.password \?\? TIMING_EQUALISER_HASH\)\) && user\.password !== null/.test(loginSrc));

console.log(`\n[oauth-ticket] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
