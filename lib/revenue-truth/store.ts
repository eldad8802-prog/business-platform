/**
 * Revenue truth — the writers. docs/revenue-truth-milestone-a.md.
 *
 * Every write is idempotent and append-only:
 *   - evidence (sale, receipt, Z, settlement) is keyed by (business, sourceScope, externalId[, register, revision]):
 *     the same event again is DUPLICATE and writes nothing; the same key with a different source payload hash is
 *     CONFLICT and writes nothing (a changed fact is a correction — a refund, a void or a new Z revision — never an
 *     overwrite);
 *   - a link is proposed once per pair; its state changes only by appending a decision;
 *   - a decision carries its own idempotency key, follows the allowed transitions, and a CONFIRMED link may never
 *     close more money than the objects it names hold (checked under an advisory lock per object).
 *
 * The database enforces tenancy (FORCE RLS, composite keys, the link guard), the arithmetic (CHECK) and the
 * append-only rule (trigger); this file never relies on the caller for any of them. `businessId` MUST be
 * server-derived (see lib/tenant/tenant-tx.ts).
 *
 * NOT CONNECTED: in milestone A no route, job or adapter calls these writers; only the lab battery does.
 */
import type { RevenueLink } from "@prisma/client";
import { moneyFromDecimal } from "@/lib/money/money";
import { tenantTx, type TenantTxClient } from "@/lib/tenant/tenant-tx";
import type { Capture, DecisionKind, LinkKind, TenderMethod, Validation } from "./types";

const ZERO = BigInt(0);
/** Advisory-lock namespace for revenue allocation ('RV'). */
const LOCK_NAMESPACE = 0x5256;

export type WriteStatus = "CREATED" | "DUPLICATE" | "CONFLICT";
export type WriteResult = { status: WriteStatus; id: number };

type SourceRef = {
  sourceKind: "POS" | "ACCOUNTING_APP" | "ACQUIRER" | "PAYMENT_PROVIDER" | "OWNER";
  capture: Capture;
  sourceScope: string;
  externalId: string;
  connectionId?: number | null;
  sourcePayloadHash?: string | null;
  ingestRef?: string | null;
};

/** A YYYY-MM-DD Israel business day as the DATE value Prisma writes. */
function dayDate(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`revenue-truth: business day must be YYYY-MM-DD, got "${day}"`);
  return new Date(`${day}T00:00:00.000Z`);
}

function outcome(created: boolean, existing: { id: number; sourcePayloadHash: string | null }, hash: string | null | undefined): WriteResult {
  if (created) return { status: "CREATED", id: existing.id };
  const changed = !!hash && !!existing.sourcePayloadHash && hash !== existing.sourcePayloadHash;
  return { status: changed ? "CONFLICT" : "DUPLICATE", id: existing.id };
}

export type SaleInput = SourceRef & {
  kind: "SALE" | "REFUND" | "VOID";
  originalSaleId?: number | null;
  occurredAt: Date;
  businessDay: string;
  registerKey?: string | null;
  currency: string;
  grossMinor: bigint;
  discountMinor?: bigint;
  vatMinor: bigint;
};

export function recordSale(businessId: number, input: SaleInput): Promise<WriteResult> {
  return tenantTx(businessId, async (tx) => {
    const discount = input.discountMinor ?? ZERO;
    const { count } = await tx.revenueSale.createMany({
      data: [{
        businessId, sourceKind: input.sourceKind, capture: input.capture, sourceScope: input.sourceScope,
        connectionId: input.connectionId ?? null, externalId: input.externalId, kind: input.kind,
        originalSaleId: input.originalSaleId ?? null, occurredAt: input.occurredAt, businessDay: dayDate(input.businessDay),
        registerKey: input.registerKey ?? null, currency: input.currency, grossMinor: input.grossMinor,
        discountMinor: discount, totalMinor: input.grossMinor - discount, vatMinor: input.vatMinor,
        sourcePayloadHash: input.sourcePayloadHash ?? null, ingestRef: input.ingestRef ?? null,
      }],
      skipDuplicates: true,
    });
    const row = await tx.revenueSale.findUniqueOrThrow({
      where: { businessId_sourceScope_externalId: { businessId, sourceScope: input.sourceScope, externalId: input.externalId } },
      select: { id: true, sourcePayloadHash: true },
    });
    return outcome(count === 1, row, input.sourcePayloadHash);
  });
}

export type ReceiptInput = SourceRef & {
  saleId?: number | null;
  direction: "IN" | "OUT";
  method: TenderMethod;
  receivedAt: Date;
  businessDay: string;
  registerKey?: string | null;
  currency: string;
  amountMinor: bigint;
  cardBrand?: string | null;
  acquirer?: string | null;
  installmentCount?: number | null;
};

export function recordReceipt(businessId: number, input: ReceiptInput): Promise<WriteResult> {
  return tenantTx(businessId, async (tx) => {
    const { count } = await tx.revenueReceipt.createMany({
      data: [{
        businessId, sourceKind: input.sourceKind, capture: input.capture, sourceScope: input.sourceScope,
        connectionId: input.connectionId ?? null, externalId: input.externalId, saleId: input.saleId ?? null,
        direction: input.direction, method: input.method, receivedAt: input.receivedAt, businessDay: dayDate(input.businessDay),
        registerKey: input.registerKey ?? null, currency: input.currency, receivedMinor: input.amountMinor,
        cardBrand: input.cardBrand ?? null, acquirer: input.acquirer ?? null, installmentCount: input.installmentCount ?? null,
        sourcePayloadHash: input.sourcePayloadHash ?? null, ingestRef: input.ingestRef ?? null,
      }],
      skipDuplicates: true,
    });
    const row = await tx.revenueReceipt.findUniqueOrThrow({
      where: { businessId_sourceScope_externalId: { businessId, sourceScope: input.sourceScope, externalId: input.externalId } },
      select: { id: true, sourcePayloadHash: true },
    });
    return outcome(count === 1, row, input.sourcePayloadHash);
  });
}

export type DailyCloseInput = SourceRef & {
  documentId?: number | null;
  salesScope?: string | null;
  registerKey: string;
  revision?: number;
  supersedesId?: number | null;
  zNumber?: bigint | null;
  businessDay: string;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  currency: string;
  grossMinor: bigint;
  discountMinor?: bigint;
  refundMinor?: bigint;
  voidMinor?: bigint;
  vatMinor: bigint;
  grandTotalMinor?: bigint | null;
  transactionCount?: number | null;
  validation: Validation;
  validationCodes?: string[];
  tenders: { method: TenderMethod; label?: string; amountMinor: bigint; count?: number | null }[];
  vatLines: { category: "STANDARD" | "ZERO_RATED" | "EXEMPT"; rateBasisPoints: number; taxableMinor: bigint; vatMinor: bigint }[];
};

/** A Z report with its tender and VAT lines, in one transaction: a visible header always has its lines. */
export function recordDailyClose(businessId: number, input: DailyCloseInput): Promise<WriteResult> {
  return tenantTx(businessId, async (tx) => {
    const revision = input.revision ?? 1;
    const discount = input.discountMinor ?? ZERO;
    const refunds = input.refundMinor ?? ZERO;
    const voids = input.voidMinor ?? ZERO;
    const { count } = await tx.revenueDailyClose.createMany({
      data: [{
        businessId, sourceKind: input.sourceKind, capture: input.capture, sourceScope: input.sourceScope,
        connectionId: input.connectionId ?? null, documentId: input.documentId ?? null, salesScope: input.salesScope ?? null,
        registerKey: input.registerKey, externalId: input.externalId, revision, supersedesId: input.supersedesId ?? null,
        zNumber: input.zNumber ?? null, businessDay: dayDate(input.businessDay), periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null, currency: input.currency, grossMinor: input.grossMinor, discountMinor: discount,
        refundMinor: refunds, voidMinor: voids, totalMinor: input.grossMinor - discount - refunds - voids, vatMinor: input.vatMinor,
        grandTotalMinor: input.grandTotalMinor ?? null, transactionCount: input.transactionCount ?? null,
        validation: input.validation, validationCodes: input.validationCodes ?? [],
        sourcePayloadHash: input.sourcePayloadHash ?? null, ingestRef: input.ingestRef ?? null,
      }],
      skipDuplicates: true,
    });
    const row = await tx.revenueDailyClose.findUniqueOrThrow({
      where: { sourceKey: { businessId, sourceScope: input.sourceScope, registerKey: input.registerKey, externalId: input.externalId, revision } },
      select: { id: true, sourcePayloadHash: true },
    });
    if (count === 1) {
      // One inline write per line (a Z has a handful), so the written shape stays readable to the erasure contract.
      for (const t of input.tenders) {
        await tx.revenueDailyCloseTender.create({
          data: { businessId, dailyCloseId: row.id, method: t.method, label: t.label ?? "", amountMinor: t.amountMinor, count: t.count ?? null },
        });
      }
      for (const l of input.vatLines) {
        await tx.revenueDailyCloseVat.create({
          data: { businessId, dailyCloseId: row.id, category: l.category, rateBasisPoints: l.rateBasisPoints, taxableMinor: l.taxableMinor, vatMinor: l.vatMinor },
        });
      }
    }
    return outcome(count === 1, row, input.sourcePayloadHash);
  });
}

export type SettlementInput = SourceRef & {
  documentId?: number | null;
  acquirer: string;
  valueDate: string;
  currency: string;
  grossMinor: bigint;
  feeMinor?: bigint;
  otherDeductionsMinor?: bigint;
  installmentNumber?: number | null;
  installmentCount?: number | null;
  validation: Validation;
  validationCodes?: string[];
};

export function recordSettlement(businessId: number, input: SettlementInput): Promise<WriteResult> {
  return tenantTx(businessId, async (tx) => {
    const fee = input.feeMinor ?? ZERO;
    const other = input.otherDeductionsMinor ?? ZERO;
    const { count } = await tx.revenueSettlement.createMany({
      data: [{
        businessId, sourceKind: input.sourceKind, capture: input.capture, sourceScope: input.sourceScope,
        connectionId: input.connectionId ?? null, documentId: input.documentId ?? null, externalId: input.externalId,
        acquirer: input.acquirer, valueDate: dayDate(input.valueDate), currency: input.currency, grossMinor: input.grossMinor,
        feeMinor: fee, otherDeductionsMinor: other, netMinor: input.grossMinor - fee - other,
        installmentNumber: input.installmentNumber ?? null, installmentCount: input.installmentCount ?? null,
        validation: input.validation, validationCodes: input.validationCodes ?? [],
        sourcePayloadHash: input.sourcePayloadHash ?? null, ingestRef: input.ingestRef ?? null,
      }],
      skipDuplicates: true,
    });
    const row = await tx.revenueSettlement.findUniqueOrThrow({
      where: { businessId_sourceScope_externalId: { businessId, sourceScope: input.sourceScope, externalId: input.externalId } },
      select: { id: true, sourcePayloadHash: true },
    });
    return outcome(count === 1, row, input.sourcePayloadHash);
  });
}

export type LinkInput = {
  linkKind: LinkKind;
  saleId?: number | null;
  receiptId?: number | null;
  dailyCloseTenderId?: number | null;
  settlementId?: number | null;
  externalTransactionId?: number | null;
  billingDocumentId?: number | null;
  amountMinor?: bigint | null;
  currency: string;
  basis: "SOURCE_REFERENCE" | "RULE_EXACT" | "RULE_TOLERANCE" | "OWNER_MANUAL";
  proposedBy: "OWNER_USER" | "SYSTEM";
  score?: number | null;
};

const LINK_REFS = ["saleId", "receiptId", "dailyCloseTenderId", "settlementId", "externalTransactionId", "billingDocumentId"] as const;

/** Propose a link once. The same pair again (whatever was decided about it) is ALREADY_PROPOSED. */
export function proposeLink(businessId: number, input: LinkInput): Promise<{ status: "PROPOSED" | "ALREADY_PROPOSED"; id: number }> {
  return tenantTx(businessId, async (tx) => {
    const refs = Object.fromEntries(LINK_REFS.map((k) => [k, input[k] ?? null])) as Record<(typeof LINK_REFS)[number], number | null>;
    const { count } = await tx.revenueLink.createMany({
      data: [{
        businessId, linkKind: input.linkKind, saleId: refs.saleId, receiptId: refs.receiptId, dailyCloseTenderId: refs.dailyCloseTenderId,
        settlementId: refs.settlementId, externalTransactionId: refs.externalTransactionId, billingDocumentId: refs.billingDocumentId,
        linkedMinor: input.amountMinor ?? null, currency: input.currency, basis: input.basis, proposedBy: input.proposedBy, score: input.score ?? null,
      }],
      skipDuplicates: true,
    });
    const row = await tx.revenueLink.findFirstOrThrow({
      where: { businessId, linkKind: input.linkKind, ...refs },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    return { status: count === 1 ? "PROPOSED" : "ALREADY_PROPOSED", id: row.id };
  });
}

export type DecisionErrorCode =
  | "INVALID_TRANSITION"
  | "OVER_ALLOCATION"
  | "ALREADY_SAME_AS"
  | "NOT_FOUND"
  /** Rejecting evidence that a CONFIRMED link still names: revoke the link first. */
  | "HAS_CONFIRMED_LINKS"
  /** Rejecting a sale that a live refund / void or a live receipt still names: reject those first. */
  | "HAS_LIVE_DEPENDENTS"
  /** Restoring a refund / void / receipt whose sale is rejected: restore the sale first. */
  | "DEPENDS_ON_REJECTED"
  /** Confirming a link that names rejected evidence. */
  | "REJECTED_EVIDENCE";
export class RevenueDecisionError extends Error {
  constructor(readonly code: DecisionErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "RevenueDecisionError";
  }
}

/** What a decision may follow, on a link or a Z. REJECTED is final: a rejected pair is never confirmed again. */
const ALLOWED: Record<DecisionKind | "NONE", readonly DecisionKind[]> = {
  NONE: ["CONFIRMED", "REJECTED"],
  CONFIRMED: ["REVOKED"],
  REVOKED: ["CONFIRMED", "REJECTED"],
  REJECTED: [],
};
/** On evidence (a sale, a receipt, a settlement): valid as recorded until REJECTED; a rejection can be REVOKED. */
const ALLOWED_ON_EVIDENCE: Record<DecisionKind | "NONE", readonly DecisionKind[]> = {
  NONE: ["REJECTED"],
  REJECTED: ["REVOKED"],
  REVOKED: ["REJECTED"],
  CONFIRMED: [],
};

type Subject = { linkId: number } | { dailyCloseId: number } | { saleId: number } | { receiptId: number } | { settlementId: number };
type EvidenceRef = "saleId" | "receiptId" | "settlementId";

export type DecisionInput = {
  subject: Subject;
  decision: DecisionKind;
  actor: "OWNER_USER" | "SYSTEM";
  reasonCode?: string | null;
  idempotencyKey: string;
};

export function recordDecision(businessId: number, input: DecisionInput): Promise<{ status: "RECORDED" | "DUPLICATE"; id: number }> {
  return tenantTx(businessId, async (tx) => {
    const retried = await tx.revenueDecision.findUnique({
      where: { businessId_idempotencyKey: { businessId, idempotencyKey: input.idempotencyKey } },
      select: { id: true },
    });
    if (retried) return { status: "DUPLICATE" as const, id: retried.id };

    const s = input.subject;
    const subjectColumns = {
      linkId: "linkId" in s ? s.linkId : null,
      dailyCloseId: "dailyCloseId" in s ? s.dailyCloseId : null,
      saleId: "saleId" in s ? s.saleId : null,
      receiptId: "receiptId" in s ? s.receiptId : null,
      settlementId: "settlementId" in s ? s.settlementId : null,
    };

    if ("linkId" in s) {
      const link = await tx.revenueLink.findUnique({ where: { businessId_id: { businessId, id: s.linkId } } });
      if (!link) throw new RevenueDecisionError("NOT_FOUND", "no such link in this business");
      await lock(tx, businessId, objectKeys(link));
      assertTransition(ALLOWED, await latestDecisionOf(tx, businessId, s), input.decision);
      if (input.decision === "CONFIRMED") await assertConfirmable(tx, businessId, link);
    } else if ("dailyCloseId" in s) {
      if (!(await tx.revenueDailyClose.findUnique({ where: { businessId_id: { businessId, id: s.dailyCloseId } }, select: { id: true } }))) {
        throw new RevenueDecisionError("NOT_FOUND", "no such Z report in this business");
      }
      assertTransition(ALLOWED, await latestDecisionOf(tx, businessId, s), input.decision);
    } else {
      const ref: EvidenceRef = "saleId" in s ? "saleId" : "receiptId" in s ? "receiptId" : "settlementId";
      const id = subjectColumns[ref]!;
      const parentSaleId = await evidenceParentSale(tx, businessId, ref, id);
      // The object, and the sale it depends on: a sale's rejection and a dependent's restoration serialise.
      await lock(tx, businessId, [`${ref}:${id}`, ...(parentSaleId !== null ? [`saleId:${parentSaleId}`] : [])]);
      assertTransition(ALLOWED_ON_EVIDENCE, await latestDecisionOf(tx, businessId, s), input.decision);
      if (input.decision === "REJECTED") await assertRejectable(tx, businessId, ref, id);
      if (input.decision === "REVOKED" && parentSaleId !== null && (await latestDecisionOf(tx, businessId, { saleId: parentSaleId })) === "REJECTED") {
        throw new RevenueDecisionError("DEPENDS_ON_REJECTED", `sale ${parentSaleId} is rejected; restore it first`);
      }
    }

    const row = await tx.revenueDecision.create({
      data: {
        businessId, linkId: subjectColumns.linkId, dailyCloseId: subjectColumns.dailyCloseId, saleId: subjectColumns.saleId,
        receiptId: subjectColumns.receiptId, settlementId: subjectColumns.settlementId, decision: input.decision,
        actor: input.actor, reasonCode: input.reasonCode ?? null, idempotencyKey: input.idempotencyKey,
      },
      select: { id: true },
    });
    return { status: "RECORDED" as const, id: row.id };
  });
}

function assertTransition(table: Record<DecisionKind | "NONE", readonly DecisionKind[]>, current: DecisionKind | null, next: DecisionKind): void {
  if (!table[current ?? "NONE"].includes(next)) {
    throw new RevenueDecisionError("INVALID_TRANSITION", `${current ?? "NONE"} → ${next} is not allowed`);
  }
}

/** The sale a refund / void or a receipt depends on (null for a sale without an original, and for a settlement). */
async function evidenceParentSale(tx: TenantTxClient, businessId: number, ref: EvidenceRef, id: number): Promise<number | null> {
  if (ref === "saleId") {
    const sale = await tx.revenueSale.findUnique({ where: { businessId_id: { businessId, id } }, select: { originalSaleId: true } });
    if (!sale) throw new RevenueDecisionError("NOT_FOUND", "no such sale in this business");
    return sale.originalSaleId;
  }
  if (ref === "receiptId") {
    const receipt = await tx.revenueReceipt.findUnique({ where: { businessId_id: { businessId, id } }, select: { saleId: true } });
    if (!receipt) throw new RevenueDecisionError("NOT_FOUND", "no such receipt in this business");
    return receipt.saleId;
  }
  if (!(await tx.revenueSettlement.findUnique({ where: { businessId_id: { businessId, id } }, select: { id: true } }))) {
    throw new RevenueDecisionError("NOT_FOUND", "no such settlement in this business");
  }
  return null;
}

/** A rejection may not leave a match standing on excluded money, nor a live refund / payment of an excluded sale. */
async function assertRejectable(tx: TenantTxClient, businessId: number, ref: EvidenceRef, id: number): Promise<void> {
  const links = await tx.revenueLink.findMany({ where: { businessId, [ref]: id }, select: { id: true } });
  for (const l of links) {
    if ((await latestDecisionOf(tx, businessId, { linkId: l.id })) === "CONFIRMED") {
      throw new RevenueDecisionError("HAS_CONFIRMED_LINKS", `link ${l.id} is confirmed on this ${ref.replace("Id", "")}; revoke it first`);
    }
  }
  if (ref !== "saleId") return;
  const dependents = [
    ...(await tx.revenueSale.findMany({ where: { businessId, originalSaleId: id }, select: { id: true } })).map((d) => ({ saleId: d.id })),
    ...(await tx.revenueReceipt.findMany({ where: { businessId, saleId: id }, select: { id: true } })).map((d) => ({ receiptId: d.id })),
  ];
  for (const d of dependents) {
    if ((await latestDecisionOf(tx, businessId, d)) !== "REJECTED") {
      throw new RevenueDecisionError("HAS_LIVE_DEPENDENTS", `${Object.keys(d)[0].replace("Id", "")} ${Object.values(d)[0]} still names this sale; reject it first`);
    }
  }
}

type LinkRow = RevenueLink;

/** Every money object the link names, as lock keys. */
function objectKeys(l: LinkRow): string[] {
  return LINK_REFS.filter((k) => l[k] !== null).map((k) => `${k}:${l[k]}`);
}

/** Per-object advisory locks, taken in sorted order so two decisions never deadlock. */
async function lock(tx: TenantTxClient, businessId: number, keys: string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}::int, hashtext(${`${businessId}:${key}`})::int)`;
  }
}

async function latestDecisionOf(tx: TenantTxClient, businessId: number, subject: Subject): Promise<DecisionKind | null> {
  const last = await tx.revenueDecision.findFirst({
    where: { businessId, ...subject },
    orderBy: { id: "desc" },
    select: { decision: true },
  });
  return last?.decision ?? null;
}

/** Other CONFIRMED links naming the same object (latest decision per link). */
async function confirmedSiblings(tx: TenantTxClient, businessId: number, self: LinkRow, ref: (typeof LINK_REFS)[number], kinds: LinkKind[]): Promise<LinkRow[]> {
  const value = self[ref];
  if (value === null) return [];
  const siblings = await tx.revenueLink.findMany({ where: { businessId, [ref]: value, linkKind: { in: kinds }, id: { not: self.id } } });
  const out: LinkRow[] = [];
  for (const s of siblings) if ((await latestDecisionOf(tx, businessId, { linkId: s.id })) === "CONFIRMED") out.push(s);
  return out;
}

async function assertConfirmable(tx: TenantTxClient, businessId: number, l: LinkRow): Promise<void> {
  // No match may stand on excluded money (the lock on each object serialises this with a rejection of it).
  for (const ref of ["saleId", "receiptId", "settlementId"] as const) {
    const id = l[ref];
    if (id !== null && (await latestDecisionOf(tx, businessId, { [ref]: id } as Subject)) === "REJECTED") {
      throw new RevenueDecisionError("REJECTED_EVIDENCE", `${ref.replace("Id", "")} ${id} is rejected; restore it before confirming a link on it`);
    }
  }
  if (l.linkKind === "SALE_SAME_AS_DOCUMENT") {
    const bySale = await confirmedSiblings(tx, businessId, l, "saleId", ["SALE_SAME_AS_DOCUMENT"]);
    const byDoc = await confirmedSiblings(tx, businessId, l, "billingDocumentId", ["SALE_SAME_AS_DOCUMENT"]);
    if (bySale.length > 0 || byDoc.length > 0) throw new RevenueDecisionError("ALREADY_SAME_AS", "the sale or the document is already confirmed as the same as another");
    return;
  }
  const amount = l.linkedMinor ?? ZERO;
  const capacity: { ref: (typeof LINK_REFS)[number]; kinds: LinkKind[]; holds: () => Promise<bigint> }[] = [];
  if (l.receiptId !== null) {
    capacity.push({ ref: "receiptId", kinds: ["TENDER_SETTLED_BY", "CASH_DEPOSITED_AS"], holds: async () => (await tx.revenueReceipt.findUniqueOrThrow({ where: { businessId_id: { businessId, id: l.receiptId! } } })).receivedMinor });
  }
  if (l.dailyCloseTenderId !== null) {
    capacity.push({ ref: "dailyCloseTenderId", kinds: ["TENDER_SETTLED_BY", "CASH_DEPOSITED_AS"], holds: async () => (await tx.revenueDailyCloseTender.findUniqueOrThrow({ where: { businessId_id: { businessId, id: l.dailyCloseTenderId! } } })).amountMinor });
  }
  if (l.settlementId !== null) {
    // A settlement is filled from two sides: tenders up to its gross, deposits up to its net.
    const kind = l.linkKind;
    capacity.push({ ref: "settlementId", kinds: [kind], holds: async () => {
      const st = await tx.revenueSettlement.findUniqueOrThrow({ where: { businessId_id: { businessId, id: l.settlementId! } } });
      return kind === "SETTLEMENT_DEPOSITED_AS" ? st.netMinor : st.grossMinor;
    } });
  }
  if (l.externalTransactionId !== null) {
    capacity.push({ ref: "externalTransactionId", kinds: ["SETTLEMENT_DEPOSITED_AS", "CASH_DEPOSITED_AS"], holds: async () => {
      const et = await tx.externalTransaction.findFirstOrThrow({ where: { id: l.externalTransactionId!, businessId }, select: { amount: true, currency: true } });
      return moneyFromDecimal(et.amount.toString(), et.currency).minor;
    } });
  }
  for (const c of capacity) {
    const siblings = await confirmedSiblings(tx, businessId, l, c.ref, c.kinds);
    const already = siblings.reduce((sum, s) => sum + (s.linkedMinor ?? ZERO), ZERO);
    const holds = await c.holds();
    if (already + amount > holds) {
      throw new RevenueDecisionError("OVER_ALLOCATION", `${c.ref} holds ${holds}; ${already} is already confirmed, ${amount} more does not fit`);
    }
  }
}
