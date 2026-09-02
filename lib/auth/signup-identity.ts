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

export const MIN_PASSWORD_LENGTH = 6;
export const MIN_NAME_LENGTH = 2;

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
};

export type NormalizedSignup = {
  email: string;
  password: string;
  name: string;
  businessName: string;
};

export type SignupField = "email" | "password" | "name" | "businessName";

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

/**
 * Validate and normalize, or throw with the offending field named.
 *
 * Returns the exact values that will be persisted, so nothing downstream has to
 * re-trim or re-fold and risk disagreeing about what the identity is.
 */
export function normalizeSignupInput(input: SignupInput): NormalizedSignup {
  const { email, password, name, businessName } = input ?? ({} as SignupInput);

  if (typeof name !== "string" || name.trim().length < MIN_NAME_LENGTH) {
    throw new SignupValidationError("name", "יש להזין שם מלא");
  }

  if (
    typeof businessName !== "string" ||
    businessName.trim().length < MIN_NAME_LENGTH
  ) {
    throw new SignupValidationError("businessName", "יש להזין שם עסק");
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

  return {
    email: normalizeEmail(email),
    password,
    name: name.trim(),
    businessName: businessName.trim(),
  };
}
