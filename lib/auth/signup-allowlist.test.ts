/**
 * Closed-beta signup allowlist — parsing, fail-closed behaviour, normalisation parity with signup,
 * and the register page's use of it. Pure: no database, no network.
 *   npx tsx lib/auth/signup-allowlist.test.ts
 */
import fs from "node:fs";
import path from "node:path";

import { CLOSED_BETA_ACCESS, MAX_SIGNUP_ALLOWLIST, parseSignupAllowlist, readSignupAllowlist } from "./signup-allowlist";
import { normalizeEmail, normalizeSignupInput } from "./signup-identity";

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

// ── no list = today ──────────────────────────────────────────────────────────
for (const raw of [undefined, "", "   ", ",", " , \n "]) {
  const l = parseSignupAllowlist(raw);
  ok(`unset/empty ${JSON.stringify(raw)} → not configured, admits no one, no error`, !l.configured && l.error === null && !l.has("a@b.co"));
}
ok("read from env: SIGNUP_ALLOWED_EMAILS absent → not configured", !readSignupAllowlist({}).configured);

// ── exact addresses ──────────────────────────────────────────────────────────
{
  const l = parseSignupAllowlist("owner@example.co.il, second@example.com");
  ok("two exact addresses → configured, size 2", l.configured && l.size === 2 && l.error === null);
  ok("a listed address is admitted", l.has("owner@example.co.il"));
  ok("…after signup's own normalisation (case, surrounding space)", l.has("  OWNER@Example.CO.IL ") && l.has("Second@EXAMPLE.com"));
  ok("an unlisted address on the SAME domain is not admitted (no domain-wide allowance)", !l.has("other@example.co.il"));
  ok("a sub-address / look-alike is not admitted", !l.has("owner+x@example.co.il") && !l.has("owner@example.co.il.evil.com") && !l.has("xowner@example.co.il"));
  ok("non-string input is never admitted", !l.has(undefined as never) && !l.has(null as never));
  ok("new-line separated entries work", parseSignupAllowlist("a@b.co\nc@d.co").size === 2);
  ok("list entries are normalised the same way", parseSignupAllowlist("  MiXeD@Case.Com ").has("mixed@case.com"));
}

// ── fail closed: one bad entry voids the whole list ──────────────────────────
for (const [raw, why] of [
  ["*", "a bare wildcard"],
  ["*@example.com", "a wildcard local part"],
  ["owner@*.com", "a wildcard domain"],
  ["@example.com", "a domain-wide entry"],
  ["example.com", "a bare domain"],
  ["owner@example", "no dot in the domain"],
  ["owner@@example.com", "two @"],
  ["owner name@example.com", "a space inside"],
  ["Owner <owner@example.com>", "a display-name form"],
  ["owner@example.com;other@example.com", "a semicolon separator"],
  ["%@example.com", "a percent pattern"],
  ["owner@example.com, *@example.com", "one good entry and one wildcard"],
  ["owner@example.com, broken", "one good entry and one malformed"],
] as const) {
  const l = parseSignupAllowlist(raw);
  ok(`fail closed — ${why}: the WHOLE list is ignored`, !l.configured && l.error === "invalid_entry" && !l.has("owner@example.com"), JSON.stringify(raw));
}
{
  const many = Array.from({ length: MAX_SIGNUP_ALLOWLIST + 1 }, (_, i) => `u${i}@example.com`).join(",");
  const l = parseSignupAllowlist(many);
  ok(`more than ${MAX_SIGNUP_ALLOWLIST} entries → ignored (too_many)`, !l.configured && l.error === "too_many" && !l.has("u0@example.com"));
  const max = parseSignupAllowlist(Array.from({ length: MAX_SIGNUP_ALLOWLIST }, (_, i) => `u${i}@example.com`).join(","));
  ok(`exactly ${MAX_SIGNUP_ALLOWLIST} entries → configured`, max.configured && max.size === MAX_SIGNUP_ALLOWLIST);
}

// ── normalisation parity: the allowlist compares exactly what createAccount will store ──────
{
  const input = normalizeSignupInput({ email: "  Dana.Cohen@Example.CO.IL ", password: "sup3rsecret", name: "דנה", businessName: "עסק", acceptTerms: true } as never);
  const l = parseSignupAllowlist("dana.cohen@example.co.il");
  ok("the address signup stores is the address the allowlist matches", input.email === normalizeEmail("dana.cohen@example.co.il") && l.has(input.email));
  const src = fs.readFileSync(path.join(process.cwd(), "lib/auth/signup-allowlist.ts"), "utf8");
  ok("the allowlist imports signup's normalizeEmail (one definition, not a copy)",
    /import \{ normalizeEmail \} from "\.\/signup-identity"/.test(src) && !/toLowerCase\(\)/.test(src));
}

// ── the register page: public /register unchanged; the form only behind the explicit entry ──
{
  const page = fs.readFileSync(path.join(process.cwd(), "app/register/page.tsx"), "utf8");
  ok("page: public open → the form, as today", /if \(isPublicSignupEnabled\(\)\) return <RegisterForm \/>;/.test(page));
  ok("page: closed → the form ONLY for ?access=beta AND a valid list",
    /access === CLOSED_BETA_ACCESS && readSignupAllowlist\(\)\.configured/.test(page) && CLOSED_BETA_ACCESS === "beta");
  ok("page: every other closed request → the closed notice", /return <SignupClosedNotice \/>;\s*\}\s*$/.test(page.trim() + "\n"));
}

console.log(`\n[signup-allowlist] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
