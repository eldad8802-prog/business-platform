/**
 * ר1 — a NEW share copy of a quote, rendered by the existing quote PDF functions and stored before it is shared.
 * SERVER-ONLY.
 *
 * NO WRITE IN THE BILLING MECHANISM. The quote, its lines, its customer and the business letterhead are only READ,
 * in a READ ONLY transaction (the database refuses any write inside it). The PDF is produced by the existing pure
 * functions (buildQuotePdfSnapshot → renderBillingPdfHtmlFromSnapshot) — never by getOrRenderQuotePdf, which writes
 * PDF fields and allocates a number. A quote without a number is refused: the owner numbers it in the existing quote
 * screen (its PDF button), then comes back. The copy is a new file of our own; it is never the historical PDF the
 * existing screen stored.
 *
 * HOW A CHANGE DURING THE RENDER IS DETECTED — two separate transactions, not a re-read inside one:
 *   T1  REPEATABLE READ, READ ONLY: quote + lines + customer + letterhead from ONE snapshot → snapshot S1 →
 *       renderInputHash H1. (A re-read inside T1 would see the same snapshot and could never notice anything.)
 *   ——  render S1 to PDF bytes, outside any transaction; store them (create-once) under a PENDING file row.
 *   T2  a NEW REPEATABLE READ transaction, opened after the render: re-read the same rows → S2 (same date and actor)
 *       → H2. H2 ≠ H1 → the quote changed while it was being rendered: the file is abandoned, the key is released,
 *       CHANGED_DURING_RENDER. H2 = H1 → in the SAME transaction, the file is committed and the copy recorded with
 *       contentCheckedAt = T2's time. An edit that commits after T2's snapshot is a LATER edit: the copy correctly
 *       describes the quote as of its check, and the screen then shows "the quote changed since this copy".
 */
import type { BillingDocument, BillingDocumentLine } from "@prisma/client";

import { buildQuotePdfSnapshot } from "@/lib/services/billing/quote-pdf-snapshot";
import { renderBillingPdfHtmlFromSnapshot } from "@/lib/services/billing/pdf/billing-pdf-html-renderer";
import { assertSnapshotV1, type BillingIssuedSnapshotV1 } from "@/lib/services/billing/pdf/billing-pdf-template";
import { getStorageService, type StorageService } from "@/lib/storage";

import { bdTx, type BdTx } from "../bd-tx";
import { abandonPendingFile, commitFile, createPendingFile, sha256Hex, uploadCreateOnce } from "../files/business-docs-files";
import { attachRequestFile, claimRequest, completeRequest, releaseRequest, requestHashOf } from "../requests/business-docs-requests";
import { quoteContentHash, renderInputHash } from "./quote-share-content";

export type QuoteCopyRefusal = "NOT_FOUND" | "SERVICE_DESK_QUOTE" | "NO_QUOTE_NUMBER" | "INCOMPLETE_QUOTE" | "CHANGED_DURING_RENDER";

export class QuoteCopyRefusedError extends Error {
  constructor(readonly code: QuoteCopyRefusal) {
    super(code);
    this.name = "QuoteCopyRefusedError";
  }
  get status(): number {
    return this.code === "NOT_FOUND" ? 404 : 409;
  }
}

export type QuoteShareCopyView = {
  id: number;
  quoteDocumentId: number;
  sha256: string;
  quoteContentHash: string;
  quoteNumber: string;
  customerName: string | null;
  total: string;
  currency: string;
  contentCheckedAt: string;
  createdAt: string;
  replay: boolean;
};

type RenderRows = {
  doc: BillingDocument & { lines: BillingDocumentLine[] };
  customer: { id: number; name: string; phone: string | null; email: string | null; city: string | null } | null;
  business: { id: number; name: string; profile: Record<string, unknown> | null };
  serviceDesk: boolean;
};

/** Every read the copy needs, inside the caller's transaction. Nothing is written. */
export async function loadQuoteRenderRows(tx: BdTx, businessId: number, quoteId: number): Promise<RenderRows | null> {
  const doc = await tx.billingDocument.findFirst({
    where: { id: quoteId, businessId, documentType: "QUOTE" },
    include: { lines: { orderBy: { lineIndex: "asc" } } },
  });
  if (!doc) return null;
  const customer = doc.customerId === null ? null : await tx.customer.findFirst({
    where: { id: doc.customerId, businessId },
    select: { id: true, name: true, phone: true, email: true, city: true },
  });
  const business = await tx.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      name: true,
      profile: {
        select: {
          billingLegalName: true, billingTaxId: true, billingVatNumber: true, billingPhone: true, billingEmail: true,
          billingAddress: true, billingPaymentNote: true, billingFooterNote: true, billingLogoDataUrl: true,
          billingSignatureDataUrl: true, billingPdfTemplateStyle: true,
        },
      },
    },
  });
  const serviceDesk = (await tx.serviceQuote.count({ where: { businessId, billingDocumentId: quoteId } })) > 0;
  return { doc, customer, business: business as RenderRows["business"], serviceDesk };
}

/** The quote-content view of the render rows (the lines live inside the document row). */
export function contentRowsOf(rows: RenderRows) {
  return { doc: rows.doc, lines: rows.doc.lines, customer: rows.customer };
}

function refuseUnlessRenderable(rows: RenderRows | null): asserts rows is RenderRows {
  if (!rows || !rows.business) throw new QuoteCopyRefusedError("NOT_FOUND");
  if (rows.serviceDesk) throw new QuoteCopyRefusedError("SERVICE_DESK_QUOTE");
  if (rows.doc.documentNumber === null || !rows.doc.documentNumberFormatted) throw new QuoteCopyRefusedError("NO_QUOTE_NUMBER");
  if (!(rows.doc.customerNameSnapshot ?? "").trim() || rows.doc.lines.length === 0) throw new QuoteCopyRefusedError("INCOMPLETE_QUOTE");
}

export function snapshotOf(rows: RenderRows, snapshotDate: Date, actorUserId: number): BillingIssuedSnapshotV1 {
  const snapshot = buildQuotePdfSnapshot({
    document: rows.doc,
    lines: rows.doc.lines,
    business: rows.business as never,
    customer: rows.customer,
    documentNumber: rows.doc.documentNumber as number,
    documentNumberFormatted: rows.doc.documentNumberFormatted as string,
    snapshotDate,
    actorUserId,
    totals: { subtotalAmount: rows.doc.subtotalAmount, vatAmount: rows.doc.vatAmount, totalAmount: rows.doc.totalAmount },
  });
  assertSnapshotV1(snapshot);
  return snapshot;
}

export type QuoteCopyDeps = {
  storage?: StorageService;
  render?: (snapshot: BillingIssuedSnapshotV1) => Promise<Buffer>;
  /** test seams for the timed-transaction proofs; never set in production */
  afterRead?: () => Promise<void>;
  beforeCommit?: () => Promise<void>;
};

const viewOf = (c: { id: number; quoteDocumentId: number; sha256: string; quoteContentHash: string; quoteNumberSnapshot: string; customerNameSnapshot: string | null; totalSnapshot: unknown; currencySnapshot: string; contentCheckedAt: Date; createdAt: Date }, replay: boolean): QuoteShareCopyView => ({
  id: c.id,
  quoteDocumentId: c.quoteDocumentId,
  sha256: c.sha256,
  quoteContentHash: c.quoteContentHash,
  quoteNumber: c.quoteNumberSnapshot,
  customerName: c.customerNameSnapshot,
  total: String(c.totalSnapshot),
  currency: c.currencySnapshot,
  contentCheckedAt: c.contentCheckedAt.toISOString(),
  createdAt: c.createdAt.toISOString(),
  replay,
});

export async function prepareQuoteShareCopy(
  input: { businessId: number; userId: number; quoteId: number; idempotencyKey: string },
  deps: QuoteCopyDeps = {}
): Promise<QuoteShareCopyView> {
  const { businessId, userId, quoteId, idempotencyKey } = input;
  const storage = deps.storage ?? getStorageService();
  const render = deps.render ?? renderBillingPdfHtmlFromSnapshot;
  const requestHash = requestHashOf({ op: "QUOTE_SHARE_COPY", quoteId });

  const claim = await bdTx(businessId, (tx) => claimRequest(tx, businessId, "QUOTE_SHARE_COPY", idempotencyKey, requestHash));
  if (claim.kind === "REPLAY") {
    const c = await bdTx(businessId, (tx) => tx.quoteShareCopy.findFirstOrThrow({ where: { businessId, id: claim.resultId } }));
    return viewOf(c, true);
  }

  let fileId: number | null = null;
  try {
    // T1 — one snapshot, read only.
    const snapshotDate = new Date();
    const rows1 = await bdTx(businessId, (tx) => loadQuoteRenderRows(tx, businessId, quoteId), { repeatableRead: true, readOnly: true });
    refuseUnlessRenderable(rows1);
    const s1 = snapshotOf(rows1, snapshotDate, userId);
    const h1 = renderInputHash(s1 as unknown as Record<string, unknown>);
    if (deps.afterRead) await deps.afterRead();

    const bytes = await render(s1);
    if (!bytes || bytes.length === 0) throw new Error("the renderer produced no bytes");

    const pending = await bdTx(businessId, async (tx) => {
      const f = await createPendingFile(tx, businessId, "QUOTE_SHARE_COPY", claim.leaseOwner);
      await attachRequestFile(tx, claim.requestId, claim.leaseOwner, f.id);
      return f;
    });
    fileId = pending.id;
    if ((await uploadCreateOnce(businessId, pending.objectKey, bytes, storage)) !== "CREATED") {
      throw new Error("a fresh object key was already taken");
    }
    if (deps.beforeCommit) await deps.beforeCommit();

    // T2 — a new snapshot after the render; check and record in the same transaction.
    const outcome = await bdTx(businessId, async (tx) => {
      const rows2 = await loadQuoteRenderRows(tx, businessId, quoteId);
      refuseUnlessRenderable(rows2);
      const h2 = renderInputHash(snapshotOf(rows2, snapshotDate, userId) as unknown as Record<string, unknown>);
      if (h2 !== h1) return "CHANGED" as const;
      if (!(await commitFile(tx, businessId, pending.id, claim.leaseOwner, bytes))) throw new Error("the upload lease was lost");
      const copy = await tx.quoteShareCopy.create({
        data: {
          businessId,
          quoteDocumentId: quoteId,
          fileId: pending.id,
          sha256: sha256Hex(bytes),
          quoteContentHash: quoteContentHash(contentRowsOf(rows2)),
          quoteNumberSnapshot: rows2.doc.documentNumberFormatted as string,
          customerNameSnapshot: (rows2.doc.customerNameSnapshot ?? "").trim().slice(0, 200) || null,
          totalSnapshot: rows2.doc.totalAmount,
          currencySnapshot: rows2.doc.currency,
          validUntilSnapshot: rows2.doc.validUntil,
          contentCheckedAt: new Date(),
          createdByUserId: userId,
        },
      });
      await completeRequest(tx, claim.requestId, claim.leaseOwner, copy.id);
      return copy;
    }, { repeatableRead: true });

    if (outcome === "CHANGED") throw new QuoteCopyRefusedError("CHANGED_DURING_RENDER");
    return viewOf(outcome, false);
  } catch (error) {
    // Give the key back and leave any object to the janitor — never a committed copy that was not checked.
    await bdTx(businessId, async (tx) => {
      if (fileId !== null) await abandonPendingFile(tx, businessId, fileId);
      await releaseRequest(tx, claim.requestId, claim.leaseOwner);
    }).catch(() => undefined);
    throw error;
  }
}

/** A fresh content fingerprint of the quote as it is now (for events and for "changed since this copy"). */
export async function currentQuoteContent(tx: BdTx, businessId: number, quoteId: number): Promise<{ hash: string; rows: RenderRows } | null> {
  const rows = await loadQuoteRenderRows(tx, businessId, quoteId);
  if (!rows) return null;
  return { hash: quoteContentHash(contentRowsOf(rows)), rows };
}

