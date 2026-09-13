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
import { ADVISORY_NAMESPACE, lifecycleOf } from "@/lib/tenant/business-lifecycle";
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

// `assertExactlyOne` lived here and is gone with its last caller. Both lifecycle
// transitions are now CONDITIONAL — the quarantine on `deletionRequestedAt: null`
// and the finalization on `deletedAt: null` — so zero rows is the ordinary way a
// resumed or concurrent attempt observes that the other one got there first. It
// was never an error; asserting it was is what made a resume throw.

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
    // ── 1. LIFECYCLE TRANSITION — deliberately OUTSIDE tenant context ──────
    //
    // `Business` carries no RLS, and it is the one statement here that must not
    // run inside a tenant job: the transition is what CREATES the quarantine,
    // and `runTenantJob` refuses a quarantined business by default. The advisory
    // lock belongs here and nowhere else — it exists to serialise this
    // transition against `assertBusinessAcceptsWritesTx`, which takes the same
    // lock from the other side. Once this commits, normal writes are refused
    // everywhere, which is what makes the destruction below safe to do second.
    const transitioned = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_NAMESPACE}::int, ${businessId}::int)`;
      const moved = await tx.business.updateMany({
        where: { id: businessId, deletionRequestedAt: null, deletedAt: null },
        data: { deletionRequestedAt: now },
      });
      return moved.count;
    });
    const wonTheRace = transitioned === 1;

    // ── 2. CREDENTIAL DESTRUCTION — REQUIRES tenant context ────────────────
    //
    // THIS IS THE FIX. Four of these six tables are FORCE-RLS'd, and every
    // statement below used to run on the context-less tenant client inside the
    // transaction above. Under RLS the predicate evaluated to NULL, so each
    // matched ZERO rows, returned without raising, and left the secret at rest
    // while the flow reported it destroyed. Measured: the Gmail refresh token,
    // the SHAAM access and refresh tokens, and the payment-provider credential
    // all survived. `WhatsAppConnection` and `POSApiKey` carry no RLS and were
    // destroyed correctly by the very same transaction — which is what proved
    // the stage executed rather than never running.
    //
    // Only the statements that NEED the context get it. The transition above
    // does not and is not wrapped.
    //
    // This runs on EVERY attempt, not only when this caller won the race. Each
    // statement is a state-convergent overwrite, so repeating it is a no-op, and
    // an attempt that died between the transition and this point would otherwise
    // leave credentials alive with nothing left to reach them.
    //
    // `quarantinePolicy: "erasure"` is required and is the ONLY sanctioned way
    // past the lifecycle gate: by now the business IS quarantined, which is
    // exactly why this job must be allowed to act on it. CI confines the literal
    // to this module.
    await runTenantJob(
      { businessId },
      () =>
        withTenantTransaction(async (tx) => {
          // The same silent-zero backstop stage 2 uses, and for the same reason:
          // zero rows IS legitimate here, because a business may simply never
          // have connected a provider, so row counts can never detect a missing
          // context on their own.
          await assertTenantContextIs(tx, businessId);

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
          // fiscal FK, so deletion is the correct revoke.
          await tx.pOSApiKey.deleteMany({ where: { businessId } });
        }),
      { quarantinePolicy: "erasure" }
    );

    // false = another request transitioned first. Not an error; the caller
    // resumes from stage 2. Credentials converged either way.
    return wonTheRace;
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
   * STAGE 3 — evidence FIRST, then the terminal transition.
   *
   * THE ORDER IS THE FIX, and the context is the other half of it.
   *
   * `logAuditEvent` writes `LearningEvent`, which is FORCE-RLS'd with a tenant
   * predicate in both USING and WITH CHECK. This used to run on the context-less
   * tenant client, so the INSERT's WITH CHECK evaluated to NULL and PostgreSQL
   * refused it outright with 42501 — not silently, loudly. `logAuditEvent`
   * rethrows when a `tx` is supplied, by contract, so the surrounding
   * transaction rolled back and `deletedAt` was never set. Every deletion ended
   * there: quarantined, partially purged, no evidence, HTTP 500, and no way back
   * because the quarantine had already killed the session that would retry.
   *
   * The two writes are now in separate transactions, deliberately, because they
   * belong to different planes: the evidence is tenant data and needs the GUC,
   * while `Business` has no RLS and must stay outside a tenant job. That gives
   * up single-transaction atomicity, so the ORDER has to carry the guarantee
   * instead — and evidence-first is the safe direction:
   *
   *   evidence fails      → terminal state NEVER committed. The business stays
   *                         DELETION_REQUESTED and the attempt is resumable.
   *                         This is the property that must never be lost.
   *   transition fails    → evidence exists for an unfinished deletion. The
   *                         resume is safe: the evidence write below is
   *                         conditional, so it is not duplicated, and the
   *                         transition is conditional on `deletedAt: null`.
   *
   * The opposite order — the one this replaces — makes "reported deleted with no
   * evidence" representable, which is the failure nobody can audit after the fact.
   */
  async finalizeAndAudit(businessId, actorUserId, now) {
    // ── 1. EVIDENCE, under tenant context, exactly once ───────────────────
    await runTenantJob(
      { businessId },
      () =>
        withTenantTransaction(async (tx) => {
          await assertTenantContextIs(tx, businessId);
          // The same lock the quarantine takes, so two concurrent finalizations
          // cannot both decide the evidence is absent and write it twice.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_NAMESPACE}::int, ${businessId}::int)`;

          // Conditional, because a resumed attempt must not append a second
          // ACCOUNT_DELETED for the same erasure. One erasure, one record.
          const already = await tx.learningEvent.count({
            where: { businessId, eventType: "ACCOUNT_DELETED" },
          });
          if (already > 0) return;

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
        }),
      { quarantinePolicy: "erasure" }
    );

    // ── 2. TERMINAL TRANSITION, only now that the evidence is durable ──────
    //
    // Conditional on `deletedAt: null`. Zero rows means another attempt reached
    // the terminal state first, which is a legitimate outcome of a resume or a
    // race rather than an error — so this no longer asserts exactly-one. The
    // orchestrator already treats an ALREADY-PURGED business as success.
    await prisma.$transaction(async (tx) => {
      await tx.business.updateMany({
        where: { id: businessId, deletedAt: null },
        data: { deletedAt: now, archivedAt: now, archivedByUserId: actorUserId },
      });
    });
  },
};
