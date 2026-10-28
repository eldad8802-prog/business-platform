/**
 * The ONE place the accountant monitor opens a transaction outside a tenant: the platform-level alert table
 * ("AccountantOpsAlert" — no tenant key, no business data, closed by CHECK; migration 20261107090000).
 * Registered in scripts/ci/tenant-context-guard.sh as GLOBAL_NON_TENANT: nothing here may touch a tenant table —
 * per-business alerts are written only inside that business's tenant transaction (lib/accountant/ops/monitor.ts).
 */

import { prisma } from "@/lib/prisma";
import { reconcileAlerts, releaseClaims, type Claim, type ReconcileResult } from "./alert-store";
import type { Finding, OpenAlert } from "./findings";

export function reconcilePlatformAlerts(findings: Finding[], now: Date): Promise<ReconcileResult> {
  return prisma.$transaction((tx) => reconcileAlerts(tx, { kind: "platform" }, findings, now));
}

export function releasePlatformClaims(claims: Claim[]): Promise<number> {
  return prisma.$transaction((tx) => releaseClaims(tx, claims.filter((c) => c.scope.kind === "platform")));
}

/** Platform alerts open before this run (the rules keep them until their fault is actually gone). */
export async function openPlatformAlerts(): Promise<OpenAlert[]> {
  const rows = await prisma.accountantOpsAlert.findMany({ where: { resolvedAt: null }, select: { code: true, subjectKey: true, detail: true } });
  return rows.map((r) => ({ ...r, detail: (r.detail ?? {}) as Record<string, unknown> }));
}
