/**
 * Alerts — the memory that keeps the monitor from repeating itself. One open row per finding
 * (migration 20261107090000: a partial unique index per (code, subject), per business for the tenant table).
 *
 *   OPEN       INSERT … ON CONFLICT DO NOTHING on the open-key index: a finding seen again, or seen by two monitors
 *              at once, stays ONE row; lastSeenAt / severity / detail are refreshed.
 *   RESOLVE    an open alert whose finding is absent from a COMPLETE evaluation of its scope is resolved. A scope
 *              that was not evaluated (an error, the time budget) keeps its alerts as they are.
 *   CLAIM      a notification is claimed by a conditional UPDATE under FOR UPDATE SKIP LOCKED: the first notice of an
 *              open alert (notifyCount 0), a reminder every REMIND_EVERY_MS while it stays open (codes that remind),
 *              and one notice when an alert that was notified resolves. Two monitors racing claim each item once.
 *   RELEASE    if the message could not be sent, the claims are given back — fenced on exactly what was claimed — so
 *              the next run sends the same items again under the same provider idempotency key.
 *
 * The platform table needs no tenant context (no tenant key, no business data); the business table is read and
 * written only inside that business's tenant transaction, under FORCE RLS.
 */

import { Prisma } from "@prisma/client";

import type { TenantTxClient } from "@/lib/tenant/tenant-tx";
import { REMINDABLE_CODES, type Finding, type Severity } from "./findings";

export const REMIND_EVERY_MS = 24 * 60 * 60 * 1000;

export type AlertScope = { kind: "platform" } | { kind: "business"; businessId: number };
type SqlClient = Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw"> | Pick<TenantTxClient, "$executeRaw" | "$queryRaw">;

export type Claim = {
  scope: AlertScope;
  alertId: number;
  code: string;
  subjectKey: string;
  severity: Severity;
  detail: Record<string, unknown>;
  openedAt: Date;
  /** "open": first notice · "reminder": the n-th notice of a still-open alert · "resolved": it recovered. */
  kind: "open" | "reminder" | "resolved";
  /** notifyCount after the claim (open / reminder), or the alert's count (resolved). */
  notifyCount: number;
  claimedAt: Date;
  /** lastNotifiedAt before the claim — what a release restores. */
  previousNotifiedAt: Date | null;
};

export type ReconcileResult = { opened: number; resolved: number; open: number; claims: Claim[] };

/** TIMESTAMP(3) holds UTC wall-clock time (as every Prisma write does). Converted explicitly. */
const at = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
const table = (s: AlertScope) => Prisma.raw(s.kind === "platform" ? `"AccountantOpsAlert"` : `"AccountantBusinessAlert"`);
const scoped = (s: AlertScope) => (s.kind === "platform" ? Prisma.sql`TRUE` : Prisma.sql`"businessId" = ${s.businessId}`);
const asDate = (v: unknown) => (v instanceof Date ? v : new Date(String(v) + (String(v).endsWith("Z") ? "" : "Z")));

type Row = {
  id: number;
  code: string;
  subjectKey: string;
  severity: Severity;
  detail: Record<string, unknown>;
  openedAt: Date;
  notifyCount: number;
  prev: Date | null;
};

/** Brings one scope's alerts in line with its findings (a complete evaluation of that scope) and claims what is due. */
export async function reconcileAlerts(db: SqlClient, scope: AlertScope, findings: Finding[], now: Date): Promise<ReconcileResult> {
  const T = table(scope);
  let opened = 0;
  const seen = new Map<string, Finding>();
  for (const f of findings) seen.set(`${f.code}|${f.subjectKey}`, f);

  for (const f of seen.values()) {
    const detail = JSON.stringify(f.detail);
    opened +=
      scope.kind === "platform"
        ? await db.$executeRaw`
            INSERT INTO "AccountantOpsAlert" ("code", "subjectKey", "severity", "detail", "openedAt", "lastSeenAt")
            VALUES (${f.code}, ${f.subjectKey}, ${f.severity}, ${detail}::jsonb, ${at(now)}, ${at(now)})
            ON CONFLICT ("code", "subjectKey") WHERE "resolvedAt" IS NULL DO NOTHING`
        : await db.$executeRaw`
            INSERT INTO "AccountantBusinessAlert" ("businessId", "code", "subjectKey", "severity", "detail", "openedAt", "lastSeenAt")
            VALUES (${scope.businessId}, ${f.code}, ${f.subjectKey}, ${f.severity}, ${detail}::jsonb, ${at(now)}, ${at(now)})
            ON CONFLICT ("businessId", "code", "subjectKey") WHERE "resolvedAt" IS NULL DO NOTHING`;
    await db.$executeRaw`
      UPDATE ${T} SET "lastSeenAt" = GREATEST("lastSeenAt", ${at(now)}), "severity" = ${f.severity}, "detail" = ${detail}::jsonb
       WHERE ${scoped(scope)} AND "code" = ${f.code} AND "subjectKey" = ${f.subjectKey} AND "resolvedAt" IS NULL`;
  }

  const keep = [...seen.keys()];
  const resolved =
    keep.length === 0
      ? await db.$executeRaw`UPDATE ${T} SET "resolvedAt" = GREATEST("openedAt", ${at(now)}) WHERE ${scoped(scope)} AND "resolvedAt" IS NULL`
      : await db.$executeRaw`
          UPDATE ${T} SET "resolvedAt" = GREATEST("openedAt", ${at(now)})
           WHERE ${scoped(scope)} AND "resolvedAt" IS NULL AND ("code" || '|' || "subjectKey") <> ALL (${keep}::text[])`;

  const remindBefore = new Date(now.getTime() - REMIND_EVERY_MS);
  const notices = await db.$queryRaw<Row[]>`
    WITH due AS (
      SELECT "id", "lastNotifiedAt" AS prev FROM ${T}
       WHERE ${scoped(scope)} AND "resolvedAt" IS NULL
         AND ("notifyCount" = 0 OR ("code" = ANY (${[...REMINDABLE_CODES]}::text[]) AND "lastNotifiedAt" <= ${at(remindBefore)}))
       ORDER BY "id"
       FOR UPDATE SKIP LOCKED)
    UPDATE ${T} a SET "notifyCount" = a."notifyCount" + 1, "lastNotifiedAt" = ${at(now)}
      FROM due WHERE a."id" = due."id"
    RETURNING a."id", a."code", a."subjectKey", a."severity", a."detail", a."openedAt", a."notifyCount", due.prev`;
  const recovered = await db.$queryRaw<Row[]>`
    WITH due AS (
      SELECT "id", "lastNotifiedAt" AS prev FROM ${T}
       WHERE ${scoped(scope)} AND "resolvedAt" IS NOT NULL AND "resolvedNotifiedAt" IS NULL AND "notifyCount" > 0
       ORDER BY "id"
       FOR UPDATE SKIP LOCKED)
    UPDATE ${T} a SET "resolvedNotifiedAt" = ${at(now)}
      FROM due WHERE a."id" = due."id"
    RETURNING a."id", a."code", a."subjectKey", a."severity", a."detail", a."openedAt", a."notifyCount", due.prev`;

  const open = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM ${T} WHERE ${scoped(scope)} AND "resolvedAt" IS NULL`;
  const claim = (r: Row, kind: Claim["kind"]): Claim => ({
    scope,
    alertId: r.id,
    code: r.code,
    subjectKey: r.subjectKey,
    severity: r.severity,
    detail: r.detail ?? {},
    openedAt: asDate(r.openedAt),
    kind,
    notifyCount: r.notifyCount,
    claimedAt: now,
    previousNotifiedAt: r.prev ? asDate(r.prev) : null,
  });
  return {
    opened,
    resolved,
    open: open[0]?.n ?? 0,
    claims: [
      ...notices.map((r) => claim(r, r.notifyCount === 1 ? "open" : "reminder")),
      ...recovered.map((r) => claim(r, "resolved")),
    ],
  };
}

/** Gives claims back after a failed send — each fenced on exactly what this run claimed. Returns how many. */
export async function releaseClaims(db: SqlClient, claims: Claim[]): Promise<number> {
  let n = 0;
  for (const c of claims) {
    const T = table(c.scope);
    n +=
      c.kind === "resolved"
        ? await db.$executeRaw`
            UPDATE ${T} SET "resolvedNotifiedAt" = NULL
             WHERE ${scoped(c.scope)} AND "id" = ${c.alertId} AND "resolvedNotifiedAt" = ${at(c.claimedAt)}`
        : await db.$executeRaw`
            UPDATE ${T} SET "notifyCount" = "notifyCount" - 1,
                            "lastNotifiedAt" = ${c.previousNotifiedAt ? at(c.previousNotifiedAt) : null}
             WHERE ${scoped(c.scope)} AND "id" = ${c.alertId} AND "notifyCount" = ${c.notifyCount} AND "lastNotifiedAt" = ${at(c.claimedAt)}`;
  }
  return n;
}
