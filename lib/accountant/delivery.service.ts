/**
 * Sending the monthly package to the accountant — only after the owner's explicit approval of that
 * exact package version and that exact recipient (Option B, D2–D5). SERVER-ONLY.
 *
 * APPROVAL (approveDelivery) binds, and the database re-checks on insert:
 *   the period's CURRENT package (id, version, sha256) · the current data (a fresh fingerprint of the
 *   facts equals the package's — otherwise PACKAGE_OUTDATED) · the current recipient (version + email) ·
 *   D2: when the package has open items, the separate "send anyway" acknowledgement · one send in flight
 *   per period · an Idempotency-Key (a double click is one approval).
 *
 * SENDING (attemptDelivery) is its own tenant-scoped outbox: the delivery row is claimed (status +
 * lease, attempt fence), the email is rendered at send time (the link secret is derived, never stored),
 * and the existing provider layer sends it (Resend, `Idempotency-Key: acct:<id>`), with the existing
 * retry / expiry policy (24 h window — Resend's idempotency window). The approved object is the one the
 * link serves; nothing is ever rebuilt or re-chosen at send time.
 *
 * OUTCOMES (D5) are never inflated: ACCEPTED = the provider accepted the message; DELIVERED / BOUNCED
 * only from an authenticated provider webhook; a download is recorded as a download, never as "read".
 *
 * TWO SWITCHES: the business needs the feature flag, and the platform needs ACCOUNTANT_DELIVERY_ENABLED
 * = "true" (owner gate G4). With the second off, approvals are refused and nothing is ever sent.
 */

import { Prisma } from "@prisma/client";
import { tenantTx, type TenantTxClient } from "@/lib/tenant/tenant-tx";
import { readTransactionalEmailConfig, isValidAddress } from "@/lib/email/transactional/config";
import { decideFinalization, CLAIM_LEASE_MS } from "@/lib/email/transactional/delivery";
import type { EmailProvider } from "@/lib/email/transactional/provider";
import { createResendProvider } from "@/lib/email/transactional/resend";
import { AccountantError } from "./http";
import { buildAccountantLinkUrl, linkExpiry, mintAccountantLink } from "./link";
import { computeFingerprint } from "./package-scope";
import { loadPeriodFacts } from "./period-facts";
import { isPeriodKey, periodLabelHe, periodRange } from "./period";
import { renderAccountantPackageEmail } from "./email-template";
import { appendEvent, parseStoredReadiness, type WorkflowActor } from "./store";
import { derivePeriodStatus, IN_FLIGHT_DELIVERY, SUCCESSFUL_DELIVERY, type DeliveryStatus, type PeriodStatus } from "./workflow-status";

export const SEND_WINDOW_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_#-]{8,200}$/;

export function deliveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ACCOUNTANT_DELIVERY_ENABLED?.trim() === "true";
}

// ── Period status after a delivery change (one place, shared by every path) ────────────────────

export async function rederivePeriodStatus(tx: TenantTxClient, businessId: number, periodId: number, now: Date): Promise<PeriodStatus> {
  const period = await tx.accountantPeriod.findFirstOrThrow({ where: { id: periodId, businessId } });
  const pkg = period.latestPackageId
    ? await tx.accountantPackage.findFirst({ where: { id: period.latestPackageId, businessId } })
    : null;
  const latest = await tx.accountantDelivery.findFirst({
    where: { businessId, periodId, status: { not: "CANCELED" } },
    orderBy: { id: "desc" },
  });
  const readiness = parseStoredReadiness(period.readiness);
  const currentPackageReady = pkg?.status === "READY" && pkg.contentFingerprint === period.contentFingerprint;
  const status = derivePeriodStatus({
    readiness: readiness?.status ?? "NEEDS_ATTENTION",
    currentBuildFailed: period.status === "PREPARATION_FAILED" && !currentPackageReady,
    currentPackageReady,
    latestDelivery: latest ? { status: latest.status as DeliveryStatus } : null,
    completedManually: period.completionKind === "MANUAL",
  });

  const sent = latest && SUCCESSFUL_DELIVERY.has(latest.status as DeliveryStatus) ? latest : null;
  let completion: Prisma.AccountantPeriodUpdateInput = {};
  if (sent) {
    completion = {
      completedAt: period.completionKind === "DELIVERY" && period.completedPackageId === sent.packageId ? period.completedAt : now,
      completionKind: "DELIVERY",
      completedPackageId: sent.packageId,
    };
  } else if (period.completionKind === "DELIVERY") {
    // The send that completed the month bounced or failed: the month is open again.
    completion = { completedAt: null, completionKind: null, completedPackageId: null };
  }
  const sentPackageId = sent?.packageId ?? (period.completionKind === "MANUAL" ? period.completedPackageId : null);
  let changedSinceSent = false;
  if (sentPackageId !== null && sentPackageId !== undefined) {
    const sentPkg = await tx.accountantPackage.findFirst({ where: { id: sentPackageId, businessId }, select: { contentFingerprint: true } });
    changedSinceSent = !!sentPkg && sentPkg.contentFingerprint !== period.contentFingerprint;
  }
  await tx.accountantPeriod.update({
    where: { id: periodId },
    data: { status, changedSinceSent, ...completion, updatedAt: now },
  });
  return status;
}

// ── Approval ────────────────────────────────────────────────────────────────────────────────────

export type ApproveInput = {
  businessId: number;
  userId: number;
  periodKey: unknown;
  packageId: unknown;
  packageSha256: unknown;
  recipientVersion: unknown;
  recipientEmail: unknown;
  acknowledgeIncomplete: unknown;
  idempotencyKey: string | null;
  now: Date;
};

export type ApprovedDelivery = { deliveryId: number; created: boolean };

export async function approveDelivery(input: ApproveInput): Promise<ApprovedDelivery> {
  if (!deliveryEnabled()) throw new AccountantError(403, "DELIVERY_DISABLED");
  const email = readTransactionalEmailConfig();
  if (!email.enabled || !("ok" in email) || !email.ok) throw new AccountantError(503, "EMAIL_NOT_CONFIGURED");
  if (!input.idempotencyKey || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    throw new AccountantError(400, "IDEMPOTENCY_KEY_REQUIRED");
  }
  if (!isPeriodKey(input.periodKey)) throw new AccountantError(404, "NOT_FOUND");
  const packageId = Number(input.packageId);
  const recipientVersion = Number(input.recipientVersion);
  if (!Number.isInteger(packageId) || packageId < 1) throw new AccountantError(400, "INVALID_PACKAGE");
  if (typeof input.packageSha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.packageSha256)) {
    throw new AccountantError(400, "INVALID_PACKAGE");
  }
  if (!Number.isInteger(recipientVersion) || recipientVersion < 1) throw new AccountantError(400, "INVALID_RECIPIENT");
  if (typeof input.recipientEmail !== "string") throw new AccountantError(400, "INVALID_RECIPIENT");
  const periodKey = input.periodKey;
  const { businessId, userId, now } = input;

  // Same key again → the same approval (a double click, a retried request).
  const existing = await tenantTx(businessId, (tx) =>
    tx.accountantDelivery.findUnique({
      where: { businessId_idempotencyKey: { businessId, idempotencyKey: input.idempotencyKey! } },
      select: { id: true, packageId: true },
    })
  );
  if (existing) {
    if (existing.packageId !== packageId) throw new AccountantError(409, "IDEMPOTENCY_KEY_REUSED");
    return { deliveryId: existing.id, created: false };
  }

  // The data must still be exactly what the package holds — read fresh, not from the last evaluation.
  const fresh = computeFingerprint(await loadPeriodFacts(businessId, periodRange(periodKey)));

  try {
    return await tenantTx(businessId, async (tx) => {
      const period = await tx.accountantPeriod.findUnique({ where: { businessId_periodKey: { businessId, periodKey } } });
      if (!period) throw new AccountantError(404, "NOT_FOUND");
      // Serialise approvals of the period (and against the recipient change, which locks the recipient).
      await tx.$queryRaw`SELECT 1 FROM "AccountantPeriod" WHERE "id" = ${period.id} FOR UPDATE`;
      const pkg = await tx.accountantPackage.findFirst({ where: { id: packageId, businessId, periodId: period.id } });
      if (!pkg || pkg.status !== "READY" || period.latestPackageId !== pkg.id || pkg.sha256 !== input.packageSha256) {
        throw new AccountantError(409, "PACKAGE_OUTDATED");
      }
      if (pkg.contentFingerprint !== fresh) throw new AccountantError(409, "PACKAGE_OUTDATED", { reason: "data_changed" });

      const recipient = await tx.$queryRaw<Array<{ name: string; email: string; version: number }>>`
        SELECT "name", "email", "version" FROM "AccountantRecipient" WHERE "businessId" = ${businessId} FOR UPDATE`;
      const r = recipient[0];
      if (!r) throw new AccountantError(409, "RECIPIENT_MISSING");
      if (r.version !== recipientVersion || r.email !== (input.recipientEmail as string).trim().toLowerCase()) {
        throw new AccountantError(409, "RECIPIENT_CHANGED");
      }

      const openItems = pkg.openItemCount;
      const acknowledged = input.acknowledgeIncomplete === true;
      if (openItems > 0 && !acknowledged) {
        throw new AccountantError(409, "INCOMPLETE_NOT_ACKNOWLEDGED", { openItems });
      }

      const inFlight = await tx.accountantDelivery.findFirst({
        where: { businessId, periodId: period.id, status: { in: [...IN_FLIGHT_DELIVERY] } },
        select: { id: true },
      });
      if (inFlight) throw new AccountantError(409, "SEND_IN_PROGRESS");

      const link = mintAccountantLink();
      const created = await tx.accountantDelivery.create({
        data: {
          businessId,
          periodId: period.id,
          packageId: pkg.id,
          packageVersion: pkg.version,
          packageSha256: pkg.sha256!,
          recipientVersion: r.version,
          recipientName: r.name,
          recipientEmail: r.email,
          approvedByUserId: userId,
          approvedAt: now,
          incompleteAcknowledged: openItems > 0 && acknowledged,
          openItemCount: openItems,
          idempotencyKey: input.idempotencyKey!,
          status: "APPROVED",
          nextAttemptAt: now,
          linkPublicId: link.publicId,
          linkTokenHash: link.tokenHash,
          linkExpiresAt: linkExpiry(now),
          createdAt: now,
          updatedAt: now,
        },
        select: { id: true },
      });
      await appendEvent(tx, {
        businessId,
        periodId: period.id,
        packageId: pkg.id,
        deliveryId: created.id,
        eventType: "DELIVERY_APPROVED",
        actor: { type: "OWNER_USER", userId },
        occurredAt: now,
        // D2: the trail records that an incomplete package was knowingly approved.
        payload: { packageVersion: pkg.version, recipientVersion: r.version, openItems, incompleteAcknowledged: openItems > 0 && acknowledged },
        idempotencyKey: `approve:${created.id}`,
      });
      await rederivePeriodStatus(tx, businessId, period.id, now);
      return { deliveryId: created.id, created: true };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new AccountantError(409, "SEND_IN_PROGRESS");
    }
    throw e;
  }
}

// ── Sending ─────────────────────────────────────────────────────────────────────────────────────

export type AttemptOutcome = "disabled" | "not_configured" | "not_claimable" | "accepted" | "retry_scheduled" | "failed" | "lost_claim";

export type DeliveryDeps = {
  provider: (apiKey: string) => EmailProvider;
};

export const defaultDeliveryDeps: DeliveryDeps = {
  provider: (apiKey) => createResendProvider({ apiKey }),
};

/** Claims, sends and finalises one delivery. Safe to call concurrently; at most one caller sends. */
export async function attemptDelivery(
  businessId: number,
  deliveryId: number,
  now: Date,
  deps: DeliveryDeps = defaultDeliveryDeps
): Promise<AttemptOutcome> {
  if (!deliveryEnabled()) return "disabled";
  const cfg = readTransactionalEmailConfig();
  if (!cfg.enabled || !("ok" in cfg) || !cfg.ok) return "not_configured";

  // Claim: an APPROVED row whose attempt is due, or a SENDING row whose lease expired (a crashed send).
  const claimed = await tenantTx(businessId, async (tx) => {
    const n = await tx.accountantDelivery.updateMany({
      where: {
        id: deliveryId,
        businessId,
        recipientEmail: { not: null },
        OR: [
          { status: "APPROVED", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
          { status: "SENDING", leaseUntil: { lt: now } },
        ],
      },
      data: { status: "SENDING", attempts: { increment: 1 }, leaseUntil: new Date(now.getTime() + CLAIM_LEASE_MS), updatedAt: now },
    });
    if (n.count !== 1) return null;
    const d = await tx.accountantDelivery.findFirstOrThrow({ where: { id: deliveryId, businessId } });
    const period = await tx.accountantPeriod.findFirstOrThrow({ where: { id: d.periodId, businessId }, select: { periodKey: true } });
    const profile = await tx.businessProfile.findUnique({
      where: { businessId },
      select: { billingLegalName: true, billingEmail: true },
    });
    const business = await tx.business.findUnique({ where: { id: businessId }, select: { name: true } });
    await appendEvent(tx, {
      businessId,
      periodId: d.periodId,
      deliveryId: d.id,
      eventType: "DELIVERY_SENDING",
      actor: { type: "SYSTEM" },
      occurredAt: now,
      payload: { attempt: d.attempts },
      idempotencyKey: `sending:${d.id}:${d.attempts}`,
    });
    return { d, periodKey: period.periodKey, businessName: profile?.billingLegalName || business?.name || "", replyTo: profile?.billingEmail ?? null };
  });
  if (!claimed) return "not_claimable";
  const { d } = claimed;

  const expiresOn = d.linkExpiresAt.toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem" });
  const rendered = renderAccountantPackageEmail({
    businessName: claimed.businessName,
    recipientName: d.recipientName ?? "",
    periodLabel: periodLabelHe(claimed.periodKey),
    link: buildAccountantLinkUrl(cfg.config.appBaseUrl, d.linkPublicId),
    expiresOn,
    incomplete: d.incompleteAcknowledged,
  });
  const replyTo = claimed.replyTo && isValidAddress(claimed.replyTo) ? claimed.replyTo : cfg.config.replyTo;
  const startedMs = Date.now();
  const result = await deps.provider(cfg.config.apiKey).send({
    idempotencyKey: `acct:${d.id}`,
    from: cfg.config.from,
    replyTo,
    to: d.recipientEmail!,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });
  // The caller's clock plus the time the provider call actually took.
  const finishedAt = new Date(now.getTime() + Math.max(0, Date.now() - startedMs));
  const decision = decideFinalization(result, { attempts: d.attempts, expiresAt: new Date(d.approvedAt.getTime() + SEND_WINDOW_MS) }, finishedAt);

  return tenantTx(businessId, async (tx) => {
    // Fence: only the holder of THIS attempt may finalise it.
    const fence = { id: d.id, businessId, status: "SENDING", attempts: d.attempts };
    let n: Prisma.BatchPayload;
    let outcome: AttemptOutcome;
    let event: { type: "DELIVERY_ACCEPTED" | "DELIVERY_RETRY_SCHEDULED" | "DELIVERY_FAILED"; payload: Record<string, string | number | boolean | null> };
    if (decision.status === "SENT") {
      let messageId =
        decision.providerMessageId && /^[A-Za-z0-9_:.-]{1,128}$/.test(decision.providerMessageId) ? decision.providerMessageId : null;
      // The provider already accepted the message, so this update must not fail: a message id that another
      // delivery already holds (globally unique) would abort it and leave the row SENDING to be re-sent. The
      // ids-only lookup sees across businesses; on a clash the acceptance is kept without the id (webhook
      // events for it then cannot be matched — recorded as provider_id_conflict).
      let idConflict = false;
      if (messageId) {
        const holders = await tx.$queryRaw<Array<{ deliveryId: number }>>`
          SELECT "deliveryId" FROM public.accountant_delivery_by_provider_message(${"resend"}, ${messageId})`;
        if (holders.some((h) => h.deliveryId !== d.id)) {
          idConflict = true;
          messageId = null;
        }
      }
      n = await tx.accountantDelivery.updateMany({
        where: fence,
        data: {
          status: "ACCEPTED",
          acceptedAt: finishedAt,
          provider: "resend",
          providerMessageId: messageId,
          leaseUntil: null,
          failureCode: idConflict ? "provider_id_conflict" : null,
          updatedAt: finishedAt,
        },
      });
      outcome = "accepted";
      event = { type: "DELIVERY_ACCEPTED", payload: { attempt: d.attempts, providerIdConflict: idConflict } };
    } else if (decision.status === "PENDING") {
      n = await tx.accountantDelivery.updateMany({
        where: fence,
        data: { status: "APPROVED", nextAttemptAt: decision.nextAttemptAt, leaseUntil: null, failureCode: decision.code.slice(0, 64), updatedAt: finishedAt },
      });
      outcome = "retry_scheduled";
      event = { type: "DELIVERY_RETRY_SCHEDULED", payload: { attempt: d.attempts, code: decision.code.slice(0, 64) } };
    } else {
      n = await tx.accountantDelivery.updateMany({
        where: fence,
        data: { status: "FAILED", failedAt: finishedAt, leaseUntil: null, failureCode: decision.code.slice(0, 64), updatedAt: finishedAt },
      });
      outcome = "failed";
      event = { type: "DELIVERY_FAILED", payload: { attempt: d.attempts, code: decision.code.slice(0, 64) } };
    }
    if (n.count !== 1) return "lost_claim";
    await appendEvent(tx, {
      businessId,
      periodId: d.periodId,
      deliveryId: d.id,
      eventType: event.type,
      actor: { type: "PROVIDER" },
      occurredAt: finishedAt,
      payload: event.payload,
      idempotencyKey: `${event.type.toLowerCase()}:${d.id}:${d.attempts}`,
    });
    const status = await rederivePeriodStatus(tx, businessId, d.periodId, finishedAt);
    if (status === "SENT") {
      await appendEvent(tx, {
        businessId,
        periodId: d.periodId,
        deliveryId: d.id,
        eventType: "PERIOD_COMPLETED",
        actor: { type: "SYSTEM" },
        occurredAt: finishedAt,
        payload: { packageVersion: d.packageVersion },
        idempotencyKey: `completed:${d.periodId}:${d.id}`,
      });
    }
    return outcome;
  });
}

/** Sends whose attempt is due for one business (the sweep's retry path). Returns how many were tried. */
export async function processDueDeliveries(businessId: number, now: Date, deps: DeliveryDeps = defaultDeliveryDeps): Promise<number> {
  if (!deliveryEnabled()) return 0;
  const due = await tenantTx(businessId, (tx) =>
    tx.accountantDelivery.findMany({
      where: {
        businessId,
        OR: [
          { status: "APPROVED", nextAttemptAt: { lte: now } },
          { status: "SENDING", leaseUntil: { lt: now } },
        ],
      },
      orderBy: { id: "asc" },
      take: 5,
      select: { id: true },
    })
  );
  for (const d of due) await attemptDelivery(businessId, d.id, now, deps);
  return due.length;
}

// ── Provider events (authenticated webhook) ─────────────────────────────────────────────────────

export type ProviderEvent = "delivered" | "bounced";

/** Applies a provider outcome. Idempotent; a stale or out-of-order event is ignored, never an error. */
export async function applyProviderEvent(businessId: number, deliveryId: number, event: ProviderEvent, at: Date): Promise<boolean> {
  return tenantTx(businessId, async (tx) => {
    const d = await tx.accountantDelivery.findFirst({ where: { id: deliveryId, businessId } });
    if (!d) return false;
    const from = d.status as DeliveryStatus;
    const to: DeliveryStatus = event === "delivered" ? "DELIVERED" : "BOUNCED";
    const allowed = to === "DELIVERED" ? from === "ACCEPTED" : from === "ACCEPTED" || from === "DELIVERED";
    if (!allowed) return false;
    await tx.accountantDelivery.update({
      where: { id: d.id },
      data:
        to === "DELIVERED"
          ? { status: to, deliveredAt: at, updatedAt: at }
          : { status: to, failedAt: at, failureCode: "bounced", updatedAt: at },
    });
    await appendEvent(tx, {
      businessId,
      periodId: d.periodId,
      deliveryId: d.id,
      eventType: to === "DELIVERED" ? "DELIVERY_DELIVERED" : "DELIVERY_BOUNCED",
      actor: { type: "PROVIDER" },
      occurredAt: at,
      payload: {},
      idempotencyKey: `${to.toLowerCase()}:${d.id}`,
    });
    await rederivePeriodStatus(tx, businessId, d.periodId, at);
    return true;
  });
}

// ── Owner actions on a delivery ─────────────────────────────────────────────────────────────────

export async function revokeLink(businessId: number, userId: number, deliveryId: number, now: Date): Promise<void> {
  await tenantTx(businessId, async (tx) => {
    const d = await tx.accountantDelivery.findFirst({ where: { id: deliveryId, businessId } });
    if (!d) throw new AccountantError(404, "NOT_FOUND");
    if (d.linkRevokedAt) return;
    await tx.accountantDelivery.update({ where: { id: d.id }, data: { linkRevokedAt: now, updatedAt: now } });
    await appendEvent(tx, {
      businessId,
      periodId: d.periodId,
      deliveryId: d.id,
      eventType: "LINK_REVOKED",
      actor: { type: "OWNER_USER", userId },
      occurredAt: now,
      payload: {},
      idempotencyKey: `revoke:${d.id}`,
    });
  });
}

/** Withdraws an approval that has not started sending. */
export async function cancelDelivery(businessId: number, userId: number, deliveryId: number, now: Date): Promise<void> {
  await tenantTx(businessId, async (tx) => {
    const n = await tx.accountantDelivery.updateMany({
      where: { id: deliveryId, businessId, status: "APPROVED" },
      data: { status: "CANCELED", canceledAt: now, failureCode: "owner_canceled", linkRevokedAt: now, updatedAt: now },
    });
    if (n.count !== 1) throw new AccountantError(409, "NOT_CANCELABLE");
    const d = await tx.accountantDelivery.findFirstOrThrow({ where: { id: deliveryId, businessId }, select: { periodId: true } });
    await appendEvent(tx, {
      businessId,
      periodId: d.periodId,
      deliveryId,
      eventType: "DELIVERY_CANCELED",
      actor: { type: "OWNER_USER", userId },
      occurredAt: now,
      payload: { reason: "owner_canceled" },
      idempotencyKey: `cancel:${deliveryId}`,
    });
    await rederivePeriodStatus(tx, businessId, d.periodId, now);
  });
}

/** "I sent it myself" — owner-reported completion, labelled as such, for a specific package version. */
export async function completeManually(
  businessId: number,
  userId: number,
  periodKey: string,
  packageId: number,
  now: Date
): Promise<void> {
  await tenantTx(businessId, async (tx) => {
    const period = await tx.accountantPeriod.findUnique({ where: { businessId_periodKey: { businessId, periodKey } } });
    if (!period) throw new AccountantError(404, "NOT_FOUND");
    const pkg = await tx.accountantPackage.findFirst({ where: { id: packageId, businessId, periodId: period.id, status: { in: ["READY", "SUPERSEDED"] } } });
    if (!pkg) throw new AccountantError(409, "PACKAGE_OUTDATED");
    const inFlight = await tx.accountantDelivery.findFirst({ where: { businessId, periodId: period.id, status: { in: [...IN_FLIGHT_DELIVERY] } } });
    if (inFlight) throw new AccountantError(409, "SEND_IN_PROGRESS");
    await tx.accountantPeriod.update({
      where: { id: period.id },
      data: { completedAt: now, completionKind: "MANUAL", completedPackageId: pkg.id, updatedAt: now },
    });
    await appendEvent(tx, {
      businessId,
      periodId: period.id,
      packageId: pkg.id,
      eventType: "PERIOD_COMPLETED_MANUALLY",
      actor: { type: "OWNER_USER", userId },
      occurredAt: now,
      payload: { packageVersion: pkg.version },
      idempotencyKey: `manual:${period.id}:${pkg.id}`,
    });
    await rederivePeriodStatus(tx, businessId, period.id, now);
  });
}

// ── The accountant opens the link ───────────────────────────────────────────────────────────────

export type LinkOpen =
  | { ok: true; storageKey: string; periodKey: string; packageVersion: number; businessName: string; expiresAt: Date }
  | { ok: false; reason: "expired" | "revoked" | "unavailable" };

/**
 * Called with a (businessId, deliveryId) the SECURITY DEFINER lookup resolved from the public id AND the
 * hash of the secret; everything below reads under RLS in that business. `record` = a download (counted
 * and logged) versus a look at the page (nothing written).
 */
export async function openLink(businessId: number, deliveryId: number, now: Date, record: boolean): Promise<LinkOpen> {
  return tenantTx(businessId, async (tx) => {
    const d = await tx.accountantDelivery.findFirst({ where: { id: deliveryId, businessId } });
    if (!d) return { ok: false, reason: "unavailable" };
    const refuse = async (reason: "expired" | "revoked" | "unavailable"): Promise<LinkOpen> => {
      if (record) {
        await appendEvent(tx, {
          businessId,
          periodId: d.periodId,
          deliveryId: d.id,
          eventType: "LINK_REFUSED",
          actor: { type: "RECIPIENT" },
          occurredAt: now,
          payload: { reason },
          idempotencyKey: `refused:${d.id}:${now.getTime()}`,
        });
      }
      return { ok: false, reason };
    };
    if (d.linkRevokedAt) return refuse("revoked");
    if (d.linkExpiresAt.getTime() <= now.getTime()) return refuse("expired");
    // Only a message the provider accepted has a link anyone was given.
    if (!SUCCESSFUL_DELIVERY.has(d.status as DeliveryStatus)) return refuse("unavailable");
    const pkg = await tx.accountantPackage.findFirst({
      where: { id: d.packageId, businessId, status: { in: ["READY", "SUPERSEDED"] } },
      select: { storageKey: true, sha256: true, version: true },
    });
    if (!pkg?.storageKey || pkg.sha256 !== d.packageSha256) return refuse("unavailable");
    const period = await tx.accountantPeriod.findFirstOrThrow({ where: { id: d.periodId, businessId }, select: { periodKey: true } });
    const profile = await tx.businessProfile.findUnique({ where: { businessId }, select: { billingLegalName: true } });
    const business = await tx.business.findUnique({ where: { id: businessId }, select: { name: true } });
    if (record) {
      await tx.accountantDelivery.update({
        where: { id: d.id },
        data: {
          downloadCount: { increment: 1 },
          firstDownloadedAt: d.firstDownloadedAt ?? now,
          lastDownloadedAt: now,
          updatedAt: now,
        },
      });
      await appendEvent(tx, {
        businessId,
        periodId: d.periodId,
        deliveryId: d.id,
        eventType: "LINK_DOWNLOADED",
        actor: { type: "RECIPIENT" },
        occurredAt: now,
        payload: { downloadNumber: d.downloadCount + 1 },
        idempotencyKey: `download:${d.id}:${d.downloadCount + 1}`,
      });
    }
    return {
      ok: true,
      storageKey: pkg.storageKey,
      periodKey: period.periodKey,
      packageVersion: pkg.version,
      businessName: profile?.billingLegalName || business?.name || "",
      expiresAt: d.linkExpiresAt,
    };
  });
}

export type { WorkflowActor };
