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
 *
 * sec(C) / M-14(a): every per-business access runs inside a tenant transaction
 * (`tenantTx`, GUC set), and the one pre-context lookup — webhook
 * phone_number_id -> business — goes through the narrow SECURITY DEFINER function
 * `sec_c_whatsapp_business_by_phone_number_id`, which returns ONLY the business id
 * of a CONNECTED row. That makes the table ready for FORCE RLS
 * (ops/security/sec-c-phase3-rls.sql) without the runtime ever needing
 * cross-tenant SELECT on rows that carry encrypted tokens.
 */

import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";
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

function isUndefinedFunction(error: unknown): boolean {
  const e = error as { code?: string; meta?: { code?: string }; message?: string } | null;
  return (
    e?.meta?.code === "42883" ||
    e?.code === "42883" ||
    /function public.sec_c_whatsapp_business_by_phone_number_id(.*) does not exist/.test(
      String(e?.message ?? "")
    )
  );
}

// ─── reads ─────────────────────────────────────────────────────────────────

export async function findPublicByBusinessId(
  businessId: number
): Promise<PublicConnection | null> {
  if (!Number.isInteger(businessId) || businessId <= 0) return null;
  return tenantTx(businessId, (tx) =>
    tx.whatsAppConnection.findUnique({
      where: { businessId },
      select: PUBLIC_SELECT,
    })
  );
}

/**
 * Connection states under which INBOUND events are still accepted.
 *
 * M2 (W8): before this, inbound required `CONNECTED`. But an outbound send
 * that Graph refused with 401/403/190 flips the row to `REVOKED_BY_META`
 * (`markRevokedByMeta`), and every customer message after that was dropped
 * with a 200 — a failed reply silently cut the business off from its own
 * customers. An outbound auth error proves the business's SEND token stopped
 * working; it proves nothing about inbound. A webhook that arrives here is
 * signed with the app secret and names this phone_number_id, which is Meta's
 * own evidence that it is still delivering this number's traffic to us.
 *
 *   CONNECTED        accepted
 *   REVOKED_BY_META  accepted — outbound token failure only
 *   ERROR            accepted — a recorded transient error, not a disconnect
 *   DISCONNECTED     refused  — the owner disconnected on purpose
 *   REVOKED          refused  — an explicit revocation
 *
 * Tenant binding is unchanged: phoneNumberId is unique and 1:1 with a business.
 */
const INBOUND_ACCEPTING_STATUSES: readonly WhatsAppConnectionStatus[] = [
  "CONNECTED",
  "REVOKED_BY_META",
  "ERROR",
];

export function connectionAcceptsInbound(status: string): boolean {
  return (INBOUND_ACCEPTING_STATUSES as readonly string[]).includes(status);
}

/**
 * Used by the inbound webhook router. Returns the `businessId` when the number
 * is bound to a business whose connection still accepts inbound (see
 * `connectionAcceptsInbound`). An unknown number, or one the owner disconnected,
 * yields null — the webhook records nothing for it and answers 200.
 *
 * A database error PROPAGATES (never "not found"), so the webhook refuses to
 * acknowledge and the provider redelivers.
 */
export async function resolveBusinessIdByPhoneNumberId(
  phoneNumberId: string
): Promise<number | null> {
  if (typeof phoneNumberId !== "string" || phoneNumberId.length === 0) {
    return null;
  }
  // D2/P7-W4A: a DB failure must PROPAGATE, never read as "not found" —
  // the old swallow-and-return-null pattern let a transient DB error hit the
  // env fallback map, silently rerouting tenant resolution. Now only a true
  // miss / owner-stopped row yields null.
  let viaFunction: number | null = null;
  try {
    const rows = await prisma.$queryRaw<{ b: number | null }[]>`
      SELECT public.sec_c_whatsapp_business_by_phone_number_id(${phoneNumberId}) AS b`;
    viaFunction = rows[0]?.b ?? null;
  } catch (error) {
    // ONLY "function does not exist" (42883) — a database the sec(C) migration has
    // not reached (schema-push labs). There the table has no RLS and the direct
    // lookup below is exactly main's behaviour. Every other error propagates.
    if (!isUndefinedFunction(error)) throw error;
    console.error("[whatsapp] bootstrap lookup function missing — using direct lookup");
  }
  if (typeof viaFunction === "number" && viaFunction > 0) return viaFunction;

  // The definer function (migration 20260926110100) answers CONNECTED rows only. Main
  // (#557/#558) also accepts inbound for REVOKED_BY_META and ERROR, so a miss is
  // re-checked with the direct read — the same read main performs, possible only
  // while WhatsAppConnection has no RLS. Phase 3 (ops/security/sec-c-phase3-rls.sql)
  // must NOT ship until a migration widens the function to connectionAcceptsInbound's
  // statuses; under FORCE RLS this re-check sees nothing and those numbers would be
  // dropped again.
  const row = await prisma.whatsAppConnection.findUnique({
    where: { phoneNumberId },
    select: { businessId: true, status: true },
  });
  if (!row) return null;
  if (!connectionAcceptsInbound(row.status)) return null;
  return row.businessId;
}

/**
 * Every business that has a WhatsApp connection row, in any status. Read by the
 * intake sweeper to find tenants that may hold unprocessed receipts — including
 * one that disconnected after its receipts were recorded (a receipt Dubiz
 * accepted is finished whatever the connection does next). WhatsAppConnection
 * is the allowlisted bootstrap table, readable without a tenant; this file
 * remains its sole reader. Returns ids only.
 */
export async function listBusinessIdsWithWhatsAppConnection(): Promise<number[]> {
  const rows = await prisma.whatsAppConnection.findMany({
    select: { businessId: true },
    orderBy: { businessId: "asc" },
  });
  return rows.map((r) => r.businessId);
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
  const row = await tenantTx(businessId, (tx) => tx.whatsAppConnection.findUnique({
    where: { businessId },
    select: {
      status: true,
      phoneNumberId: true,
      accessTokenEncrypted: true,
      accessTokenIv: true,
      accessTokenTag: true,
    },
  }));
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

  return tenantTx(input.businessId, (tx) => tx.whatsAppConnection.upsert({
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
  }));
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
  return tenantTx(businessId, async (tx) => {
  const existing = await tx.whatsAppConnection.findUnique({
    where: { businessId },
    select: { id: true },
  });
  if (!existing) return null;

  return tx.whatsAppConnection.update({
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

  const result = await tenantTx(businessId, (tx) =>
    tx.whatsAppConnection.deleteMany({ where: { businessId } })
  );
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
  await tenantTx(businessId, (tx) => tx.whatsAppConnection.updateMany({
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
  }));
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
  await tenantTx(businessId, (tx) => tx.whatsAppConnection.updateMany({
    where: { businessId },
    data: {
      lastErrorAt: new Date(),
      lastErrorCode: reason.code.slice(0, 64),
      lastErrorMessage: reason.message.slice(0, 500),
    },
  }));
}
