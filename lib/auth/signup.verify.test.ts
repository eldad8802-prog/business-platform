/**
 * Verify — signup identity and validation rules.
 * Run: npx tsx lib/auth/signup.verify.test.ts
 *
 * Imports only ./signup-identity, which has no dependencies — so this runs
 * without a database, a Prisma client, or a native bcrypt build. What it proves
 * is the part that decides WHAT gets written, which is where the account
 * identity bugs lived. Atomicity of the write itself is a separate DB proof, and
 * whether registration is open at all is the public-signup gate's business, not
 * this module's.
 */
import assert from "node:assert/strict";

import {
  MIN_PASSWORD_LENGTH,
  SIGNUP_BUSINESS_KINDS,
  SignupValidationError,
  normalizeEmail,
  normalizeGoogleSignupInput,
  normalizeSignupInput,
} from "@/lib/auth/signup-identity";
import { BILLING_BUSINESS_KIND_VALUES } from "@/lib/billing/business-identity";

let checks = 0;
function check(label: string, fn: () => void) {
  fn();
  checks += 1;
  void label;
}

function expectInvalid(
  input: Record<string, unknown>,
  field: string,
  label: string
) {
  check(label, () => {
    assert.throws(
      () => normalizeSignupInput(input as never),
      (err: unknown) => {
        assert.ok(
          err instanceof SignupValidationError,
          `${label}: expected SignupValidationError`
        );
        assert.equal(err.field, field, `${label}: wrong field named`);
        return true;
      }
    );
  });
}

const valid = {
  email: "owner@example.com",
  password: "sup3rsecret",
  name: "אלדד",
  businessName: "מספרה", businessKind: "AUTHORIZED_DEALER",
  legalName: "דנה כהן", taxId: "000000018", address: "הרצל 1, תל אביב", phone: "0501234567", businessEmail: "biz@lab.invalid",
  acceptTerms: true,
};

function main() {
  /* ------------------------------------------------ email is one identity -- */

  check("email folds to lower case", () => {
    assert.equal(normalizeEmail("Foo@Example.COM"), "foo@example.com");
  });

  check("email is trimmed", () => {
    assert.equal(normalizeEmail("  foo@example.com  "), "foo@example.com");
  });

  check("two spellings of one address normalize identically", () => {
    // This is the whole point: before folding, these two registered as two
    // separate businesses, and the owner of the first could be locked out by
    // typing their own address the way they usually write it.
    assert.equal(
      normalizeEmail("Owner@Example.com"),
      normalizeEmail("owner@example.com")
    );
  });

  check("normalizeSignupInput persists the folded address", () => {
    const out = normalizeSignupInput({ ...valid, email: " Owner@Example.COM " });
    assert.equal(out.email, "owner@example.com");
  });

  /* ------------------------------------------------------- password rules -- */

  check("password is never trimmed", () => {
    // Trimming would store a different secret than the one typed, and the owner
    // would be unable to log in with the password they believe they chose.
    const out = normalizeSignupInput({ ...valid, password: "  spaced  " });
    assert.equal(out.password, "  spaced  ");
  });

  check("whitespace counts toward password length", () => {
    const eightSpaces = " ".repeat(8);
    const out = normalizeSignupInput({ ...valid, password: eightSpaces });
    assert.equal(out.password, eightSpaces);
  });

  expectInvalid(
    { ...valid, password: "a".repeat(MIN_PASSWORD_LENGTH - 1) },
    "password",
    "password below minimum rejected"
  );

  check("password at exactly the minimum is accepted", () => {
    const out = normalizeSignupInput({
      ...valid,
      password: "a".repeat(MIN_PASSWORD_LENGTH),
    });
    assert.equal(out.password.length, MIN_PASSWORD_LENGTH);
  });

  /* ------------------------------------------------------------- trimming -- */

  check("names are trimmed", () => {
    const out = normalizeSignupInput({
      ...valid,
      name: "  אלדד  ",
      businessName: "  מספרה  ",
    });
    assert.equal(out.name, "אלדד");
    assert.equal(out.businessName, "מספרה");
  });

  check("a whitespace-only name is not a name", () => {
    assert.throws(() => normalizeSignupInput({ ...valid, name: "     " }));
  });

  /* -------------------------------------------- every field names itself --- */

  expectInvalid({ ...valid, name: "" }, "name", "missing name");
  expectInvalid({ ...valid, name: "א" }, "name", "one-character name");
  expectInvalid({ ...valid, legalName: "" }, "legalName", "missing legal name");
  for (const field of ["legalName", "taxId", "address", "phone", "businessEmail"]) {
    expectInvalid({ ...valid, [field]: undefined }, field, `missing ${field}`);
  }
  check("an empty legacy business name is no trade name: the legal name is shown", () => {
    assert.equal(normalizeSignupInput({ ...valid, businessName: "" }).businessName, "דנה כהן");
  });
  expectInvalid({ ...valid, email: "" }, "email", "missing email");
  expectInvalid({ ...valid, email: "not-an-email" }, "email", "email without @");
  expectInvalid({ ...valid, email: "a@b" }, "email", "email without dot");
  expectInvalid({ ...valid, email: "a b@c.com" }, "email", "email with space");

  /* --------------------------------------- non-strings are a 400, not 500 -- */

  for (const bad of [null, undefined, 42, {}, []] as const) {
    expectInvalid({ ...valid, email: bad }, "email", `email typed ${typeof bad}`);
    expectInvalid(
      { ...valid, password: bad },
      "password",
      `password typed ${typeof bad}`
    );
    expectInvalid({ ...valid, name: bad }, "name", `name typed ${typeof bad}`);
  }

  check("an entirely empty body names a field rather than throwing raw", () => {
    assert.throws(
      () => normalizeSignupInput({} as never),
      (err: unknown) => err instanceof SignupValidationError
    );
  });

  /* --------------------------------------------------------- happy path ---- */

  check("a valid signup normalizes without throwing", () => {
    const out = normalizeSignupInput(valid);
    assert.deepEqual(out, {
      email: "owner@example.com",
      password: "sup3rsecret",
      name: "אלדד",
      businessName: "מספרה",
      businessKind: "AUTHORIZED_DEALER",
      legalIdentity: {
        kind: "AUTHORIZED_DEALER",
        legalName: "דנה כהן",
        taxId: "000000018",
        tradeName: "מספרה",
        address: "הרצל 1, תל אביב",
        phone: "0501234567",
        businessEmail: "biz@lab.invalid",
      },
      attribution: null,
    });
  });

  /* -------------------------------------------------------------- consent -- */

  expectInvalid({ ...valid, acceptTerms: undefined }, "acceptTerms", "terms not ticked");
  expectInvalid({ ...valid, acceptTerms: false }, "acceptTerms", "terms refused");
  expectInvalid({ ...valid, acceptTerms: "true" }, "acceptTerms", "a string is not consent");
  expectInvalid({ ...valid, acceptTerms: 1 }, "acceptTerms", "a number is not consent");

  /* ---------------------------------------------------------- name bounds -- */

  expectInvalid({ ...valid, businessName: "א".repeat(121) }, "tradeName", "trade name (legacy businessName) over 120");
  check("a business name of exactly 120 is accepted", () => {
    assert.equal(normalizeSignupInput({ ...valid, businessName: "א".repeat(120) }).businessName.length, 120);
  });

  /* ---------------------------------------------------------- attribution -- */

  check("attribution keeps utm labels and the referrer host only", () => {
    const out = normalizeSignupInput({
      ...valid,
      attribution: {
        utm_source: "facebook",
        utm_campaign: "חורף 2026",
        utm_medium: "<script>",
        utm_term: "x".repeat(101),
        referrer: "https://www.google.com/search?q=private",
        email: "leak@example.com",
      },
    });
    assert.deepEqual(out.attribution, {
      utm_source: "facebook",
      utm_campaign: "חורף 2026",
      referrerHost: "www.google.com",
    });
  });
  check("nothing usable means no attribution at all", () => {
    assert.equal(normalizeSignupInput({ ...valid, attribution: { referrer: "not a url" } }).attribution, null);
    assert.equal(normalizeSignupInput({ ...valid, attribution: "utm_source=x" }).attribution, null);
    assert.equal(normalizeSignupInput({ ...valid, attribution: ["x"] }).attribution, null);
  });

  // ── business kind (owner decision 2026-11-11) ──
  check("the signup kinds are exactly billing's three kinds, in the same order", () => {
    assert.deepEqual([...SIGNUP_BUSINESS_KINDS], [...BILLING_BUSINESS_KIND_VALUES]);
  });
  check("each kind is accepted and kept verbatim", () => {
    for (const k of SIGNUP_BUSINESS_KINDS) assert.equal(normalizeSignupInput({ ...valid, businessKind: k }).businessKind, k);
  });
  for (const [label, v] of [["missing", undefined], ["empty", ""], ["unknown", "VAT_FREE"], ["lower case", "exempt_dealer"], ["padded", " LTD_COMPANY "], ["number", 2], ["array", ["LTD_COMPANY"]]] as const) {
    expectInvalid({ ...valid, businessKind: v }, "businessKind", `business kind ${label} is refused`);
  }
  check("the Google completion requires the same kind", () => {
    const g = { name: "דנה כהן", businessName: "מאפייה", acceptTerms: true, legalName: "דנה כהן", taxId: "000000018",
                address: "הרצל 1, תל אביב", phone: "0501234567", businessEmail: "biz@lab.invalid" };
    assert.equal(normalizeGoogleSignupInput({ ...g, businessKind: "LTD_COMPANY" }).businessKind, "LTD_COMPANY");
    for (const v of [undefined, "", "OTHER"]) {
      assert.throws(() => normalizeGoogleSignupInput({ ...g, businessKind: v }), (e: unknown) => e instanceof SignupValidationError && e.field === "businessKind");
    }
  });
  check("the kind is checked before the password (a person fixing the form sees it next to the business name)", () => {
    assert.throws(() => normalizeSignupInput({ ...valid, businessKind: "", password: "x" } as never), (e: unknown) => e instanceof SignupValidationError && e.field === "businessKind");
  });

  console.log(`signup.verify.test.ts: ok (${checks} checks)`);
}

main();
