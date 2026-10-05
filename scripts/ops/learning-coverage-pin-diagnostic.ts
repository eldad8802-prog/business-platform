/**
 * All-Feature Learning Coverage — READ-ONLY diagnosis of the "existing learning pinned" failures of the
 * final proof (run 37253581837: one row in B3, one in B9). SCRIPT-ONLY. Changes nothing.
 *
 *   OWNER_DATABASE_URL=… node_modules/.bin/tsx scripts/ops/learning-coverage-pin-diagnostic.ts \
 *     --allow-host ep-flat-brook-am4bhq1y --businesses 3,9
 *
 * Selects EXACTLY the rows that check flagged: a KnowledgeMeasure of a pre-coverage rule whose policy
 * lineage KEY differs from the key that rule uses in today's catalogue. For each, it proves from the
 * data — not from an assumption about which rule it is:
 *   status                     the row's own status
 *   actual / expected lineage  policy key + version on the row vs the current rule's (registry)
 *   createdBeforeLineage       row.materializedAt < creation time of the expected lineage's version
 *   currentSlotRow             a row for the same business / measure key / subject under the expected
 *                              lineage, and its status (the reconciler writes the new version to a new slot)
 *   consumable                 only ACTIVE is consumed by composers / snapshot
 *   classification             LEGITIMATE_HISTORY  status SUPERSEDED or STALE (out of circulation by design) AND
 *                                                  corroborated: created before the expected lineage existed,
 *                                                  or a row under the expected lineage exists for the same slot
 *                              HISTORICAL_STATUS_UNEXPLAINED  out of circulation, but neither corroboration holds
 *                              LIVE_WRONG_PIN      status ACTIVE or INSUFFICIENT_EVIDENCE under a lineage
 *                                                  the current rule does not use (would be a real defect)
 *
 * Output: business, measure key, rule id, statuses, lineage keys/versions, timestamps, booleans. No
 * value, no detail, no evidence, no entity id, no name. One owner session, READ ONLY by Postgres
 * (verified before and after). Exit: 0 printed · 1 failed · 3 REFUSED · 2 usage.
 */
import { PrismaClient } from "@prisma/client";
import { assertSafeUrl, enforceReadOnly, RefusedError, verifyReadOnly } from "./runtime-rls-evidence";
import { catalogueDescriptors } from "@/lib/knowledge/registry";
import { classifyPinMismatch } from "./lineage-pin-classifier";

const NEW_RULE = /^(BILL|CUST|PAY|COLL|LEAD|CONV|APPT|SEC|OFF|REP)-/;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const allowHost = arg("--allow-host") ?? null;
  const businesses = (arg("--businesses") ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (businesses.length === 0) { console.error("usage: --allow-host <host> --businesses 3,9"); process.exit(2); }

  const preCoverage = catalogueDescriptors().filter((d) => !NEW_RULE.test(d.ruleId));
  let db: PrismaClient | undefined;
  try {
    db = new PrismaClient({ datasourceUrl: assertSafeUrl("OWNER_DATABASE_URL", process.env.OWNER_DATABASE_URL, allowHost) });
    await enforceReadOnly(db, "owner");
    const q = <T>(sql: string, ...p: unknown[]) => db!.$queryRawUnsafe<T[]>(sql, ...p);

    const expectedVersion = new Map<string, { createdAt: Date | null }>();
    for (const d of preCoverage) {
      const [v] = await q<{ createdAt: Date }>(
        `SELECT v."createdAt" FROM "DerivationPolicyVersion" v JOIN "DerivationPolicy" p ON p.id = v."policyId" WHERE p.key = $1 AND v.version = $2`,
        d.policyKey, d.versionLabel);
      expectedVersion.set(d.ruleId, { createdAt: v?.createdAt ?? null });
    }

    const rows: Record<string, unknown>[] = [];
    for (const b of businesses) {
      const measures = await q<{ id: number; measureKey: string; status: string; hasSubject: boolean; entityType: string | null; entityId: number | null;
        materializedAt: Date; pkey: string; ver: string; verCreatedAt: Date }>(
        `SELECT m.id, m."measureKey", m.status::text AS status, (m."entityType" IS NOT NULL) AS "hasSubject", m."entityType", m."entityId",
                m."materializedAt", p.key AS pkey, v.version AS ver, v."createdAt" AS "verCreatedAt"
           FROM "KnowledgeMeasure" m JOIN "DerivationPolicyVersion" v ON v.id = m."rulePolicyVersionId" JOIN "DerivationPolicy" p ON p.id = v."policyId"
          WHERE m."businessId" = $1 ORDER BY m.id`, b);
      for (const m of measures) {
        const d = preCoverage.find((x) => x.measureKey === m.measureKey);
        if (!d || d.policyKey === m.pkey) continue; // exactly the proof's condition
        const [slot] = await q<{ status: string; materializedAt: Date }>(
          `SELECT m.status::text AS status, m."materializedAt" FROM "KnowledgeMeasure" m
             JOIN "DerivationPolicyVersion" v ON v.id = m."rulePolicyVersionId" JOIN "DerivationPolicy" p ON p.id = v."policyId"
            WHERE m."businessId" = $1 AND m."measureKey" = $2 AND COALESCE(m."entityType", '') = COALESCE($3, '') AND COALESCE(m."entityId", 0) = COALESCE($4, 0)
              AND p.key = $5 AND v.version = $6 LIMIT 1`, b, m.measureKey, m.entityType, m.entityId, d.policyKey, d.versionLabel);
        const exp = expectedVersion.get(d.ruleId)?.createdAt ?? null;
        rows.push({
          business: `B${b}`, measureKey: m.measureKey, ruleId: d.ruleId, status: m.status, subjectLevel: m.hasSubject ? "entity" : "business",
          actualLineage: `${m.pkey}@${m.ver}`, actualLineageCreatedAt: m.verCreatedAt,
          expectedLineage: `${d.policyKey}@${d.versionLabel}`, expectedLineageCreatedAt: exp,
          rowMaterializedAt: m.materializedAt,
          createdBeforeLineage: exp !== null && m.materializedAt.getTime() < exp.getTime(),
          currentRuleUsesExpectedLineage: true, // by construction: expected = today's catalogue descriptor for this measure key
          currentSlotRow: slot ? { exists: true, status: slot.status, materializedAt: slot.materializedAt } : { exists: false },
          consumable: m.status === "ACTIVE",
          // The same classifier the final proof uses (lineage-pin-classifier.ts).
          classification: classifyPinMismatch({ status: m.status, materializedAt: m.materializedAt,
            expectedLineageCreatedAt: exp, currentSlotStatus: slot?.status ?? null }),
        });
      }
    }
    await verifyReadOnly(db, "owner");
    console.log(JSON.stringify({ flaggedRows: rows.length, rows }, null, 1));
    const live = rows.filter((r) => r.classification === "LIVE_WRONG_PIN").length;
    console.log(`\nDIAGNOSIS: ${rows.length} flagged row(s); LEGITIMATE_HISTORY=${rows.filter((r) => r.classification === "LEGITIMATE_HISTORY").length} UNEXPLAINED=${rows.filter((r) => r.classification === "HISTORICAL_STATUS_UNEXPLAINED").length} LIVE_WRONG_PIN=${live}`);
  } catch (e) {
    if (e instanceof RefusedError) { console.error(`REFUSED: ${e.message}`); process.exitCode = 3; }
    else { console.error(`FAILED: ${e instanceof Error ? e.name : "unknown"} ${(e as { code?: string })?.code ?? ""}`); process.exitCode = 1; }
  } finally {
    await db?.$disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/ops/learning-coverage-pin-diagnostic.ts")) void main();
