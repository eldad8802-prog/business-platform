/**
 * M4 · SUPPLIERS — the rhythm and reliability of this business's purchasing relationships.
 *
 * THE IDENTITY PRECONDITION, AND WHY IT IS NOT NEGOTIABLE
 *
 * Every measure here is keyed on `Supplier.id`, reached through `PurchaseOrder.supplierId` — a real
 * foreign key, verified tenant-scoped when the order was created. Purchase orders also carry a
 * free-text `supplierName`, and grouping by that string would produce more measures covering more of
 * the data. It is not done, anywhere, at any confidence.
 *
 * "ספקי הצפון" and "ספקי הצפון בע״מ" are two strings. Whether they are one supplier is a question
 * about the world, and the only honest answers are a strong identifier or the owner. Until one of
 * those exists the two orders belong to two subjects, and a cadence computed across them would be a
 * rhythm no supplier has. A correctly unresolved identity is better than a false join — which is why
 * the identity layer proposes relationships and never merges records.
 *
 * WHAT IS NOT MEASURED, AND WHY NOT
 *   Order SIZE in money. `PurchaseOrder` has no total, and reconstructing one from line
 *   `unitCost × orderedQty` would silently treat every null cost as zero — producing a confident
 *   number that is wrong in exactly the cases where a supplier's pricing is not recorded. There is no
 *   honest version of that measure on this schema, so there is no version of it.
 */
import type { KnowledgeRule, RuleDescriptor, EvidenceSource } from "../rule.contract";
import type { MeasureResult } from "../measure.contract";
import {
  cadenceMeasure,
  groupByEntity,
  latencyMeasure,
  shareMeasure,
  type LatencyPoint,
  type SharePoint,
  type TimelinePoint,
} from "../rule-kit";

/** One purchase order placed with an identified supplier. */
export type SupplierOrderObservation = {
  /** The `PurchaseOrder` id. */
  readonly recordId: number;
  readonly businessId: number;
  /**
   * `orderDate` when the owner recorded one, otherwise `createdAt`.
   *
   * The fallback is counted, not hidden: `detail.datedFromCreation` says how many observations in
   * the sample had no business date of their own, so a consumer can discount a cadence built mostly
   * out of row-creation timestamps instead of discovering it later.
   */
  readonly at: Date;
  readonly supplierId: number;
  readonly datedFromCreation: boolean;
};

/**
 * One CLOSED purchase order and how it actually finished.
 *
 * The unit is the ORDER, not the receiving session, because an order delivered in three visits is one
 * thing the owner ordered and waited for. `status = CLOSED` is what makes the question answerable at
 * all: an order still awaiting delivery has no lead time yet and cannot be short yet — it is simply
 * unfinished, and counting it either way would be wrong.
 */
export type SupplierDeliveryObservation = {
  /** The `PurchaseOrder` id. */
  readonly recordId: number;
  readonly businessId: number;
  /** The LAST posted `ReceivingSession.receivedAt` — the day the order finished arriving. */
  readonly at: Date;
  /** `PurchaseOrder.orderDate`. */
  readonly expectedAt: Date;
  readonly supplierId: number;
  /** How many lines the order had, and how many finished with less received than ordered. */
  readonly linesOrdered: number;
  readonly linesShort: number;
};

export const SUPPLIERS_WINDOW_DAYS = 365;

const SHARED: Pick<RuleDescriptor, "domain" | "windowDays" | "freshness"> = {
  domain: "suppliers",
  windowDays: SUPPLIERS_WINDOW_DAYS,
  freshness: ["NEW_EVIDENCE", "WINDOW_ROLLED", "ENTITY_GONE", "OWNER_CORRECTION", "RULE_VERSION_CHANGED"],
};

export function makeOrderSource(
  load: EvidenceSource<SupplierOrderObservation>["load"],
): EvidenceSource<SupplierOrderObservation> {
  return { key: "suppliers.orders", windowDays: SUPPLIERS_WINDOW_DAYS, load };
}

export function makeDeliverySource(
  load: EvidenceSource<SupplierDeliveryObservation>["load"],
): EvidenceSource<SupplierDeliveryObservation> {
  return { key: "suppliers.deliveries", windowDays: SUPPLIERS_WINDOW_DAYS, load };
}

/* ────────────────────────────── SUPP-01 · purchase cadence ────────────────────────────── */

export const SUPP01: RuleDescriptor = {
  ...SHARED,
  ruleId: "SUPP-01",
  measureKey: "suppliers.purchase_cadence",
  policyKey: "suppliers-purchase-cadence",
  versionLabel: "v1",
  entityType: "supplier",
  /** Three gaps, so four orders. Two orders make a gap; they do not make a cycle. */
  minSupport: 3,
  valueUnit: "days",
  question: "How many days typically pass between this business's orders from a given supplier?",
};

/** A week. Purchasing rhythms are lumpy, and a two-day shift in a monthly cycle is not a change. */
const CADENCE_TREND_MIN_DELTA = 7;

export function derivePurchaseCadence(
  observations: readonly SupplierOrderObservation[],
  now: Date,
  businessId: number,
): MeasureResult[] {
  const bySupplier = groupByEntity(observations, (o) => o.supplierId);

  return [...bySupplier.entries()].map(([supplierId, rows]) => {
    const result = cadenceMeasure(
      {
        measureKey: SUPP01.measureKey,
        entityType: "supplier",
        entityId: supplierId,
        valueUnit: "days",
        evidenceKind: "purchase-order",
        minSupport: SUPP01.minSupport,
        windowDays: SUPP01.windowDays,
        trendMinDelta: CADENCE_TREND_MIN_DELTA,
      },
      rows as readonly TimelinePoint[],
      now,
      businessId,
    );
    return {
      ...result,
      detail: {
        ...(result.detail ?? {}),
        datedFromCreation: rows.filter((r) => r.datedFromCreation).length,
      },
    };
  });
}

/* ────────────────────────────── SUPP-02 · delivery lag ────────────────────────────── */

export const SUPP02: RuleDescriptor = {
  ...SHARED,
  ruleId: "SUPP-02",
  measureKey: "suppliers.delivery_lag",
  policyKey: "suppliers-delivery-lag",
  // v2 (M5.5): orders created-and-received by draft approval are excluded (zero lead time by construction).
  versionLabel: "v2",
  entityType: "supplier",
  minSupport: 3,
  valueUnit: "days",
  question: "How long does a given supplier usually take between the order and the goods arriving?",
};

/**
 * Measured order date → received date, and only where BOTH are real dates the owner supplied.
 *
 * An order with no `orderDate` is excluded here rather than falling back to `createdAt` the way the
 * cadence rule does, and the asymmetry is deliberate: a cadence is a rhythm of activity and a
 * creation timestamp is a usable proxy for when activity happened, but a LEAD TIME is the distance
 * between two specific business events. Substituting a row's creation time for the order date would
 * not be a slightly noisier lead time — it would be a different quantity wearing the same name.
 *
 * `Supplier.defaultLeadTimeDays` exists and is NOT used as evidence. It is what the owner expects;
 * this measure is what happened. Comparing the two is a legitimate question for a later milestone,
 * and answering it requires keeping them apart now.
 */
const DELIVERY_TREND_MIN_DELTA = 2;

export function deriveDeliveryLag(
  observations: readonly SupplierDeliveryObservation[],
  now: Date,
  businessId: number,
): MeasureResult[] {
  const bySupplier = groupByEntity(observations, (o) => o.supplierId);

  return [...bySupplier.entries()].map(([supplierId, rows]) =>
    latencyMeasure(
      {
        measureKey: SUPP02.measureKey,
        entityType: "supplier",
        entityId: supplierId,
        valueUnit: "days",
        evidenceKind: "purchase-order",
        minSupport: SUPP02.minSupport,
        windowDays: SUPP02.windowDays,
        trendMinDelta: DELIVERY_TREND_MIN_DELTA,
      },
      rows as readonly LatencyPoint[],
      now,
      businessId,
    ),
  );
}

/* ────────────────────────────── SUPP-03 · short deliveries ────────────────────────────── */

export const SUPP03: RuleDescriptor = {
  ...SHARED,
  ruleId: "SUPP-03",
  measureKey: "suppliers.short_delivery_share",
  policyKey: "suppliers-short-delivery-share",
  // v2 (M5.5): orders created-and-received by draft approval are excluded (never short by construction).
  versionLabel: "v2",
  entityType: "supplier",
  minSupport: 3,
  valueUnit: "ratio",
  question: "How often does a given supplier deliver less than was ordered?",
};

/**
 * Counted per ORDER, not per line.
 *
 * A twelve-line order that closes with one line short is one incomplete order, and per-line counting
 * would score it 92% complete — flattering a supplier whose shipment the owner still had to chase.
 * The owner's experience is the unit, so the order is the unit.
 *
 * This measures what ARRIVED against what was ORDERED, on orders that are finished. It is not a
 * claim about the supplier's intent, their stock, or a dispute: a line can be short because the
 * owner cancelled the remainder or accepted a substitute, and the receiving record looks identical
 * in every case. "This supplier's orders often close short" is the fact; why is not observed.
 */
export function deriveShortDeliveryShare(
  observations: readonly SupplierDeliveryObservation[],
  now: Date,
  businessId: number,
): MeasureResult[] {
  const bySupplier = groupByEntity(observations, (o) => o.supplierId);

  return [...bySupplier.entries()].map(([supplierId, rows]) => {
    const points: SharePoint[] = rows.map((r) => ({
      recordId: r.recordId,
      businessId: r.businessId,
      at: r.at,
      hit: r.linesShort > 0,
    }));
    const result = shareMeasure(
      {
        measureKey: SUPP03.measureKey,
        entityType: "supplier",
        entityId: supplierId,
        valueUnit: "ratio",
        evidenceKind: "purchase-order",
        minSupport: SUPP03.minSupport,
        windowDays: SUPP03.windowDays,
      },
      points,
      now,
      businessId,
    );
    return {
      ...result,
      detail: {
        ...(result.detail ?? {}),
        linesShortTotal: rows.reduce((s, r) => s + r.linesShort, 0),
        linesOrderedTotal: rows.reduce((s, r) => s + r.linesOrdered, 0),
      },
    };
  });
}

/* ────────────────────────────── the three rules ────────────────────────────── */

export function supplierRules(
  orders: EvidenceSource<SupplierOrderObservation>,
  deliveries: EvidenceSource<SupplierDeliveryObservation>,
): [KnowledgeRule<SupplierOrderObservation>[], KnowledgeRule<SupplierDeliveryObservation>[]] {
  const tenantOfO = (o: readonly SupplierOrderObservation[]): number => o[0]?.businessId ?? 0;
  const tenantOfD = (o: readonly SupplierDeliveryObservation[]): number => o[0]?.businessId ?? 0;
  return [
    [{ descriptor: SUPP01, source: orders, derive: (o, n) => derivePurchaseCadence(o, n, tenantOfO(o)) }],
    [
      { descriptor: SUPP02, source: deliveries, derive: (o, n) => deriveDeliveryLag(o, n, tenantOfD(o)) },
      { descriptor: SUPP03, source: deliveries, derive: (o, n) => deriveShortDeliveryShare(o, n, tenantOfD(o)) },
    ],
  ];
}
