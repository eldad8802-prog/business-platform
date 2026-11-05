/**
 * Service Desk 1.2c / M1 — spare parts in a service case. Pure: no database, no clock, no network, no input mutation.
 *
 * A part line moves through eight states (parts.contracts.ts). Only two decisions ever ask for a stock change, and
 * each asks for exactly ONE InventoryMovement, returned as an `InventoryMovementIntent` for the future service (M3):
 *   ISSUE (or SEND_WITH_EXTERNAL of a part not yet issued) → OUT, reason SERVICE_PART, linked as issueMovementId;
 *   RETURN (or RESOLVE_FROM_EXTERNAL RETURNED_INTACT) of a STOCK part → IN, reason RETURN, linked as returnMovementId.
 * Reserve, release, install, write-off, cancel, price and cost decisions never ask for one.
 *
 * What this file decides and what it cannot:
 *   - it decides from the facts it is given — the soft-reservation arithmetic, allowed transitions, quantities, the
 *     captured cost, the double-action guards that the part's own state can show;
 *   - it does NOT prove anything about concurrency: two transactions deciding on stale facts can both be "ok" here.
 *     Every fact that must be read under a lock, every uniqueness and every stock guard is listed in `serverChecks`
 *     and in the intent's `requires`, for M3 to establish in the database (and for M0 to make the inventory writer
 *     atomic). A green test of this core is never evidence that inventory concurrency is solved.
 *
 * The case status machine (service-case.core.ts) is not changed: its `openPartReservations` input is fed with
 * `summarizeCaseParts(...).openCount`, so CLOSE stays refused while any part is open, and its CANCEL effect
 * RELEASE_PART_RESERVATIONS is planned per part by `planPartsForCaseCancel`.
 */
import type { ServiceCaseActor, ServiceCaseStatus, ServiceEventPayloadValue } from "./contracts";
import {
  COUNTED_UNIT_TYPES,
  EXTERNAL_PART_RESOLUTIONS,
  OPEN_PART_STATES,
  PART_COST_SOURCES,
  PART_REASON_MAX_LENGTH,
  PART_SOURCES,
  PART_STATES,
  PART_TEXT_MAX_LENGTH,
  PART_UNIT_TYPES,
  QUANTITY_EPSILON,
  WRITE_OFF_REASONS,
  type AddPartInput,
  type CaseCancelPartsPlan,
  type CasePartsSummary,
  type ItemCostFacts,
  type InventoryMovementIntent,
  type IssueCostChoice,
  type PartAction,
  type PartActionFacts,
  type PartCaseFacts,
  type PartCostSource,
  type PartDecision,
  type PartEventKind,
  type PartServerCheck,
  type PartState,
  type PartTexts,
  type PartUnitType,
  type PartViolation,
  type PartViolationCode,
  type PartWarning,
  type ServicePartSnapshot,
  type StockFacts,
  type SupplierPartInput,
} from "./parts.contracts";

const v = (code: PartViolationCode, detail: string): PartViolation => ({ code, detail });
const isPositiveInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;
const isNonNegativeInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
const isFiniteNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const codePoints = (s: string) => Array.from(s).length;
const emptyTexts = (): PartTexts => ({ name: null, sku: null, reason: null, note: null });

/** Statuses after which nothing new happens to the case's parts (only resolutions and cost corrections). */
const CASE_FINISHED: readonly ServiceCaseStatus[] = ["DELIVERED", "CLOSED", "CANCELLED", "ABANDONED"];

/** A calendar date YYYY-MM-DD (no time, no zone). */
function isCalendarDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

export function quantitiesEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= QUANTITY_EPSILON;
}

/** A quantity a part line may hold: finite, > 0, and whole for counted units (UNIT, BOX). */
export function isValidPartQuantity(quantity: unknown, unitType: PartUnitType | null): quantity is number {
  if (!isFiniteNumber(quantity) || quantity <= QUANTITY_EPSILON) return false;
  if (unitType !== null && COUNTED_UNIT_TYPES.includes(unitType) && !Number.isInteger(quantity)) return false;
  return true;
}

/** On hand minus what OTHER part lines reserved. Soft: the till and other inventory flows do not see it. */
export function netAvailable(stock: StockFacts): number {
  return stock.onHandQuantity - stock.reservedByOtherParts;
}

/** Shekels (the inventory's Float) → integer agorot, half up; null for a missing or invalid value. */
export function shekelsToAgorot(shekels: unknown): number | null {
  if (!isFiniteNumber(shekels) || shekels < 0) return null;
  return Math.round(Number((shekels * 100).toFixed(4)));
}

/** The cost candidates the inventory offers, so the caller can choose (ק‑9) — the core never chooses. */
export function costCandidates(cost: ItemCostFacts | undefined): { lastPurchaseAgorot: number | null; itemCostAgorot: number | null; disagree: boolean } {
  const lastPurchaseAgorot = shekelsToAgorot(cost?.lastPurchaseCost);
  const itemCostAgorot = shekelsToAgorot(cost?.costPerUnit);
  return { lastPurchaseAgorot, itemCostAgorot, disagree: lastPurchaseAgorot !== null && itemCostAgorot !== null && lastPurchaseAgorot !== itemCostAgorot };
}

/** Sum of RESERVED quantity of one item across part lines (the service sums in SQL under the item lock). */
export function reservedQuantityByItem(parts: readonly ServicePartSnapshot[], inventoryItemId: number): number {
  return parts.filter((p) => p.state === "RESERVED" && p.inventoryItemId === inventoryItemId).reduce((s, p) => s + p.quantity, 0);
}

function takeText(raw: unknown, field: string, max: number, out: PartViolation[]): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") { out.push(v("INVALID_INPUT", field)); return null; }
  const t = raw.trim();
  if (!t) return null;
  if (codePoints(t) > max) out.push(v("TEXT_TOO_LONG", `${field} exceeds ${max} characters`));
  return t;
}

function ownerOnly(actor: ServiceCaseActor, out: PartViolation[]) {
  if (actor?.kind !== "OWNER" || !isPositiveInt(actor.userId)) out.push(v("ACTOR_NOT_ALLOWED", `${String(actor?.kind)} may not act on parts`));
}

function validCaseFacts(c: PartCaseFacts | undefined): c is PartCaseFacts {
  return !!c && typeof c.status === "string" && typeof c.cancellationRequested === "boolean" && typeof c.quoteApprovedOrCovered === "boolean";
}

const caseCancelled = (c: PartCaseFacts) => c.outcome === "CANCELLED" || c.cancellationRequested;

/** New work on parts (add, reserve, order, issue, send, price, quote) needs a live, not-cancelled case. */
function requireLiveCase(c: PartCaseFacts, out: PartViolation[]) {
  if (CASE_FINISHED.includes(c.status)) out.push(v("CASE_NOT_ACTIVE", `the case is ${c.status}`));
  else if (caseCancelled(c)) out.push(v("CASE_CANCELLED", "the case is cancelled: only resolving its parts is allowed"));
}

function validSnapshot(p: ServicePartSnapshot | undefined): p is ServicePartSnapshot {
  return !!p && PART_STATES.includes(p.state) && PART_SOURCES.includes(p.source) && isPositiveInt(p.version)
    && isValidPartQuantity(p.quantity, p.unitType) && (p.source === "STOCK" ? isPositiveInt(p.inventoryItemId) : p.inventoryItemId === null);
}

function validStock(s: StockFacts | undefined): s is StockFacts {
  return !!s && typeof s.itemActive === "boolean" && PART_UNIT_TYPES.includes(s.itemUnitType)
    && isFiniteNumber(s.onHandQuantity) && isFiniteNumber(s.reservedByOtherParts) && s.reservedByOtherParts >= 0;
}

const atSupplier = (p: ServicePartSnapshot) => p.state === "ISSUED" && p.externalWorkId !== null;

function ok(
  before: PartState | null,
  part: ServicePartSnapshot,
  kind: PartEventKind,
  actor: ServiceCaseActor,
  payload: Record<string, ServiceEventPayloadValue>,
  extra: { texts?: PartTexts; inventory?: InventoryMovementIntent | null; serverChecks?: PartServerCheck[]; warnings?: PartWarning[]; amountAgorot?: number | null; previousAmountAgorot?: number | null } = {},
): PartDecision {
  return {
    ok: true,
    part: { ...part },
    texts: { ...(extra.texts ?? emptyTexts()) },
    inventory: extra.inventory ? { ...extra.inventory, requires: [...extra.inventory.requires] } : null,
    serverChecks: [...new Set(extra.serverChecks ?? [])],
    warnings: [...new Set(extra.warnings ?? [])],
    event: {
      kind,
      seq: part.version,
      stateBefore: before,
      stateAfter: part.state,
      quantity: part.quantity,
      amountAgorot: extra.amountAgorot ?? null,
      previousAmountAgorot: extra.previousAmountAgorot ?? null,
      actor: { ...actor },
      payload: { ...payload },
    },
  };
}

const refuse = (out: PartViolation[]): PartDecision => ({ ok: false, violations: out });

const OUT_REQUIRES = ["M0_ATOMIC_STOCK_UPDATE", "M0_NON_NEGATIVE_GUARD", "M0_SERVICE_PART_REASON", "SAME_TRANSACTION_AS_PART_EVENT"] as const;
const IN_REQUIRES = ["M0_ATOMIC_STOCK_UPDATE", "SAME_TRANSACTION_AS_PART_EVENT"] as const;

function outIntent(p: ServicePartSnapshot): InventoryMovementIntent {
  return { movementType: "OUT", reason: "SERVICE_PART", inventoryItemId: p.inventoryItemId as number, quantityDelta: -p.quantity, linkAs: "issueMovementId", requires: [...OUT_REQUIRES] };
}
function inIntent(p: ServicePartSnapshot): InventoryMovementIntent {
  return { movementType: "IN", reason: "RETURN", inventoryItemId: p.inventoryItemId as number, quantityDelta: p.quantity, linkAs: "returnMovementId", requires: [...IN_REQUIRES] };
}

/** The stock facts of a STOCK part, checked for the decision (soft: other lines' reservations are respected). */
function checkStock(p: ServicePartSnapshot, stock: StockFacts | undefined, out: PartViolation[]): void {
  if (!validStock(stock)) { out.push(v("INVALID_INPUT", "stock facts")); return; }
  if (!stock.itemActive) out.push(v("ITEM_INACTIVE", "the inventory item is not active"));
  if (p.unitType !== null && stock.itemUnitType !== p.unitType) out.push(v("UNIT_MISMATCH", `the item is counted in ${stock.itemUnitType}, the part in ${p.unitType}`));
  const available = netAvailable(stock);
  if (p.quantity > available + QUANTITY_EPSILON) {
    out.push(v("PART_NOT_AVAILABLE", `needs ${p.quantity}, available ${Math.max(0, available)} (on hand ${stock.onHandQuantity}, reserved elsewhere ${stock.reservedByOtherParts})`));
  }
}

const STOCK_CHECKS: PartServerCheck[] = ["ITEM_BELONGS_TO_BUSINESS", "ITEM_ACTIVE", "STOCK_READ_UNDER_ITEM_LOCK", "RESERVATIONS_SUMMED_UNDER_ITEM_LOCK"];

/** The cost captured at issue, from the caller's explicit choice. */
function captureCost(p: ServicePartSnapshot, choice: IssueCostChoice | undefined, cost: ItemCostFacts | undefined, out: PartViolation[], warnings: PartWarning[]): { unitCostAgorot: number | null; costSource: PartCostSource } | null {
  if (!choice || !PART_COST_SOURCES.includes(choice.source)) { out.push(v("INVALID_INPUT", "cost: choose LAST_PURCHASE, ITEM_COST, MANUAL or NONE (ק‑9: no default)")); return null; }
  const c = costCandidates(cost);
  if (p.source === "STOCK" && c.disagree && (choice.source === "LAST_PURCHASE" || choice.source === "ITEM_COST")) warnings.push("COST_SOURCES_DISAGREE");
  switch (choice.source) {
    case "LAST_PURCHASE":
    case "ITEM_COST": {
      if (p.source !== "STOCK") { out.push(v("COST_SOURCE_MISSING", "only a stock part has inventory costs")); return null; }
      const value = choice.source === "LAST_PURCHASE" ? c.lastPurchaseAgorot : c.itemCostAgorot;
      if (value === null) { out.push(v("COST_SOURCE_MISSING", `the item has no ${choice.source === "LAST_PURCHASE" ? "last purchase cost" : "cost per unit"}`)); return null; }
      return { unitCostAgorot: value, costSource: choice.source };
    }
    case "MANUAL":
      if (!isNonNegativeInt(choice.unitCostAgorot)) { out.push(v("INVALID_INPUT", "unitCostAgorot is an integer ≥ 0")); return null; }
      return { unitCostAgorot: choice.unitCostAgorot, costSource: "MANUAL" };
    case "NONE":
      warnings.push("COST_UNKNOWN");
      return { unitCostAgorot: null, costSource: "NONE" };
  }
}

/** ISSUE rules shared by ISSUE and SEND_WITH_EXTERNAL: returns the issued part, or null with violations. */
function issue(part: ServicePartSnapshot, choice: IssueCostChoice | undefined, facts: PartActionFacts, out: PartViolation[], warnings: PartWarning[], checks: PartServerCheck[]): { next: ServicePartSnapshot; inventory: InventoryMovementIntent | null } | null {
  if (part.source === "SUPPLIER") { out.push(v("TRANSITION_NOT_ALLOWED", "a supplier's part never comes from the stock")); return null; }
  if (part.issueMovementLinked) { out.push(v("ALREADY_ISSUED", "this part already left the stock")); return null; }
  if (!["NEEDED", "ON_ORDER", "RESERVED"].includes(part.state)) { out.push(v("TRANSITION_NOT_ALLOWED", `${part.state} cannot be issued`)); return null; }
  const policy = facts.policy?.issueBeforeQuoteApproval;
  if (policy !== "WARN" && policy !== "BLOCK") out.push(v("POLICY_REQUIRED", "issueBeforeQuoteApproval (ק‑6) must be passed: WARN or BLOCK"));
  else if (!facts.case.quoteApprovedOrCovered) {
    if (policy === "BLOCK") out.push(v("QUOTE_NOT_APPROVED", "the customer has not approved a quote and the repair is not covered"));
    else warnings.push("QUOTE_NOT_APPROVED");
  }
  if (part.source === "STOCK") {
    checkStock(part, facts.stock, out);
    checks.push(...STOCK_CHECKS, "STOCK_GUARDED_BY_MOVEMENT", "MOVEMENT_LINK_UNIQUE", "MOVEMENT_MATCHES_PART");
  }
  const captured = captureCost(part, choice, facts.cost, out, warnings);
  if (out.length > 0 || !captured) return null;
  const next: ServicePartSnapshot = {
    ...part,
    state: "ISSUED",
    version: part.version + 1,
    issueMovementLinked: part.source === "STOCK",
    unitCostAgorot: captured.unitCostAgorot,
    costSource: captured.costSource,
  };
  return { next, inventory: part.source === "STOCK" ? outIntent(part) : null };
}

// ── add ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A new part line on a case: NEEDED, version 1. No stock is touched; reserving is a separate decision. */
export function addPart(input: AddPartInput, facts: { case: PartCaseFacts; stock?: StockFacts }, actor: ServiceCaseActor): PartDecision {
  const out: PartViolation[] = [];
  ownerOnly(actor, out);
  if (!validCaseFacts(facts?.case)) return refuse([...out, v("INVALID_INPUT", "case facts")]);
  requireLiveCase(facts.case, out);
  if (!input || (input.source !== "STOCK" && input.source !== "NON_STOCK")) return refuse([...out, v("INVALID_INPUT", "source: STOCK or NON_STOCK (a supplier's part is recordSupplierPart)")]);
  const texts = emptyTexts();
  texts.name = takeText(input.name, "name", PART_TEXT_MAX_LENGTH, out);
  if (texts.name === null && !out.some((x) => x.code === "TEXT_TOO_LONG")) out.push(v("INVALID_INPUT", "name is required"));
  texts.sku = takeText(input.sku, "sku", PART_TEXT_MAX_LENGTH, out);
  const unitType = input.unitType ?? null;
  if (unitType !== null && !PART_UNIT_TYPES.includes(unitType)) out.push(v("INVALID_INPUT", "unitType"));
  const price = input.customerUnitPriceAgorot ?? null;
  if (price !== null && !isNonNegativeInt(price)) out.push(v("INVALID_INPUT", "customerUnitPriceAgorot is an integer ≥ 0"));
  const checks: PartServerCheck[] = [];
  let itemId: number | null = null;
  if (input.source === "STOCK") {
    if (!isPositiveInt(input.inventoryItemId)) out.push(v("INVALID_INPUT", "inventoryItemId"));
    else itemId = input.inventoryItemId;
    if (!validStock(facts.stock)) out.push(v("INVALID_INPUT", "stock facts"));
    else {
      if (!facts.stock.itemActive) out.push(v("ITEM_INACTIVE", "the inventory item is not active"));
      if (unitType !== null && unitType !== facts.stock.itemUnitType) out.push(v("UNIT_MISMATCH", `the item is counted in ${facts.stock.itemUnitType}`));
    }
    checks.push("ITEM_BELONGS_TO_BUSINESS", "ITEM_ACTIVE");
  } else if (input.inventoryItemId !== null && input.inventoryItemId !== undefined) {
    out.push(v("INVALID_INPUT", "a NON_STOCK part has no inventory item"));
  }
  const effectiveUnit: PartUnitType | null = input.source === "STOCK" && validStock(facts.stock) ? (unitType ?? facts.stock.itemUnitType) : unitType;
  if (!isValidPartQuantity(input.quantity, effectiveUnit)) out.push(v("QUANTITY_INVALID", "a quantity > 0, whole for UNIT / BOX"));
  if (out.length > 0) return refuse(out);

  const part: ServicePartSnapshot = {
    state: "NEEDED", source: input.source, inventoryItemId: itemId, quantity: input.quantity, unitType: effectiveUnit, version: 1,
    issueMovementLinked: false, returnMovementLinked: false, unitCostAgorot: null, costSource: null, customerUnitPriceAgorot: price,
    quotedInVersion: null, costIncludedInExternal: false, externalWorkId: null, purchaseOrderId: null, purchaseOrderLineId: null,
    expectedOn: null, writeOffReason: null,
  };
  const net = input.source === "STOCK" && validStock(facts.stock) ? netAvailable(facts.stock) : null;
  return ok(null, part, "ADDED", actor,
    { source: part.source, inventoryItemId: itemId, quantity: part.quantity, unitType: effectiveUnit, hasPrice: price !== null, availableAtAdd: net === null ? null : net >= part.quantity - QUANTITY_EPSILON },
    { texts, serverChecks: checks });
}

/**
 * A part the external supplier used (its own, a warranty replacement, a part it installed): recorded only on the
 * owner's word, straight as INSTALLED, never a stock movement. Its cost is inside the supplier's work cost unless the
 * supplier billed it separately; a warranty part costs nothing.
 */
export function recordSupplierPart(input: SupplierPartInput, facts: { case: PartCaseFacts; external?: PartActionFacts["external"] }, actor: ServiceCaseActor): PartDecision {
  const out: PartViolation[] = [];
  ownerOnly(actor, out);
  if (!validCaseFacts(facts?.case)) return refuse([...out, v("INVALID_INPUT", "case facts")]);
  if (CASE_FINISHED.includes(facts.case.status)) out.push(v("CASE_NOT_ACTIVE", `the case is ${facts.case.status}`));
  const ext = facts.external;
  if (!ext || !isPositiveInt(ext.externalWorkId) || !ext.sameCase || ext.externalWorkId !== input?.externalWorkId) out.push(v("EXTERNAL_WORK_INVALID", "the supplier's work of this case is required"));
  const texts = emptyTexts();
  texts.name = takeText(input?.name, "name", PART_TEXT_MAX_LENGTH, out);
  if (texts.name === null && !out.some((x) => x.code === "TEXT_TOO_LONG")) out.push(v("INVALID_INPUT", "name is required"));
  const unitType = input?.unitType ?? null;
  if (unitType !== null && !PART_UNIT_TYPES.includes(unitType)) out.push(v("INVALID_INPUT", "unitType"));
  if (!isValidPartQuantity(input?.quantity, unitType)) out.push(v("QUANTITY_INVALID", "a quantity > 0, whole for UNIT / BOX"));
  if (typeof input?.costIncludedInExternal !== "boolean" || typeof input?.underWarranty !== "boolean") out.push(v("INVALID_INPUT", "costIncludedInExternal / underWarranty"));
  const cost = input?.unitCostAgorot ?? null;
  const price = input?.customerUnitPriceAgorot ?? null;
  if (price !== null && !isNonNegativeInt(price)) out.push(v("INVALID_INPUT", "customerUnitPriceAgorot"));
  let unitCostAgorot: number | null = null;
  let costSource: PartCostSource | null = null;
  let included = false;
  if (input?.underWarranty === true) {
    if (cost !== null && cost !== 0) out.push(v("INVALID_INPUT", "a warranty part has no cost"));
    unitCostAgorot = 0; costSource = "MANUAL";
  } else if (input?.costIncludedInExternal === true) {
    if (cost !== null) out.push(v("INVALID_INPUT", "a part inside the supplier's cost has no cost of its own (no double count)"));
    included = true;
  } else if (input?.costIncludedInExternal === false) {
    if (!isNonNegativeInt(cost)) out.push(v("INVALID_INPUT", "a part billed separately needs unitCostAgorot (integer ≥ 0)"));
    unitCostAgorot = cost; costSource = "MANUAL";
  }
  if (out.length > 0) return refuse(out);

  const part: ServicePartSnapshot = {
    state: "INSTALLED", source: "SUPPLIER", inventoryItemId: null, quantity: input.quantity, unitType, version: 1,
    issueMovementLinked: false, returnMovementLinked: false, unitCostAgorot, costSource, customerUnitPriceAgorot: price,
    quotedInVersion: null, costIncludedInExternal: included, externalWorkId: input.externalWorkId, purchaseOrderId: null,
    purchaseOrderLineId: null, expectedOn: null, writeOffReason: null,
  };
  return ok(null, part, "SUPPLIER_PART_RECORDED", actor,
    { externalWorkId: input.externalWorkId, quantity: part.quantity, underWarranty: input.underWarranty, costIncludedInExternal: included, unitCostAgorot },
    { texts, serverChecks: ["EXTERNAL_WORK_OF_SAME_CASE"], amountAgorot: unitCostAgorot });
}

// ── actions on a part line ───────────────────────────────────────────────────────────────────────────────────

/** Every change of a part line. Every ok decision bumps the version by one and asks for at most one movement. */
export function evaluatePartAction(part: ServicePartSnapshot, action: PartAction, facts: PartActionFacts, actor: ServiceCaseActor): PartDecision {
  const out: PartViolation[] = [];
  ownerOnly(actor, out);
  if (!validSnapshot(part)) return refuse([...out, v("INVALID_INPUT", "part")]);
  if (!validCaseFacts(facts?.case)) return refuse([...out, v("INVALID_INPUT", "case facts")]);
  const before = part.state;
  const next: ServicePartSnapshot = { ...part, version: part.version + 1 };
  const warnings: PartWarning[] = [];
  const checks: PartServerCheck[] = [];

  switch (action?.type) {
    case "RESERVE": {
      requireLiveCase(facts.case, out);
      if (part.source !== "STOCK") out.push(v("NOT_A_STOCK_PART", "only an inventory item can be reserved"));
      else if (part.state !== "NEEDED" && part.state !== "ON_ORDER") out.push(v("TRANSITION_NOT_ALLOWED", `${part.state} cannot be reserved`));
      else checkStock(part, facts.stock, out);
      if (out.length > 0) return refuse(out);
      next.state = "RESERVED";
      return ok(before, next, "RESERVED", actor,
        { inventoryItemId: part.inventoryItemId, quantity: part.quantity, fromOrder: before === "ON_ORDER", onHand: facts.stock!.onHandQuantity, reservedElsewhere: facts.stock!.reservedByOtherParts },
        { serverChecks: STOCK_CHECKS, warnings: ["RESERVATION_IS_SOFT"] });
    }
    case "RELEASE": {
      requireLiveCase(facts.case, out);
      if (part.state !== "RESERVED") out.push(v("TRANSITION_NOT_ALLOWED", `${part.state} holds no reservation`));
      if (out.length > 0) return refuse(out);
      next.state = "NEEDED";
      return ok(before, next, "RELEASED", actor, { inventoryItemId: part.inventoryItemId, quantity: part.quantity });
    }
    case "MARK_ON_ORDER":
    case "UPDATE_ORDER": {
      requireLiveCase(facts.case, out);
      const marking = action.type === "MARK_ON_ORDER";
      if (part.source === "SUPPLIER") out.push(v("TRANSITION_NOT_ALLOWED", "a supplier's part is not ordered by the business"));
      else if (marking && part.state !== "NEEDED") out.push(v("TRANSITION_NOT_ALLOWED", `${part.state} cannot be marked as ordered`));
      else if (!marking && part.state !== "ON_ORDER") out.push(v("TRANSITION_NOT_ALLOWED", "only an ordered part's order can be updated"));
      const orderId = action.purchaseOrderId ?? null;
      const lineId = action.purchaseOrderLineId ?? null;
      const expectedOn = action.expectedOn ?? null;
      if (orderId !== null && !isPositiveInt(orderId)) out.push(v("INVALID_INPUT", "purchaseOrderId"));
      if (lineId !== null && (!isPositiveInt(lineId) || orderId === null)) out.push(v("INVALID_INPUT", "purchaseOrderLineId needs its purchaseOrderId"));
      if (expectedOn !== null && !isCalendarDate(expectedOn)) out.push(v("INVALID_INPUT", "expectedOn"));
      if (!marking && out.length === 0 && orderId === part.purchaseOrderId && lineId === part.purchaseOrderLineId && expectedOn === part.expectedOn) {
        out.push(v("ORDER_UNCHANGED", "nothing changed"));
      }
      if (out.length > 0) return refuse(out);
      next.state = "ON_ORDER";
      next.purchaseOrderId = orderId;
      next.purchaseOrderLineId = lineId;
      next.expectedOn = expectedOn;
      if (orderId !== null) checks.push("PURCHASE_ORDER_BELONGS_TO_BUSINESS");
      if (lineId !== null) checks.push("PURCHASE_ORDER_LINE_OF_ORDER");
      return ok(before, next, marking ? "ORDER_LINKED" : "ORDER_UPDATED", actor,
        { purchaseOrderId: orderId, purchaseOrderLineId: lineId, expectedOn, automaticOrder: false }, { serverChecks: checks });
    }
    case "ISSUE": {
      requireLiveCase(facts.case, out);
      if (out.length > 0) return refuse(out);
      const r = issue(part, action.cost, facts, out, warnings, checks);
      if (!r) return refuse(out);
      return ok(before, r.next, "ISSUED", actor,
        { source: part.source, inventoryItemId: part.inventoryItemId, quantity: part.quantity, costSource: r.next.costSource, unitCostAgorot: r.next.unitCostAgorot, quoteApprovedOrCovered: facts.case.quoteApprovedOrCovered },
        { inventory: r.inventory, serverChecks: checks, warnings, amountAgorot: r.next.unitCostAgorot });
    }
    case "INSTALL": {
      // A resolution: allowed after a cancel too ("documented as used").
      if (part.state !== "ISSUED") out.push(v("TRANSITION_NOT_ALLOWED", `${part.state} cannot be installed (issue it first)`));
      else if (atSupplier(part)) out.push(v("PART_AT_SUPPLIER", "the part is with the supplier: record what the supplier did (RESOLVE_FROM_EXTERNAL)"));
      if (out.length > 0) return refuse(out);
      next.state = "INSTALLED";
      return ok(before, next, "INSTALLED", actor, { quantity: part.quantity, afterCancel: caseCancelled(facts.case) });
    }
    case "RETURN": {
      if (part.state === "RETURNED" || part.returnMovementLinked) out.push(v("ALREADY_RETURNED", "this part already went back"));
      else if (part.state !== "ISSUED") out.push(v("TRANSITION_NOT_ALLOWED", `${part.state} has nothing to return (cancel or release it instead)`));
      else if (atSupplier(part)) out.push(v("PART_AT_SUPPLIER", "the part is with the supplier: record its return (RESOLVE_FROM_EXTERNAL)"));
      if (!isFiniteNumber(action.quantity) || action.quantity <= QUANTITY_EPSILON || action.quantity > part.quantity + QUANTITY_EPSILON) {
        out.push(v("QUANTITY_INVALID", `return quantity must be > 0 and at most ${part.quantity}`));
      } else if (!quantitiesEqual(action.quantity, part.quantity)) {
        out.push(v("PARTIAL_RETURN_NOT_DECIDED", "a partial return is not decided (ק‑4): return the whole line, or cancel and re-add"));
      }
      if (out.length > 0) return refuse(out);
      return returned(part, next, actor, "RETURNED", { afterCancel: caseCancelled(facts.case) });
    }
    case "WRITE_OFF": {
      if (!WRITE_OFF_REASONS.includes(action.reason)) out.push(v("INVALID_INPUT", "reason: DAMAGED, LOST or KEPT_BY_SUPPLIER"));
      if (part.state !== "ISSUED") {
        out.push(v("TRANSITION_NOT_ALLOWED", part.state === "RESERVED" || part.state === "NEEDED"
          ? "a damaged part still on the shelf is the inventory's DAMAGE adjustment: cancel this line"
          : `${part.state} cannot be written off`));
      } else if (atSupplier(part)) out.push(v("PART_AT_SUPPLIER", "the part is with the supplier: record what happened (RESOLVE_FROM_EXTERNAL)"));
      else if (action.reason === "KEPT_BY_SUPPLIER" && part.externalWorkId === null) out.push(v("INVALID_INPUT", "KEPT_BY_SUPPLIER needs a part that went to a supplier"));
      const texts = emptyTexts();
      texts.note = takeText(action.note, "note", PART_REASON_MAX_LENGTH, out);
      if (out.length > 0) return refuse(out);
      next.state = "WRITTEN_OFF";
      next.writeOffReason = action.reason;
      // No movement: the stock already went down at ISSUE. The captured cost stays on the case as a loss.
      return ok(before, next, "WRITTEN_OFF", actor, { reason: action.reason, quantity: part.quantity, noteRecorded: texts.note !== null, afterCancel: caseCancelled(facts.case) },
        { texts, amountAgorot: part.unitCostAgorot });
    }
    case "CANCEL": {
      if (!["NEEDED", "ON_ORDER", "RESERVED"].includes(part.state)) {
        out.push(v("TRANSITION_NOT_ALLOWED", part.state === "ISSUED" ? "the part left the stock: return it, record it installed or write it off" : `${part.state} is final`));
      }
      const texts = emptyTexts();
      texts.reason = takeText(action.reason, "reason", PART_REASON_MAX_LENGTH, out);
      if (out.length > 0) return refuse(out);
      next.state = "CANCELLED";
      return ok(before, next, "CANCELLED", actor, { wasReserved: before === "RESERVED", wasOrdered: before === "ON_ORDER", withCase: caseCancelled(facts.case), reasonRecorded: texts.reason !== null }, { texts });
    }
    case "SET_PRICE": {
      requireLiveCase(facts.case, out);
      if (["CANCELLED", "RETURNED", "WRITTEN_OFF"].includes(part.state)) out.push(v("TRANSITION_NOT_ALLOWED", `${part.state} is not charged`));
      const price = action.customerUnitPriceAgorot;
      if (price !== null && !isNonNegativeInt(price)) out.push(v("INVALID_INPUT", "customerUnitPriceAgorot is an integer ≥ 0 or null"));
      else if (price === part.customerUnitPriceAgorot) out.push(v("PRICE_UNCHANGED", "same price"));
      if (out.length > 0) return refuse(out);
      next.customerUnitPriceAgorot = price;
      if (part.quotedInVersion !== null) warnings.push("PRICE_DIFFERS_FROM_QUOTE");
      return ok(before, next, "PRICE_SET", actor, { customerUnitPriceAgorot: price, previousAgorot: part.customerUnitPriceAgorot, quotedInVersion: part.quotedInVersion },
        { warnings, amountAgorot: price, previousAmountAgorot: part.customerUnitPriceAgorot });
    }
    case "RECORD_QUOTED": {
      requireLiveCase(facts.case, out);
      if (!isPositiveInt(action.quoteVersion)) out.push(v("INVALID_INPUT", "quoteVersion"));
      if (["CANCELLED", "RETURNED", "WRITTEN_OFF"].includes(part.state)) out.push(v("TRANSITION_NOT_ALLOWED", `${part.state} is not quoted`));
      if (part.customerUnitPriceAgorot === null) out.push(v("INVALID_INPUT", "a part is quoted at its price: set the price first"));
      if (out.length > 0) return refuse(out);
      next.quotedInVersion = action.quoteVersion;
      return ok(before, next, "QUOTED", actor, { quoteVersion: action.quoteVersion, customerUnitPriceAgorot: part.customerUnitPriceAgorot },
        { serverChecks: ["QUOTE_VERSION_OF_CASE"], amountAgorot: part.customerUnitPriceAgorot });
    }
    case "CORRECT_COST": {
      // History is kept: a NEW event with the previous value and the reason; the issue event stays as it was.
      if (part.costSource === null || part.costIncludedInExternal) out.push(v("COST_NOT_CAPTURED", "no cost was captured for this part"));
      if (!isNonNegativeInt(action.unitCostAgorot)) out.push(v("INVALID_INPUT", "unitCostAgorot is an integer ≥ 0"));
      else if (action.unitCostAgorot === part.unitCostAgorot) out.push(v("CORRECTION_UNCHANGED", "the corrected value equals the current one"));
      const texts = emptyTexts();
      texts.reason = takeText(action.reason, "reason", PART_REASON_MAX_LENGTH, out);
      if (texts.reason === null && !out.some((x) => x.code === "TEXT_TOO_LONG")) out.push(v("REASON_REQUIRED", "a cost correction needs its reason"));
      if (out.length > 0) return refuse(out);
      next.unitCostAgorot = action.unitCostAgorot;
      next.costSource = "MANUAL";
      return ok(before, next, "COST_CORRECTED", actor, { unitCostAgorot: action.unitCostAgorot, previousAgorot: part.unitCostAgorot, previousSource: part.costSource, reasonRecorded: true },
        { texts, amountAgorot: action.unitCostAgorot, previousAmountAgorot: part.unitCostAgorot });
    }
    case "SEND_WITH_EXTERNAL": {
      requireLiveCase(facts.case, out);
      const ext = facts.external;
      if (!ext || !isPositiveInt(ext.externalWorkId) || !ext.sameCase || !ext.atSupplier) out.push(v("EXTERNAL_WORK_INVALID", "an open supplier work of this case is required"));
      if (part.source === "SUPPLIER") out.push(v("TRANSITION_NOT_ALLOWED", "a supplier's part does not go to the supplier"));
      if (part.externalWorkId !== null && part.state === "ISSUED") out.push(v("PART_AT_SUPPLIER", "the part is already with a supplier"));
      if (out.length > 0) return refuse(out);
      checks.push("EXTERNAL_WORK_OF_SAME_CASE", "EXTERNAL_WORK_AT_SUPPLIER");
      if (part.state === "ISSUED") {
        next.externalWorkId = ext!.externalWorkId;
        return ok(before, next, "SENT_WITH_EXTERNAL", actor, { externalWorkId: ext!.externalWorkId, issuedNow: false, quantity: part.quantity }, { serverChecks: checks });
      }
      const r = issue(part, action.cost, facts, out, warnings, checks);
      if (!r) return refuse(out);
      r.next.externalWorkId = ext!.externalWorkId;
      return ok(before, r.next, "SENT_WITH_EXTERNAL", actor,
        { externalWorkId: ext!.externalWorkId, issuedNow: true, quantity: part.quantity, costSource: r.next.costSource, unitCostAgorot: r.next.unitCostAgorot },
        { inventory: r.inventory, serverChecks: checks, warnings, amountAgorot: r.next.unitCostAgorot });
    }
    case "RESOLVE_FROM_EXTERNAL": {
      // Only the owner's word moves anything: a supplier's report alone is a progress note on the work (1.2b).
      if (!atSupplier(part)) out.push(v("PART_NOT_AT_SUPPLIER", "the part is not with a supplier"));
      const ext = facts.external;
      if (!ext || ext.externalWorkId !== part.externalWorkId || !ext.sameCase) out.push(v("EXTERNAL_WORK_INVALID", "the supplier work this part went with is required"));
      if (!EXTERNAL_PART_RESOLUTIONS.includes(action.resolution)) out.push(v("INVALID_INPUT", "resolution"));
      const texts = emptyTexts();
      texts.note = takeText(action.note, "note", PART_REASON_MAX_LENGTH, out);
      if (out.length > 0) return refuse(out);
      checks.push("EXTERNAL_WORK_OF_SAME_CASE");
      const payload = { externalWorkId: part.externalWorkId, resolution: action.resolution, quantity: part.quantity };
      switch (action.resolution) {
        case "RETURNED_INTACT":
          return returned(part, next, actor, "BACK_FROM_EXTERNAL", payload, checks, texts);
        case "INSTALLED":
          next.state = "INSTALLED";
          return ok(before, next, "BACK_FROM_EXTERNAL", actor, payload, { texts, serverChecks: checks });
        default:
          next.state = "WRITTEN_OFF";
          next.writeOffReason = action.resolution === "DAMAGED" ? "DAMAGED" : "KEPT_BY_SUPPLIER";
          return ok(before, next, "BACK_FROM_EXTERNAL", actor, payload, { texts, serverChecks: checks, amountAgorot: part.unitCostAgorot });
      }
    }
    default:
      return refuse([...out, v("INVALID_INPUT", `unknown action ${String((action as { type?: unknown })?.type)}`)]);
  }
}

/** ISSUED → RETURNED: one IN movement for a STOCK part (fit to go back), none otherwise. */
function returned(
  part: ServicePartSnapshot,
  next: ServicePartSnapshot,
  actor: ServiceCaseActor,
  kind: PartEventKind,
  payload: Record<string, ServiceEventPayloadValue>,
  checks: PartServerCheck[] = [],
  texts?: PartTexts,
): PartDecision {
  next.state = "RETURNED";
  const stock = part.source === "STOCK";
  next.returnMovementLinked = stock;
  return ok(part.state, next, kind, actor, { ...payload, movesStock: stock },
    { texts, inventory: stock ? inIntent(part) : null, serverChecks: stock ? [...checks, "ITEM_BELONGS_TO_BUSINESS", "MOVEMENT_LINK_UNIQUE", "MOVEMENT_MATCHES_PART"] : checks });
}

// ── the case's view of its parts ─────────────────────────────────────────────────────────────────────────────

/**
 * A case cancel, as far as parts go. The cancel request is never refused because of parts (the case machine's
 * CANCEL is unchanged); what is still on the shelf or on order is cancelled with the case; what left the stock must
 * be resolved — returned, recorded as installed, or written off — before the cancel counts as complete.
 */
export function planPartsForCaseCancel(parts: readonly { id: number; part: ServicePartSnapshot }[]): CaseCancelPartsPlan {
  const cancelWithCase: number[] = [];
  const needsResolution: number[] = [];
  for (const { id, part } of parts ?? []) {
    if (part.state === "NEEDED" || part.state === "ON_ORDER" || part.state === "RESERVED") cancelWithCase.push(id);
    else if (part.state === "ISSUED") needsResolution.push(id);
  }
  return { cancelWithCase, needsResolution, completionBlocked: needsResolution.length > 0 };
}

/** Part lines that went with a supplier work and are still out — the service keeps that work's return open on them. */
export function partsBlockingExternalReturn(parts: readonly { id: number; part: ServicePartSnapshot }[], externalWorkId: number): number[] {
  return (parts ?? []).filter(({ part }) => atSupplier(part) && part.externalWorkId === externalWorkId).map(({ id }) => id);
}

/** Logical totals (never a charge): counts per state, open parts, costs counted once, the customer price. */
export function summarizeCaseParts(parts: readonly ServicePartSnapshot[], externalFinalCostAgorot: number | null): CasePartsSummary {
  const byState = Object.fromEntries(PART_STATES.map((s) => [s, 0])) as Record<PartState, number>;
  let partsCostAgorot = 0, expectedCostAgorot = 0, unknownCostLines = 0, customerPriceAgorot = 0;
  for (const p of parts ?? []) {
    byState[p.state] += 1;
    const lineCost = p.unitCostAgorot === null ? null : Math.round(p.unitCostAgorot * p.quantity);
    if (p.state === "INSTALLED" || p.state === "WRITTEN_OFF") {
      if (p.costIncludedInExternal) { /* inside the supplier's cost — counted there, once */ }
      else if (lineCost === null) unknownCostLines += 1;
      else partsCostAgorot += lineCost;
    } else if (p.state === "ISSUED") {
      if (lineCost === null) unknownCostLines += 1;
      else expectedCostAgorot += lineCost;
    }
    if (p.customerUnitPriceAgorot !== null && !["CANCELLED", "RETURNED", "WRITTEN_OFF"].includes(p.state)) {
      customerPriceAgorot += Math.round(p.customerUnitPriceAgorot * p.quantity);
    }
  }
  const externalCostAgorot = isNonNegativeInt(externalFinalCostAgorot) ? externalFinalCostAgorot : 0;
  const openCount = (parts ?? []).filter((p) => OPEN_PART_STATES.includes(p.state)).length;
  return {
    byState,
    openCount,
    unresolvedIssuedCount: byState.ISSUED,
    partsCostAgorot,
    expectedCostAgorot,
    unknownCostLines,
    externalCostAgorot,
    totalCostAgorot: partsCostAgorot + externalCostAgorot,
    customerPriceAgorot,
  };
}

// ── command envelope ─────────────────────────────────────────────────────────────────────────────────────────

/** Shape and version of a command on a part line. The binding compare runs again under the row lock (M3). */
export function checkPartEnvelope(
  part: ServicePartSnapshot,
  command: { partId: number; expectedVersion: number; idempotencyKey: string },
): { ok: true } | { ok: false; violations: readonly PartViolation[] } {
  const out: PartViolation[] = [];
  if (!isPositiveInt(command?.partId)) out.push(v("INVALID_INPUT", "partId"));
  if (typeof command?.idempotencyKey !== "string" || !/^[A-Za-z0-9:_#-]{8,200}$/.test(command.idempotencyKey)) out.push(v("INVALID_INPUT", "idempotencyKey"));
  if (!isPositiveInt(command?.expectedVersion)) out.push(v("INVALID_INPUT", "expectedVersion"));
  else if (command.expectedVersion !== part?.version) out.push(v("VERSION_CONFLICT", `expected ${command.expectedVersion}, part is at ${part?.version}`));
  return out.length > 0 ? { ok: false, violations: out } : { ok: true };
}
