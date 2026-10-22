/**
 * Platform-admin passkeys (WebAuthn) — a second, phishing-resistant way for an
 * allowlisted PLATFORM_ADMIN to step up: Face ID / fingerprint / device PIN on
 * the phone or computer, instead of typing a six-digit code. The TOTP factor
 * stays; a passkey is added NEXT to it, never instead of it.
 *
 * Verification is `@simplewebauthn/server` (pinned): a maintained, widely used
 * implementation of the WebAuthn Level 2 checks (origin, RP id hash, user
 * presence AND verification, signature over authData||clientDataHash, counter)
 * — a security control that is hand-rolled and subtly wrong is worse than none.
 *
 * Invariants:
 *   - OFF unless PLATFORM_ADMIN_PASSKEY_ENABLED === "true";
 *   - AUTH PLANE ONLY: the table is granted to app_auth alone (migration
 *     20261024090000). In the legacy auth mode the feature reports itself
 *     unavailable rather than reaching for the tenant runtime;
 *   - only an MFA-ELEVATED admin can register a passkey (the route uses the full
 *     guard), so a stolen session alone can never add a factor;
 *   - user verification is REQUIRED in both ceremonies;
 *   - public keys only are stored; nothing secret lives in the row;
 *   - an assertion is accepted at most once: its challenge hash and the counter
 *     it was verified against are the conditions of the single UPDATE that
 *     accepts it — a replay, or two concurrent uses, match zero rows;
 *   - removal is `revokedAt` (no DELETE privilege exists).
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { authDb, isAuthPlaneActive } from "@/lib/prisma-auth";
import {
  issuePasskeyChallenge,
  verifyPasskeyChallenge,
} from "./admin-passkey-challenge";

const RP_NAME = "Dubiz Admin";
const MAX_PASSKEYS_PER_ADMIN = 10;
const DEFAULT_LABEL = "מפתח גישה";
const KNOWN_TRANSPORTS: readonly AuthenticatorTransportFuture[] = [
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
];

export type PasskeyAvailability =
  | { enabled: true; rpID: string; origin: string }
  | { enabled: false; reason: "FLAG_OFF" | "AUTH_PLANE_LEGACY" | "NO_BASE_URL" };

/** Whether passkeys can work here, and the relying party they bind to. */
export function passkeyAvailability(env: NodeJS.ProcessEnv = process.env): PasskeyAvailability {
  if (env.PLATFORM_ADMIN_PASSKEY_ENABLED?.trim().toLowerCase() !== "true") {
    return { enabled: false, reason: "FLAG_OFF" };
  }
  let active = false;
  try {
    active = isAuthPlaneActive();
  } catch {
    active = false;
  }
  if (!active) return { enabled: false, reason: "AUTH_PLANE_LEGACY" };
  const base = env.APP_BASE_URL?.trim();
  if (!base) return { enabled: false, reason: "NO_BASE_URL" };
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return { enabled: false, reason: "NO_BASE_URL" };
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    return { enabled: false, reason: "NO_BASE_URL" };
  }
  return { enabled: true, rpID: url.hostname, origin: url.origin };
}

export class PasskeyUnavailableError extends Error {
  constructor(public readonly reason: string) {
    super(`Passkeys are not available here (${reason})`);
    this.name = "PasskeyUnavailableError";
  }
}

function requireAvailable(): { rpID: string; origin: string } {
  const a = passkeyAvailability();
  if (!a.enabled) throw new PasskeyUnavailableError(a.reason);
  return { rpID: a.rpID, origin: a.origin };
}

function cleanTransports(raw: unknown): AuthenticatorTransportFuture[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is AuthenticatorTransportFuture =>
    KNOWN_TRANSPORTS.includes(t as AuthenticatorTransportFuture)
  );
}

/**
 * The challenge as the library must receive it: the RAW bytes. Given a string,
 * @simplewebauthn/server UTF-8-encodes it and re-encodes that as base64url, so
 * the browser would sign a different challenge from the one our envelope vouches
 * for (found end-to-end with a virtual authenticator; pinned by a unit test).
 */
export function challengeBytes(challenge: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(challenge, "base64url"));
}

export function normalizePasskeyLabel(raw: unknown): string {
  const label = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!label) return DEFAULT_LABEL;
  return label.slice(0, 60);
}

export type AdminPasskeySummary = {
  id: number;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: string | null;
  backedUp: boolean;
};

export async function listActivePasskeys(userId: number): Promise<AdminPasskeySummary[]> {
  const rows = await authDb().platformAdminPasskey.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, label: true, createdAt: true, lastUsedAt: true, deviceType: true, backedUp: true },
  });
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    deviceType: r.deviceType,
    backedUp: r.backedUp,
  }));
}

/** Count without throwing — used by the session endpoint to decide what to offer. */
export async function countActivePasskeysSafe(userId: number): Promise<number> {
  if (!passkeyAvailability().enabled) return 0;
  try {
    return await authDb().platformAdminPasskey.count({ where: { userId, revokedAt: null } });
  } catch {
    return 0;
  }
}

/**
 * Strict variant for SECURITY decisions (e.g. "adding a factor needs a fresh
 * step-up when one already exists"): a database error propagates instead of
 * reading as zero, so the decision fails closed. Off flag = no usable passkey.
 */
export async function hasActivePasskeys(userId: number): Promise<boolean> {
  if (!passkeyAvailability().enabled) return false;
  return (await authDb().platformAdminPasskey.count({ where: { userId, revokedAt: null } })) > 0;
}

/* ------------------------------- registration ------------------------------ */

export async function beginPasskeyRegistration(admin: {
  id: number;
  email: string;
  name: string | null;
}): Promise<
  | { ok: true; options: PublicKeyCredentialCreationOptionsJSON; challengeToken: string }
  | { ok: false; reason: "too_many" }
> {
  const { rpID } = requireAvailable();
  const existing = await authDb().platformAdminPasskey.findMany({
    where: { userId: admin.id, revokedAt: null },
    select: { credentialId: true, transports: true },
  });
  if (existing.length >= MAX_PASSKEYS_PER_ADMIN) return { ok: false, reason: "too_many" };

  const { challenge, token } = issuePasskeyChallenge(admin.id, "register");
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: admin.email,
    userDisplayName: admin.name ?? admin.email,
    // Stable, opaque handle: never the email, never reused across users.
    userID: new TextEncoder().encode(`dubiz-admin:${admin.id}`),
    challenge: challengeBytes(challenge),
    timeout: 120_000,
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: cleanTransports(c.transports),
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
    // ES256 and RS256 cover every platform authenticator in use.
    supportedAlgorithmIDs: [-7, -257],
  });
  return { ok: true, options, challengeToken: token };
}

export type FinishRegistrationResult =
  | { ok: true; passkey: AdminPasskeySummary }
  | { ok: false; reason: "bad_challenge" | "not_verified" | "duplicate" | "too_many" };

export async function finishPasskeyRegistration(input: {
  userId: number;
  challengeToken: unknown;
  response: unknown;
  label: unknown;
}): Promise<FinishRegistrationResult> {
  const { rpID, origin } = requireAvailable();
  const challenge = verifyPasskeyChallenge(input.challengeToken, input.userId, "register");
  if (!challenge.ok) return { ok: false, reason: "bad_challenge" };

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
    });
  } catch {
    return { ok: false, reason: "not_verified" };
  }
  if (!verification.verified) return { ok: false, reason: "not_verified" };
  const info = verification.registrationInfo;

  const db = authDb();
  const active = await db.platformAdminPasskey.count({ where: { userId: input.userId, revokedAt: null } });
  if (active >= MAX_PASSKEYS_PER_ADMIN) return { ok: false, reason: "too_many" };

  try {
    const row = await db.platformAdminPasskey.create({
      data: {
        userId: input.userId,
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey),
        signCount: BigInt(info.credential.counter),
        transports: cleanTransports(info.credential.transports),
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        label: normalizePasskeyLabel(input.label),
      },
      select: { id: true, label: true, createdAt: true, lastUsedAt: true, deviceType: true, backedUp: true },
    });
    return {
      ok: true,
      passkey: {
        id: row.id,
        label: row.label,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: null,
        deviceType: row.deviceType,
        backedUp: row.backedUp,
      },
    };
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return { ok: false, reason: "duplicate" };
    throw e;
  }
}

/** Revoke one of THIS admin's passkeys. Never touches another user's row. */
export async function revokePasskey(userId: number, passkeyId: number): Promise<{ ok: boolean; label?: string }> {
  const db = authDb();
  const row = await db.platformAdminPasskey.findFirst({
    where: { id: passkeyId, userId, revokedAt: null },
    select: { id: true, label: true },
  });
  if (!row) return { ok: false };
  const updated = await db.platformAdminPasskey.updateMany({
    where: { id: row.id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return updated.count === 1 ? { ok: true, label: row.label } : { ok: false };
}

/* ------------------------------ authentication ----------------------------- */

export async function beginPasskeyAuthentication(userId: number): Promise<
  | { ok: true; options: PublicKeyCredentialRequestOptionsJSON; challengeToken: string }
  | { ok: false; reason: "no_passkeys" }
> {
  const { rpID } = requireAvailable();
  const creds = await authDb().platformAdminPasskey.findMany({
    where: { userId, revokedAt: null },
    select: { credentialId: true, transports: true },
  });
  if (creds.length === 0) return { ok: false, reason: "no_passkeys" };
  const { challenge, token } = issuePasskeyChallenge(userId, "authenticate");
  const options = await generateAuthenticationOptions({
    rpID,
    challenge: challengeBytes(challenge),
    timeout: 120_000,
    userVerification: "required",
    allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: cleanTransports(c.transports) })),
  });
  return { ok: true, options, challengeToken: token };
}

export type FinishAuthenticationResult =
  | { ok: true; passkeyId: number; label: string }
  | { ok: false; reason: "bad_challenge" | "unknown_credential" | "not_verified" | "replayed" };

export async function finishPasskeyAuthentication(input: {
  userId: number;
  challengeToken: unknown;
  response: unknown;
}): Promise<FinishAuthenticationResult> {
  const { rpID, origin } = requireAvailable();
  const challenge = verifyPasskeyChallenge(input.challengeToken, input.userId, "authenticate");
  if (!challenge.ok) return { ok: false, reason: "bad_challenge" };

  const response = input.response as AuthenticationResponseJSON;
  const credentialId = typeof response?.id === "string" ? response.id : "";
  if (!credentialId || credentialId.length > 1024) return { ok: false, reason: "unknown_credential" };

  const db = authDb();
  // Bound to THIS user: a credential registered by someone else never matches.
  const row = await db.platformAdminPasskey.findFirst({
    where: { credentialId, userId: input.userId, revokedAt: null },
    select: { id: true, label: true, publicKey: true, signCount: true, transports: true, lastChallengeIssuedAt: true },
  });
  if (!row) return { ok: false, reason: "unknown_credential" };

  // Only a challenge issued AFTER the last accepted one: this refuses the same
  // assertion twice and any older assertion still inside its 2-minute life.
  const issuedAt = challenge.issuedAt;
  if (row.lastChallengeIssuedAt && issuedAt.getTime() <= row.lastChallengeIssuedAt.getTime()) {
    return { ok: false, reason: "replayed" };
  }

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: credentialId,
        publicKey: new Uint8Array(row.publicKey),
        counter: Number(row.signCount),
        transports: cleanTransports(row.transports),
      },
    });
  } catch {
    return { ok: false, reason: "not_verified" };
  }
  if (!verification.verified) return { ok: false, reason: "not_verified" };

  // The single acceptance write. Its WHERE is the replay guard: the challenge
  // must be newer than the last one accepted, and the counter must still be the
  // one we verified against — a replay or a concurrent second use matches zero rows.
  const accepted = await db.platformAdminPasskey.updateMany({
    where: {
      id: row.id,
      userId: input.userId,
      revokedAt: null,
      signCount: row.signCount,
      OR: [{ lastChallengeIssuedAt: null }, { lastChallengeIssuedAt: { lt: issuedAt } }],
    },
    data: {
      signCount: BigInt(verification.authenticationInfo.newCounter),
      lastUsedAt: new Date(),
      lastChallengeIssuedAt: issuedAt,
    },
  });
  if (accepted.count !== 1) return { ok: false, reason: "replayed" };
  return { ok: true, passkeyId: row.id, label: row.label };
}
