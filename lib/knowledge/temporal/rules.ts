/**
 * M6 · The temporal rule catalogue — which series of ONE business become temporal knowledge.
 *
 * Every rule here consumes an evidence source that already exists in lib/knowledge/evidence/sources.ts
 * (the only file in the knowledge layer that queries), over a longer window, and builds one or more
 * series from it: business-level, per entity, or per same-business context slice. The engine does the
 * statistics; this file decides WHAT a series is, and nothing else.
 *
 * Each rule also names the sensor-manifest rows it depends on (docs/learning/SENSOR_COVERAGE.md). A
 * test parses the manifest and fails if any of them is not COVERED / COVERED_BY_DOMAIN_STATE — or a
 * PARTIAL row that the rule explicitly justifies for the exact fields it uses. That is the evidence
 * boundary: a GAP or BLOCKED row cannot become an input by accident.
 *
 * NOT HERE, ON PURPOSE (see docs/learning/TEMPORAL_KNOWLEDGE.md for the full classification):
 *   INV-05 stock pressure   BLOCKED_BY_PRODUCT_DEFECT — alerts follow stock quantities, which the POS
 *                           held-sale defect corrupts
 *   AP-06 evidence backing  NOT_TEMPORAL — describes the evidence, not the business
 *   AP-03, SUPP-03          NEEDS_MORE_EVIDENCE as separate rates; AP-01's timing already carries the
 *                           lateness signal and per-supplier short rates need far more orders
 *   L0 facts                NOT_TEMPORAL — point-in-time by definition
 */
import { calendarDays } from "../rule-kit";
import * as sources from "../evidence/sources";
import type { SettlementObservation } from "../rules/payables";
import type { MovementObservation } from "../rules/inventory";
import type { SupplierDeliveryObservation, SupplierOrderObservation } from "../rules/suppliers";
import type { ReviewObservation, VendorDocumentObservation } from "../rules/documents";
import type { NumericPoint, RatePoint, TemporalSpec } from "./temporal.contract";

/** One series the engine will assess, and where it belongs. */
export type TemporalSeries =
  | {
      readonly kind: "numeric";
      readonly entityType: string | null;
      readonly entityId: number | null;
      readonly contextKey: string;
      readonly points: readonly NumericPoint[];
      readonly lastEventAt?: Date | null;
      /** For a context slice: the same-business baseline to fall back to when it is sparse. */
      readonly fallbackContextKey?: string;
    }
  | {
      readonly kind: "rate";
      readonly entityType: string | null;
      readonly entityId: number | null;
      readonly contextKey: string;
      readonly points: readonly RatePoint[];
      readonly fallbackContextKey?: string;
    };

export type TemporalRule<TObs> = {
  readonly ruleId: string;
  readonly temporalKey: string;
  readonly domain: "documents" | "payables" | "inventory" | "suppliers";
  readonly policyKey: string;
  readonly versionLabel: string;
  /** The M4 rule whose evidence this follows over time. */
  readonly followsRule: string;
  readonly spec: TemporalSpec;
  /** Exact action labels from docs/learning/SENSOR_COVERAGE.md. */
  readonly manifestDependencies: readonly string[];
  /** Required when a dependency is PARTIAL: why the fields this rule uses are nonetheless complete. */
  readonly partialJustification?: string;
  readonly source: { readonly key: string; load(businessId: number, asOf: Date): Promise<TObs[]> };
  series(observations: readonly TObs[]): TemporalSeries[];
};

export type AnyTemporalRule = TemporalRule<unknown>;

const loadWindow = (s: TemporalSpec) => s.historyDays + s.recentDays;

function byEntity<T>(rows: readonly T[], idOf: (r: T) => number | null): Map<number, T[]> {
  const m = new Map<number, T[]>();
  for (const r of rows) {
    const id = idOf(r);
    if (id == null) continue;
    const b = m.get(id);
    if (b) b.push(r);
    else m.set(id, [r]);
  }
  return new Map([...m.entries()].sort((a, b) => a[0] - b[0]));
}

/** Gaps between consecutive occurrences. The gap is dated at, and evidenced by, the later one. */
function gaps(events: readonly { at: Date; recordId: number }[], kind: string): { points: NumericPoint[]; last: Date | null } {
  const s = [...events].sort((a, b) => a.at.getTime() - b.at.getTime() || a.recordId - b.recordId);
  const points: NumericPoint[] = [];
  for (let i = 1; i < s.length; i += 1) {
    points.push({ at: s[i].at, value: calendarDays(s[i - 1].at, s[i].at), recordId: s[i].recordId, evidenceKind: kind });
  }
  return { points, last: s.length > 0 ? s[s.length - 1].at : null };
}

/* ─────────────────────────────── documents ─────────────────────────────── */

const DOC04_SPEC: TemporalSpec = {
  valueKind: "duration", unit: "days", historyDays: 365, recentDays: 90,
  minHistory: 12, minSpanDays: 90, minRecent: 4,
  materialFloor: 1.5, stableRelativeSpread: 0.5,
  trendPeriods: 4, minPerPeriod: 3, staleAfterDays: 120,
};

const tDoc04: TemporalRule<sources.PaperworkWithDirection> = {
  ruleId: "T-DOC-04", temporalKey: "documents.paperwork_lag", domain: "documents",
  policyKey: "temporal-documents-paperwork-lag", versionLabel: "v1", followsRule: "DOC-04",
  spec: DOC04_SPEC,
  manifestDependencies: ["Owner approves a document", "Financial record created"],
  source: {
    key: "temporal.documents.paperwork",
    load: (b, asOf) => sources.loadPaperworkWithDirection(b, asOf, loadWindow(DOC04_SPEC)),
  },
  series(obs) {
    const point = (o: sources.PaperworkWithDirection): NumericPoint => ({
      at: o.approvedAt, value: calendarDays(o.documentDate, o.approvedAt), recordId: o.recordId, evidenceKind: "financial-record",
    });
    const out: TemporalSeries[] = [
      { kind: "numeric", entityType: null, entityId: null, contextKey: "", points: obs.map(point) },
    ];
    // Context: income and expense documents may be filed on different rhythms. Each slice is judged on
    // its own history; a sparse slice says so and points at THIS business's overall baseline.
    for (const dir of ["expense", "income"]) {
      const slice = obs.filter((o) => o.direction === dir);
      if (slice.length > 0) {
        out.push({
          kind: "numeric", entityType: null, entityId: null, contextKey: `direction=${dir}`,
          points: slice.map(point), fallbackContextKey: "",
        });
      }
    }
    return out;
  },
};

const DOC05_SPEC: TemporalSpec = {
  valueKind: "amount", unit: "currency", historyDays: 365, recentDays: 120,
  minHistory: 6, minSpanDays: 90, minRecent: 3,
  materialFloor: 0.1, materialFloorIsRelative: true, stableRelativeSpread: 0.15,
  trendPeriods: 4, minPerPeriod: 2, staleAfterDays: 180,
};

const DOC_VENDOR_SOURCE = {
  key: "temporal.documents.vendor_records",
  load: (b: number, asOf: Date) => sources.loadVendorDocuments(b, asOf, loadWindow(DOC05_SPEC)),
};

const tDoc05: TemporalRule<VendorDocumentObservation> = {
  ruleId: "T-DOC-05", temporalKey: "documents.vendor_amount", domain: "documents",
  policyKey: "temporal-documents-vendor-amount", versionLabel: "v1", followsRule: "DOC-05",
  spec: DOC05_SPEC,
  manifestDependencies: ["Financial record created", "Document vendor ↔ supplier identity"],
  source: DOC_VENDOR_SOURCE,
  series(obs) {
    // Per RESOLVED party only (the loader drops unresolved vendor strings). Two spellings are two
    // parties until the owner or a valid tax id says otherwise — M6 has no authority to merge.
    const expenses = obs.filter((o) => o.direction === "expense");
    return [...byEntity(expenses, (o) => o.partyId)].map(([partyId, rows]) => ({
      kind: "numeric" as const, entityType: "party", entityId: partyId, contextKey: "",
      points: rows.map((o) => ({ at: o.at, value: o.amount, recordId: o.recordId, evidenceKind: "financial-record" })),
    }));
  },
};

const DOC02_SPEC: TemporalSpec = {
  valueKind: "cadence", unit: "days", historyDays: 365, recentDays: 120,
  minHistory: 5, minSpanDays: 90, minRecent: 3,
  materialFloor: 5, stableRelativeSpread: 0.3,
  trendPeriods: 4, minPerPeriod: 2, staleAfterDays: 240,
};

const tDoc02: TemporalRule<VendorDocumentObservation> = {
  ruleId: "T-DOC-02", temporalKey: "documents.vendor_cadence", domain: "documents",
  policyKey: "temporal-documents-vendor-cadence", versionLabel: "v1", followsRule: "DOC-02",
  spec: DOC02_SPEC,
  manifestDependencies: ["Financial record created", "Document vendor ↔ supplier identity"],
  source: DOC_VENDOR_SOURCE,
  series(obs) {
    const expenses = obs.filter((o) => o.direction === "expense");
    return [...byEntity(expenses, (o) => o.partyId)].map(([partyId, rows]) => {
      const g = gaps(rows.map((r) => ({ at: r.at, recordId: r.recordId })), "financial-record");
      return { kind: "numeric" as const, entityType: "party", entityId: partyId, contextKey: "", points: g.points, lastEventAt: g.last };
    });
  },
};

const DOC06_SPEC: TemporalSpec = {
  valueKind: "rate", unit: "ratio", historyDays: 365, recentDays: 90,
  minHistory: 30, minSpanDays: 90, minRecent: 15,
  materialFloor: 0.1, stableRelativeSpread: 0,
  trendPeriods: 4, minPerPeriod: 8, staleAfterDays: 120,
};

const tDoc06: TemporalRule<ReviewObservation> = {
  ruleId: "T-DOC-06", temporalKey: "documents.correction_rate", domain: "documents",
  policyKey: "temporal-documents-correction-rate", versionLabel: "v1", followsRule: "DOC-06",
  spec: DOC06_SPEC,
  manifestDependencies: ["Owner corrects extracted fields"],
  source: {
    key: "temporal.documents.reviews",
    load: (b, asOf) => sources.loadReviews(b, asOf, loadWindow(DOC06_SPEC)),
  },
  series(obs) {
    return [{
      kind: "rate", entityType: null, entityId: null, contextKey: "",
      points: obs.map((o) => ({ at: o.at, hit: o.corrected, recordId: o.recordId, evidenceKind: "review-event" })),
    }];
  },
};

/* ─────────────────────────────── payables ─────────────────────────────── */

const AP01_SPEC: TemporalSpec = {
  valueKind: "duration", unit: "days", historyDays: 365, recentDays: 90,
  minHistory: 10, minSpanDays: 90, minRecent: 4,
  materialFloor: 2, stableRelativeSpread: 0.5,
  trendPeriods: 4, minPerPeriod: 3, staleAfterDays: 120,
};
const AP04_SPEC: TemporalSpec = { ...AP01_SPEC, recentDays: 120, minHistory: 6, minRecent: 3, minPerPeriod: 2, staleAfterDays: 180 };

const SETTLEMENT_SOURCE = {
  key: "temporal.payables.settlements",
  load: (b: number, asOf: Date) => sources.loadSettlements(b, asOf, loadWindow(AP04_SPEC)),
};
const settlementPoint = (o: SettlementObservation): NumericPoint => ({
  // Signed: negative is early. Flattening it to a magnitude would turn a punctual payer into a late one.
  at: o.at, value: calendarDays(o.expectedAt, o.at), recordId: o.recordId, evidenceKind: "payment-allocation",
});
const AP_DEPENDENCIES = [
  "Commitment + installments created", "Manual payment recorded", "Payment voided", "Allocation reversed",
];

const tAp01: TemporalRule<SettlementObservation> = {
  ruleId: "T-AP-01", temporalKey: "payables.payment_timing", domain: "payables",
  policyKey: "temporal-payables-payment-timing", versionLabel: "v1", followsRule: "AP-01",
  spec: AP01_SPEC, manifestDependencies: AP_DEPENDENCIES, source: SETTLEMENT_SOURCE,
  series(obs) {
    return [{ kind: "numeric", entityType: null, entityId: null, contextKey: "", points: obs.map(settlementPoint) }];
  },
};

const tAp04: TemporalRule<SettlementObservation> = {
  ruleId: "T-AP-04", temporalKey: "payables.payee_payment_timing", domain: "payables",
  policyKey: "temporal-payables-payee-timing", versionLabel: "v1", followsRule: "AP-04",
  spec: AP04_SPEC, manifestDependencies: AP_DEPENDENCIES, source: SETTLEMENT_SOURCE,
  series(obs) {
    return [...byEntity(obs, (o) => o.payeeId)].map(([payeeId, rows]) => ({
      kind: "numeric" as const, entityType: "payee", entityId: payeeId, contextKey: "", points: rows.map(settlementPoint),
    }));
  },
};

/* ─────────────────────────────── inventory ─────────────────────────────── */

const INV02_SPEC: TemporalSpec = {
  valueKind: "cadence", unit: "days", historyDays: 180, recentDays: 60,
  minHistory: 5, minSpanDays: 45, minRecent: 3,
  materialFloor: 3, stableRelativeSpread: 0.3,
  trendPeriods: 4, minPerPeriod: 2, staleAfterDays: 120,
};
const INV04_SPEC: TemporalSpec = {
  valueKind: "rate", unit: "ratio", historyDays: 180, recentDays: 60,
  minHistory: 30, minSpanDays: 45, minRecent: 15,
  materialFloor: 0.1, stableRelativeSpread: 0,
  trendPeriods: 4, minPerPeriod: 8, staleAfterDays: 90,
};
const MOVEMENT_SOURCE = {
  key: "temporal.inventory.movements",
  load: (b: number, asOf: Date) => sources.loadMovements(b, asOf, loadWindow(INV02_SPEC)),
};
const RESTOCK = new Set(["SUPPLIER_PURCHASE", "MANUAL_ADD"]);

const tInv02: TemporalRule<MovementObservation> = {
  ruleId: "T-INV-02", temporalKey: "inventory.restock_cadence", domain: "inventory",
  policyKey: "temporal-inventory-restock-cadence", versionLabel: "v1", followsRule: "INV-02",
  spec: INV02_SPEC,
  manifestDependencies: ["Quantity changed / manual correction", "Receiving posted"],
  source: MOVEMENT_SOURCE,
  series(obs) {
    // Restock EVENTS only, and their timing only — never quantities, which the POS held-sale defect
    // can corrupt. A restock's date is true whatever the stock level it produced.
    const restocks = obs.filter((m) => m.movementType === "IN" && RESTOCK.has(m.reason));
    return [...byEntity(restocks, (m) => m.itemId)].map(([itemId, rows]) => {
      const g = gaps(rows.map((r) => ({ at: r.at, recordId: r.recordId })), "inventory-movement");
      return { kind: "numeric" as const, entityType: "inventory-item", entityId: itemId, contextKey: "", points: g.points, lastEventAt: g.last };
    });
  },
};

const tInv04: TemporalRule<MovementObservation> = {
  ruleId: "T-INV-04", temporalKey: "inventory.correction_share", domain: "inventory",
  policyKey: "temporal-inventory-correction-share", versionLabel: "v1", followsRule: "INV-04",
  spec: INV04_SPEC,
  manifestDependencies: ["Quantity changed / manual correction"],
  source: MOVEMENT_SOURCE,
  series(obs) {
    // A COUNT of movements by recorded reason — quantities are not read, so the POS defect's wrong
    // deductions cannot distort it. What a correction was FOR is not claimed.
    return [{
      kind: "rate", entityType: null, entityId: null, contextKey: "",
      points: obs.map((m) => ({ at: m.at, hit: m.reason === "INVENTORY_COUNT_CORRECTION", recordId: m.recordId, evidenceKind: "inventory-movement" })),
    }];
  },
};

/* ─────────────────────────────── suppliers ─────────────────────────────── */

const SUPP01_SPEC: TemporalSpec = {
  valueKind: "cadence", unit: "days", historyDays: 365, recentDays: 120,
  minHistory: 5, minSpanDays: 90, minRecent: 3,
  materialFloor: 5, stableRelativeSpread: 0.3,
  trendPeriods: 4, minPerPeriod: 2, staleAfterDays: 240,
};
const SUPP02_SPEC: TemporalSpec = {
  valueKind: "duration", unit: "days", historyDays: 365, recentDays: 120,
  minHistory: 5, minSpanDays: 90, minRecent: 3,
  materialFloor: 2, stableRelativeSpread: 0.5,
  trendPeriods: 4, minPerPeriod: 2, staleAfterDays: 240,
};

const tSupp01: TemporalRule<SupplierOrderObservation> = {
  ruleId: "T-SUPP-01", temporalKey: "suppliers.purchase_cadence", domain: "suppliers",
  policyKey: "temporal-suppliers-purchase-cadence", versionLabel: "v1", followsRule: "SUPP-01",
  spec: SUPP01_SPEC,
  manifestDependencies: ["Purchase order created by the owner", "Purchase order created by approving a draft"],
  partialJustification:
    "'Purchase order created by the owner' is PARTIAL only because PurchaseOrder.source is client-supplied. " +
    "This rule reads supplierId (a verified tenant FK), orderDate/createdAt and status (DRAFT/CANCELLED excluded) — " +
    "never `source` — so the partial field is not an input.",
  source: {
    key: "temporal.suppliers.orders",
    load: (b, asOf) => sources.loadSupplierOrders(b, asOf, loadWindow(SUPP01_SPEC)),
  },
  series(obs) {
    return [...byEntity(obs, (o) => o.supplierId)].map(([supplierId, rows]) => {
      const g = gaps(rows.map((r) => ({ at: r.at, recordId: r.recordId })), "purchase-order");
      return { kind: "numeric" as const, entityType: "supplier", entityId: supplierId, contextKey: "", points: g.points, lastEventAt: g.last };
    });
  },
};

const tSupp02: TemporalRule<SupplierDeliveryObservation> = {
  ruleId: "T-SUPP-02", temporalKey: "suppliers.delivery_lag", domain: "suppliers",
  policyKey: "temporal-suppliers-delivery-lag", versionLabel: "v1", followsRule: "SUPP-02",
  spec: SUPP02_SPEC,
  manifestDependencies: ["Receiving posted", "Purchase order created by approving a draft"],
  source: {
    key: "temporal.suppliers.deliveries",
    // The v2 loader: orders created-and-received by one draft-approval click are excluded.
    load: (b, asOf) => sources.loadSupplierDeliveries(b, asOf, loadWindow(SUPP02_SPEC)),
  },
  series(obs) {
    return [...byEntity(obs, (o) => o.supplierId)].map(([supplierId, rows]) => ({
      kind: "numeric" as const, entityType: "supplier", entityId: supplierId, contextKey: "",
      points: rows.map((o) => ({ at: o.at, value: calendarDays(o.expectedAt, o.at), recordId: o.recordId, evidenceKind: "purchase-order" })),
    }));
  },
};

/** Built per call, like the M4 catalogue: nothing is constructed at import time. */
export function temporalCatalogue(): AnyTemporalRule[] {
  return [tDoc04, tDoc05, tDoc02, tDoc06, tAp01, tAp04, tInv02, tInv04, tSupp01, tSupp02] as unknown as AnyTemporalRule[];
}
