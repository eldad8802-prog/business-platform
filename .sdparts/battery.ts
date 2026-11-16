/**
 * Service Desk 1d-B — spare parts WITHOUT stock movements: the data service AS the real runtime role, on the P4 lab
 * (.sd3p4/lab.sh <db> then --deploy-only: 1.2a + 1.2b + M2 + 1.3-0 + P4 applied by migrate deploy). Synthetic only.
 *
 *   A  add: a STOCK line (item of the business, active, its unit) and a NON_STOCK line → NEEDED v1 with ADDED; replay;
 *      same key + other body; an item of another business; an inactive item; a unit mismatch; a fractional UNIT; a
 *      finished case; a cancelled case.
 *   R  reserve (soft): NEEDED → RESERVED within what is on hand minus the other reservations; over-reservation refused;
 *      a NON_STOCK line cannot be reserved; release → NEEDED; the inventory row is UNCHANGED (quantity, updatedAt) and
 *      no InventoryMovement is written by any of it.
 *   P  price: set, unchanged refused, cleared; the amounts on the event.
 *   C  cancel: NEEDED / RESERVED → CANCELLED with the reason in its column only (never the payload); a cancelled line
 *      takes no further action.
 *   O  out of scope: ISSUE, RETURN, MARK_ON_ORDER, UPDATE_ORDER, INSTALL, WRITE_OFF, SEND_WITH_EXTERNAL,
 *      RESOLVE_FROM_EXTERNAL, CORRECT_COST, RECORD_QUOTED → ACTION_NOT_IN_SCOPE, nothing written.
 *   G  database guards as the runtime role: a part change without its event rolls back; the part journal is append-only.
 *   I  isolation: another business cannot list, add to or act on A's parts.
 *   K  races: two reservations of the last units at once → one wins (no over-reservation); one add key five times →
 *      one line; two actions at one version → one wins.
 *   L  closed to users: with FULL access both parts routes answer 422 ACTION_NOT_IN_SCOPE and write nothing; 401 with no
 *      session; 404 when the module is NONE.
 *
 * env: OWNER_URL (lab owner), DATABASE_URL = DIRECT_URL (app_runtime_prod), TASK_REQUEST_HMAC_KEY / _ID, AUTH_TOKEN_SECRET.
 */
import { PrismaClient } from "@prisma/client";

import { uuidV7 } from "../lib/services/tasks/task-idempotency";
import { ServiceDeskError } from "../lib/services/service-desk/service-desk-errors";
import { openCase, runCaseAction, type ServiceDeskPrincipal } from "../lib/services/service-desk/service-case.service";
import { PARTS_API_OPEN, addCasePart, listParts, runPartAction } from "../lib/services/service-desk/parts.service";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL! });
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const x = (sql: string, ...a: unknown[]) => owner.$executeRawUnsafe(sql, ...a);
const n = async (sql: string, ...a: unknown[]) => Number((await q(sql, ...a))[0]?.n);
const key = (at = new Date()) => uuidV7(at);
async function code(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return "OK"; } catch (e) {
    if (e instanceof ServiceDeskError) return `${e.code}${e.details && Object.keys(e.details).length ? ":" + JSON.stringify(e.details) : ""}`;
    return `ERR:${(e as Error).message.slice(0, 200)}`;
  }
}
const t = Date.now();
async function business(tag: string) {
  const b = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sdparts-${tag}-${t}`))[0].id);
  const u = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdparts-${tag}-${t}@lab.invalid`, b))[0].id);
  const cust = Number((await q(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, b))[0].id);
  const item = Number((await q(`INSERT INTO "InventoryItem" ("businessId", name, "unitType", "currentQuantity", "updatedAt") VALUES ($1, 'מסך 6.1', 'UNIT', 3, now()) RETURNING id`, b))[0].id);
  const off = Number((await q(`INSERT INTO "InventoryItem" ("businessId", name, "unitType", "currentQuantity", "isActive", "updatedAt") VALUES ($1, 'פריט לא פעיל', 'UNIT', 5, false, now()) RETURNING id`, b))[0].id);
  const ml = Number((await q(`INSERT INTO "InventoryItem" ("businessId", name, "unitType", "currentQuantity", "updatedAt") VALUES ($1, 'גז קירור', 'ML', 1000, now()) RETURNING id`, b))[0].id);
  return { b, u, cust, item, off, ml, p: { businessId: b, userId: u } as ServiceDeskPrincipal };
}
type Biz = Awaited<ReturnType<typeof business>>;
const openFIELD = async (z: Biz) => (await openCase(z.p, { kind: "FIELD", customerId: z.cust, problemDescription: "תקלה סינתטית" }, { idempotencyKey: key() })).case;
const add = (z: Biz, caseId: number, body: Record<string, unknown>, k = key()) => addCasePart(z.p, caseId, body, { idempotencyKey: k });
const pact = (z: Biz, partId: number, action: Record<string, unknown>, v: number, k = key()) => runPartAction(z.p, partId, { action, expectedVersion: v }, { idempotencyKey: k });
const partEvents = (partId: number) => n(`SELECT count(*)::int AS n FROM "ServicePartEvent" WHERE "partId" = $1`, partId);
const movements = (b: number) => n(`SELECT count(*)::int AS n FROM "InventoryMovement" WHERE "businessId" = $1`, b);
const itemRow = async (id: number) => JSON.stringify((await q(`SELECT "currentQuantity" q, "updatedAt" u FROM "InventoryItem" WHERE id = $1`, id))[0]);

async function main() {
  const A = await business("a"), B = await business("b");
  ok("setup: the parts routes are open in code (PARTS_API_OPEN = true — the unlock PR)", PARTS_API_OPEN === true);
  const itemBefore = await itemRow(A.item);
  const movBefore = await movements(A.b);

  console.log("A — add");
  const c1 = await openFIELD(A);
  const ka = key();
  const s1 = await add(A, c1.id, { source: "STOCK", inventoryItemId: A.item, name: "מסך 6.1", sku: "SCR-61", quantity: 1 }, ka);
  const e1 = (await q(`SELECT seq, kind::text k, "stateAfter"::text s, "idempotencyKey" ik FROM "ServicePartEvent" WHERE "partId" = $1`, s1.part.id))[0];
  ok("A1 a STOCK line → NEEDED v1 with its ADDED event (seq 1, the key); the unit taken from the item",
    s1.part.state === "NEEDED" && s1.part.version === 1 && s1.part.unitType === "UNIT" && s1.part.inventoryItemId === A.item
      && Number(e1.seq) === 1 && e1.k === "ADDED" && e1.s === "NEEDED" && e1.ik === ka && !s1.replayed);
  const r1 = await add(A, c1.id, { source: "STOCK", inventoryItemId: A.item, name: "מסך 6.1", sku: "SCR-61", quantity: 1 }, ka);
  ok("A2 the same key + same request → the stored line (replayed), one line, one event", r1.replayed && r1.part.id === s1.part.id
    && (await n(`SELECT count(*)::int AS n FROM "ServicePart" WHERE "caseId" = $1`, c1.id)) === 1 && (await partEvents(s1.part.id)) === 1);
  ok("A3 the same key + another request → IDEMPOTENCY_KEY_REUSED", (await code(() => add(A, c1.id, { source: "NON_STOCK", name: "אחר", quantity: 1 }, ka))) === "IDEMPOTENCY_KEY_REUSED");
  const ns = await add(A, c1.id, { source: "NON_STOCK", name: "בורג מיוחד", quantity: 2, customerUnitPriceAgorot: 1500 });
  ok("A4 a NON_STOCK line → NEEDED, no item, its price", ns.part.state === "NEEDED" && ns.part.inventoryItemId === null && ns.part.customerUnitPriceAgorot === 1500);
  ok("A5 an item of another business → refused (never revealed)", (await code(() => add(A, c1.id, { source: "STOCK", inventoryItemId: B.item, name: "x", quantity: 1 }))).startsWith("SERVER_CHECK_FAILED"));
  ok("A6 an inactive item → ITEM_INACTIVE; a unit mismatch → UNIT_MISMATCH; a fractional UNIT → QUANTITY_INVALID",
    (await code(() => add(A, c1.id, { source: "STOCK", inventoryItemId: A.off, name: "x", quantity: 1 }))).includes("ITEM_INACTIVE")
      && (await code(() => add(A, c1.id, { source: "STOCK", inventoryItemId: A.ml, name: "x", quantity: 1, unitType: "UNIT" }))).includes("UNIT_MISMATCH")
      && (await code(() => add(A, c1.id, { source: "STOCK", inventoryItemId: A.item, name: "x", quantity: 1.5 }))).includes("QUANTITY_INVALID"));
  ok("A7 a measured unit takes a fraction (ML 12.5)", (await add(A, c1.id, { source: "STOCK", inventoryItemId: A.ml, name: "גז", quantity: 12.5 })).part.quantity === 12.5);
  const cxCase = await openFIELD(A);
  await runCaseAction(A.p, cxCase.id, { action: { type: "CANCEL" }, expectedVersion: 1 }, { idempotencyKey: key() });
  ok("A8 a cancelled / finished case → refused (CASE_NOT_ACTIVE or CASE_CANCELLED)", /CASE_NOT_ACTIVE|CASE_CANCELLED/.test(await code(() => add(A, cxCase.id, { source: "NON_STOCK", name: "x", quantity: 1 }))));

  console.log("R — soft reservation");
  const rs = await pact(A, s1.part.id, { type: "RESERVE" }, 1);
  ok("R1 NEEDED → RESERVED v2 with a RESERVED event; the warning says the reservation is soft", rs.part.state === "RESERVED" && rs.part.version === 2 && rs.warnings.includes("RESERVATION_IS_SOFT"));
  const c2 = await openFIELD(A);
  const big = await add(A, c2.id, { source: "STOCK", inventoryItemId: A.item, name: "מסך 6.1", quantity: 3 });
  ok("R2 3 on hand, 1 reserved elsewhere → reserving 3 is refused PART_NOT_AVAILABLE", (await code(() => pact(A, big.part.id, { type: "RESERVE" }, 1))).includes("PART_NOT_AVAILABLE"));
  const two = await add(A, c2.id, { source: "STOCK", inventoryItemId: A.item, name: "מסך 6.1", quantity: 2 });
  ok("R3 … reserving the remaining 2 passes", (await pact(A, two.part.id, { type: "RESERVE" }, 1)).part.state === "RESERVED");
  ok("R4 a NON_STOCK line cannot be reserved (NOT_A_STOCK_PART)", (await code(() => pact(A, ns.part.id, { type: "RESERVE" }, 1))).includes("NOT_A_STOCK_PART"));
  const rl = await pact(A, s1.part.id, { type: "RELEASE" }, rs.part.version);
  ok("R5 release → NEEDED v3 (RELEASED)", rl.part.state === "NEEDED" && rl.part.version === 3);
  ok("R6 the inventory row is unchanged (quantity, updatedAt) and no InventoryMovement was written", (await itemRow(A.item)) === itemBefore && (await movements(A.b)) === movBefore);

  console.log("P — price");
  const pr = await pact(A, s1.part.id, { type: "SET_PRICE", customerUnitPriceAgorot: 45000 }, rl.part.version);
  const pe = (await q(`SELECT "amountAgorot" a, "previousAmountAgorot" p FROM "ServicePartEvent" WHERE "partId" = $1 ORDER BY seq DESC LIMIT 1`, s1.part.id))[0];
  ok("P1 price set → PRICE_SET with the amount and the previous (null) on the event", pr.part.customerUnitPriceAgorot === 45000 && Number(pe.a) === 45000 && pe.p === null);
  ok("P2 the same price → PRICE_UNCHANGED", (await code(() => pact(A, s1.part.id, { type: "SET_PRICE", customerUnitPriceAgorot: 45000 }, pr.part.version))).includes("PRICE_UNCHANGED"));
  const pc = await pact(A, s1.part.id, { type: "SET_PRICE", customerUnitPriceAgorot: null }, pr.part.version);
  ok("P3 the price can be cleared", pc.part.customerUnitPriceAgorot === null);

  console.log("C — cancel");
  const cx = await pact(A, two.part.id, { type: "CANCEL", reason: "הלקוח ויתר — רונית 052" }, 2);
  const ce = (await q(`SELECT reason r, payload::text p FROM "ServicePartEvent" WHERE "partId" = $1 ORDER BY seq DESC LIMIT 1`, two.part.id))[0];
  ok("C1 a RESERVED line → CANCELLED (closedAt set), the reason in its column only — never in the payload",
    cx.part.state === "CANCELLED" && cx.part.closedAt !== null && String(ce.r).includes("רונית") && !String(ce.p).includes("רונית") && cx.part.reason?.includes("רונית") === true);
  ok("C2 a cancelled line takes no further action (TRANSITION_NOT_ALLOWED / CASE rules)", (await code(() => pact(A, two.part.id, { type: "RESERVE" }, cx.part.version))).startsWith("REFUSED"));

  console.log("O — out of scope (no stock movement, no orders)");
  const before = await partEvents(s1.part.id);
  const oos = await Promise.all(["ISSUE", "RETURN", "MARK_ON_ORDER", "UPDATE_ORDER", "INSTALL", "WRITE_OFF", "SEND_WITH_EXTERNAL", "RESOLVE_FROM_EXTERNAL", "CORRECT_COST", "RECORD_QUOTED"]
    .map((type) => code(() => pact(A, s1.part.id, { type, quantity: 1, reason: "x", resolution: "INSTALLED", unitCostAgorot: 1, quoteVersion: 1 }, pc.part.version))));
  ok("O1 ISSUE, RETURN, orders, install, write-off, external, cost and quote → ACTION_NOT_IN_SCOPE, nothing written",
    oos.every((r) => r.startsWith("ACTION_NOT_IN_SCOPE")) && (await partEvents(s1.part.id)) === before && (await movements(A.b)) === movBefore, JSON.stringify(oos));

  console.log("G — database guards (runtime role)");
  const silent = await runtime.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(A.b));
    await tx.$executeRawUnsafe(`UPDATE "ServicePart" SET state = 'RESERVED', version = version + 1, "lastEventKind" = 'RESERVED' WHERE id = $1`, s1.part.id);
  }).then(() => "COMMITTED", (e) => String((e as Error).message));
  ok("G1 a part change without its event → rolled back", silent !== "COMMITTED" && (await q(`SELECT state::text s FROM "ServicePart" WHERE id = $1`, s1.part.id))[0].s === "NEEDED", silent.slice(0, 120));
  const del = await runtime.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(A.b));
    await tx.$executeRawUnsafe(`DELETE FROM "ServicePartEvent" WHERE "partId" = $1`, s1.part.id);
  }).then(() => "COMMITTED", (e) => String((e as Error).message));
  ok("G2 the part journal is append-only for the runtime role", del !== "COMMITTED" && (await partEvents(s1.part.id)) === before, del.slice(0, 120));

  console.log("I — isolation");
  ok("I1 another business cannot list A's parts, add to A's case or act on A's line (NOT_FOUND)",
    (await code(() => listParts(B.b, c1.id))) === "NOT_FOUND"
      && (await code(() => add(B, c1.id, { source: "NON_STOCK", name: "x", quantity: 1 }))) === "NOT_FOUND"
      && (await code(() => pact(B, s1.part.id, { type: "SET_PRICE", customerUnitPriceAgorot: 1 }, pc.part.version))) === "NOT_FOUND");
  const list = await listParts(A.b, c1.id);
  ok("I2 A's list: oldest first, each line with its journal", list.parts.length >= 3 && list.parts[0].id === s1.part.id && list.parts[0].events.length === pc.part.version);

  console.log("K — races");
  const lastItem = Number((await q(`INSERT INTO "InventoryItem" ("businessId", name, "unitType", "currentQuantity", "updatedAt") VALUES ($1, 'יחידה אחרונה', 'UNIT', 1, now()) RETURNING id`, A.b))[0].id);
  const k1 = await openFIELD(A), k2 = await openFIELD(A);
  const l1 = await add(A, k1.id, { source: "STOCK", inventoryItemId: lastItem, name: "יחידה", quantity: 1 });
  const l2 = await add(A, k2.id, { source: "STOCK", inventoryItemId: lastItem, name: "יחידה", quantity: 1 });
  const both = await Promise.all([code(() => pact(A, l1.part.id, { type: "RESERVE" }, 1)), code(() => pact(A, l2.part.id, { type: "RESERVE" }, 1))]);
  ok("K1 two reservations of the last unit at once (two cases) → exactly one RESERVED, the other PART_NOT_AVAILABLE",
    both.filter((r) => r === "OK").length === 1 && both.some((r) => r.includes("PART_NOT_AVAILABLE"))
      && (await n(`SELECT count(*)::int AS n FROM "ServicePart" WHERE "inventoryItemId" = $1 AND state = 'RESERVED'`, lastItem)) === 1, JSON.stringify(both));
  const k3 = await openFIELD(A);
  const kk = key();
  const five = await Promise.all(Array.from({ length: 5 }, () => add(A, k3.id, { source: "NON_STOCK", name: "שסתום", quantity: 1 }, kk).then((r) => r.part.id, (e) => `E:${(e as Error).message}`)));
  ok("K2 one add key five times at once → one line, every answer the same line", new Set(five).size === 1 && typeof five[0] === "number"
    && (await n(`SELECT count(*)::int AS n FROM "ServicePart" WHERE "caseId" = $1`, k3.id)) === 1, JSON.stringify(five));
  const k3p = five[0] as number;
  const twoActs = await Promise.all([code(() => pact(A, k3p, { type: "SET_PRICE", customerUnitPriceAgorot: 100 }, 1)), code(() => pact(A, k3p, { type: "CANCEL" }, 1))]);
  ok("K3 two actions at one version → one wins, the other VERSION_CONFLICT; the journal has 2 events", twoActs.filter((r) => r === "OK").length === 1 && twoActs.includes("VERSION_CONFLICT") && (await partEvents(k3p)) === 2, JSON.stringify(twoActs));
  ok("K4 still no InventoryMovement for the business after every race", (await movements(A.b)) === movBefore);

  console.log("L — closed to users (owner rule)");
  const setOverride = async (b: number, state: "ENABLED" | null) => {
    await x(`DELETE FROM "BusinessFeatureAccess" WHERE "businessId" = $1 AND "featureKey" = 'service_desk'`, b);
    if (state) await x(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", state, reason, "updatedAt") VALUES ($1, 'service_desk', 'ENABLED', 'sdparts lab', now())`, b);
  };
  const { signAuthToken } = await import("../lib/auth-token");
  const tokenA = signAuthToken(A.u);
  const routes = {
    caseParts: await import("../app/api/service-desk/cases/[id]/parts/route"),
    actions: await import("../app/api/service-desk/parts/[partId]/actions/route"),
  };
  const http = (method: string, body: unknown, token: string | null) => new Request("https://lab.test/api/service-desk/x", {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", "idempotency-key": key() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const snap = async () => JSON.stringify([await n(`SELECT count(*)::int AS n FROM "ServicePart" WHERE "businessId" = $1`, A.b), await n(`SELECT count(*)::int AS n FROM "ServicePartEvent" WHERE "businessId" = $1`, A.b)]);
  const calls = async (token: string | null) => [
    await routes.caseParts.GET(http("GET", undefined, token), { params: Promise.resolve({ id: String(c1.id) }) }),
    await routes.caseParts.POST(http("POST", { source: "NON_STOCK", name: "x", quantity: 1 }, token), { params: Promise.resolve({ id: String(c1.id) }) }),
    await routes.actions.POST(http("POST", { action: { type: "SET_PRICE", customerUnitPriceAgorot: 1 }, expectedVersion: pc.part.version }, token), { params: Promise.resolve({ partId: String(s1.part.id) }) }),
  ];
  await setOverride(A.b, "ENABLED"); // FULL for A (lab only)
  const beforeL = await snap();
  const full = await calls(tokenA);
  const bodies = await Promise.all(full.map((r) => r.json()));
  ok("L1 FULL access: the parts routes reach the service (no ACTION_NOT_IN_SCOPE lock answer)", bodies.every((b) => !(b?.error === "ACTION_NOT_IN_SCOPE" && b?.details?.capability === "parts")), JSON.stringify(full.map((r) => r.status)));
  {
    const [p0, e0] = JSON.parse(beforeL) as number[]; const [p1, e1] = JSON.parse(await snap()) as number[];
    ok("L2 … and every write through the open routes is journaled (a new part line comes with its event)", p1 - p0 <= e1 - e0 && e1 >= e0, `${beforeL} → ${p1},${e1}`);
  }
  ok("L3 no session → 401", (await calls(null)).every((r) => r.status === 401));
  await setOverride(A.b, null);
  ok("L4 module NONE (not launched) → 404 before the lock", (await calls(tokenA)).every((r) => r.status === 404));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) console.log("FAILED:\n  " + failures.join("\n  "));
}

main()
  .catch((e) => { failures.push(`crash: ${(e as Error).message}`); console.error(e); console.log(`\n${pass} passed, ${failures.length} failed`); })
  .finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); process.exit(failures.length ? 1 : 0); });
