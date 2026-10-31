/**
 * The accountant's one-time code on a new device (G5 M5), pure:
 *   npx tsx lib/accountant/link-device.verify.test.ts
 *
 *  - codes: six digits from the CSPRNG, uniform enough (every digit position varies), never the same twice in a row
 *    of many; the HMAC binds the code to its delivery and its salt; keys depend on AUTH_TOKEN_SECRET;
 *  - limits: one code per 60 s, 3 per 15 minutes, 10 per 24 hours — with the right retry time;
 *  - the device cookie: httpOnly, SameSite=Strict, path-scoped, Secure in production, Max-Age = the link's remaining
 *    life; one cookie name per link that reveals nothing; a cookie of another link or a malformed one is not read;
 *  - the masked address and the code email (the code, no link, no address of anyone else, escaped).
 */
process.env.AUTH_TOKEN_SECRET = "acct-lab-synthetic-auth-token-secret-0123456789";

import {
  CODE_LIMIT_15MIN,
  CODE_LIMIT_DAY,
  codeIssueDecision,
  deviceCookie,
  deviceCookieName,
  hashCode,
  hashDeviceToken,
  isCode,
  maskEmail,
  newCode,
  readDeviceToken,
} from "./link-device";
import { renderAccountantCodeEmail } from "./email-template";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`OK: ${name}`);
  else { failed++; console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}

// Codes
const codes = Array.from({ length: 2000 }, () => newCode());
ok("codes are six digits", codes.every((c) => isCode(c)));
ok("every digit position takes all ten values over 2000 codes", [0, 1, 2, 3, 4, 5].every((i) => new Set(codes.map((c) => c[i])).size === 10));
ok("codes are not repeated in bulk (≥ 1990 distinct of 2000)", new Set(codes).size >= 1990);
ok("isCode refuses anything but six digits", !isCode("12345") && !isCode("1234567") && !isCode("12a456") && !isCode(123456) && !isCode(" 123456"));
const salt = "0123456789abcdef0123456789abcdef";
ok("the HMAC is 64 hex and depends on the delivery, the salt and the code",
  /^[0-9a-f]{64}$/.test(hashCode(1, salt, "123456")) && hashCode(1, salt, "123456") !== hashCode(2, salt, "123456") &&
    hashCode(1, salt, "123456") !== hashCode(1, salt.replace("0", "1"), "123456") && hashCode(1, salt, "123456") !== hashCode(1, salt, "123457"));
ok("code and device keys are separate", hashCode(1, salt, "123456") !== hashDeviceToken(`1.${salt}.123456`));
const h1 = hashDeviceToken("x".repeat(43));
process.env.AUTH_TOKEN_SECRET = "another-synthetic-secret-0123456789abcdef";
ok("the keys come from AUTH_TOKEN_SECRET", hashDeviceToken("x".repeat(43)) !== h1);
process.env.AUTH_TOKEN_SECRET = "acct-lab-synthetic-auth-token-secret-0123456789";
const saved = process.env.AUTH_TOKEN_SECRET;
delete process.env.AUTH_TOKEN_SECRET;
let threw = false;
try { hashDeviceToken("x"); } catch { threw = true; }
ok("no AUTH_TOKEN_SECRET → refuses (never an unkeyed hash)", threw);
process.env.AUTH_TOKEN_SECRET = saved;

// Limits
const t = new Date("2026-11-01T10:00:00Z");
const ago = (ms: number) => new Date(t.getTime() - ms);
ok("first code: allowed", codeIssueDecision([], t).ok);
const cd = codeIssueDecision([ago(20_000)], t);
ok("within 60 s: cooldown, retry after 40 s", !cd.ok && cd.reason === "cooldown" && cd.retryAfterSec === 40, JSON.stringify(cd));
ok("after 60 s: allowed", codeIssueDecision([ago(61_000)], t).ok);
const l15 = codeIssueDecision([ago(2 * 60_000), ago(5 * 60_000), ago(10 * 60_000)], t);
ok(`${CODE_LIMIT_15MIN} in 15 minutes: refused until the oldest leaves the window`, !l15.ok && l15.reason === "limit_15min" && l15.retryAfterSec === 5 * 60, JSON.stringify(l15));
ok("3 codes, the oldest 16 minutes ago: allowed", codeIssueDecision([ago(2 * 60_000), ago(5 * 60_000), ago(16 * 60_000)], t).ok);
const dayIssued = Array.from({ length: CODE_LIMIT_DAY }, (_, i) => ago((i + 1) * 60 * 60_000));
const ld = codeIssueDecision(dayIssued, t);
ok(`${CODE_LIMIT_DAY} in 24 hours: refused (limit_day)`, !ld.ok && ld.reason === "limit_day" && ld.retryAfterSec === 14 * 3600, JSON.stringify(ld));
ok("older than 24 hours do not count", codeIssueDecision(Array.from({ length: 20 }, (_, i) => ago(25 * 3600_000 + i)), t).ok);

// The device cookie
const pub = "A".repeat(32);
const name = deviceCookieName(pub);
ok("one cookie name per link, revealing nothing of it", /^dz_acct_[0-9a-f]{16}$/.test(name) && name !== deviceCookieName("B".repeat(32)) && !name.includes(pub.slice(0, 8)));
const token = "a".repeat(43);
const expires = new Date(t.getTime() + 3 * 86400_000);
const prevEnv = process.env.NODE_ENV;
(process.env as Record<string, string>).NODE_ENV = "production";
const c = deviceCookie(pub, token, expires, t);
ok("cookie: HttpOnly, SameSite=Strict, Path=/api/accountant/link, Secure in production, Max-Age = the link's remaining life",
  c.includes("HttpOnly") && c.includes("SameSite=Strict") && c.includes("Path=/api/accountant/link;") && c.includes("Secure") && c.includes(`Max-Age=${3 * 86400}`), c);
(process.env as Record<string, string>).NODE_ENV = prevEnv ?? "test";
ok("an expired link gives Max-Age=0", deviceCookie(pub, token, ago(1000), t).includes("Max-Age=0"));
const req = (cookie: string) => new Request("https://app.example.com/api/accountant/link/portal", { headers: { cookie } });
ok("the link's own cookie is read", readDeviceToken(req(`other=1; ${name}=${token}; x=y`), pub) === token);
ok("another link's cookie is not", readDeviceToken(req(`${deviceCookieName("B".repeat(32))}=${token}`), pub) === null);
ok("a malformed value is not", readDeviceToken(req(`${name}=short`), pub) === null && readDeviceToken(req(`${name}=${"a".repeat(42)}!`), pub) === null);
ok("no cookie header → none", readDeviceToken(new Request("https://app.example.com/"), pub) === null);

// Mask + email
ok("masked address", maskEmail("dana@example.com") === "d•••@example.com" && maskEmail("x") === "•••");
const m = renderAccountantCodeEmail({ businessName: "מאפיית <הלב>", periodLabel: "ספטמבר 2026", code: "042517", minutes: 10 });
ok("the email carries the code, the business and the month, valid 10 minutes", m.text.includes("042517") && m.html.includes("042517") && m.text.includes("ספטמבר 2026") && m.text.includes("10 דקות"));
ok("the email has no link and escapes markup", !/https?:\/\//.test(m.text) && !/href=/.test(m.html) && m.html.includes("&lt;הלב&gt;") && !m.html.includes("<הלב>"));
ok("a malformed code is never printed", !renderAccountantCodeEmail({ businessName: "x", periodLabel: "y", code: "<b>1</b>", minutes: 10 }).html.includes("<b>1</b>"));

if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
console.log("\nall passed");
