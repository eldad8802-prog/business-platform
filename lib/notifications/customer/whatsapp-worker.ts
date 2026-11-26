/**
 * The notification worker's WHATSAPP LANE — runWhatsAppWorker(now) (G1, appointments completion program, workstream
 * F). SERVER-ONLY. Runs from the existing worker route (/api/notifications/worker, CRON_SECRET) after the push lane.
 *
 * notification_whatsapp_due() (SECURITY DEFINER, identifiers only, live businesses only) lists the owed customer
 * messages; each is then handled inside ITS OWN business's tenant transaction:
 *   0. entitlement (customer-entitlement.ts, once per business per pass): not entitled ⇒ SUPPRESSED 'not_entitled';
 *   1. CLAIM: a conditional UPDATE sets leaseUntil = now + 2 min while the row is PENDING, due and not leased — one
 *      winner among concurrent workers (the push lane's lease, the same 2 minutes);
 *   2. decide: an earlier attempt that STARTED but recorded no outcome (see "duplicate-proof" below) ⇒ uncertain, never
 *      resent; expired (expiresAt, else creation + the category's TTL) ⇒ FAILED 'expired'; a VERIFICATION row (its
 *      code is never stored; its caller sends it at once — one found here was orphaned) ⇒ FAILED 'not_retryable';
 *      WHATSAPP_PLATFORM_SEND_MODE=off (the WhatsApp emergency stop) ⇒ deferred 10 minutes, error 'send_stopped' —
 *      nothing sent, nothing lost while still useful, nothing duplicated; phone erased ⇒ SUPPRESSED 'erased'; the
 *      appointment no longer in the state the message announces, or moved away from the start it was made for ⇒
 *      SUPPRESSED 'stale'; the quota hook (usage.ts — null today) exceeded ⇒ SUPPRESSED 'quota'; quiet hours
 *      (22:00–08:00 business time, quietBypass false) ⇒ nextAttemptAt = 08:00, or FAILED 'quiet' past the expiry;
 *   3. compose, from the LIVE rows: the business name (always — owner rule), service, date, time, and for a public
 *      booking a fresh manage link (a new hashed token, live mode only; the customer's earlier links stay valid);
 *   4. send OUTSIDE any transaction (platform-transport.ts);
 *   5. record on THE SAME ROW, fenced by the attempt's token: sent ⇒ SENT + providerMessageId (write-once,
 *      DB-enforced); transient (Meta answered: not accepted) ⇒ attempts + 1 and the engine's backoff (1 m, 5 m, 15 m,
 *      1 h; the 5th failure ends it: 'retries_exhausted'), never past the expiry; permanent ⇒ FAILED; uncertain ⇒ see
 *      below. A retry never adds a row — one row per logical message, so no double count.
 *
 * DUPLICATE-PROOF ACROSS LEASE EXPIRY (owner item 6). A message is resent only when it is PROVEN not to have been
 * accepted by Meta:
 *   a. Fence: before the send, the claim transaction stamps the row 'inflight:<token>' (a fresh random token per
 *      attempt) and the token rides with the request as Meta's biz_opaque_callback_data ("dz1:b<biz>:d<row>:<token>"),
 *      which Meta echoes in every status webhook of that message.
 *   b. Bounded send: the request is aborted before the lease can run out — the deadline is the smaller of the send
 *      timeout (15 s) and the lease left minus a 30 s margin; with less than 1 s left nothing is sent (re-queued).
 *   c. Only a Meta ANSWER that says "not accepted" (4xx / 429) is retried. A 5xx, a timeout, an abort or a network
 *      error is UNCERTAIN: the row becomes 'uncertain:<token>' and waits 15 minutes for the status webhook, which
 *      finds it by the echoed token and records SENT with Meta's id (whatsapp-status.ts). Still unresolved after the
 *      wait ⇒ FAILED 'unresolved:<token>' — never resent (a late webhook can still record it as SENT).
 *   d. A claim that finds 'inflight:<token>' (a worker died or overran mid-send) does NOT send: it marks the row
 *      uncertain as in (c). The late worker's own outcome still lands (its token matches), so a message that did go
 *      out is recorded exactly once.
 * Counts only in the report and the log: never a phone, a name, a code or a text.
 */
import { randomBytes } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { normalizeAppBaseUrl } from "@/lib/email/transactional/config";
import { isQuietHours, manageLinkExpiry, newManageToken, quietHoursEnd, safeTimeZone, sha256Hex } from "@/lib/services/booking/booking.core";
import { TEMPLATE_SEND_TIMEOUT_MS } from "@/lib/services/integrations/whatsapp/graph.service";

import { getCustomerCategory, type CustomerCategoryDefinition } from "../catalog";
import { retryAfter } from "../engine/worker-decision";
import { startOfKey } from "./appointment-messages";
import { customerMessagesEntitlement } from "./customer-entitlement";
import { platformConfig, sendPlatformTemplate, type TransportDeps, type TransportResult } from "./platform-transport";
import { customerMessageQuota, monthlyCustomerMessageUsageInTx, withinQuota } from "./usage";
import { buildTemplateParams, templateByName, type TemplateValues } from "./whatsapp-templates";

type Tx = Prisma.TransactionClient;

export const WA_LEASE_MS = 2 * 60_000;
/** The send must end this long before the lease does. */
export const SEND_MARGIN_MS = 30_000;
/** How long an uncertain attempt waits for its status webhook before it is closed (never resent). */
export const UNCERTAIN_WAIT_MS = 15 * 60_000;
/** How often a hard-stopped (send mode off) owed message is looked at again. */
export const STOP_RECHECK_MS = 10 * 60_000;
const BATCH = 100;

export type WhatsAppReport = {
  owed: number;
  claimed: number;
  sent: number;
  simulated: number;
  retried: number;
  deferred: number;
  /** Owed messages held by WHATSAPP_PLATFORM_SEND_MODE=off. */
  stopped: number;
  /** Attempts whose outcome is unknown (Meta may have accepted them): waiting for the status webhook, never resent. */
  uncertain: number;
  /** Uncertain attempts the webhook never resolved: closed FAILED 'unresolved:…', never resent. */
  unresolved: number;
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
  /** Test seam: the real-time clock the send deadline is measured on (default Date.now). */
  clock?: () => number;
  quiet?: boolean;
};

const emptyReport = (): WhatsAppReport => ({
  owed: 0, claimed: 0, sent: 0, simulated: 0, retried: 0, deferred: 0, stopped: 0, uncertain: 0, unresolved: 0,
  failed: 0, expired: 0, suppressed: 0, notEntitled: 0, errors: 0,
});

const toUtc = (d: Date) => d.toISOString().replace("T", " ").replace("Z", "");

/** The attempt fence: the row's marker and Meta's echoed callback data. */
export const fence = {
  newToken: () => randomBytes(16).toString("base64url"),
  inflight: (t: string) => `inflight:${t}`,
  uncertain: (t: string) => `uncertain:${t}`,
  unresolved: (t: string) => `unresolved:${t}`,
  callback: (businessId: number, deliveryId: number, t: string) => `dz1:b${businessId}:d${deliveryId}:${t}`,
  /** The token of a marker, or null. */
  tokenOf: (error: string | null, state: "inflight" | "uncertain" | "unresolved"): string | null => {
    const m = error ? new RegExp(`^${state}:([A-Za-z0-9_-]{22})$`).exec(error) : null;
    return m ? m[1] : null;
  },
  parseCallback: (data: string | null | undefined): { businessId: number; deliveryId: number; token: string } | null => {
    const m = typeof data === "string" ? /^dz1:b([1-9][0-9]{0,9}):d([1-9][0-9]{0,9}):([A-Za-z0-9_-]{22})$/.exec(data) : null;
    return m ? { businessId: Number(m[1]), deliveryId: Number(m[2]), token: m[3] } : null;
  },
};

/** Pure: how long the send may take, given the claim's real time and now — null when too little lease is left. */
export function sendDeadlineMs(claimedAtMs: number, nowMs: number): number | null {
  const left = WA_LEASE_MS - (nowMs - claimedAtMs) - SEND_MARGIN_MS;
  const ms = Math.min(TEMPLATE_SEND_TIMEOUT_MS, left);
  return ms >= 1000 ? ms : null;
}

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
          await processOwed(businessId, id, now, entitled, opts, report);
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
  token: string;
  claimedAtMs: number;
};

async function processOwed(
  businessId: number, id: number, now: Date, entitled: boolean, opts: WhatsAppWorkerOptions, report: WhatsAppReport,
): Promise<void> {
  const clock = opts.clock ?? Date.now;
  const transport = opts.transport ?? {};
  const plan = await tenantTx(businessId, (tx) => claimAndDecide(tx, businessId, id, now, entitled, transport, report, clock));
  if (!plan) return;
  const deadline = sendDeadlineMs(plan.claimedAtMs, clock());
  if (deadline === null) {
    // Too little lease left to send safely: nothing was sent — give the row back as it was (due now).
    await tenantTx(businessId, (tx) => tx.notificationDelivery.updateMany({
      where: { id, businessId, status: "PENDING", error: fence.inflight(plan.token) },
      data: { error: null, leaseUntil: null, nextAttemptAt: now },
    }));
    report.deferred += 1;
    return;
  }
  const result = await sendPlatformTemplate({
    toPhone: plan.toPhone, templateName: plan.templateName, languageCode: "he", bodyParams: plan.bodyParams,
    callbackData: fence.callback(businessId, id, plan.token), signal: AbortSignal.timeout(deadline),
  }, transport).catch((): TransportResult => ({ kind: "uncertain", code: "transport_threw" }));
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
  clock: () => number,
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
  const claimedAtMs = clock();

  const finish = async (status: "FAILED" | "SUPPRESSED", error: string) => {
    await tx.notificationDelivery.updateMany({
      where: { id, businessId, status: "PENDING", leaseUntil: lease },
      data: { status, error, completedAt: now, leaseUntil: null },
    });
    if (error === "expired") report.expired += 1;
    else if (error === "not_entitled") report.notEntitled += 1;
    else if (error.startsWith("unresolved:")) report.unresolved += 1;
    else if (status === "SUPPRESSED") report.suppressed += 1;
    else report.failed += 1;
    return null;
  };
  const hold = async (until: Date, error: string | null) => {
    await tx.notificationDelivery.updateMany({
      where: { id, businessId, status: "PENDING", leaseUntil: lease },
      data: { nextAttemptAt: until, leaseUntil: null, error },
    });
    return null;
  };

  const row = await tx.notificationDelivery.findFirst({
    where: { id, businessId },
    select: {
      id: true, attempts: true, expiresAt: true, createdAt: true, recipientPhone: true, templateKey: true, messageClass: true,
      appointmentId: true, error: true,
      notification: { select: { semanticCategory: true, dedupeKey: true } },
    },
  });
  if (!row) return null;

  // ── (d) an earlier attempt started and recorded nothing: it MAY have been sent — never resend blindly ───────────────
  const inflight = fence.tokenOf(row.error, "inflight");
  if (inflight) {
    report.uncertain += 1;
    return hold(new Date(now.getTime() + UNCERTAIN_WAIT_MS), fence.uncertain(inflight));
  }
  const uncertain = fence.tokenOf(row.error, "uncertain");
  if (uncertain) return finish("FAILED", fence.unresolved(uncertain)); // the webhook never resolved it: closed, not resent

  const cat = getCustomerCategory(row.notification.semanticCategory);
  if (!cat) return finish("FAILED", "unknown_category");
  const expiry = row.expiresAt ?? new Date(row.createdAt.getTime() + cat.ttlMinutes * 60_000);
  if (expiry.getTime() <= now.getTime()) return finish("FAILED", "expired");
  if (row.messageClass === "VERIFICATION") return finish("FAILED", "not_retryable");
  if (!entitled) return finish("SUPPRESSED", "not_entitled");
  // ── the WhatsApp emergency stop: held, not lost (it expires on its own schedule), not duplicated (same row) ────────
  if (platformConfig(transport.env ?? process.env).mode === "off") {
    report.stopped += 1;
    return hold(new Date(Math.min(now.getTime() + STOP_RECHECK_MS, expiry.getTime())), "send_stopped");
  }
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
    report.deferred += 1;
    return hold(end, null);
  }

  const bodyParamsBase = template.params.includes("link") ? null : buildTemplateParams(template, values);
  if (!template.params.includes("link") && !bodyParamsBase) return finish("FAILED", "template_params");

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
  const bodyParams = bodyParamsBase ?? buildTemplateParams(template, values);
  if (!bodyParams) return finish("FAILED", "template_params");

  // ── (a) the fence: this attempt's token, stamped in the same transaction as the claim ──────────────────────────────
  const token = fence.newToken();
  await tx.notificationDelivery.updateMany({
    where: { id, businessId, status: "PENDING", leaseUntil: lease },
    data: { error: fence.inflight(token), attemptedAt: now },
  });
  return { lease, id, attempts: row.attempts, expiry, toPhone: row.recipientPhone, templateName: template.name, bodyParams, token, claimedAtMs };
}

async function recordResult(tx: Tx, businessId: number, plan: SendPlan, result: TransportResult, now: Date, report: WhatsAppReport): Promise<void> {
  const attempts = plan.attempts + 1;
  const t = plan.token;
  /** Rows of THIS attempt that are still undecided (the fence). */
  const mine = { OR: [{ error: fence.inflight(t) }, { error: fence.uncertain(t) }] };
  if (result.kind === "sent") {
    // Recorded whatever happened meanwhile (another claim marked it uncertain, the wait closed it unresolved): the
    // message WAS handed over, once. providerMessageId is write-once (DB guard).
    const n = await tx.notificationDelivery.updateMany({
      where: {
        id: plan.id, businessId, providerMessageId: null, status: { in: ["PENDING", "FAILED"] },
        OR: [{ error: fence.inflight(t) }, { error: fence.uncertain(t) }, { error: fence.unresolved(t) }],
      },
      data: { status: "SENT", providerMessageId: result.providerMessageId, attempts, error: null, completedAt: now, leaseUntil: null },
    });
    const already = n.count === 0
      ? await tx.notificationDelivery.count({ where: { id: plan.id, businessId, providerMessageId: result.providerMessageId } })
      : 0; // the status webhook may have recorded it first (same Meta id)
    if (n.count === 1 || already === 1) {
      report.sent += 1;
      if (result.simulated) report.simulated += 1;
    } else {
      report.errors += 1;
    }
    return;
  }
  if (result.kind === "stopped") {
    await tx.notificationDelivery.updateMany({
      where: { id: plan.id, businessId, status: "PENDING", error: fence.inflight(t) },
      data: { error: "send_stopped", nextAttemptAt: new Date(Math.min(now.getTime() + STOP_RECHECK_MS, plan.expiry.getTime())), leaseUntil: null },
    });
    report.stopped += 1;
    return;
  }
  if (result.kind === "uncertain") {
    const n = await tx.notificationDelivery.updateMany({
      where: { id: plan.id, businessId, status: "PENDING", error: fence.inflight(t) },
      data: { attempts, error: fence.uncertain(t), nextAttemptAt: new Date(now.getTime() + UNCERTAIN_WAIT_MS), leaseUntil: null },
    });
    report.uncertain += n.count; // 0 when another claim already marked it uncertain
    return;
  }
  // Meta ANSWERED and did not accept it: safe to retry (transient) or final (permanent) — even if another claim had
  // marked the attempt uncertain meanwhile.
  if (result.kind === "transient") {
    const next = retryAfter(attempts, now);
    if (next !== null && next.getTime() < plan.expiry.getTime()) {
      await tx.notificationDelivery.updateMany({
        where: { id: plan.id, businessId, status: "PENDING", ...mine },
        data: { attempts, nextAttemptAt: next, leaseUntil: null, error: `transient:${result.code}`.slice(0, 64) },
      });
      report.retried += 1;
      return;
    }
    await tx.notificationDelivery.updateMany({
      where: { id: plan.id, businessId, status: "PENDING", ...mine },
      data: { status: "FAILED", attempts, error: next === null ? "retries_exhausted" : "expired", completedAt: now, leaseUntil: null },
    });
    if (next === null) report.failed += 1;
    else report.expired += 1;
    return;
  }
  await tx.notificationDelivery.updateMany({
    where: { id: plan.id, businessId, status: "PENDING", ...mine },
    data: { status: "FAILED", attempts, error: `permanent:${result.code}`.slice(0, 64), completedAt: now, leaseUntil: null },
  });
  report.failed += 1;
}
