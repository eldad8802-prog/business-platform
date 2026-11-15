/**
 * Service Desk — the business's own DEFAULT QA list per service track (migration 20261130100000). SERVER-ONLY. No UI, no
 * route logic, no flag logic (the HTTP edge decides FULL / READ_ONLY / NONE before a write is called; the write needs
 * FULL — the business owner, exactly as the QA lists and the service settings).
 *
 *   getQaTrackDefaults   the seven tracks: the current default (list, its state), the revision to send back, the track's
 *                        QA mode in the business's current profile, and whether a case opened now would take it
 *   setQaTrackDefault    one track's default → a list of the business, or none. ONE tenant transaction: the business's
 *                        defaults lock → an earlier answer for this Idempotency-Key? (the table is its own ledger, as
 *                        ServiceQaListEvent for the lists) → the revision compared → the list read FOR SHARE → the next
 *                        revision appended. The database re-checks the revision, the list's business and state.
 *
 * The default is applied at the opening (service-case.service.ts openCase), through #1124's own case choice. Changing a
 * default never touches an existing case: a case names a list VERSION, never the default.
 * Without the migrations every write answers NOT_AVAILABLE_UNTIL_MIGRATION and the read answers `available: false`.
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { checkIdempotencyKey, digestWithKeyId, sameDigest } from "@/lib/services/tasks/task-idempotency";

import { qaListsSchemaReady } from "./qa-lists.store";
import {
  decideDefaultChange,
  isTrackToken,
  parseSetDefault,
  viewReason,
  type QaTrackDefaultView,
} from "./qa-track-defaults.core";
import { qaTrackDefaultsSchemaReady, readListState, readTrackDefaults, type TrackDefaultRow } from "./qa-track-defaults.store";
import { SERVICE_TRACKS, requirementsFromSnapshot, type ProfileSnapshot, type ServiceTrack } from "./service-profiles";
import { ServiceDeskError } from "./service-desk-errors";
import { guardRefusal, isUniqueViolation, prepare, type Prepared, type ServiceDeskPrincipal, type Tx, type WriteRequest } from "./service-case.service";
import { businessProfileSnapshot } from "./tracks.service";

async function ready(tx: Tx): Promise<boolean> {
  return (await qaListsSchemaReady(tx)) && (await qaTrackDefaultsSchemaReady(tx));
}

async function viewOf(tx: Tx, b: number, snapshot: ProfileSnapshot, track: ServiceTrack, row: TrackDefaultRow | undefined): Promise<QaTrackDefaultView> {
  const qaMode = requirementsFromSnapshot(snapshot, track).qa.mode;
  const listId = row?.listId ?? null;
  let list: QaTrackDefaultView["list"] = null;
  if (listId !== null) {
    const l = (await tx.$queryRaw<{ name: string | null; v: number; archived: boolean }[]>`
      SELECT v.name, l."currentVersion" AS v, l."archivedAt" IS NOT NULL AS archived
        FROM "ServiceQaList" l JOIN "ServiceQaListVersion" v ON v."businessId" = l."businessId" AND v."listId" = l.id AND v.version = l."currentVersion"
       WHERE l."businessId" = ${b}::int AND l.id = ${listId}::int`)[0];
    if (l) list = { id: listId, name: l.name ?? null, currentVersion: Number(l.v), archived: l.archived === true };
  }
  const reason = viewReason(listId, list, qaMode);
  return {
    track, revision: row?.revision ?? 0, listId, list, qaMode, appliesAtOpening: reason === "DEFAULT", reason,
    changedAt: row?.occurredAt ?? null, changedByUserId: row?.actorUserId ?? null,
  };
}

/** GET — the seven tracks' defaults. `available: false` (and every track without a default) before the migrations. */
export async function getQaTrackDefaults(businessId: number): Promise<{ available: boolean; profileKey: string; tracks: QaTrackDefaultView[] }> {
  const b = businessId;
  return tenantTx(b, async (tx) => {
    const { profileKey, snapshot } = await businessProfileSnapshot(tx, b);
    const available = await ready(tx);
    const rows = available ? await readTrackDefaults(tx, b) : [];
    const tracks: QaTrackDefaultView[] = [];
    for (const t of SERVICE_TRACKS) tracks.push(await viewOf(tx, b, snapshot, t, rows.find((r) => r.track === t)));
    return { available, profileKey, tracks };
  });
}

/** The table is its own ledger: same key + same request → the stored answer (that track now); another request → refused. */
async function findPrior(tx: Tx, b: number, p: Prepared): Promise<{ track: ServiceTrack } | null> {
  const origin = (await tx.$queryRaw<{ t: string; d: string | null; k: string | null }[]>`
    SELECT track AS t, "requestDigest" AS d, "digestKeyId" AS k FROM "ServiceQaTrackDefault" WHERE "businessId" = ${b}::int AND "idempotencyKey" = ${p.key}::text`)[0];
  if (!origin) return null;
  if (!origin.d || !origin.k) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
  const expected = digestWithKeyId(p.keys, origin.k, p.ident);
  if (!expected || !sameDigest(expected, origin.d)) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
  return { track: origin.t as ServiceTrack };
}

/**
 * PUT /qa-track-defaults/[track] { listId: number | null, expectedRevision } — the track's default becomes an ACTIVE list of
 * the business (its current version is taken by each case opened later) or none. Refusals: INVALID_INPUT (track, listId,
 * expectedRevision, an unknown field), VERSION_CONFLICT (expectedRevision is not the track's revision), REFUSED with
 * QA_LIST_NOT_FOUND (no such list in THIS business) / QA_LIST_ARCHIVED / NO_CHANGE, IDEMPOTENCY_KEY_*,
 * NOT_AVAILABLE_UNTIL_MIGRATION, BUSINESS_DELETING. Existing cases are never touched.
 */
export async function setQaTrackDefault(p: ServiceDeskPrincipal, track: unknown, body: Record<string, unknown>, req: WriteRequest): Promise<QaTrackDefaultView & { replayed: boolean }> {
  if (!isTrackToken(track)) throw new ServiceDeskError("INVALID_INPUT", { field: "track" });
  const parsed = parseSetDefault(body);
  if (!parsed.ok) throw new ServiceDeskError("INVALID_INPUT", { field: parsed.field });
  const { listId, expectedRevision } = parsed.value;
  const prepared = prepare(p, req, "service-desk/qa-track-defaults:set", { track, listId, expectedRevision });
  const b = p.businessId;
  const attempt = () => tenantTx(b, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${0x53445144}::int, ${b}::int)`; // 'SDQD' — one defaults writer per business
    if (!(await ready(tx))) throw new ServiceDeskError("NOT_AVAILABLE_UNTIL_MIGRATION");
    const { snapshot } = await businessProfileSnapshot(tx, b);
    const prior = await findPrior(tx, b, prepared);
    if (prior) {
      if (prior.track !== track) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
      return { ...(await viewOf(tx, b, snapshot, track, (await readTrackDefaults(tx, b, track))[0])), replayed: true };
    }
    const verdict = checkIdempotencyKey(prepared.key, prepared.now);
    if (!verdict.ok) throw new ServiceDeskError(verdict.code);
    const current = (await readTrackDefaults(tx, b, track))[0] ?? null;
    if ((current?.revision ?? 0) !== expectedRevision) throw new ServiceDeskError("VERSION_CONFLICT");
    const l = listId === null ? null : await readListState(tx, b, listId, { share: true });
    const d = decideDefaultChange({ current, listId, target: listId === null ? null : { found: l !== null, archived: l?.archived === true } });
    if (!d.ok) throw new ServiceDeskError("REFUSED", { violations: d.violations });
    await tx.$executeRaw`
      INSERT INTO "ServiceQaTrackDefault" ("businessId", track, revision, "listId", actor, "actorUserId", "idempotencyKey", "requestDigest", "digestKeyId")
      VALUES (${b}::int, ${track}::text, ${expectedRevision + 1}::int, ${d.listId}::int, 'OWNER_USER'::"ServiceActor", ${p.userId}::int,
              ${prepared.key}::text, ${prepared.digest.value}::text, ${prepared.digest.keyId}::text)`;
    return { ...(await viewOf(tx, b, snapshot, track, (await readTrackDefaults(tx, b, track))[0])), replayed: false };
  }, { timeoutMs: 15_000 });
  try {
    return await attempt();
  } catch (e) {
    if (e instanceof ServiceDeskError) throw e;
    if (isUniqueViolation(e)) {
      // a writer of the same revision / key won the race: answered from it (replay) or VERSION_CONFLICT
      try { return await attempt(); } catch (e2) {
        if (e2 instanceof ServiceDeskError) throw e2;
        throw isUniqueViolation(e2) ? new ServiceDeskError("CONFLICT") : guardRefusal(e2) ?? e2;
      }
    }
    throw guardRefusal(e) ?? e;
  }
}
