/**
 * ר1 — what the owner's manual record means for the internal Daily Tasks reminders. SERVER-ONLY, read only.
 * Nothing here sends anything to a customer.
 *
 *   S08 (validity ends): a quote with an in-force response recorded on its CURRENT version is closed. A note, a
 *       download, a share sheet or a "sent" never closes it; a corrected response no longer counts; a response on an
 *       older version of the quote decides nothing.
 *   S09 (no reply recorded): QUOTE_FOLLOWUP_DAYS Israel days after the latest in-force MARKED_SENT on the current
 *       version, while no in-force response is recorded on it; never for a converted or a Service Desk quote.
 */
import { addCalendarDays, daysBetweenDayKeys, jerusalemDayKey, type JerusalemDayKey } from "@/lib/utils/jerusalem-day";

import type { BdTx } from "../bd-tx";
import { currentQuoteContent } from "./quote-share-read";
import { closesValidityReminder, deriveShareState, followUpDue, QUOTE_FOLLOWUP_DAYS, type ShareEventKind, type ShareEventRow } from "./quote-share-state";

async function eventsByQuote(tx: BdTx, businessId: number, quoteIds: number[]): Promise<Map<number, ShareEventRow[]>> {
  const rows = quoteIds.length
    ? await tx.quoteShareEvent.findMany({
        where: { businessId, quoteDocumentId: { in: quoteIds } },
        select: { id: true, quoteDocumentId: true, kind: true, copyId: true, correctsEventId: true, quoteContentHash: true, createdAt: true },
      })
    : [];
  const out = new Map<number, ShareEventRow[]>();
  for (const r of rows) {
    const list = out.get(r.quoteDocumentId) ?? [];
    list.push({ id: r.id, kind: r.kind as ShareEventKind, copyId: r.copyId, correctsEventId: r.correctsEventId, quoteContentHash: r.quoteContentHash, createdAt: r.createdAt });
    out.set(r.quoteDocumentId, list);
  }
  return out;
}

/** S08: of these quotes, the ones the owner's record closes. */
export async function quotesClosedByResponse(tx: BdTx, businessId: number, quoteIds: number[]): Promise<Set<number>> {
  const closed = new Set<number>();
  const events = await eventsByQuote(tx, businessId, quoteIds);
  for (const [quoteId, list] of events) {
    if (!list.some((e) => e.kind === "RESPONSE_ACCEPTED" || e.kind === "RESPONSE_DECLINED")) continue;
    const current = await currentQuoteContent(tx, businessId, quoteId);
    if (current && closesValidityReminder(deriveShareState(list, current.hash))) closed.add(quoteId);
  }
  return closed;
}

export type FollowUpItem = { quoteId: number; number: string | null; customerName: string | null; sentEventId: number; sentDay: JerusalemDayKey; dueOn: JerusalemDayKey };

/** S09: quotes due for a follow-up today (sent ≥ QUOTE_FOLLOWUP_DAYS days ago on this version, no response). */
export async function selectFollowUps(tx: BdTx, businessId: number, today: JerusalemDayKey, cap: number): Promise<{ items: FollowUpItem[]; capped: boolean }> {
  const sentRows = await tx.quoteShareEvent.findMany({
    where: { businessId, kind: "MARKED_SENT" },
    distinct: ["quoteDocumentId"],
    orderBy: [{ quoteDocumentId: "asc" }],
    select: { quoteDocumentId: true },
    take: cap * 4,
  });
  const ids = sentRows.map((r) => r.quoteDocumentId);
  const events = await eventsByQuote(tx, businessId, ids);
  const items: FollowUpItem[] = [];
  for (const quoteId of ids) {
    const current = await currentQuoteContent(tx, businessId, quoteId);
    if (!current || current.rows.serviceDesk || current.rows.doc.convertedToInvoiceId !== null) continue;
    const state = deriveShareState(events.get(quoteId) ?? [], current.hash);
    if (!state.sent) continue;
    const sentDay = jerusalemDayKey(state.sent.at);
    if (!followUpDue(state, daysBetweenDayKeys(sentDay, today))) continue;
    items.push({
      quoteId,
      number: current.rows.doc.documentNumberFormatted,
      customerName: current.rows.doc.customerNameSnapshot,
      sentEventId: state.sent.eventId,
      sentDay,
      dueOn: addCalendarDays(sentDay, QUOTE_FOLLOWUP_DAYS),
    });
  }
  items.sort((a, b) => (a.dueOn === b.dueOn ? a.quoteId - b.quoteId : a.dueOn < b.dueOn ? -1 : 1));
  return { items: items.slice(0, cap), capped: items.length > cap || sentRows.length >= cap * 4 };
}
