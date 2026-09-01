/**
 * Prisma adapter for account deletion. Executes the ratified erasure manifest.
 * SERVER-ONLY.
 *
 * D2/AD-2A — what changed and why it matters:
 *
 *  1. TENANT CONTEXT. The purge now runs inside `runTenantJob` +
 *     `withTenantTransaction`, so the transaction-local `app.current_business_id`
 *     GUC is set. Before this, every operation ran on the context-less global client
 *     and relied solely on its own `where: { businessId }`. Under FORCE RLS that
 *     predicate is ANDed with a policy that evaluates to NULL, so every statement
 *     would have matched ZERO rows — silently — while the flow still reported the
 *     account deleted. `where: { businessId }` is kept as defence in depth; it is no
 *     longer the only thing standing between a user's erasure request and nothing
 *     happening at all.
 *
 *  2. SILENT-ZERO. Row counts alone cannot detect that failure: a healthy business
 *     may legitimately have zero conversations. So the purge first PROVES the context
 *     is live (`assertTenantContextIs`) and only then runs the manifest. The two
 *     lifecycle transitions, which are never legitimately zero in their own branch,
 *     additionally assert exactly-one.
 *
 *  3. ORDER. Quarantine + credential destruction commit FIRST, in one transaction,
 *     before anything destructive. See the orchestrator for why.
 *
 * The erasure job is the ONE caller allowed past the quarantine gate in
 * `runTenantJob` — it must be able to act on a business precisely because that
 * business is being erased. Every other caller is refused.
 *
 * Integration credentials are CLEARED IN PLACE (not row-deleted) to avoid FK
 * landmines with retained fiscal rows; required non-null cipher fields are blanked to
 * "" (ciphertext gone). Provider-side revoke is a separate best-effort concern
 * (documented in the design doc); here we guarantee the at-rest secret is destroyed.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/services/audit.service";
import { runTenantJob } from "@/lib/tenant/job";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { lifecycleOf } from "@/lib/tenant/business-lifecycle";
import type {
  AccountDeletionStore,
  BusinessDeletionState,
} from "@/lib/services/account/account-deletion.service";

/** Raised when the erasure could not prove it was operating on the intended tenant. */
export class ErasureExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErasureExecutionError";
  }
}

/**
 * Prove the tenant GUC is live and points at the business we intend to erase.
 *
 * This is the silent-zero backstop. Without it a missing or wrong context produces a
 * long, entirely successful-looking sequence of zero-row statements. Row counts
 * cannot substitute for it, because zero is a legitimate outcome for most of the
 * manifest — a business may simply have no CRM notes.
 */
async function assertTenantContextIs(
  tx: Prisma.TransactionClient,
  businessId: number
): Promise<void> {
  const rows = await tx.$queryRaw<{ guc: string | null }[]>`
    SELECT NULLIF(current_setting('app.current_business_id', true), '') AS guc
  `;
  const guc = rows[0]?.guc ?? null;
  if (guc === null) {
    throw new ErasureExecutionError(
      "erasure aborted: no tenant context — every statement would have matched zero rows under RLS"
    );
  }
  if (Number(guc) !== businessId) {
    throw new ErasureExecutionError(
      `erasure aborted: tenant context is ${guc}, expected ${businessId}`
    );
  }
}

function assertExactlyOne(count: number, operation: string): void {
  if (count !== 1) {
    throw new ErasureExecutionError(
      `erasure ${operation} affected ${count} rows, expected exactly 1`
    );
  }
}

function assertAtLeastOne(count: number, operation: string): void {
  if (count < 1) {
    throw new ErasureExecutionError(
      `erasure ${operation} affected 0 rows, expected at least 1`
    );
  }
}

export const prismaAccountDeletionStore: AccountDeletionStore = {
  async getBusiness(businessId) {
    const b = await prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, deletionRequestedAt: true, deletedAt: true },
    });
    if (!b) {
      return null;
    }
    return { id: b.id, state: lifecycleOf(b) as BusinessDeletionState };
  },

  async listActiveUserIds(businessId) {
    const users = await prisma.user.findMany({
      where: { businessId },
      select: { id: true },
    });
    return users.map((u) => u.id);
  },

  /**
   * STAGE 1 — quarantine + credential destruction, atomically.
   *
   * The transition is a CONDITIONAL update (`deletionRequestedAt: null`), which makes
   * two concurrent deletion requests safe without an application-level lock: exactly
   * one of them updates a row, the other sees 0 and reports that it lost the race.
   * Row locking against in-flight normal writes is provided by
   * `assertBusinessAcceptsWritesTx`, which locks the same row from the other side.
   *
   * NO NETWORK CALL lives in this transaction. Provider-side revocation is a separate,
   * best-effort concern; what commits here is the destruction of the secret at rest,
   * which is what actually stops the integration from being usable.
   */
  async quarantineAndRevokeIntegrations(businessId, now) {
    return prisma.$transaction(async (tx) => {
      const transitioned = await tx.business.updateMany({
        where: { id: businessId, deletionRequestedAt: null, deletedAt: null },
        data: { deletionRequestedAt: now },
      });
      if (transitioned.count === 0) {
        // Another request already quarantined this business. Not an error — the
        // caller resumes from stage 2.
        return false;
      }
      assertExactlyOne(transitioned.count, "quarantine transition");

      // Bucket C — destroy at-rest credentials. Zero rows is legitimate here: a
      // business may simply never have connected a given provider.
      await tx.billingAuthorityConnection.updateMany({
        where: { businessId },
        data: {
          accessTokenEncrypted: null, accessTokenIv: null, accessTokenTag: null,
          refreshTokenEncrypted: null, refreshTokenIv: null, refreshTokenTag: null,
          revokedAt: now,
        },
      });
      await tx.businessPaymentConnection.updateMany({
        where: { businessId },
        data: { credentialEncrypted: null, credentialIv: null, credentialTag: null, isActive: false },
      });
      await tx.whatsAppConnection.updateMany({
        where: { businessId },
        data: { accessTokenEncrypted: "", accessTokenIv: "", accessTokenTag: "", status: "REVOKED_BY_META" },
      });
      await tx.emailConnection.updateMany({
        where: { businessId },
        data: { status: "revoked", lastSyncCursor: null },
      });
      // OAuthTokens hang off EmailConnection; delete via the relation (no fiscal FK).
      await tx.oAuthToken.deleteMany({ where: { connection: { businessId } } });
      // POS keys: DELETE the rows. keyHash is globally @unique, so blanking it to a
      // constant would collide across multiple account deletions; the row carries no
      // fiscal FK, so deletion is the correct revoke. (AD-2A recon flagged that the
      // restricted runtime holds no DELETE here — see the closure report's residue
      // section; nothing about that privilege is changed by this wave.)
      await tx.pOSApiKey.deleteMany({ where: { businessId } });

      return true;
    });
  },

  /**
   * STAGE 2 — anonymize + purge operational PII, under an explicit tenant context.
   *
   * `quarantinePolicy: "erasure"` is the single sanctioned way past the lifecycle gate
   * in `runTenantJob`: this job must act on a business precisely because that business
   * is quarantined. CI restricts the value to this module.
   */
  async purgeOperationalData(businessId) {
    await runTenantJob(
      { businessId },
      () =>
        withTenantTransaction(async (tx) => {
          await assertTenantContextIs(tx, businessId);

          // B.1 anonymize (rows kept — required by fiscal FKs / referential integrity).
          // A business always has at least one user, so zero here means the statement
          // did not reach the rows it was supposed to reach.
          const users = await tx.user.updateMany({
            where: { businessId },
            data: {
              email: `deleted-biz-${businessId}@deleted.invalid`,
              name: null,
              password: "",
            },
          });
          assertAtLeastOne(users.count, "user anonymization");

          // Zero is legitimate for everything below: a business may have no profile
          // row, no customers, no leads, no CRM content and no conversations.
          await tx.businessProfile.updateMany({
            where: { businessId },
            data: {
              billingLegalName: null, billingTaxId: null, billingVatNumber: null,
              billingPhone: null, billingEmail: null, billingAddress: null,
              city: null, latitude: null, longitude: null, openingHours: null,
              billingLogoDataUrl: null, billingSignatureDataUrl: null,
            },
          });
          // Customers anonymized (NOT deleted) — issued invoices reference customerId;
          // the invoice's frozen customerNameSnapshot preserves the legal record.
          await tx.customer.updateMany({
            where: { businessId },
            data: { name: "לקוח שנמחק", phone: null, email: null, city: null, legalName: null, taxId: null, notes: null },
          });
          await tx.lead.updateMany({
            where: { businessId },
            data: { customerName: null, phone: null },
          });

          // B.2 delete pure communications PII (Conversation cascades Message/analysis).
          await tx.crmAttachment.deleteMany({ where: { businessId } });
          await tx.crmNote.deleteMany({ where: { businessId } });
          await tx.conversation.deleteMany({ where: { businessId } });
        }),
      { quarantinePolicy: "erasure" }
    );
  },

  /**
   * STAGE 3 — finalize + evidence, atomically.
   *
   * The audit is written with the transaction, which makes `logAuditEvent` RETHROW
   * instead of swallowing (its documented contract). A deletion that reports success
   * without durable evidence of the erasure is worse than one that fails and is
   * retried, so the transition and the evidence commit together or not at all.
   */
  async finalizeAndAudit(businessId, actorUserId, now) {
    await prisma.$transaction(async (tx) => {
      const finalized = await tx.business.updateMany({
        where: { id: businessId, deletedAt: null },
        data: { deletedAt: now, archivedAt: now, archivedByUserId: actorUserId },
      });
      assertExactlyOne(finalized.count, "purge finalization");

      await logAuditEvent(
        {
          businessId,
          eventType: "ACCOUNT_DELETED",
          entityType: "BUSINESS",
          entityId: businessId,
          payload: {
            actorUserId,
            at: now.toISOString(),
            categories: ["user_identity", "business_profile_pii", "customers", "leads", "conversations", "crm", "integrations"],
            retained: ["fiscal_documents", "financial_records", "billing_audit", "governance"],
          },
        },
        { tx }
      );
    });
  },
};
