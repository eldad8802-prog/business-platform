/**
 * Signup — what an account's identity IS, decided before anything is written.
 *
 * Deliberately dependency-free: no Prisma, no bcrypt, no environment. These are
 * business rules about identity, and a rule you cannot check without standing up
 * a database is a rule nobody checks. Keeping them here means the decisions that
 * caused real account bugs — two spellings of one address becoming two
 * businesses, a trimmed password locking its owner out — are provable in
 * milliseconds.
 *
 * `createAccount` in ./signup.ts consumes this and does the writing. Neither
 * knows anything about the public-signup gate: whether registration is open at
 * all is decided earlier, in the route.
 */

// Applies to NEW passwords only. Login never re-validates length, so an existing
// owner with a shorter password is not locked out by this rule.
export const MIN_PASSWORD_LENGTH = 8;
export const MIN_NAME_LENGTH = 2;
/** Shared with the rename route: a business name is a label, not a paragraph. */
export const MAX_BUSINESS_NAME_LENGTH = 120;
export const MAX_NAME_LENGTH = 120;

/**
 * Deliberately permissive. This shape check exists to catch typos, not to
 * adjudicate RFC 5322 — an over-strict pattern rejects addresses that genuinely
 * deliver, and a rejected signup is a lost customer.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SignupInput = {
  email: unknown;
  password: unknown;
  name: unknown;
  businessName: unknown;
  /** Must be exactly `true`: the box was ticked. Anything else is refusal. */
  acceptTerms?: unknown;
  /** Whatever the landing page captured; reduced by normalizeSignupAttribution. */
  attribution?: unknown;
};

/** Campaign labels and a referrer HOST — never a path, query, or free text. */
export type SignupAttribution = {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  referrerHost?: string;
};

export type NormalizedSignup = {
  email: string;
  password: string;
  name: string;
  businessName: string;
  attribution: SignupAttribution | null;
};

export type SignupField = "email" | "password" | "name" | "businessName" | "acceptTerms";

export class SignupValidationError extends Error {
  readonly field: SignupField;

  constructor(field: SignupField, message: string) {
    super(message);
    this.name = "SignupValidationError";
    this.field = field;
  }
}

/** Raised when the address is already registered — a 409, never a 500. */
export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super("email_already_registered");
    this.name = "EmailAlreadyRegisteredError";
  }
}

/**
 * The canonical form of an address for identity purposes.
 *
 * Email domains are case-insensitive by specification, and no mail provider a
 * small business actually uses treats the local part as case-sensitive either.
 * Storing the address verbatim therefore let `Foo@x.com` and `foo@x.com`
 * register as two separate businesses, and let an owner who capitalised their
 * address on Monday fail to log in with it on Tuesday. One address, one
 * account: fold case at the boundary so the unique index can do its job.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
const MAX_UTM_LENGTH = 100;
const UTM_VALUE = /^[\p{L}\p{N} ._+-]+$/u;
const HOST = /^[a-z0-9.-]{1,253}$/;

/**
 * Reduce whatever the landing page sent to labels that name nobody.
 *
 * Attribution is worth keeping because it cannot be recovered later — but it is
 * also caller-controlled input written by the auth plane. So it is an
 * allowlist, not a filter: five utm keys with short label-shaped values, and
 * the referrer reduced to its host. Anything else is dropped silently; a bad
 * campaign tag never costs anyone their signup.
 */
export function normalizeSignupAttribution(raw: unknown): SignupAttribution | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const out: SignupAttribution = {};
  for (const key of UTM_KEYS) {
    const v = input[key];
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t.length === 0 || t.length > MAX_UTM_LENGTH || !UTM_VALUE.test(t)) continue;
    out[key] = t;
  }
  const ref = input.referrer;
  if (typeof ref === "string" && ref.length <= 2048) {
    try {
      const host = new URL(ref).hostname.toLowerCase();
      if (HOST.test(host)) out.referrerHost = host;
    } catch {
      /* not a URL: dropped */
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Validate and normalize, or throw with the offending field named.
 *
 * Returns the exact values that will be persisted, so nothing downstream has to
 * re-trim or re-fold and risk disagreeing about what the identity is.
 */
export function normalizeSignupInput(input: SignupInput): NormalizedSignup {
  const { email, password, name, businessName, acceptTerms, attribution } =
    input ?? ({} as SignupInput);

  if (typeof name !== "string" || name.trim().length < MIN_NAME_LENGTH) {
    throw new SignupValidationError("name", "יש להזין שם מלא");
  }
  if (name.trim().length > MAX_NAME_LENGTH) {
    throw new SignupValidationError("name", `השם ארוך מדי (עד ${MAX_NAME_LENGTH} תווים)`);
  }

  if (
    typeof businessName !== "string" ||
    businessName.trim().length < MIN_NAME_LENGTH
  ) {
    throw new SignupValidationError("businessName", "יש להזין שם עסק");
  }
  if (businessName.trim().length > MAX_BUSINESS_NAME_LENGTH) {
    throw new SignupValidationError(
      "businessName",
      `שם העסק ארוך מדי (עד ${MAX_BUSINESS_NAME_LENGTH} תווים)`
    );
  }

  if (typeof email !== "string" || !EMAIL_SHAPE.test(email.trim())) {
    throw new SignupValidationError("email", "יש להזין כתובת אימייל תקינה");
  }

  // Length is checked on the raw value: a password is a secret, not a label, so
  // it is never trimmed. Trimming would silently store a different secret than
  // the one the owner typed, and they would be locked out on the next login.
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new SignupValidationError(
      "password",
      `הסיסמה חייבת להכיל לפחות ${MIN_PASSWORD_LENGTH} תווים`
    );
  }

  // Strictly `true`. A string "true", a 1 or a missing field is not consent.
  if (acceptTerms !== true) {
    throw new SignupValidationError("acceptTerms", "יש לאשר את תנאי השימוש ומדיניות הפרטיות");
  }

  return {
    email: normalizeEmail(email),
    password,
    name: name.trim(),
    businessName: businessName.trim(),
    attribution: normalizeSignupAttribution(attribution),
  };
}
