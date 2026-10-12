/**
 * Daily Tasks milestone B — the agenda, the sync and the actions on a real database, AS THE RESTRICTED RUNTIME
 * (NOSUPERUSER NOBYPASSRLS, a member of app_runtime), over the real migration (built by .dt/lab.sh):
 *
 *   Flag (13): daily_tasks is OFF by default and per business.
 *   Read-only (8.6, T-C6, T-Y1): GET's service writes nothing — proven by row counts AND by running it in a child
 *     process whose every transaction is READ ONLY; a series without its open occurrence is returned as a
 *     pendingRepair row, REPAIR_PENDING, nothing stored.
 *   Sync (8.6–8.7, T-Y2, T-Y5, T-C7): the repair creates ONE occurrence (SYSTEM), syncVersion rises; a second call
 *     inside the lease is IN_PROGRESS; two parallel syncs → one runs; a repeat changes nothing.
 *   Cycles (8.5, T-C4, T-C8): a new cycle is recorded once; a FAILED or CAPPED source closes nothing; a complete
 *     result closes the vanished cycle with ONE SOURCE_CLOSED_OBSERVED, however many syncs follow.
 *   Display state (3.4, 12.3): handled-for-today hides the item; a replay is the same answer; another business
 *     cannot act on an item it does not see.
 *   Domain routing (3.3, 3.5): a payment reminder postponed through tasks moves the obligation's followUpAt only —
 *     the debt stays visible and counted; "טופל" writes handledAt only, never a payment.
 *   Money (12.12, T-I7, T-M2…T-M5): "שילמתי" records ONE payment through the payment service with the secretary's
 *     key; the same key replays; the same key with another amount is refused BEFORE the payment service; another
 *     key with the same content is still one payment; no amount enters the journal.
 *   Preferences: switching a source off is journaled once and hides it.
 *   Isolation: business B sees none of A's rows and B's sync never touches A.
 *
 * env: DATABASE_URL / DIRECT_URL = the runtime login (app_runtime_prod), OWNER_URL = the migration role (fixtures
 * only). Synthetic data only. Run: npx tsx lib/services/tasks/agenda.service.db.test.ts
 */
import { spawnSync } from "node:child_process";

import { PrismaClient } from "@prisma/client";

process.env.TASK_REQUEST_HMAC_KEY ??= "daily-tasks-lab-hmac-key-0123456789abcdef";
process.env.TASK_REQUEST_HMAC_KEY_ID ??= "lab1";
process.env.SECRETARY_LEDGER_STORE = "true";

const IS_RO_CHILD = process.env.DT_AGENDA_RO_CHILD === "1";

let failed = 0;
let checks = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  checks += 1;
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failed += 1;
    console.log(`  [FAIL] ${name}`, extra ?? "");
  }
}

/** The child: GET's service on a connection where every transaction is READ ONLY. Prints one JSON line. */
async function roChild() {
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { getAgenda } = await import("./agenda.service");
  const businessId = Number(process.env.DT_BUSINESS_ID);
  try {
    const a = await runWithTenantContext({ businessId }, () => getAgenda(businessId));
    console.log(JSON.stringify({ ok: true, integrity: a.integrity, repairs: a.buckets.flatMap((b) => b.rows).filter((r) => r.type === "REPAIR").length }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: (e as Error).message.slice(0, 200) }));
  }
  process.exit(0);
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const { jerusalemDayKey, addCalendarDays } = await import("@/lib/utils/jerusalem-day");
  const { recognizeObligation } = await import("@/lib/services/obligations/obligation.service");
  const { obligationServiceDeps } = await import("@/lib/services/obligations/obligations.deps");
  const { uuidV7 } = await import("./task-idempotency");
  const svc = await import("./task.service");
  const { getAgenda } = await import("./agenda.service");
  const { runSync, SYNC_LEASE_MS } = await import("./sync.service");
  const actions = await import("./source-actions.service");
  const prefs = await import("./preferences.service");
  const { dailyTasksEnabled } = await import("./tasks-http");

  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  const NOW = new Date();
  const TODAY = jerusalemDayKey(NOW);
  let tick = 0;
  const key = () => uuidV7(new Date(NOW.getTime() - 5000 + ++tick));
  const as = <T>(businessId: number, fn: () => Promise<T>) => runWithTenantContext({ businessId }, fn);
  const code = async (p: Promise<unknown>) => {
    try { await p; return "OK"; } catch (e) { return e instanceof svc.TaskServiceError ? e.code : `ERR:${(e as Error).message.slice(0, 80)}`; }
  };
  const later = (min: number) => new Date(NOW.getTime() + min * 60_000);
  const taskTableCounts = async (businessId: number) =>
    JSON.stringify(await Promise.all([
      owner.task.count({ where: { businessId } }),
      owner.taskSeries.count({ where: { businessId } }),
      owner.taskEvent.count({ where: { businessId } }),
      owner.taskSourceState.count({ where: { businessId } }),
      owner.taskPreferences.count({ where: { businessId } }),
      owner.taskRequestLedger.count({ where: { businessId } }),
    ]));

  // ── Fixtures (owner) ─────────────────────────────────────────────────────────────────────────
  const bizA = await owner.business.create({ data: { name: "dt-b-A" } });
  const bizB = await owner.business.create({ data: { name: "dt-b-B" } });
  const uA = await owner.user.create({ data: { email: `ba-${Date.now()}@dt.lab`, password: "x", businessId: bizA.id } });
  const uB = await owner.user.create({ data: { email: `bb-${Date.now()}@dt.lab`, password: "x", businessId: bizB.id } });
  const A = { businessId: bizA.id, userId: uA.id };
  const B = { businessId: bizB.id, userId: uB.id };

  try {
    // ── Flag ─────────────────────────────────────────────────────────────────────────────────
    console.log("flag");
    ok("daily_tasks is OFF by default", (await dailyTasksEnabled(A.businessId)) === false);
    await owner.businessFeatureAccess.create({ data: { businessId: A.businessId, featureKey: "daily_tasks", state: "ENABLED" } });
    ok("ON for the business it was enabled for", (await dailyTasksEnabled(A.businessId)) === true);
    ok("…and still OFF for another business", (await dailyTasksEnabled(B.businessId)) === false);

    // ── Read-only agenda + pending repair (T-C6, T-Y1) ───────────────────────────────────────
    console.log("read-only agenda");
    const series = await as(A.businessId, () => svc.createSeries(A, { idempotencyKey: key(), now: NOW }, { title: "לספור מלאי", rule: { kind: "DAILY" }, startOn: TODAY }));
    const seriesId = series.series!.id;
    // An abnormal state: the active series lost its open occurrence (as after a crash between steps).
    await owner.task.updateMany({ where: { businessId: A.businessId, seriesId, status: "OPEN" }, data: { status: "DONE", completedAt: NOW } });
    const before = await taskTableCounts(A.businessId);
    const ag1 = await as(A.businessId, () => getAgenda(A.businessId, NOW));
    ok("T-Y1: REPAIR_PENDING with a computed 'מתעדכנת…' row", ag1.integrity.includes("REPAIR_PENDING") && ag1.buckets.some((b) => b.rows.some((r) => r.type === "REPAIR")));
    ok("T-Y1: the empty state is blocked", ag1.emptyAllowed === false);
    ok("T-C6: GET wrote nothing (every task table unchanged)", (await taskTableCounts(A.businessId)) === before);
    const roUrl = `${process.env.DATABASE_URL}${process.env.DATABASE_URL!.includes("?") ? "&" : "?"}options=-c%20default_transaction_read_only%3Don`;
    const child = spawnSync(process.execPath, [...process.execArgv, __filename], {
      env: { ...process.env, DT_AGENDA_RO_CHILD: "1", DT_BUSINESS_ID: String(A.businessId), DATABASE_URL: roUrl, DIRECT_URL: roUrl },
      encoding: "utf8",
      timeout: 120_000,
    });
    const line = (child.stdout ?? "").split("\n").find((l) => l.startsWith("{")) ?? "{}";
    const ro = JSON.parse(line) as { ok?: boolean; integrity?: string[]; repairs?: number; error?: string };
    ok("T-C6: the same agenda is served by a READ ONLY database session", ro.ok === true && ro.repairs === 1 && !!ro.integrity?.includes("REPAIR_PENDING"), ro.error ?? line.slice(0, 200));

    // ── Sync: lease, repair, idempotence (T-Y2, T-Y5, T-C7) ──────────────────────────────────
    console.log("sync");
    const s1 = await as(A.businessId, () => runSync(A.businessId, NOW));
    ok("T-Y2: the sync repaired the series and raised syncVersion", s1.status === "OK" && s1.repaired === 1 && s1.syncVersion === 1, s1);
    ok("T-Y2: exactly one open occurrence now", (await owner.task.count({ where: { businessId: A.businessId, seriesId, status: "OPEN" } })) === 1);
    const repairEvents = await owner.taskEvent.findMany({ where: { businessId: A.businessId, seriesId, idempotencyKey: { startsWith: "sync:repair:" } } });
    ok("the repair is journaled once, as SYSTEM, no acting user", repairEvents.length === 1 && repairEvents[0].actor === "SYSTEM" && repairEvents[0].actorUserId === null);
    const s2 = await as(A.businessId, () => runSync(A.businessId, later(0.5)));
    ok("T-Y5: a second sync inside the lease → IN_PROGRESS with Retry-After", s2.status === "IN_PROGRESS" && s2.retryAfterSeconds > 0 && s2.retryAfterSeconds <= SYNC_LEASE_MS / 1000, s2);
    const ag2 = await as(A.businessId, () => getAgenda(A.businessId, later(1)));
    ok("after the sync the list is COMPLETE again", ag2.integrity.join() === "COMPLETE" && ag2.lastSyncAt !== null, ag2.integrity);
    const s3 = await as(A.businessId, () => runSync(A.businessId, later(3)));
    ok("T-C7: a repeat sync changes nothing (no repair, same syncVersion)", s3.status === "OK" && s3.repaired === 0 && s3.syncVersion === 1 && !s3.changed, s3);
    // Parallel: two tabs open at once (T-Y5) — one runs, one waits; still one occurrence.
    await owner.task.updateMany({ where: { businessId: A.businessId, seriesId, status: "OPEN" }, data: { status: "DONE", completedAt: NOW } });
    const [p1, p2] = await Promise.all([as(A.businessId, () => runSync(A.businessId, later(6))), as(A.businessId, () => runSync(A.businessId, later(6)))]);
    ok("T-Y5: two parallel syncs → one OK, one IN_PROGRESS", [p1.status, p2.status].sort().join() === "IN_PROGRESS,OK", [p1.status, p2.status]);
    ok("T-Y5: …and one open occurrence", (await owner.task.count({ where: { businessId: A.businessId, seriesId, status: "OPEN" } })) === 1);
    const failedSync = await code(as(A.businessId, () => runSync(A.businessId, later(9), async () => { throw new Error("boom"); })));
    const prefsAfterFail = await owner.taskPreferences.findUnique({ where: { businessId: A.businessId } });
    ok("a failed sync records lastSyncFailedAt and releases the lease", failedSync.startsWith("ERR") && !!prefsAfterFail?.lastSyncFailedAt && prefsAfterFail.syncLeaseUntil === null);

    // ── Cycles and closures (T-C4, T-C8) ─────────────────────────────────────────────────────
    console.log("cycles");
    type Res = Awaited<ReturnType<typeof import("./sources").runAllAdapters>>;
    const stockItem = {
      sourceKind: "stock" as const, dedupeKey: "inventory_alert:990001", cycleKey: "a990001", evidenceVersion: "tc", placement: "TODAY" as const,
      dueOn: null, severity: "HIGH" as const, title: "x", fact: "", factAt: null, action: { label: "x", href: "/inventory/alerts" }, snooze: "STATE" as const,
    };
    const with_ = (status: "OK" | "FAILED" | "CAPPED", items: (typeof stockItem)[]) => async (): Promise<Res> => [{ kind: "stock", status, items }];
    let t = 12;
    const sync = (fn: () => Promise<Res>) => as(A.businessId, () => runSync(A.businessId, later((t += 3)), fn));
    const c1 = await sync(with_("OK", [stockItem]));
    ok("a new cycle is recorded once", c1.status === "OK" && c1.newCycles === 1);
    const c2 = await sync(with_("OK", [stockItem]));
    ok("…and not again while it stays", c2.status === "OK" && c2.newCycles === 0 && c2.closed === 0);
    const closedEvents = () => owner.taskEvent.count({ where: { businessId: A.businessId, eventType: "SOURCE_CLOSED_OBSERVED", dedupeKey: stockItem.dedupeKey } });
    await sync(with_("FAILED", []));
    ok("T-C8: a FAILED source closes nothing", (await closedEvents()) === 0);
    await sync(with_("CAPPED", []));
    ok("T-C8: a CAPPED source closes nothing", (await closedEvents()) === 0);
    const c5 = await sync(with_("OK", []));
    ok("a complete result closes the vanished cycle", c5.status === "OK" && c5.closed === 1 && (await closedEvents()) === 1);
    await sync(with_("OK", []));
    await sync(with_("OK", []));
    ok("T-C4: three more syncs → still one closure event", (await closedEvents()) === 1);
    const closedEv = await owner.taskEvent.findFirst({ where: { businessId: A.businessId, eventType: "SOURCE_CLOSED_OBSERVED" } });
    ok("the closure is SYSTEM, with no acting user", closedEv?.actor === "SYSTEM" && closedEv.actorUserId === null);
    // B runs a sync with the same item key: its own row, A's untouched.
    await as(B.businessId, () => runSync(B.businessId, NOW, with_("OK", [stockItem])));
    ok("isolation: B's sync wrote B's cycle only", (await owner.taskSourceState.count({ where: { businessId: B.businessId } })) === 1 && (await owner.taskSourceState.count({ where: { businessId: A.businessId, closedObservedAt: null } })) === 0);

    // ── A real business item: a supplier payment from the secretary's ledger ─────────────────
    console.log("supplier payment (routed + money)");
    const yesterday = addCalendarDays(TODAY, -1);
    const ob = await tenantTx(A.businessId, (tx) =>
      recognizeObligation({ businessId: A.businessId, obligeeName: "ספק בדיקה", amount: "500", dueAt: new Date(`${yesterday}T09:00:00.000Z`) }, obligationServiceDeps({ tx })),
    );
    const ref = { sourceKind: "supplier_payment", dedupeKey: `obligation:${ob.id}` };
    const findRow = async (businessId: number) =>
      (await as(businessId, () => getAgenda(businessId))).buckets.flatMap((b) => b.rows).find((r) => r.type === "SOURCE" && r.item.dedupeKey === ref.dedupeKey);
    ok("the overdue payment is on A's agenda", !!(await findRow(A.businessId)));
    ok("isolation: B's agenda does not show it", !(await findRow(B.businessId)));
    ok("12.3: B cannot act on A's item", (await code(as(B.businessId, () => actions.setDisplayState(B, { idempotencyKey: key() }, ref, "pin")))) === "NOT_FOUND");
    ok("12.3: an item that does not exist is refused", (await code(as(A.businessId, () => actions.setDisplayState(A, { idempotencyKey: key() }, { sourceKind: "stock", dedupeKey: "inventory_alert:1" }, "acknowledge")))) === "NOT_FOUND");

    const pinKey = key();
    const pin1 = await as(A.businessId, () => actions.setDisplayState(A, { idempotencyKey: pinKey }, ref, "pin"));
    const pin2 = await as(A.businessId, () => actions.setDisplayState(A, { idempotencyKey: pinKey }, ref, "pin"));
    ok("pin: replay → the same answer, no second event", pin2.replayed && pin2.sourceStateId === pin1.sourceStateId && (await owner.taskEvent.count({ where: { businessId: A.businessId, eventType: "SOURCE_ITEM_PINNED" } })) === 1);
    ok("pinned rows carry 'חשוב'", (await findRow(A.businessId))?.pinned === true);
    ok("a display snooze is refused where the domain owns the slot", (await code(as(A.businessId, () => actions.setDisplayState(A, { idempotencyKey: key() }, ref, "snooze", addCalendarDays(TODAY, 2))))) === "INVALID_STATE");

    const tomorrow = addCalendarDays(TODAY, 1);
    await as(A.businessId, () => actions.routeDomainAction(A, { idempotencyKey: key() }, ref, "payment_snooze", tomorrow));
    const wf1 = await owner.installmentWorkflow.findUnique({ where: { installmentId: ob.id } });
    ok("3.5: 'דחה תזכורת' wrote the obligation's followUpAt only", !!wf1?.followUpAt && wf1.handledAt === null);
    const row1 = await findRow(A.businessId);
    ok("3.5: the debt stays visible and counted, tagged as postponed", !!row1 && row1.type === "SOURCE" && !!row1.item.reminderPostponed && row1.tags.some((tg) => tg.tone === "snooze"));

    const payments = () => owner.payment.count({ where: { businessId: A.businessId } });
    const k1 = key();
    const paid1 = await as(A.businessId, () => actions.recordPaidViaTasks(A, { idempotencyKey: k1 }, { ...ref, amount: "100.00", paidAt: TODAY, method: "BANK_TRANSFER" }));
    ok("T-M2: 'שילמתי' recorded one payment", (await payments()) === 1 && !!paid1.paymentId);
    const paid2 = await as(A.businessId, () => actions.recordPaidViaTasks(A, { idempotencyKey: k1 }, { ...ref, amount: "100.00", paidAt: TODAY, method: "BANK_TRANSFER" }));
    ok("T-I1: the same key replays the same payment", paid2.replayed && paid2.paymentId === paid1.paymentId && (await payments()) === 1);
    ok("T-I7: the same key with another amount is refused before the payment service", (await code(as(A.businessId, () => actions.recordPaidViaTasks(A, { idempotencyKey: k1 }, { ...ref, amount: "200.00", paidAt: TODAY, method: "BANK_TRANSFER" })))) === "IDEMPOTENCY_KEY_REUSED" && (await payments()) === 1);
    const paid3 = await as(A.businessId, () => actions.recordPaidViaTasks(A, { idempotencyKey: key() }, { ...ref, amount: "100.00", paidAt: TODAY, method: "BANK_TRANSFER" }));
    ok("T-M3: another key, same content → still one payment (the secretary's key)", paid3.paymentId === paid1.paymentId && (await payments()) === 1);
    ok("an unknown payment method is refused", (await code(as(A.businessId, () => actions.recordPaidViaTasks(A, { idempotencyKey: key() }, { ...ref, amount: "1.00", paidAt: TODAY, method: "GOLD" })))) === "INVALID_INPUT");
    ok("B cannot pay A's item", (await code(as(B.businessId, () => actions.recordPaidViaTasks(B, { idempotencyKey: key() }, { ...ref, amount: "1.00", paidAt: TODAY, method: "CASH" })))) === "NOT_FOUND" && (await owner.payment.count({ where: { businessId: B.businessId } })) === 0);

    await as(A.businessId, () => actions.routeDomainAction(A, { idempotencyKey: key() }, ref, "payment_handled"));
    const wf2 = await owner.installmentWorkflow.findUnique({ where: { installmentId: ob.id } });
    ok("'טופל' wrote handledAt — and no payment", !!wf2?.handledAt && (await payments()) === 1);
    ok("the handled reminder left the agenda", !(await findRow(A.businessId)));

    const allPayloads = (await owner.taskEvent.findMany({ where: { businessId: A.businessId }, select: { payload: true } })).map((e) => JSON.stringify(e.payload));
    ok("T-M5: no amount, balance or name in the journal", allPayloads.every((p) => !/amount|remaining|balance|"500|100\.00|ספק/.test(p)));

    // ── Display state on a business item ─────────────────────────────────────────────────────
    console.log("handled for today");
    const ob2 = await tenantTx(A.businessId, (tx) =>
      recognizeObligation({ businessId: A.businessId, obligeeName: "ספק שני", amount: "80", dueAt: new Date(`${TODAY}T09:00:00.000Z`) }, obligationServiceDeps({ tx })),
    );
    const ref2 = { sourceKind: "supplier_payment", dedupeKey: `obligation:${ob2.id}` };
    const ackKey = key();
    const ack1 = await as(A.businessId, () => actions.setDisplayState(A, { idempotencyKey: ackKey }, ref2, "acknowledge"));
    const hidden = !(await as(A.businessId, () => getAgenda(A.businessId))).buckets.flatMap((b) => b.rows).some((r) => r.type === "SOURCE" && r.item.dedupeKey === ref2.dedupeKey);
    ok("handled for today hides the item", hidden);
    const ack2 = await as(A.businessId, () => actions.setDisplayState(A, { idempotencyKey: ackKey }, ref2, "acknowledge"));
    ok("a replay is the same answer, one event", ack2.replayed && ack2.sourceStateId === ack1.sourceStateId && (await owner.taskEvent.count({ where: { businessId: A.businessId, eventType: "SOURCE_ITEM_ACKNOWLEDGED" } })) === 1);
    const ackEv = await owner.taskEvent.findFirst({ where: { businessId: A.businessId, eventType: "SOURCE_ITEM_ACKNOWLEDGED" } });
    ok("the owner's action is journaled as OWNER_USER with the item's keys", ackEv?.actor === "OWNER_USER" && ackEv.dedupeKey === ref2.dedupeKey && !!ackEv.cycleKey);

    // ── Preferences ──────────────────────────────────────────────────────────────────────────
    console.log("preferences");
    const pk = key();
    await as(A.businessId, () => prefs.setSourceEnabled(A, { idempotencyKey: pk }, "stock", false));
    await as(A.businessId, () => prefs.setSourceEnabled(A, { idempotencyKey: pk }, "stock", false));
    const view = await as(A.businessId, () => prefs.getPreferences(A.businessId));
    ok("a source switched off is journaled once", (await owner.taskEvent.count({ where: { businessId: A.businessId, eventType: "SOURCE_DISABLED" } })) === 1);
    ok("…shown as off and reported by the agenda", view.sources.find((x) => x.kind === "stock")?.enabled === false && (await as(A.businessId, () => getAgenda(A.businessId))).disabledSources.includes("stock"));
    ok("an unknown source is refused", (await code(as(A.businessId, () => prefs.setSourceEnabled(A, { idempotencyKey: key() }, "weather", false)))) === "INVALID_INPUT");

    // ── Isolation of the agenda ──────────────────────────────────────────────────────────────
    console.log("isolation");
    const agB = await as(B.businessId, () => getAgenda(B.businessId));
    ok("B's agenda holds none of A's tasks or series", agB.series.length === 0 && agB.buckets.every((b) => b.rows.every((r) => r.type !== "TASK" && r.type !== "REPAIR")));
    ok("B never got a task row from A's syncs", (await owner.task.count({ where: { businessId: B.businessId } })) === 0);
    void prisma;
  } finally {
    // Synthetic fixtures stay in the disposable lab database; nothing here ever runs against Production.
    await owner.$disconnect();
  }

  console.log(`\nagenda / sync / actions (runtime role): ${checks - failed}/${checks} checks hold.`);
  if (failed > 0) {
    console.error(`${failed} FAILED`);
    process.exit(1);
  }
  process.exit(0);
}

if (IS_RO_CHILD) void roChild();
else
  main().catch((e) => {
    console.error("agenda db test crashed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
