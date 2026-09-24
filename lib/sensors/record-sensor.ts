/**
 * M5.5 · `recordSensor` — the one writer for new business sensors.
 *
 * WHAT IT ENFORCES, SO NO CALL SITE HAS TO REMEMBER
 *
 *   KNOWN        the sensor exists in the catalogue, or nothing is written
 *   DECIDED      the caller states an actor AND a source; there is no default, because a default is a
 *                guess and a guess about "who did this" is precisely the fake precision M5 removed
 *   CONSISTENT   OWNER_UI is only ever a person; a person always has a user id
 *   PURPOSE-LIMITED  only the catalogue's payload keys, only scalars and short lists, no string long
 *                enough to be a paragraph, and never a key whose name says personal data or free text
 *   ONCE         with an idempotency key, a retry of the same action is ON CONFLICT DO NOTHING — which
 *                matters inside a caller's transaction, where a unique violation would abort it
 *   TENANT-BOUND always inside a tenant transaction: the caller's, or its own
 *
 * FAILURE. A refused payload is a programming error, reported by name and never by content, and it
 * writes nothing. A database failure OUTSIDE a caller's transaction is logged and swallowed: the
 * business action already happened and is recorded in its own table. INSIDE a caller's transaction
 * it is rethrown, because Postgres has already aborted that transaction and pretending otherwise
 * would report success for a write that will roll back.
 */
import { Prisma } from "@prisma/client";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { SENSORS, type SensorKey } from "./catalogue";
import {
  FORBIDDEN_KEY,
  MAX_LIST,
  MAX_STRING,
  type SensorActor,
  type SensorPayload,
  type SensorSource,
  type SensorValue,
} from "./sensor.contract";

export type RecordSensorInput = {
  readonly businessId: number;
  readonly sensor: SensorKey;
  readonly entityId?: number | null;
  readonly actor: SensorActor;
  readonly source: SensorSource;
  readonly payload?: SensorPayload;
  /** Business time, when it differs from the moment of recording. */
  readonly occurredAt?: Date | null;
  /** A stable identity for the action, e.g. `customer:42:created`. Retries become no-ops. */
  readonly idempotencyKey?: string | null;
};

export type RecordSensorResult =
  | { readonly ok: true; readonly written: boolean }
  | { readonly ok: false; readonly refused: SensorRefusal };

export type SensorRefusal =
  | "unknown_sensor"
  | "bad_business"
  | "bad_actor"
  | "actor_source_mismatch"
  | "payload_key_not_allowed"
  | "payload_key_forbidden"
  | "payload_value_not_scalar"
  | "payload_string_too_long"
  | "payload_list_too_long"
  | "idempotency_key_invalid";

function scalarOk(v: unknown): boolean {
  return v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) ||
    typeof v === "string";
}

/** Pure. Exported so the catalogue test and the battery can check the contract without a database. */
export function validateSensorInput(input: RecordSensorInput): SensorRefusal | null {
  const def = SENSORS[input.sensor];
  if (!def) return "unknown_sensor";
  if (!Number.isInteger(input.businessId) || input.businessId <= 0) return "bad_business";

  const a = input.actor;
  if (a.type === "OWNER_USER" && !(Number.isInteger(a.userId) && a.userId > 0)) return "bad_actor";
  // The owner's UI is, by definition, a person. A system job claiming OWNER_UI is lying about origin.
  if (input.source === "OWNER_UI" && a.type !== "OWNER_USER") return "actor_source_mismatch";
  // An import is started by a person; an integration or a job is not the owner's UI.
  if (input.source === "IMPORT" && a.type !== "OWNER_USER" && a.type !== "UNKNOWN") {
    return "actor_source_mismatch";
  }

  const allowed = new Set<string>(def.payloadKeys);
  for (const [key, value] of Object.entries(input.payload ?? {})) {
    if (FORBIDDEN_KEY.test(key)) return "payload_key_forbidden";
    if (!allowed.has(key)) return "payload_key_not_allowed";
    const values: readonly unknown[] = Array.isArray(value) ? value : [value];
    if (Array.isArray(value) && value.length > MAX_LIST) return "payload_list_too_long";
    for (const v of values) {
      if (!scalarOk(v)) return "payload_value_not_scalar";
      if (typeof v === "string" && v.length > MAX_STRING) return "payload_string_too_long";
    }
  }

  const k = input.idempotencyKey;
  if (k != null && (typeof k !== "string" || k.length === 0 || k.length > 200)) {
    return "idempotency_key_invalid";
  }
  return null;
}

type SensorWriteClient = Pick<Prisma.TransactionClient, "learningEvent" | "$executeRawUnsafe">;

function rowOf(input: RecordSensorInput) {
  const def = SENSORS[input.sensor];
  const actor = input.actor;
  return {
    businessId: input.businessId,
    eventType: def.eventType,
    entityType: def.entityType,
    entityId: input.entityId ?? null,
    payload: (input.payload ?? {}) as Prisma.InputJsonValue,
    actorType: actor.type,
    // A user id only ever accompanies OWNER_USER: a job has nobody behind it, and attaching the user
    // whose request happened to trigger it would put a name on a decision nobody made.
    actorUserId: actor.type === "OWNER_USER" ? actor.userId : null,
    source: input.source,
    occurredAt: input.occurredAt ?? null,
    sensorVersion: def.version,
    idempotencyKey: input.idempotencyKey ?? null,
  };
}

async function write(client: SensorWriteClient, input: RecordSensorInput): Promise<boolean> {
  // createMany + skipDuplicates is INSERT … ON CONFLICT DO NOTHING: a retried action inside a
  // caller's transaction must not raise a unique violation, which would abort that transaction.
  const res = await client.learningEvent.createMany({ data: [rowOf(input)], skipDuplicates: true });
  return res.count === 1;
}

function errorCode(e: unknown): string {
  if (e instanceof Prisma.PrismaClientKnownRequestError) return e.code;
  return e instanceof Error ? e.name : "unknown";
}

export async function recordSensor(
  input: RecordSensorInput,
  options?: { tx?: SensorWriteClient },
): Promise<RecordSensorResult> {
  const refused = validateSensorInput(input);
  if (refused) {
    // Name and reason only. The payload is exactly what must never reach a log.
    console.error("[sensor] refused", { sensor: input.sensor, refused });
    return { ok: false, refused };
  }

  if (options?.tx) {
    // Inside the caller's transaction, behind a SAVEPOINT. The sensor is still atomic with the action
    // (it commits or rolls back with it), but a failure of the SENSOR alone — a lock wait, a timeout,
    // an out-of-range id — rolls back to the savepoint and leaves the caller's transaction healthy.
    // Without it, Postgres would abort the whole transaction and a learning record would have cost
    // the owner their customer, their POS sale or their inbound message.
    const tx = options.tx;
    const sp = `sensor_${Math.random().toString(36).slice(2, 10)}`;
    await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
    try {
      const written = await write(tx, input);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
      return { ok: true, written };
    } catch (e) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
      console.error("[sensor] write failed (rolled back to savepoint)", { sensor: input.sensor, code: errorCode(e) });
      return { ok: true, written: false };
    }
  }
  try {
    const written = await tenantTx(input.businessId, (tx) => write(tx, input));
    return { ok: true, written };
  } catch (e) {
    console.error("[sensor] write failed", { sensor: input.sensor, code: errorCode(e) });
    return { ok: true, written: false };
  }
}

/** Field names that differ between two records, sorted — the only "what changed" a sensor carries. */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
  keys: readonly (keyof T & string)[],
): string[] {
  const out: string[] = [];
  for (const k of keys) {
    if (!(k in after)) continue;
    const a = before[k];
    const b = after[k];
    const same =
      a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b ||
      (a == null && b == null);
    if (!same) out.push(k);
  }
  return out.sort();
}

export type { SensorValue };
