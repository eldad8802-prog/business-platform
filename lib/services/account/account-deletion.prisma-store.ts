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
 *  3. ORDER. The quarantine commits FIRST, before anything destructive. SEC-E split
 *     credential destruction out of it: the provider-side revoke needs the plaintext
 *     token, so the order is now quarantine -> revoke authority (sessions) -> purge ->
 *     provider revoke -> destroy credentials -> verify -> finalize, each a durable,
 *     retryable stage of lib/services/account/erasure-job.ts.
 *
 * The erasure job is the ONE caller allowed past the quarantine gate in
 * `runTenantJob` — it must be able to act on a business precisely because that
 * business is being erased. Every other caller is refused.
 *
 * Integration credentials are CLEARED IN PLACE (not row-deleted) to avoid FK
 * landmines with retained fiscal rows; required non-null cipher fields are blanked to
 * "" (ciphertext gone). The provider-side revoke is performed by the erasure job from
 * `readProviderGrants` and its outcome recorded truthfully (REVOKED /
 * REVOKE_FAILED_LOCAL_DELETED / NOT_SUPPORTED); this adapter guarantees the at-rest
 * secret is destroyed.
 */
// `Prisma` is a VALUE import, not a type-only one: clearing a nullable Json
// column needs `Prisma.DbNull`, because a plain `null` there means "JSON null"
// rather than "no value".
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/services/audit.service";
// S8: the object deleter the CRM product already uses. One implementation, not two.
import { deleteAttachmentObject } from "@/lib/services/crm/crm-attachment-storage";
import { deletePublicAssetsOfBusiness } from "@/lib/services/storage/public-asset-storage.service";
import { getStorageService } from "@/lib/storage";
import {
  countSessionsOfBusinessUsers,
  eraseSessionsOfBusinessUsers,
  revokeAuthorityOfBusinessUsers,
} from "@/lib/auth/session-directory";
import { decryptTokenForRevocation } from "@/lib/services/integrations/gmail/token-crypto.placeholder";
import { decryptAccessToken } from "@/lib/services/integrations/whatsapp/token-crypto.service";
import { runTenantJob } from "@/lib/tenant/job";
import { prismaErasureLedger } from "@/lib/services/account/erasure-ledger.prisma";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { ADVISORY_NAMESPACE, lifecycleOf } from "@/lib/tenant/business-lifecycle";
import type {
  AccountDeletionStore,
  BusinessDeletionState,
  ProviderGrant,
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
  /** SEC-E / H-5 — the durable record of every erasure attempt (erasure-ledger.prisma.ts). */
  ledger: prismaErasureLedger,

  /**
   * SEC-E / H-5 — the sweeper's work list: every business whose erasure is owed
   * (quarantined) and not finished, oldest request first. `Business` carries no RLS; the
   * runtime reads only the lifecycle columns it is granted. The list is a SCHEDULE, never
   * authority: the job re-reads each business and refuses one that is not quarantined.
   */
  async listStrandedErasures(limit) {
    const rows = await prisma.business.findMany({
      where: { deletionRequestedAt: { not: null }, deletedAt: null },
      select: { id: true },
      orderBy: { deletionRequestedAt: "asc" },
      take: Math.max(1, Math.min(limit, 500)),
    });
    return rows.map((r) => r.id);
  },

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
   * STAGE 1 — QUARANTINE. The lifecycle transition, and only that.
   *
   * SEC-E: the name predates the split and is kept because CI-AD-3 anchors the
   * quarantine-before-purge ordering on it. It used to destroy the integration
   * credentials in the same call, which made a provider-side revoke impossible: the
   * plaintext token a revoke needs was gone before anything could send it. Revocation is
   * now durable, retryable stages the erasure job (erasure-job.ts) runs AFTER this
   * commits: `readProviderGrants` -> provider revoke (recorded truthfully in the ledger)
   * -> `destroyIntegrationCredentials`. Quarantine-first is unchanged: once this commits,
   * no normal write can commit anywhere (sessions, runTenantJob, and every tenant
   * transaction via withTenantTransaction), so credentials still at rest until their
   * stage runs are unusable by the product.
   *
   * The transition is CONDITIONAL (`deletionRequestedAt: null`), so two concurrent
   * requests cannot both believe they started the deletion. It takes the lifecycle
   * advisory key EXCLUSIVE; every tenant transaction holds it SHARED, so the transition
   * waits for in-flight writers to finish and every later one observes the quarantine.
   *
   * NO NETWORK CALL lives here.
   */
  async quarantineAndRevokeIntegrations(businessId, now) {
    // `Business` carries no RLS, and this is the one statement that must not run inside
    // a tenant job: the transition is what CREATES the quarantine.
    const transitioned = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_NAMESPACE}::int, ${businessId}::int)`;
      const moved = await tx.business.updateMany({
        where: { id: businessId, deletionRequestedAt: null, deletedAt: null },
        data: { deletionRequestedAt: now },
      });
      return moved.count;
    });
    // false = another request transitioned first. Not an error; the job resumes.
    return transitioned === 1;
  },

  /**
   * SEC-E / M-12(b) — the plaintext grants a provider-side revoke needs, read BEFORE
   * `destroyIntegrationCredentials` destroys them. Returned to the erasure job, which
   * calls the providers OUTSIDE any transaction and records every outcome.
   *
   * A grant whose ciphertext is already gone or cannot be decrypted is reported with
   * `token: null`, and the job records it REVOKE_FAILED_LOCAL_DELETED, never REVOKED.
   * Read-only; nothing here writes.
   */
  async readProviderGrants(businessId) {
    return runTenantJob(
      { businessId },
      () =>
        withTenantTransaction(async (tx) => {
          await assertTenantContextIs(tx, businessId);
          const grants: ProviderGrant[] = [];
          const gmail = await tx.emailConnection.findMany({
            where: { businessId },
            select: {
              id: true,
              token: { select: { accessTokenEncrypted: true, refreshTokenEncrypted: true } },
            },
          });
          for (const c of gmail) {
            if (!c.token) continue;
            // Prefer the refresh token: Google revokes the whole grant from either. The
            // revocation-only decoder (workstream D, L-17) binds the row context and also
            // reads a quarantined legacy blob: revoking it is the one use it still has.
            const ctx = { businessId, connectionId: c.id };
            const token =
              decryptTokenForRevocation(c.token.refreshTokenEncrypted, { ...ctx, field: "refresh" }) ??
              decryptTokenForRevocation(c.token.accessTokenEncrypted, { ...ctx, field: "access" });
            grants.push({ provider: "google", action: "oauth_token_revoke", connectionId: c.id, token, wabaId: null });
          }
          const wa = await tx.whatsAppConnection.findMany({
            where: { businessId },
            select: { id: true, wabaId: true, accessTokenEncrypted: true, accessTokenIv: true, accessTokenTag: true },
          });
          for (const c of wa) {
            if (!c.accessTokenEncrypted) continue;
            const token = decryptAccessToken(
              { encrypted: c.accessTokenEncrypted, iv: c.accessTokenIv, tag: c.accessTokenTag },
              businessId
            );
            grants.push({ provider: "meta", action: "waba_unsubscribe", connectionId: c.id, token, wabaId: c.wabaId || null });
          }
          // ITA and the payment providers: no provider-side revoke API exists in this
          // codebase for either, so the grant is listed only so its outcome is RECORDED
          // (NOT_SUPPORTED) instead of silently implied.
          const ita = await tx.billingAuthorityConnection.findMany({
            where: {
              businessId,
              OR: [{ accessTokenEncrypted: { not: null } }, { refreshTokenEncrypted: { not: null } }],
            },
            select: { id: true },
          });
          for (const c of ita) {
            grants.push({ provider: "ita", action: "oauth_token_revoke", connectionId: c.id, token: null, wabaId: null });
          }
          const pay = await tx.businessPaymentConnection.findMany({
            where: { businessId, credentialEncrypted: { not: null } },
            select: { id: true },
          });
          for (const c of pay) {
            grants.push({ provider: "payment", action: "credential_revoke", connectionId: c.id, token: null, wabaId: null });
          }
          return grants;
        }),
      { quarantinePolicy: "erasure" }
    );
  },

  /**
   * STAGE — CREDENTIAL + IDENTIFIER DESTRUCTION, under an explicit tenant context.
   *
   * Runs only after the provider-revoke stage has an outcome for every grant (the job
   * enforces that order). Four of these tables are FORCE-RLS'd; without the tenant GUC
   * every statement here matched ZERO rows, silently (Defect A).
   *
   * SEC-E / M-13 + L-18: the connection IDENTIFIERS go too, not only the secrets. A
   * WhatsApp number stayed bound to the deleted business forever (`phoneNumberId` is
   * globally @unique, so the number could never be connected to another Dubiz account),
   * and the Gmail address, Google account id, granted scopes and the last provider error
   * text all survived. `phoneNumberId` and `emailAddress` are NOT NULL and unique, so
   * they get a tombstone that cannot collide; the rest is cleared.
   *
   * Every statement is a state-convergent overwrite, so a retry is a no-op.
   */
  async destroyIntegrationCredentials(businessId, now) {
    await runTenantJob(
      { businessId },
      () =>
        withTenantTransaction(async (tx) => {
          // Zero rows IS legitimate here (a business may never have connected a
          // provider), so row counts can never detect a missing context on their own.
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
          // `businessId` is @unique on this table (one connection per business), so a
          // tombstone derived from it is unique by construction, and the real number is
          // released for reconnection anywhere (L-18).
          await tx.whatsAppConnection.updateMany({
            where: { businessId },
            data: {
              accessTokenEncrypted: "", accessTokenIv: "", accessTokenTag: "", status: "REVOKED_BY_META",
              phoneNumberId: `erased-${businessId}`,
              displayPhoneNumber: "",
              wabaId: "",
              lastErrorMessage: null,
              lastErrorCode: null,
              lastErrorAt: null,
            },
          });
          await tx.emailConnection.updateMany({
            where: { businessId },
            data: { status: "revoked", lastSyncCursor: null, lastError: null, providerAccountId: "", scopes: "" },
          });
          // `emailAddress` is NOT NULL and unique per (business, provider), so it is
          // rewritten per row with a tombstone derived from the row's own id:
          // deterministic across retries, and incapable of colliding with a sibling.
          const connections = await tx.emailConnection.findMany({
            where: { businessId },
            select: { id: true },
          });
          for (const { id } of connections) {
            await tx.emailConnection.updateMany({
              where: { businessId, id },
              data: { emailAddress: `erased-${id}@deleted.invalid` },
            });
          }
          // OAuthTokens hang off EmailConnection; delete via the relation (no fiscal FK).
          await tx.oAuthToken.deleteMany({ where: { connection: { businessId } } });
          // POS keys: DELETE the rows. keyHash is globally @unique, so blanking it to a
          // constant would collide across multiple account deletions; the row carries no
          // fiscal FK, so deletion is the correct revoke.
          await tx.pOSApiKey.deleteMany({ where: { businessId } });
        }),
      { quarantinePolicy: "erasure" }
    );
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
      async () => {
        // ── S8. THE OBJECTS GO FIRST, AND OUTSIDE THE TRANSACTION ─────────────
        //
        // CRM attachment bytes live in object storage. The row is the only place
        // their `storageKey` exists — `@@unique([businessId, storageKey])`, and no
        // other model carries it. The erasure used to delete the row inside the
        // transaction below and never touch storage, so the object survived the
        // account deletion AND the only pointer to it was destroyed in the same
        // statement. The storage service has no listing operation, so after that
        // nothing in this application could find those bytes again.
        //
        // Deleting an object is a network call and is NOT transactional with
        // PostgreSQL. Pretending otherwise would be the lie; the ORDER is what makes
        // it safe instead:
        //
        //   object delete FAILS       → this throws, the transaction below never
        //                               runs, row and key survive, stage 2 fails and
        //                               the deletion does not report success. Retry.
        //   object ok, row delete FAILS → the object is gone and the row survives
        //                               with its key; the retry deletes an object
        //                               that is already absent, which both adapters
        //                               treat as success (local unlink swallows
        //                               ENOENT; an S3 DELETE of a missing key
        //                               succeeds). The second run converges.
        //
        // Reading the keys needs the tenant context `runTenantJob` has established,
        // so the read runs in its own short transaction before any object is touched.
        const attachments = await withTenantTransaction(async (tx) => {
          await assertTenantContextIs(tx, businessId);
          return tx.crmAttachment.findMany({
            where: { businessId },
            select: { storageKey: true },
          });
        });
        for (const { storageKey } of attachments) {
          await deleteAttachmentObject(storageKey);
        }

        // ── S8 / SEC-E M-13 — the objects NO row points at ────────────────────
        //
        // A content upload is written to `biz/{id}/content/*` and its URL lives only in
        // the browser. There is no column to read a key from, so the only way to reach
        // those bytes is the tenant's own prefix. Object-first like the attachments
        // above: a failure here throws before any row is touched, and a retry lists
        // whatever is left and deletes it. Declared as a prefix surface in
        // scripts/ci/erasure/erasure-object-surfaces.ts (C28).
        await deletePublicAssetsOfBusiness(businessId, "content");

        return withTenantTransaction(async (tx) => {
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
          // E2-W1. This statement used to clear two columns. The manifest
          // declared `email` erased and the adapter never wrote it — the
          // contract lie the whole residual sweep started from. The other three
          // are the free text a salesperson types about a named person, which
          // is the same class of content the conversation graph is anonymised
          // for, sitting one table away.
          //
          // The analytics columns are deliberately NOT touched: source channel,
          // stage, status, the price estimates and the timestamps describe the
          // pipeline, not the person, and destroying them would be erasing the
          // business's own history rather than its counterparty's identity.
          await tx.lead.updateMany({
            where: { businessId },
            data: {
              customerName: null,
              phone: null,
              email: null,
              intentSnapshot: null,
              followUpNote: null,
              lostReason: null,
              customerId: null,
            },
          });

          // E2-W1. Notifications are not an original surface — they are a COPY.
          // `title` is built from the raw customer name, and `summary` is
          // assembled from the last message snippet, the generated reply and the
          // lead's follow-up note. All three are already required to be
          // anonymised at their source, so a readable copy here would make that
          // work pointless.
          //
          // ANONYMISED, NOT DELETED, and not by preference: the runtime holds
          // SELECT, INSERT and UPDATE on this table and no DELETE. A
          // `deleteMany` would match zero rows in Production and raise nothing —
          // the exact silent-zero shape of Defect B.
          //
          // `reason` and `href` stay. One is a fixed policy string, the other an
          // internal route; neither names anyone, and clearing them would be
          // destroying operational state under cover of an erasure.
          await tx.notification.updateMany({
            where: { businessId },
            data: { title: "", summary: null },
          });

          // ── C12-E1 — the two procurement notes ─────────────────────────────
          //
          // Free text, and nothing else on either model. The receiving session keeps
          // which order it received and when; the purchase-order line keeps the
          // product it names, the quantity and the decision. Both keep WHO acted, as
          // an id into a User row this same transaction has already anonymised.
          // Only the sentence somebody typed goes.
          //
          // Anonymised rather than deleted for the same reason as everything above:
          // the runtime holds SELECT, INSERT and UPDATE on both tables and NO DELETE,
          // so a `deleteMany` here would match zero rows, raise nothing and report
          // success — the shape of Defect B.
          await tx.receivingSession.updateMany({
            where: { businessId },
            data: { note: null },
          });
          // `PurchaseOrderLine` has NO businessId. It owns through its parent, and its
          // RLS policy is an EXISTS over `PurchaseOrder`, so this relation filter IS
          // the tenant boundary — the same shape stage 1 uses to reach OAuthToken
          // through EmailConnection. A `where: {}` would clear every tenant's notes
          // and look identical to this one in any test that checks only this tenant.
          await tx.purchaseOrderLine.updateMany({
            where: { purchaseOrder: { businessId } },
            data: { remainingDecisionNote: null },
          });

          // B.2 delete pure communications PII with no fiscal linkage.
          await tx.crmAttachment.deleteMany({ where: { businessId } });
          await tx.crmNote.deleteMany({ where: { businessId } });

          // ── B.2.1 — the inbound-email sender authorisation list ─────────────
          //
          // Two tables of pure personal data with no fiscal linkage: an address
          // belonging to a person OUTSIDE this business who was asked to be
          // allowed to forward, and the hashed challenges sent to prove they
          // hold that mailbox. Nothing downstream reads either, so there is
          // nothing to anonymise around — they are deleted outright.
          //
          // CHILD FIRST, and explicitly, rather than leaning on the composite
          // CASCADE the schema declares. A referential action is performed by
          // the database, and under FORCE row-level security that is exactly the
          // shape that failed silently once before: `conversation.deleteMany`
          // matched zero rows, raised nothing, and the cascade to Message never
          // fired. Deleting the child in code keeps the guarantee where this
          // file's own tests can see it.
          //
          // Both are scoped by businessId, so they can only reach rows this
          // transaction's tenant GUC already admits.
          //
          // NOT erased here, deliberately: InboundEmailAddress,
          // InboundEmailMessage and InboundEmailAttachmentImport stay
          // UNMANAGED_PERSONAL_DATA with recorded debt. Their raw MIME lives in
          // object storage OUTSIDE Postgres, which no database erasure reaches,
          // so closing them honestly needs an increment that deletes those
          // objects too. Claiming them here would be a promise this code cannot
          // keep.
          //
          // Deleting a sender leaves InboundEmailMessage.authorizedSenderId to
          // the schema's ON DELETE SET NULL, which drops the link to the person
          // without touching that message row's own retention.
          await tx.inboundEmailSenderChallenge.deleteMany({ where: { businessId } });
          await tx.inboundEmailAuthorizedSender.deleteMany({ where: { businessId } });

          // ── B.3 — the conversation graph, ANONYMISED IN PLACE ──────────────
          //
          // This used to be `conversation.deleteMany`, and it deleted nothing.
          // The five pilot tables carry SELECT/INSERT/UPDATE policies and NO
          // DELETE policy, deliberately, so under FORCE RLS the delete matched
          // zero rows, raised nothing, and the cascade to Message never fired.
          // Every customer message body survived an erasure that reported
          // removing them.
          //
          // The owner's decision is anonymise-in-place rather than purge, so no
          // DELETE policy, no grant and no new identity are introduced. The
          // guarantee changes from "the rows are gone" to "nothing readable,
          // derived or identifying is left in them", which the UPDATE policies
          // these tables already carry are enough to deliver.
          //
          // DEEPEST FIRST, so a failure part-way through can never leave a child
          // holding content whose parent already claims to be clean.
          //
          // Every statement is a state-convergent overwrite to a constant, which
          // is what makes the whole thing idempotent: running it twice leaves
          // exactly the same safe state, and a retry after a partial pass simply
          // finishes the job.

          // Derived analysis. No businessId of its own — its policy reaches it
          // through Message, so the relation filter is also what satisfies RLS.
          // Both columns are NOT NULL, so they are blanked rather than nulled.
          await tx.messageAnalysis.updateMany({
            where: { message: { businessId } },
            data: { intent: "", stage: "" },
          });

          // Generated replies. `text` is the model's own content and is NOT
          // NULL; the two labels describe how it was written and would survive
          // as a description of what was said.
          await tx.replySuggestion.updateMany({
            where: { businessId },
            data: { text: "", toneLabel: null, strategyLabel: null },
          });

          // The messages themselves: the words, the language they were in, every
          // derived label about them, the provider's own id for the message —
          // which is the value that could reconnect this skeleton to the live
          // thread on WhatsApp or Gmail — the client idempotency key, and the
          // provider error text, which routinely quotes the number or the body.
          await tx.message.updateMany({
            where: { businessId },
            data: {
              contentText: null,
              languageCode: null,
              intentLabel: null,
              sentimentLabel: null,
              objectionLabel: null,
              stageLabel: null,
              providerMessageId: null,
              clientRequestId: null,
              sendErrorCode: null,
              sendErrorMessage: null,
              customerId: null,
            },
          });

          // The conversation row: free-text snapshots that summarise what was
          // said, the two Json blobs that carry pending follow-up and
          // appointment detail, and the participant pointers. `leadId` matters
          // most — a Lead still holds contact fields this erasure does not
          // scrub, so leaving the pointer would reconnect the skeleton to a
          // person through a table B does not own.
          await tx.conversation.updateMany({
            where: { businessId },
            data: {
              intentType: null,
              sentimentSnapshot: null,
              outcomeReason: null,
              lostReason: null,
              pendingFollowUp: Prisma.DbNull,
              pendingAppointmentRequest: Prisma.DbNull,
              customerId: null,
              leadId: null,
            },
          });
        });
      },
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
              actor: { type: "OWNER_USER", userId: actorUserId },
              source: "OWNER_UI",
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

  /**
   * SEC-E / M-12(a) — end the authority the account still holds, on the auth plane
   * that owns it: every user's token generation moves and every live session is
   * revoked. Before this the lifecycle gate was the only control; now a token or a
   * refresh credential minted before the deletion fails on its own.
   */
  async revokeAccountAuthority(businessId, now) {
    await revokeAuthorityOfBusinessUsers(businessId, now);
  },

  /**
   * SEC-E — erase the device history (session rows and their rotation secrets, which
   * carry the User-Agent of every login). Runs after the authority stage.
   */
  async eraseAccountSessions(businessId) {
    await eraseSessionsOfBusinessUsers(businessId);
  },

  /**
   * SEC-E / H-5 — VERIFIED COMPLETION. Post-conditions read back from the database and
   * the object store BEFORE the terminal transition is allowed to commit. Returns the
   * residual CLASSES still present (fixed strings, never values). An empty list is the
   * only thing that lets `finalizeAndAudit` run; anything else leaves the business
   * DELETION_REQUESTED and the job retries.
   *
   * This is a gate, not the exhaustive proof: the AD-2A and SEC-E batteries sweep every
   * column. It exists so a stage that silently did less than it claimed (the Defect A/B
   * shape) cannot reach PURGED.
   */
  async verifyErased(businessId) {
    const residual: string[] = [];
    const counts = await runTenantJob(
      { businessId },
      () =>
        withTenantTransaction(async (tx) => {
          await assertTenantContextIs(tx, businessId);
          return {
            users: await tx.user.count({
              where: {
                businessId,
                OR: [
                  { NOT: { email: `deleted-biz-${businessId}@deleted.invalid` } },
                  { name: { not: null } },
                  { NOT: { password: "" } },
                ],
              },
            }),
            oauth: await tx.oAuthToken.count({ where: { connection: { businessId } } }),
            email: await tx.emailConnection.count({
              where: {
                businessId,
                OR: [
                  { NOT: { emailAddress: { endsWith: "@deleted.invalid" } } },
                  { NOT: { providerAccountId: "" } },
                  { lastError: { not: null } },
                ],
              },
            }),
            whatsapp: await tx.whatsAppConnection.count({
              where: {
                businessId,
                OR: [
                  { NOT: { accessTokenEncrypted: "" } },
                  { NOT: { phoneNumberId: `erased-${businessId}` } },
                  { NOT: { wabaId: "" } },
                ],
              },
            }),
            ita: await tx.billingAuthorityConnection.count({
              where: {
                businessId,
                OR: [{ accessTokenEncrypted: { not: null } }, { refreshTokenEncrypted: { not: null } }],
              },
            }),
            payment: await tx.businessPaymentConnection.count({
              where: { businessId, credentialEncrypted: { not: null } },
            }),
            pos: await tx.pOSApiKey.count({ where: { businessId } }),
            crm: (await tx.crmAttachment.count({ where: { businessId } })) + (await tx.crmNote.count({ where: { businessId } })),
            customers: await tx.customer.count({
              where: { businessId, OR: [{ phone: { not: null } }, { email: { not: null } }, { taxId: { not: null } }] },
            }),
            leads: await tx.lead.count({
              where: { businessId, OR: [{ phone: { not: null } }, { email: { not: null } }, { customerName: { not: null } }] },
            }),
            messages: await tx.message.count({ where: { businessId, contentText: { not: null } } }),
          };
        }),
      { quarantinePolicy: "erasure" }
    );
    for (const [cls, n] of Object.entries(counts)) {
      if (n > 0) residual.push(cls);
    }
    const content = await getStorageService().listByPrefix(`biz/${businessId}/content/`, { limit: 1 });
    if (content.keys.length > 0) residual.push("content_objects");
    if ((await countSessionsOfBusinessUsers(businessId)) > 0) residual.push("auth_sessions");
    return residual;
  },
};
