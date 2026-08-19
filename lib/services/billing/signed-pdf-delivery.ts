/**
 * Fiscal billing PDF delivery orchestrator (Phase 2B-3A) — PURE, INERT by default.
 *
 * Wraps the EXISTING unsigned canonical PDF pipeline and, WHEN signing is active,
 * turns the unsigned canonical bytes into a canonical cryptographically-signed
 * artifact and serves that. It composes the already-shipped foundations — it does
 * NOT reimplement the signer (2A), identity resolution (2B-2), the signed-artifact
 * state machine / CAS (2B-1), or the storage abstraction.
 *
 * This module is dependency-injected and free of DB / renderer / env imports so it
 * is fully testable without a database; the real wiring lives in
 * `signed-pdf-delivery.wiring.ts`.
 *
 * Guarantees:
 *  - OFF: exact current unsigned behavior; resolver/signer/upload/record never run.
 *  - ON: fail closed — a signing/identity/upload/persist failure NEVER yields an
 *    unsigned PDF dressed up as final. Issuance is untouched (this is delivery only).
 *  - Sign-once: once a canonical signed artifact exists it is served directly and
 *    never re-signed.
 *  - Concurrency: CAS picks one canonical winner; a loser rereads and serves the
 *    winner (never overwrites it). No lock/queue.
 *  - Hash semantics preserved: `pdfHash` stays the unsigned hash; the signed hash
 *    is separate and used only for the signed artifact + ETag.
 *
 * Scope: fiscal ISSUED documents only. QUOTE is out of scope and never routed here.
 */
import { createHash } from "node:crypto";
import type {
  GetOrRenderBillingPdfInput,
  GetOrRenderBillingPdfResult,
} from "@/lib/services/billing/billing-pdf.service";
import type {
  SigningMaterial,
  SignedPdf,
  SigningIdentityResolver,
} from "@/lib/services/signing/signing-types";
import {
  recordSignedPdfArtifact,
  hasCanonicalSignedPdf,
  isPartialSignedArtifactState,
  type SignedArtifactStore,
} from "@/lib/services/billing/signed-pdf-artifact";

export type FiscalPdfDeliveryResult = {
  buffer: Buffer;
  /** ETag hash of the served bytes: unsigned `pdfHash` when OFF/unsigned, `signedPdfHash` when signed. */
  servedHash: string;
  pdfTemplateVersion: string;
  documentNumberFormatted: string;
  renderedNow: boolean;
  /** True when the served artifact is the canonical cryptographically-signed PDF. */
  signed: boolean;
};

export type FiscalSigningErrorCode = "not_found" | "partial_state" | "persist_failed";

/** Fail-closed delivery error. Carries a stable code + safe message; never any secret. */
export class FiscalSigningError extends Error {
  readonly code: FiscalSigningErrorCode;
  constructor(code: FiscalSigningErrorCode, message: string) {
    super(message);
    this.name = "FiscalSigningError";
    this.code = code;
  }
}

export type FiscalDeliveryStorage = {
  write: (storageKey: string, bytes: Buffer) => Promise<void>;
  read: (storageKey: string) => Promise<Buffer>;
  unlinkQuiet: (storageKey: string) => Promise<void>;
};

export type FiscalSigningDeps = {
  /** Activation gate — OFF means passthrough of the unsigned pipeline. */
  isActive: () => boolean;
  /** The existing unsigned canonical PDF pipeline (render/cache/persist unsigned). */
  getUnsigned: (input: GetOrRenderBillingPdfInput) => Promise<GetOrRenderBillingPdfResult>;
  /** Platform signing identity resolver (fails closed on missing/expired/etc). */
  resolver: SigningIdentityResolver;
  /** Generic PKCS#7/PAdES signer (identity-agnostic). */
  sign: (unsigned: Buffer, material: SigningMaterial) => Promise<SignedPdf>;
  /** Signed-artifact state store (read + CAS record), Phase 2B-1. */
  store: SignedArtifactStore;
  /** Object storage for the signed artifact (content-addressed). */
  storage: FiscalDeliveryStorage;
  /** Builds the signed artifact's storage key (content-addressed by signed hash). */
  buildSignedKey: (businessId: number, documentId: number, signedHash: string) => string;
  /** Clock (injectable for tests). */
  now: () => Date;
};

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function served(
  buffer: Buffer,
  servedHash: string,
  base: GetOrRenderBillingPdfResult,
  signed: boolean
): FiscalPdfDeliveryResult {
  return {
    buffer,
    servedHash,
    pdfTemplateVersion: base.pdfTemplateVersion,
    documentNumberFormatted: base.documentNumberFormatted,
    renderedNow: base.renderedNow,
    signed,
  };
}

/**
 * Produce the canonical PDF to deliver for a fiscal ISSUED document.
 * OFF → unsigned (today's behavior). ON → canonical signed artifact (fail closed).
 */
export async function deliverFiscalBillingPdf(
  input: GetOrRenderBillingPdfInput,
  deps: FiscalSigningDeps
): Promise<FiscalPdfDeliveryResult> {
  // Always produce/serve the unsigned canonical PDF first via the EXISTING pipeline
  // (authority delivery gate, ISSUED checks, render/cache, pdfHash/pdfStorageKey).
  const base = await deps.getUnsigned(input);

  // OFF: exact current behavior. Nothing signing-related is touched.
  if (!deps.isActive()) {
    return served(base.buffer, base.pdfHash, base, false);
  }

  const businessId = input.businessId;
  const documentId = input.billingDocumentId;

  // Sign-once: if a canonical signed artifact already exists, serve it. Never re-sign.
  const existing = await deps.store.readSignedFields({ documentId, businessId });
  if (existing == null) {
    throw new FiscalSigningError("not_found", "billing document not found for this business");
  }
  if (hasCanonicalSignedPdf(existing)) {
    const signedBytes = await deps.storage.read(existing.signedPdfStorageKey as string);
    return served(signedBytes, existing.signedPdfHash as string, base, true);
  }
  // A partial/incoherent signed state must never be served as signed (fail closed).
  if (isPartialSignedArtifactState(existing)) {
    throw new FiscalSigningError("partial_state", "incoherent signed-artifact state; refusing to serve");
  }

  // Unsigned → resolve identity + sign the unsigned canonical bytes. Identity and
  // signing errors propagate (fail closed): the unsigned PDF is NOT returned.
  const material = await deps.resolver.resolveSigningIdentity(businessId);
  const signed = await deps.sign(base.buffer, material);
  const signedHash = sha256Hex(signed.bytes);
  const signedKey = deps.buildSignedKey(businessId, documentId, signedHash);

  // Upload the signed artifact (content-addressed). Failure propagates → no DB record.
  await deps.storage.write(signedKey, signed.bytes);

  try {
    await recordSignedPdfArtifact(deps.store, {
      documentId,
      businessId,
      artifact: { storageKey: signedKey, hash: signedHash, signedAt: deps.now() },
    });
    // We won the CAS (recorded) or an identical artifact already existed (idempotent):
    // our bytes are canonical.
    return served(signed.bytes, signedHash, base, true);
  } catch {
    // CAS conflict (a different artifact won) or a persistence failure. Reread: if a
    // canonical winner exists, serve it and drop our orphan; otherwise fail closed.
    const after = await deps.store.readSignedFields({ documentId, businessId });
    if (after && hasCanonicalSignedPdf(after)) {
      await deps.storage.unlinkQuiet(signedKey);
      const winnerBytes = await deps.storage.read(after.signedPdfStorageKey as string);
      return served(winnerBytes, after.signedPdfHash as string, base, true);
    }
    await deps.storage.unlinkQuiet(signedKey);
    throw new FiscalSigningError("persist_failed", "failed to persist canonical signed artifact");
  }
}
