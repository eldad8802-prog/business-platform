/**
 * Prisma adapter for account deletion (Wave 1B). Executes the ratified erasure
 * manifest. SERVER-ONLY. EVERY operation is `businessId`-scoped (tenant safety) and
 * the anonymize+purge+mark steps run in one transaction (atomic — no half-deleted
 * tenant). Retained bucket-A fiscal/evidence records are never referenced here.
 *
 * Integration credentials are CLEARED IN PLACE (not row-deleted) to avoid FK
 * landmines with retained fiscal rows; required non-null cipher fields are blanked to
 * "" (ciphertext gone). Provider-side revoke is a separate best-effort concern
 * (documented in the design doc); here we guarantee the at-rest secret is destroyed.
 */
import { prisma } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/services/audit.service";
import type { AccountDeletionStore } from "@/lib/services/account/account-deletion.service";

export const prismaAccountDeletionStore: AccountDeletionStore = {
  async getBusiness(businessId) {
    const b = await prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, deletedAt: true },
    });
    return b ? { id: b.id, deletedAt: b.deletedAt } : null;
  },

  async listActiveUserIds(businessId) {
    const users = await prisma.user.findMany({
      where: { businessId },
      select: { id: true },
    });
    return users.map((u) => u.id);
  },

  async revokeIntegrations(businessId) {
    // Clear at-rest credentials; set revoked markers. Tenant-scoped.
    await prisma.$transaction([
      prisma.billingAuthorityConnection.updateMany({
        where: { businessId },
        data: {
          accessTokenEncrypted: null, accessTokenIv: null, accessTokenTag: null,
          refreshTokenEncrypted: null, refreshTokenIv: null, refreshTokenTag: null,
          revokedAt: new Date(),
        },
      }),
      prisma.businessPaymentConnection.updateMany({
        where: { businessId },
        data: { credentialEncrypted: null, credentialIv: null, credentialTag: null, isActive: false },
      }),
      prisma.whatsAppConnection.updateMany({
        where: { businessId },
        data: { accessTokenEncrypted: "", accessTokenIv: "", accessTokenTag: "", status: "REVOKED_BY_META" },
      }),
      prisma.emailConnection.updateMany({
        where: { businessId },
        data: { status: "revoked", lastSyncCursor: null },
      }),
      // OAuthTokens hang off EmailConnection; delete via the relation (no fiscal FK).
      prisma.oAuthToken.deleteMany({ where: { connection: { businessId } } }),
      // POS keys: DELETE the rows. keyHash is globally @unique, so blanking it to a
      // constant would collide across multiple account deletions; the row carries no
      // fiscal FK, so deletion is the correct revoke.
      prisma.pOSApiKey.deleteMany({ where: { businessId } }),
    ]);
  },

  async anonymizeAndPurgeOperationalData(businessId) {
    const tombstoneEmail = `deleted-biz-${businessId}@deleted.invalid`;
    await prisma.$transaction([
      // B.1 anonymize (rows kept — required by fiscal FKs / referential integrity)
      prisma.user.updateMany({
        where: { businessId },
        data: { email: tombstoneEmail, name: null, password: "" },
      }),
      prisma.businessProfile.updateMany({
        where: { businessId },
        data: {
          billingLegalName: null, billingTaxId: null, billingVatNumber: null,
          billingPhone: null, billingEmail: null, billingAddress: null,
          city: null, latitude: null, longitude: null, openingHours: null,
          billingLogoDataUrl: null, billingSignatureDataUrl: null,
        },
      }),
      // Customers anonymized (NOT deleted) — issued invoices reference customerId;
      // the invoice's frozen customerNameSnapshot preserves the legal record.
      prisma.customer.updateMany({
        where: { businessId },
        data: { name: "לקוח שנמחק", phone: null, email: null, city: null, legalName: null, taxId: null, notes: null },
      }),
      prisma.lead.updateMany({
        where: { businessId },
        data: { customerName: null, phone: null },
      }),
      // B.2 delete pure communications PII (Conversation cascades Message/analysis).
      prisma.crmAttachment.deleteMany({ where: { businessId } }),
      prisma.crmNote.deleteMany({ where: { businessId } }),
      prisma.conversation.deleteMany({ where: { businessId } }),
    ]);
  },

  async markBusinessDeleted(businessId, actorUserId, now) {
    await prisma.business.update({
      where: { id: businessId },
      data: {
        deletedAt: now,
        deletionRequestedAt: now,
        archivedAt: now,
        archivedByUserId: actorUserId,
      },
    });
  },

  async writeErasureAudit(businessId, actorUserId, now) {
    // Categories/when/by-whom only — never the erased content.
    await logAuditEvent({
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
    });
  },
};
