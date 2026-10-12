/**
 * Daily Tasks — the owner's source preferences (Daily Tasks spec 7.6, 13). SERVER-ONLY.
 *
 * Version one keeps one preference: which of the eight sources the owner switched off. A switched-off source
 * is not run and not shown; switching it back on shows its items again from the source (nothing was stored).
 * The morning summary columns exist (milestone A) and stay untouched here — external reminders are not in v1.
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { SOURCE_KINDS, SOURCE_NAMES, type SourceKind } from "./agenda-core";
import { TaskServiceError, idempotent, own, type TaskActor, type TaskRequest } from "./task.service";
import { utcTs } from "./task.store";

export type TaskPreferencesView = { sources: { kind: SourceKind; name: string; enabled: boolean }[]; version: number };

export async function getPreferences(businessId: number): Promise<TaskPreferencesView> {
  const p = await tenantTx(businessId, (tx) => tx.taskPreferences.findUnique({ where: { businessId }, select: { disabledSources: true, version: true } }));
  const off = new Set(p?.disabledSources ?? []);
  return { sources: SOURCE_KINDS.map((kind) => ({ kind, name: SOURCE_NAMES[kind], enabled: !off.has(kind) })), version: p?.version ?? 0 };
}

export async function setSourceEnabled(actor: TaskActor, req: TaskRequest, kind: string, enabled: boolean): Promise<TaskPreferencesView> {
  if (!SOURCE_KINDS.includes(kind as SourceKind)) throw new TaskServiceError("INVALID_INPUT", { field: "kind" });
  if (typeof enabled !== "boolean") throw new TaskServiceError("INVALID_INPUT", { field: "enabled" });
  await idempotent(actor, req, "preferences.source", { kind, enabled }, async (ctx) => {
    await ctx.tx.$executeRaw`
      INSERT INTO "TaskPreferences" ("businessId", "updatedAt") VALUES (${ctx.businessId}, ${utcTs(ctx.now)})
      ON CONFLICT ("businessId") DO NOTHING`;
    const rows = await ctx.tx.$queryRaw<{ disabledSources: string[] }[]>`
      SELECT "disabledSources" FROM "TaskPreferences" WHERE "businessId" = ${ctx.businessId} FOR UPDATE`;
    const off = new Set(rows[0]?.disabledSources ?? []);
    if (off.has(kind) === !enabled) return {}; // already so: no write, no event
    if (enabled) off.delete(kind);
    else off.add(kind);
    await ctx.tx.taskPreferences.update({
      where: { businessId: ctx.businessId },
      data: { disabledSources: [...off].sort(), version: { increment: 1 } },
    });
    own(ctx, { eventType: enabled ? "SOURCE_ENABLED" : "SOURCE_DISABLED", payload: { sourceKind: kind } });
    return {};
  });
  return getPreferences(actor.businessId);
}
