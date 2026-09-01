/**
 * Platform-admin TOTP MFA (CASA 3.3.1).
 *
 * RFC 6238 TOTP via `otpauth` — a maintained, RFC-compliant implementation with
 * a single audited dependency (`@noble/hashes`). Chosen over hand-rolling the
 * algorithm (a security control that silently does nothing is worse than none)
 * and over `otplib` (six transitive packages vs. one), which matters because
 * CASA 6.1.1 judges the dependency surface.
 *
 * Parameters are the interoperable defaults every authenticator app expects:
 * SHA-1, 6 digits, 30-second period. They are NOT a weakness here — TOTP's
 * SHA-1 usage is HMAC-based and unaffected by SHA-1 collision attacks, and
 * deviating breaks Google Authenticator / 1Password / Authy compatibility.
 *
 * Invariants:
 *   - the seed is generated server-side, never accepted from a client;
 *   - the seed is persisted ONLY encrypted (dedicated key, see admin-mfa-crypto);
 *   - the provisioning URI is returned exactly once, at enrollment start;
 *   - MFA is enabled ONLY after a code has been proven (`enrolledAt`);
 *   - an accepted code's time-step is recorded, so a code cannot be replayed;
 *   - recovery codes are single-use and stored only as hashes;
 *   - no code, seed, URI or recovery code is ever logged.
 *
 * Reads/writes go through the sanctioned admin client: this is platform-plane
 * state with no `businessId`, so the tenant client (and its RLS context) is the
 * wrong tool and would be a CI-4 violation.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as OTPAuth from "otpauth";
import { getPrismaAdmin } from "@/lib/prisma-admin";
import {
  ADMIN_MFA_KEY_ID,
  decryptAdminMfaSecret,
  encryptAdminMfaSecret,
} from "./admin-mfa-crypto";

const ISSUER = "Dubiz";
const ALGORITHM = "SHA1";
const DIGITS = 6;
const PERIOD_SECONDS = 30;

/**
 * Accept the current step plus one on each side. One step (±30s) is the
 * standard allowance for clock drift; anything wider materially widens the
 * window an observed code stays usable.
 */
const DRIFT_WINDOW = 1;

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 10;

export type AdminMfaState = {
  exists: boolean;
  enrolled: boolean;
  enrolledAt: Date | null;
  lastVerifiedAt: Date | null;
  recoveryCodesRemaining: number;
};

export type VerifyOutcome =
  | { ok: true; via: "totp" | "recovery_code" }
  | {
      ok: false;
      reason: "not_enrolled" | "invalid_code" | "replayed_code" | "no_record";
    };

function buildTotp(secretBase32: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label: "platform-admin",
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase(), "utf8").digest("hex");
}

function constantTimeHashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Human-transcribable, unambiguous alphabet (no 0/O/1/I). */
function generateRecoveryCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(RECOVERY_CODE_BYTES);
  let out = "";
  for (let i = 0; i < RECOVERY_CODE_BYTES; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i === 4) out += "-";
  }
  return out;
}

/** Current state for a user. Never returns the seed or any code. */
export async function getAdminMfaState(userId: number): Promise<AdminMfaState> {
  const row = await getPrismaAdmin().platformAdminMfa.findUnique({
    where: { userId },
    select: {
      enrolledAt: true,
      lastVerifiedAt: true,
      recoveryCodeHashes: true,
    },
  });
  if (!row) {
    return {
      exists: false,
      enrolled: false,
      enrolledAt: null,
      lastVerifiedAt: null,
      recoveryCodesRemaining: 0,
    };
  }
  return {
    exists: true,
    enrolled: row.enrolledAt != null,
    enrolledAt: row.enrolledAt,
    lastVerifiedAt: row.lastVerifiedAt,
    recoveryCodesRemaining: row.recoveryCodeHashes.length,
  };
}

/**
 * Begin (or restart) enrollment. Generates a fresh server-side seed, stores it
 * encrypted with `enrolledAt = null`, and returns the provisioning URI ONCE.
 *
 * Restarting overwrites any unconfirmed seed. It refuses to overwrite an
 * already-enrolled record: re-enrolling an active authenticator must go through
 * the deliberate reset path, not through calling "begin" again.
 */
export async function beginAdminMfaEnrollment(
  userId: number
): Promise<
  | { ok: true; otpauthUri: string }
  | { ok: false; reason: "already_enrolled" }
> {
  const db = getPrismaAdmin();
  const existing = await db.platformAdminMfa.findUnique({
    where: { userId },
    select: { enrolledAt: true },
  });
  if (existing?.enrolledAt) {
    return { ok: false, reason: "already_enrolled" };
  }

  const secret = new OTPAuth.Secret({ size: 20 }); // 160-bit, RFC 4226 minimum
  const base32 = secret.base32;
  const { encrypted, keyId } = encryptAdminMfaSecret(base32);

  await db.platformAdminMfa.upsert({
    where: { userId },
    create: {
      userId,
      secretEncrypted: encrypted,
      encryptionKeyId: keyId,
      enrolledAt: null,
      recoveryCodeHashes: [],
    },
    update: {
      secretEncrypted: encrypted,
      encryptionKeyId: keyId,
      enrolledAt: null,
      lastUsedStep: null,
      recoveryCodeHashes: [],
      recoveryCodesGeneratedAt: null,
    },
  });

  return { ok: true, otpauthUri: buildTotp(base32).toString() };
}

/**
 * Confirm enrollment with a real code, then — and only then — enable MFA and
 * mint the recovery codes. They are returned exactly once and never again.
 */
export async function confirmAdminMfaEnrollment(
  userId: number,
  code: string,
  now: Date = new Date()
): Promise<
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; reason: "no_pending_enrollment" | "already_enrolled" | "invalid_code" }
> {
  const db = getPrismaAdmin();
  const row = await db.platformAdminMfa.findUnique({ where: { userId } });
  if (!row) return { ok: false, reason: "no_pending_enrollment" };
  if (row.enrolledAt) return { ok: false, reason: "already_enrolled" };

  const secret = decryptAdminMfaSecret(row.secretEncrypted);
  if (!secret) return { ok: false, reason: "no_pending_enrollment" };

  const delta = buildTotp(secret).validate({
    token: (code ?? "").trim(),
    window: DRIFT_WINDOW,
    timestamp: now.getTime(),
  });
  if (delta === null) return { ok: false, reason: "invalid_code" };

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const step = BigInt(Math.floor(now.getTime() / 1000 / PERIOD_SECONDS) + delta);

  await db.platformAdminMfa.update({
    where: { userId },
    data: {
      enrolledAt: now,
      lastVerifiedAt: now,
      lastUsedStep: step,
      recoveryCodeHashes: codes.map(hashRecoveryCode),
      recoveryCodesGeneratedAt: now,
    },
  });

  return { ok: true, recoveryCodes: codes };
}

/**
 * Verify a TOTP code — or, as a fallback, a single-use recovery code — for an
 * enrolled admin. On success the caller mints an elevation.
 *
 * Replay defence: the accepted time-step is persisted and any step at or below
 * it is refused, so a code observed over the shoulder or in a proxy log cannot
 * be reused even within its own 30-second window.
 */
export async function verifyAdminMfaCode(
  userId: number,
  code: string,
  now: Date = new Date()
): Promise<VerifyOutcome> {
  const db = getPrismaAdmin();
  const row = await db.platformAdminMfa.findUnique({ where: { userId } });
  if (!row) return { ok: false, reason: "no_record" };
  if (!row.enrolledAt) return { ok: false, reason: "not_enrolled" };

  const submitted = (code ?? "").trim();
  const secret = decryptAdminMfaSecret(row.secretEncrypted);

  if (secret) {
    const delta = buildTotp(secret).validate({
      token: submitted,
      window: DRIFT_WINDOW,
      timestamp: now.getTime(),
    });
    if (delta !== null) {
      const step = BigInt(
        Math.floor(now.getTime() / 1000 / PERIOD_SECONDS) + delta
      );
      if (row.lastUsedStep != null && step <= row.lastUsedStep) {
        return { ok: false, reason: "replayed_code" };
      }
      await db.platformAdminMfa.update({
        where: { userId },
        data: { lastUsedStep: step, lastVerifiedAt: now },
      });
      return { ok: true, via: "totp" };
    }
  }

  // Recovery-code fallback: constant-time compare, single use.
  const submittedHash = hashRecoveryCode(submitted);
  const match = row.recoveryCodeHashes.find((h) =>
    constantTimeHashEquals(h, submittedHash)
  );
  if (match) {
    await db.platformAdminMfa.update({
      where: { userId },
      data: {
        recoveryCodeHashes: row.recoveryCodeHashes.filter((h) => h !== match),
        lastVerifiedAt: now,
      },
    });
    return { ok: true, via: "recovery_code" };
  }

  return { ok: false, reason: "invalid_code" };
}

/**
 * Deliberate reset. Removes the record entirely so the admin can re-enroll from
 * scratch. This is NOT an unauthenticated escape hatch: the only callers are
 * behind the platform-admin guard, and the documented break-glass is an
 * operator-run database deletion of this row. Either way the next enrollment
 * still requires proving a code before MFA is active again.
 */
export async function resetAdminMfa(userId: number): Promise<void> {
  await getPrismaAdmin().platformAdminMfa.deleteMany({ where: { userId } });
}

export const __testing = {
  ADMIN_MFA_KEY_ID,
  DRIFT_WINDOW,
  PERIOD_SECONDS,
  RECOVERY_CODE_COUNT,
  buildTotp,
  generateRecoveryCode,
  hashRecoveryCode,
};
