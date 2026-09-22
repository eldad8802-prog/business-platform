import { Prisma } from "@prisma/client";
import { billingTenantTx } from "@/lib/services/billing/billing-tenant-tx";
import { loadAwaitingPaymentList } from "@/lib/services/billing/collection/awaiting-payment.loader";

/**
 * The collection action inbox — ONE read model for /collection.
 *
 * Four segments, each derived only from server state that Dubiz holds with
 * authority. Nothing here is guessed, and nothing a provider did not establish
 * is reported as having happened.
 *
 *   צריך לגבות  toCollect   customers with a due, economically outstanding debt
 *   ממתין        waiting     a payment request is open and nothing terminal is known
 *   דורש טיפול   attention   something a person must decide: a payment the
 *                            provider REFUSED, a link whose own stated expiry
 *                            passed, a verified payment whose receipt is paused,
 *                            or verified money that settles no debt (excess)
 *   שולם         paid        verified money in, with its accounting state —
 *                            bounded to the recent window, never an endless dump
 *
 * A request cancelled by the owner that the customer paid anyway is PAID: the
 * money is the fact. It appears once, under paid, never twice.
 */

export type InboxRequestState =
  | "WAITING"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED"
  | "PAID";

export type InboxAccounting =
  /** One receipt issued and allocated. */
  | "RECEIPTED"
  /** Verified; the receipt is being produced (inline or by recovery). */
  | "RECEIPT_PENDING"
  /** Verified; receipt paused on a cause a person must resolve. */
  | "RECEIPT_ATTENTION"
  /** Verified before automatic receipts existed — no automatic receipt. */
  | "NO_AUTOMATIC_RECEIPT";

export type InboxRequestItem = {
  requestId: number;
  customerId: number | null;
  customerName: string | null;
  invoiceId: number | null;
  invoiceNumber: string | null;
  amount: string;
  currency: string;
  state: InboxRequestState;
  createdAt: string;
  paidAt: string | null;
  paymentUrl: string | null;
};

export type InboxPaidItem = InboxRequestItem & {
  paymentTransactionId: number | null;
  accounting: InboxAccounting;
  attentionReason: string | null;
  receiptId: number | null;
  receiptNumber: string | null;
  allocatedAmount: string | null;
  unappliedAmount: string | null;
};

export type InboxAttentionItem =
  | { kind: "PAYMENT_FAILED" | "LINK_EXPIRED"; request: InboxRequestItem }
  | {
      kind: "RECEIPT_ATTENTION";
      request: InboxRequestItem;
      paymentTransactionId: number;
      reason: string;
    }
  | {
      kind: "UNAPPLIED_EXCESS";
      request: InboxRequestItem;
      paymentTransactionId: number;
      receiptId: number;
      receiptNumber: string | null;
      unappliedAmount: string;
      refundedAmount: string;
    };

export type InboxDebtCustomer = {
  customerId: number | null;
  customerName: string | null;
  customerPhone: string | null;
  totalOutstanding: string;
  currency: string;
  awaitingSince: string | null;
  invoices: {
    id: number;
    documentNumber: string | null;
    outstanding: string;
    currency: string;
    isPartiallySettled: boolean;
  }[];
  /** An open request already exists for this customer — nudge, don't duplicate. */
  openRequestCount: number;
};

export type CollectionInbox = {
  /** How the business signs a message to its customer. */
  businessName: string;
  summary: {
    toCollect: { amount: string; count: number; currency: string | null };
    waiting: { amount: string; count: number };
    attention: { count: number };
    paidRecent: { amount: string; count: number };
  };
  toCollect: InboxDebtCustomer[];
  waiting: InboxRequestItem[];
  attention: InboxAttentionItem[];
  paid: InboxPaidItem[];
  /** Cursor for older paid items, or null when there are none. */
  paidNextBefore: string | null;
};

export const PAID_WINDOW_DAYS = 30;
export const PAID_PAGE_SIZE = 20;
export const ATTENTION_WINDOW_DAYS = 90;

const dec = (v: Prisma.Decimal | null | undefined) =>
  (v ?? new Prisma.Decimal(0)).toFixed(2);

export async function loadCollectionInbox(
  businessId: number,
  opts: { now?: Date; paidBefore?: Date | null } = {}
): Promise<CollectionInbox> {
  const now = opts.now ?? new Date();
  const paidSince = new Date(now.getTime() - PAID_WINDOW_DAYS * 86400_000);
  const attentionSince = new Date(now.getTime() - ATTENTION_WINDOW_DAYS * 86400_000);

  const debts = await loadAwaitingPaymentList(businessId, now);

  const data = await billingTenantTx(businessId, async (tx) => {
    const requestSelect = {
      id: true,
      customerId: true,
      billingDocumentId: true,
      amount: true,
      currency: true,
      status: true,
      expiresAt: true,
      createdAt: true,
      paidAt: true,
      paymentUrl: true,
      customer: { select: { name: true } },
      billingDocument: {
        select: { documentNumberFormatted: true, customerNameSnapshot: true },
      },
      transactions: {
        where: { status: "PAID" as const },
        select: { id: true, amount: true },
        orderBy: { id: "asc" as const },
      },
    };

    const open = await tx.paymentRequest.findMany({
      where: { businessId, status: "PENDING" },
      select: requestSelect,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const failedOrExpired = await tx.paymentRequest.findMany({
      where: {
        businessId,
        status: { in: ["FAILED", "EXPIRED"] },
        updatedAt: { gte: attentionSince },
      },
      select: requestSelect,
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    // Paid is read from the verified MONEY, not from the request's status or
    // paidAt: a request the owner cancelled can still be paid through its
    // link, and that payment must not vanish from view.
    const paidTxs = await tx.paymentTransaction.findMany({
      where: {
        status: "PAID",
        amount: { gt: 0 },
        paymentRequest: { businessId },
        createdAt: opts.paidBefore ? { lt: opts.paidBefore } : { gte: paidSince },
      },
      select: {
        id: true,
        amount: true,
        currency: true,
        createdAt: true,
        paymentRequest: { select: requestSelect },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PAID_PAGE_SIZE + 1,
    });
    const attentionSettlements = await tx.paymentAccountingSettlement.findMany({
      where: { businessId, status: "REQUIRES_ATTENTION" },
      select: {
        paymentTransactionId: true,
        attentionReason: true,
        paymentTransaction: { select: { paymentRequest: { select: requestSelect } } },
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    const excessReceipts = await tx.billingDocument.findMany({
      where: {
        businessId,
        documentType: "RECEIPT",
        status: "ISSUED",
        unappliedAmount: { gt: 0 },
        sourcePaymentTransactionId: { not: null },
        issuedAt: { gte: attentionSince },
      },
      select: {
        id: true,
        documentNumberFormatted: true,
        unappliedAmount: true,
        sourcePaymentTransactionId: true,
        sourcePaymentTransaction: {
          select: {
            paymentRequest: {
              select: {
                ...requestSelect,
                transactions: { select: { id: true, amount: true, status: true } },
              },
            },
          },
        },
      },
      orderBy: { issuedAt: "desc" },
      take: 50,
    });

    // Accounting state for the paid page, by the verified transaction.
    const paidTxIds = paidTxs.map((t) => t.id);
    const settlements = paidTxIds.length
      ? await tx.paymentAccountingSettlement.findMany({
          where: { businessId, paymentTransactionId: { in: paidTxIds } },
          select: { paymentTransactionId: true, status: true, attentionReason: true },
        })
      : [];
    const receipts = paidTxIds.length
      ? await tx.billingDocument.findMany({
          where: { businessId, sourcePaymentTransactionId: { in: paidTxIds }, status: "ISSUED" },
          select: {
            id: true,
            documentNumberFormatted: true,
            unappliedAmount: true,
            sourcePaymentTransactionId: true,
            paymentAllocationsAsReceipt: { select: { allocatedAmount: true } },
          },
        })
      : [];

    const business = await tx.business.findUnique({
      where: { id: businessId },
      select: { name: true, profile: { select: { billingLegalName: true } } },
    });
    const businessName =
      (business?.profile?.billingLegalName ?? "").trim() || business?.name || "";
    return { open, failedOrExpired, paidTxs, attentionSettlements, excessReceipts, settlements, receipts, businessName };
  });

  type Row = (typeof data.open)[number];
  const toItem = (r: Row, state: InboxRequestState): InboxRequestItem => ({
    requestId: r.id,
    customerId: r.customerId,
    customerName: r.customer?.name ?? r.billingDocument?.customerNameSnapshot ?? null,
    invoiceId: r.billingDocumentId,
    invoiceNumber: r.billingDocument?.documentNumberFormatted ?? null,
    amount: dec(r.amount),
    currency: r.currency,
    state,
    createdAt: r.createdAt.toISOString(),
    paidAt: r.paidAt ? r.paidAt.toISOString() : null,
    paymentUrl: r.paymentUrl,
  });
  const verifiedTx = (r: Row) => r.transactions.find((t) => t.amount.greaterThan(0)) ?? null;

  // ── ממתין / expired-by-its-own-stated-expiry ────────────────────────────
  const waiting: InboxRequestItem[] = [];
  const attention: InboxAttentionItem[] = [];
  for (const r of data.open) {
    if (verifiedTx(r)) continue; // money arrived: it is paid, shown once, below
    if (r.expiresAt && r.expiresAt.getTime() < now.getTime()) {
      attention.push({ kind: "LINK_EXPIRED", request: toItem(r, "EXPIRED") });
    } else {
      waiting.push(toItem(r, "WAITING"));
    }
  }
  for (const r of data.failedOrExpired) {
    if (verifiedTx(r)) continue;
    attention.push({
      kind: r.status === "FAILED" ? "PAYMENT_FAILED" : "LINK_EXPIRED",
      request: toItem(r, r.status === "FAILED" ? "FAILED" : "EXPIRED"),
    });
  }
  for (const s of data.attentionSettlements) {
    const r = s.paymentTransaction.paymentRequest;
    attention.push({
      kind: "RECEIPT_ATTENTION",
      request: toItem(r, "PAID"),
      paymentTransactionId: s.paymentTransactionId,
      reason: s.attentionReason ?? "UNKNOWN",
    });
  }
  for (const rc of data.excessReceipts) {
    const r = rc.sourcePaymentTransaction?.paymentRequest;
    if (!r || rc.sourcePaymentTransactionId === null) continue;
    // A refund (settled reversal) is money returned — it is what resolves an
    // excess from the owner's side. Anything not yet returned stays visible.
    const refunded = r.transactions
      .filter((t) => t.status === "PAID" && t.amount.lessThan(0))
      .reduce((a, t) => a.plus(t.amount.negated()), new Prisma.Decimal(0));
    if (refunded.greaterThanOrEqualTo(rc.unappliedAmount)) continue;
    attention.push({
      kind: "UNAPPLIED_EXCESS",
      request: toItem(r as unknown as Row, "PAID"),
      paymentTransactionId: rc.sourcePaymentTransactionId,
      receiptId: rc.id,
      receiptNumber: rc.documentNumberFormatted,
      unappliedAmount: dec(rc.unappliedAmount),
      refundedAmount: dec(refunded),
    });
  }

  // ── שולם ────────────────────────────────────────────────────────────────
  const hasMore = data.paidTxs.length > PAID_PAGE_SIZE;
  const paidPage = data.paidTxs.slice(0, PAID_PAGE_SIZE);
  const paid: InboxPaidItem[] = paidPage.map((t) => {
    const r = t.paymentRequest;
    const s = data.settlements.find((x) => x.paymentTransactionId === t.id);
    const rc = data.receipts.find((x) => x.sourcePaymentTransactionId === t.id);
    const accounting: InboxAccounting = rc
      ? "RECEIPTED"
      : !s
        ? "NO_AUTOMATIC_RECEIPT"
        : s.status === "REQUIRES_ATTENTION"
          ? "RECEIPT_ATTENTION"
          : "RECEIPT_PENDING";
    return {
      ...toItem(r, "PAID"),
      amount: dec(t.amount),
      currency: t.currency,
      paidAt: t.createdAt.toISOString(),
      paymentTransactionId: t.id,
      accounting,
      attentionReason: s?.attentionReason ?? null,
      receiptId: rc?.id ?? null,
      receiptNumber: rc?.documentNumberFormatted ?? null,
      allocatedAmount: rc
        ? dec(rc.paymentAllocationsAsReceipt.reduce((a, x) => a.plus(x.allocatedAmount), new Prisma.Decimal(0)))
        : null,
      unappliedAmount: rc ? dec(rc.unappliedAmount) : null,
    };
  });

  // ── צריך לגבות ──────────────────────────────────────────────────────────
  const openByCustomer = new Map<number, number>();
  for (const w of waiting) {
    if (w.customerId !== null) openByCustomer.set(w.customerId, (openByCustomer.get(w.customerId) ?? 0) + 1);
  }
  const toCollect: InboxDebtCustomer[] = debts.customers.map((c) => ({
    customerId: c.customerId,
    customerName: c.customerName,
    customerPhone: c.customerPhone,
    totalOutstanding: c.totalOutstanding.toFixed(2),
    currency: c.currency,
    awaitingSince: c.awaitingSince ? c.awaitingSince.toISOString() : null,
    invoices: c.invoices.map((i) => ({
      id: i.id,
      documentNumber: i.documentNumber,
      outstanding: i.outstanding.toFixed(2),
      currency: i.currency,
      isPartiallySettled: i.isPartiallySettled,
    })),
    openRequestCount: c.customerId !== null ? (openByCustomer.get(c.customerId) ?? 0) : 0,
  }));

  const sum = (xs: { amount: string }[]) =>
    xs.reduce((a, x) => a.plus(x.amount), new Prisma.Decimal(0)).toFixed(2);

  return {
    businessName: data.businessName,
    summary: {
      toCollect: {
        amount: debts.totalOutstanding.toFixed(2),
        count: debts.customerCount,
        currency: debts.customers[0]?.currency ?? null,
      },
      waiting: { amount: sum(waiting), count: waiting.length },
      attention: { count: attention.length },
      paidRecent: { amount: sum(paid), count: paid.length },
    },
    toCollect,
    waiting,
    attention,
    paid,
    paidNextBefore: hasMore && paidPage.length ? paidPage[paidPage.length - 1].createdAt.toISOString() : null,
  };
}
