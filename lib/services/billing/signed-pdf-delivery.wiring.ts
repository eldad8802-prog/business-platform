/**
 * Production wiring for the fiscal PDF delivery orchestrator (Phase 2B-3A). SERVER-ONLY.
 *
 * Binds the pure orchestrator (`deliverFiscalBillingPdf`) to the real, already-shipped
 * foundations: the unsigned pipeline (billing-pdf.service), the platform identity
 * resolver (2B-2), the generic signer (2A), the signed-artifact store (2B-1), and the
 * billing storage adapter. Nothing new is provisioned; with the activation gate OFF
 * (the default), this composes to exactly today's unsigned behavior.
 */
import {
  getOrRenderBillingPdf,
  type GetOrRenderBillingPdfInput,
} from "@/lib/services/billing/billing-pdf.service";
import { createPlatformSigningIdentityResolver } from "@/lib/services/signing/platform-signing-identity";
import { signPdf } from "@/lib/services/signing/pdf-signer.service";
import { prismaSignedArtifactStore } from "@/lib/services/billing/signed-pdf-artifact.prisma-store";
import {
  buildStorageKey,
  writeAtomic,
  readByKey,
  unlinkByKeyQuiet,
} from "@/lib/services/billing/pdf/billing-pdf-storage";
import { isBillingSigningActive } from "@/lib/services/billing/signing-activation";
import {
  deliverFiscalBillingPdf,
  type FiscalPdfDeliveryResult,
  type FiscalSigningDeps,
} from "@/lib/services/billing/signed-pdf-delivery";

// Defensive server-only guard: this module reaches the signer + identity material and
// must never be bundled into client code.
if (typeof window !== "undefined") {
  throw new Error("signed-pdf-delivery.wiring is server-only and must not be imported by client code");
}

function defaultFiscalSigningDeps(): FiscalSigningDeps {
  return {
    isActive: isBillingSigningActive,
    getUnsigned: getOrRenderBillingPdf,
    // A single platform identity for all tenants (2B-2). Reads env lazily at call time;
    // with the secret unprovisioned and the activation gate OFF, it is never invoked.
    resolver: createPlatformSigningIdentityResolver(),
    sign: signPdf,
    store: prismaSignedArtifactStore,
    storage: { write: writeAtomic, read: readByKey, unlinkQuiet: unlinkByKeyQuiet },
    // The signed artifact is content-addressed by the SIGNED hash, so it is a distinct
    // object from the unsigned PDF (which is addressed by pdfHash) — same key shape,
    // different hash, never a collision.
    buildSignedKey: (businessId, documentId, signedHash) =>
      buildStorageKey(businessId, documentId, signedHash),
    now: () => new Date(),
  };
}

/**
 * Deliver the canonical fiscal billing PDF (unsigned when the gate is OFF; the
 * canonical signed artifact when ON). Single boundary used by the download route so
 * every consumer gets the same canonical-artifact decision.
 */
export async function getFiscalBillingPdfForDelivery(
  input: GetOrRenderBillingPdfInput
): Promise<FiscalPdfDeliveryResult> {
  return deliverFiscalBillingPdf(input, defaultFiscalSigningDeps());
}
