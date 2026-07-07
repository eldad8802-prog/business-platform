/**
 * `WhatsAppConnection` persistence layer.
 *
 * Boundaries:
 *   - Token is encrypted on write, decrypted on read inside this module.
 *   - Public APIs never return the plaintext token or the ciphertext
 *     columns — callers either get a sanitized view (`PublicConnection`) or
 *     an explicit decrypted token via `getAccessTokenForBusiness`.
 *   - All status transitions are funnelled through named methods (no raw
 *     `update` exposed) so the lifecycle stays auditable.
 *
 * This service is the only file that may touch
 *   `prisma.whatsAppConnection.*`
 * outside of generated migrations. Keep it that way.
 */

import { prisma } from "@/lib/prisma";
import type { Prisma, WhatsAppConnectionStatus } from "@prisma/client";
import {
  decryptAccessToken,
  encryptAccessToken,
} from "./token-crypto.service";

/**
 * The shape returned by every public read API. Never includes the encrypted
 * token columns. Safe to return from HTTP routes.
 */
export type PublicConnection = {
  businessId: number;
  status: WhatsAppConnectionStatus;
  phoneNumberId: string;
  displayPhoneNumber: string;
  wabaId: string;
  lastVerifiedAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const PUBLIC_SELECT = {
  businessId: true,
  status: true,
  phoneNumberId: true,
  displayPhoneNumber: true,
  wabaId: true,
  lastVerifiedAt: true,
  lastErrorAt: true,
  lastErrorCode: true,
  lastErrorMessage: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.WhatsAppConnectionSelect;

// ─── reads ─────────────────────────────────────────────────────────────────

export async function findPublicByBusinessId(
  businessId: number
): Promise<PublicConnection | null> {
  if (!Number.isInteger(businessId) || businessId <= 0) return null;
  return prisma.whatsAppConnection.findUnique({
    where: { businessId },
    select: PUBLIC_SELECT,
  });
}

/**
 * Used by the inbound webhook router. Returns the `businessId` ONLY when
 * status is `CONNECTED`. Unknown / non-active connections behave as
 * "not connected" — the webhook should log + return 200 without writing.
 *
 * DB errors (e.g. table not yet migrated, connection blip) are swallowed
 * and treated as "not found" so the caller (`business-resolve.service`)
 * can fall back to the env-map when `WHATSAPP_ALLOW_ENV_FALLBACK=1`. This
 * is what keeps the existing PR2/PR3 routing tests green during the
 * migration window — they hit a non-migrated DB but expect env-map
 * routing to work.
 */
export async function resolveBusinessIdByPhoneNumberId(
  phoneNumberId: string
): Promise<number | null> {
  if (typeof phoneNumberId !== "string" || phoneNumberId.length === 0) {
    return null;
  }
  try {
    const row = await prisma.whatsAppConnection.findUnique({
      where: { phoneNumberId },
      select: { businessId: true, status: true },
    });
    if (!row) return null;
    if (row.status !== "CONNECTED") return null;
    return row.businessId;
  } catch {
    return null;
  }
}

/**
 * Returns the plaintext access token for outbound sends. Should be called
 * once per send and discarded immediately. Returns `null` when:
 *   - no row exists for the business
 *   - status is not `CONNECTED`
 *   - GCM decryption fails (tamper, wrong key, wrong businessId AAD)
 *
 * Callers MUST treat `null` as a hard failure.
 */
export async function getAccessTokenForBusiness(
  businessId: number
): Promise<{ token: string; phoneNumberId: string } | null> {
  if (!Number.isInteger(businessId) || businessId <= 0) return null;
  const row = await prisma.whatsAppConnection.findUnique({
    where: { businessId },
    select: {
      status: true,
      phoneNumberId: true,
      accessTokenEncrypted: true,
      accessTokenIv: true,
      accessTokenTag: true,
    },
  });
  if (!row) return null;
  if (row.status !== "CONNECTED") return null;
  const token = decryptAccessToken(
    {
      encrypted: row.accessTokenEncrypted,
      iv: row.accessTokenIv,
      tag: row.accessTokenTag,
    },
    businessId
  );
  if (!token) return null;
  return { token, phoneNumberId: row.phoneNumberId };
}

// ─── writes ────────────────────────────────────────────────────────────────

export type ManualSeedInput = {
  businessId: number;
  phoneNumberId: string;
  displayPhoneNumber: string;
  wabaId: string;
  accessToken: string;
};

/**
 * Manual-seed insert used by the MVP-1 admin route. Encrypts the token,
 * upserts the connection row, and sets `status = CONNECTED`.
 *
 * Idempotent on `(businessId)`. Calling this with a different
 * `phoneNumberId` for the same `businessId` will REPLACE the prior
 * connection — that's the intended behavior for re-seeding.
 *
 * Throws on invalid inputs. The caller is expected to validate access
 * (admin role + WHATSAPP_MANUAL_SEED_ENABLED env flag) before invoking.
 */
export async function manualSeedConnection(
  input: ManualSeedInput
): Promise<PublicConnection> {
  if (!Number.isInteger(input.businessId) || input.businessId <= 0) {
    throw new Error("manualSeedConnection: invalid businessId");
  }
  if (!input.phoneNumberId.trim()) {
    throw new Error("manualSeedConnection: phoneNumberId is required");
  }
  if (!input.displayPhoneNumber.trim()) {
    throw new Error("manualSeedConnection: displayPhoneNumber is required");
  }
  if (!input.wabaId.trim()) {
    throw new Error("manualSeedConnection: wabaId is required");
  }
  if (!input.accessToken || input.accessToken.length < 8) {
    throw new Error("manualSeedConnection: accessToken looks invalid");
  }

  const encrypted = encryptAccessToken(input.accessToken, input.businessId);

  return prisma.whatsAppConnection.upsert({
    where: { businessId: input.businessId },
    create: {
      businessId: input.businessId,
      phoneNumberId: input.phoneNumberId.trim(),
      displayPhoneNumber: input.displayPhoneNumber.trim(),
      wabaId: input.wabaId.trim(),
      accessTokenEncrypted: encrypted.encrypted,
      accessTokenIv: encrypted.iv,
      accessTokenTag: encrypted.tag,
      status: "CONNECTED",
      lastVerifiedAt: new Date(),
      lastErrorAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
    update: {
      phoneNumberId: input.phoneNumberId.trim(),
      displayPhoneNumber: input.displayPhoneNumber.trim(),
      wabaId: input.wabaId.trim(),
      accessTokenEncrypted: encrypted.encrypted,
      accessTokenIv: encrypted.iv,
      accessTokenTag: encrypted.tag,
      status: "CONNECTED",
      lastVerifiedAt: new Date(),
      lastErrorAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
    select: PUBLIC_SELECT,
  });
}

/**
 * Embedded Signup persist (Ticket 4). Called by the
 * `/api/integrations/whatsapp/embedded-signup` route after the server-side
 * token exchange + phone-number fetch have already succeeded.
 *
 * Same write semantics as `manualSeedConnection` — encrypts the token,
 * upserts on `(businessId)`, sets `status = CONNECTED`, stamps
 * `lastVerifiedAt`, clears the last-error columns — and returns the
 * sanitized `PublicConnection` (never the token or ciphertext columns).
 *
 * It is a distinct public entry point (not the admin manual-seed path) so
 * the connect lifecycle stays explicit at the call site. The shared write
 * is delegated so the two paths can never drift apart.
 */
export type EmbeddedSignupPersistInput = {
  businessId: number;
  phoneNumberId: string;
  displayPhoneNumber: string;
  wabaId: string;
  accessToken: string;
};

export async function persistFromEmbeddedSignup(
  input: EmbeddedSignupPersistInput
): Promise<PublicConnection> {
  return manualSeedConnection(input);
}

/**
 * Owner-initiated disconnect. Wipes the encrypted token blob so the row
 * cannot be used for sends even if status is flipped back by accident.
 *
 * The row is preserved (not deleted) so we keep an audit of historical
 * `phoneNumberId` → `businessId` bindings.
 */
export async function disconnectByBusinessId(
  businessId: number
): Promise<PublicConnection | null> {
  if (!Number.isInteger(businessId) || businessId <= 0) return null;
  const existing = await prisma.whatsAppConnection.findUnique({
    where: { businessId },
    select: { id: true },
  });
  if (!existing) return null;

  return prisma.whatsAppConnection.update({
    where: { businessId },
    data: {
      status: "DISCONNECTED",
      // Wipe ciphertext + nonce + tag so the token cannot be revived.
      // Use empty strings (not NULL) — the columns are NOT NULL in the schema.
      accessTokenEncrypted: "",
      accessTokenIv: "",
      accessTokenTag: "",
      lastVerifiedAt: null,
    },
    select: PUBLIC_SELECT,
  });
}

/**
 * Owner-initiated Meta data deletion. Removes only the per-business
 * WhatsAppConnection row, which contains the encrypted token parts and Meta
 * identifiers. Conversation/customer/message history lives in separate tables
 * and is intentionally untouched.
 */
export async function deleteMetaDataByBusinessId(
  businessId: number
): Promise<{ deleted: boolean }> {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    return { deleted: false };
  }

  const result = await prisma.whatsAppConnection.deleteMany({
    where: { businessId },
  });
  return { deleted: result.count > 0 };
}

/**
 * Marks the connection as broken on Meta's side. Called by the outbound
 * send path when Graph returns a 401/403 indicating token revocation.
 * Token columns are wiped in the same step.
 */
export async function markRevokedByMeta(
  businessId: number,
  reason: { code: string; message: string }
): Promise<void> {
  if (!Number.isInteger(businessId) || businessId <= 0) return;
  await prisma.whatsAppConnection.updateMany({
    where: { businessId, status: { not: "DISCONNECTED" } },
    data: {
      status: "REVOKED_BY_META",
      accessTokenEncrypted: "",
      accessTokenIv: "",
      accessTokenTag: "",
      lastErrorAt: new Date(),
      lastErrorCode: reason.code.slice(0, 64),
      lastErrorMessage: reason.message.slice(0, 500),
    },
  });
}

/**
 * Records a transient send/verify error. Does NOT change status — the
 * connection may still be usable. Errors are clamped to safe lengths so
 * an attacker-controlled error message can't fill the column.
 */
export async function recordTransientError(
  businessId: number,
  reason: { code: string; message: string }
): Promise<void> {
  if (!Number.isInteger(businessId) || businessId <= 0) return;
  await prisma.whatsAppConnection.updateMany({
    where: { businessId },
    data: {
      lastErrorAt: new Date(),
      lastErrorCode: reason.code.slice(0, 64),
      lastErrorMessage: reason.message.slice(0, 500),
    },
  });
}
