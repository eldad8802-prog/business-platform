/**
 * TEMPORARY — register the ITA PRODUCTION BillingAuthorityApp from inside the
 * Production runtime.
 *
 * Why it exists: the client secret must be encrypted with the
 * BILLING_AUTHORITY_ENCRYPTION_KEY that already lives in the Production runtime
 * environment. Running scripts/bootstrap-billing-authority-app.ts elsewhere
 * would require extracting that key; this service encrypts in-process instead,
 * so the key is never read out, printed or replaced.
 *
 * Contract:
 *   - the environment is hard-coded PRODUCTION — no input can change it;
 *   - CREATE-ONLY: an existing PRODUCTION row is never updated or overwritten
 *     (APP_ALREADY_REGISTERED, in both modes; a racing insert that trips the
 *     unique constraint maps to the same code);
 *   - dry-run validates and proves the key (encrypt + decrypt in memory) and
 *     performs NO write; apply additionally creates the row exactly once;
 *   - results and errors carry typed codes and a masked summary only — never
 *     the client secret, the key, ciphertext, or an unmasked client id /
 *     accounting number.
 *
 * Called only by app/api/platform-admin/authority/production-app-registration.
 * Removed together with that route in the follow-up PR once the row exists.
 */

import {
  BillingAuthorityAppStatus,
  BillingAuthorityEnvironment,
} from "@prisma/client";
import {
  BillingAuthorityTokenCryptoConfigError,
  decryptAuthorityAppSecret,
  encryptAuthorityAppSecret,
  type EncryptedAuthorityMaterial,
} from "@/lib/services/billing/authority/billing-authority-token-crypto.service";

export const AUTHORITY_APP_REGISTRATION_ENCRYPTION_KEY_ID = "authority_gcm_v1";

const PRODUCTION = BillingAuthorityEnvironment.PRODUCTION;

export const AUTHORITY_APP_REGISTRATION_CODES = {
  INVALID_CLIENT_ID: "INVALID_CLIENT_ID",
  INVALID_CLIENT_SECRET: "INVALID_CLIENT_SECRET",
  CLIENT_SECRET_SURROUNDING_WHITESPACE: "CLIENT_SECRET_SURROUNDING_WHITESPACE",
  INVALID_ACCOUNTING_SOFTWARE_NUMBER: "INVALID_ACCOUNTING_SOFTWARE_NUMBER",
  INVALID_PORTAL_APPLICATION_ID: "INVALID_PORTAL_APPLICATION_ID",
  INVALID_MODE: "INVALID_MODE",
  ENCRYPTION_KEY_UNAVAILABLE: "ENCRYPTION_KEY_UNAVAILABLE",
  KEY_CHECK_FAILED: "KEY_CHECK_FAILED",
  APP_ALREADY_REGISTERED: "APP_ALREADY_REGISTERED",
  READ_FAILED: "READ_FAILED",
  WRITE_FAILED: "WRITE_FAILED",
} as const;

export type AuthorityAppRegistrationCode =
  (typeof AUTHORITY_APP_REGISTRATION_CODES)[keyof typeof AUTHORITY_APP_REGISTRATION_CODES];

export type AuthorityAppRegistrationMode = "dry-run" | "apply";

export type AuthorityAppRegistrationInput = {
  mode: AuthorityAppRegistrationMode;
  itaClientId: string;
  clientSecret: string;
  accountingSoftwareNumber: string;
  portalApplicationId?: string | null;
};

export type AuthorityAppRegistrationSummary = {
  mode: AuthorityAppRegistrationMode;
  environment: "PRODUCTION";
  itaClientId: string;
  accountingSoftwareNumber: string;
  portalApplicationId: string | null;
  keyCheck: "OK";
  created: boolean;
};

export type AuthorityAppRegistrationResult =
  | { ok: true; summary: AuthorityAppRegistrationSummary }
  | { ok: false; code: AuthorityAppRegistrationCode };

/** Minimal Prisma surface — keeps the service testable with in-memory doubles. */
export type AuthorityAppRegistrationDb = {
  billingAuthorityApp: {
    findUnique: (args: {
      where: { environment: BillingAuthorityEnvironment };
      select: { id: true };
    }) => Promise<{ id: number } | null>;
    createMany: (args: {
      data: AuthorityAppRegistrationRow;
    }) => Promise<{ count: number }>;
  };
};

export type AuthorityAppRegistrationRow = {
  environment: BillingAuthorityEnvironment;
  status: BillingAuthorityAppStatus;
  accountingSoftwareNumber: string;
  itaClientId: string;
  clientSecretEncrypted: string;
  clientSecretIv: string;
  clientSecretTag: string;
  encryptionKeyId: string;
  portalOrganizationId: null;
  portalApplicationId: string | null;
  registeredAt: Date;
  lastValidatedAt: null;
  lastErrorCode: null;
  lastErrorMessage: null;
};

export type AuthorityAppRegistrationCrypto = {
  encrypt: (plaintext: string, environment: BillingAuthorityEnvironment) => EncryptedAuthorityMaterial;
  decrypt: (stored: EncryptedAuthorityMaterial, environment: BillingAuthorityEnvironment) => string | null;
};

export type AuthorityAppRegistrationDeps = {
  db?: AuthorityAppRegistrationDb;
  now?: () => Date;
  crypto?: AuthorityAppRegistrationCrypto;
};

const DIGITS_1_12 = /^[0-9]{1,12}$/;
const WHITESPACE = /\s/;
const MAX_CLIENT_ID = 200;
const MAX_CLIENT_SECRET = 1000;

/** `***<last4>`; never reveals the head. Same shape as the bootstrap script's maskTail. */
export function maskTail(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (v.length === 0) return "";
  return `***${v.slice(-4)}`;
}

type ValidatedInput = {
  mode: AuthorityAppRegistrationMode;
  itaClientId: string;
  clientSecret: string;
  accountingSoftwareNumber: string;
  portalApplicationId: string | null;
};

function validate(
  input: AuthorityAppRegistrationInput
): { ok: true; value: ValidatedInput } | { ok: false; code: AuthorityAppRegistrationCode } {
  const C = AUTHORITY_APP_REGISTRATION_CODES;
  if (!input || typeof input !== "object") return { ok: false, code: C.INVALID_MODE };
  if (input.mode !== "dry-run" && input.mode !== "apply") return { ok: false, code: C.INVALID_MODE };

  if (typeof input.itaClientId !== "string") return { ok: false, code: C.INVALID_CLIENT_ID };
  const itaClientId = input.itaClientId.trim();
  if (
    itaClientId.length === 0 ||
    itaClientId.length > MAX_CLIENT_ID ||
    WHITESPACE.test(itaClientId)
  ) {
    return { ok: false, code: C.INVALID_CLIENT_ID };
  }

  // The secret is NEVER trimmed: a secret with stray surrounding spaces once
  // broke the SANDBOX app silently. Refuse it explicitly instead.
  const clientSecret = input.clientSecret;
  if (
    typeof clientSecret !== "string" ||
    clientSecret.length === 0 ||
    clientSecret.length > MAX_CLIENT_SECRET
  ) {
    return { ok: false, code: C.INVALID_CLIENT_SECRET };
  }
  if (clientSecret.trim().length === 0) return { ok: false, code: C.INVALID_CLIENT_SECRET };
  if (clientSecret !== clientSecret.trim()) {
    return { ok: false, code: C.CLIENT_SECRET_SURROUNDING_WHITESPACE };
  }

  if (typeof input.accountingSoftwareNumber !== "string") {
    return { ok: false, code: C.INVALID_ACCOUNTING_SOFTWARE_NUMBER };
  }
  const accountingSoftwareNumber = input.accountingSoftwareNumber.trim();
  if (!DIGITS_1_12.test(accountingSoftwareNumber)) {
    return { ok: false, code: C.INVALID_ACCOUNTING_SOFTWARE_NUMBER };
  }

  let portalApplicationId: string | null = null;
  const rawPortal = input.portalApplicationId;
  if (rawPortal !== undefined && rawPortal !== null) {
    if (typeof rawPortal !== "string") return { ok: false, code: C.INVALID_PORTAL_APPLICATION_ID };
    const trimmed = rawPortal.trim();
    if (trimmed.length > 0) {
      if (!DIGITS_1_12.test(trimmed)) return { ok: false, code: C.INVALID_PORTAL_APPLICATION_ID };
      portalApplicationId = trimmed;
    }
  }

  return {
    ok: true,
    value: { mode: input.mode, itaClientId, clientSecret, accountingSoftwareNumber, portalApplicationId },
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/** Logs only the error class name / Prisma code — never a message (may carry values). */
function logFailure(stage: string, error: unknown): void {
  const name = error instanceof Error ? error.name : "UnknownError";
  const code =
    error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
  console.error(`AUTHORITY_APP_REGISTRATION_${stage}:`, name, code);
}

async function defaultDb(): Promise<AuthorityAppRegistrationDb> {
  // The canonical runtime client — the admin read plane is SELECT-only.
  const { prisma } = await import("@/lib/prisma");
  return prisma as unknown as AuthorityAppRegistrationDb;
}

const defaultCrypto: AuthorityAppRegistrationCrypto = {
  encrypt: encryptAuthorityAppSecret,
  decrypt: decryptAuthorityAppSecret,
};

export async function registerProductionAuthorityApp(
  input: AuthorityAppRegistrationInput,
  deps: AuthorityAppRegistrationDeps = {}
): Promise<AuthorityAppRegistrationResult> {
  const C = AUTHORITY_APP_REGISTRATION_CODES;
  const crypto = deps.crypto ?? defaultCrypto;
  const now = deps.now ?? (() => new Date());

  const validated = validate(input);
  if (!validated.ok) return validated;
  const v = validated.value;

  // Key check: prove the runtime key encrypts AND decrypts this secret under the
  // PRODUCTION AAD before anything is stored. Detail is never surfaced.
  let material: EncryptedAuthorityMaterial;
  try {
    material = crypto.encrypt(v.clientSecret, PRODUCTION);
  } catch (error) {
    // Name only: the config error's message describes the key (length/format).
    logFailure(
      error instanceof BillingAuthorityTokenCryptoConfigError ? "KEY_CONFIG" : "KEY",
      error
    );
    return { ok: false, code: C.ENCRYPTION_KEY_UNAVAILABLE };
  }
  let roundTrip: string | null;
  try {
    roundTrip = crypto.decrypt(material, PRODUCTION);
  } catch {
    roundTrip = null;
  }
  if (roundTrip !== v.clientSecret) {
    return { ok: false, code: C.KEY_CHECK_FAILED };
  }

  const db = deps.db ?? (await defaultDb());

  try {
    const existing = await db.billingAuthorityApp.findUnique({
      where: { environment: PRODUCTION },
      select: { id: true },
    });
    if (existing) return { ok: false, code: C.APP_ALREADY_REGISTERED };
  } catch (error) {
    logFailure("READ", error);
    return { ok: false, code: C.READ_FAILED };
  }

  let created = false;
  if (v.mode === "apply") {
    try {
      // createMany never updates an existing row (no upsert) and emits no
      // RETURNING; the unique(environment) constraint refuses a racing insert.
      const result = await db.billingAuthorityApp.createMany({
        data: {
          environment: PRODUCTION,
          status: BillingAuthorityAppStatus.ACTIVE,
          accountingSoftwareNumber: v.accountingSoftwareNumber,
          itaClientId: v.itaClientId,
          clientSecretEncrypted: material.encrypted,
          clientSecretIv: material.iv,
          clientSecretTag: material.tag,
          encryptionKeyId: AUTHORITY_APP_REGISTRATION_ENCRYPTION_KEY_ID,
          portalOrganizationId: null,
          portalApplicationId: v.portalApplicationId,
          registeredAt: now(),
          lastValidatedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      if (result.count !== 1) return { ok: false, code: C.WRITE_FAILED };
      created = true;
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false, code: C.APP_ALREADY_REGISTERED };
      logFailure("WRITE", error);
      return { ok: false, code: C.WRITE_FAILED };
    }
  }

  return {
    ok: true,
    summary: {
      mode: v.mode,
      environment: "PRODUCTION",
      itaClientId: maskTail(v.itaClientId),
      accountingSoftwareNumber: maskTail(v.accountingSoftwareNumber),
      portalApplicationId: v.portalApplicationId,
      keyCheck: "OK",
      created,
    },
  };
}
