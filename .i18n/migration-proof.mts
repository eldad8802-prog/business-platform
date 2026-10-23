/**
 * Proof of the PROPOSED locale/currency migration (docs/i18n-multicurrency/proposed-migration.sql)
 * on an EPHEMERAL PostgreSQL only. The workflow applies the SQL with psql after `prisma db push`
 * and after creating a NOLOGIN `app_runtime` role; this script then proves, as app_runtime (not the
 * superuser, so RLS really applies):
 *
 *   P1  additive: existing tables/rows untouched; no row exists ⇒ the app reads defaults
 *   P2  tenant isolation: A sees/writes only A; writing B's row under A's context is refused
 *   P3  CHECKs: unsupported locale / currency refused
 *   P4  base-currency lock: once locked, the runtime cannot change it
 *   P5  FxRate: runtime may read, may not insert/update/delete; append-only even for the owner
 *   P6  user preference rides the same tenant isolation
 *
 * `--rollback-check` mode (run after the rollback SQL) proves the three tables and two functions are gone.
 * Synthetic data only. Never run against anything but the CI service container.
 */
import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL ?? "";
if (!/@localhost:5432\//.test(url)) {
  console.error("ABORT: migration proof runs only against the local CI service container");
  process.exit(2);
}

const prisma = new PrismaClient();
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** Runs fn as app_runtime with the tenant context of `businessId`. Returns the error message on failure. */
async function asRuntime<T>(businessId: number | null, fn: (tx: PrismaClient) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    const value = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_runtime`);
      if (businessId !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${businessId}', true)`);
      return fn(tx as unknown as PrismaClient);
    });
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function rollbackCheck() {
  const rows = await prisma.$queryRawUnsafe<{ n: string }[]>(
    `SELECT relname AS n FROM pg_class WHERE relname IN ('BusinessLocaleSettings','UserLocalePreference','FxRate')`
  );
  ok("R1 — rollback removed the three tables", rows.length === 0, JSON.stringify(rows));
  const fns = await prisma.$queryRawUnsafe<{ n: string }[]>(
    `SELECT proname AS n FROM pg_proc WHERE proname IN ('business_locale_base_currency_guard','fx_rate_append_only_guard')`
  );
  ok("R2 — rollback removed the guard functions", fns.length === 0, JSON.stringify(fns));
  const biz = await prisma.business.count();
  ok("R3 — existing data intact after rollback", biz >= 2, String(biz));
}

async function main() {
  if (process.argv.includes("--rollback-check")) return rollbackCheck();

  const a = await prisma.business.create({ data: { name: `i18n-A-${uniq()}` } });
  const b = await prisma.business.create({ data: { name: `i18n-B-${uniq()}` } });
  const ua = await prisma.user.create({ data: { email: `i18n-a-${uniq()}@example.test`, password: "x", businessId: a.id, role: "USER" } });
  const ub = await prisma.user.create({ data: { email: `i18n-b-${uniq()}@example.test`, password: "x", businessId: b.id, role: "USER" } });

  console.log("\n== P1 — additive, defaults when absent ==");
  const before = await asRuntime(a.id, (tx) => tx.$queryRawUnsafe<unknown[]>(`SELECT * FROM "BusinessLocaleSettings"`));
  ok("P1 — a business with no row reads nothing (app falls back to he/IL/Asia/Jerusalem/ILS)", before.ok && before.value.length === 0, JSON.stringify(before));
  const cols = await prisma.$queryRawUnsafe<{ column_name: string; column_default: string | null }[]>(
    `SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'BusinessLocaleSettings'`
  );
  const def = (c: string) => cols.find((x) => x.column_name === c)?.column_default ?? "";
  ok("P1 — defaults are today's behaviour", def("locale").includes("'he'") && def("baseCurrency").includes("'ILS'") && def("timeZone").includes("Asia/Jerusalem") && def("region").includes("'IL'"), JSON.stringify(cols));
  const rls = await prisma.$queryRawUnsafe<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>(
    `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('BusinessLocaleSettings','UserLocalePreference')`
  );
  ok("P1 — RLS enabled AND forced on both tenant tables", rls.length === 2 && rls.every((r) => r.relrowsecurity && r.relforcerowsecurity), JSON.stringify(rls));

  console.log("\n== P2 — tenant isolation ==");
  const insA = await asRuntime(a.id, (tx) =>
    tx.$executeRawUnsafe(`INSERT INTO "BusinessLocaleSettings" ("businessId","locale","baseCurrency","updatedAt") VALUES (${a.id},'en','USD',now())`)
  );
  ok("P2 — A writes its own settings", insA.ok, JSON.stringify(insA));
  const insBunderA = await asRuntime(a.id, (tx) =>
    tx.$executeRawUnsafe(`INSERT INTO "BusinessLocaleSettings" ("businessId","updatedAt") VALUES (${b.id},now())`)
  );
  ok("P2 — A cannot write B's settings (RLS WITH CHECK)", !insBunderA.ok, JSON.stringify(insBunderA));
  const insB = await asRuntime(b.id, (tx) =>
    tx.$executeRawUnsafe(`INSERT INTO "BusinessLocaleSettings" ("businessId","locale","baseCurrency","updatedAt") VALUES (${b.id},'he','ILS',now())`)
  );
  ok("P2 — B writes its own settings", insB.ok, JSON.stringify(insB));
  const seenByA = await asRuntime(a.id, (tx) => tx.$queryRawUnsafe<{ businessId: number }[]>(`SELECT "businessId" FROM "BusinessLocaleSettings"`));
  ok("P2 — A sees only A", seenByA.ok && seenByA.value.length === 1 && seenByA.value[0].businessId === a.id, JSON.stringify(seenByA));
  const updBfromA = await asRuntime(a.id, (tx) =>
    tx.$executeRawUnsafe(`UPDATE "BusinessLocaleSettings" SET "locale"='en' WHERE "businessId"=${b.id}`)
  );
  ok("P2 — A's UPDATE of B touches 0 rows", updBfromA.ok && updBfromA.value === 0, JSON.stringify(updBfromA));
  const noCtx = await asRuntime(null, (tx) => tx.$queryRawUnsafe<unknown[]>(`SELECT * FROM "BusinessLocaleSettings"`));
  ok("P2 — without tenant context nothing is visible", noCtx.ok && noCtx.value.length === 0, JSON.stringify(noCtx));
  const del = await asRuntime(a.id, (tx) => tx.$executeRawUnsafe(`DELETE FROM "BusinessLocaleSettings" WHERE "businessId"=${a.id}`));
  ok("P2 — runtime has no DELETE", !del.ok, JSON.stringify(del));

  console.log("\n== P3 — CHECKs ==");
  const badLocale = await asRuntime(a.id, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessLocaleSettings" SET "locale"='fr' WHERE "businessId"=${a.id}`));
  ok("P3 — unsupported locale refused", !badLocale.ok, JSON.stringify(badLocale));
  const badCur = await asRuntime(a.id, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessLocaleSettings" SET "displayCurrency"='GBP' WHERE "businessId"=${a.id}`));
  ok("P3 — unsupported currency refused", !badCur.ok, JSON.stringify(badCur));
  const goodDisplay = await asRuntime(a.id, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessLocaleSettings" SET "displayCurrency"='EUR' WHERE "businessId"=${a.id}`));
  ok("P3 — display currency EUR accepted", goodDisplay.ok, JSON.stringify(goodDisplay));

  console.log("\n== P4 — base currency lock ==");
  const lock = await asRuntime(a.id, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessLocaleSettings" SET "baseCurrencyLockedAt"=now() WHERE "businessId"=${a.id}`));
  ok("P4 — first financial record locks the base currency", lock.ok, JSON.stringify(lock));
  const change = await asRuntime(a.id, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessLocaleSettings" SET "baseCurrency"='EUR' WHERE "businessId"=${a.id}`));
  ok("P4 — a locked base currency cannot be changed", !change.ok && /BASE_CURRENCY_LOCKED/.test(change.error), JSON.stringify(change));
  const unlock = await asRuntime(a.id, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessLocaleSettings" SET "baseCurrencyLockedAt"=NULL WHERE "businessId"=${a.id}`));
  ok("P4 — the lock cannot be removed by the runtime", !unlock.ok, JSON.stringify(unlock));
  const otherCols = await asRuntime(a.id, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessLocaleSettings" SET "locale"='he' WHERE "businessId"=${a.id}`));
  ok("P4 — other settings remain editable while locked", otherCols.ok, JSON.stringify(otherCols));

  console.log("\n== P5 — FxRate reference data ==");
  await prisma.$executeRawUnsafe(
    `INSERT INTO "FxRate" ("base","quote","rate","kind","source","rateDate","verification") VALUES ('USD','ILS',3.7250,'REPRESENTATIVE','BANK_OF_ISRAEL','2026-10-20','VERIFIED')`
  );
  const read = await asRuntime(a.id, (tx) => tx.$queryRawUnsafe<{ rate: string }[]>(`SELECT "rate"::text AS rate FROM "FxRate"`));
  ok("P5 — runtime reads rates (exact numeric)", read.ok && read.value[0]?.rate === "3.7250000000", JSON.stringify(read));
  const rtInsert = await asRuntime(a.id, (tx) =>
    tx.$executeRawUnsafe(`INSERT INTO "FxRate" ("base","quote","rate","kind","source","rateDate") VALUES ('EUR','ILS',4,'DISPLAY','MANUAL','2026-10-20')`)
  );
  ok("P5 — runtime cannot insert rates", !rtInsert.ok, JSON.stringify(rtInsert));
  const rtUpdate = await asRuntime(a.id, (tx) => tx.$executeRawUnsafe(`UPDATE "FxRate" SET "rate"=1`));
  ok("P5 — runtime cannot update rates", !rtUpdate.ok, JSON.stringify(rtUpdate));
  let ownerUpdate = "allowed";
  try { await prisma.$executeRawUnsafe(`UPDATE "FxRate" SET "rate"=1`); } catch (e) { ownerUpdate = String(e); }
  ok("P5 — rates are append-only even for the owner", /FX_RATE_APPEND_ONLY/.test(ownerUpdate), ownerUpdate.slice(0, 200));
  let badRate = "allowed";
  try { await prisma.$executeRawUnsafe(`INSERT INTO "FxRate" ("base","quote","rate","kind","source","rateDate") VALUES ('USD','ILS',0,'REPRESENTATIVE','BANK_OF_ISRAEL','2026-10-21')`); } catch (e) { badRate = String(e); }
  ok("P5 — zero rate refused", badRate !== "allowed");
  let samePair = "allowed";
  try { await prisma.$executeRawUnsafe(`INSERT INTO "FxRate" ("base","quote","rate","kind","source","rateDate") VALUES ('ILS','ILS',1,'REPRESENTATIVE','BANK_OF_ISRAEL','2026-10-21')`); } catch (e) { samePair = String(e); }
  ok("P5 — ILS→ILS refused", samePair !== "allowed");

  console.log("\n== P6 — user preference isolation ==");
  const prefA = await asRuntime(a.id, (tx) =>
    tx.$executeRawUnsafe(`INSERT INTO "UserLocalePreference" ("businessId","userId","locale","updatedAt") VALUES (${a.id},${ua.id},'en',now())`)
  );
  ok("P6 — A's user stores a preference", prefA.ok, JSON.stringify(prefA));
  const prefBunderA = await asRuntime(a.id, (tx) =>
    tx.$executeRawUnsafe(`INSERT INTO "UserLocalePreference" ("businessId","userId","locale","updatedAt") VALUES (${b.id},${ub.id},'en',now())`)
  );
  ok("P6 — A cannot store B's user preference", !prefBunderA.ok, JSON.stringify(prefBunderA));
  const prefSeenByB = await asRuntime(b.id, (tx) => tx.$queryRawUnsafe<unknown[]>(`SELECT * FROM "UserLocalePreference"`));
  ok("P6 — B sees no preference of A", prefSeenByB.ok && prefSeenByB.value.length === 0, JSON.stringify(prefSeenByB));

  const untouched = await prisma.business.findUnique({ where: { id: a.id } });
  ok("P1 — Business row untouched by the settings writes", untouched?.name === a.name);
}

main()
  .catch((e) => { failures.push(`crash: ${e instanceof Error ? e.message : String(e)}`); console.error(e); })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(`\nmigration proof: ${pass} passed, ${failures.length} failed`);
    if (failures.length) { console.log(failures.map((f) => ` - ${f}`).join("\n")); process.exit(1); }
  });
