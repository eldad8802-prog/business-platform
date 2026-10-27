/**
 * The accountant package monitoring page (G5 milestone 1) — read on the ADMIN plane (app_admin, SELECT only).
 *
 * It reads exactly the three monitoring tables (migration 20261107090000; the console's read is migration
 * 20261107092000_accountant_ops_admin_read) and the business names the console already reads (A1). Nothing of the
 * accountant workflow itself: no period, package, recipient, delivery or trail row — no address, no link, no token,
 * no provider id, no document, no amount. The configuration block is switches only (on / off), never a value.
 *
 * Without migration 20261107092000 applied, app_admin has no privilege on the tables: the page then says so
 * ("not granted") instead of failing or showing zeros.
 */

import { getPrismaAdmin } from "@/lib/prisma-admin";
import { readAlertChannel } from "@/lib/accountant/ops/alert-email";
import { FINDING_SPECS, isFindingCode, subjectLabelHe } from "@/lib/accountant/ops/findings";

export type AccountantOpsAlertView = {
  id: number;
  scope: "platform" | "business";
  businessId: number | null;
  businessName: string | null;
  code: string;
  title: string;
  subject: string;
  severity: string;
  detail: Record<string, unknown>;
  openedAt: string;
  lastSeenAt: string;
  notifyCount: number;
  lastNotifiedAt: string | null;
  resolvedAt: string | null;
};

export type AccountantOpsRunView = {
  id: number;
  kind: string;
  source: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  outcome: string;
  errorCode: string | null;
  counts: Record<string, unknown>;
};

export type AccountantOpsResponse =
  | { available: false; reason: "admin_read_not_granted"; config: AccountantOpsConfig }
  | {
      available: true;
      generatedAt: string;
      config: AccountantOpsConfig;
      openAlerts: AccountantOpsAlertView[];
      recentlyResolved: AccountantOpsAlertView[];
      sweepRuns: AccountantOpsRunView[];
      monitorRuns: AccountantOpsRunView[];
    };

export type AccountantOpsConfig = {
  monitorEnabled: boolean;
  sweepEnabled: boolean;
  deliveryEnabled: boolean;
  webhookConfigured: boolean;
  alertChannelConfigured: boolean;
};

const RECENT_RUNS = 12;
const RESOLVED_DAYS = 7;
const MAX_ALERTS = 100;

export function readAccountantOpsConfig(env: Record<string, string | undefined> = process.env): AccountantOpsConfig {
  return {
    monitorEnabled: env.ACCOUNTANT_MONITOR_ENABLED?.trim() === "true",
    sweepEnabled: env.ACCOUNTANT_SWEEP_ENABLED?.trim() === "true",
    deliveryEnabled: env.ACCOUNTANT_DELIVERY_ENABLED?.trim() === "true",
    webhookConfigured: !!env.RESEND_WEBHOOK_SECRET?.trim(),
    alertChannelConfigured: readAlertChannel(env).ok,
  };
}

type AlertRow = {
  id: number;
  code: string;
  subjectKey: string;
  severity: string;
  detail: unknown;
  openedAt: Date;
  lastSeenAt: Date;
  notifyCount: number;
  lastNotifiedAt: Date | null;
  resolvedAt: Date | null;
  businessId?: number;
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const titleOf = (code: string) => (isFindingCode(code) ? FINDING_SPECS[code].titleHe : code);
const detailOf = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function isPermissionDenied(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return /permission denied/i.test(text);
}

export async function getAccountantOps(now = new Date()): Promise<AccountantOpsResponse> {
  const config = readAccountantOpsConfig();
  const db = getPrismaAdmin();
  const since = new Date(now.getTime() - RESOLVED_DAYS * 24 * 60 * 60 * 1000);
  try {
    const [platformOpen, businessOpen, platformResolved, businessResolved, sweepRuns, monitorRuns] = await Promise.all([
      db.accountantOpsAlert.findMany({ where: { resolvedAt: null }, orderBy: { openedAt: "desc" }, take: MAX_ALERTS }),
      db.accountantBusinessAlert.findMany({ where: { resolvedAt: null }, orderBy: { openedAt: "desc" }, take: MAX_ALERTS }),
      db.accountantOpsAlert.findMany({ where: { resolvedAt: { gte: since } }, orderBy: { resolvedAt: "desc" }, take: MAX_ALERTS }),
      db.accountantBusinessAlert.findMany({ where: { resolvedAt: { gte: since } }, orderBy: { resolvedAt: "desc" }, take: MAX_ALERTS }),
      db.accountantOpsRun.findMany({ where: { kind: "SWEEP" }, orderBy: { startedAt: "desc" }, take: RECENT_RUNS }),
      db.accountantOpsRun.findMany({ where: { kind: "MONITOR" }, orderBy: { startedAt: "desc" }, take: RECENT_RUNS }),
    ]);
    const ids = [...new Set([...businessOpen, ...businessResolved].map((a) => a.businessId))];
    const names = ids.length
      ? new Map((await db.business.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((b) => [b.id, b.name]))
      : new Map<number, string>();
    const view = (a: AlertRow): AccountantOpsAlertView => ({
      id: a.id,
      scope: a.businessId === undefined ? "platform" : "business",
      businessId: a.businessId ?? null,
      businessName: a.businessId === undefined ? null : names.get(a.businessId) ?? null,
      code: a.code,
      title: titleOf(a.code),
      subject: subjectLabelHe(a.subjectKey),
      severity: a.severity,
      detail: detailOf(a.detail),
      openedAt: a.openedAt.toISOString(),
      lastSeenAt: a.lastSeenAt.toISOString(),
      notifyCount: a.notifyCount,
      lastNotifiedAt: iso(a.lastNotifiedAt),
      resolvedAt: iso(a.resolvedAt),
    });
    const run = (r: (typeof sweepRuns)[number]): AccountantOpsRunView => ({
      id: r.id,
      kind: r.kind,
      source: r.source,
      startedAt: r.startedAt.toISOString(),
      finishedAt: iso(r.finishedAt),
      durationMs: r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
      outcome: r.outcome,
      errorCode: r.errorCode,
      counts: detailOf(r.counts),
    });
    const rank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
    const open = [...platformOpen.map((a) => view(a)), ...businessOpen.map((a) => view(a))].sort(
      (a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || b.openedAt.localeCompare(a.openedAt)
    );
    const resolved = [...platformResolved.map((a) => view(a)), ...businessResolved.map((a) => view(a))].sort((a, b) =>
      (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? "")
    );
    return {
      available: true,
      generatedAt: now.toISOString(),
      config,
      openAlerts: open,
      recentlyResolved: resolved.slice(0, MAX_ALERTS),
      sweepRuns: sweepRuns.map(run),
      monitorRuns: monitorRuns.map(run),
    };
  } catch (e) {
    if (isPermissionDenied(e)) return { available: false, reason: "admin_read_not_granted", config };
    throw e;
  }
}
