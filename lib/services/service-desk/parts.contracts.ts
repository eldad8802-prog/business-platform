/**
 * Service Desk 1.2c / M1 — the contracts of spare parts in a service case (חלקי חילוף בקריאת שירות).
 *
 * Owner approval for M1 (2026-11-05), binding:
 *   - the existing inventory module is the only stock: Service Desk never keeps a quantity of its own and never
 *     writes InventoryItem.currentQuantity; a future stock change is ONE InventoryMovement made by the inventory
 *     module's own writer (`inventoryService.createMovement`), after M0 (inventory session) makes it atomic;
 *   - SOFT reservation: a part may be reserved for a case and two cases may not reserve the same units, but a
 *     reservation is NOT a hard allocation — a sale at the till or any other inventory flow can still take the
 *     units; availability is checked again before the part physically leaves the stock, and an issue that no longer
 *     fits fails safely (the part stays as it was, stock never goes negative);
 *   - states are not movements: reserve, install, write-off, release and cancel never move stock; ISSUE (the part
 *     physically leaves the stock) is one OUT movement; RETURN of a part fit to go back is one IN movement;
 *   - a case cancel is never blocked by parts, but it cannot be COMPLETED while a part that left the stock is
 *     unresolved — each such part needs a return, an installation record or a write-off (`planPartsForCaseCancel`);
 *     the case status machine (service-case.core.ts) is unchanged;
 *   - the part's cost is a historical value captured at ISSUE, with its source; a later purchase price never changes
 *     it; purchase cost, cost to the repair and price to the customer are three different numbers and the selling
 *     price is never taken as a cost;
 *   - no charge, payment, commitment or accounting document is ever produced.
 *
 * Owner decisions 2026-11-05 (second message):
 *   ק‑3 the cancel request is allowed with issued parts; it is complete only when every issued part is returned,
 *       installed or written off; a cancel never moves stock by itself. The case machine stays unchanged — so a case
 *       status CANCELLED (FIELD / nothing held) is NOT proof that its parts are resolved: `planPartsForCaseCancel`
 *       is the only answer to "are the parts resolved" (a case-level guard is a 1.3 proposal);
 *   ק‑4 partial return by splitting the line: the original line keeps the rest, a child line holds the returned
 *       quantity; original = rest + returned, one IN movement per approved return, the history kept;
 *   ק‑5 labour is a separate quote line — nothing in the parts core;
 *   ק‑6 a part may leave the stock before the quote is approved only after a clear warning AND the owner's explicit
 *       confirmation, recorded with the acting user — a warning alone is never a confirmation;
 *   ק‑7 no inventory item is created from a case — items come from the inventory module only;
 *   ק‑8 two tables (part line + append-only journal) as the direction; the schema is M2;
 *   ק‑9 cost source order: the last purchase cost if available and reliable (> 0), else the item's cost per unit if
 *       reliable (> 0), else unknown — never invented; when both are reliable and disagree the core refuses the
 *       automatic choice and the owner chooses explicitly (or enters a manual cost).
 *
 * Pure: no database, clock, network or randomness. Every `serverChecks` entry names a fact the future service layer
 * (M3) must establish in the database, in the same transaction — a pure decision is never proof of it.
 */
import type { ServiceCaseActor, ServiceCaseStatus, ServiceEventPayloadValue, ServiceOutcome } from "./contracts";

export const PART_STATES = [
  "NEEDED", // נדרש
  "ON_ORDER", // בהזמנה
  "RESERVED", // שוריין (שריון רך)
  "ISSUED", // נלקח מהמלאי
  "INSTALLED", // הותקן
  "RETURNED", // הוחזר (למלאי, כשהוא חלק מלאי)
  "WRITTEN_OFF", // נפסל
  "CANCELLED", // בוטל לפני שנלקח
] as const;
export type PartState = (typeof PART_STATES)[number];

/** A part still needs a decision: it counts as open on the case (CLOSE is refused while any is open). */
export const OPEN_PART_STATES: readonly PartState[] = ["NEEDED", "ON_ORDER", "RESERVED", "ISSUED"];
export const TERMINAL_PART_STATES: readonly PartState[] = ["INSTALLED", "RETURNED", "WRITTEN_OFF", "CANCELLED"];
/** States in which the part has physically left the stock (or never belonged to it) and was not given back. */
export const LEFT_STOCK_STATES: readonly PartState[] = ["ISSUED", "INSTALLED", "WRITTEN_OFF"];

export const PART_SOURCES = [
  "STOCK", // an item of the existing inventory — the only source that moves stock
  "SUPPLIER", // the external repair supplier's own part — never moves stock
  "NON_STOCK", // not managed in the inventory (free description) — never moves stock
] as const;
export type PartSource = (typeof PART_SOURCES)[number];

export const WRITE_OFF_REASONS = ["DAMAGED", "LOST", "KEPT_BY_SUPPLIER"] as const;
export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number];

/** Where the captured cost came from. NONE = no cost was known; it is never invented. */
export const PART_COST_SOURCES = ["LAST_PURCHASE", "ITEM_COST", "MANUAL", "NONE"] as const;
export type PartCostSource = (typeof PART_COST_SOURCES)[number];

/** The inventory's unit types (InventoryUnitType) — copied, not imported, so the core stays independent of Prisma. */
export const PART_UNIT_TYPES = ["UNIT", "ML", "GRAM", "KG", "LITER", "BOX"] as const;
export type PartUnitType = (typeof PART_UNIT_TYPES)[number];
/** Counted, not measured: a quantity of these must be a whole number. */
export const COUNTED_UNIT_TYPES: readonly PartUnitType[] = ["UNIT", "BOX"];

/** What an external supplier did with a part that left with the device — recorded only on the owner's word. */
export const EXTERNAL_PART_RESOLUTIONS = ["RETURNED_INTACT", "INSTALLED", "DAMAGED", "KEPT_BY_SUPPLIER"] as const;
export type ExternalPartResolution = (typeof EXTERNAL_PART_RESOLUTIONS)[number];

export const PART_EVENT_KINDS = [
  "ADDED",
  "SPLIT",
  "RESERVED",
  "RELEASED",
  "ORDER_LINKED",
  "ORDER_UPDATED",
  "ISSUED",
  "INSTALLED",
  "RETURNED",
  "WRITTEN_OFF",
  "CANCELLED",
  "PRICE_SET",
  "QUOTED",
  "COST_CORRECTED",
  "SENT_WITH_EXTERNAL",
  "BACK_FROM_EXTERNAL",
  "SUPPLIER_PART_RECORDED",
] as const;
export type PartEventKind = (typeof PART_EVENT_KINDS)[number];

export const PART_TEXT_MAX_LENGTH = 200; // name / sku snapshot
export const PART_REASON_MAX_LENGTH = 1000;
/** Quantities are DOUBLE PRECISION in the inventory; two quantities closer than this are equal. */
export const QUANTITY_EPSILON = 1e-9;

/** A part line as the service layer loads it (under the case lock). Amounts are integer agorot. */
export interface ServicePartSnapshot {
  state: PartState;
  source: PartSource;
  /** STOCK only (the inventory item); null for SUPPLIER / NON_STOCK. */
  inventoryItemId: number | null;
  quantity: number;
  unitType: PartUnitType | null;
  version: number;
  /** The OUT movement of the issue — set exactly when a STOCK part left the stock. */
  issueMovementLinked: boolean;
  /** The IN movement of the return — set exactly when a STOCK part went back. */
  returnMovementLinked: boolean;
  unitCostAgorot: number | null;
  costSource: PartCostSource | null;
  customerUnitPriceAgorot: number | null;
  /** The ServiceQuote version this part was offered in (null = never quoted). */
  quotedInVersion: number | null;
  /** A supplier's part whose cost is inside the supplier's work cost — never counted twice. */
  costIncludedInExternal: boolean;
  externalWorkId: number | null;
  purchaseOrderId: number | null;
  purchaseOrderLineId: number | null;
  expectedOn: string | null;
  writeOffReason: WriteOffReason | null;
  /**
   * A child line made by a partial return (ק‑4): it left the stock through its PARENT's issue movement (so its own
   * issueMovementLinked is false) and the service stores the parent's id as splitFromPartId.
   */
  splitFromParent: boolean;
}

/** The case as far as parts care. */
export interface PartCaseFacts {
  status: ServiceCaseStatus;
  outcome: ServiceOutcome | null;
  cancellationRequested: boolean;
  /** An approved quote version exists, or the repair is covered (no quote needed). */
  quoteApprovedOrCovered: boolean;
}

/**
 * Stock facts read by the service UNDER the InventoryItem row lock, in the transaction of the decision:
 * `onHandQuantity` = InventoryItem.currentQuantity; `reservedByOtherParts` = the sum of RESERVED part lines of the
 * same item in OTHER parts (other cases, or other lines of this case).
 */
export interface StockFacts {
  itemActive: boolean;
  itemUnitType: PartUnitType;
  onHandQuantity: number;
  reservedByOtherParts: number;
}

/** The inventory item's cost fields, in shekels as the inventory stores them (Float). */
export interface ItemCostFacts {
  lastPurchaseCost: number | null;
  costPerUnit: number | null;
}

/** The external work a part goes out with or comes back from (1.2b; read under lock). */
export interface ExternalWorkFacts {
  externalWorkId: number;
  sameCase: boolean;
  atSupplier: boolean;
}

export interface AddPartInput {
  source: "STOCK" | "NON_STOCK";
  inventoryItemId?: number | null;
  /** The name as shown (a snapshot of the item's name, or the free description of a NON_STOCK part). */
  name: string;
  sku?: string | null;
  quantity: number;
  unitType?: PartUnitType | null;
  customerUnitPriceAgorot?: number | null;
}

export interface SupplierPartInput {
  name: string;
  quantity: number;
  unitType?: PartUnitType | null;
  externalWorkId: number;
  /** true (default) = paid inside the supplier's work cost; false = the supplier billed it separately. */
  costIncludedInExternal: boolean;
  /** Only when billed separately. */
  unitCostAgorot?: number | null;
  /** A warranty replacement: no cost to anyone. */
  underWarranty: boolean;
  customerUnitPriceAgorot?: number | null;
}

/**
 * The cost at ISSUE (ק‑9). AUTO (or no choice) = the approved order: last purchase cost if reliable, else the item's
 * cost if reliable, else unknown; refused when both are reliable and disagree. An explicit choice is the owner's.
 */
export type IssueCostChoice =
  | { source: "AUTO" }
  | { source: "LAST_PURCHASE" }
  | { source: "ITEM_COST" }
  | { source: "MANUAL"; unitCostAgorot: number }
  | { source: "NONE" };

export type PartAction =
  | { type: "RESERVE" }
  | { type: "RELEASE" }
  | { type: "MARK_ON_ORDER"; purchaseOrderId?: number | null; purchaseOrderLineId?: number | null; expectedOn?: string | null }
  | { type: "UPDATE_ORDER"; purchaseOrderId?: number | null; purchaseOrderLineId?: number | null; expectedOn?: string | null }
  | { type: "ISSUE"; cost?: IssueCostChoice; confirmBeforeQuote?: boolean }
  | { type: "INSTALL" }
  | { type: "RETURN"; quantity: number }
  | { type: "WRITE_OFF"; reason: WriteOffReason; note?: string | null }
  | { type: "CANCEL"; reason?: string | null }
  | { type: "SET_PRICE"; customerUnitPriceAgorot: number | null }
  | { type: "RECORD_QUOTED"; quoteVersion: number }
  | { type: "CORRECT_COST"; unitCostAgorot: number; reason: string }
  | { type: "SEND_WITH_EXTERNAL"; cost?: IssueCostChoice; confirmBeforeQuote?: boolean }
  | { type: "RESOLVE_FROM_EXTERNAL"; resolution: ExternalPartResolution; note?: string | null };

export type PartActionType = PartAction["type"];

/** Everything an action may need; only what that action names is required. */
export interface PartActionFacts {
  case: PartCaseFacts;
  stock?: StockFacts;
  cost?: ItemCostFacts;
  external?: ExternalWorkFacts;
}

/**
 * The FUTURE stock change (M3) — a contract, not an operation: the service hands it to the inventory module's
 * writer in the SAME transaction as the part update and the part event, and links the resulting movement id.
 * `requires` lists what must already be true for it to be safe; the first two are M0 (inventory session).
 */
export interface InventoryMovementIntent {
  movementType: "OUT" | "IN";
  reason: "SERVICE_PART" | "RETURN";
  inventoryItemId: number;
  /** Signed as InventoryMovement.quantityDelta: negative for OUT, positive for IN. */
  quantityDelta: number;
  /** The part column that receives the movement id (UNIQUE — one movement per part per direction). */
  linkAs: "issueMovementId" | "returnMovementId";
  /** true = link on the child line of a split (ק‑4), not on the line the action was on. */
  onSplitChild: boolean;
  requires: readonly InventoryRequirement[];
}

export type InventoryRequirement =
  | "M0_ATOMIC_STOCK_UPDATE" // createMovement cannot lose an update under concurrency
  | "M0_NON_NEGATIVE_GUARD" // the database refuses a negative currentQuantity
  | "M0_SERVICE_PART_REASON" // InventoryMovementReason has SERVICE_PART
  | "SAME_TRANSACTION_AS_PART_EVENT"; // the movement, the part row and its event commit or roll back together

export type PartServerCheck =
  | "ITEM_BELONGS_TO_BUSINESS"
  | "ITEM_ACTIVE"
  | "STOCK_READ_UNDER_ITEM_LOCK" // currentQuantity read after SELECT … FOR UPDATE on the item
  | "RESERVATIONS_SUMMED_UNDER_ITEM_LOCK" // the other RESERVED lines summed after the same lock
  | "STOCK_GUARDED_BY_MOVEMENT" // the authoritative stock check is the inventory writer's (M0), not this decision
  | "MOVEMENT_LINK_UNIQUE" // the movement id is not linked to any other part (UNIQUE)
  | "MOVEMENT_MATCHES_PART" // the linked movement is of this item, this reason, this signed quantity
  | "PURCHASE_ORDER_BELONGS_TO_BUSINESS"
  | "PURCHASE_ORDER_LINE_OF_ORDER"
  | "EXTERNAL_WORK_OF_SAME_CASE"
  | "EXTERNAL_WORK_AT_SUPPLIER"
  | "QUOTE_VERSION_OF_CASE"
  | "QUOTE_STATE_READ_UNDER_CASE_LOCK" // the approval fact behind a before-approval confirmation is current
  | "SPLIT_QUANTITIES_RECONCILE"; // the issue movement's quantity = the parent's remaining + all its children

export type PartWarning =
  | "QUOTE_NOT_APPROVED" // ק‑6: shown, and the owner confirmed — the part leaves the stock before approval
  | "PRICE_DIFFERS_FROM_QUOTE" // the price changed after the part was quoted: a new quote version is needed
  | "COST_UNKNOWN" // issued with cost source NONE
  | "COST_SOURCES_DISAGREE" // last purchase cost and item cost differ — the owner chose one explicitly
  | "RESERVATION_IS_SOFT"; // a reservation never guarantees the units against the till or other inventory flows

/** Free text — business columns only, never in an event payload (ט‑1 A). */
export interface PartTexts {
  name: string | null;
  sku: string | null;
  reason: string | null;
  note: string | null;
}

/** The journal row to append: seq = the part's version after the change. Payload: tokens, numbers, booleans, nulls. */
export interface PartEventDraft {
  kind: PartEventKind;
  seq: number;
  stateBefore: PartState | null;
  stateAfter: PartState;
  quantity: number;
  amountAgorot: number | null;
  previousAmountAgorot: number | null;
  actor: ServiceCaseActor;
  payload: Readonly<Record<string, ServiceEventPayloadValue>>;
}

export type PartDecision =
  | {
      ok: true;
      part: ServicePartSnapshot;
      texts: PartTexts;
      /** The one stock change this decision needs, or null — never more than one. */
      inventory: InventoryMovementIntent | null;
      serverChecks: readonly PartServerCheck[];
      warnings: readonly PartWarning[];
      event: PartEventDraft;
      /** A partial return (ק‑4): the new child line and its own first event; null otherwise. */
      split: { child: ServicePartSnapshot; childEvent: PartEventDraft } | null;
    }
  | { ok: false; violations: readonly PartViolation[] };

export type PartViolationCode =
  | "INVALID_INPUT"
  | "ACTOR_NOT_ALLOWED"
  | "VERSION_CONFLICT"
  | "CASE_NOT_ACTIVE"
  | "CASE_CANCELLED"
  | "TRANSITION_NOT_ALLOWED"
  | "NOT_A_STOCK_PART"
  | "ITEM_INACTIVE"
  | "UNIT_MISMATCH"
  | "QUANTITY_INVALID"
  | "PART_NOT_AVAILABLE"
  | "ALREADY_ISSUED"
  | "ALREADY_RETURNED"
  | "QUOTE_CONFIRMATION_REQUIRED"
  | "COST_SOURCE_MISSING"
  | "COST_SOURCES_CONFLICT"
  | "COST_NOT_CAPTURED"
  | "CORRECTION_UNCHANGED"
  | "REASON_REQUIRED"
  | "TEXT_TOO_LONG"
  | "PRICE_UNCHANGED"
  | "ORDER_UNCHANGED"
  | "EXTERNAL_WORK_INVALID"
  | "PART_AT_SUPPLIER"
  | "PART_NOT_AT_SUPPLIER";

export interface PartViolation {
  code: PartViolationCode;
  detail: string;
}

/** Cancel of a case, as far as its parts go — what the service does with each, and whether the cancel may complete. */
export interface CaseCancelPartsPlan {
  /** NEEDED / ON_ORDER / RESERVED: cancelled with the case (no stock change) — the RELEASE_PART_RESERVATIONS effect. */
  cancelWithCase: readonly number[];
  /** ISSUED: left the stock and not resolved — each needs RETURN, INSTALL or WRITE_OFF before the cancel completes. */
  needsResolution: readonly number[];
  /** True while any part needs resolution. The cancel REQUEST is never refused because of parts. */
  completionBlocked: boolean;
}

/** Logical totals of a case's parts, for display and the CLOSE guard. Amounts in agorot. */
export interface CasePartsSummary {
  byState: Readonly<Record<PartState, number>>;
  /** Parts in an open state — the value the service feeds the case core as `openPartReservations`. */
  openCount: number;
  /** ISSUED parts not yet installed, returned or written off. */
  unresolvedIssuedCount: number;
  /** Cost to the repair: INSTALLED + WRITTEN_OFF stock / non-stock parts, plus supplier parts billed separately. */
  partsCostAgorot: number;
  /** ISSUED parts' captured cost — expected, not final. */
  expectedCostAgorot: number;
  /** Lines whose cost is unknown (source NONE or not captured) and would otherwise count. */
  unknownCostLines: number;
  /** The external supplier's final cost, counted once. */
  externalCostAgorot: number;
  totalCostAgorot: number;
  /** Sum of price × quantity for parts with a price that are not cancelled / returned. */
  customerPriceAgorot: number;
}
