/**
 * The notification worker's WHATSAPP LANE — runWhatsAppWorker(now) (G1, appointments completion program, workstream
 * F). SERVER-ONLY. Runs from the existing worker route (/api/notifications/worker, CRON_SECRET) after the push lane.
 *
 * notification_whatsapp_due() (SECURITY DEFINER, identifiers only, live businesses only) lists the owed customer
 * messages; each is then handled inside ITS OWN business's tenant transaction:
 *   0. entitlement (customer-entitlement.ts, once per business per pass): not entitled ⇒ SUPPRESSED 'not_entitled';
 *   1. CLAIM: a conditional UPDATE sets leaseUntil = now + 2 min while the row is PENDING, due and not leased — one
 *      winner among concurrent workers (the push lane's lease, the same 2 minutes);
 *   2. decide: expired (expiresAt, else creation + the category's TTL) ⇒ FAILED 'expired'; a VERIFICATION row (its
 *      code is never stored; its caller sends it at once — one found here was orphaned) ⇒ FAILED 'not_retryable';
 *      phone erased ⇒ SUPPRESSED 'erased'; the appointment no longer in the state the message announces, or moved
 *      away from the start it was made for ⇒ SUPPRESSED 'stale'; the quota hook (usage.ts — null today) exceeded ⇒
 *      SUPPRESSED 'quota'; quiet hours (22:00–08:00 business time, quietBypass false) ⇒ nextAttemptAt = 08:00, or
 *      FAILED 'quiet' when that is past the expiry;
 *   3. compose, from the LIVE rows: the business name (always — owner rule), service, date, time, and for a public
 *      booking a fresh manage link (a new hashed token, live mode only; the customer's earlier links stay valid);
 *   4. send OUTSIDE any transaction (platform-transport.ts: simulate unless live + credentials);
 *   5. record on THE SAME ROW: sent ⇒ SENT + providerMessageId (write-once, DB-enforced); transient ⇒ attempts + 1 and
 *      the engine's backoff (1 m, 5 m, 15 m, 1 h; the 5th failure ends it: 'retries_exhausted'), never past the
 *      expiry; permanent ⇒ FAILED. A retry never adds a row — one row per logical message, so no duplicate send and
 *      no double count.
 * Counts only in the report and the log: never a phone, a name, a code or a text.
 */
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { normalizeAppBaseUrl } from "@/lib/email/transactional/config";
import { isQuietHours, manageLinkExpiry, newManageToken, quietHoursEnd, safeTimeZone, sha256Hex } from "@/lib/services/booking/booking.core";

import { getCustomerCategory, type CustomerCategoryDefinition } from "../catalog";
import { retryAfter } from "../engine/worker-decision";
import { startOfKey } from "./appointment-messages";
import { customerMessagesEntitlement } from "./customer-entitlement";
import { platformConfig, sendPlatformTemplate, type TransportDeps, type TransportResult } from "./platform-transport";
import { customerMessageQuota, monthlyCustomerMessageUsageInTx, withinQuota } from "./usage";
import { buildTemplateParams, templateByName, type TemplateValues } from "./whatsapp-templates";

type Tx = Prisma.TransactionClient;

export const WA_LEASE_MS = 2 * 60_000;
const BATCH = 100;

export type WhatsAppReport = {
  owed: number;
  claimed: number;
  sent: number;
  simulated: number;
  retried: number;
  deferred: number;
  failed: number;
  expired: number;
  suppressed: number;
  notEntitled: number;
  errors: number;
};

export type WhatsAppWorkerOptions = {
  limit?: number;
  businessId?: number;
  deliveryIds?: number[];
  transport?: TransportDeps;
  /** Test seam: entitlement of a business. */
  entitled?: (businessId: number) => Promise<boolean>;
  quiet?: boolean;
};

const emptyReport = (): WhatsAppReport => ({
  owed: 0, claimed: 0, sent: 0, simulated: 0, retried: 0, deferred: 0, failed: 0, expired: 0, suppressed: 0, notEntitled: 0, errors: 0,
});

const toUtc = (d: Date) => d.toISOString().replace("T", " ").replace("Z", "");

async function dueIds(now: Date, opts: WhatsAppWorkerOptions): Promise<{ businessId: number; deliveryId: number }[]> {
  const limit = Math.min(Math.max(opts.limit ?? BATCH, 1), 500);
  if (opts.businessId !== undefined) {
    const businessId = opts.businessId;
    const rows = await tenantTx(businessId, (tx) =>
      tx.notificationDelivery.findMany({
        where: {
          businessId, status: "PENDING", recipientKind: "CUSTOMER",
          ...(opts.deliveryIds ? { id: { in: opts.deliveryIds } } : {}),
          AND: [{ OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }, { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }],
        },
        select: { id: true },
        orderBy: [{ nextAttemptAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
        take: limit,
      }),
    );
    return rows.map((r) => ({ businessId, deliveryId: r.id }));
  }
  const rows = await prisma.$queryRaw<{ businessId: number; deliveryId: number }[]>`
    SELECT "businessId", "deliveryId" FROM public.notification_whatsapp_due(${toUtc(now)}::timestamp(3), ${limit}::int)`;
  return rows.map((r) => ({ businessId: Number(r.businessId), deliveryId: Number(r.deliveryId) }));
}

export async function runWhatsAppWorker(now: Date = new Date(), opts: WhatsAppWorkerOptions = {}): Promise<WhatsAppReport> {
  const report = emptyReport();
  const due = await dueIds(now, opts);
  report.owed = due.length;
  const byBusiness = new Map<number, number[]>();
  for (const d of due) byBusiness.set(d.businessId, [...(byBusiness.get(d.businessId) ?? []), d.deliveryId]);
  for (const [businessId, ids] of byBusiness) {
    try {
      const entitled = opts.entitled ? await opts.entitled(businessId) : (await customerMessagesEntitlement(businessId)).allowed;
      for (const id of ids) {
        try {
          await processOwed(businessId, id, now, entitled, opts.transport ?? {}, report);
        } catch {
          report.errors += 1;
        }
      }
    } catch {
      report.errors += 1;
    }
  }
  if (!opts.quiet) console.log("[notifications] whatsapp lane", JSON.stringify(report));
  return report;
}

type SendPlan = {
  lease: Date;
  id: number;
  attempts: number;
  expiry: Date;
  toPhone: string;
  templateName: string;
  bodyParams: string[];
};

async function processOwed(
  businessId: number, id: number, now: Date, entitled: boolean, transport: TransportDeps, report: WhatsAppReport,
): Promise<void> {
  const plan = await tenantTx(businessId, (tx) => claimAndDecide(tx, businessId, id, now, entitled, transport, report));
  if (!plan) return;
  const result = await sendPlatformTemplate({ toPhone: plan.toPhone, templateName: plan.templateName, languageCode: "he", bodyParams: plan.bodyParams }, transport)
    .catch((): TransportResult => ({ kind: "transient", code: "transport_threw" }));
  await tenantTx(businessId, (tx) => recordResult(tx, businessId, plan, result, now, report));
}

const fmtDate = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("he-IL", { weekday: "long", day: "numeric", month: "numeric", timeZone: tz }).format(d);
const fmtTime = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("he-IL", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(d);

/** Is the appointment still in the state the message announces, at the start it was made for? */
export function stillFits(cat: CustomerCategoryDefinition, appt: { status: string; startsAt: Date | null; erasedAt: Date | null }, dedupeKey: string): boolean {
  if (appt.erasedAt !== null || appt.startsAt === null) return false;
  const want: Record<string, string> = {
    "appointments.customer_received": "PROPOSED",
    "appointments.customer_confirmed": "CONFIRMED",
    "appointments.customer_changed": "CONFIRMED|PROPOSED",
    "appointments.customer_reminder": "CONFIRMED",
    "appointments.customer_cancelled": "CANCELED",
  };
  const states = want[cat.key];
  if (!states || !states.split("|").includes(appt.status)) return false;
  const start = startOfKey(dedupeKey);
  return start !== null && start.getTime() === appt.startsAt.getTime();
}

async function claimAndDecide(
  tx: Tx, businessId: number, id: number, now: Date, entitled: boolean, transport: TransportDeps, report: WhatsAppReport,
): Promise<SendPlan | null> {
  const lease = new Date(now.getTime() + WA_LEASE_MS);
  const claim = await tx.notificationDelivery.updateMany({
    where: {
      id, businessId, status: "PENDING", recipientKind: "CUSTOMER", providerMessageId: null,
      AND: [{ OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }],
    },
    data: { leaseUntil: lease },
  });
  if (claim.count !== 1) return null;
  report.claimed += 1;

  const finish = async (status: "FAILED" | "SUPPRESSED", error: string) => {
    await tx.notificationDelivery.updateMany({
      where: { id, businessId, status: "PENDING", leaseUntil: lease },
      data: { status, error, completedAt: now, leaseUntil: null },
    });
    if (error === "expired") report.expired += 1;
    else if (error === "not_entitled") report.notEntitled += 1;
    else if (status === "SUPPRESSED") report.suppressed += 1;
    else report.failed += 1;
    return null;
  };

  const row = await tx.notificationDelivery.findFirst({
    where: { id, businessId },
    select: {
      id: true, attempts: true, expiresAt: true, createdAt: true, recipientPhone: true, templateKey: true, messageClass: true, appointmentId: true,
      notification: { select: { semanticCategory: true, dedupeKey: true } },
    },
  });
  if (!row) return null;
  const cat = getCustomerCategory(row.notification.semanticCategory);
  if (!cat) return finish("FAILED", "unknown_category");
  const expiry = row.expiresAt ?? new Date(row.createdAt.getTime() + cat.ttlMinutes * 60_000);
  if (expiry.getTime() <= now.getTime()) return finish("FAILED", "expired");
  if (row.messageClass === "VERIFICATION") return finish("FAILED", "not_retryable");
  if (!entitled) return finish("SUPPRESSED", "not_entitled");
  if (!row.recipientPhone) return finish("SUPPRESSED", "erased");
  const template = row.templateKey ? templateByName(row.templateKey) : null;
  if (!template) return finish("FAILED", "unknown_template");

  const settings = await tx.bookingSettings.findFirst({ where: { businessId }, select: { timeZone: true } });
  const tz = safeTimeZone(settings?.timeZone);
  const business = await tx.business.findFirst({ where: { id: businessId }, select: { name: true } });
  const values: TemplateValues = { business: business?.name ?? "" };
  let apptForLink: { id: number; startsAt: Date | null } | null = null;

  if (row.appointmentId !== null) {
    const appt = await tx.appointment.findFirst({
      where: { id: row.appointmentId, businessId },
      select: { id: true, status: true, startsAt: true, erasedAt: true, title: true, businessServiceId: true },
    });
    if (!appt || !stillFits(cat, appt, row.notification.dedupeKey)) return finish("SUPPRESSED", "stale");
    const service = appt.businessServiceId
      ? await tx.businessService.findFirst({ where: { id: appt.businessServiceId, businessId }, select: { name: true } })
      : null;
    values.service = service?.name ?? appt.title ?? "תור";
    values.date = fmtDate(appt.startsAt!, tz);
    values.time = fmtTime(appt.startsAt!, tz);
    apptForLink = appt;
  }

  const quota = await customerMessageQuota(businessId);
  if (quota !== null) {
    const used = await monthlyCustomerMessageUsageInTx(tx, businessId, now);
    if (!withinQuota(used.sent, quota)) return finish("SUPPRESSED", "quota");
  }

  if (!cat.quietBypass && isQuietHours(now, tz)) {
    const end = quietHoursEnd(now, tz);
    if (end.getTime() >= expiry.getTime()) return finish("FAILED", "quiet");
    await tx.notificationDelivery.updateMany({
      where: { id, businessId, status: "PENDING", leaseUntil: lease },
      data: { nextAttemptAt: end, leaseUntil: null },
    });
    report.deferred += 1;
    return null;
  }

  // The manage link is minted LAST — after every reason not to send now — so a deferred or refused message never
  // leaves a token behind.
  if (apptForLink && template.params.includes("link")) {
    const base = normalizeAppBaseUrl((transport.env ?? process.env).APP_BASE_URL?.trim() ?? "");
    if (!base) return finish("FAILED", "no_link_base");
    if (platformConfig(transport.env ?? process.env).mode === "live") {
      // A fresh link for this message (only its hash is stored); the customer's earlier links stay valid.
      const token = newManageToken();
      await tx.appointmentManageToken.create({
        data: { businessId, appointmentId: apptForLink.id, tokenHash: sha256Hex(token), expiresAt: manageLinkExpiry(now, apptForLink.startsAt!), createdAt: now },
      });
      values.link = `${base}/book/manage#${token}`;
    } else {
      values.link = `${base}/book/manage`; // simulate: no token is minted for a message that is never sent
    }
  }

  const bodyParams = buildTemplateParams(template, values);
  if (!bodyParams) return finish("FAILED", "template_params");
  return { lease, id, attempts: row.attempts, expiry, toPhone: row.recipientPhone, templateName: template.name, bodyParams };
}

async function recordResult(tx: Tx, businessId: number, plan: SendPlan, result: TransportResult, now: Date, report: WhatsAppReport): Promise<void> {
  const attempts = plan.attempts + 1;
  if (result.kind === "sent") {
    // Recorded even if the lease ran out meanwhile: the message WAS handed over. providerMessageId is write-once.
    const n = await tx.notificationDelivery.updateMany({
      where: { id: plan.id, businessId, status: "PENDING", providerMessageId: null },
      data: { status: "SENT", providerMessageId: result.providerMessageId, attempts, error: null, completedAt: now, leaseUntil: null },
    });
    if (n.count === 1) {
      report.sent += 1;
      if (result.simulated) report.simulated += 1;
    } else {
      report.errors += 1;
    }
    return;
  }
  if (result.kind === "transient") {
    const next = retryAfter(attempts, now);
    if (next !== null && next.getTime() < plan.expiry.getTime()) {
      await tx.notificationDelivery.updateMany({
        where: { id: plan.id, businessId, status: "PENDING", leaseUntil: plan.lease },
        data: { attempts, nextAttemptAt: next, leaseUntil: null, error: `transient:${result.code}`.slice(0, 64) },
      });
      report.retried += 1;
      return;
    }
    await tx.notificationDelivery.updateMany({
      where: { id: plan.id, businessId, status: "PENDING", leaseUntil: plan.lease },
      data: { status: "FAILED", attempts, error: next === null ? "retries_exhausted" : "expired", completedAt: now, leaseUntil: null },
    });
    if (next === null) report.failed += 1;
    else report.expired += 1;
    return;
  }
  await tx.notificationDelivery.updateMany({
    where: { id: plan.id, businessId, status: "PENDING", leaseUntil: plan.lease },
    data: { status: "FAILED", attempts, error: `permanent:${result.code}`.slice(0, 64), completedAt: now, leaseUntil: null },
  });
  report.failed += 1;
}
