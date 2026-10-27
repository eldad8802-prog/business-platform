/**
 * Leads L1 · G-05 — the shared "needs attention" queue, pure suite. Run with:
 *   npx tsx lib/services/crm/lead-attention-queue.test.ts
 *
 * No database. Pins:
 *   - urgency decides the order BEFORE any cap: a customer who called / wrote (no follow-up date)
 *     outranks routine follow-ups due today, so a cap of 8 can never cut them
 *   - every evaluator reason is in the queue (not only "follow-up due" / "new before today")
 *   - closed leads, a NEW lead created today (current 1-day grace) and a quiet open lead are not
 *   - Home (business-status), /leads needsAction, the list ranking and the count all read THIS queue
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { rankLeadAttention, type LeadAttentionRaw } from "./lead-attention-queue";

let checks = 0;
function test(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}

console.log("\nLeads L1 · G-05 attention queue — pure suite\n");

const NOW = new Date("2026-10-28T09:00:00.000Z"); // 11:00 in Israel
const day = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * day);
let nextId = 1;
const lead = (over: Partial<LeadAttentionRaw>): LeadAttentionRaw => ({
  id: nextId++,
  customerName: null,
  status: "OPEN",
  nextFollowUpAt: null,
  followUpNote: null,
  createdAt: ago(2),
  lastActivityAt: NOW,
  lastCustomerInboundAt: null,
  lastUnreturnedCallAt: null,
  openIdentityProposals: 0,
  ...over,
});

const routine = Array.from({ length: 9 }, () => lead({ nextFollowUpAt: NOW }));
const called = lead({ lastActivityAt: ago(1), lastUnreturnedCallAt: ago(0.01) });
const wrote = lead({ lastActivityAt: ago(2), lastCustomerInboundAt: ago(0.01) });
const awaiting = lead({ openIdentityProposals: 1 });
const quote = lead({ status: "QUOTED", lastActivityAt: ago(5) });
const stalled = lead({ status: "QUALIFIED", lastActivityAt: ago(12) });
const overdue = lead({ nextFollowUpAt: ago(3) });
const staleNew = lead({ status: "NEW", createdAt: ago(3), lastActivityAt: ago(3) });
const newToday = lead({ status: "NEW", createdAt: ago(0.05), lastActivityAt: ago(0.05) });
const quiet = lead({});
const won = lead({ status: "WON", nextFollowUpAt: ago(4) });

// The order the OLD SQL capped by: follow-up date ASC NULLS LAST — callers / writers last.
const sqlOrder = [...routine, overdue, staleNew, newToday, quiet, won, called, wrote, awaiting, quote, stalled];
const queue = rankLeadAttention(sqlOrder, NOW);
const reasons = queue.map((i) => i.attention.reason);

test("every evaluator reason is in the queue, not only follow-up / new-before-today", () => {
  for (const r of ["FOLLOWUP_OVERDUE", "CUSTOMER_CALLED", "CUSTOMER_WROTE", "FOLLOWUP_DUE_TODAY", "AWAITING_OWNER_DECISION",
    "NEW_UNHANDLED", "QUOTE_NO_ACTIVITY", "STALLED"]) assert.ok(reasons.includes(r as never), r);
});

test("urgency orders the queue BEFORE any cap: overdue → called → wrote → due today …", () => {
  assert.deepEqual(queue.slice(0, 3).map((i) => i.row.id), [overdue.id, called.id, wrote.id]);
  const top8 = queue.slice(0, 8).map((i) => i.row.id);
  assert.ok(top8.includes(called.id) && top8.includes(wrote.id), "a cap of 8 keeps the customer who called and who wrote");
  for (let i = 1; i < queue.length; i++) assert.ok(queue[i - 1].attention.priority >= queue[i].attention.priority);
});

test("closed, quiet and NEW-created-today leads are not in the queue (current 1-day grace kept)", () => {
  const ids = new Set(queue.map((i) => i.row.id));
  for (const l of [won, quiet, newToday]) assert.equal(ids.has(l.id), false, String(l.id));
  assert.equal(queue.length, sqlOrder.length - 3);
});

test("ties break by the clock that made it urgent, then id — deterministic", () => {
  const again = rankLeadAttention([...sqlOrder].reverse(), NOW).map((i) => i.row.id);
  assert.deepEqual(again, queue.map((i) => i.row.id));
});

test("structural: Home, the needsAction list, the ranking, the count and the API read the ONE queue", () => {
  const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
  assert.match(read("lib/business-status/loaders.ts"), /loadLeadAttentionQueue\(db, businessId, now\)/);
  const svc = read("lib/services/crm/lead.service.ts");
  const list = svc.slice(svc.indexOf("async listLeads("), svc.indexOf("async listUrgentCandidates("));
  assert.match(list, /where\.id = \{ in: \[\.\.\.ids\] \}/);
  assert.doesNotMatch(list, /startOfLeadDayUtc|endOfLeadDayUtc/, "listLeads keeps no narrow copy of the predicate");
  const count = svc.slice(svc.indexOf("async countNeedingAttention("), svc.indexOf("async createFromConversation("));
  assert.match(count, /loadLeadAttentionQueue\(db, input\.businessId, now\)\)\.items\.length/);
  assert.doesNotMatch(count, /startOfLeadDayUtc|endOfLeadDayUtc/);
  assert.match(svc.slice(svc.indexOf("async listUrgentCandidates(")), /\{ id: \{ in: \[\.\.\.attentionIds\] \} \}/);
  const route = read("app/api/leads/route.ts");
  assert.match(route, /loadLeadAttentionQueue\(tx, user\.businessId, now, t\)/);
  assert.match(route, /toListRow\(l, now, intelligence\.get\(l\.id\)\?\.intelligence \?\? null, t, queued\.get\(l\.id\)\)/);
});

console.log(`\nALL L1 ATTENTION-QUEUE TESTS PASSED — ${checks} checks\n`);
