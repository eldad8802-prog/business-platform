/**
 * Production Prisma adapter for the signed-artifact store (Phase 2B-1).
 *
 * Thin: implements the compare-and-set + tenant-scoped read against Prisma, routed
 * through the sanctioned billing mutation gateway (so the ISSUED operational-only
 * immutability guard applies). It performs NO signing, NO upload, NO secret/cert
 * access, and never touches legal snapshot fields. Not exercised by the unit tests
 * (which use an in-memory store); wired for real use in Phase 2B-3.
 */
import { prisma } from "@/lib/prisma";
import { billingTenantTx } from "@/lib/services/billing/billing-tenant-tx";
import { updateBillingDocuments } from "@/lib/services/billing/domain/billing-document-mutation.gateway";
import type {
  SignedArtifactStore,
  SignedArtifactFields,
  SignedPdfArtifact,
} from "@/lib/services/billing/signed-pdf-artifact";

export const prismaSignedArtifactStore: SignedArtifactStore = {
  async casRecordSignedArtifact(args: {
    documentId: number;
    businessId: number;
    artifact: SignedPdfArtifact;
  }): Promise<number> {
    // Atomic single-writer: set the three operational fields ONLY when currently
    // unsigned (signedPdfStorageKey IS NULL) and the document is this tenant's and
    // ISSUED (the intent merges `status: ISSUED`). BatchPayload.count is 0 or 1.
    const res = await billingTenantTx(args.businessId, (tx) =>
      updateBillingDocuments(tx, {
      intent: "issued_operational",
      where: {
        id: args.documentId,
        businessId: args.businessId,
        signedPdfStorageKey: null,
      },
      data: {
        signedPdfStorageKey: args.artifact.storageKey,
        signedPdfHash: args.artifact.hash,
        signedAt: args.artifact.signedAt,
      },
    })
    );
    return res.count;
  },

  async readSignedFields(args: {
    documentId: number;
    businessId: number;
  }): Promise<SignedArtifactFields | null> {
    const doc = await billingTenantTx(args.businessId, (tx) =>
    tx.billingDocument.findFirst({
      where: { id: args.documentId, businessId: args.businessId },
      select: { signedPdfStorageKey: true, signedPdfHash: true, signedAt: true },
    })
  );
    if (!doc) return null;
    return {
      signedPdfStorageKey: doc.signedPdfStorageKey,
      signedPdfHash: doc.signedPdfHash,
      signedAt: doc.signedAt,
    };
  },
};
