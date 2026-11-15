/**
 * Service Desk QA track defaults (migration 20261130100000) — the rows the opening and the defaults commands read, in the
 * caller's tenant transaction. SERVER-ONLY. Shared by service-case.service (openCase) and qa-track-defaults.service, so
 * neither imports the other. Raw SQL with explicit casts; every query names the business.
 */
import type { Prisma } from "@prisma/client";

import type { ListState } from "./qa-track-defaults.core";
import type { ServiceTrack } from "./service-profiles";

type Tx = Prisma.TransactionClient;

/** Migration 20261130100000 is applied. Fail closed — without it no default exists (a case opens without a list). */
export async function qaTrackDefaultsSchemaReady(tx: Tx): Promise<boolean> {
  const r = await tx.$queryRaw<{ ok: boolean }[]>`SELECT to_regclass('public."ServiceQaTrackDefault"') IS NOT NULL AS ok`;
  return r[0]?.ok === true;
}

export type TrackDefaultRow = { track: ServiceTrack; revision: number; listId: number | null; occurredAt: string; actorUserId: number | null };

/** Every track's CURRENT default row (its highest revision) — tracks never set are absent. */
export async function readTrackDefaults(tx: Tx, b: number, track?: ServiceTrack): Promise<TrackDefaultRow[]> {
  const rows = await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT DISTINCT ON (track) track, revision, "listId", "actorUserId",
           to_char("occurredAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt"
      FROM "ServiceQaTrackDefault"
     WHERE "businessId" = ${b}::int AND (${track ?? null}::text IS NULL OR track = ${track ?? null}::text)
     ORDER BY track, revision DESC`;
  return rows.map((r) => ({
    track: String(r.track) as ServiceTrack, revision: Number(r.revision), listId: r.listId === null ? null : Number(r.listId),
    occurredAt: String(r.occurredAt), actorUserId: r.actorUserId === null ? null : Number(r.actorUserId),
  }));
}

/**
 * A list of THIS business as it stands (its current version, archived or not), or null when there is none here. With
 * `share`, the head row is read FOR SHARE: an archive or a revision of the list waits for the caller to commit, so the
 * version named cannot move under it (the case guard and the defaults guard re-check the same row).
 */
export async function readListState(tx: Tx, b: number, listId: number, opts: { share?: boolean } = {}): Promise<ListState | null> {
  const r = opts.share
    ? (await tx.$queryRaw<{ v: number; archived: boolean }[]>`
        SELECT "currentVersion" AS v, "archivedAt" IS NOT NULL AS archived FROM "ServiceQaList" WHERE "businessId" = ${b}::int AND id = ${listId}::int FOR SHARE`)[0]
    : (await tx.$queryRaw<{ v: number; archived: boolean }[]>`
        SELECT "currentVersion" AS v, "archivedAt" IS NOT NULL AS archived FROM "ServiceQaList" WHERE "businessId" = ${b}::int AND id = ${listId}::int`)[0];
  return r ? { listId, currentVersion: Number(r.v), archived: r.archived === true } : null;
}
