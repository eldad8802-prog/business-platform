/**
 * ר1 — the owner's manual record about a quote, and the read model of the share screen. SERVER-ONLY.
 *
 * Every event is recorded once per server-issued key (a retry returns the first event). A file event
 * (DOWNLOADED / SHARE_SHEET_OPENED / MARKED_SENT) always points at the stored copy it was about and carries that
 * copy's content fingerprint; a response or a note carries the quote's fingerprint at the moment it is recorded.
 * The database refuses the rest (append-only, one correction per event, correctable kinds only, same quote).
 */
import { bdTx } from "../bd-tx";
import { claimRequest, completeRequest, requestHashOf } from "../requests/business-docs-requests";
import { currentQuoteContent } from "./quote-share-read";
import { deriveShareState, type ShareEventInput, type ShareEventKind, type ShareEventRow } from "./quote-share-state";

export class QuoteShareEventRefusedError extends Error {
  constructor(readonly code: "NOT_FOUND" | "COPY_NOT_FOUND" | "TARGET_NOT_FOUND" | "SERVICE_DESK_QUOTE") {
    super(code);
    this.name = "QuoteShareEventRefusedError";
  }
  get status(): number {
    return this.code === "SERVICE_DESK_QUOTE" ? 409 : 404;
  }
}

export async function recordQuoteShareEvent(input: { businessId: number; userId: number; quoteId: number; idempotencyKey: string; event: ShareEventInput }): Promise<{ id: number; replay: boolean }> {
  const { businessId, userId, quoteId, idempotencyKey, event } = input;
  const requestHash = requestHashOf({ op: "QUOTE_SHARE_EVENT", quoteId, ...event });
  // One transaction: a refusal below rolls the claim back too, so the key stays usable.
  return bdTx(businessId, async (tx) => {
    const claim = await claimRequest(tx, businessId, "QUOTE_SHARE_EVENT", idempotencyKey, requestHash);
    if (claim.kind === "REPLAY") return { id: claim.resultId, replay: true };
    const current = await currentQuoteContent(tx, businessId, quoteId);
    if (!current) {
      throw new QuoteShareEventRefusedError("NOT_FOUND");
    }
    if (current.rows.serviceDesk) {
      throw new QuoteShareEventRefusedError("SERVICE_DESK_QUOTE");
    }
    let hash = current.hash;
    if (event.copyId !== null) {
      const copy = await tx.quoteShareCopy.findFirst({ where: { businessId, quoteDocumentId: quoteId, id: event.copyId }, select: { quoteContentHash: true } });
      if (!copy) {
          throw new QuoteShareEventRefusedError("COPY_NOT_FOUND");
      }
      hash = copy.quoteContentHash;
    }
    if (event.correctsEventId !== null) {
      const target = await tx.quoteShareEvent.findFirst({ where: { businessId, quoteDocumentId: quoteId, id: event.correctsEventId }, select: { quoteContentHash: true } });
      if (!target) {
          throw new QuoteShareEventRefusedError("TARGET_NOT_FOUND");
      }
      hash = target.quoteContentHash;
    }
    const created = await tx.quoteShareEvent.create({
      data: {
        businessId,
        quoteDocumentId: quoteId,
        kind: event.kind,
        copyId: event.copyId,
        correctsEventId: event.correctsEventId,
        quoteContentHash: hash,
        channel: event.channel,
        note: event.note,
        actorUserId: userId,
      },
      select: { id: true },
    });
    await completeRequest(tx, claim.requestId, claim.leaseOwner, created.id);
    return { id: created.id, replay: false };
  });
}

export type QuoteShareView = {
  quote: {
    id: number;
    number: string | null;
    customerName: string | null;
    total: string;
    currency: string;
    validUntil: string | null;
    convertedToInvoice: boolean;
    serviceDesk: boolean;
  };
  currentContentHash: string;
  copies: { id: number; createdAt: string; contentCheckedAt: string; quoteNumber: string; total: string; currency: string; changedSince: boolean }[];
  events: { id: number; kind: ShareEventKind; copyId: number | null; channel: string | null; note: string | null; correctsEventId: number | null; createdAt: string; corrected: boolean; olderVersion: boolean }[];
  state: { response: "ACCEPTED" | "DECLINED" | null; sentAt: string | null; staleResponses: number };
};

export async function getQuoteShareView(businessId: number, quoteId: number): Promise<QuoteShareView | null> {
  return bdTx(businessId, async (tx) => {
    const current = await currentQuoteContent(tx, businessId, quoteId);
    if (!current) return null;
    const [copies, events] = await Promise.all([
      tx.quoteShareCopy.findMany({ where: { businessId, quoteDocumentId: quoteId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 }),
      tx.quoteShareEvent.findMany({ where: { businessId, quoteDocumentId: quoteId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 200 }),
    ]);
    const rows: ShareEventRow[] = events.map((e) => ({ id: e.id, kind: e.kind as ShareEventKind, copyId: e.copyId, correctsEventId: e.correctsEventId, quoteContentHash: e.quoteContentHash, createdAt: e.createdAt }));
    const state = deriveShareState(rows, current.hash);
    const d = current.rows.doc;
    return {
      quote: {
        id: d.id,
        number: d.documentNumberFormatted,
        customerName: d.customerNameSnapshot,
        total: String(d.totalAmount),
        currency: d.currency,
        validUntil: d.validUntil ? d.validUntil.toISOString() : null,
        convertedToInvoice: d.convertedToInvoiceId !== null,
        serviceDesk: current.rows.serviceDesk,
      },
      currentContentHash: current.hash,
      copies: copies.map((c) => ({ id: c.id, createdAt: c.createdAt.toISOString(), contentCheckedAt: c.contentCheckedAt.toISOString(), quoteNumber: c.quoteNumberSnapshot, total: String(c.totalSnapshot), currency: c.currencySnapshot, changedSince: c.quoteContentHash !== current.hash })),
      events: events.map((e) => ({ id: e.id, kind: e.kind as ShareEventKind, copyId: e.copyId, channel: e.channel, note: e.note, correctsEventId: e.correctsEventId, createdAt: e.createdAt.toISOString(), corrected: state.correctedIds.has(e.id), olderVersion: e.kind !== "CORRECTION" && e.quoteContentHash !== current.hash })),
      state: { response: state.response?.kind ?? null, sentAt: state.sent ? state.sent.at.toISOString() : null, staleResponses: state.staleResponses },
    };
  });
}

/** The quotes the hub lists (regular quotes only — never a Service Desk quote), newest first. */
export async function listShareableQuotes(businessId: number): Promise<{ id: number; number: string | null; customerName: string | null; total: string; currency: string; validUntil: string | null; convertedToInvoice: boolean; lastEvent: ShareEventKind | null }[]> {
  return bdTx(businessId, async (tx) => {
    const docs = await tx.billingDocument.findMany({
      where: { businessId, documentType: "QUOTE" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 60,
      select: { id: true, documentNumberFormatted: true, customerNameSnapshot: true, totalAmount: true, currency: true, validUntil: true, convertedToInvoiceId: true },
    });
    if (docs.length === 0) return [];
    const ids = docs.map((d) => d.id);
    const owned = new Set((await tx.serviceQuote.findMany({ where: { businessId, billingDocumentId: { in: ids } }, select: { billingDocumentId: true } })).map((s) => s.billingDocumentId));
    const last = await tx.quoteShareEvent.findMany({ where: { businessId, quoteDocumentId: { in: ids }, kind: { not: "CORRECTION" } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { quoteDocumentId: true, kind: true } });
    const lastByQuote = new Map<number, ShareEventKind>();
    for (const e of last) if (!lastByQuote.has(e.quoteDocumentId)) lastByQuote.set(e.quoteDocumentId, e.kind as ShareEventKind);
    return docs.filter((d) => !owned.has(d.id)).map((d) => ({
      id: d.id,
      number: d.documentNumberFormatted,
      customerName: d.customerNameSnapshot,
      total: String(d.totalAmount),
      currency: d.currency,
      validUntil: d.validUntil ? d.validUntil.toISOString() : null,
      convertedToInvoice: d.convertedToInvoiceId !== null,
      lastEvent: lastByQuote.get(d.id) ?? null,
    }));
  });
}
