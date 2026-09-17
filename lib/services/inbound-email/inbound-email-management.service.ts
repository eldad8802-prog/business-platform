import { logAuditEvent } from "@/lib/services/audit.service";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import {
  buildInboundAddress,
  inboundLocalPartPreview,
  inboundTokenHash,
  mintInboundLocalPart,
} from "@/lib/inbound-email/inbound-address";
import {
  decryptInboundLocalPart,
  encryptInboundLocalPart,
  INBOUND_EMAIL_ENCRYPTION_KEY_ID,
} from "@/lib/inbound-email/inbound-address-crypto";
import { normalizeEmail } from "@/lib/auth/signup-identity";

/**
 * The management plane for inbound-email forwarding: the address a business
 * forwards to, and the senders it is willing to accept mail from.
 *
 * # What this is not
 *
 * It receives no mail. Nothing here touches SES, object storage, a queue, a MIME
 * parser or a Document. It is the settings surface that has to exist before any
 * of that can be turned on, and at this increment the feature flag is off, so
 * nothing calls it in Production at all.
 *
 * # Why the lifecycle lives here and not in a route or a component
 *
 * Rotation is four writes that must happen together, and "is this address still
 * usable" is a comparison a later worker will have to make the same way this
 * screen makes it. A rule that lives in a React component is a rule the worker
 * will reimplement slightly differently.
 */

/** Thirty days, the approved grace a rotated address keeps. */
export const INBOUND_ADDRESS_GRACE_DAYS = 30;

/**
 * Advisory-lock namespace for this feature.
 *
 * `pg_advisory_xact_lock(namespace, businessId)` serialises the two operations
 * that must never interleave — creating the first address and rotating it —
 * because nothing in the schema stops a business from ending up with two ACTIVE
 * rows. A unique index cannot express "at most one row with this status", so the
 * guarantee is taken in the transaction instead, and the lock is released when
 * that transaction ends rather than when somebody remembers to release it.
 */
const INBOUND_ADDRESS_LOCK_NAMESPACE = 0x1b_0d;

export type InboundAddressView = {
  id: number;
  /** The full forwarding address, decrypted for display. */
  address: string | null;
  /** Masked fragment, always safe to show even when decryption failed. */
  preview: string;
  status: "ACTIVE" | "RETIRING" | "REVOKED";
  /** When a retiring address stops being usable. */
  graceUntil: string | null;
  /** Derived from the clock, never from a background job having run. */
  expired: boolean;
  createdAt: string;
};

export type InboundSenderView = {
  id: number;
  email: string;
  status: "PENDING_VERIFICATION" | "VERIFIED" | "REVOKED";
  createdAt: string;
};

export type InboundEmailSettingsView = {
  /** The address to forward to, or null when none has been created yet. */
  current: InboundAddressView | null;
  /** Previous addresses still inside their grace window, newest first. */
  retiring: InboundAddressView[];
  /** Current senders only. Revoked history is kept but not shown here. */
  senders: InboundSenderView[];
  /**
   * True when the current address exists but its stored material could not be
   * decrypted. The caller shows an error; it must NOT rotate or regenerate,
   * because that would destroy an address the owner may already have configured
   * forwarding to.
   */
  addressUnreadable: boolean;
};

const ADDRESS_SELECT = {
  id: true,
  status: true,
  localPartPreview: true,
  localPartEncrypted: true,
  localPartIv: true,
  localPartTag: true,
  encryptionKeyId: true,
  tokenHash: true,
  graceUntil: true,
  createdAt: true,
} as const;

type AddressRow = {
  id: number;
  status: string;
  localPartPreview: string;
  localPartEncrypted: string;
  localPartIv: string;
  localPartTag: string;
  encryptionKeyId: string;
  tokenHash: string;
  graceUntil: Date | null;
  createdAt: Date;
};

/** The domain addresses are built on. Absent means the feature is unconfigured. */
function inboundDomain(): string | null {
  const raw = process.env.INBOUND_EMAIL_DOMAIN?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/**
 * Turn a stored row into something displayable, or report that it is not.
 *
 * Decryption failure is reported, never worked around. The plaintext cannot be
 * recovered from `tokenHash` — that is the whole point of storing a hash — so a
 * failure here means the key changed or the row is damaged, and the honest
 * answer is to say so rather than to mint a replacement the owner has not
 * forwarded anything to.
 */
function toView(
  row: AddressRow,
  businessId: number,
  domain: string | null,
  now: Date
): InboundAddressView | null {
  let localPart: string | null = null;
  try {
    // The AAD binds the ciphertext to this business and this token hash, so a
    // row moved between tenants fails to authenticate instead of decrypting
    // into somebody else's address.
    localPart = decryptInboundLocalPart(row, businessId, row.tokenHash);
  } catch {
    // A missing or malformed key throws rather than returning null. Same
    // answer either way: unreadable, and the caller must not paper over it.
    return null;
  }
  if (localPart === null) return null;

  return {
    id: row.id,
    address: domain ? buildInboundAddress(localPart, domain) : null,
    preview: row.localPartPreview,
    status: row.status as InboundAddressView["status"],
    graceUntil: row.graceUntil ? row.graceUntil.toISOString() : null,
    expired: isExpired(row.status, row.graceUntil, now),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Is this address past the point where a future intake could still accept it?
 *
 * THE TIMESTAMP DECIDES, not the status column. A retiring address whose grace
 * has elapsed is expired the moment the clock passes it, whether or not anything
 * has rewritten the row — otherwise a sweep that runs late would leave an
 * address usable after it was supposed to stop, which is a security hole with a
 * scheduling excuse.
 */
export function isExpired(status: string, graceUntil: Date | null, now: Date): boolean {
  if (status === "REVOKED") return true;
  if (status !== "RETIRING") return false;
  return graceUntil === null || graceUntil.getTime() <= now.getTime();
}

/** Read the settings surface. Performs no writes of any kind. */
export async function getInboundEmailSettings(
  businessId: number,
  now: Date = new Date()
): Promise<InboundEmailSettingsView> {
  const domain = inboundDomain();
  return tenantTx(businessId, async (tx) => {
    const addresses = (await tx.inboundEmailAddress.findMany({
      where: { businessId, status: { in: ["ACTIVE", "RETIRING"] } },
      select: ADDRESS_SELECT,
      orderBy: { createdAt: "desc" },
    })) as AddressRow[];

    const activeRow = addresses.find((a) => a.status === "ACTIVE") ?? null;
    const current = activeRow ? toView(activeRow, businessId, domain, now) : null;

    const retiring = addresses
      .filter((a) => a.status === "RETIRING")
      .map((a) => toView(a, businessId, domain, now))
      .filter((v): v is InboundAddressView => v !== null);

    const senders = await tx.inboundEmailAuthorizedSender.findMany({
      // Current identities only. Revoked rows are kept as history and are not
      // part of the owner's working list.
      where: { businessId, status: { in: ["PENDING_VERIFICATION", "VERIFIED"] } },
      select: { id: true, normalizedEmail: true, status: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    return {
      current,
      retiring,
      senders: senders.map((s) => ({
        id: s.id,
        email: s.normalizedEmail,
        status: s.status as InboundSenderView["status"],
        createdAt: s.createdAt.toISOString(),
      })),
      addressUnreadable: activeRow !== null && current === null,
    };
  });
}

/** Mint the columns a new address row needs. */
function mintAddressRow(businessId: number) {
  const localPart = mintInboundLocalPart();
  const tokenHash = inboundTokenHash(localPart);
  const encrypted = encryptInboundLocalPart(localPart, businessId, tokenHash);
  return {
    tokenHash,
    localPartPreview: inboundLocalPartPreview(localPart),
    ...encrypted,
  };
}

/**
 * Serialise everything that touches which address is current, per tenant.
 *
 * Taken inside the tenant transaction so it is released with it. Without it,
 * two clicks on "create" a few milliseconds apart each see no ACTIVE row and
 * each create one.
 */
async function lockAddresses(tx: { $executeRawUnsafe: (sql: string, ...a: unknown[]) => Promise<number> }, businessId: number) {
  await tx.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock($1::int, $2::int)`,
    INBOUND_ADDRESS_LOCK_NAMESPACE,
    businessId
  );
}

export type InitializeResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: "DOMAIN_NOT_CONFIGURED" };

/**
 * Ensure the business has one current address, creating it only if none exists.
 *
 * An explicit action rather than a side effect of reading: a GET that creates
 * rows makes "open the settings page" a mutation, and makes it impossible to
 * tell a real address from one conjured by a stray page load.
 */
export async function initializeInboundAddress(
  businessId: number,
  userId: number
): Promise<InitializeResult> {
  if (inboundDomain() === null) return { ok: false, reason: "DOMAIN_NOT_CONFIGURED" };

  const created = await tenantTx(businessId, async (tx) => {
    await lockAddresses(tx, businessId);
    const existing = await tx.inboundEmailAddress.findFirst({
      where: { businessId, status: "ACTIVE" },
      select: { id: true },
    });
    if (existing) return false;

    await tx.inboundEmailAddress.create({
      data: { businessId, ...mintAddressRow(businessId), status: "ACTIVE", createdByUserId: userId },
    });
    return true;
  });

  if (created) {
    await logAuditEvent({
      businessId,
      eventType: "INBOUND_EMAIL_ADDRESS_CREATED",
      entityType: "InboundEmailAddress",
      // No local part, no token hash: the address itself is the routing
      // capability and does not belong in an event log.
      payload: { userId },
    });
  }
  return { ok: true, created };
}

export type RotateResult =
  | { ok: true }
  | { ok: false; reason: "DOMAIN_NOT_CONFIGURED" | "NO_CURRENT_ADDRESS" };

/**
 * Retire the current address and issue a new one, as one operation.
 *
 * The old address keeps working for thirty days because the owner has already
 * told suppliers to use it, and a rotation that broke it immediately would lose
 * invoices. Both writes happen in one transaction under the same lock, so there
 * is no instant where a business has two current addresses or none.
 */
export async function rotateInboundAddress(
  businessId: number,
  userId: number,
  now: Date = new Date()
): Promise<RotateResult> {
  if (inboundDomain() === null) return { ok: false, reason: "DOMAIN_NOT_CONFIGURED" };

  const graceUntil = new Date(now.getTime() + INBOUND_ADDRESS_GRACE_DAYS * 24 * 60 * 60 * 1000);

  const outcome = await tenantTx(businessId, async (tx) => {
    await lockAddresses(tx, businessId);
    const current = await tx.inboundEmailAddress.findFirst({
      where: { businessId, status: "ACTIVE" },
      select: { id: true },
    });
    if (!current) return "NO_CURRENT_ADDRESS" as const;

    // Scoped by businessId as well as id. The id came from a query that was
    // already tenant-scoped and row-level security is in force, but a write
    // that names its tenant cannot be quietly widened by a later edit.
    await tx.inboundEmailAddress.updateMany({
      where: { id: current.id, businessId, status: "ACTIVE" },
      data: { status: "RETIRING", graceUntil },
    });
    await tx.inboundEmailAddress.create({
      data: { businessId, ...mintAddressRow(businessId), status: "ACTIVE", createdByUserId: userId },
    });
    return "ROTATED" as const;
  });

  if (outcome === "NO_CURRENT_ADDRESS") return { ok: false, reason: "NO_CURRENT_ADDRESS" };

  await logAuditEvent({
    businessId,
    eventType: "INBOUND_EMAIL_ADDRESS_ROTATED",
    entityType: "InboundEmailAddress",
    payload: { userId, graceUntil: graceUntil.toISOString() },
  });
  return { ok: true };
}

export type RevokeAddressResult = { ok: true } | { ok: false; reason: "NOT_FOUND" };

/**
 * Stop a retiring address immediately.
 *
 * Only a RETIRING address. Revoking the CURRENT one would leave the business
 * with nowhere to forward to, and no approved operation replaces it in the same
 * breath, so the management plane does not offer it.
 */
export async function revokeRetiringAddress(
  businessId: number,
  addressId: number,
  userId: number,
  now: Date = new Date()
): Promise<RevokeAddressResult> {
  const updated = await tenantTx(businessId, async (tx) =>
    // Scoped by businessId as well as id: an id from another tenant matches
    // nothing rather than matching somebody else's row.
    tx.inboundEmailAddress.updateMany({
      where: { id: addressId, businessId, status: "RETIRING" },
      data: { status: "REVOKED", revokedAt: now, graceUntil: null },
    })
  );
  if (updated.count === 0) return { ok: false, reason: "NOT_FOUND" };

  await logAuditEvent({
    businessId,
    eventType: "INBOUND_EMAIL_ADDRESS_REVOKED",
    entityType: "InboundEmailAddress",
    entityId: addressId,
    payload: { userId },
  });
  return { ok: true };
}

export type AddSenderResult =
  | { ok: true; senderId: number; status: InboundSenderView["status"]; created: boolean }
  | { ok: false; reason: "INVALID_EMAIL" };

/**
 * Record an address the owner is willing to accept forwarded mail from.
 *
 * It starts PENDING_VERIFICATION and nothing here can make it anything else.
 * Verification is a later increment; until it exists this state is the honest
 * answer, and a sender that arrived VERIFIED without proving anything would be
 * an authorisation granted to whoever typed the address.
 */
export async function addAuthorizedSender(
  businessId: number,
  rawEmail: string,
  userId: number
): Promise<AddSenderResult> {
  const email = normalizeEmail(String(rawEmail ?? ""));
  if (!isPlausibleEmail(email)) return { ok: false, reason: "INVALID_EMAIL" };

  const result = await tenantTx(businessId, async (tx) => {
    // A current identity already exists: return it rather than creating a
    // second. The unique index would refuse the insert anyway; answering
    // idempotently means a double-click is not an error the owner has to read.
    const current = await tx.inboundEmailAuthorizedSender.findFirst({
      where: { businessId, activeEmailKey: email },
      select: { id: true, status: true },
    });
    if (current) return { row: current, created: false };

    // Only revoked history exists, or nothing at all. Either way this is a NEW
    // identity that must verify again; the revoked row is left exactly as it is.
    const row = await tx.inboundEmailAuthorizedSender.create({
      data: {
        businessId,
        normalizedEmail: email,
        activeEmailKey: email,
        status: "PENDING_VERIFICATION",
        createdByUserId: userId,
      },
      select: { id: true, status: true },
    });
    return { row, created: true };
  });

  if (result.created) {
    await logAuditEvent({
      businessId,
      eventType: "INBOUND_EMAIL_SENDER_ADDED",
      entityType: "InboundEmailAuthorizedSender",
      entityId: result.row.id,
      payload: { userId },
    });
  }
  return {
    ok: true,
    senderId: result.row.id,
    status: result.row.status as InboundSenderView["status"],
    created: result.created,
  };
}

export type RevokeSenderResult = { ok: true } | { ok: false; reason: "NOT_FOUND" };

/**
 * Withdraw a sender's authorisation.
 *
 * The row stays, as history. Clearing `activeEmailKey` is what makes it stop
 * counting as the current identity — and what frees the address to be registered
 * again later, as a new row that has to verify. Nothing here ever flips a
 * revoked row back.
 */
export async function revokeAuthorizedSender(
  businessId: number,
  senderId: number,
  userId: number,
  now: Date = new Date()
): Promise<RevokeSenderResult> {
  const updated = await tenantTx(businessId, async (tx) =>
    tx.inboundEmailAuthorizedSender.updateMany({
      where: {
        id: senderId,
        businessId,
        status: { in: ["PENDING_VERIFICATION", "VERIFIED"] },
      },
      data: { status: "REVOKED", activeEmailKey: null, revokedAt: now },
    })
  );
  if (updated.count === 0) return { ok: false, reason: "NOT_FOUND" };

  await logAuditEvent({
    businessId,
    eventType: "INBOUND_EMAIL_SENDER_REVOKED",
    entityType: "InboundEmailAuthorizedSender",
    entityId: senderId,
    payload: { userId },
  });
  return { ok: true };
}

/**
 * Enough of an address to be worth storing, and no more.
 *
 * Not an RFC5322 parser and must not become one. It rejects what could never be
 * a mailbox so that a typo is caught at the boundary rather than becoming a row
 * nothing can ever match.
 */
function isPlausibleEmail(value: string): boolean {
  if (value.length === 0 || value.length > 320) return false;
  if (/[\u0000-\u001f\u007f-\u009f\s]/.test(value)) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@") || at === value.length - 1) return false;
  return value.slice(at + 1).includes(".");
}
