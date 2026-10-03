/**
 * #584 run 37153235048 — READ-ONLY diagnostic of two observations in business 9. SCRIPT-ONLY.
 *
 *   OWNER_DATABASE_URL=… node_modules/.bin/tsx scripts/ops/derive-proof-diagnostic.ts \
 *     --allow-host ep-flat-brook-am4bhq1y --run-id a4496e59-1696-472b-8807-bb35508d4192 --business 9
 *
 * The window is the business's KnowledgeDerivationRun itself (startedAt → finishedAt), widened by a
 * small margin, so nothing is assumed about who wrote what.
 *
 *   PARTY      every Party of the business created/updated in the window, with every
 *              PartyResolutionClaim pointing at it: source, status, signal type, created time. The M5
 *              identity step (called by derive) creates a Party and claims with source
 *              "m5-entity-identity"; intake/backfill use other sources. Ids, codes and times only.
 *   ACTION     every OutcomeActionEvent of the business observed/created in the window: businessId,
 *              domainStore, domainRecordId, eventType, occurredAt, observedAt, and whether the source
 *              record exists in that store and belongs to the same business.
 *
 * One owner session, READ ONLY by Postgres (verified before and after). No name, content or amount.
 * Exit: 0 printed · 1 failed · 3 REFUSED · 2 usage.
 */
import { PrismaClient } from "@prisma/client";
import { assertSafeUrl, enforceReadOnly, RefusedError, verifyReadOnly } from "./runtime-rls-evidence";

const ACTION_SOURCE_STORES = ["ReviewEvent", "PaymentAllocation", "Document", "Installment"];
const MARGIN_SECONDS = 60;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const allowHost = arg("--allow-host") ?? null;
  const runId = arg("--run-id") ?? "";
  const businessId = Number(arg("--business"));
  if (!/^[0-9a-f-]{36}$/.test(runId) || !Number.isInteger(businessId) || businessId <= 0) {
    console.error("usage: --allow-host <host> --run-id <uuid> --business <id>");
    process.exit(2);
  }
  let db: PrismaClient | undefined;
  try {
    db = new PrismaClient({ datasourceUrl: assertSafeUrl("OWNER_DATABASE_URL", process.env.OWNER_DATABASE_URL, allowHost) });
    await enforceReadOnly(db, "owner");

    const [run] = await db.$queryRawUnsafe<{ b: number; started: Date; finished: Date | null; status: string }[]>(
      `SELECT "businessId" AS b, "startedAt" AS started, "finishedAt" AS finished, status FROM "KnowledgeDerivationRun" WHERE "runId" = $1`, runId);
    if (!run || Number(run.b) !== businessId || !run.finished) throw new RefusedError("the run is missing, belongs to another business, or did not finish");
    const startedAt: Date = run.started;
    const finishedAt: Date = run.finished;
    const from = new Date(startedAt.getTime() - MARGIN_SECONDS * 1000);
    const to = new Date(finishedAt.getTime() + MARGIN_SECONDS * 1000);

    // PARTY
    const parties = await db.$queryRawUnsafe<{ id: number; createdAt: Date; updatedAt: Date }[]>(
      `SELECT id, "createdAt", "updatedAt" FROM "Party"
        WHERE "businessId" = $1 AND ("createdAt" BETWEEN $2 AND $3 OR "updatedAt" BETWEEN $2 AND $3) ORDER BY id`, businessId, from, to);
    const partyDetail = [];
    for (const p of parties) {
      const claims = await db.$queryRawUnsafe<{ id: number; source: string; status: string; signal: string | null; createdAt: Date; b: number }[]>(
        `SELECT id, source, status::text AS status, "signalType"::text AS signal, "createdAt", "businessId" AS b
           FROM "PartyResolutionClaim" WHERE "partyId" = $1 ORDER BY id`, p.id);
      partyDetail.push({
        partyId: p.id, createdAt: p.createdAt, updatedAt: p.updatedAt,
        createdInRunWindow: p.createdAt >= startedAt && p.createdAt <= finishedAt,
        claims: claims.map((c) => ({ claimId: c.id, source: c.source, status: c.status, signalType: c.signal, createdAt: c.createdAt,
          sameBusiness: Number(c.b) === businessId, createdInRunWindow: c.createdAt >= startedAt && c.createdAt <= finishedAt })),
      });
    }
    // Every claim source the business has ever used, for context (codes only).
    const sources = await db.$queryRawUnsafe<{ source: string; n: number }[]>(
      `SELECT source, count(*)::int AS n FROM "PartyResolutionClaim" WHERE "businessId" = $1 GROUP BY 1 ORDER BY 1`, businessId);

    // ACTION
    const actions = await db.$queryRawUnsafe<{ id: number; b: number; store: string; rec: number; type: string; kind: string; occurredAt: Date; observedAt: Date; createdAt: Date; decisionId: number | null }[]>(
      `SELECT id, "businessId" AS b, "domainStore" AS store, "domainRecordId" AS rec, "eventType" AS type, "actionKind" AS kind,
              "occurredAt", "observedAt", "createdAt", "decisionId"
         FROM "OutcomeActionEvent" WHERE "businessId" = $1 AND ("createdAt" BETWEEN $2 AND $3 OR "observedAt" BETWEEN $2 AND $3) ORDER BY id`,
      businessId, from, to);
    const actionDetail = [];
    for (const a of actions) {
      let sourceBusinessId: number | null = null;
      if (ACTION_SOURCE_STORES.includes(a.store)) {
        const [s] = await db.$queryRawUnsafe<{ b: number }[]>(`SELECT "businessId" AS b FROM "${a.store}" WHERE id = $1`, a.rec);
        sourceBusinessId = s ? Number(s.b) : null;
      }
      actionDetail.push({
        businessId: Number(a.b), domainStore: a.store, domainRecordId: a.rec, eventType: a.type, actionKind: a.kind,
        occurredAt: a.occurredAt, observedAt: a.observedAt, createdAt: a.createdAt, decisionId: a.decisionId,
        sourceRecordExists: sourceBusinessId !== null, sourceBelongsToBusiness: sourceBusinessId === businessId,
        observedAtEqualsDerivationInstantWindow: a.observedAt >= startedAt && a.observedAt <= finishedAt,
      });
    }

    await verifyReadOnly(db, "owner");
    console.log(JSON.stringify({ businessId, run: { runId, status: run.status, startedAt, finishedAt }, window: { from, to },
      party: { rows: partyDetail, claimSourcesOfBusiness: sources }, actions: actionDetail }, null, 1));
  } catch (e) {
    if (e instanceof RefusedError) { console.error(`REFUSED: ${e.message}`); process.exitCode = 3; }
    else { console.error(`FAILED: ${e instanceof Error ? e.name : "unknown"} ${(e as { code?: string })?.code ?? ""}`); process.exitCode = 1; }
  } finally {
    await db?.$disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/ops/derive-proof-diagnostic.ts")) void main();
