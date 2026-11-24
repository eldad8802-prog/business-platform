/**
 * Metered OCR — the ONE wrapper every Google Vision call for a business goes through (upload pipeline, reprocess, Gmail
 * import, WhatsApp intake), so no intake source can bypass the OCR quota (subscriptions stage C). SERVER-ONLY.
 *
 *   1. RESERVE the customer's pages (ocr_pages) BEFORE the provider is called: an image is 1 page, a PDF its page
 *      count capped at 5 (the synchronous Vision files API reads the first five pages).
 *      Refused (ENFORCE, a customer over its quota) ⇒ the provider is NOT called; the caller keeps the document and
 *      marks it as waiting for the quota (nothing received is ever lost).
 *   2. Every provider call actually made — the geometry call, a text-only fallback, a retry — is recorded in
 *      ocr_provider_units (measured, never refused): that is our real bill, even when the customer is charged once.
 *   3. SETTLE: success ⇒ COUNTED; a failure that provably cost nothing (configuration) ⇒ RELEASED (the pages come back);
 *      anything else (timeout, network) ⇒ UNKNOWN — kept counted, reconciled later.
 * The same unit key twice (an automatic retry of the same pass) is counted once (DUPLICATE) and still runs.
 */
import { randomUUID } from "node:crypto";

import { PDFDocument } from "pdf-lib";

import { GoogleVisionConfigError } from "@/lib/services/documents/google-vision-ocr.service";

import { consumeUsage, settleUsage, type UsageDecision } from "./usage-meter";

export const OCR_MAX_PDF_PAGES = 5;

/** Pages Vision will read for this file: 1 for an image; a PDF's page count capped at 5 (1 when unreadable). */
export async function estimateOcrPages(buffer: Buffer, mimeType: string | null | undefined): Promise<number> {
  if (!(mimeType ?? "").toLowerCase().includes("pdf")) return 1;
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
    return Math.max(1, Math.min(OCR_MAX_PDF_PAGES, doc.getPageCount()));
  } catch {
    return 1;
  }
}

export type MeteredOcrContext = {
  businessId: number;
  /** The customer unit: one per document and pass (e.g. ocr:doc:<id>:first, ocr:gmail:<message>:<attachment>). */
  unitKey: string;
  source: string;
  buffer: Buffer;
  mimeType: string | null | undefined;
};

export type MeteredOcrResult<T> =
  | { ok: true; value: T; decision: UsageDecision }
  | { ok: false; reason: "QUOTA_EXHAUSTED"; decision: UsageDecision };

/**
 * `run(providerCall)` performs the OCR; it must call `providerCall()` immediately before EACH request to Vision
 * (so a fallback or a retry is recorded as the provider units it really costs).
 */
export async function meteredOcr<T>(
  ctx: MeteredOcrContext,
  run: (providerCall: () => Promise<void>) => Promise<T>,
): Promise<MeteredOcrResult<T>> {
  const pages = await estimateOcrPages(ctx.buffer, ctx.mimeType);
  const decision = await consumeUsage({
    businessId: ctx.businessId,
    metric: "ocr_pages",
    unitKey: ctx.unitKey,
    amount: pages,
    source: ctx.source,
    reserve: true,
  });
  if (!decision.allowed) return { ok: false, reason: "QUOTA_EXHAUSTED", decision };

  const providerCall = async () => {
    await consumeUsage({
      businessId: ctx.businessId,
      metric: "ocr_provider_units",
      unitKey: `${ctx.unitKey}:call:${randomUUID()}`,
      amount: pages,
      source: ctx.source,
    });
  };

  // A DUPLICATE (an automatic retry of the same pass) was settled by its first run; only a fresh reservation settles.
  const fresh = decision.outcome === "COUNTED";
  try {
    const value = await run(providerCall);
    if (fresh) await settleUsage({ businessId: ctx.businessId, metric: "ocr_pages", unitKey: ctx.unitKey, state: "COUNTED" });
    return { ok: true, value, decision };
  } catch (error) {
    if (fresh) {
      await settleUsage({
        businessId: ctx.businessId,
        metric: "ocr_pages",
        unitKey: ctx.unitKey,
        state: error instanceof GoogleVisionConfigError ? "RELEASED" : "UNKNOWN",
      });
    }
    throw error;
  }
}
