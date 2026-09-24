/**
 * M4 · DOCUMENTS — what the paperwork says about the business, beyond DOC-04's filing lag.
 *
 * TWO OF THESE THREE RULES ONLY EXIST BECAUSE OF THE IDENTITY LAYER
 *
 * A document's vendor is a string on `FinancialRecord.vendorName`. There is no vendor table, no
 * foreign key, nothing to attach a per-vendor measure to. DOC-02 and DOC-05 are therefore keyed on a
 * `Party` — the identity anchor that M5 wires up — and an unresolved vendor produces no measure at
 * all rather than a measure attached to a spelling.
 *
 * That is a real limit with a real consequence: a business whose vendor names are entered
 * inconsistently will get fewer vendor-level measures, not wronger ones. Fewer and right is the
 * trade this milestone makes everywhere.
 *
 * WHAT THESE RULES ARE NOT
 *   Not a correction to extraction. DOC-05 learns what a vendor's invoices usually come to; it does
 *   NOT write that number back into a document, pre-fill it, or outrank a confident extraction.
 *   Evidence assists resolution; it does not fabricate the contents of a source document. An earlier
 *   shadow implementation of amount memory went further than that and was never activated — this one
 *   is deliberately narrower: it produces a fact a human or a later reasoning layer can weigh, and
 *   nothing in the extraction path reads it.
 */
import type { KnowledgeRule, RuleDescriptor, EvidenceSource } from "../rule.contract";
import type { MeasureResult } from "../measure.contract";
import {
  cadenceMeasure,
  groupByEntity,
  shareMeasure,
  valueMeasure,
  type SharePoint,
  type TimelinePoint,
  type ValuePoint,
} from "../rule-kit";

/** One approved financial document, attributed to a resolved vendor identity. */
export type VendorDocumentObservation = {
  /** The `FinancialRecord` id. */
  readonly recordId: number;
  readonly businessId: number;
  /** `FinancialRecord.date` — when the document says it happened, not when it was filed. */
  readonly at: Date;
  /** The `Party` anchoring this vendor. Never a name. */
  readonly partyId: number;
  readonly amount: number;
  /** "expense" | "income". Kept apart: a vendor who both bills and is paid has two rhythms. */
  readonly direction: string;
};

/** One human review of an extracted document. */
export type ReviewObservation = {
  /** The `ReviewEvent` id. */
  readonly recordId: number;
  readonly businessId: number;
  /** `occurredAt` — when the human approved. */
  readonly at: Date;
  /** Did the human change at least one field the engine had proposed? */
  readonly corrected: boolean;
  /** Which fields were corrected, for the detail payload. Field names only, never values. */
  readonly correctedFields: readonly string[];
};

export const DOCUMENTS_WINDOW_DAYS = 365;

const SHARED: Pick<RuleDescriptor, "domain" | "freshness"> = {
  domain: "documents",
  freshness: ["NEW_EVIDENCE", "WINDOW_ROLLED", "EVIDENCE_REVERSED", "OWNER_CORRECTION", "RULE_VERSION_CHANGED"],
};

export function makeVendorDocumentSource(
  load: EvidenceSource<VendorDocumentObservation>["load"],
): EvidenceSource<VendorDocumentObservation> {
  return { key: "documents.vendor_records", windowDays: DOCUMENTS_WINDOW_DAYS, load };
}

export function makeReviewSource(
  load: EvidenceSource<ReviewObservation>["load"],
): EvidenceSource<ReviewObservation> {
  return { key: "documents.reviews", windowDays: DOCUMENTS_WINDOW_DAYS, load };
}

/** Expenses only. A vendor is someone the business buys from; income documents are a different story. */
const EXPENSE = "expense";

/* ────────────────────────────── DOC-02 · vendor billing cadence ────────────────────────────── */

export const DOC02: RuleDescriptor = {
  ...SHARED,
  ruleId: "DOC-02",
  measureKey: "documents.vendor_billing_cadence",
  policyKey: "documents-vendor-billing-cadence",
  versionLabel: "v1",
  entityType: "party",
  windowDays: DOCUMENTS_WINDOW_DAYS,
  /** Three gaps, so four documents from the same resolved vendor. */
  minSupport: 3,
  valueUnit: "days",
  question: "How regularly does a given vendor bill this business?",
};

/** Five days. Monthly billing lands on different weekdays; that is not a change in rhythm. */
const BILLING_TREND_MIN_DELTA = 5;

export function deriveVendorBillingCadence(
  observations: readonly VendorDocumentObservation[],
  now: Date,
  businessId: number,
): MeasureResult[] {
  const expenses = observations.filter((o) => o.direction === EXPENSE);
  const byParty = groupByEntity(expenses, (o) => o.partyId);

  return [...byParty.entries()].map(([partyId, rows]) =>
    cadenceMeasure(
      {
        measureKey: DOC02.measureKey,
        entityType: "party",
        entityId: partyId,
        valueUnit: "days",
        evidenceKind: "financial-record",
        minSupport: DOC02.minSupport,
        windowDays: DOC02.windowDays,
        trendMinDelta: BILLING_TREND_MIN_DELTA,
      },
      rows as readonly TimelinePoint[],
      now,
      businessId,
    ),
  );
}

/* ────────────────────────────── DOC-05 · vendor amount stability ────────────────────────────── */

export const DOC05: RuleDescriptor = {
  ...SHARED,
  ruleId: "DOC-05",
  measureKey: "documents.vendor_amount_stability",
  policyKey: "documents-vendor-amount-stability",
  versionLabel: "v1",
  entityType: "party",
  windowDays: DOCUMENTS_WINDOW_DAYS,
  /**
   * Three documents — the same floor the earlier shadow amount-memory used, and re-derived rather
   * than inherited. Three is where "this vendor charges about this much" stops being a description
   * of one invoice and its neighbour.
   */
  minSupport: 3,
  valueUnit: "currency",
  question: "What does a given vendor usually charge this business, and how much does it vary?",
};

/**
 * NO TREND, deliberately.
 *
 * A rising median could be a price increase, a larger order, or a different product from the same
 * vendor, and this rule cannot tell those apart. Reporting IMPROVING or WORSENING would attach a
 * judgement to a movement whose cause is unobserved — and on an amount, "improving" does not even
 * have an agreed direction. The spread in `detail` carries the honest version of the same
 * information: how much this vendor's invoices vary at all.
 */
export function deriveVendorAmountStability(
  observations: readonly VendorDocumentObservation[],
  now: Date,
  businessId: number,
): MeasureResult[] {
  const expenses = observations.filter((o) => o.direction === EXPENSE);
  const byParty = groupByEntity(expenses, (o) => o.partyId);

  return [...byParty.entries()].map(([partyId, rows]) => {
    const points: ValuePoint[] = rows.map((r) => ({
      recordId: r.recordId,
      businessId: r.businessId,
      at: r.at,
      value: r.amount,
    }));
    return valueMeasure(
      {
        measureKey: DOC05.measureKey,
        entityType: "party",
        entityId: partyId,
        valueUnit: "currency",
        evidenceKind: "financial-record",
        minSupport: DOC05.minSupport,
        windowDays: DOC05.windowDays,
      },
      points,
      now,
      businessId,
    );
  });
}

/* ────────────────────────────── DOC-06 · correction rate ────────────────────────────── */

export const DOC06: RuleDescriptor = {
  ...SHARED,
  ruleId: "DOC-06",
  measureKey: "documents.correction_rate",
  policyKey: "documents-correction-rate",
  versionLabel: "v1",
  entityType: null,
  windowDays: DOCUMENTS_WINDOW_DAYS,
  minSupport: 10,
  valueUnit: "ratio",
  question: "How often does the owner have to correct what the extraction engine proposed?",
};

/**
 * The one measure here that is about Dubiz rather than about the business.
 *
 * `ReviewEvent.verdicts` has recorded, per field, what the engine believed and what the human
 * submitted, on every approval, since the correction ledger shipped. Nothing has ever read it back
 * as a rate. This does — and the number it produces is the extraction engine's report card, kept in
 * the same tenant-isolated, versioned, explainable form as everything the system says about the
 * business itself.
 *
 * It counts APPROVALS WHERE SOMETHING WAS CHANGED, not fields. A document where the human fixed the
 * vendor and the date is one correction, because the owner's experience is one document they could
 * not simply accept.
 *
 * `detail.byField` names WHICH fields, never their values — a corrected amount is the business's
 * money and has no place in a derived artifact.
 */
export function deriveCorrectionRate(
  observations: readonly ReviewObservation[],
  now: Date,
  businessId: number,
): MeasureResult[] {
  const points: SharePoint[] = observations.map((r) => ({
    recordId: r.recordId,
    businessId: r.businessId,
    at: r.at,
    hit: r.corrected,
  }));
  const result = shareMeasure(
    {
      measureKey: DOC06.measureKey,
      entityType: null,
      entityId: null,
      valueUnit: "ratio",
      evidenceKind: "review-event",
      minSupport: DOC06.minSupport,
      windowDays: DOC06.windowDays,
    },
    points,
    now,
    businessId,
  );
  if (result.status !== "ACTIVE") return [result];

  const byField: Record<string, number> = {};
  const windowStart = result.windowStart;
  for (const r of observations) {
    if (r.at < windowStart || r.at > now) continue;
    for (const f of r.correctedFields) byField[f] = (byField[f] ?? 0) + 1;
  }
  return [{ ...result, detail: { ...(result.detail ?? {}), byField } }];
}

/* ────────────────────────────── the three rules ────────────────────────────── */

export function documentRules(
  vendorRecords: EvidenceSource<VendorDocumentObservation>,
  reviews: EvidenceSource<ReviewObservation>,
): [KnowledgeRule<VendorDocumentObservation>[], KnowledgeRule<ReviewObservation>[]] {
  const tenantOfV = (o: readonly VendorDocumentObservation[]): number => o[0]?.businessId ?? 0;
  const tenantOfR = (o: readonly ReviewObservation[]): number => o[0]?.businessId ?? 0;
  return [
    [
      { descriptor: DOC02, source: vendorRecords, derive: (o, n) => deriveVendorBillingCadence(o, n, tenantOfV(o)) },
      { descriptor: DOC05, source: vendorRecords, derive: (o, n) => deriveVendorAmountStability(o, n, tenantOfV(o)) },
    ],
    [{ descriptor: DOC06, source: reviews, derive: (o, n) => deriveCorrectionRate(o, n, tenantOfR(o)) }],
  ];
}
