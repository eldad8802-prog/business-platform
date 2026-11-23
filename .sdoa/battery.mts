/**
 * Service Desk — open for every business (migration 20261221190000_service_desk_open_all + the catalog default in code).
 *   before  the migration NOT applied: the pilot (ENABLED override) is FULL, every other business is NONE.
 *   after   the migration applied. The expectations follow the catalog default in code:
 *             catalog OFF (the migration-only PR): nothing new opens — the pilot FULL, every other business NONE;
 *             catalog ON  (the application PR):    every business FULL with no setup row (an existing one, one created
 *                                                  after the opening), a DISABLED override still closes, the emergency
 *                                                  switch closes everyone; a business opens and reads its own cases only
 *                                                  (services + RLS as the runtime role + the HTTP edge); the pilot's
 *                                                  cases are kept; 20261222090000 is not needed.
 * Synthetic only. env: OWNER_URL (lab_owner), DIRECT_URL / DATABASE_URL (app_runtime_prod), AUTH_TOKEN_SECRET, TASK_REQUEST_HMAC_KEY.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const MODE = process.argv[2] === "after" ? "after" : "before";
const STATE = "/tmp/sdoa-state.json";
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL! });
type Rows = Record<string, unknown>[];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const x = (sql: string, ...a: unknown[]) => owner.$executeRawUnsafe(sql, ...a);
async function asOwner(b: number, sql: string, ...a: unknown[]): Promise<Rows> {
  return owner.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b)); return (await tx.$queryRawUnsafe(sql, ...a)) as Rows; });
}
async function asRuntime(b: number, sql: string, ...a: unknown[]): Promise<Rows> {
  return runtime.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b)); return (await tx.$queryRawUnsafe(sql, ...a)) as Rows; });
}
let pass = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail = "") => { if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); } };
async function attempt(f: () => Promise<unknown>): Promise<string> {
  try { await f(); return "OK"; } catch (e) { return String((e as { code?: string }).code ?? (e as Error).message).slice(0, 200); }
}

type Biz = { b: number; u: number; cust: number };

async function main() {
  const { resolveServiceDeskMode } = await import("@/lib/services/service-desk/service-desk-gate");
  const { serviceDeskRoute } = await import("@/lib/services/service-desk/service-desk-http");
  const { openCase, getCase, listCases } = await import("@/lib/services/service-desk/service-case.service");
  const { getPlatformFeatureCatalogEntry, PLATFORM_FEATURE_KEYS } = await import("@/lib/services/feature-access/platform-feature-catalog");
  const { uuidV7 } = await import("@/lib/services/tasks/task-idempotency");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const t = Date.now();

  const newBiz = async (tag: string): Promise<Biz> => {
    const b = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sdoa-${tag}-${t}`))[0].id);
    const u = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdoa-${tag}-${t}@lab.invalid`, b))[0].id);
    const cust = Number((await asOwner(b, `INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, b))[0].id);
    return { b, u, cust };
  };
  const override = (z: Biz, state: "ENABLED" | "DISABLED") =>
    asOwner(z.b, `INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", state, reason, "updatedAt") VALUES ($1, 'service_desk', $2::"BusinessFeatureAccessState", 'lab', now()) RETURNING id`, z.b, state);
  const open = (z: Biz, problem: string) => runWithTenantContext({ businessId: z.b }, async () =>
    (await openCase({ businessId: z.b, userId: z.u } as never, { kind: "IN_SHOP", customerId: z.cust, problemDescription: problem } as never, { idempotencyKey: uuidV7(new Date()) })).case.id);
  const mode = (z: Biz) => resolveServiceDeskMode(z.b);
  const overrides = async () => Number((await q(`SELECT count(*)::int n FROM "BusinessFeatureAccess" WHERE "featureKey" = 'service_desk'`))[0].n);
  const policy = async () => (await q(`SELECT "globalEnabled" g, "emergencyDisabled" e FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'service_desk'`))[0];
  const definitionOn = async () => (await q(`SELECT "defaultEnabled" d FROM "PlatformFeatureDefinition" WHERE key = 'service_desk'`))[0].d === true;
  const recordsApplied = async () => (await q(`SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCaseEvent_case_records_in_place') ok`))[0].ok === true;

  if (MODE === "before") {
    const P = await newBiz("pilot"); await override(P, "ENABLED");
    const A = await newBiz("existing");
    const D = await newBiz("disabled"); await override(D, "DISABLED");
    const pilotCase = await open(P, "תיק פיילוט");
    const pol = await policy();
    ok("B0 the lab is at the Production state: policy global OFF, emergency OFF, definition default OFF", pol.g === false && pol.e === false && !(await definitionOn()), JSON.stringify(pol));
    ok("B1 the pilot (ENABLED override) is FULL", (await mode(P)) === "FULL");
    ok("B2 an existing business without an override is NONE", (await mode(A)) === "NONE");
    ok("B3 a DISABLED business is NONE", (await mode(D)) === "NONE");
    const edge = await serviceDeskRoute(new Request("https://lab.invalid/api/service-desk/cases"), "read", async () => new Response("reached"), { user: async () => ({ id: A.u, businessId: A.b }) });
    ok("B5 the HTTP edge answers 404 to the existing business (module invisible)", edge.status === 404, String(edge.status));
    writeFileSync(STATE, JSON.stringify({ P, A, D, pilotCase }));
  } else {
    const { P, A, D, pilotCase } = JSON.parse(readFileSync(STATE, "utf8")) as { P: Biz; A: Biz; D: Biz; pilotCase: number };
    const catalogOn = getPlatformFeatureCatalogEntry(PLATFORM_FEATURE_KEYS.SERVICE_DESK).defaultEnabled === true;
    console.log(`  catalog default in code: ${catalogOn ? "ON (application PR)" : "OFF (migration-only PR)"}`);
    const pol = await policy();
    ok("M1 the migration set exactly: policy global ON, emergency untouched (OFF), definition default ON", pol.g === true && pol.e === false && (await definitionOn()), JSON.stringify(pol));
    ok("M2 no override row was written or removed (pilot ENABLED + D DISABLED only)", (await overrides()) === 2);
    ok("M3 20261222090000 (case records) is NOT applied — the opening does not need it", !(await recordsApplied()));
    ok("M4 the pilot stays FULL and keeps its case", (await mode(P)) === "FULL"
      && (await runWithTenantContext({ businessId: P.b }, () => getCase(P.b, pilotCase))).id === pilotCase);
    ok("M5 a DISABLED business stays closed", (await mode(D)) === "NONE");

    if (!catalogOn) {
      ok("M6 migration alone (catalog OFF in code): an existing business stays NONE", (await mode(A)) === "NONE");
      const N = await newBiz("new-db");
      ok("M7 migration alone: a new business stays NONE", (await mode(N)) === "NONE");
    } else {
      ok("O1 an existing business without any setup is FULL", (await mode(A)) === "FULL");
      const before = await overrides();
      const N = await newBiz("new");
      ok("O2 a business created after the opening is FULL with no admin step and no override row", (await mode(N)) === "FULL" && (await overrides()) === before);
      const aCase = await open(A, "תיק של עסק קיים");
      const nCase = await open(N, "תיק של עסק חדש");
      ok("O3 the existing business opens its own case", aCase > 0 && (await runWithTenantContext({ businessId: A.b }, () => getCase(A.b, aCase))).id === aCase);
      ok("O4 the new business opens its own case", nCase > 0);
      const cross = await attempt(() => runWithTenantContext({ businessId: N.b }, () => getCase(N.b, aCase)));
      ok("O5 a business cannot read another business's case through the service (NOT_FOUND)", cross === "NOT_FOUND", cross);
      const pilotFromA = await attempt(() => runWithTenantContext({ businessId: A.b }, () => getCase(A.b, pilotCase)));
      ok("O6 the pilot's case is invisible to the existing business", pilotFromA === "NOT_FOUND", pilotFromA);
      const listN = await runWithTenantContext({ businessId: N.b }, () => listCases(N.b));
      ok("O7 a list shows only the business's own cases", listN.cases.length === 1 && listN.cases.every((c) => c.id === nCase), JSON.stringify(listN.cases.map((c) => c.id)));
      const rls = Number((await asRuntime(N.b, `SELECT count(*)::int n FROM "ServiceCase" WHERE id = ANY($1::int[])`, [aCase, pilotCase]))[0].n);
      const own = Number((await asRuntime(N.b, `SELECT count(*)::int n FROM "ServiceCase" WHERE id = $1`, nCase))[0].n);
      ok("O8 RLS as the runtime role: another business's cases are not even visible (0), its own is (1)", rls === 0 && own === 1, `${rls}/${own}`);
      const wr = await attempt(() => asRuntime(N.b, `UPDATE "ServiceCase" SET "problemDescription" = 'x' WHERE id = $1 RETURNING id`, aCase).then((r) => { if (r.length) throw new Error("WROTE"); }));
      ok("O9 RLS as the runtime role: a write aimed at another business's case touches nothing", wr === "OK", wr);
      const edgeA = await serviceDeskRoute(new Request("https://lab.invalid/api/service-desk/cases"), "write", async (ctx) => new Response(String(ctx.principal.businessId)), { user: async () => ({ id: A.u, businessId: A.b }) });
      ok("O10 the HTTP edge: the existing business reaches the module, as itself (business from the session)", edgeA.status === 200 && (await edgeA.text()) === String(A.b));
      const edgeD = await serviceDeskRoute(new Request("https://lab.invalid/api/service-desk/cases"), "read", async () => new Response("reached"), { user: async () => ({ id: D.u, businessId: D.b }) });
      ok("O11 the HTTP edge: a DISABLED business with no case gets 404", edgeD.status === 404, String(edgeD.status));
      const edgeAnon = await serviceDeskRoute(new Request("https://lab.invalid/api/service-desk/cases"), "read", async () => new Response("reached"), { user: async () => null });
      ok("O12 the HTTP edge: no session → 401, the server decides (not the screen)", edgeAnon.status === 401, String(edgeAnon.status));
      await x(`UPDATE "PlatformFeaturePolicy" SET "emergencyDisabled" = true, "updatedAt" = now() WHERE "featureKey" = 'service_desk'`);
      const emergency = [await mode(A), await mode(N), await mode(P)];
      await x(`UPDATE "PlatformFeaturePolicy" SET "emergencyDisabled" = false, "updatedAt" = now() WHERE "featureKey" = 'service_desk'`);
      ok("O13 the emergency switch still closes every business, the pilot included", emergency.every((m) => m === "NONE"), emergency.join(","));
      ok("O14 after the emergency switch is cleared, every business is FULL again", (await mode(A)) === "FULL" && (await mode(N)) === "FULL");
      await x(`UPDATE "PlatformFeaturePolicy" SET "globalEnabled" = false, "updatedAt" = now() WHERE "featureKey" = 'service_desk'`);
      const globalOff = [await mode(A), await mode(N), await mode(P)];
      await x(`UPDATE "PlatformFeaturePolicy" SET "globalEnabled" = true, "updatedAt" = now() WHERE "featureKey" = 'service_desk'`);
      ok("O15 the global switch can still close the module for all (the pilot keeps its override)", globalOff[0] === "NONE" && globalOff[1] === "NONE" && globalOff[2] === "FULL", globalOff.join(","));
    }
  }

  console.log(`${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
