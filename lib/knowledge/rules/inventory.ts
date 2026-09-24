/**
 * M4 · INVENTORY — how stock actually moves through this business.
 *
 * THE ONE HONESTY CONSTRAINT THAT SHAPES EVERY RULE HERE
 *
 * `InventoryMovement` has exactly one clock: `createdAt`. There is no `occurredAt`, no sale time, no
 * effective date. For a point-of-sale line that is the moment the webhook arrived; for a receiving
 * session it is the moment the owner posted it, which may be days after the goods came in.
 *
 * So these measures describe WHEN STOCK CHANGES WERE RECORDED, and they are named and worded that
 * way. None of them is called "demand", because demand is what customers did and this table knows
 * what the system was told. A restock interval is a purchasing-and-recording rhythm; a movement is an
 * entry, not an event. Naming it otherwise would be the cheapest possible lie and the hardest to
 * find later, because the numbers would look entirely reasonable.
 *
 * The distortion is bounded and worth stating: it inflates gaps when the owner batches their entry
 * and compresses them when they catch up. `detail.recordedTimeOnly` carries the caveat with the
 * artifact so a consumer never has to remember it.
 */
import type { KnowledgeRule, RuleDescriptor, EvidenceSource } from "../rule.contract";
import type { MeasureResult } from "../measure.contract";
import {
  cadenceMeasure,
  countMeasure,
  groupByEntity,
  shareMeasure,
  type SharePoint,
  type TimelinePoint,
} from "../rule-kit";

/** One row of `InventoryMovement`, reduced to what a rule may see. */
export type MovementObservation = {
  /** The `InventoryMovement` id. */
  readonly recordId: number;
  readonly businessId: number;
  /** `createdAt` — the recording time. See the header: this is not the event time. */
  readonly at: Date;
  readonly itemId: number;
  /** `InventoryMovementType`: "IN" | "OUT" | "ADJUSTMENT". The direction bucket. */
  readonly movementType: string;
  /** `InventoryMovementReason`. The MEANING — this is the column the rules actually discriminate on. */
  readonly reason: string;
};

/** One row of `InventoryAlert`, at the moment it was raised. */
export type AlertObservation = {
  readonly recordId: number;
  readonly businessId: number;
  readonly at: Date;
  readonly itemId: number;
  /** `InventoryAlertType`. */
  readonly alertType: string;
};

export const INVENTORY_WINDOW_DAYS = 180;

const SHARED: Pick<RuleDescriptor, "domain" | "windowDays" | "freshness"> = {
  domain: "inventory",
  windowDays: INVENTORY_WINDOW_DAYS,
  freshness: ["NEW_EVIDENCE", "WINDOW_ROLLED", "ENTITY_GONE", "RULE_VERSION_CHANGED"],
};

/** The caveat every inventory measure carries, so a consumer inherits it with the number. */
const RECORDED_TIME_CAVEAT = { recordedTimeOnly: true } as const;

export function makeMovementSource(
  load: EvidenceSource<MovementObservation>["load"],
): EvidenceSource<MovementObservation> {
  return { key: "inventory.movements", windowDays: INVENTORY_WINDOW_DAYS, load };
}

export function makeAlertSource(
  load: EvidenceSource<AlertObservation>["load"],
): EvidenceSource<AlertObservation> {
  return { key: "inventory.alerts", windowDays: INVENTORY_WINDOW_DAYS, load };
}

/* ────────────────────────────── INV-02 · restock interval ────────────────────────────── */

export const INV02: RuleDescriptor = {
  ...SHARED,
  ruleId: "INV-02",
  measureKey: "inventory.restock_interval",
  policyKey: "inventory-restock-interval",
  versionLabel: "v1",
  entityType: "inventory-item",
  /** Three gaps — so four recorded restocks — before this will call anything a rhythm. */
  minSupport: 3,
  valueUnit: "days",
  question: "How often does this business record replenishing a given item?",
};

/**
 * What counts as a restock.
 *
 * `SUPPLIER_PURCHASE` is a posted receiving session and `MANUAL_ADD` is the owner adding stock by
 * hand; both are the owner putting goods back on the shelf, which is the behaviour being measured.
 *
 * `INITIAL_STOCK` is excluded: it happens once, when the item is created, and including it would
 * make every item's first gap "the time from existing to being restocked", which is not a
 * replenishment interval. `RETURN` is excluded for the same reason from the other direction — a
 * customer handing something back is not the business deciding to buy more.
 */
const RESTOCK_REASONS = new Set(["SUPPLIER_PURCHASE", "MANUAL_ADD"]);

/** Three days: below that, two restocks are one delivery split across two entries. */
const RESTOCK_TREND_MIN_DELTA = 3;

export function deriveRestockInterval(
  observations: readonly MovementObservation[],
  now: Date,
  businessId: number,
): MeasureResult[] {
  const restocks = observations.filter(
    (m) => m.movementType === "IN" && RESTOCK_REASONS.has(m.reason),
  );
  const byItem = groupByEntity(restocks, (m) => m.itemId);

  return [...byItem.entries()].map(([itemId, rows]) => {
    const result = cadenceMeasure(
      {
        measureKey: INV02.measureKey,
        entityType: "inventory-item",
        entityId: itemId,
        valueUnit: "days",
        evidenceKind: "inventory-movement",
        minSupport: INV02.minSupport,
        windowDays: INV02.windowDays,
        trendMinDelta: RESTOCK_TREND_MIN_DELTA,
      },
      rows as readonly TimelinePoint[],
      now,
      businessId,
    );
    return { ...result, detail: { ...(result.detail ?? {}), ...RECORDED_TIME_CAVEAT } };
  });
}

/* ────────────────────────────── INV-04 · count-correction share ────────────────────────────── */

export const INV04: RuleDescriptor = {
  ...SHARED,
  ruleId: "INV-04",
  measureKey: "inventory.count_correction_share",
  policyKey: "inventory-count-correction-share",
  versionLabel: "v1",
  entityType: null,
  minSupport: 10,
  valueUnit: "ratio",
  question: "How often does this business have to correct its own stock figures?",
};

/**
 * Why this is worth knowing.
 *
 * A stock count correction is the moment the book and the shelf disagreed and the shelf won. A high
 * share does not mean anyone is careless — it usually means sales or shrinkage are entering the
 * system somewhere other than through Dubiz. Either way it is the single best indicator of how much
 * the recorded quantities can be trusted, and that is a precondition for every other inventory claim.
 *
 * Ten movements minimum, higher than anywhere else in the catalogue, because a ratio over five
 * movements swings by twenty points on one entry.
 */
export function deriveCountCorrectionShare(
  observations: readonly MovementObservation[],
  now: Date,
  businessId: number,
): MeasureResult[] {
  const points: SharePoint[] = observations.map((m) => ({
    recordId: m.recordId,
    businessId: m.businessId,
    at: m.at,
    hit: m.reason === "INVENTORY_COUNT_CORRECTION",
  }));
  const result = shareMeasure(
    {
      measureKey: INV04.measureKey,
      entityType: null,
      entityId: null,
      valueUnit: "ratio",
      evidenceKind: "inventory-movement",
      minSupport: INV04.minSupport,
      windowDays: INV04.windowDays,
    },
    points,
    now,
    businessId,
  );
  return [{ ...result, detail: { ...(result.detail ?? {}), ...RECORDED_TIME_CAVEAT } }];
}

/* ────────────────────────────── INV-05 · stock pressure ────────────────────────────── */

export const INV05: RuleDescriptor = {
  ...SHARED,
  ruleId: "INV-05",
  measureKey: "inventory.stock_pressure",
  policyKey: "inventory-stock-pressure",
  versionLabel: "v1",
  entityType: "inventory-item",
  /**
   * Two, because one is not a pattern and this measure's whole content is recurrence.
   *
   * An item that dipped below its threshold once had a busy week. An item that has done it twice in
   * six months has a threshold that does not match how it sells, or a lead time nobody planned for —
   * and THAT is a fact about the business rather than about the week.
   */
  minSupport: 2,
  valueUnit: "count",
  question: "Which items keep running down to their threshold, and how often?",
};

const PRESSURE_ALERT_TYPES = new Set(["LOW_STOCK", "CRITICAL_STOCK"]);

export function deriveStockPressure(
  observations: readonly AlertObservation[],
  now: Date,
  businessId: number,
): MeasureResult[] {
  const pressure = observations.filter((a) => PRESSURE_ALERT_TYPES.has(a.alertType));
  const byItem = groupByEntity(pressure, (a) => a.itemId);

  return [...byItem.entries()].map(([itemId, rows]) => {
    const result = countMeasure(
      {
        measureKey: INV05.measureKey,
        entityType: "inventory-item",
        entityId: itemId,
        valueUnit: "count",
        evidenceKind: "inventory-alert",
        minSupport: INV05.minSupport,
        windowDays: INV05.windowDays,
      },
      rows as readonly TimelinePoint[],
      now,
      businessId,
    );
    return {
      ...result,
      detail: {
        ...(result.detail ?? {}),
        ...RECORDED_TIME_CAVEAT,
        criticalCount: rows.filter((r) => r.alertType === "CRITICAL_STOCK").length,
      },
    };
  });
}

/* ────────────────────────────── the three rules ────────────────────────────── */

export function inventoryRules(
  movements: EvidenceSource<MovementObservation>,
  alerts: EvidenceSource<AlertObservation>,
): [KnowledgeRule<MovementObservation>[], KnowledgeRule<AlertObservation>[]] {
  const tenantOfM = (o: readonly MovementObservation[]): number => o[0]?.businessId ?? 0;
  const tenantOfA = (o: readonly AlertObservation[]): number => o[0]?.businessId ?? 0;
  return [
    [
      { descriptor: INV02, source: movements, derive: (o, n) => deriveRestockInterval(o, n, tenantOfM(o)) },
      { descriptor: INV04, source: movements, derive: (o, n) => deriveCountCorrectionShare(o, n, tenantOfM(o)) },
    ],
    [{ descriptor: INV05, source: alerts, derive: (o, n) => deriveStockPressure(o, n, tenantOfA(o)) }],
  ];
}
