/**
 * Run: npx tsx lib/services/billing/settlement/foreign-currency-document-hold.test.ts   (from the repo root)
 *
 * FOREIGN CURRENCY — the money is recorded, the receipt waits.
 *
 * Until the accounting rules for foreign-currency tax documents are approved
 * (docs/i18n-multicurrency/ARCHITECTURE.md), no path may issue a receipt in a
 * currency other than ILS on its own. This drives the REAL settlement code —
 * settleVerifiedPayment, releaseDocumentIssuerHolds (the "business has now
 * decided who issues documents" path), requeueSettlement, the owner's
 * resolve-and-retry and the scheduled recovery sweep — against an in-process
 * fake of the Prisma client (installed on the lib/prisma singleton before any
 * module loads), so no database is needed. Every receipt-creating call on the
 * fake is a recorded violation: the hold must stop before any receipt work.
 *
 * The real-PostgreSQL proof of the same hold is case X of .c3settlement/battery.mts.
 */
import { Prisma } from "@prisma/client";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`OK: ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

// ── the fake database ─────────────────────────────────────────────────────
type SettlementRow = {
  id: number;
  businessId: number;
  paymentTransactionId: number;
  status: "PENDING" | "SETTLED" | "REQUIRES_ATTENTION";
  attentionReason: string | null;
  attemptCount: number;
  nextAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  lastError: string | null;
  settledAt: Date | null;
};
type PaymentRow = {
  id: number;
  businessId: number;
  provider: string;
  status: string;
  amount: Prisma.Decimal;
  currency: string;
  paymentRequestId: number;
  providerTransactionId: string | null;
  rawPayload: unknown;
  createdAt: Date;
  paymentRequest: {
    id: number;
    businessId: number;
    currency: string;
    amount: Prisma.Decimal;
    billingDocumentId: number | null;
    customerId: number | null;
  };
};
type InvoiceRow = {
  id: number;
  businessId: number;
  documentType: "TAX_INVOICE";
  status: "ISSUED";
  currency: string;
  totalAmount: Prisma.Decimal;
  customerId: number | null;
  customerNameSnapshot: string | null;
};

const db = {
  settlements: [] as SettlementRow[],
  payments: [] as PaymentRow[],
  invoices: [] as InvoiceRow[],
  connections: [] as { businessId: number; provider: string; documentIssuer: string }[],
  audits: [] as { eventType: string; metadata: Record<string, unknown> }[],
  violations: [] as string[],
};
let nextId = 1;

function sqlOf(strings: TemplateStringsArray | string[]): string {
  return Array.from(strings).join("?");
}

function model(name: string, impl: Record<string, (args: any) => unknown>) {
  return new Proxy(impl, {
    get(target, prop: string) {
      if (prop in target) return async (args: any) => target[prop](args);
      return async () => {
        db.violations.push(`${name}.${prop}`);
        throw new Error(`fake: ${name}.${prop} is not expected on this path`);
      };
    },
  });
}

const tx: Record<string, unknown> = {
  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = sqlOf(strings);
    if (sql.includes("set_config")) return [];
    if (sql.includes('FROM "PaymentAccountingSettlement"') && sql.includes("SKIP LOCKED")) {
      const businessId = values[0] as number;
      return db.settlements
        .filter((s) => s.businessId === businessId && s.status === "PENDING")
        .map((s) => ({ paymentTransactionId: s.paymentTransactionId }));
    }
    if (sql.includes('FROM "PaymentAccountingSettlement"') && sql.includes("FOR UPDATE")) {
      const [paymentTransactionId, businessId] = values as [number, number];
      const row = db.settlements.find(
        (s) => s.paymentTransactionId === paymentTransactionId && s.businessId === businessId
      );
      return row ? [{ id: row.id, status: row.status, attemptCount: row.attemptCount }] : [];
    }
    if (sql.includes('FROM "BillingDocument"') && sql.includes("FOR UPDATE")) return [];
    db.violations.push(`$queryRaw:${sql.slice(0, 60)}`);
    throw new Error("fake: unexpected raw query");
  },
  paymentAccountingSettlement: model("paymentAccountingSettlement", {
    findUniqueOrThrow: ({ where }) => {
      const r = db.settlements.find((s) => s.id === where.id);
      if (!r) throw new Error("not found");
      return { ...r };
    },
    findUnique: ({ where }) => {
      const r = db.settlements.find((s) =>
        where.id !== undefined ? s.id === where.id : s.paymentTransactionId === where.paymentTransactionId
      );
      return r ? { ...r } : null;
    },
    findFirst: ({ where }) => {
      const r = db.settlements.find(
        (s) => s.businessId === where.businessId && s.paymentTransactionId === where.paymentTransactionId
      );
      if (!r) return null;
      const p = db.payments.find((x) => x.id === r.paymentTransactionId)!;
      return {
        status: r.status,
        attentionReason: r.attentionReason,
        paymentTransaction: { paymentRequest: { ...p.paymentRequest } },
      };
    },
    findMany: ({ where }) =>
      db.settlements
        .filter(
          (s) =>
            s.businessId === where.businessId &&
            s.status === where.status &&
            s.attentionReason === where.attentionReason &&
            db.payments.find((p) => p.id === s.paymentTransactionId)?.provider ===
              where.paymentTransaction?.provider
        )
        .map((s) => ({ id: s.id, paymentTransactionId: s.paymentTransactionId })),
    update: ({ where, data }) => {
      const r = db.settlements.find((s) => s.id === where.id);
      if (!r) throw new Error("not found");
      Object.assign(r, data);
      return { ...r };
    },
  }),
  paymentTransaction: model("paymentTransaction", {
    findFirst: ({ where }) => {
      const p = db.payments.find(
        (x) =>
          x.id === where.id &&
          (where.paymentRequest?.businessId === undefined || x.businessId === where.paymentRequest.businessId)
      );
      return p ? { ...p, paymentRequest: { ...p.paymentRequest } } : null;
    },
  }),
  billingDocument: model("billingDocument", {
    findFirst: ({ where }) => {
      if (where.sourcePaymentTransactionId !== undefined) return null; // no receipt exists
      const inv = db.invoices.find((d) => d.id === where.id && d.businessId === where.businessId);
      return inv ? { ...inv } : null;
    },
  }),
  businessPaymentConnection: model("businessPaymentConnection", {
    findFirst: ({ where }) => {
      const c = db.connections.find((x) => x.businessId === where.businessId && x.provider === where.provider);
      return c ? { documentIssuer: c.documentIssuer } : null;
    },
  }),
  // Reached only by the ILS controls: a named customer, and an incomplete
  // billing profile so the ILS path stops at its usual, receipt-less pause.
  customer: model("customer", {
    findFirst: ({ where }) => ({ id: where.id, name: "FX Customer" }),
  }),
  businessProfile: model("businessProfile", {
    findUnique: () => null,
  }),
  paymentAuditEvent: model("paymentAuditEvent", {
    create: ({ data }) => {
      db.audits.push({ eventType: data.eventType, metadata: data.metadata });
      return data;
    },
  }),
};
const txProxy = new Proxy(tx, {
  get(target, prop: string) {
    if (prop in target) return target[prop];
    if (typeof prop === "symbol" || prop === "then") return undefined;
    return model(prop, {});
  },
});

const fakePrisma = {
  async $transaction(fn: (t: unknown) => Promise<unknown>) {
    return fn(txProxy);
  },
  business: {
    async findUnique() {
      return { deletionRequestedAt: null, deletedAt: null };
    },
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

// ── fixtures ────────────────────────────────────────────────────────────────
const BIZ = 7101;

function seedPayment(opts: {
  currency: string;
  provider?: string;
  invoiceCurrency?: string | null; // null → standalone (no invoice)
  documentIssuer?: string | null; // null → no connection row
  status?: SettlementRow["status"];
  attentionReason?: string | null;
  attemptCount?: number;
}): number {
  const provider = opts.provider ?? "CARDCOM";
  const amount = new Prisma.Decimal("250.00");
  let invoiceId: number | null = null;
  if (opts.invoiceCurrency) {
    invoiceId = nextId++;
    db.invoices.push({
      id: invoiceId,
      businessId: BIZ,
      documentType: "TAX_INVOICE",
      status: "ISSUED",
      currency: opts.invoiceCurrency,
      totalAmount: new Prisma.Decimal("1000.00"),
      customerId: 1,
      customerNameSnapshot: "FX Customer",
    });
  }
  const requestId = nextId++;
  const ptxId = nextId++;
  db.payments.push({
    id: ptxId,
    businessId: BIZ,
    provider,
    status: "PAID",
    amount,
    currency: opts.currency,
    paymentRequestId: requestId,
    providerTransactionId: `ptx-${ptxId}`,
    rawPayload: {},
    createdAt: new Date("2026-10-22T08:00:00Z"),
    paymentRequest: {
      id: requestId,
      businessId: BIZ,
      currency: opts.currency,
      amount,
      billingDocumentId: invoiceId,
      customerId: 1,
    },
  });
  if (opts.documentIssuer !== null) {
    const existing = db.connections.find((c) => c.businessId === BIZ && c.provider === provider);
    if (existing) existing.documentIssuer = opts.documentIssuer ?? "DUBIZ_ISSUES";
    else db.connections.push({ businessId: BIZ, provider, documentIssuer: opts.documentIssuer ?? "DUBIZ_ISSUES" });
  }
  db.settlements.push({
    id: nextId++,
    businessId: BIZ,
    paymentTransactionId: ptxId,
    status: opts.status ?? "PENDING",
    attentionReason: opts.attentionReason ?? null,
    attemptCount: opts.attemptCount ?? 0,
    nextAttemptAt: null,
    lastAttemptAt: null,
    lastError: null,
    settledAt: null,
  });
  return ptxId;
}
const settlementOf = (ptxId: number) => db.settlements.find((s) => s.paymentTransactionId === ptxId)!;
const paymentOf = (ptxId: number) => db.payments.find((p) => p.id === ptxId)!;
function resetConnections() {
  db.connections.length = 0;
}

async function main() {
  const svc = await import("./payment-accounting-settlement.service");
  const { resolveAndRetrySettlement } = await import("./settlement-resolution.service");
  const { runSettlementRecovery } = await import("./payment-settlement-recovery.service");
  const { moneyHe } = await import("@/lib/i18n/messages/areas/money");
  const { moneyEn } = await import("@/lib/i18n/messages/areas/money.en");
  const { getProviderDescriptor } = await import("@/lib/services/payments/providers/provider-registry");

  const at = new Date("2026-10-22T09:00:00Z");
  const deps = { now: () => at };

  // ── the pure rule ────────────────────────────────────────────────────────
  ok("the base currency is ILS", svc.AUTOMATIC_DOCUMENT_CURRENCY === "ILS");
  ok("ILS → no hold", svc.foreignCurrencyDocumentHoldFor("ILS") === null);
  ok("ils / ' ILS ' → no hold (normalised like the settlement)", svc.foreignCurrencyDocumentHoldFor("ils") === null && svc.foreignCurrencyDocumentHoldFor(" ILS ") === null);
  for (const c of ["USD", "EUR", "usd", "GBP", "XYZ", ""]) {
    ok(`${JSON.stringify(c)} → FOREIGN_CURRENCY_DOCUMENT_HELD`, svc.foreignCurrencyDocumentHoldFor(c) === "FOREIGN_CURRENCY_DOCUMENT_HELD");
  }
  ok("the hold is NON-RETRYABLE", svc.NON_RETRYABLE_ATTENTION_REASONS.has("FOREIGN_CURRENCY_DOCUMENT_HELD"));
  ok(
    "the existing non-retryable reasons are unchanged",
    ["PROVIDER_ISSUED_DOCUMENT", "TEST_ENVIRONMENT_PAYMENT", "PROVIDER_IS_DOCUMENT_ISSUER", "DOCUMENT_ISSUER_NOT_CONFIGURED", "REFUND_ACCOUNTING_DECISION_REQUIRED"].every((r) => svc.NON_RETRYABLE_ATTENTION_REASONS.has(r)) &&
      svc.NON_RETRYABLE_ATTENTION_REASONS.size === 7
  );
  ok("PROVIDER_DOCUMENT_MISSING (USD/EUR with CardCom documents) is the one reason added, and NON-RETRYABLE", svc.NON_RETRYABLE_ATTENTION_REASONS.has("PROVIDER_DOCUMENT_MISSING"));

  // A provider whose descriptor says it never issues documents (taxDocuments NEVER).
  const neverProvider = ["CARDCOM", "SUMIT", "PAYPLUS", "PAYPAL", "TRANZILA", "MESHULAM", "GROW", "STRIPE"].find(
    (p) => getProviderDescriptor(p)?.capabilities.taxDocuments === "NEVER"
  );

  // ── standalone foreign payments, DUBIZ_ISSUES ────────────────────────────
  for (const currency of ["USD", "EUR"]) {
    resetConnections();
    const before = db.audits.length;
    const ptx = seedPayment({ currency, documentIssuer: "DUBIZ_ISSUES" });
    const r = await svc.settleVerifiedPayment({ businessId: BIZ, paymentTransactionId: ptx }, deps);
    const s = settlementOf(ptx);
    ok(`${currency} standalone, DUBIZ_ISSUES → REQUIRES_ATTENTION FOREIGN_CURRENCY_DOCUMENT_HELD`, r.outcome === "REQUIRES_ATTENTION" && r.reason === "FOREIGN_CURRENCY_DOCUMENT_HELD", JSON.stringify(r));
    ok(`${currency} standalone — settlement row paused with the reason`, s.status === "REQUIRES_ATTENTION" && s.attentionReason === "FOREIGN_CURRENCY_DOCUMENT_HELD" && s.nextAttemptAt === null && s.lastError === "SettlementAttention:FOREIGN_CURRENCY_DOCUMENT_HELD", JSON.stringify(s));
    ok(`${currency} standalone — the money stays PAID`, paymentOf(ptx).status === "PAID");
    const audit = db.audits.slice(before);
    ok(`${currency} standalone — one REQUIRES_ATTENTION audit with the reason`, audit.length === 1 && audit[0].eventType === "PAYMENT_ACCOUNTING_REQUIRES_ATTENTION" && audit[0].metadata.reason === "FOREIGN_CURRENCY_DOCUMENT_HELD", JSON.stringify(audit));
    ok(`${currency} standalone — no receipt work at all`, db.violations.length === 0, db.violations.join(","));
    const again = await svc.settleVerifiedPayment({ businessId: BIZ, paymentTransactionId: ptx }, deps);
    ok(`${currency} standalone — a further call stays paused, no new attempt`, again.outcome === "REQUIRES_ATTENTION" && again.reason === "FOREIGN_CURRENCY_DOCUMENT_HELD" && settlementOf(ptx).attemptCount === 1);
  }

  // ── standalone foreign payment, a provider that NEVER issues documents ───
  ok("a NEVER-issuing provider exists in the registry", !!neverProvider, String(neverProvider));
  if (neverProvider) {
    for (const currency of ["USD", "EUR"]) {
      resetConnections();
      const ptx = seedPayment({ currency, provider: neverProvider, documentIssuer: "NOT_CONFIGURED" });
      ok(`${neverProvider} NOT_CONFIGURED would otherwise be cleared to issue`, svc.documentHoldFor(neverProvider, "NOT_CONFIGURED") === null);
      const r = await svc.settleVerifiedPayment({ businessId: BIZ, paymentTransactionId: ptx }, deps);
      ok(`${currency} standalone, ${neverProvider} (NEVER) → FOREIGN_CURRENCY_DOCUMENT_HELD`, r.outcome === "REQUIRES_ATTENTION" && r.reason === "FOREIGN_CURRENCY_DOCUMENT_HELD", JSON.stringify(r));
      const ptx2 = seedPayment({ currency, provider: neverProvider, documentIssuer: null });
      const r2 = await svc.settleVerifiedPayment({ businessId: BIZ, paymentTransactionId: ptx2 }, deps);
      ok(`${currency} standalone, ${neverProvider} with no connection row → FOREIGN_CURRENCY_DOCUMENT_HELD`, r2.outcome === "REQUIRES_ATTENTION" && r2.reason === "FOREIGN_CURRENCY_DOCUMENT_HELD", JSON.stringify(r2));
    }
    ok("NEVER provider — no receipt work at all", db.violations.length === 0, db.violations.join(","));
  }

  // ── invoice-backed foreign payments ──────────────────────────────────────
  for (const currency of ["USD", "EUR"]) {
    resetConnections();
    const ptx = seedPayment({ currency, invoiceCurrency: "ILS", documentIssuer: "DUBIZ_ISSUES" });
    const r = await svc.settleVerifiedPayment({ businessId: BIZ, paymentTransactionId: ptx }, deps);
    ok(`${currency} against an ILS invoice → still CURRENCY_MISMATCH (unchanged)`, r.outcome === "REQUIRES_ATTENTION" && r.reason === "CURRENCY_MISMATCH", JSON.stringify(r));
    const ptx2 = seedPayment({ currency, invoiceCurrency: currency, documentIssuer: "DUBIZ_ISSUES" });
    const r2 = await svc.settleVerifiedPayment({ businessId: BIZ, paymentTransactionId: ptx2 }, deps);
    ok(`${currency} against a ${currency} invoice → FOREIGN_CURRENCY_DOCUMENT_HELD`, r2.outcome === "REQUIRES_ATTENTION" && r2.reason === "FOREIGN_CURRENCY_DOCUMENT_HELD", JSON.stringify(r2));
    ok(`${currency} invoice-backed — both payments stay PAID`, paymentOf(ptx).status === "PAID" && paymentOf(ptx2).status === "PAID");
    if (neverProvider) {
      const ptx3 = seedPayment({ currency, provider: neverProvider, invoiceCurrency: currency, documentIssuer: "NOT_CONFIGURED" });
      const r3 = await svc.settleVerifiedPayment({ businessId: BIZ, paymentTransactionId: ptx3 }, deps);
      ok(`${currency} invoice-backed, ${neverProvider} (NEVER) → FOREIGN_CURRENCY_DOCUMENT_HELD`, r3.outcome === "REQUIRES_ATTENTION" && r3.reason === "FOREIGN_CURRENCY_DOCUMENT_HELD", JSON.stringify(r3));
    }
  }
  ok("invoice-backed — no receipt work at all", db.violations.length === 0, db.violations.join(","));

  // ── the reasons that come first keep coming first ────────────────────────
  {
    resetConnections();
    const ptx = seedPayment({ currency: "USD", documentIssuer: "PROVIDER_ISSUES" });
    const r = await svc.settleVerifiedPayment({ businessId: BIZ, paymentTransactionId: ptx }, deps);
    ok("USD, PROVIDER_ISSUES → PROVIDER_IS_DOCUMENT_ISSUER (Dubiz issues nothing anyway)", r.outcome === "REQUIRES_ATTENTION" && r.reason === "PROVIDER_IS_DOCUMENT_ISSUER", JSON.stringify(r));
    const ptx2 = seedPayment({ currency: "USD" });
    paymentOf(ptx2).paymentRequest.currency = "ILS";
    const r2 = await svc.settleVerifiedPayment({ businessId: BIZ, paymentTransactionId: ptx2 }, deps);
    ok("USD charged for an ILS request → VERIFIED_CURRENCY_MISMATCH (unchanged)", r2.outcome === "REQUIRES_ATTENTION" && r2.reason === "VERIFIED_CURRENCY_MISMATCH", JSON.stringify(r2));
  }

  // ── ILS controls: the new check lets ILS through exactly as before ───────
  {
    resetConnections();
    const ptx = seedPayment({ currency: "ILS", documentIssuer: "DUBIZ_ISSUES" });
    const r = await svc.settleVerifiedPayment({ businessId: BIZ, paymentTransactionId: ptx }, deps);
    ok("ILS standalone passes the currency hold and reaches its usual next gate (billing identity)", r.outcome === "REQUIRES_ATTENTION" && r.reason === "BILLING_IDENTITY_INCOMPLETE", JSON.stringify(r));
    const ptx2 = seedPayment({ currency: "ILS", invoiceCurrency: "ILS", documentIssuer: "DUBIZ_ISSUES" });
    const r2 = await svc.settleVerifiedPayment({ businessId: BIZ, paymentTransactionId: ptx2 }, deps);
    ok("ILS invoice-backed passes the currency hold and reaches its usual next gate", r2.outcome === "REQUIRES_ATTENTION" && r2.reason === "BILLING_IDENTITY_INCOMPLETE", JSON.stringify(r2));
    const ptx3 = seedPayment({ currency: "ILS", documentIssuer: "NOT_CONFIGURED" });
    const r3 = await svc.settleVerifiedPayment({ businessId: BIZ, paymentTransactionId: ptx3 }, deps);
    ok("ILS, CardCom NOT_CONFIGURED → DOCUMENT_ISSUER_NOT_CONFIGURED (unchanged)", r3.outcome === "REQUIRES_ATTENTION" && r3.reason === "DOCUMENT_ISSUER_NOT_CONFIGURED", JSON.stringify(r3));
  }

  // ── manual retry / requeue cannot clear it ───────────────────────────────
  {
    resetConnections();
    const ptx = seedPayment({ currency: "USD", documentIssuer: "DUBIZ_ISSUES" });
    await svc.settleVerifiedPayment({ businessId: BIZ, paymentTransactionId: ptx }, deps);
    const rq = await svc.requeueSettlement({ businessId: BIZ, paymentTransactionId: ptx }, deps);
    ok("requeueSettlement refuses to requeue the hold", rq.requeued === false && settlementOf(ptx).status === "REQUIRES_ATTENTION" && settlementOf(ptx).attentionReason === "FOREIGN_CURRENCY_DOCUMENT_HELD");
    const rr = await resolveAndRetrySettlement({ businessId: BIZ, paymentTransactionId: ptx, actorUserId: 1, customerId: null });
    ok("the owner's 'try again' (resolveAndRetrySettlement) stays held", rr.outcome === "REQUIRES_ATTENTION" && rr.reason === "FOREIGN_CURRENCY_DOCUMENT_HELD", JSON.stringify(rr));
    let named = "resolved";
    try {
      await resolveAndRetrySettlement({ businessId: BIZ, paymentTransactionId: ptx, actorUserId: 1, customerId: 1 });
    } catch {
      named = "refused";
    }
    ok("naming a customer is refused for this hold (it is not NO_CUSTOMER)", named === "refused");
    ok("retry paths — no receipt work at all", db.violations.length === 0, db.violations.join(","));
  }

  // ── the issuer decision ("finish what was held") cannot clear it ─────────
  {
    resetConnections();
    // A USD payment held first for want of an issuer decision.
    const ptx = seedPayment({ currency: "USD", documentIssuer: "NOT_CONFIGURED" });
    const first = await svc.settleVerifiedPayment({ businessId: BIZ, paymentTransactionId: ptx }, deps);
    ok("USD, CardCom NOT_CONFIGURED → DOCUMENT_ISSUER_NOT_CONFIGURED first", first.outcome === "REQUIRES_ATTENTION" && first.reason === "DOCUMENT_ISSUER_NOT_CONFIGURED", JSON.stringify(first));
    // An ILS sibling held for the same reason, and a USD payment already held for currency.
    const ils = seedPayment({ currency: "ILS", documentIssuer: "NOT_CONFIGURED" });
    await svc.settleVerifiedPayment({ businessId: BIZ, paymentTransactionId: ils }, deps);
    const alreadyHeld = seedPayment({ currency: "EUR", status: "REQUIRES_ATTENTION", attentionReason: "FOREIGN_CURRENCY_DOCUMENT_HELD", attemptCount: 1 });
    // The business now says Dubiz issues the documents.
    db.connections.find((c) => c.provider === "CARDCOM")!.documentIssuer = "DUBIZ_ISSUES";
    const rel = await svc.releaseDocumentIssuerHolds({ businessId: BIZ, provider: "CARDCOM", documentIssuer: "DUBIZ_ISSUES" }, deps);
    ok("release touches only the DOCUMENT_ISSUER_NOT_CONFIGURED rows", rel.released.includes(ptx) && rel.released.includes(ils) && !rel.released.includes(alreadyHeld), JSON.stringify(rel));
    ok("the released USD payment is re-settled and held for its currency", settlementOf(ptx).status === "REQUIRES_ATTENTION" && settlementOf(ptx).attentionReason === "FOREIGN_CURRENCY_DOCUMENT_HELD", JSON.stringify(settlementOf(ptx)));
    ok("the release reports it as not settled", rel.settled === 0, JSON.stringify(rel));
    ok("the ILS sibling continues as before (to its next gate, billing identity)", settlementOf(ils).attentionReason === "BILLING_IDENTITY_INCOMPLETE");
    ok("the payment already held for currency is untouched", settlementOf(alreadyHeld).attentionReason === "FOREIGN_CURRENCY_DOCUMENT_HELD" && settlementOf(alreadyHeld).attemptCount === 1);
    const rel2 = await svc.releaseDocumentIssuerHolds({ businessId: BIZ, provider: "CARDCOM", documentIssuer: "DUBIZ_ISSUES" }, deps);
    ok("a second release finds nothing to clear", rel2.released.length === 0 && settlementOf(ptx).attentionReason === "FOREIGN_CURRENCY_DOCUMENT_HELD", JSON.stringify(rel2));
    const relP = await svc.releaseDocumentIssuerHolds({ businessId: BIZ, provider: "CARDCOM", documentIssuer: "PROVIDER_ISSUES" }, deps);
    ok("switching to PROVIDER_ISSUES does not rename the currency hold", relP.released.length === 0 && settlementOf(ptx).attentionReason === "FOREIGN_CURRENCY_DOCUMENT_HELD");
    ok("issuer decision — every payment stays PAID", [ptx, ils, alreadyHeld].every((id) => paymentOf(id).status === "PAID"));
    ok("issuer decision — no receipt work at all", db.violations.length === 0, db.violations.join(","));
  }

  // ── scheduled recovery cannot bypass it ──────────────────────────────────
  {
    db.settlements.forEach((s) => {
      if (s.status === "PENDING") s.status = "SETTLED"; // isolate: only the rows below are due
    });
    resetConnections();
    // A foreign payment whose inline attempt failed transiently: PENDING, retry due.
    const usd = seedPayment({ currency: "USD", documentIssuer: "DUBIZ_ISSUES", attemptCount: 2 });
    const eur = seedPayment({ currency: "EUR", documentIssuer: "DUBIZ_ISSUES", attemptCount: 1 });
    const report = await runSettlementRecovery({ now: () => at, listBusinessIds: async () => [BIZ] });
    ok("recovery attempts both due foreign payments", report.attempted === 2, JSON.stringify(report));
    ok("recovery settles neither, reports both as attention", report.settled === 0 && report.requiresAttention === 2, JSON.stringify(report));
    ok("recovery leaves both held for their currency", [usd, eur].every((id) => settlementOf(id).attentionReason === "FOREIGN_CURRENCY_DOCUMENT_HELD"));
    const report2 = await runSettlementRecovery({ now: () => at, listBusinessIds: async () => [BIZ] });
    ok("a second recovery run does not pick them up again", report2.attempted === 0, JSON.stringify(report2));
    ok("recovery — no receipt work at all", db.violations.length === 0, db.violations.join(","));
  }

  // ── PROVIDER_DOCUMENT_MISSING: opened paused at recording, nothing clears it ──
  {
    db.settlements.forEach((s) => {
      if (s.status === "PENDING") s.status = "SETTLED"; // isolate: only the rows below
    });
    resetConnections();
    const before = db.audits.length;
    const usd = seedPayment({ currency: "USD", documentIssuer: "PROVIDER_ISSUES", status: "REQUIRES_ATTENTION", attentionReason: "PROVIDER_DOCUMENT_MISSING" });
    const eur = seedPayment({ currency: "EUR", documentIssuer: "PROVIDER_ISSUES", status: "REQUIRES_ATTENTION", attentionReason: "PROVIDER_DOCUMENT_MISSING" });
    for (const [label, ptx] of [["USD", usd], ["EUR", eur]] as const) {
      const r = await svc.settleVerifiedPayment({ businessId: BIZ, paymentTransactionId: ptx }, deps);
      ok(`${label} missing CardCom document — settle stays REQUIRES_ATTENTION PROVIDER_DOCUMENT_MISSING`, r.outcome === "REQUIRES_ATTENTION" && r.reason === "PROVIDER_DOCUMENT_MISSING", JSON.stringify(r));
      const rq = await svc.requeueSettlement({ businessId: BIZ, paymentTransactionId: ptx }, deps);
      ok(`${label} — requeue refused`, rq.requeued === false && settlementOf(ptx).attentionReason === "PROVIDER_DOCUMENT_MISSING");
      const rr = await resolveAndRetrySettlement({ businessId: BIZ, paymentTransactionId: ptx, actorUserId: 1, customerId: null });
      ok(`${label} — the owner's "try again" stays paused`, rr.outcome === "REQUIRES_ATTENTION" && rr.reason === "PROVIDER_DOCUMENT_MISSING", JSON.stringify(rr));
      ok(`${label} — the money stays PAID`, paymentOf(ptx).status === "PAID");
    }
    for (const issuer of ["DUBIZ_ISSUES", "PROVIDER_ISSUES"]) {
      const rel = await svc.releaseDocumentIssuerHolds({ businessId: BIZ, provider: "CARDCOM", documentIssuer: issuer as "DUBIZ_ISSUES" }, deps);
      ok(`an issuer decision (${issuer}) does not touch PROVIDER_DOCUMENT_MISSING`, !rel.released.includes(usd) && !rel.released.includes(eur) && [usd, eur].every((id) => settlementOf(id).attentionReason === "PROVIDER_DOCUMENT_MISSING"), JSON.stringify(rel));
    }
    const report = await runSettlementRecovery({ now: () => at, listBusinessIds: async () => [BIZ] });
    ok("scheduled recovery does not pick PROVIDER_DOCUMENT_MISSING up", report.attempted === 0 && [usd, eur].every((id) => settlementOf(id).attentionReason === "PROVIDER_DOCUMENT_MISSING"), JSON.stringify(report));
    ok("PROVIDER_DOCUMENT_MISSING — no receipt work at all", db.violations.length === 0, db.violations.join(","));
    ok("PROVIDER_DOCUMENT_MISSING — no new attempt and no new audit", [usd, eur].every((id) => settlementOf(id).attemptCount === 0) && db.audits.length === before, JSON.stringify(db.audits.slice(before)));
  }

  // ── what the owner sees ──────────────────────────────────────────────────
  {
    const he = moneyHe.collection.attention.FOREIGN_CURRENCY_DOCUMENT_HELD;
    const en = moneyEn.collection.attention.FOREIGN_CURRENCY_DOCUMENT_HELD;
    ok("Hebrew label: recorded, foreign-currency receipt not issued automatically", /התקבל ונרשם/.test(he) && /מטבע זר/.test(he) && /לא מופקת/.test(he), he);
    ok("English label: recorded, not issued automatically", /recorded/.test(en) && /foreign-currency receipt is not issued automatically/.test(en) && !/[֐-׿]/.test(en), en);
    ok("neither label claims a receipt was issued", !/הופקה קבלה|receipt was issued|receipt issued/i.test(he + " " + en));
    const client = await import("@/components/collection/collection-client").catch(() => null);
    if (client) {
      const hit = client.ATTENTION_REASON_TEXT.FOREIGN_CURRENCY_DOCUMENT_HELD;
      ok("collection UI maps the reason to its own text, not the generic fallback", !!hit && hit.title === he && hit.title !== moneyHe.collection.attention.fallback);
      ok("collection UI does not lead with RETRY for it", hit?.action === "REVIEW");
      ok("attentionText resolves it", client.attentionText("FOREIGN_CURRENCY_DOCUMENT_HELD").title === he);
    } else {
      ok("collection-client loads in node", false);
    }
  }

  console.log(`\nforeign-currency-document-hold: ${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
