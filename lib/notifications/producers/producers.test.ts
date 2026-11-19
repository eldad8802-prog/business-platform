/**
 * Notification producers (notifications track PR 5) — pure checks: fakes for the gate, the tenant transaction,
 * notify() and the worker kick; a stubbed fetch for Google; static source checks on the call sites. No database,
 * no network.
 *
 *   npx tsx lib/notifications/producers/producers.test.ts
 *
 *  1. connections.disconnected event: catalog category, entity, dedupe per connection, internal href under the
 *     category prefix, generic text (no address, no phone, no digits); it classifies back to its category; the push
 *     built for it is the generic lock-screen text unless the user opted in.
 *  2. record: engine OFF ⇒ nothing (no transaction, no notify); ON ⇒ notify() exactly once with that event, the
 *     worker kicked once only when a push was owed; inside the cooldown ⇒ no kick; a failure is swallowed.
 *  3. resolve: engine OFF ⇒ nothing; ON ⇒ one tenant-scoped updateMany on that connection's dedupe key only.
 *  4. scheduling: the call sites only schedule (nothing runs synchronously); a scheduler failure or an invalid ref
 *     never reaches the domain.
 *  5. Gmail detection (oauth-refresh.service.ts): the hook fires once on `invalid_grant` only; the thrown error is
 *     identical with or without the hook, and a throwing hook changes nothing.
 *  6. Call sites (static): each hook runs AFTER the domain's own write and returns nothing to it.
 *  7. security.new_device: NOT wired (no reliable signal without a schema change) — no producer references it.
 *  8. The existing writer-based notifiers (inbox, documents queue, inventory, intake, accountant): every row they
 *     write classifies to a catalog category; the policy grants PUSH exactly where the catalog pushes by default;
 *     under default preferences only inventory critical stock may reach a device — the rest are suppressed
 *     (pref_off) by the worker.
 */
import fs from "node:fs";
import path from "node:path";

import { categoryMayPush, classifyNotification, getCategory, safeHref, type ClassifiableRow } from "../catalog";
import { decideNotification } from "../notification-policy";
import { DEFAULT_SETTINGS, resolveCategory } from "../preferences";
import { buildPushMessage } from "../push/push-content";
import { decideOwed } from "../engine/worker-decision";
import type { NotifyEvent, NotifyOutcome } from "../engine/notify";
import { DOCUMENTS_REVIEW_QUEUE_SCOPE } from "../documents-review-queue-notifications";
import { INBOX_WAITING_SCOPE } from "../inbox-waiting-notifications";
import { INVENTORY_ALERT_SCOPE } from "../inventory-alert-notifications";
import { INTAKE_NOTIFICATION_SCOPE } from "../intake-notifications";
import { translatePeriodNotice, ACCOUNTANT_ENTITY_TYPES, type NoticeKind } from "@/lib/accountant/notify";
import type { BusinessStatusItem } from "@/lib/business-status/types";
import { refreshGoogleAccessToken } from "@/lib/services/integrations/gmail/oauth-refresh.service";
import { GmailReauthRequiredError } from "@/lib/services/integrations/gmail/gmail-errors";

import {
  CONNECTION_CATEGORY,
  connectionDedupeKey,
  connectionDisconnectedEvent,
  recordConnectionDisconnected,
  resolveConnectionDisconnected,
  scheduleConnectionDisconnected,
  scheduleConnectionRestored,
  type ConnectionRef,
  type ProducerDeps,
} from "./connection-notifications";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}`, detail ?? ""); }
}

const NOW = new Date("2026-11-12T10:00:00.000Z"); // 12:00 Asia/Jerusalem — outside quiet hours
const GMAIL: ConnectionRef = { businessId: 7, provider: "gmail", connectionId: 31 };
const WA: ConnectionRef = { businessId: 7, provider: "whatsapp", connectionId: 7 };

type Calls = { gate: number; tx: number[]; notify: NotifyEvent[]; kick: number[]; updates: unknown[] };
function fakes(opts: { engineOn: boolean; outcome?: Partial<NotifyOutcome>; notifyThrows?: boolean; updated?: number }): { deps: ProducerDeps; calls: Calls } {
  const calls: Calls = { gate: 0, tx: [], notify: [], kick: [], updates: [] };
  const tx = {
    notification: {
      updateMany: async (args: unknown) => { calls.updates.push(args); return { count: opts.updated ?? 1 }; },
    },
  };
  const deps: ProducerDeps = {
    engineOn: async () => { calls.gate += 1; return opts.engineOn; },
    tenantTx: async (businessId, fn) => { calls.tx.push(businessId); return fn(tx as never); },
    notify: async (_tx, event) => {
      calls.notify.push(event);
      if (opts.notifyThrows) throw new Error("boom");
      return { notificationId: 1, created: true, notified: true, owedDeliveryId: 9, ...opts.outcome };
    },
    kick: (businessId) => { calls.kick.push(businessId); },
  };
  return { deps, calls };
}

async function main() {
  console.log("1. the event");
  const cat = getCategory(CONNECTION_CATEGORY)!;
  for (const ref of [GMAIL, WA]) {
    const e = connectionDisconnectedEvent(ref, NOW);
    ok(`${ref.provider}: category connections.disconnected`, e.category === "connections.disconnected");
    ok(`${ref.provider}: dedupe per connection`, e.dedupeKey === `conn:${ref.provider}:${ref.connectionId}` && e.dedupeKey === connectionDedupeKey(ref));
    ok(`${ref.provider}: entity = the connection`, e.entity.type === `${ref.provider}_connection` && e.entity.id === ref.connectionId);
    ok(`${ref.provider}: whole business, the catalog cooldown (24 h)`, e.userId === null && e.cooldownHours === undefined && cat.cooldownHours === 24);
    ok(`${ref.provider}: href internal under the category prefix`, safeHref(e.href, cat.hrefPrefixes) === "/settings/connections");
    const text = `${e.title} ${e.summary ?? ""}`;
    ok(`${ref.provider}: text names nobody (no digits, no @, no phone)`, !/[0-9@+]/.test(text), text);
    const row: ClassifiableRow = { domain: cat.domain, semanticCategory: e.category, severity: "MEDIUM", entityType: e.entity.type };
    ok(`${ref.provider}: the stored row classifies back to its category`, classifyNotification(row)?.key === "connections.disconnected");
    const push = buildPushMessage(cat, { id: 1, title: e.title, summary: e.summary ?? null, href: e.href, entityType: e.entity.type, entityId: e.entity.id }, { lockScreenDetails: false, ttlSeconds: 60 });
    ok(`${ref.provider}: push = generic lock-screen text (no stored title / summary)`, push.title === cat.lockScreen.title && push.body === cat.lockScreen.body);
  }
  ok("gmail and whatsapp keys never collide", connectionDedupeKey(GMAIL) !== connectionDedupeKey({ provider: "whatsapp", connectionId: 31 }));
  ok("connections.disconnected: in-app by default, push only if a user opts in", cat.defaults.inApp && !cat.defaults.push && categoryMayPush(cat));

  console.log("2. record");
  {
    const { deps, calls } = fakes({ engineOn: false });
    const out = await recordConnectionDisconnected(GMAIL, NOW, deps);
    ok("engine OFF ⇒ engine_off, no transaction, no notify, no kick", out === "engine_off" && calls.tx.length === 0 && calls.notify.length === 0 && calls.kick.length === 0, { out, calls });
  }
  {
    const { deps, calls } = fakes({ engineOn: true });
    const out = await recordConnectionDisconnected(GMAIL, NOW, deps);
    ok("engine ON ⇒ notify() once, in the business's tenant transaction", out === "notified" && calls.notify.length === 1 && calls.tx.length === 1 && calls.tx[0] === 7);
    ok("…with exactly the event", JSON.stringify(calls.notify[0]) === JSON.stringify(connectionDisconnectedEvent(GMAIL, NOW)));
    ok("…and one after-response worker kick for that business", calls.kick.length === 1 && calls.kick[0] === 7);
  }
  {
    const { deps, calls } = fakes({ engineOn: true, outcome: { owedDeliveryId: null } });
    const out = await recordConnectionDisconnected(WA, NOW, deps);
    ok("no owed push ⇒ no kick", out === "notified" && calls.kick.length === 0);
  }
  {
    const { deps, calls } = fakes({ engineOn: true, outcome: { notified: false, owedDeliveryId: null } });
    const out = await recordConnectionDisconnected(WA, NOW, deps);
    ok("inside the cooldown ⇒ cooldown, no kick", out === "cooldown" && calls.kick.length === 0);
  }
  {
    const { deps, calls } = fakes({ engineOn: true, notifyThrows: true });
    const warn = console.warn; const logs: unknown[][] = []; console.warn = (...a: unknown[]) => { logs.push(a); };
    let threw = false; let out = "";
    try { out = await recordConnectionDisconnected(GMAIL, NOW, deps); } catch { threw = true; } finally { console.warn = warn; }
    ok("a notify failure is swallowed (error), no kick", !threw && out === "error" && calls.kick.length === 0);
    ok("…its log carries the error class only", logs.length === 1 && !/boom|gmail_connection|31/.test(JSON.stringify(logs)), logs);
  }
  {
    const { deps, calls } = fakes({ engineOn: true });
    const out = await recordConnectionDisconnected({ businessId: 0, provider: "gmail", connectionId: 1 }, NOW, deps);
    const out2 = await recordConnectionDisconnected({ businessId: 1, provider: "smtp" as never, connectionId: 1 }, NOW, deps);
    ok("an invalid ref ⇒ invalid, no gate, no transaction", out === "invalid" && out2 === "invalid" && calls.gate === 0 && calls.tx.length === 0);
  }

  console.log("3. resolve");
  {
    const { deps, calls } = fakes({ engineOn: false });
    const out = await resolveConnectionDisconnected(GMAIL, NOW, deps);
    ok("engine OFF ⇒ engine_off, no transaction", out === "engine_off" && calls.tx.length === 0 && calls.updates.length === 0);
  }
  {
    const { deps, calls } = fakes({ engineOn: true, updated: 1 });
    const out = await resolveConnectionDisconnected(GMAIL, NOW, deps);
    const u = calls.updates[0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    ok("engine ON ⇒ one updateMany in the business's tenant transaction", out === "resolved" && calls.updates.length === 1 && calls.tx[0] === 7);
    ok("…scoped to this business and this connection's open notification only",
      u.where.businessId === 7 && u.where.dedupeKey === "conn:gmail:31" && u.where.resolvedAt === null && Object.keys(u.where).length === 3);
    ok("…sets resolvedAt only (no delivery, no notify)", (u.data.resolvedAt as Date).getTime() === NOW.getTime() && calls.notify.length === 0 && calls.kick.length === 0);
  }
  {
    const { deps } = fakes({ engineOn: true, updated: 0 });
    ok("nothing open ⇒ nothing_open", (await resolveConnectionDisconnected(WA, NOW, deps)) === "nothing_open");
  }

  console.log("4. scheduling");
  {
    const tasks: (() => Promise<unknown>)[] = [];
    scheduleConnectionDisconnected(GMAIL, (t) => { tasks.push(t); });
    scheduleConnectionRestored(WA, (t) => { tasks.push(t); });
    ok("each call schedules exactly one task and runs nothing synchronously", tasks.length === 2);
    let threw = false;
    try {
      scheduleConnectionDisconnected(GMAIL, () => { throw new Error("no request scope"); });
      scheduleConnectionRestored(GMAIL, () => { throw new Error("no request scope"); });
    } catch { threw = true; }
    ok("a scheduler failure never reaches the domain", !threw);
    const before = tasks.length;
    scheduleConnectionDisconnected({ businessId: -1, provider: "gmail", connectionId: 2 }, (t) => { tasks.push(t); });
    ok("an invalid ref schedules nothing", tasks.length === before);
    let threw2 = false;
    try { scheduleConnectionDisconnected(GMAIL); } catch { threw2 = true; }
    ok("the default scheduler outside a request scope (after() throws) is a silent no-op", !threw2);
  }

  console.log("5. Gmail detection");
  const realFetch = globalThis.fetch;
  async function refreshWith(status: number, body: string, onRevoked?: () => void): Promise<{ err: unknown; ok?: unknown }> {
    globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
    try {
      const r = await refreshGoogleAccessToken({ clientId: "c", clientSecret: "s", refreshToken: "r", ...(onRevoked ? { onRevoked } : {}) });
      return { err: null, ok: r };
    } catch (e) {
      return { err: e };
    } finally {
      globalThis.fetch = realFetch;
    }
  }
  {
    let n = 0;
    const grant = JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." });
    const a = await refreshWith(400, grant, () => { n += 1; });
    const b = await refreshWith(400, grant);
    ok("invalid_grant ⇒ the hook fires once", n === 1);
    const ea = a.err as GmailReauthRequiredError; const eb = b.err as GmailReauthRequiredError;
    ok("…and the thrown error is identical with or without the hook",
      ea instanceof GmailReauthRequiredError && eb instanceof GmailReauthRequiredError && ea.reason === "refresh_rejected" && ea.message === eb.message);
    const c = await refreshWith(400, grant, () => { throw new Error("hook"); });
    ok("a throwing hook changes nothing", c.err instanceof GmailReauthRequiredError && (c.err as GmailReauthRequiredError).message === eb.message);
    let m = 0;
    await refreshWith(400, JSON.stringify({ error: "invalid_request" }), () => { m += 1; });
    await refreshWith(400, JSON.stringify({ error: "unauthorized_client" }), () => { m += 1; });
    await refreshWith(503, "invalid_grant", () => { m += 1; });
    const fine = await refreshWith(200, JSON.stringify({ access_token: "x", expires_in: 3600 }), () => { m += 1; });
    ok("other 400s, 5xx and success never fire the hook", m === 0 && fine.err === null);
  }

  console.log("6. call sites (static)");
  const root = process.cwd();
  const code = (f: string) => fs.readFileSync(path.join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const wa = code("lib/services/integrations/whatsapp/connection.service.ts");
  const revokedFn = wa.slice(wa.indexOf("export async function markRevokedByMeta"), wa.indexOf("export async function recordTransientError"));
  ok("markRevokedByMeta: schedules AFTER its write, only when a row changed, returns nothing new",
    revokedFn.indexOf("await prisma.whatsAppConnection.updateMany") >= 0 &&
    revokedFn.indexOf("await prisma.whatsAppConnection.updateMany") < revokedFn.indexOf("scheduleConnectionDisconnected(") &&
    /if \(res\.count > 0\)/.test(revokedFn) && /Promise<void>/.test(revokedFn) && !/return [^;]/.test(revokedFn.replace("return;", "")));
  const seedFn = wa.slice(wa.indexOf("export async function manualSeedConnection"), wa.indexOf("export type EmbeddedSignupPersistInput"));
  ok("manualSeedConnection: resolves AFTER its upsert and returns the same row",
    seedFn.indexOf("await prisma.whatsAppConnection.upsert") < seedFn.indexOf("scheduleConnectionRestored(") && /return connection;/.test(seedFn));
  for (const f of ["lib/services/integrations/gmail/gmail-auth.service.ts", "lib/services/integrations/gmail/gmail-discovery.service.ts"]) {
    const c = code(f);
    ok(`${f}: passes the hook to the single detection point, with the resolved connection`,
      /onRevoked: \(\) =>\s*scheduleConnectionDisconnected\(\{ businessId: params\.businessId, provider: "gmail", connectionId: connection\.id \}\)/.test(c));
  }
  const cb = code("app/api/integrations/gmail/callback/route.ts");
  ok("Gmail callback: resolves only after the committed connect (not on max_accounts)",
    cb.indexOf('persistOutcome.kind === "max_accounts"') < cb.indexOf("scheduleConnectionRestored(") &&
    cb.indexOf("scheduleConnectionRestored(") < cb.indexOf("return redirectSuccess(req);"));
  const prod = code("lib/notifications/producers/connection-notifications.ts");
  ok("the producer gates on notifications_engine before any transaction", prod.indexOf("deps.engineOn(") < prod.indexOf("deps.tenantTx(") && /notificationsEngineEnabled/.test(prod));
  ok("the producer kicks the worker only for an owed push", /if \(out\.owedDeliveryId !== null\) deps\.kick\(/.test(prod));
  ok("the producer logs an error class only", (prod.match(/console\.\w+\([^;]*;/g) ?? []).every((l) => /e instanceof Error \? e\.name/.test(l)));

  console.log("7. security.new_device");
  const producers = fs.readdirSync(path.join(root, "lib/notifications/producers")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  ok("no producer writes security.new_device (no reliable new-device signal without a schema change)",
    producers.every((f) => !code(`lib/notifications/producers/${f}`).includes("security.new_device")));

  console.log("8. existing writer-based notifiers");
  const item = (domain: string, semanticCategory: string, severity: string, entityType: string) =>
    ({ domain, semanticCategory, severity, entityRef: { type: entityType, id: 1 } }) as unknown as BusinessStatusItem;
  const accountant = (kind: NoticeKind) => {
    const i = translatePeriodNotice({ businessId: 1, periodId: 3, periodKey: "2026-10" as never, status: "READY_FOR_REVIEW" as never, changedSinceSent: false, readiness: null }, kind, NOW);
    return item(i.domain, i.semanticCategory, i.severity, i.entityRef.type);
  };
  const WRITER_ROWS: [string, BusinessStatusItem, string][] = [
    ["inbox waiting", item(INBOX_WAITING_SCOPE.domain, "ACTION_REQUIRED", "HIGH", INBOX_WAITING_SCOPE.entityTypes[0]), "inbox.customer_waiting"],
    ["documents review queue", item(DOCUMENTS_REVIEW_QUEUE_SCOPE.domain, "ACTION_REQUIRED", "HIGH", DOCUMENTS_REVIEW_QUEUE_SCOPE.entityTypes[0]), "documents.review"],
    ...INVENTORY_ALERT_SCOPE.entityTypes.flatMap((t): [string, BusinessStatusItem, string][] => [
      [`inventory critical (${t})`, item("inventory", "ALERT", "CRITICAL", t), "inventory.critical_stock"],
      [`inventory attention (${t})`, item("inventory", "ALERT", "HIGH", t), "inventory.attention"],
    ]),
    ...INTAKE_NOTIFICATION_SCOPE.entityTypes.flatMap((t): [string, BusinessStatusItem, string][] => [
      [`intake ${t} HIGH`, item("leads", "ACTION_REQUIRED", "HIGH", t), "connections.disconnected"],
      [`intake ${t} MEDIUM`, item("leads", "ACTION_REQUIRED", "MEDIUM", t), "connections.disconnected"],
    ]),
    ...(Object.keys(ACCOUNTANT_ENTITY_TYPES) as NoticeKind[]).map((k): [string, BusinessStatusItem, string] => [
      `accountant ${k}`, accountant(k), k === "SEND_FAILED" ? "accountant.send_failed" : "accountant.month_close",
    ]),
  ];
  const mayReachDevice = new Set<string>();
  for (const [name, it, want] of WRITER_ROWS) {
    const row: ClassifiableRow = { domain: it.domain, semanticCategory: it.semanticCategory, severity: it.severity, entityType: it.entityRef.type };
    const c = classifyNotification(row);
    ok(`${name} → ${want}`, c?.key === want, c?.key ?? null);
    if (!c) continue;
    const decision = decideNotification(1, it, NOW);
    if (decision.notify) {
      ok(`${name}: the policy grants PUSH exactly when the catalog pushes by default`, decision.channels.includes("PUSH") === c.defaults.push, { channels: decision.channels, catalog: c.defaults.push });
    }
    const eff = resolveCategory(c, DEFAULT_SETTINGS, [], true);
    const d = decideOwed({
      now: NOW, notification: { resolvedAt: null, dismissedAt: null }, expiresAt: new Date(NOW.getTime() + 3_600_000),
      category: c, effective: eff, quiet: { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60 }, timeZone: "Asia/Jerusalem", recentSends: [],
    });
    if (d.kind === "send") mayReachDevice.add(c.key);
    else ok(`${name}: under default preferences the worker suppresses an owed push (pref_off)`, d.kind === "suppress" && d.reason === "pref_off", d);
  }
  ok("under default preferences only inventory critical stock reaches a device", JSON.stringify([...mayReachDevice]) === JSON.stringify(["inventory.critical_stock"]), [...mayReachDevice]);
  const offFeature = decideOwed({
    now: NOW, notification: { resolvedAt: null, dismissedAt: null }, expiresAt: new Date(NOW.getTime() + 3_600_000),
    category: getCategory("inventory.critical_stock"), effective: resolveCategory(getCategory("inventory.critical_stock"), DEFAULT_SETTINGS, [], false),
    quiet: { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60 }, timeZone: "Asia/Jerusalem", recentSends: [],
  });
  ok("inventory critical with the inventory feature unavailable ⇒ feature_off", offFeature.kind === "suppress" && offFeature.reason === "feature_off");

  console.log(`\n[producers] PASS=${passed} FAIL=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
