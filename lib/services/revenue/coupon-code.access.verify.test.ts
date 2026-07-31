/**
 * W1-01 — Coupon Surface hardening verify (pure logic, NO DB required):
 *   npx tsx lib/services/revenue/coupon-code.access.verify.test.ts
 *
 * Covers the security-decisive logic:
 *   - anonymous / no business        → 401 (requireIssuerBusinessId)
 *   - authenticated, not the issuer  → 403 (assertCouponCodeAccess)
 *   - authenticated issuer           → 200 (token/qrValue/redeemLink)
 *   - ownership is checked BEFORE status/expiry (anti-enumeration)
 *   - public details DTO carries NO secret and NO internal coupon.id
 *   - public active card carries NO secret and NO internal coupon.id
 *   - production has NO bypass: auth stays enforced regardless of env
 *
 * The route wires getCurrentUser → requireIssuerBusinessId → getCouponCode; the
 * DB-touching getCouponCode is exercised end-to-end in staging, not here.
 */

import {
  assertCouponCodeAccess,
  requireIssuerBusinessId,
  type CouponCodeRecord,
} from "@/lib/services/revenue/coupon-code.service";
import { toPublicCouponDetailsDTO } from "@/lib/services/revenue/coupon-details-public.service";
import { toActiveCouponCard } from "@/lib/services/revenue/active-coupons.service";
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "@/lib/errors";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

function throwsStatus(
  name: string,
  fn: () => unknown,
  ctor: new (...args: never[]) => AppError,
  statusCode: number
) {
  try {
    fn();
    ok(name, false);
  } catch (err) {
    ok(
      name,
      err instanceof ctor && (err as AppError).statusCode === statusCode
    );
  }
}

/** Recursively collect every object key that appears anywhere in `value`. */
function allKeys(value: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) allKeys(v, acc);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      acc.add(k);
      allKeys(v, acc);
    }
  }
  return acc;
}

const SECRET_KEYS = ["token", "qrValue", "redeemLink"];

const OWNER = 42;
const OTHER = 99;

function activeCoupon(overrides: Partial<CouponCodeRecord> = {}): CouponCodeRecord {
  return {
    issuingBusinessId: OWNER,
    status: "ACTIVE",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    token: "tok_secret_abc",
    qrValue: "https://app.example/revenue/redeem?token=tok_secret_abc",
    ...overrides,
  };
}

// ── 1. requireIssuerBusinessId — the 401 gate ────────────────────────────────
throwsStatus("anonymous (null user) → 401", () => requireIssuerBusinessId(null), UnauthorizedError, 401);
throwsStatus("user without businessId → 401", () => requireIssuerBusinessId({ businessId: null }), UnauthorizedError, 401);
throwsStatus("user with undefined businessId → 401", () => requireIssuerBusinessId({}), UnauthorizedError, 401);
ok("authenticated business → returns businessId", requireIssuerBusinessId({ businessId: 7 }) === 7);

// ── 2. assertCouponCodeAccess — 403 / 200 / 404 / 400 ────────────────────────
throwsStatus(
  "wrong issuer → 403",
  () => assertCouponCodeAccess({ coupon: activeCoupon(), requestingBusinessId: OTHER }),
  ForbiddenError,
  403
);

const granted = assertCouponCodeAccess({ coupon: activeCoupon(), requestingBusinessId: OWNER });
ok("correct issuer → returns token", granted.token === "tok_secret_abc");
ok("correct issuer → returns qrValue", granted.qrValue.includes("token=tok_secret_abc"));
ok("correct issuer → redeemLink mirrors qrValue", granted.redeemLink === granted.qrValue);

throwsStatus(
  "missing coupon → 404",
  () => assertCouponCodeAccess({ coupon: null, requestingBusinessId: OWNER }),
  NotFoundError,
  404
);
throwsStatus(
  "owner + expired → 400",
  () =>
    assertCouponCodeAccess({
      coupon: activeCoupon({ expiresAt: new Date(Date.now() - 1000) }),
      requestingBusinessId: OWNER,
    }),
  ValidationError,
  400
);
throwsStatus(
  "owner + non-active → 400",
  () =>
    assertCouponCodeAccess({
      coupon: activeCoupon({ status: "REDEEMED" }),
      requestingBusinessId: OWNER,
    }),
  ValidationError,
  400
);

// Anti-enumeration: a non-owner must not be able to distinguish an expired coupon
// from a live one — ownership (403) is decided BEFORE status/expiry (400).
throwsStatus(
  "non-owner + expired → still 403 (not 400)",
  () =>
    assertCouponCodeAccess({
      coupon: activeCoupon({ expiresAt: new Date(Date.now() - 1000) }),
      requestingBusinessId: OTHER,
    }),
  ForbiddenError,
  403
);

// ── 3. Public details DTO — no secrets, no internal coupon.id ────────────────
const detailsDTO = toPublicCouponDetailsDTO({
  publicId: "11111111-1111-1111-1111-111111111111",
  status: "ACTIVE",
  issuedAt: new Date(),
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  redeemedAt: null,
  offer: {
    id: 5,
    title: "1+1",
    customerBenefitText: "קנה אחד קבל אחד",
    description: null,
    imageUrl: null,
  },
  issuingBusiness: {
    id: 3,
    name: "עסק לדוגמה",
    profile: {
      category: "אוכל",
      city: "תל אביב",
      openingHours: null,
      billingAddress: null,
      billingPhone: null,
    },
  },
});
{
  const keys = allKeys(detailsDTO);
  ok("public details: no secret keys", SECRET_KEYS.every((k) => !keys.has(k)));
  ok("public details: coupon exposes publicId", typeof detailsDTO.coupon.publicId === "string");
  ok("public details: coupon has NO internal id", !("id" in (detailsDTO.coupon as object)));
}

// ── 4. Public active card — no secrets, no internal coupon.id ────────────────
const card = toActiveCouponCard(
  {
    publicId: "22222222-2222-2222-2222-222222222222",
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    offer: {
      id: 8,
      title: "20% הנחה",
      customerBenefitText: "20% על הכל",
      description: null,
      imageUrl: null,
    },
    issuingBusiness: {
      id: 4,
      name: "קפה",
      profile: {
        category: "קפה",
        subCategory: null,
        businessModel: null,
        city: "חיפה",
        openingHours: null,
        latitude: null,
        longitude: null,
        billingAddress: null,
        billingPhone: null,
      },
    },
  },
  null
);
{
  const keys = allKeys(card);
  ok("public active card: no secret keys", SECRET_KEYS.every((k) => !keys.has(k)));
  ok("public active card: identified by publicId", typeof card.publicId === "string");
  ok("public active card: no top-level internal id", !("id" in (card as object)));
}

// ── 5. Production has NO bypass ──────────────────────────────────────────────
// Force production and set bogus "bypass"-looking env vars. No code reads them;
// auth must stay enforced. Proves /code cannot be opened without auth in prod.
process.env.NODE_ENV = "production";
process.env.ALLOW_INSECURE_COUPON_CODE = "1";
process.env.COUPON_CODE_PUBLIC = "true";
process.env.SECURITY_BYPASS = "1";
throwsStatus(
  "production: anonymous still → 401 (no bypass)",
  () => requireIssuerBusinessId(null),
  UnauthorizedError,
  401
);
throwsStatus(
  "production: wrong issuer still → 403 (no bypass)",
  () => assertCouponCodeAccess({ coupon: activeCoupon(), requestingBusinessId: OTHER }),
  ForbiddenError,
  403
);

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll W1-01 coupon-surface checks passed.");
