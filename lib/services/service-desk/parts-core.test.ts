/**
 * Service Desk 1.2c / M1 — spare parts in a service case, pure proofs (no database, no network, no clock). Run:
 *   npx tsx lib/services/service-desk/parts-core.test.ts
 *
 * What these prove: the decisions of the core from the facts they are given — states, transitions, the soft
 * reservation arithmetic, one movement intent at most per decision, the cost captured at issue, the cancel plan,
 * the summary, and the fit with the unchanged 1.1 case machine and 1.1d external work.
 * What they do NOT prove: anything about concurrency in the inventory or the database. Locks, uniqueness and the
 * stock guard are listed as serverChecks / intent.requires and belong to M0 (inventory session) and M3.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ServiceCaseActor, ServiceCaseContext, ServiceEventPayloadValue } from "./contracts";
import {
  OPEN_PART_STATES,
  PART_EVENT_KINDS,
  PART_STATES,
  TERMINAL_PART_STATES,
  type AddPartInput,
  type PartAction,
  type PartActionFacts,
  type PartCaseFacts,
  type PartDecision,
  type PartViolationCode,
  type ServicePartSnapshot,
  type StockFacts,
  type SupplierPartInput,
} from "./parts.contracts";
import {
  addPart,
  checkPartEnvelope,
  costCandidates,
  evaluatePartAction,
  isValidPartQuantity,
  netAvailable,
  partsBlockingExternalReturn,
  planPartsForCaseCancel,
  recordSupplierPart,
  reservedQuantityByItem,
  shekelsToAgorot,
  summarizeCaseParts,
} from "./parts.core";
import { evaluateTransition } from "./service-case.core";
import { closeExternalWork } from "./external-work.core";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = ""): void {
  if (cond) pass++; else fail++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}
const OK: Extract<PartDecision, { ok: true }>[] = [];
const keep = (d: PartDecision) => { if (d.ok) OK.push(d); return d; };
const codes = (d: PartDecision) => (d.ok ? [] : d.violations.map((x) => x.code));
const refused = (name: string, d: PartDecision, code: PartViolationCode) =>
  check(name, !d.ok && codes(d).includes(code), d.ok ? "allowed" : codes(d).join(","));
const allowed = (name: string, d: PartDecision, extra?: (x: Extract<PartDecision, { ok: true }>) => boolean) =>
  check(name, d.ok && (extra ? extra(d) : true), d.ok ? "" : codes(d).join(","));
function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") { Object.freeze(o); for (const x of Object.values(o as object)) deepFreeze(x); }
  return o;
}

const OWNER: ServiceCaseActor = { kind: "OWNER", userId: 70 };
const CUSTOMER: ServiceCaseActor = { kind: "CUSTOMER_LINK" };
const SYSTEM: ServiceCaseActor = { kind: "SYSTEM" };

const LIVE: PartCaseFacts = { status: "IN_REPAIR", outcome: null, cancellationRequested: false, quoteApprovedOrCovered: true };
const caseF = (o: Partial<PartCaseFacts> = {}): PartCaseFacts => ({ ...LIVE, ...o });
const stock = (o: Partial<StockFacts> = {}): StockFacts => ({ itemActive: true, itemUnitType: "UNIT", onHandQuantity: 4, reservedByOtherParts: 0, ...o });
const WARN = { issueBeforeQuoteApproval: "WARN" as const };
const BLOCK = { issueBeforeQuoteApproval: "BLOCK" as const };
const COST = { lastPurchaseCost: 120.5, costPerUnit: 120.5 };
const facts = (o: Partial<PartActionFacts> = {}): PartActionFacts => ({ case: LIVE, stock: stock(), cost: COST, policy: WARN, ...o });

function part(o: Partial<ServicePartSnapshot> = {}): ServicePartSnapshot {
  return {
    state: "NEEDED", source: "STOCK", inventoryItemId: 31, quantity: 1, unitType: "UNIT", version: 1,
    issueMovementLinked: false, returnMovementLinked: false, unitCostAgorot: null, costSource: null,
    customerUnitPriceAgorot: 45_000, quotedInVersion: null, costIncludedInExternal: false, externalWorkId: null,
    purchaseOrderId: null, purchaseOrderLineId: null, expectedOn: null, writeOffReason: null, ...o,
  };
}
const issued = (o: Partial<ServicePartSnapshot> = {}) => part({ state: "ISSUED", version: 3, issueMovementLinked: true, unitCostAgorot: 12_050, costSource: "LAST_PURCHASE", ...o });
const act = (p: ServicePartSnapshot, a: PartAction, f: PartActionFacts = facts(), who: ServiceCaseActor = OWNER) => keep(evaluatePartAction(p, a, f, who));
const SCREEN: AddPartInput = { source: "STOCK", inventoryItemId: 31, name: "מסך iPhone 14", sku: "SCR-IP14", quantity: 1, customerUnitPriceAgorot: 45_000 };

console.log("\n== 1. adding a part ==");
{
  const d = keep(addPart(SCREEN, { case: LIVE, stock: stock() }, OWNER));
  allowed("stock part added as NEEDED v1, no movement", d, (x) => x.part.state === "NEEDED" && x.part.version === 1 && x.inventory === null && x.event.kind === "ADDED" && x.event.seq === 1);
  check("name and sku are texts, never payload", d.ok && d.texts.name === "מסך iPhone 14" && d.texts.sku === "SCR-IP14" && !JSON.stringify(d.event.payload).includes("iPhone"));
  check("unit type taken from the item when not given", d.ok && d.part.unitType === "UNIT");
  check("availability at add is reported, nothing reserved", d.ok && d.event.payload.availableAtAdd === true && d.part.state === "NEEDED");
  check("add asks the server for item ownership + active", d.ok && d.serverChecks.includes("ITEM_BELONGS_TO_BUSINESS") && d.serverChecks.includes("ITEM_ACTIVE"));
  const none = keep(addPart(SCREEN, { case: LIVE, stock: stock({ onHandQuantity: 0 }) }, OWNER));
  allowed("a missing part can still be added (to be ordered)", none, (x) => x.event.payload.availableAtAdd === false);
  allowed("non-stock part added without an item", addPart({ source: "NON_STOCK", name: "בורג מיוחד", quantity: 2 }, { case: LIVE }, OWNER), (x) => x.part.inventoryItemId === null && x.part.source === "NON_STOCK");
  refused("non-stock with an item id", addPart({ source: "NON_STOCK", name: "x", quantity: 1, inventoryItemId: 3 }, { case: LIVE }, OWNER), "INVALID_INPUT");
  refused("stock part without item id", addPart({ ...SCREEN, inventoryItemId: null }, { case: LIVE, stock: stock() }, OWNER), "INVALID_INPUT");
  refused("stock part without stock facts", addPart(SCREEN, { case: LIVE }, OWNER), "INVALID_INPUT");
  refused("inactive item", addPart(SCREEN, { case: LIVE, stock: stock({ itemActive: false }) }, OWNER), "ITEM_INACTIVE");
  refused("unit mismatch with the item", addPart({ ...SCREEN, unitType: "ML" }, { case: LIVE, stock: stock() }, OWNER), "UNIT_MISMATCH");
  refused("zero quantity", addPart({ ...SCREEN, quantity: 0 }, { case: LIVE, stock: stock() }, OWNER), "QUANTITY_INVALID");
  refused("negative quantity", addPart({ ...SCREEN, quantity: -1 }, { case: LIVE, stock: stock() }, OWNER), "QUANTITY_INVALID");
  refused("fractional UNIT quantity", addPart({ ...SCREEN, quantity: 1.5 }, { case: LIVE, stock: stock() }, OWNER), "QUANTITY_INVALID");
  refused("NaN quantity", addPart({ ...SCREEN, quantity: Number.NaN }, { case: LIVE, stock: stock() }, OWNER), "QUANTITY_INVALID");
  allowed("fractional ML quantity is fine", addPart({ ...SCREEN, quantity: 2.5 }, { case: LIVE, stock: stock({ itemUnitType: "ML" }) }, OWNER), (x) => x.part.unitType === "ML");
  refused("missing name", addPart({ ...SCREEN, name: "  " }, { case: LIVE, stock: stock() }, OWNER), "INVALID_INPUT");
  refused("name over 200", addPart({ ...SCREEN, name: "א".repeat(201) }, { case: LIVE, stock: stock() }, OWNER), "TEXT_TOO_LONG");
  refused("negative price", addPart({ ...SCREEN, customerUnitPriceAgorot: -5 }, { case: LIVE, stock: stock() }, OWNER), "INVALID_INPUT");
  refused("fractional agorot price", addPart({ ...SCREEN, customerUnitPriceAgorot: 10.5 }, { case: LIVE, stock: stock() }, OWNER), "INVALID_INPUT");
  refused("a supplier part is not addPart", addPart({ ...SCREEN, source: "SUPPLIER" as unknown as "STOCK" }, { case: LIVE, stock: stock() }, OWNER), "INVALID_INPUT");
  refused("customer link cannot add", addPart(SCREEN, { case: LIVE, stock: stock() }, CUSTOMER), "ACTOR_NOT_ALLOWED");
  refused("system cannot add", addPart(SCREEN, { case: LIVE, stock: stock() }, SYSTEM), "ACTOR_NOT_ALLOWED");
  refused("closed case", addPart(SCREEN, { case: caseF({ status: "CLOSED" }), stock: stock() }, OWNER), "CASE_NOT_ACTIVE");
  refused("delivered case", addPart(SCREEN, { case: caseF({ status: "DELIVERED" }), stock: stock() }, OWNER), "CASE_NOT_ACTIVE");
  refused("cancelled (held, READY) case", addPart(SCREEN, { case: caseF({ status: "READY", outcome: "CANCELLED" }), stock: stock() }, OWNER), "CASE_CANCELLED");
  refused("cancel requested at supplier", addPart(SCREEN, { case: caseF({ status: "EXTERNAL", cancellationRequested: true }), stock: stock() }, OWNER), "CASE_CANCELLED");
  refused("missing case facts", addPart(SCREEN, { case: undefined as unknown as PartCaseFacts, stock: stock() }, OWNER), "INVALID_INPUT");
}

console.log("\n== 2. soft reservation ==");
{
  const r = act(part(), { type: "RESERVE" });
  allowed("reserve NEEDED → RESERVED, no movement", r, (x) => x.part.state === "RESERVED" && x.inventory === null && x.part.version === 2 && x.event.seq === 2);
  check("reservation is flagged soft", r.ok && r.warnings.includes("RESERVATION_IS_SOFT"));
  check("reservation asks for the item lock + the sum under it", r.ok && r.serverChecks.includes("STOCK_READ_UNDER_ITEM_LOCK") && r.serverChecks.includes("RESERVATIONS_SUMMED_UNDER_ITEM_LOCK"));
  allowed("reserve exactly the last unit", act(part(), { type: "RESERVE" }, facts({ stock: stock({ onHandQuantity: 1 }) })));
  refused("reserve beyond the known quantity", act(part({ quantity: 5 }), { type: "RESERVE" }), "PART_NOT_AVAILABLE");
  refused("double reservation between cases: the last unit is already reserved elsewhere", act(part(), { type: "RESERVE" }, facts({ stock: stock({ onHandQuantity: 1, reservedByOtherParts: 1 }) })), "PART_NOT_AVAILABLE");
  allowed("other reservations leave enough", act(part({ quantity: 2 }), { type: "RESERVE" }, facts({ stock: stock({ onHandQuantity: 4, reservedByOtherParts: 2 }) })));
  refused("on hand already negative (bad data): nothing to reserve", act(part(), { type: "RESERVE" }, facts({ stock: stock({ onHandQuantity: -2 }) })), "PART_NOT_AVAILABLE");
  refused("reserve again (already RESERVED)", act(part({ state: "RESERVED" }), { type: "RESERVE" }), "TRANSITION_NOT_ALLOWED");
  refused("reserve an issued part", act(issued(), { type: "RESERVE" }), "TRANSITION_NOT_ALLOWED");
  refused("reserve a non-stock part", act(part({ source: "NON_STOCK", inventoryItemId: null }), { type: "RESERVE" }), "NOT_A_STOCK_PART");
  refused("reserve without stock facts", act(part(), { type: "RESERVE" }, facts({ stock: undefined })), "INVALID_INPUT");
  refused("reserve an inactive item", act(part(), { type: "RESERVE" }, facts({ stock: stock({ itemActive: false }) })), "ITEM_INACTIVE");
  refused("reserve on a cancelled case", act(part(), { type: "RESERVE" }, facts({ case: caseF({ outcome: "CANCELLED", status: "READY" }) })), "CASE_CANCELLED");
  refused("negative reservedByOtherParts is invalid facts", act(part(), { type: "RESERVE" }, facts({ stock: stock({ reservedByOtherParts: -1 }) })), "INVALID_INPUT");
  check("netAvailable = on hand − reserved elsewhere", netAvailable(stock({ onHandQuantity: 5, reservedByOtherParts: 2 })) === 3);
  check("reservedQuantityByItem sums RESERVED of that item only",
    reservedQuantityByItem([part({ state: "RESERVED", quantity: 2 }), part({ state: "RESERVED", quantity: 1, inventoryItemId: 9 }), part({ state: "NEEDED", quantity: 7 }), issued({ quantity: 4 })], 31) === 2);
  const rel = act(part({ state: "RESERVED", version: 2 }), { type: "RELEASE" });
  allowed("release RESERVED → NEEDED, no movement", rel, (x) => x.part.state === "NEEDED" && x.inventory === null && x.event.kind === "RELEASED");
  refused("release a NEEDED part", act(part(), { type: "RELEASE" }), "TRANSITION_NOT_ALLOWED");
  refused("release an issued part", act(issued(), { type: "RELEASE" }), "TRANSITION_NOT_ALLOWED");
}

console.log("\n== 3. issue: the one OUT movement ==");
{
  const d = act(part({ state: "RESERVED", version: 2 }), { type: "ISSUE", cost: { source: "LAST_PURCHASE" } });
  allowed("issue RESERVED → ISSUED", d, (x) => x.part.state === "ISSUED" && x.part.issueMovementLinked && x.part.version === 3);
  check("exactly one OUT intent, SERVICE_PART, delta −quantity, linked as issueMovementId", d.ok && d.inventory?.movementType === "OUT" && d.inventory.reason === "SERVICE_PART" && d.inventory.quantityDelta === -1 && d.inventory.linkAs === "issueMovementId" && d.inventory.inventoryItemId === 31);
  check("the intent requires M0 (atomic + non-negative + reason) and one transaction", d.ok && ["M0_ATOMIC_STOCK_UPDATE", "M0_NON_NEGATIVE_GUARD", "M0_SERVICE_PART_REASON", "SAME_TRANSACTION_AS_PART_EVENT"].every((r) => d.inventory!.requires.includes(r as never)));
  check("the authoritative stock guard is named as the movement's, not this decision's", d.ok && d.serverChecks.includes("STOCK_GUARDED_BY_MOVEMENT") && d.serverChecks.includes("MOVEMENT_LINK_UNIQUE") && d.serverChecks.includes("MOVEMENT_MATCHES_PART"));
  check("cost captured at issue: 120.50 ₪ → 12050 agorot, source LAST_PURCHASE", d.ok && d.part.unitCostAgorot === 12_050 && d.part.costSource === "LAST_PURCHASE" && d.event.amountAgorot === 12_050);
  allowed("direct issue from NEEDED (stock available)", act(part(), { type: "ISSUE", cost: { source: "ITEM_COST" } }), (x) => x.part.state === "ISSUED" && x.part.costSource === "ITEM_COST");
  allowed("issue from ON_ORDER once it arrived", act(part({ state: "ON_ORDER", purchaseOrderId: 8 }), { type: "ISSUE", cost: { source: "NONE" } }), (x) => x.part.state === "ISSUED" && x.part.purchaseOrderId === 8);
  refused("issue when the stock was sold at the till meanwhile (soft reservation)", act(part({ state: "RESERVED" }), { type: "ISSUE", cost: { source: "NONE" } }, facts({ stock: stock({ onHandQuantity: 0 }) })), "PART_NOT_AVAILABLE");
  refused("issue a NEEDED part whose units are reserved by another case", act(part(), { type: "ISSUE", cost: { source: "NONE" } }, facts({ stock: stock({ onHandQuantity: 1, reservedByOtherParts: 1 }) })), "PART_NOT_AVAILABLE");
  const failed = act(part({ state: "RESERVED", version: 2 }), { type: "ISSUE", cost: { source: "NONE" } }, facts({ stock: stock({ onHandQuantity: 0 }) }));
  check("a failed issue changes nothing and asks for no movement (fails safely)", !failed.ok);
  refused("double issue: already ISSUED", act(issued(), { type: "ISSUE", cost: { source: "NONE" } }), "ALREADY_ISSUED");
  refused("double issue: movement already linked even if state looks RESERVED", act(part({ state: "RESERVED", issueMovementLinked: true }), { type: "ISSUE", cost: { source: "NONE" } }), "ALREADY_ISSUED");
  refused("issue an installed part", act(part({ state: "INSTALLED", issueMovementLinked: false }), { type: "ISSUE", cost: { source: "NONE" } }), "TRANSITION_NOT_ALLOWED");
  refused("issue a cancelled part", act(part({ state: "CANCELLED" }), { type: "ISSUE", cost: { source: "NONE" } }), "TRANSITION_NOT_ALLOWED");
  refused("issue a supplier part", act(part({ source: "SUPPLIER", inventoryItemId: null, state: "INSTALLED" }), { type: "ISSUE", cost: { source: "NONE" } }), "TRANSITION_NOT_ALLOWED");
  refused("issue on a cancelled case", act(part({ state: "RESERVED" }), { type: "ISSUE", cost: { source: "NONE" } }, facts({ case: caseF({ status: "READY", outcome: "CANCELLED" }) })), "CASE_CANCELLED");
  refused("issue on a closed case", act(part({ state: "RESERVED" }), { type: "ISSUE", cost: { source: "NONE" } }, facts({ case: caseF({ status: "CLOSED" }) })), "CASE_NOT_ACTIVE");
  refused("issue by the customer link", act(part({ state: "RESERVED" }), { type: "ISSUE", cost: { source: "NONE" } }, facts(), CUSTOMER), "ACTOR_NOT_ALLOWED");
  const ns = act(part({ source: "NON_STOCK", inventoryItemId: null }), { type: "ISSUE", cost: { source: "MANUAL", unitCostAgorot: 900 } }, facts({ stock: undefined }));
  allowed("non-stock issue: no movement, manual cost", ns, (x) => x.inventory === null && !x.part.issueMovementLinked && x.part.unitCostAgorot === 900);
  refused("non-stock issue cannot take an inventory cost", act(part({ source: "NON_STOCK", inventoryItemId: null }), { type: "ISSUE", cost: { source: "LAST_PURCHASE" } }), "COST_SOURCE_MISSING");
}

console.log("\n== 4. quote gate (ק‑6 open: the caller passes WARN or BLOCK) ==");
{
  const noQuote = caseF({ quoteApprovedOrCovered: false });
  const w = act(part({ state: "RESERVED" }), { type: "ISSUE", cost: { source: "NONE" } }, facts({ case: noQuote, policy: WARN }));
  allowed("WARN: issue allowed with a QUOTE_NOT_APPROVED warning", w, (x) => x.warnings.includes("QUOTE_NOT_APPROVED"));
  refused("BLOCK: issue refused before approval", act(part({ state: "RESERVED" }), { type: "ISSUE", cost: { source: "NONE" } }, facts({ case: noQuote, policy: BLOCK })), "QUOTE_NOT_APPROVED");
  allowed("BLOCK with an approved quote / coverage: allowed", act(part({ state: "RESERVED" }), { type: "ISSUE", cost: { source: "NONE" } }, facts({ policy: BLOCK })), (x) => !x.warnings.includes("QUOTE_NOT_APPROVED"));
  refused("no policy passed: refused, never defaulted", act(part({ state: "RESERVED" }), { type: "ISSUE", cost: { source: "NONE" } }, facts({ policy: undefined })), "POLICY_REQUIRED");
  refused("unknown policy value", act(part({ state: "RESERVED" }), { type: "ISSUE", cost: { source: "NONE" } }, facts({ policy: { issueBeforeQuoteApproval: "ALLOW" as "WARN" } })), "POLICY_REQUIRED");
}

console.log("\n== 5. cost (captured at issue; ק‑9 open: the caller chooses the source) ==");
{
  check("shekelsToAgorot 120.5 → 12050", shekelsToAgorot(120.5) === 12_050);
  check("shekelsToAgorot 12.345 → 1235 (half up, no float drift)", shekelsToAgorot(12.345) === 1235);
  check("shekelsToAgorot 0.1+0.2 → 30", shekelsToAgorot(0.1 + 0.2) === 30);
  check("shekelsToAgorot rejects negative / NaN / null", shekelsToAgorot(-1) === null && shekelsToAgorot(Number.NaN) === null && shekelsToAgorot(null) === null);
  const disagree = { lastPurchaseCost: 130, costPerUnit: 100 };
  check("costCandidates reports both and that they disagree", costCandidates(disagree).lastPurchaseAgorot === 13_000 && costCandidates(disagree).itemCostAgorot === 10_000 && costCandidates(disagree).disagree);
  const d = act(part({ state: "RESERVED" }), { type: "ISSUE", cost: { source: "ITEM_COST" } }, facts({ cost: disagree }));
  allowed("explicit ITEM_COST taken when sources disagree, with a warning", d, (x) => x.part.unitCostAgorot === 10_000 && x.warnings.includes("COST_SOURCES_DISAGREE"));
  refused("no cost choice: refused (no default)", act(part({ state: "RESERVED" }), { type: "ISSUE" } as PartAction), "INVALID_INPUT");
  refused("LAST_PURCHASE when the item has none", act(part({ state: "RESERVED" }), { type: "ISSUE", cost: { source: "LAST_PURCHASE" } }, facts({ cost: { lastPurchaseCost: null, costPerUnit: 50 } })), "COST_SOURCE_MISSING");
  refused("ITEM_COST when the item has none", act(part({ state: "RESERVED" }), { type: "ISSUE", cost: { source: "ITEM_COST" } }, facts({ cost: { lastPurchaseCost: 50, costPerUnit: null } })), "COST_SOURCE_MISSING");
  refused("MANUAL negative", act(part({ state: "RESERVED" }), { type: "ISSUE", cost: { source: "MANUAL", unitCostAgorot: -1 } }), "INVALID_INPUT");
  const unknown = act(part({ state: "RESERVED" }), { type: "ISSUE", cost: { source: "NONE" } }, facts({ cost: { lastPurchaseCost: null, costPerUnit: null } }));
  allowed("NONE: cost stays unknown (null), never invented", unknown, (x) => x.part.unitCostAgorot === null && x.part.costSource === "NONE" && x.warnings.includes("COST_UNKNOWN"));
  check("the selling price is never used as cost", unknown.ok && unknown.part.unitCostAgorot === null && unknown.part.customerUnitPriceAgorot === 45_000);
  const later = act(part({ state: "RESERVED" }), { type: "ISSUE", cost: { source: "LAST_PURCHASE" } }, facts({ cost: { lastPurchaseCost: 999, costPerUnit: null } }));
  check("a later purchase price is not read for an issued part (the snapshot is what it is)", later.ok && act(later.part, { type: "INSTALL" }).ok && (act(later.part, { type: "INSTALL" }) as Extract<PartDecision, { ok: true }>).part.unitCostAgorot === 99_900);
  const corr = act(issued(), { type: "CORRECT_COST", unitCostAgorot: 11_000, reason: "חשבונית ספק מתוקנת" });
  allowed("cost correction: new value, previous kept, source MANUAL", corr, (x) => x.part.unitCostAgorot === 11_000 && x.event.previousAmountAgorot === 12_050 && x.event.payload.previousSource === "LAST_PURCHASE" && x.part.costSource === "MANUAL");
  check("correction reason is a text, not payload", corr.ok && corr.texts.reason === "חשבונית ספק מתוקנת" && corr.event.payload.reasonRecorded === true);
  refused("correction without reason", act(issued(), { type: "CORRECT_COST", unitCostAgorot: 1, reason: " " }), "REASON_REQUIRED");
  refused("correction to the same value", act(issued(), { type: "CORRECT_COST", unitCostAgorot: 12_050, reason: "x" }), "CORRECTION_UNCHANGED");
  refused("correction before any cost was captured", act(part({ state: "RESERVED" }), { type: "CORRECT_COST", unitCostAgorot: 1, reason: "x" }), "COST_NOT_CAPTURED");
  refused("correction of a part inside the supplier cost", act(part({ source: "SUPPLIER", inventoryItemId: null, state: "INSTALLED", costIncludedInExternal: true, externalWorkId: 4 }), { type: "CORRECT_COST", unitCostAgorot: 1, reason: "x" }), "COST_NOT_CAPTURED");
  allowed("correction allowed after the case closed (history fix)", act(issued({ state: "INSTALLED" }), { type: "CORRECT_COST", unitCostAgorot: 1, reason: "x" }, facts({ case: caseF({ status: "CLOSED" }) })));
  allowed("correcting a NONE cost to a known one", act(issued({ unitCostAgorot: null, costSource: "NONE" }), { type: "CORRECT_COST", unitCostAgorot: 500, reason: "x" }), (x) => x.event.previousAmountAgorot === null);
}

console.log("\n== 6. install / use ==");
{
  const d = act(issued(), { type: "INSTALL" });
  allowed("install ISSUED → INSTALLED, no second movement", d, (x) => x.part.state === "INSTALLED" && x.inventory === null);
  refused("install without issue", act(part({ state: "RESERVED" }), { type: "INSTALL" }), "TRANSITION_NOT_ALLOWED");
  refused("install twice", act(issued({ state: "INSTALLED" }), { type: "INSTALL" }), "TRANSITION_NOT_ALLOWED");
  refused("install a part that is with the supplier", act(issued({ externalWorkId: 4 }), { type: "INSTALL" }), "PART_AT_SUPPLIER");
  allowed("install recorded after a cancel (documenting the use)", act(issued(), { type: "INSTALL" }, facts({ case: caseF({ status: "READY", outcome: "CANCELLED" }) })), (x) => x.event.payload.afterCancel === true);
}

console.log("\n== 7. return of an unused part: the one IN movement ==");
{
  const d = act(issued(), { type: "RETURN", quantity: 1 });
  allowed("return ISSUED → RETURNED", d, (x) => x.part.state === "RETURNED" && x.part.returnMovementLinked);
  check("exactly one IN intent, RETURN, +quantity, linked as returnMovementId", d.ok && d.inventory?.movementType === "IN" && d.inventory.reason === "RETURN" && d.inventory.quantityDelta === 1 && d.inventory.linkAs === "returnMovementId");
  check("return asks for movement uniqueness + match", d.ok && d.serverChecks.includes("MOVEMENT_LINK_UNIQUE") && d.serverChecks.includes("MOVEMENT_MATCHES_PART"));
  refused("return twice", act(issued({ state: "RETURNED", returnMovementLinked: true }), { type: "RETURN", quantity: 1 }), "ALREADY_RETURNED");
  refused("return link already present", act(issued({ returnMovementLinked: true }), { type: "RETURN", quantity: 1 }), "ALREADY_RETURNED");
  refused("return a reserved part (release/cancel instead)", act(part({ state: "RESERVED" }), { type: "RETURN", quantity: 1 }), "TRANSITION_NOT_ALLOWED");
  refused("return an installed part", act(issued({ state: "INSTALLED" }), { type: "RETURN", quantity: 1 }), "TRANSITION_NOT_ALLOWED");
  refused("partial return (ק‑4 undecided)", act(issued({ quantity: 3 }), { type: "RETURN", quantity: 1 }), "PARTIAL_RETURN_NOT_DECIDED");
  refused("return more than issued", act(issued(), { type: "RETURN", quantity: 2 }), "QUANTITY_INVALID");
  refused("return zero", act(issued(), { type: "RETURN", quantity: 0 }), "QUANTITY_INVALID");
  refused("return negative", act(issued(), { type: "RETURN", quantity: -1 }), "QUANTITY_INVALID");
  refused("return a part that is with the supplier (resolve it)", act(issued({ externalWorkId: 4 }), { type: "RETURN", quantity: 1 }), "PART_AT_SUPPLIER");
  allowed("non-stock return: no movement", act(issued({ source: "NON_STOCK", inventoryItemId: null, issueMovementLinked: false }), { type: "RETURN", quantity: 1 }), (x) => x.inventory === null && !x.part.returnMovementLinked);
  allowed("return allowed after a cancel", act(issued(), { type: "RETURN", quantity: 1 }, facts({ case: caseF({ status: "CANCELLED", outcome: "CANCELLED" }) })));
  allowed("ML quantity returned whole within epsilon", act(issued({ unitType: "ML", quantity: 0.3 }), { type: "RETURN", quantity: 0.1 + 0.2 }), (x) => x.inventory?.quantityDelta === 0.3);
}

console.log("\n== 8. damaged / written off ==");
{
  const d = act(issued(), { type: "WRITE_OFF", reason: "DAMAGED", note: "נסדק בהתקנה" });
  allowed("write-off ISSUED → WRITTEN_OFF, no movement (stock already down)", d, (x) => x.part.state === "WRITTEN_OFF" && x.inventory === null && x.part.writeOffReason === "DAMAGED");
  check("the loss carries the captured cost; note is a text", d.ok && d.event.amountAgorot === 12_050 && d.texts.note === "נסדק בהתקנה" && d.event.payload.noteRecorded === true);
  refused("a damaged part on the shelf is an inventory DAMAGE, not ours", act(part({ state: "RESERVED" }), { type: "WRITE_OFF", reason: "DAMAGED" }), "TRANSITION_NOT_ALLOWED");
  refused("write off twice", act(issued({ state: "WRITTEN_OFF", writeOffReason: "LOST" }), { type: "WRITE_OFF", reason: "DAMAGED" }), "TRANSITION_NOT_ALLOWED");
  refused("KEPT_BY_SUPPLIER for a part that never went out", act(issued(), { type: "WRITE_OFF", reason: "KEPT_BY_SUPPLIER" }), "INVALID_INPUT");
  refused("unknown reason", act(issued(), { type: "WRITE_OFF", reason: "BROKEN" as "DAMAGED" }), "INVALID_INPUT");
  refused("write off while at the supplier (resolve it)", act(issued({ externalWorkId: 4 }), { type: "WRITE_OFF", reason: "LOST" }), "PART_AT_SUPPLIER");
  allowed("write-off LOST after a cancel", act(issued(), { type: "WRITE_OFF", reason: "LOST" }, facts({ case: caseF({ status: "READY", outcome: "CANCELLED" }) })));
}

console.log("\n== 9. specially ordered part (no automatic purchase order) ==");
{
  const o = act(part(), { type: "MARK_ON_ORDER", purchaseOrderId: 8, purchaseOrderLineId: 81, expectedOn: "2026-11-20" });
  allowed("NEEDED → ON_ORDER with an existing order line and an expected date", o, (x) => x.part.state === "ON_ORDER" && x.part.purchaseOrderLineId === 81 && x.part.expectedOn === "2026-11-20" && x.inventory === null);
  check("never creates an order; asks the server to verify the order and line", o.ok && o.event.payload.automaticOrder === false && o.serverChecks.includes("PURCHASE_ORDER_BELONGS_TO_BUSINESS") && o.serverChecks.includes("PURCHASE_ORDER_LINE_OF_ORDER"));
  allowed("ordered by phone (no order link)", act(part(), { type: "MARK_ON_ORDER" }), (x) => x.part.purchaseOrderId === null && x.serverChecks.length === 0);
  refused("a line without its order", act(part(), { type: "MARK_ON_ORDER", purchaseOrderLineId: 81 }), "INVALID_INPUT");
  refused("invalid date", act(part(), { type: "MARK_ON_ORDER", expectedOn: "2026-02-30" }), "INVALID_INPUT");
  refused("order a reserved part", act(part({ state: "RESERVED" }), { type: "MARK_ON_ORDER" }), "TRANSITION_NOT_ALLOWED");
  allowed("update the expected date", act(part({ state: "ON_ORDER", expectedOn: "2026-11-20" }), { type: "UPDATE_ORDER", expectedOn: "2026-11-25" }), (x) => x.event.kind === "ORDER_UPDATED" && x.part.expectedOn === "2026-11-25");
  refused("update with nothing changed", act(part({ state: "ON_ORDER", expectedOn: "2026-11-20" }), { type: "UPDATE_ORDER", expectedOn: "2026-11-20" }), "ORDER_UNCHANGED");
  refused("update a part not on order", act(part(), { type: "UPDATE_ORDER", expectedOn: "2026-11-25" }), "TRANSITION_NOT_ALLOWED");
  const arrived = act(part({ state: "ON_ORDER", purchaseOrderId: 8 }), { type: "RESERVE" }, facts({ stock: stock({ onHandQuantity: 1 }) }));
  allowed("arrived: ON_ORDER → RESERVED (owner action after receiving)", arrived, (x) => x.part.state === "RESERVED" && x.event.payload.fromOrder === true && x.part.purchaseOrderId === 8);
  refused("not yet received: reserve refused", act(part({ state: "ON_ORDER" }), { type: "RESERVE" }, facts({ stock: stock({ onHandQuantity: 0 }) })), "PART_NOT_AVAILABLE");
  refused("received but taken by another case's reservation", act(part({ state: "ON_ORDER" }), { type: "RESERVE" }, facts({ stock: stock({ onHandQuantity: 1, reservedByOtherParts: 1 }) })), "PART_NOT_AVAILABLE");
  allowed("non-stock part can be marked ordered", act(part({ source: "NON_STOCK", inventoryItemId: null }), { type: "MARK_ON_ORDER" }));
}

console.log("\n== 10. cancel of a part and of the case ==");
{
  for (const s of ["NEEDED", "ON_ORDER", "RESERVED"] as const) {
    allowed(`cancel a ${s} part: no movement`, act(part({ state: s }), { type: "CANCEL" }), (x) => x.part.state === "CANCELLED" && x.inventory === null);
  }
  refused("cancel an issued part: resolve it instead", act(issued(), { type: "CANCEL" }), "TRANSITION_NOT_ALLOWED");
  refused("cancel an installed part", act(issued({ state: "INSTALLED" }), { type: "CANCEL" }), "TRANSITION_NOT_ALLOWED");
  allowed("cancel a part on an already-cancelled case (the cascade)", act(part({ state: "RESERVED" }), { type: "CANCEL" }, facts({ case: caseF({ status: "CANCELLED", outcome: "CANCELLED" }) })), (x) => x.event.payload.withCase === true);
  const lines = [
    { id: 1, part: part() }, { id: 2, part: part({ state: "ON_ORDER" }) }, { id: 3, part: part({ state: "RESERVED" }) },
    { id: 4, part: issued() }, { id: 5, part: issued({ state: "INSTALLED" }) }, { id: 6, part: issued({ state: "RETURNED" }) }, { id: 7, part: issued({ externalWorkId: 4 }) },
  ];
  const plan = planPartsForCaseCancel(lines);
  check("cancel plan: shelf / order lines are cancelled with the case", JSON.stringify(plan.cancelWithCase) === "[1,2,3]");
  check("cancel plan: issued lines (incl. at the supplier) need resolution", JSON.stringify(plan.needsResolution) === "[4,7]");
  check("cancel completion blocked while issued parts are unresolved", plan.completionBlocked);
  check("nothing issued: completion not blocked", !planPartsForCaseCancel(lines.filter((l) => l.id !== 4 && l.id !== 7)).completionBlocked);
  check("empty case: nothing to do", planPartsForCaseCancel([]).completionBlocked === false && planPartsForCaseCancel([]).cancelWithCase.length === 0);
}

console.log("\n== 11. parts at an external supplier ==");
{
  const ext = { externalWorkId: 4, sameCase: true, atSupplier: true };
  const sendNew = act(part({ state: "RESERVED" }), { type: "SEND_WITH_EXTERNAL", cost: { source: "LAST_PURCHASE" } }, facts({ external: ext, case: caseF({ status: "EXTERNAL" }) }));
  allowed("send a reserved part with the device: issued now, one OUT", sendNew, (x) => x.part.state === "ISSUED" && x.part.externalWorkId === 4 && x.inventory?.movementType === "OUT" && x.event.payload.issuedNow === true);
  const sendIssued = act(issued(), { type: "SEND_WITH_EXTERNAL" }, facts({ external: ext }));
  allowed("send an already issued part: attached, no second movement", sendIssued, (x) => x.inventory === null && x.part.externalWorkId === 4 && x.event.payload.issuedNow === false);
  refused("send to a work of another case", act(issued(), { type: "SEND_WITH_EXTERNAL" }, facts({ external: { ...ext, sameCase: false } })), "EXTERNAL_WORK_INVALID");
  refused("send to a work already back", act(issued(), { type: "SEND_WITH_EXTERNAL" }, facts({ external: { ...ext, atSupplier: false } })), "EXTERNAL_WORK_INVALID");
  refused("send twice", act(issued({ externalWorkId: 4 }), { type: "SEND_WITH_EXTERNAL" }, facts({ external: ext })), "PART_AT_SUPPLIER");
  refused("send without stock: fails safely", act(part({ state: "RESERVED" }), { type: "SEND_WITH_EXTERNAL", cost: { source: "NONE" } }, facts({ external: ext, stock: stock({ onHandQuantity: 0 }) })), "PART_NOT_AVAILABLE");
  const out = issued({ externalWorkId: 4 });
  const back = act(out, { type: "RESOLVE_FROM_EXTERNAL", resolution: "RETURNED_INTACT" }, facts({ external: { ...ext, atSupplier: false } }));
  allowed("supplier returned it unused (owner verified): RETURNED + one IN", back, (x) => x.part.state === "RETURNED" && x.inventory?.movementType === "IN" && x.event.kind === "BACK_FROM_EXTERNAL");
  allowed("supplier installed our part: INSTALLED, no movement", act(out, { type: "RESOLVE_FROM_EXTERNAL", resolution: "INSTALLED" }, facts({ external: ext })), (x) => x.part.state === "INSTALLED" && x.inventory === null);
  allowed("supplier damaged it: WRITTEN_OFF DAMAGED, no movement", act(out, { type: "RESOLVE_FROM_EXTERNAL", resolution: "DAMAGED" }, facts({ external: ext })), (x) => x.part.writeOffReason === "DAMAGED" && x.inventory === null);
  allowed("supplier kept it: WRITTEN_OFF KEPT_BY_SUPPLIER", act(out, { type: "RESOLVE_FROM_EXTERNAL", resolution: "KEPT_BY_SUPPLIER" }, facts({ external: ext })), (x) => x.part.writeOffReason === "KEPT_BY_SUPPLIER");
  refused("a supplier report alone moves nothing: only the owner resolves", act(out, { type: "RESOLVE_FROM_EXTERNAL", resolution: "RETURNED_INTACT" }, facts({ external: ext }), SYSTEM), "ACTOR_NOT_ALLOWED");
  refused("resolve against another work", act(out, { type: "RESOLVE_FROM_EXTERNAL", resolution: "INSTALLED" }, facts({ external: { ...ext, externalWorkId: 5 } })), "EXTERNAL_WORK_INVALID");
  refused("resolve a part that is not out", act(issued(), { type: "RESOLVE_FROM_EXTERNAL", resolution: "INSTALLED" }, facts({ external: ext })), "PART_NOT_AT_SUPPLIER");
  refused("resolve twice", act(issued({ externalWorkId: 4, state: "INSTALLED" }), { type: "RESOLVE_FROM_EXTERNAL", resolution: "INSTALLED" }, facts({ external: ext })), "PART_NOT_AT_SUPPLIER");
  const sup: SupplierPartInput = { name: "סוללה מקורית", quantity: 1, externalWorkId: 4, costIncludedInExternal: true, underWarranty: false };
  const sp = keep(recordSupplierPart(sup, { case: caseF({ status: "EXTERNAL" }), external: ext }, OWNER));
  allowed("supplier's own part: recorded INSTALLED, no movement, cost inside the supplier's", sp, (x) => x.part.state === "INSTALLED" && x.part.source === "SUPPLIER" && x.inventory === null && x.part.costIncludedInExternal && x.part.unitCostAgorot === null);
  allowed("supplier part billed separately keeps its own cost", recordSupplierPart({ ...sup, costIncludedInExternal: false, unitCostAgorot: 7000 }, { case: LIVE, external: ext }, OWNER), (x) => x.part.unitCostAgorot === 7000 && !x.part.costIncludedInExternal);
  allowed("warranty replacement: cost 0", recordSupplierPart({ ...sup, underWarranty: true }, { case: LIVE, external: ext }, OWNER), (x) => x.part.unitCostAgorot === 0 && x.event.payload.underWarranty === true);
  refused("included part with its own cost = double count", recordSupplierPart({ ...sup, unitCostAgorot: 7000 }, { case: LIVE, external: ext }, OWNER), "INVALID_INPUT");
  refused("separately billed part without a cost", recordSupplierPart({ ...sup, costIncludedInExternal: false }, { case: LIVE, external: ext }, OWNER), "INVALID_INPUT");
  refused("warranty part with a cost", recordSupplierPart({ ...sup, underWarranty: true, unitCostAgorot: 10 }, { case: LIVE, external: ext }, OWNER), "INVALID_INPUT");
  refused("supplier part for another case's work", recordSupplierPart(sup, { case: LIVE, external: { ...ext, sameCase: false } }, OWNER), "EXTERNAL_WORK_INVALID");
  refused("supplier part recorded by the system", recordSupplierPart(sup, { case: LIVE, external: ext }, SYSTEM), "ACTOR_NOT_ALLOWED");
  allowed("supplier part may be recorded after a cancel request (the device came back)", recordSupplierPart(sup, { case: caseF({ status: "EXTERNAL", cancellationRequested: true }), external: { ...ext, atSupplier: false } }, OWNER));
  const lines = [{ id: 1, part: out }, { id: 2, part: issued({ externalWorkId: 9 }) }, { id: 3, part: issued({ externalWorkId: 4, state: "INSTALLED" }) }];
  check("parts still out with work 4 are listed (the return stays open on them)", JSON.stringify(partsBlockingExternalReturn(lines, 4)) === "[1]");
}

console.log("\n== 12. price and quote ==");
{
  allowed("set the customer price", act(part(), { type: "SET_PRICE", customerUnitPriceAgorot: 50_000 }), (x) => x.part.customerUnitPriceAgorot === 50_000 && x.event.previousAmountAgorot === 45_000);
  allowed("price change after the part was quoted warns: a new quote version is needed", act(part({ quotedInVersion: 2 }), { type: "SET_PRICE", customerUnitPriceAgorot: 50_000 }), (x) => x.warnings.includes("PRICE_DIFFERS_FROM_QUOTE"));
  refused("same price", act(part(), { type: "SET_PRICE", customerUnitPriceAgorot: 45_000 }), "PRICE_UNCHANGED");
  refused("negative price", act(part(), { type: "SET_PRICE", customerUnitPriceAgorot: -1 }), "INVALID_INPUT");
  refused("price on a returned part", act(issued({ state: "RETURNED" }), { type: "SET_PRICE", customerUnitPriceAgorot: 1 }), "TRANSITION_NOT_ALLOWED");
  allowed("price cleared (null)", act(part(), { type: "SET_PRICE", customerUnitPriceAgorot: null }));
  const q = act(part(), { type: "RECORD_QUOTED", quoteVersion: 2 });
  allowed("record the quote version the part was offered in", q, (x) => x.part.quotedInVersion === 2 && x.serverChecks.includes("QUOTE_VERSION_OF_CASE"));
  refused("quote a part without a price", act(part({ customerUnitPriceAgorot: null }), { type: "RECORD_QUOTED", quoteVersion: 2 }), "INVALID_INPUT");
  refused("quote version 0", act(part(), { type: "RECORD_QUOTED", quoteVersion: 0 }), "INVALID_INPUT");
}

console.log("\n== 13. summary: counts, open parts, costs counted once ==");
{
  const parts = [
    issued({ state: "INSTALLED", unitCostAgorot: 12_050, quantity: 1, customerUnitPriceAgorot: 45_000 }),
    issued({ state: "WRITTEN_OFF", unitCostAgorot: 3_000, quantity: 2, writeOffReason: "DAMAGED", customerUnitPriceAgorot: 9_000 }),
    issued({ unitCostAgorot: 1_000, quantity: 3, customerUnitPriceAgorot: 2_000 }),
    issued({ state: "RETURNED", unitCostAgorot: 5_000, customerUnitPriceAgorot: 7_000 }),
    part({ state: "RESERVED", customerUnitPriceAgorot: 10_000 }),
    part({ state: "CANCELLED", customerUnitPriceAgorot: 99_000 }),
    part({ source: "SUPPLIER", inventoryItemId: null, state: "INSTALLED", costIncludedInExternal: true, externalWorkId: 4, customerUnitPriceAgorot: null }),
    part({ source: "SUPPLIER", inventoryItemId: null, state: "INSTALLED", unitCostAgorot: 7_000, costSource: "MANUAL", externalWorkId: 4, customerUnitPriceAgorot: null }),
    issued({ state: "INSTALLED", unitCostAgorot: null, costSource: "NONE", customerUnitPriceAgorot: null }),
  ];
  const s = summarizeCaseParts(parts, 20_000);
  check("parts cost = installed + written off + separately billed supplier part (12050 + 6000 + 7000)", s.partsCostAgorot === 25_050, String(s.partsCostAgorot));
  check("supplier part inside the supplier cost is not counted again", s.partsCostAgorot === 25_050 && s.externalCostAgorot === 20_000);
  check("total = parts + external once", s.totalCostAgorot === 45_050);
  check("issued-not-installed is expected cost, not final (3 × 1000)", s.expectedCostAgorot === 3_000);
  check("returned and cancelled parts carry no cost", s.partsCostAgorot + s.expectedCostAgorot === 28_050);
  check("unknown cost lines counted, never invented", s.unknownCostLines === 1);
  check("customer price: open + issued + installed only (45000 + 6000 + 10000)", s.customerPriceAgorot === 61_000, String(s.customerPriceAgorot));
  check("open parts = NEEDED/ON_ORDER/RESERVED/ISSUED", s.openCount === 2 && s.unresolvedIssuedCount === 1);
  check("byState counts every line", Object.values(s.byState).reduce((a, b) => a + b, 0) === parts.length && s.byState.INSTALLED === 4);
  check("external cost null/invalid counts as 0", summarizeCaseParts([], null).externalCostAgorot === 0 && summarizeCaseParts([], -5).externalCostAgorot === 0);
  check("fractional quantity cost rounds to whole agorot", summarizeCaseParts([issued({ state: "INSTALLED", unitType: "ML", quantity: 0.333, unitCostAgorot: 100 })], 0).partsCostAgorot === 33);
}

console.log("\n== 14. fit with the unchanged 1.1 case machine and 1.1d external work ==");
{
  const ctx = (o: Partial<ServiceCaseContext> = {}): ServiceCaseContext => ({
    kind: "IN_SHOP", status: "DELIVERED", holdReason: null, outcome: "REPAIRED", version: 9, staffMemberId: 5, siteId: null,
    coverage: null, currentQuote: { version: 1, totalAgorot: 45_000, docHash: "h1", state: "APPROVED", approval: { version: 1, totalAgorot: 45_000, docHash: "h1", method: "PHONE" } },
    intake: { conditionRecorded: true, accessoriesRecorded: true, customerSigned: true }, qaChecklistCompleted: true,
    openPartReservations: 0, openLoaner: false, cancellationRequested: false, pickupRemindersSent: 0,
    settlement: { known: true, openBalanceAgorot: 0 }, ...o,
  });
  const open = summarizeCaseParts([issued(), part({ state: "RESERVED" }), issued({ state: "INSTALLED" })], 0).openCount;
  const close = evaluateTransition(ctx({ openPartReservations: open }), { type: "CLOSE" }, SYSTEM);
  check("case CLOSE refused while parts are open (fed with openCount)", !close.ok && close.violations.some((x) => x.code === "OPEN_PART_RESERVATIONS"));
  const closeOk = evaluateTransition(ctx({ openPartReservations: summarizeCaseParts([issued({ state: "INSTALLED" }), part({ state: "CANCELLED" })], 0).openCount }), { type: "CLOSE" }, SYSTEM);
  check("case CLOSE allowed once every part is resolved", closeOk.ok);
  const cancel = evaluateTransition(ctx({ status: "IN_REPAIR", outcome: null, openPartReservations: 2 }), { type: "CANCEL", reason: "הלקוח ויתר" }, OWNER);
  check("case CANCEL request is never refused because of parts", cancel.ok && cancel.effects.includes("RELEASE_PART_RESERVATIONS"));
  check("held item cancelled → READY (then delivery and CLOSE, which waits for parts)", cancel.ok && cancel.to === "READY");
  const field = evaluateTransition(ctx({ kind: "FIELD", status: "IN_REPAIR", outcome: null, openPartReservations: 1 }), { type: "CANCEL", reason: null as unknown as string }, OWNER);
  check("FIELD cancel → CANCELLED (terminal) — the case machine is unchanged", field.ok && field.to === "CANCELLED");
  allowed("…and its issued part can still be resolved afterwards", act(issued(), { type: "RETURN", quantity: 1 }, facts({ case: caseF({ status: "CANCELLED", outcome: "CANCELLED" }) })));
  const extCancel = evaluateTransition(ctx({ status: "EXTERNAL", outcome: null, openPartReservations: 1 }), { type: "CANCEL", reason: "x" }, OWNER);
  check("cancel at the supplier stays a request (1.1d unchanged)", extCancel.ok && extCancel.to === "EXTERNAL" && extCancel.cancellationRequestedAfter === true);
  const work = { state: "AT_SUPPLIER" as const, round: 1, supplierId: 12, progressStage: "REPAIR_DONE" as const, version: 3, supplierReference: null, expectedBackOn: null, estimatedCostAgorot: null, approvedCostAgorot: null, finalCostAgorot: null, returnResult: null };
  const wc = closeExternalWork(work, { result: "REPAIRED", followUpRequired: false }, OWNER);
  check("1.1d closeExternalWork is unaffected by parts (the service checks partsBlockingExternalReturn)", wc.ok);
}

console.log("\n== 15. envelope, invalid input, actors ==");
{
  check("envelope ok", checkPartEnvelope(part({ version: 3 }), { partId: 1, expectedVersion: 3, idempotencyKey: "part:1:issue:abc" }).ok);
  const stale = checkPartEnvelope(part({ version: 4 }), { partId: 1, expectedVersion: 3, idempotencyKey: "part:1:issue:abc" });
  check("stale version → VERSION_CONFLICT (a replay of a done issue)", !stale.ok && stale.violations.some((x) => x.code === "VERSION_CONFLICT"));
  const badKey = checkPartEnvelope(part(), { partId: 1, expectedVersion: 1, idempotencyKey: "short" });
  check("short idempotency key refused", !badKey.ok);
  check("partId must be positive", !checkPartEnvelope(part(), { partId: 0, expectedVersion: 1, idempotencyKey: "part:1:issue:abc" }).ok);
  refused("unknown action", act(part(), { type: "TELEPORT" } as unknown as PartAction), "INVALID_INPUT");
  refused("invalid snapshot (bad state)", act(part({ state: "LOST" as "NEEDED" }), { type: "RESERVE" }), "INVALID_INPUT");
  refused("invalid snapshot (stock without item)", act(part({ inventoryItemId: null }), { type: "RESERVE" }), "INVALID_INPUT");
  refused("invalid snapshot (zero quantity)", act(part({ quantity: 0 }), { type: "RESERVE" }), "INVALID_INPUT");
  refused("invalid snapshot (version 0)", act(part({ version: 0 }), { type: "RESERVE" }), "INVALID_INPUT");
  refused("missing case facts", act(part(), { type: "RESERVE" }, { case: undefined as unknown as PartCaseFacts }), "INVALID_INPUT");
  refused("owner without a user id", act(part(), { type: "RESERVE" }, facts(), { kind: "OWNER", userId: 0 }), "ACTOR_NOT_ALLOWED");
  check("isValidPartQuantity: BOX whole only, ML any positive", isValidPartQuantity(2, "BOX") && !isValidPartQuantity(2.5, "BOX") && isValidPartQuantity(0.01, "ML") && !isValidPartQuantity(Infinity, "ML"));
}

console.log("\n== 16. invariants over every ok decision ==");
{
  const TOKEN = /^[A-Z0-9_]{1,40}$|^\d{4}-\d{2}-\d{2}$/;
  const payloadOk = (p: Readonly<Record<string, ServiceEventPayloadValue>>) => Object.values(p).every((x) => x === null || typeof x === "number" || typeof x === "boolean" || (typeof x === "string" && TOKEN.test(x)));
  check(`collected ok decisions (${OK.length})`, OK.length >= 45);
  check("every payload holds only tokens, numbers, booleans, nulls (no free text)", OK.every((d) => payloadOk(d.event.payload)), OK.filter((d) => !payloadOk(d.event.payload)).map((d) => d.event.kind).join(","));
  check("at most one movement intent per decision", OK.every((d) => d.inventory === null || typeof d.inventory.quantityDelta === "number"));
  check("only ISSUED/SENT_WITH_EXTERNAL ask for OUT, only RETURNED/BACK_FROM_EXTERNAL for IN", OK.every((d) =>
    d.inventory === null
    || (d.inventory.movementType === "OUT" && ["ISSUED", "SENT_WITH_EXTERNAL"].includes(d.event.kind) && d.inventory.quantityDelta < 0)
    || (d.inventory.movementType === "IN" && ["RETURNED", "BACK_FROM_EXTERNAL"].includes(d.event.kind) && d.inventory.quantityDelta > 0)));
  check("a movement intent only for STOCK parts", OK.every((d) => d.inventory === null || d.part.source === "STOCK"));
  check("reserve / release / install / write-off / cancel / price / cost never ask for a movement", OK.filter((d) => ["RESERVED", "RELEASED", "INSTALLED", "WRITTEN_OFF", "CANCELLED", "PRICE_SET", "QUOTED", "COST_CORRECTED", "ORDER_LINKED", "ORDER_UPDATED", "ADDED", "SUPPLIER_PART_RECORDED"].includes(d.event.kind)).every((d) => d.inventory === null));
  check("event seq = the part's new version; stateAfter = part.state", OK.every((d) => d.event.seq === d.part.version && d.event.stateAfter === d.part.state));
  check("issueMovementLinked ⇔ a STOCK part that left the stock", OK.every((d) => d.part.issueMovementLinked === (d.part.source === "STOCK" && ["ISSUED", "INSTALLED", "WRITTEN_OFF", "RETURNED"].includes(d.part.state))));
  check("returnMovementLinked only for RETURNED stock parts", OK.every((d) => !d.part.returnMovementLinked || (d.part.state === "RETURNED" && d.part.source === "STOCK")));
  check("write-off reason ⇔ WRITTEN_OFF", OK.every((d) => (d.part.writeOffReason !== null) === (d.part.state === "WRITTEN_OFF")));
  check("every event kind is known; every state is known", OK.every((d) => PART_EVENT_KINDS.includes(d.event.kind) && PART_STATES.includes(d.part.state)));
  check("open and terminal states partition the eight", OPEN_PART_STATES.length + TERMINAL_PART_STATES.length === PART_STATES.length && PART_STATES.every((s) => OPEN_PART_STATES.includes(s) !== TERMINAL_PART_STATES.includes(s)));
  check("a cost included in the supplier's never carries a cost of its own", OK.every((d) => !d.part.costIncludedInExternal || d.part.unitCostAgorot === null));
  check("costs are integer agorot or null", OK.every((d) => d.part.unitCostAgorot === null || Number.isInteger(d.part.unitCostAgorot)));
}

console.log("\n== 17. purity: no input mutation, deterministic ==");
{
  const p = deepFreeze(part({ state: "RESERVED", version: 2 }));
  const f = deepFreeze(facts());
  const a1 = evaluatePartAction(p, { type: "ISSUE", cost: { source: "LAST_PURCHASE" } }, f, OWNER);
  const a2 = evaluatePartAction(p, { type: "ISSUE", cost: { source: "LAST_PURCHASE" } }, f, OWNER);
  check("frozen inputs are not mutated (no throw) and output is deterministic", JSON.stringify(a1) === JSON.stringify(a2));
  check("the returned part is a copy", a1.ok && a1.part !== p && p.state === "RESERVED");
  const lines = deepFreeze([{ id: 1, part: issued() }]);
  check("plan / summary do not mutate", planPartsForCaseCancel(lines).completionBlocked && summarizeCaseParts([lines[0].part], 0).openCount === 1);
  const src = fs.readFileSync(path.join(__dirname, "parts.core.ts"), "utf8") + fs.readFileSync(path.join(__dirname, "parts.contracts.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("core imports nothing outside service-desk (no prisma, no inventory service)", !/from\s+["'](?!\.\/)/.test(code));
  check("no clock, randomness, network or database in the core", !/Date\.now|new Date\(\)|Math\.random|fetch\(|prisma|\$queryRaw|\$executeRaw/.test(code));
  check("the core never names currentQuantity writes", !/currentQuantity\s*[:=]/.test(code));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
