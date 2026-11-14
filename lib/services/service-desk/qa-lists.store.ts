/**
 * Service Desk QA lists (migration 20261129090000) — the rows the case commands read and write, in the caller's tenant
 * transaction. SERVER-ONLY. Shared by service-case.service (recordQa) and qa-lists.service (the list commands and the
 * case's choice), so neither imports the other. Raw SQL with explicit casts; every query names the business.
 */
import type { Prisma } from "@prisma/client";

import type { ItemResult, QaListItem } from "./qa-lists.core";

type Tx = Prisma.TransactionClient;

/**
 * Migration 20261129090000 is applied: its tables and the qa.list_chosen event type. Fail closed — without it the list
 * commands answer NOT_AVAILABLE_UNTIL_MIGRATION and QA results are recorded exactly as before (no per-item rows).
 */
export async function qaListsSchemaReady(tx: Tx): Promise<boolean> {
  const r = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT (to_regclass('public."ServiceQaList"') IS NOT NULL AND to_regclass('public."ServiceCaseQaItemResult"') IS NOT NULL
        AND EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'ServiceEventType' AND e.enumlabel = 'qa.list_chosen')) AS ok`;
  return r[0]?.ok === true;
}

/** The list version a case names, or null (its built-in template). Read under the caller's case lock. */
export async function caseQaChoice(tx: Tx, b: number, caseId: number): Promise<{ listId: number; listVersion: number } | null> {
  const r = (await tx.$queryRaw<{ l: number | null; v: number | null }[]>`
    SELECT "qaListId" AS l, "qaListVersion" AS v FROM "ServiceCase" WHERE id = ${caseId}::int AND "businessId" = ${b}::int`)[0];
  return r && r.l !== null && r.v !== null ? { listId: Number(r.l), listVersion: Number(r.v) } : null;
}

export type VersionRow = { listId: number; version: number; name: string | null; itemCount: number; requiredCount: number; createdAt: string; items: (QaListItem & { label: string | null; position: number })[] };

/** One version with its checks in order (labels NULL only after the account erasure). */
export async function readVersion(tx: Tx, b: number, listId: number, version: number): Promise<VersionRow | null> {
  const v = (await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT name, "itemCount", "requiredCount", to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
      FROM "ServiceQaListVersion" WHERE "businessId" = ${b}::int AND "listId" = ${listId}::int AND version = ${version}::int`)[0];
  if (!v) return null;
  const items = await tx.$queryRaw<{ key: string; label: string | null; required: boolean; position: number }[]>`
    SELECT "itemKey" AS key, label, required, position FROM "ServiceQaListItem"
     WHERE "businessId" = ${b}::int AND "listId" = ${listId}::int AND "listVersion" = ${version}::int ORDER BY position`;
  return {
    listId, version, name: (v.name as string) ?? null, itemCount: Number(v.itemCount), requiredCount: Number(v.requiredCount), createdAt: String(v.createdAt),
    items: items.map((i) => ({ key: i.key, label: i.label as string, required: i.required === true, position: Number(i.position) })),
  };
}

/**
 * The QA record of a RECORD_QA event (seq = caseVersion) and one row per check recorded. The database re-derives every
 * count at COMMIT (service_case_qa_record_matches), so these are never trusted from here alone.
 */
export async function insertQaRecord(
  tx: Tx, b: number, caseId: number, caseVersion: number,
  r: { list: { listId: number; listVersion: number } | null; templateId: string | null; itemCount: number; results: readonly ItemResult[];
       counts: { requiredFailed: number; requiredMissing: number }; completed: boolean; userId: number },
): Promise<void> {
  const pass = r.results.filter((x) => x.result === "PASS").length;
  const id = Number((await tx.$queryRaw<{ id: number }[]>`
    INSERT INTO "ServiceCaseQaRecord" ("businessId", "caseId", "caseVersion", "listId", "listVersion", "templateId", "itemCount", "resultCount",
      "passCount", "failCount", "requiredMissing", "requiredFailed", completed, "actorUserId")
    VALUES (${b}::int, ${caseId}::int, ${caseVersion}::int, ${r.list?.listId ?? null}::int, ${r.list?.listVersion ?? null}::int, ${r.templateId}::text,
      ${r.itemCount}::int, ${r.results.length}::int, ${pass}::int, ${r.results.length - pass}::int, ${r.counts.requiredMissing}::int,
      ${r.counts.requiredFailed}::int, ${r.completed}::boolean, ${r.userId}::int)
    RETURNING id`)[0].id);
  for (const x of r.results) {
    await tx.$executeRaw`
      INSERT INTO "ServiceCaseQaItemResult" ("businessId", "recordId", "listId", "listVersion", "itemKey", required, result, note)
      VALUES (${b}::int, ${id}::int, ${r.list?.listId ?? null}::int, ${r.list?.listVersion ?? null}::int, ${x.key}::text, ${x.required}::boolean,
              ${x.result}::"ServiceQaResult", ${x.note}::text)`;
  }
}
