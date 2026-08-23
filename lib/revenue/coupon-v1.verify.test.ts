/**
 * Coupons v1 — pure-logic verify (NO DB required):
 *   npx tsx lib/revenue/coupon-v1.verify.test.ts
 *
 * Covers the invariants the audit found unenforced:
 *   - benefit validation: 0%, >100%, 24 digits, empty, bad money  (COUPON-07)
 *   - the stored sentence can never contain a placeholder          (COUPON-12)
 *   - terms require the amount they claim                          (COUPON-06)
 *   - end date: past, missing, too far, Israel end-of-day          (COUPON-08)
 *   - lifecycle: active / expired-by-time / disabled / redeemed    (COUPON-02)
 *   - disable/enable transition rules
 *   - base-URL resolution never throws on a missing env var        (COUPON-01)
 *
 * The DB-touching services are exercised by the tenant-isolation suite and by
 * the browser smoke run; this file locks the decision logic they depend on.
 */

import {
  benefitSegment,
  composeBenefitSentence,
  isBenefitType,
  validateBenefit,
  SCOPE_WHOLE_BUSINESS,
  type BenefitType,
} from "@/lib/revenue/coupon-benefit";
import {
  composeTermsText,
  israelEndOfDay,
  maxValidUntilDate,
  validateTerms,
  validateValidUntil,
} from "@/lib/revenue/coupon-terms";
import {
  couponTitle,
  initialDraft,
  titleInputValue,
} from "@/components/coupon/coupon-model";
import {
  canDisable,
  canEditEconomics,
  canEnable,
  deriveLifecycleState,
} from "@/lib/revenue/coupon-lifecycle";
import {
  buildCouponQrValue,
  CouponBaseUrlError,
  isPubliclyReachable,
  resolveCouponBaseUrl,
} from "@/lib/revenue/coupon-base-url";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const scope = SCOPE_WHOLE_BUSINESS;
const valid = (benefitType: BenefitType, value: string, s = scope) =>
  validateBenefit({ benefitType, value, scope: s }).length === 0;

// ── 1. Percentage bounds — the audit published 0% and 999% ──────────────────
ok("pct: 20 is valid", valid("pct", "20"));
ok("pct: 1 is valid (lower bound)", valid("pct", "1"));
ok("pct: 100 is valid (upper bound)", valid("pct", "100"));
ok("pct: 0 is rejected", !valid("pct", "0"));
ok("pct: 101 is rejected", !valid("pct", "101"));
ok("pct: 999 is rejected", !valid("pct", "999"));
ok("pct: empty is rejected", !valid("pct", ""));
ok("pct: 24 digits is rejected", !valid("pct", "123456789012345678901234"));
ok("pct: decimals are rejected", !valid("pct", "20.5"));
ok("pct: non-numeric is rejected", !valid("pct", "abc"));
ok("pct: negative is rejected", !valid("pct", "-5"));
ok(
  "pct: error names the value field",
  validateBenefit({ benefitType: "pct", value: "0", scope }).some((e) => e.field === "value")
);

// ── 2. Money bounds ──────────────────────────────────────────────────────────
ok("amt: 50 is valid", valid("amt", "50"));
ok("amt: 49.90 is valid", valid("amt", "49.90"));
ok("amt: 0 is rejected", !valid("amt", "0"));
ok("amt: empty is rejected", !valid("amt", ""));
ok("amt: 3 decimals is rejected", !valid("amt", "10.005"));
ok("amt: above ceiling is rejected", !valid("amt", "100001"));
ok("amt: 24 digits is rejected", !valid("amt", "123456789012345678901234"));
ok("price: 0 is rejected", !valid("price", "0"));
ok("price: 35 is valid", valid("price", "35"));

// ── 3. Free-text benefits ────────────────────────────────────────────────────
ok("gift: named product is valid", valid("giftProduct", "קפה הפוך"));
ok("gift: empty is rejected", !valid("giftProduct", ""));
ok("gift: single char is rejected", !valid("giftProduct", "א"));
ok("gift: over 60 chars is rejected", !valid("giftProduct", "א".repeat(61)));
ok("other: requires a description", !valid("other", ""));
ok("other: described is valid", valid("other", "הטבת חורף"));
ok("more: 1+1 is valid", valid("more", "1+1"));

// ── 4. Scope ─────────────────────────────────────────────────────────────────
ok("scope: whole business is valid", valid("pct", "20", SCOPE_WHOLE_BUSINESS));
ok("scope: typed product name is valid", valid("pct", "20", "קפה הפוך"));
ok("scope: empty is rejected", !valid("pct", "20", ""));
ok("scope: blank-only is rejected", !valid("pct", "20", "   "));
ok("scope: over 40 chars is rejected", !valid("pct", "20", "א".repeat(41)));

// ── 5. Unknown benefit type is refused outright ──────────────────────────────
ok("type: unknown key is not a BenefitType", !isBenefitType("bogus"));
ok("type: unknown key fails validation", validateBenefit({ benefitType: "bogus" as BenefitType, value: "20", scope }).length > 0);

// ── 6. The stored sentence never carries a placeholder (COUPON-12) ───────────
// Every sentence that can reach the database is composed from validated parts,
// so the audit's "50₪ על קטגוריה" / "קפה הפוך מתנה על כל העסק" artefacts are
// structurally unreachable: the scope half is either a real typed noun or the
// literal "כל העסק".
const CASES: { type: BenefitType; value: string; scope: string; expect: string }[] = [
  { type: "pct", value: "20", scope: SCOPE_WHOLE_BUSINESS, expect: "20% הנחה על כל העסק" },
  { type: "amt", value: "50", scope: "קפה הפוך", expect: "50₪ הנחה על קפה הפוך" },
  { type: "amt", value: "49.90", scope: SCOPE_WHOLE_BUSINESS, expect: "49.9₪ הנחה על כל העסק" },
  { type: "price", value: "35", scope: "ארוחת בוקר", expect: "במחיר 35₪ על ארוחת בוקר" },
  { type: "giftProduct", value: "קרואסון", scope: "כל העסק", expect: "קרואסון מתנה על כל העסק" },
  { type: "more", value: "1+1", scope: "פיצות", expect: "1+1 על פיצות" },
];
for (const c of CASES) {
  const input = { benefitType: c.type, value: c.value, scope: c.scope };
  ok(`sentence: ${c.type} → "${c.expect}"`, composeBenefitSentence(input) === c.expect);
  ok(`sentence: ${c.type} passes validation`, validateBenefit(input).length === 0);
}
const PLACEHOLDERS = ["—", "…", "undefined", "null", "NaN"];
for (const c of CASES) {
  const sentence = composeBenefitSentence({ benefitType: c.type, value: c.value, scope: c.scope });
  ok(
    `sentence: ${c.type} contains no placeholder`,
    !PLACEHOLDERS.some((p) => sentence.includes(p))
  );
}
ok("segment: money is normalized (50.00 → 50)", benefitSegment("amt", "50.00") === "50₪ הנחה");

// ── 7. Terms require their amount (COUPON-06) ────────────────────────────────
ok(
  "terms: minimum purchase ON with no amount is rejected",
  validateTerms({ minPurchaseEnabled: true, minPurchaseRaw: "" }).errors.length > 0
);
ok(
  "terms: minimum purchase ON with 0 is rejected",
  validateTerms({ minPurchaseEnabled: true, minPurchaseRaw: "0" }).errors.length > 0
);
ok(
  "terms: minimum purchase ON with 100 is accepted",
  validateTerms({ minPurchaseEnabled: true, minPurchaseRaw: "100" }).terms.minPurchase === 100
);
ok(
  "terms: minimum purchase OFF ignores a stale amount",
  validateTerms({ minPurchaseEnabled: false, minPurchaseRaw: "100" }).terms.minPurchase === null
);
ok(
  "terms: text reads correctly",
  composeTermsText({ minPurchase: 100, newCustomersOnly: true }) === "בקנייה מעל 100₪ · ללקוחות חדשים בלבד"
);
ok("terms: no terms → empty string", composeTermsText({ minPurchase: null, newCustomersOnly: false }) === "");

// ── 8. Validity (COUPON-08) ──────────────────────────────────────────────────
const NOW = new Date("2026-08-20T09:00:00.000Z");
const future = new Date("2026-09-01T20:59:59.999Z");
const past = new Date("2026-08-19T20:59:59.999Z");
ok("date: future end date is valid", validateValidUntil(future, NOW).length === 0);
ok("date: past end date is rejected", validateValidUntil(past, NOW).length > 0);
ok("date: same instant is rejected", validateValidUntil(NOW, NOW).length > 0);
ok("date: invalid date is rejected", validateValidUntil(new Date(NaN), NOW).length > 0);
ok(
  "date: beyond one year is rejected",
  validateValidUntil(new Date("2027-12-31T00:00:00.000Z"), NOW).length > 0
);
ok("date: malformed input string is invalid", Number.isNaN(israelEndOfDay("not-a-date").getTime()));
ok("date: empty input string is invalid", Number.isNaN(israelEndOfDay("").getTime()));

// Israel end-of-day: a date picked in Israel must die at 23:59:59.999 local,
// not UTC — otherwise "today" expires 2–3 hours early.
const summer = israelEndOfDay("2026-08-20"); // IDT = UTC+3
ok("date: IDT end-of-day is 20:59:59.999Z", summer.toISOString() === "2026-08-20T20:59:59.999Z");
const winter = israelEndOfDay("2026-01-15"); // IST = UTC+2
ok("date: IST end-of-day is 21:59:59.999Z", winter.toISOString() === "2026-01-15T21:59:59.999Z");
ok(
  "date: end-of-day is the last instant of the local day",
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", dateStyle: "short" }).format(summer) ===
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", dateStyle: "short" }).format(
      new Date(summer.getTime() - 1000)
    )
);

// ── 9. Lifecycle (COUPON-02) ─────────────────────────────────────────────────
const soon = new Date(NOW.getTime() + 86_400_000);
const gone = new Date(NOW.getTime() - 86_400_000);

ok("state: ACTIVE + future expiry → ACTIVE", deriveLifecycleState({ status: "ACTIVE", expiresAt: soon }, NOW) === "ACTIVE");
ok("state: CANCELLED → DISABLED", deriveLifecycleState({ status: "CANCELLED", expiresAt: soon }, NOW) === "DISABLED");
ok("state: REDEEMED → REDEEMED", deriveLifecycleState({ status: "REDEEMED", expiresAt: soon }, NOW) === "REDEEMED");
ok("state: EXPIRED enum → EXPIRED", deriveLifecycleState({ status: "EXPIRED", expiresAt: gone }, NOW) === "EXPIRED");
// The decisive one: the stored enum still says ACTIVE (it is only flipped
// lazily on a redeem attempt), but time has passed. Reading the enum alone
// would show a dead coupon as live in the owner's list.
ok(
  "state: ACTIVE enum but past expiry → EXPIRED (derived from time)",
  deriveLifecycleState({ status: "ACTIVE", expiresAt: gone }, NOW) === "EXPIRED"
);
ok(
  "state: expiry wins over a disable once the date has passed",
  deriveLifecycleState({ status: "CANCELLED", expiresAt: gone }, NOW) === "EXPIRED"
);
ok(
  "state: redeemed wins over expiry",
  deriveLifecycleState({ status: "REDEEMED", expiresAt: gone }, NOW) === "REDEEMED"
);

ok("transition: only ACTIVE can be disabled", canDisable("ACTIVE") && !canDisable("DISABLED") && !canDisable("EXPIRED") && !canDisable("REDEEMED"));
ok("transition: only DISABLED can be enabled", canEnable("DISABLED") && !canEnable("ACTIVE") && !canEnable("EXPIRED") && !canEnable("REDEEMED"));
ok("transition: an expired coupon can never be revived", !canEnable("EXPIRED"));
ok("edit: economics are frozen in v1", canEditEconomics() === false);

// ── 10. Base URL — the COUPON-01 root cause ──────────────────────────────────
// The old code threw a bare Error (→ 500) when APP_BASE_URL was unset. Neither
// var is set in any env file, so publishing failed every time outside dev.
const savedApp = process.env.APP_BASE_URL;
const savedPublic = process.env.NEXT_PUBLIC_APP_URL;
const savedNodeEnv = process.env.NODE_ENV;

delete process.env.APP_BASE_URL;
delete process.env.NEXT_PUBLIC_APP_URL;
process.env.NODE_ENV = "production";

const req = { nextUrl: { origin: "https://app.dubiz.test" } };
let threw = false;
let resolved = "";
try {
  resolved = resolveCouponBaseUrl(req);
} catch {
  threw = true;
}
ok("baseUrl: production with NO env var does not throw", !threw);
ok("baseUrl: falls back to the request origin", resolved === "https://app.dubiz.test");

process.env.APP_BASE_URL = "https://configured.dubiz.test/";
ok("baseUrl: env overrides the request origin", resolveCouponBaseUrl(req) === "https://configured.dubiz.test");
ok(
  "baseUrl: trailing slash is trimmed so the QR URL is well-formed",
  buildCouponQrValue(resolveCouponBaseUrl(req), "tok-1") ===
    "https://configured.dubiz.test/revenue/redeem?token=tok-1"
);
ok(
  "qrValue: token is URL-encoded",
  buildCouponQrValue("https://a.test", "a b&c").includes("token=a+b%26c")
);

// ---- production must never bake a non-public origin into a permanent QR ----
// Measured behaviour: `nextUrl.origin` ignores Host / X-Forwarded-Host, so the
// request-origin fallback cannot discover the public domain on a hosted
// deployment. Minting a localhost QR would produce coupons no customer can ever
// redeem, so production fails loudly and actionably instead.
delete process.env.APP_BASE_URL;
delete process.env.NEXT_PUBLIC_APP_URL;
process.env.NODE_ENV = "production";

let guardFired = false;
try {
  resolveCouponBaseUrl({ nextUrl: { origin: "http://localhost:3000" } });
} catch (err) {
  guardFired = err instanceof CouponBaseUrlError && err.statusCode === 503;
}
ok("baseUrl: production refuses a localhost origin (503, not a silent bad QR)", guardFired);

process.env.APP_BASE_URL = "https://promaxgroup.co.il";
ok(
  "baseUrl: a configured public origin is used in production",
  resolveCouponBaseUrl({ nextUrl: { origin: "http://localhost:3000" } }) === "https://promaxgroup.co.il"
);

process.env.NODE_ENV = "development";
delete process.env.APP_BASE_URL;
ok(
  "baseUrl: development still works with no configuration at all",
  resolveCouponBaseUrl({ nextUrl: { origin: "http://localhost:3000" } }) === "http://localhost:3000"
);
ok("baseUrl: public host classified public", isPubliclyReachable("https://promaxgroup.co.il"));
ok("baseUrl: localhost classified non-public", !isPubliclyReachable("http://localhost:3000"));
ok("baseUrl: loopback IP classified non-public", !isPubliclyReachable("http://127.0.0.1:3000"));

process.env.APP_BASE_URL = savedApp;
process.env.NEXT_PUBLIC_APP_URL = savedPublic;
process.env.NODE_ENV = savedNodeEnv;

// ── 11. Regressions found by the adversarial pass ───────────────────────────

// A percentage that validates must also PUBLISH normalized: "007" is 7, and was
// being printed to customers verbatim as "007% הנחה".
ok("regression: leading-zero percent is normalized", benefitSegment("pct", "007") === "7% הנחה");
ok("regression: leading-zero percent in the full sentence",
  composeBenefitSentence({ benefitType: "pct", value: "007", scope: SCOPE_WHOLE_BUSINESS }) === "7% הנחה על כל העסק");
ok("regression: plain percent unchanged", benefitSegment("pct", "25") === "25% הנחה");

// The date picker's max must be a date the server actually accepts. It was one
// day too far: end-of-day Israel on day 365 lands past the `now + 365d` cutoff.
const pickerMax = israelEndOfDay(maxValidUntilDate(NOW));
ok("regression: the picker's max date passes server validation",
  validateValidUntil(pickerMax, NOW).length === 0);

// A title the owner clears must stay cleared in the field, while the coupon
// still gets a real name.
const clearedDraft = { ...initialDraft(), benefitType: "pct" as const, value: "20", scope: SCOPE_WHOLE_BUSINESS, titleEdited: true, title: "" };
ok("regression: a cleared title stays cleared in the input", titleInputValue(clearedDraft) === "");
ok("regression: a cleared title still yields a real coupon name",
  couponTitle(clearedDraft) === "20% הנחה על כל העסק");
const typedDraft = { ...clearedDraft, title: "הטבת קיץ" };
ok("regression: a typed title is shown verbatim", titleInputValue(typedDraft) === "הטבת קיץ");
const untouchedDraft = { ...clearedDraft, titleEdited: false, title: "" };
ok("regression: an untouched title tracks the composed sentence",
  titleInputValue(untouchedDraft) === "20% הנחה על כל העסק");

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll coupon v1 logic checks passed.");
