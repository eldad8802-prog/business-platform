/**
 * Service Desk 1.3-0 — the REAL account-deletion purge (prismaAccountDeletionStore.purgeOperationalData, the code
 * account deletion runs) on a database where 20261120090000 is applied and the business has rows in the new tables.
 * PR-1 proved it unharmed (condition 3.6) and pinned the gap; PR-2 wires the door, so P3 / P4 now prove the wiring:
 *   P1. the purge succeeds with 1.3-0 rows present (no new guard, FK or trigger stands in its way);
 *   P2. the purge's own erasures still run (users anonymised, staff blanked, the 1.2a case scrubbed);
 *   P3. the purge itself scrubs the new rows in place (who acted, the warranty change reason) and opens the durable
 *       storage-erasure job — service_desk_ui_erase_business() runs in the purge transaction;
 *   P4. the door re-run by hand changes nothing more (already erased) and the one job stays PENDING_OBJECTS — objects
 *       are deleted only after commit (.sd3/storage-erasure-battery.ts);
 *   P5. a second purge after the door still succeeds (the job refuses only Service Desk UI writes, never the purge).
 *
 * env: OWNER_URL, DATABASE_URL / DIRECT_URL / AUTH_DATABASE_URL (runtime), AUTH_TOKEN_SECRET. Synthetic only.
 */
import { PrismaClient } from "@prisma/client";
import { prismaAccountDeletionStore } from "../lib/services/account/account-deletion.prisma-store";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL! });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const x = (sql: string, ...a: unknown[]) => owner.$executeRawUnsafe(sql, ...a);
const n = async (sql: string, ...a: unknown[]) => Number((await q(sql, ...a))[0]?.n);
const purge = (biz: number) => prismaAccountDeletionStore.purgeOperationalData(biz).then(() => null, (e: Error) => e.message);
const H = (c: string) => c.repeat(64);

async function main() {
  const biz = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sd3-purge-${Date.now()}`))[0].id);
  const user = Number((await q(`INSERT INTO "User" (email, name, "businessId", "updatedAt") VALUES ($1, 'בעל עסק', $2, now()) RETURNING id`, `sd3-purge-${biz}@lab.invalid`, biz))[0].id);
  const cust = Number((await q(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח', now()) RETURNING id`, biz))[0].id);
  const staff = Number((await q(`INSERT INTO "StaffMember" ("businessId", "displayName", "updatedAt") VALUES ($1, 'טכנאית דנה', now()) RETURNING id`, biz))[0].id);
  const doc = Number((await q(`INSERT INTO "BillingDocument" ("businessId", "documentType", "updatedAt") VALUES ($1, 'QUOTE', now()) RETURNING id`, biz))[0].id);

  // One case with every 1.3-0 row, written as the runtime in the tenant context.
  const kase = await runtime.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${biz}', true)`);
    const one = async (sql: string, ...a: unknown[]) => Number(((await tx.$queryRawUnsafe(sql, ...a)) as Rows)[0].id);
    const terms = await one(`INSERT INTO "ServiceTextVersion" ("businessId", kind, version, body, "bodySha256", "createdByUserId") VALUES ($1, 'TERMS', 1, 'תנאים', encode(sha256(convert_to('תנאים','UTF8')),'hex'), $2) RETURNING id`, biz, user);
    const notice = await one(`INSERT INTO "ServiceTextVersion" ("businessId", kind, version, body, "bodySha256", "createdByUserId") VALUES ($1, 'STATUTORY_NOTICE', 1, 'הודעה', encode(sha256(convert_to('הודעה','UTF8')),'hex'), $2) RETURNING id`, biz, user);
    await tx.$executeRawUnsafe(`UPDATE "ServiceTextVersion" SET "legalStatus" = 'LEGALLY_APPROVED', "legallyApprovedAt" = now(), "legallyApprovedByUserId" = $2 WHERE "businessId" = $1`, biz, user);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceSettings" ("businessId", "defaultStaffMemberId", "activeTermsVersionId", "activeStatutoryNoticeVersionId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, biz, staff, terms, notice);
    const k = await one(`INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "staffMemberId", "problemDescription", "updatedAt") VALUES ($1, 1, 'IN_SHOP', $2, $3, 'מסך', now()) RETURNING id`, biz, cust, staff);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, "actorUserId", payload, "idempotencyKey")
      VALUES ($1, $2, 1, 'case.opened', 'OPEN', NULL, 'OPEN', false, false, 'OWNER_USER', $3, '{}', $4)`, biz, k, user, `sd3-purge-${biz}-0001`);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseIntake" ("businessId", "caseId", "deviceSnapshot", "conditionNote", "conditionRecorded", "accessoriesRecorded", "updatedAt") VALUES ($1, $2, '{}', 'שריטה', true, true, now())`, biz, k);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceIntakeTermsSnapshot" ("businessId", "caseId", "termsVersionId", "termsSha256", "statutoryNoticeVersionId", "statutorySha256", "presentedByUserId")
      SELECT $1, $2, t.id, t."bodySha256", s.id, s."bodySha256", $3 FROM "ServiceTextVersion" t, "ServiceTextVersion" s WHERE t.id = $4 AND s.id = $5`, biz, k, user, terms, notice);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceIntakePhoto" ("businessId", "caseId", "storageKey", sha256, "mimeType", "byteSize", "createdByUserId") VALUES ($1, $2, $3, $4, 'image/jpeg', 1000, $5)`,
      biz, k, `biz/${biz}/service/cases/${k}/intake/photos/${H("1")}.jpg`, H("1"), user);
    await tx.$executeRawUnsafe(`UPDATE "ServiceCaseIntake" SET "customerSigned" = true, "signedAt" = now(), "signatureKey" = $2 WHERE "caseId" = $1`, k, `biz/${biz}/service/sig/${k}.png`);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceQuote" ("businessId", "caseId", version, "billingDocumentId", "totalAgorot", "docHash", "sentPdfKey", "sentPdfSha256", "sentByUserId") VALUES ($1, $2, 1, $3, 100, $4, $5, $6, $7)`,
      biz, k, doc, H("2"), `biz/${biz}/service/quotes/${k}.pdf`, H("3"), user);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceShareEvent" ("businessId", "caseId", "objectKind", "quoteVersion", "objectKey", "objectSha256", channel, "actorUserId", "idempotencyKey") VALUES ($1, $2, 'QUOTE_PDF', 1, $3, $4, 'WHATSAPP_MANUAL', $5, $6)`,
      biz, k, `biz/${biz}/service/quotes/${k}.pdf`, H("3"), user, `sd3-purge-share-${biz}-01`);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceWarrantyOffer" ("businessId", "caseId", seq, state, source, "durationValue", "durationUnit", "scopeText", "statutoryNoticeVersionId", "contentSha256", "presentedAt", "presentedByUserId", "createdByUserId", "updatedAt")
      VALUES ($1, $2, 1, 'PRESENTED', 'INTAKE', 3, 'MONTHS', 'חלקים ועבודה', $3, $4, now(), $5, $5, now())`, biz, k, notice, H("4"), user);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceHandover" ("businessId", "caseId", "receivedByName", "signatureCaptured", "openBalanceAgorot", "actorUserId") VALUES ($1, $2, 'ישראל', true, 0, $3)`, biz, k, user);
    return k;
  }, { timeout: 60_000 });

  const newRows = async () => n(`SELECT ((SELECT count(*) FROM "ServiceTextVersion" WHERE "businessId" = $1) + (SELECT count(*) FROM "ServiceSettings" WHERE "businessId" = $1)
    + (SELECT count(*) FROM "ServiceIntakeTermsSnapshot" WHERE "businessId" = $1) + (SELECT count(*) FROM "ServiceIntakePhoto" WHERE "businessId" = $1)
    + (SELECT count(*) FROM "ServiceShareEvent" WHERE "businessId" = $1) + (SELECT count(*) FROM "ServiceWarrantyOffer" WHERE "businessId" = $1))::int AS n`, biz);
  ok("P0 fixtures: the business holds rows in six of the new tables (7 rows)", await newRows() === 7);

  await x(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, biz);
  const r1 = await purge(biz);
  ok("P1 the real purge succeeds with 1.3-0 rows present", r1 === null, String(r1));
  const u = (await q(`SELECT email, name FROM "User" WHERE id = $1`, user))[0];
  const st = (await q(`SELECT "displayName" AS d FROM "StaffMember" WHERE id = $1`, staff))[0];
  const kc = (await q(`SELECT "problemDescription" AS p, "erasedAt" IS NOT NULL AS e FROM "ServiceCase" WHERE id = $1`, kase))[0];
  ok("P2 the purge's own erasures still run (user anonymised, staff blanked, 1.2a case scrubbed)",
    !!u && u.email !== `sd3-purge-${biz}@lab.invalid` && st?.d === "" && kc?.p === null && kc?.e === true, JSON.stringify({ u, st, kc }));
  ok("P3 the purge scrubs the new rows in place and opens the storage-erasure job (service_desk_ui_erase_business() wired)",
    await n(`SELECT count(*)::int AS n FROM "ServiceWarrantyOffer" WHERE "businessId" = $1 AND "erasedAt" IS NOT NULL AND "presentedByUserId" IS NULL AND "createdByUserId" IS NULL`, biz) === 1
    && await n(`SELECT count(*)::int AS n FROM "ServiceTextVersion" WHERE "businessId" = $1 AND "erasedAt" IS NOT NULL AND "createdByUserId" IS NULL AND "legallyApprovedByUserId" IS NULL`, biz) === 2
    && await n(`SELECT count(*)::int AS n FROM "ServiceIntakePhoto" WHERE "businessId" = $1 AND "erasedAt" IS NOT NULL AND "createdByUserId" IS NULL`, biz) === 1
    && await n(`SELECT count(*)::int AS n FROM "ServiceStorageErasure" WHERE "businessId" = $1 AND state = 'PENDING_OBJECTS'`, biz) === 1);
  const r4 = await runtime.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${biz}', true)`);
    await tx.$queryRawUnsafe(`SELECT public.service_erase_business() AS n`);
    return Number(((await tx.$queryRawUnsafe(`SELECT public.service_desk_ui_erase_business() AS n`)) as Rows)[0].n);
  }).catch((e: Error) => e.message);
  ok("P4 the door re-run changes nothing more (0 rows) and the one job stays PENDING_OBJECTS",
    r4 === 0 && await n(`SELECT count(*)::int AS n FROM "ServiceStorageErasure" WHERE "businessId" = $1 AND state = 'PENDING_OBJECTS'`, biz) === 1, String(r4));
  const r5 = await purge(biz);
  ok("P5 a second purge with the job open still succeeds", r5 === null, String(r5));
}

main()
  .catch((e) => { failures.push(`crash: ${(e as Error).message}`); console.error(e); })
  .finally(async () => {
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) console.log("FAILED:\n  " + failures.join("\n  "));
    await owner.$disconnect(); await runtime.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
