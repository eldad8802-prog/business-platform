/**
 * Service Desk A7 — migration 20261214090000_service_desk_case_fields on the M1 lab: permissions, guards, erasure and
 * the task link, as the runtime role where the application acts and as the table owner where the guard is the point.
 * Synthetic only. env: OWNER_URL (lab_owner), DIRECT_URL (app_runtime_prod), DATABASE_URL, AUTH_TOKEN_SECRET.
 */
import { PrismaClient } from "@prisma/client";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL! });
let pass = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail = "") => { if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); } };
type Rows = Record<string, unknown>[];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
async function asOwner(b: number, sql: string, ...a: unknown[]): Promise<Rows> {
  return owner.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b)); return (await tx.$queryRawUnsafe(sql, ...a)) as Rows; });
}
async function asRuntime(b: number, sql: string, ...a: unknown[]): Promise<Rows> {
  return runtime.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b)); return (await tx.$queryRawUnsafe(sql, ...a)) as Rows; });
}
async function attempt(f: () => Promise<unknown>): Promise<string> {
  try { await f(); return "OK"; } catch (e) { return (e as Error).message.replace(/\s+/g, " ").slice(-260); }
}

async function main() {
  const { openCase } = await import("@/lib/services/service-desk/service-case.service");
  const { uuidV7 } = await import("@/lib/services/tasks/task-idempotency");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const t = Date.now();
  const biz = async (tag: string) => {
    const b = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sda7-${tag}-${t}`))[0].id);
    const u = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sda7-${tag}-${t}@lab.invalid`, b))[0].id);
    const cust = Number((await asOwner(b, `INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, b))[0].id);
    const c = await runWithTenantContext({ businessId: b }, async () =>
      (await openCase({ businessId: b, userId: u } as never, { customerId: cust, problemDescription: "בדיקה", track: "T1", subject: { displayName: "מכשיר" } } as never, { idempotencyKey: uuidV7(new Date()) })).case.id);
    return { b, u, c };
  };
  const A = await biz("A");
  const B = await biz("B");

  // ── the light case fields ──
  const chk = (await q(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'ServiceCase_item_location_note'`))[0]?.d as string | undefined;
  ok("F2 the item-location CHECK refuses blank and over 120 characters", !!chk && chk.includes("120") && chk.includes("btrim"), chk);
  ok("F3 estimatedReadyOn is a nullable DATE", Number((await q(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name = 'ServiceCase' AND column_name = 'estimatedReadyOn' AND data_type = 'date' AND is_nullable = 'YES'`))[0].n) === 1);

  // ── loans, as the runtime role ──
  const lend = (z: { b: number; c: number }, b = z.b) => asRuntime(z.b, `INSERT INTO "ServiceCaseLoaner" ("businessId", "caseId", "itemName", note) VALUES ($1, $2, 'טלפון חלופי', 'בקופסה') RETURNING id`, b, z.c);
  const r1 = await attempt(() => lend(A));
  ok("L1 the runtime lends a replacement item on its own case", r1 === "OK", r1);
  const loanId = Number((await asRuntime(A.b, `SELECT id FROM "ServiceCaseLoaner" WHERE "caseId" = $1`, A.c))[0]?.id);
  ok("L2 another business cannot write a loan under this tenant (RLS)", (await attempt(() => lend(A, B.b))) !== "OK");
  ok("L3 another business sees no loan of A (RLS)", (await asRuntime(B.b, `SELECT count(*)::int n FROM "ServiceCaseLoaner"`))[0].n === 0);
  ok("L4 a loan to a case of another business is refused (composite key)", (await attempt(() => asRuntime(A.b, `INSERT INTO "ServiceCaseLoaner" ("businessId", "caseId", "itemName") VALUES ($1, $2, 'x') RETURNING id`, A.b, B.c))) !== "OK");
  ok("L5 returning a loan is allowed", (await attempt(() => asRuntime(A.b, `UPDATE "ServiceCaseLoaner" SET "returnedAt" = now() WHERE id = $1 RETURNING id`, loanId))) === "OK");
  ok("L6 the lend time never changes", (await attempt(() => asRuntime(A.b, `UPDATE "ServiceCaseLoaner" SET "lentAt" = now() - interval '1 day' WHERE id = $1 RETURNING id`, loanId))).includes("SERVICE_LOANER_FIXED"));
  ok("L7 the runtime cannot delete a loan (no privilege)", (await attempt(() => asRuntime(A.b, `DELETE FROM "ServiceCaseLoaner" WHERE id = $1 RETURNING id`, loanId))) !== "OK");
  ok("L8 even the owner cannot delete a loan directly (guard)", (await attempt(() => asOwner(A.b, `DELETE FROM "ServiceCaseLoaner" WHERE id = $1 RETURNING id`, loanId))).includes("SERVICE_LOANER_KEPT"));
  ok("L9 a loan is never born erased", (await attempt(() => asRuntime(A.b, `INSERT INTO "ServiceCaseLoaner" ("businessId", "caseId", "itemName", "erasedAt") VALUES ($1, $2, 'x', now()) RETURNING id`, A.b, A.c))).includes("SERVICE_LOANER_ERASED_ON_WRITE"));
  ok("L10 no trigger blocks a handover: the guard is on the loan table only", Number((await q(`SELECT count(*)::int n FROM pg_trigger WHERE tgname ILIKE '%loaner%' AND tgrelid <> '"ServiceCaseLoaner"'::regclass`))[0].n) === 0);

  // ── erasure ──
  ok("E1 the erasure is refused while the business is not being deleted", (await attempt(() => asRuntime(A.b, `SELECT public.service_case_loaner_erase_business() n`))).includes("SERVICE_LOANER_ERASURE_NOT_DELETING"));
  await q(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1 RETURNING id`, A.b);
  ok("E2 a business being deleted cannot lend any more", (await attempt(() => lend(A))).includes("SERVICE_UI_BUSINESS_DELETING"));
  const er = await attempt(() => asRuntime(A.b, `SELECT public.service_case_loaner_erase_business() n`));
  const after = (await asOwner(A.b, `SELECT "itemName" i, note, "erasedAt" IS NOT NULL e FROM "ServiceCaseLoaner" WHERE id = $1`, loanId))[0];
  ok("E3 the erasure blanks the loan's texts and keeps the dates", er === "OK" && after.i === "נמחק" && after.note === null && after.e === true, `${er} ${JSON.stringify(after)}`);
  ok("E4 an erased loan is not changed again", (await attempt(() => asOwner(A.b, `UPDATE "ServiceCaseLoaner" SET note = 'x' WHERE id = $1 RETURNING id`, loanId))).includes("SERVICE_LOANER_ERASED"));

  // ── task link ──
  const task = Number((await asOwner(B.b, `INSERT INTO "Task" ("businessId", title, "updatedAt") VALUES ($1, 'להתקשר ללקוח', now()) RETURNING id`, B.b))[0].id);
  ok("T1 a task links to a case of its own business", (await attempt(() => asOwner(B.b, `UPDATE "Task" SET "serviceCaseId" = $1 WHERE id = $2 RETURNING id`, B.c, task))) === "OK");
  ok("T2 a task cannot link to a case of another business", (await attempt(() => asOwner(B.b, `UPDATE "Task" SET "serviceCaseId" = $1 WHERE id = $2 RETURNING id`, A.c, task))) !== "OK");
  const fk = (await q(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'Task_service_case_fkey'`))[0]?.d as string | undefined;
  ok("T3 removing a case clears only the link (ON DELETE SET NULL of serviceCaseId)", !!fk && /ON DELETE SET NULL \("serviceCaseId"\)/.test(fk), fk);

  console.log(`${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
