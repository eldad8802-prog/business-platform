/**
 * Revenue truth — the read model. Pure: evidence in, one view out. docs/revenue-truth-milestone-a.md.
 *
 * THE RULE THAT PREVENTS DOUBLE COUNTING
 *   Revenue is recognised at the SALE layer only, from ONE authoritative source per register day:
 *     - a register day with an effective Z is counted from the Z; that day's POS sales and till receipts are
 *       excluded (COVERED_BY_CLOSE) and only compared (variance);
 *     - a register day without one is counted from its POS sales (PROVISIONAL today, UNCLOSED after);
 *     - a Dubiz tax invoice / invoice-receipt is a sale unless a confirmed link says it IS a register sale
 *       (SAME_AS_SALE), in which case the register already counts it;
 *     - receipts, settlements and bank deposits NEVER add to sales: they close what a sale opened. An invoice
 *       and the payment for it are one sale and one receipt.
 *   A link counts only once CONFIRMED (its latest decision). A Z counts only as the latest revision of its
 *   chain, not rejected, not failed validation, and — when read from a photo / scan — confirmed.
 *
 * MONEY
 *   bigint minor units, kept PER CURRENCY. Nothing here adds two currencies; `requireSingleCurrency` throws
 *   CurrencyMismatchError when asked for one figure over a mixed view.
 *
 * NOT CONNECTED: no route, page, job or learning engine calls this in milestone A.
 */
import type { CurrencyCode } from "@/lib/money/currency";
import { CurrencyMismatchError } from "@/lib/money/money";
import { dayKeyIsBefore, type JerusalemDayKey } from "@/lib/utils/jerusalem-day";
import type { DailyClose, Decision, DecisionKind, Link, RevenueInputs, TenderMethod } from "./types";

const ZERO = BigInt(0);

export type ReceiptChannel = TenderMethod | "PAYMENT_PROVIDER" | "DUBIZ_DOCUMENT";

export type SalesTotals = {
  /** VAT-inclusive sales before discounts. */
  grossMinor: bigint;
  discountMinor: bigint;
  refundsMinor: bigint;
  voidsMinor: bigint;
  /** gross − discounts − refunds − voids, VAT included. */
  netMinor: bigint;
  vatMinor: bigint;
  /** net − VAT. */
  netExVatMinor: bigint;
  /** The part of net counted from closed register days (Z). */
  closedNetMinor: bigint;
  /** The part of net counted from today's POS stream, before its Z. */
  provisionalNetMinor: bigint;
  /** The part of net counted from past POS days that never got a Z. */
  unclosedNetMinor: bigint;
  /** The part of net counted from Dubiz documents. */
  documentNetMinor: bigint;
};

export type ReceiptTotals = {
  inMinor: bigint;
  outMinor: bigint;
  netMinor: bigint;
  /** Money in, by channel. */
  byChannel: Partial<Record<ReceiptChannel, bigint>>;
};

export type SettlementTotals = { grossMinor: bigint; feesMinor: bigint; otherDeductionsMinor: bigint; netMinor: bigint };
export type DepositTotals = { creditsMinor: bigint; matchedMinor: bigint; unmatchedMinor: bigint };
export type InTransit = {
  /** Card takings not yet linked (confirmed) to an acquirer settlement. */
  cardAwaitingSettlementMinor: bigint;
  /** Settlement net not yet linked (confirmed) to a bank credit. */
  settlementAwaitingDepositMinor: bigint;
  /** Cash takings not yet linked (confirmed) to a bank credit. */
  cashAwaitingDepositMinor: bigint;
};

export type CurrencyView = {
  currency: CurrencyCode;
  sales: SalesTotals;
  receipts: ReceiptTotals;
  settlements: SettlementTotals;
  deposits: DepositTotals;
  inTransit: InTransit;
};

export type RegisterDayStatus = "CLOSED" | "CLOSED_WITH_VARIANCE" | "PROVISIONAL" | "UNCLOSED";

export type RegisterDay = {
  stream: string;
  registerKey: string;
  businessDay: JerusalemDayKey;
  currency: CurrencyCode;
  status: RegisterDayStatus;
  /** What this day contributes to net sales. */
  countedNetMinor: bigint;
  /** Net of the POS sales seen for the day (counted or only compared). */
  posNetMinor: bigint;
  /** Net of the effective Z report(s); null when the day has none. */
  closeNetMinor: bigint | null;
  /** close − POS, when both exist. */
  varianceMinor: bigint | null;
  closeIds: number[];
  /** A Z read from a photo / scan that waits for the owner (the day is not closed by it yet). */
  awaitingConfirmationCloseIds: number[];
};

export type ExclusionReason =
  | "COVERED_BY_CLOSE"
  | "SAME_AS_SALE"
  | "SUPERSEDED"
  | "CLOSE_REJECTED"
  | "CLOSE_AWAITING_CONFIRMATION"
  | "VALIDATION_FAILED"
  | "SAME_RECEIPT_AS_PAYMENT";

export type Exclusion = { kind: "SALE" | "RECEIPT" | "CLOSE" | "DOCUMENT" | "SETTLEMENT"; id: number; reason: ExclusionReason };
export type ReadWarning = { code: "OVER_ALLOCATED" | "CREDIT_NOTE_ON_LINKED_DOCUMENT"; ref: string };

export type RevenueView = {
  byCurrency: ReadonlyMap<CurrencyCode, CurrencyView>;
  days: RegisterDay[];
  excluded: Exclusion[];
  warnings: ReadWarning[];
};

export type ReadOptions = {
  /** Today's Israel business day: register days before it without a Z are UNCLOSED, not PROVISIONAL. */
  today: JerusalemDayKey;
};

function emptyView(currency: CurrencyCode): CurrencyView {
  return {
    currency,
    sales: {
      grossMinor: ZERO, discountMinor: ZERO, refundsMinor: ZERO, voidsMinor: ZERO, netMinor: ZERO, vatMinor: ZERO,
      netExVatMinor: ZERO, closedNetMinor: ZERO, provisionalNetMinor: ZERO, unclosedNetMinor: ZERO, documentNetMinor: ZERO,
    },
    receipts: { inMinor: ZERO, outMinor: ZERO, netMinor: ZERO, byChannel: {} },
    settlements: { grossMinor: ZERO, feesMinor: ZERO, otherDeductionsMinor: ZERO, netMinor: ZERO },
    deposits: { creditsMinor: ZERO, matchedMinor: ZERO, unmatchedMinor: ZERO },
    inTransit: { cardAwaitingSettlementMinor: ZERO, settlementAwaitingDepositMinor: ZERO, cashAwaitingDepositMinor: ZERO },
  };
}

/** One row per id: the same evidence loaded twice is still one piece of evidence. */
function uniqueById<T extends { id: number }>(rows: readonly T[]): T[] {
  const seen = new Map<number, T>();
  for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, r);
  return [...seen.values()];
}

/** The latest decision per subject (decisions are append-only; the highest id is the latest). */
function latestDecisions(decisions: readonly Decision[], subject: "linkId" | "dailyCloseId"): Map<number, DecisionKind> {
  const latest = new Map<number, { id: number; decision: DecisionKind }>();
  for (const d of decisions) {
    const key = d[subject];
    if (key === null) continue;
    const cur = latest.get(key);
    if (!cur || d.id > cur.id) latest.set(key, { id: d.id, decision: d.decision });
  }
  return new Map([...latest].map(([k, v]) => [k, v.decision]));
}

type Bucket = {
  stream: string;
  registerKey: string;
  businessDay: JerusalemDayKey;
  currency: CurrencyCode;
  saleIds: number[];
  receiptIds: number[];
  effective: DailyClose[];
  awaiting: number[];
};

export function computeRevenueView(raw: RevenueInputs, options: ReadOptions): RevenueView {
  const inputs: RevenueInputs = {
    sales: uniqueById(raw.sales), receipts: uniqueById(raw.receipts), closes: uniqueById(raw.closes),
    settlements: uniqueById(raw.settlements), deposits: uniqueById(raw.deposits), documents: uniqueById(raw.documents),
    payments: uniqueById(raw.payments), links: uniqueById(raw.links), decisions: uniqueById(raw.decisions),
  };
  const views = new Map<CurrencyCode, CurrencyView>();
  const view = (c: CurrencyCode) => {
    let v = views.get(c);
    if (!v) { v = emptyView(c); views.set(c, v); }
    return v;
  };
  const excluded: Exclusion[] = [];
  const warnings: ReadWarning[] = [];

  const linkState = latestDecisions(inputs.decisions, "linkId");
  const closeState = latestDecisions(inputs.decisions, "dailyCloseId");
  const confirmed = inputs.links.filter((l) => linkState.get(l.id) === "CONFIRMED");

  // ── Z chains: only the latest revision of each chain can close a day ──────────────────────────
  const chainMax = new Map<string, number>();
  const chainKey = (c: DailyClose) => `${c.sourceScope}|${c.registerKey}|${c.externalId}`;
  for (const c of inputs.closes) chainMax.set(chainKey(c), Math.max(chainMax.get(chainKey(c)) ?? 0, c.revision));

  const buckets = new Map<string, Bucket>();
  const bucket = (stream: string, registerKey: string | null, businessDay: JerusalemDayKey, currency: CurrencyCode) => {
    const key = `${stream}|${registerKey ?? ""}|${businessDay}|${currency}`;
    let b = buckets.get(key);
    if (!b) {
      b = { stream, registerKey: registerKey ?? "", businessDay, currency, saleIds: [], receiptIds: [], effective: [], awaiting: [] };
      buckets.set(key, b);
    }
    return b;
  };
  for (const c of inputs.closes) {
    const b = bucket(c.salesScope ?? c.sourceScope, c.registerKey, c.businessDay, c.currency);
    const state = closeState.get(c.id);
    if (c.revision < (chainMax.get(chainKey(c)) ?? c.revision)) excluded.push({ kind: "CLOSE", id: c.id, reason: "SUPERSEDED" });
    else if (state === "REJECTED") excluded.push({ kind: "CLOSE", id: c.id, reason: "CLOSE_REJECTED" });
    else if (c.validation === "FAILED") excluded.push({ kind: "CLOSE", id: c.id, reason: "VALIDATION_FAILED" });
    else if (c.capture === "FILE_EXTRACTED" && state !== "CONFIRMED") {
      excluded.push({ kind: "CLOSE", id: c.id, reason: "CLOSE_AWAITING_CONFIRMATION" });
      b.awaiting.push(c.id);
    } else b.effective.push(c);
  }
  const saleById = new Map(inputs.sales.map((s) => [s.id, s]));
  const receiptById = new Map(inputs.receipts.map((r) => [r.id, r]));
  for (const s of inputs.sales) bucket(s.sourceScope, s.registerKey, s.businessDay, s.currency).saleIds.push(s.id);
  for (const r of inputs.receipts) bucket(r.sourceScope, r.registerKey, r.businessDay, r.currency).receiptIds.push(r.id);

  // Money objects that are COUNTED (so links on them may close them): till receipts outside closed days,
  // and the tender lines of effective Z reports.
  const countedReceipts = new Set<number>();
  const countedTenders = new Map<number, { method: TenderMethod; amountMinor: bigint; currency: CurrencyCode }>();

  // ── Layer 1 + 2, register stream ─────────────────────────────────────────────────────────────
  const days: RegisterDay[] = [];
  for (const b of buckets.values()) {
    const v = view(b.currency);
    let posNet = ZERO;
    for (const id of b.saleIds) {
      const s = saleById.get(id)!;
      posNet += s.kind === "SALE" ? s.totalMinor : -s.totalMinor;
    }
    const closed = b.effective.length > 0;
    let counted = ZERO;
    if (closed) {
      for (const c of b.effective) {
        v.sales.grossMinor += c.grossMinor;
        v.sales.discountMinor += c.discountMinor;
        v.sales.refundsMinor += c.refundMinor;
        v.sales.voidsMinor += c.voidMinor;
        v.sales.vatMinor += c.vatMinor;
        counted += c.totalMinor;
        for (const t of c.tenders) {
          countedTenders.set(t.id, { method: t.method, amountMinor: t.amountMinor, currency: c.currency });
          addReceipt(v, t.method, t.amountMinor);
        }
      }
      v.sales.closedNetMinor += counted;
      for (const id of b.saleIds) excluded.push({ kind: "SALE", id, reason: "COVERED_BY_CLOSE" });
      for (const id of b.receiptIds) excluded.push({ kind: "RECEIPT", id, reason: "COVERED_BY_CLOSE" });
    } else {
      for (const id of b.saleIds) {
        const s = saleById.get(id)!;
        if (s.kind === "SALE") {
          v.sales.grossMinor += s.grossMinor;
          v.sales.discountMinor += s.discountMinor;
          v.sales.vatMinor += s.vatMinor;
        } else {
          if (s.kind === "REFUND") v.sales.refundsMinor += s.totalMinor;
          else v.sales.voidsMinor += s.totalMinor;
          v.sales.vatMinor -= s.vatMinor;
        }
      }
      counted = posNet;
      if (dayKeyIsBefore(b.businessDay, options.today)) v.sales.unclosedNetMinor += counted;
      else v.sales.provisionalNetMinor += counted;
      for (const id of b.receiptIds) {
        const r = receiptById.get(id)!;
        countedReceipts.add(r.id);
        addReceipt(v, r.method, r.direction === "IN" ? r.amountMinor : -r.amountMinor);
      }
    }
    if (b.saleIds.length === 0 && !closed && b.awaiting.length === 0) continue; // a receipts-only day: no day row
    const closeNet = closed ? b.effective.reduce((sum, c) => sum + c.totalMinor, ZERO) : null;
    const variance = closed && b.saleIds.length > 0 ? closeNet! - posNet : null;
    days.push({
      stream: b.stream, registerKey: b.registerKey, businessDay: b.businessDay, currency: b.currency,
      status: closed
        ? (variance !== null && variance !== ZERO ? "CLOSED_WITH_VARIANCE" : "CLOSED")
        : (dayKeyIsBefore(b.businessDay, options.today) ? "UNCLOSED" : "PROVISIONAL"),
      countedNetMinor: counted, posNetMinor: posNet, closeNetMinor: closeNet, varianceMinor: variance,
      closeIds: b.effective.map((c) => c.id), awaitingConfirmationCloseIds: b.awaiting,
    });
  }

  // ── Layer 1 + 2, Dubiz documents and payments ─────────────────────────────────────────────────
  const docsSameAsSale = new Set(
    confirmed.filter((l) => l.linkKind === "SALE_SAME_AS_DOCUMENT" && l.billingDocumentId !== null).map((l) => l.billingDocumentId!),
  );
  for (const d of inputs.documents) {
    const v = view(d.currency);
    const total = abs(d.totalMinor);
    const vat = abs(d.vatMinor);
    if (docsSameAsSale.has(d.id)) {
      excluded.push({ kind: "DOCUMENT", id: d.id, reason: "SAME_AS_SALE" });
      continue;
    }
    if (d.documentType === "TAX_INVOICE" || d.documentType === "TAX_INVOICE_RECEIPT") {
      v.sales.grossMinor += total;
      v.sales.vatMinor += vat;
      v.sales.documentNetMinor += total;
    } else if (d.documentType === "CREDIT_NOTE") {
      v.sales.refundsMinor += total;
      v.sales.vatMinor -= vat;
      v.sales.documentNetMinor -= total;
      if (d.referenceDocumentId !== null && docsSameAsSale.has(d.referenceDocumentId)) {
        warnings.push({ code: "CREDIT_NOTE_ON_LINKED_DOCUMENT", ref: `document:${d.id}` });
      }
    }
    // The receipt side of a document: a payment and the system receipt issued for it are ONE receipt.
    if (d.documentType === "RECEIPT" || d.documentType === "TAX_INVOICE_RECEIPT") {
      if (d.sourcePaymentTransactionId !== null) excluded.push({ kind: "DOCUMENT", id: d.id, reason: "SAME_RECEIPT_AS_PAYMENT" });
      else addReceipt(v, "DUBIZ_DOCUMENT", total);
    }
  }
  for (const p of inputs.payments) addReceipt(view(p.currency), "PAYMENT_PROVIDER", p.amountMinor);

  // ── Layer 3 ──────────────────────────────────────────────────────────────────────────────────
  const countedSettlements = new Map<number, { grossMinor: bigint; netMinor: bigint; currency: CurrencyCode }>();
  for (const s of inputs.settlements) {
    if (s.validation === "FAILED") { excluded.push({ kind: "SETTLEMENT", id: s.id, reason: "VALIDATION_FAILED" }); continue; }
    const v = view(s.currency);
    v.settlements.grossMinor += s.grossMinor;
    v.settlements.feesMinor += s.feeMinor;
    v.settlements.otherDeductionsMinor += s.otherDeductionsMinor;
    v.settlements.netMinor += s.netMinor;
    countedSettlements.set(s.id, { grossMinor: s.grossMinor, netMinor: s.netMinor, currency: s.currency });
  }

  // ── Allocation: what confirmed links close, never more than the object holds ─────────────────
  const allocated = new Map<string, bigint>();
  const allocate = (key: string, amount: bigint) => allocated.set(key, (allocated.get(key) ?? ZERO) + amount);
  for (const l of confirmed) {
    const amount = l.amountMinor ?? ZERO;
    if (l.linkKind === "TENDER_SETTLED_BY") {
      if (l.receiptId !== null && countedReceipts.has(l.receiptId)) allocate(`card:receipt:${l.receiptId}`, amount);
      if (l.dailyCloseTenderId !== null && countedTenders.has(l.dailyCloseTenderId)) allocate(`card:tender:${l.dailyCloseTenderId}`, amount);
    } else if (l.linkKind === "SETTLEMENT_DEPOSITED_AS") {
      if (l.settlementId !== null && countedSettlements.has(l.settlementId)) allocate(`settlement:${l.settlementId}`, amount);
      if (l.externalTransactionId !== null) allocate(`bank:${l.externalTransactionId}`, amount);
    } else if (l.linkKind === "CASH_DEPOSITED_AS") {
      if (l.receiptId !== null && countedReceipts.has(l.receiptId)) allocate(`cash:receipt:${l.receiptId}`, amount);
      if (l.dailyCloseTenderId !== null && countedTenders.has(l.dailyCloseTenderId)) allocate(`cash:tender:${l.dailyCloseTenderId}`, amount);
      if (l.externalTransactionId !== null) allocate(`bank:${l.externalTransactionId}`, amount);
    }
  }
  const closedPart = (key: string, holds: bigint) => {
    const a = allocated.get(key) ?? ZERO;
    if (a > holds) { warnings.push({ code: "OVER_ALLOCATED", ref: key }); return holds; }
    return a;
  };

  for (const r of inputs.receipts) {
    if (!countedReceipts.has(r.id) || r.direction !== "IN") continue;
    const v = view(r.currency);
    if (r.method === "CARD") v.inTransit.cardAwaitingSettlementMinor += r.amountMinor - closedPart(`card:receipt:${r.id}`, r.amountMinor);
    if (r.method === "CASH") v.inTransit.cashAwaitingDepositMinor += r.amountMinor - closedPart(`cash:receipt:${r.id}`, r.amountMinor);
  }
  for (const [id, t] of countedTenders) {
    if (t.amountMinor <= ZERO) continue;
    const v = view(t.currency);
    if (t.method === "CARD") v.inTransit.cardAwaitingSettlementMinor += t.amountMinor - closedPart(`card:tender:${id}`, t.amountMinor);
    if (t.method === "CASH") v.inTransit.cashAwaitingDepositMinor += t.amountMinor - closedPart(`cash:tender:${id}`, t.amountMinor);
  }
  for (const [id, s] of countedSettlements) {
    if (s.netMinor <= ZERO) continue;
    view(s.currency).inTransit.settlementAwaitingDepositMinor += s.netMinor - closedPart(`settlement:${id}`, s.netMinor);
  }

  // ── Layer 4: bank credits are money in, never sales ──────────────────────────────────────────
  for (const d of inputs.deposits) {
    const v = view(d.currency);
    const matched = closedPart(`bank:${d.id}`, d.amountMinor);
    v.deposits.creditsMinor += d.amountMinor;
    v.deposits.matchedMinor += matched;
    v.deposits.unmatchedMinor += d.amountMinor - matched;
  }

  for (const v of views.values()) {
    const s = v.sales;
    s.netMinor = s.grossMinor - s.discountMinor - s.refundsMinor - s.voidsMinor;
    s.netExVatMinor = s.netMinor - s.vatMinor;
    v.receipts.netMinor = v.receipts.inMinor - v.receipts.outMinor;
  }
  days.sort((a, b) => (a.businessDay === b.businessDay ? a.stream.localeCompare(b.stream) || a.registerKey.localeCompare(b.registerKey) : a.businessDay < b.businessDay ? -1 : 1));
  return { byCurrency: views, days, excluded, warnings };
}

/** A signed amount into a channel: positive is money in, negative is money paid back. */
function addReceipt(v: CurrencyView, channel: ReceiptChannel, signedMinor: bigint): void {
  if (signedMinor >= ZERO) {
    v.receipts.inMinor += signedMinor;
    v.receipts.byChannel[channel] = (v.receipts.byChannel[channel] ?? ZERO) + signedMinor;
  } else {
    v.receipts.outMinor += -signedMinor;
  }
}

function abs(n: bigint): bigint {
  return n < ZERO ? -n : n;
}

/**
 * The one figure a single-currency caller may ask for. A view with more than one currency has no single
 * figure until someone converts it under an explicit policy (lib/money/fx.ts) — so this throws.
 */
export function requireSingleCurrency(view: RevenueView): CurrencyView | null {
  const currencies = [...view.byCurrency.keys()];
  if (currencies.length > 1) throw new CurrencyMismatchError(currencies[0], currencies[1]);
  return currencies.length === 1 ? view.byCurrency.get(currencies[0])! : null;
}

/** Links whose latest decision is CONFIRMED — the only ones the view lets close anything. */
export function confirmedLinks(links: readonly Link[], decisions: readonly Decision[]): Link[] {
  const state = latestDecisions(decisions, "linkId");
  return links.filter((l) => state.get(l.id) === "CONFIRMED");
}
