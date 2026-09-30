/**
 * Business Intake M5 — the lead lifecycle contract, pure (no database, no LLM).
 *
 *   npx tsx lib/services/crm/lead-lifecycle.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LEAD_LIFECYCLE_EVENT_KINDS,
  LEAD_NEXT_ACTION_KINDS,
  customerWroteSinceLastActivity,
  leadOriginFor,
  parseLeadAmount,
  suggestNextAction,
  suggestionDueAt,
  type LeadLifecycleFacts,
} from "./lead-lifecycle-core";
import { LEAD_REASON_EVIDENCE, evaluateLeadAttention } from "./lead-attention";
import { deriveLeadBriefing, type LeadBriefingFacts } from "./lead-briefing";

let passed = 0;
const failed: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed.push(name);
    console.log(`  FAIL  ${name} — ${(e as Error).message}`);
  }
}

const NOW = new Date("2026-10-05T09:00:00.000Z"); // 12:00 Israel
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const facts = (over: Partial<LeadLifecycleFacts> = {}): LeadLifecycleFacts => ({
  status: "OPEN",
  nextFollowUpAt: null,
  createdAt: day(20),
  lastActivityAt: day(1),
  ...over,
});

/* ── vocabularies mirror the migration's CHECKs ───────────────────────────── */
const migration = readFileSync("prisma/migrations/20261002090000_crm_lead_lifecycle/migration.sql", "utf8");
check("every next-action kind is in the migration's CHECK vocabulary", () => {
  for (const k of LEAD_NEXT_ACTION_KINDS) assert.ok(migration.includes(`'${k}'`), k);
});
check("every lifecycle event kind is in the migration's CHECK vocabulary", () => {
  for (const k of LEAD_LIFECYCLE_EVENT_KINDS) assert.ok(migration.includes(`'${k}'`), k);
});

/* ── money ────────────────────────────────────────────────────────────────── */
check("amounts: non-negative, ≤ 2 decimals, fixed-point string; null clears", () => {
  assert.equal(parseLeadAmount(4750.5), "4750.50");
  assert.equal(parseLeadAmount("1200"), "1200.00");
  assert.equal(parseLeadAmount(0), "0.00");
  assert.equal(parseLeadAmount(null), null);
  assert.throws(() => parseLeadAmount(-1));
  assert.throws(() => parseLeadAmount(1.005));
  assert.throws(() => parseLeadAmount("abc"));
  assert.throws(() => parseLeadAmount(Number.POSITIVE_INFINITY));
});

/* ── origin vocabulary ────────────────────────────────────────────────────── */
check("origin: intake / import / auto-capture / conversation / manual", () => {
  assert.equal(leadOriginFor("intake:reference.lead_form", "INTEGRATION"), "INTAKE");
  assert.equal(leadOriginFor("MANUAL", "IMPORT"), "IMPORT");
  assert.equal(leadOriginFor("WHATSAPP", "SYSTEM"), "AUTO_CAPTURE");
  assert.equal(leadOriginFor("WHATSAPP", "OWNER_UI"), "CONVERSATION");
  assert.equal(leadOriginFor("MANUAL", "OWNER_UI"), "MANUAL");
});

/* ── suggestions: proposals, deterministic, dismissible ───────────────────── */
check("no suggestion for a closed lead, or when the owner already has a next action", () => {
  assert.equal(suggestNextAction(facts({ status: "WON" }), NOW), null);
  assert.equal(suggestNextAction(facts({ status: "QUOTED", lastActivityAt: day(9), nextFollowUpAt: day(-1) }), NOW), null);
});
check("NEW without a next action → S1 call today", () => {
  const s = suggestNextAction(facts({ status: "NEW" }), NOW);
  assert.equal(s?.ruleId, "S1_CONTACT_NEW@1");
  assert.equal(s?.kind, "call");
});
check("QUOTED idle ≥ 3 days → S2 check quote; idle 2 days → nothing", () => {
  assert.equal(suggestNextAction(facts({ status: "QUOTED", lastActivityAt: day(3) }), NOW)?.ruleId, "S2_CHECK_QUOTE@1");
  assert.equal(suggestNextAction(facts({ status: "QUOTED", lastActivityAt: day(2) }), NOW), null);
});
check("OPEN/QUALIFIED idle ≥ 7 days → S3; 6 days → nothing", () => {
  assert.equal(suggestNextAction(facts({ status: "QUALIFIED", lastActivityAt: day(7) }), NOW)?.ruleId, "S3_REVIVE_STALLED@1");
  assert.equal(suggestNextAction(facts({ status: "OPEN", lastActivityAt: day(6) }), NOW), null);
});
check("customer wrote after the last lead activity → S4 first (a fact beats an inference)", () => {
  const s = suggestNextAction(facts({ status: "QUOTED", lastActivityAt: day(5), lastCustomerInboundAt: day(1) }), NOW);
  assert.equal(s?.ruleId, "S4_REPLY_CUSTOMER@1");
});
check("a dismissed rule stays quiet; the next applicable rule may still speak", () => {
  const f = facts({ status: "QUOTED", lastActivityAt: day(5), lastCustomerInboundAt: day(1) });
  assert.equal(suggestNextAction({ ...f, dismissedRuleIds: ["S4_REPLY_CUSTOMER@1"] }, NOW)?.ruleId, "S2_CHECK_QUOTE@1");
  assert.equal(suggestNextAction({ ...f, dismissedRuleIds: ["S4_REPLY_CUSTOMER@1", "S2_CHECK_QUOTE@1"] }, NOW), null);
});
check("a suggestion's due moment is today 10:00 Israel, or +1h once that has passed", () => {
  const early = new Date("2026-10-05T04:00:00.000Z");
  assert.equal(suggestionDueAt({ ruleId: "S1_CONTACT_NEW@1", kind: "call", dueInDays: 0, label: "", why: "" }, early).toISOString(), "2026-10-05T08:00:00.000Z");
  const late = suggestionDueAt({ ruleId: "S1_CONTACT_NEW@1", kind: "call", dueInDays: 0, label: "", why: "" }, NOW);
  assert.equal(late.getTime(), NOW.getTime() + 3_600_000);
});
check("a message is never lead activity: an inbound BEFORE the last lead write is not 'customer wrote'", () => {
  assert.equal(customerWroteSinceLastActivity(facts({ lastActivityAt: day(1), lastCustomerInboundAt: day(2) })), false);
  assert.equal(customerWroteSinceLastActivity(facts({ lastActivityAt: day(2), lastCustomerInboundAt: day(1) })), true);
});

/* ── attention: reasons, evidence classes, bands ──────────────────────────── */
check("every attention reason declares FACT or INFERENCE", () => {
  for (const [r, c] of Object.entries(LEAD_REASON_EVIDENCE)) assert.ok(c === "fact" || c === "inference", r);
  assert.equal(LEAD_REASON_EVIDENCE.FOLLOWUP_OVERDUE, "fact");
  assert.equal(LEAD_REASON_EVIDENCE.STALLED, "inference");
  assert.equal(LEAD_REASON_EVIDENCE.QUOTE_NO_ACTIVITY, "inference");
});
check("closed leads ask nothing and propose nothing", () => {
  for (const status of ["WON", "LOST", "DROPPED"] as const) {
    const a = evaluateLeadAttention({ ...facts({ status }), lastCustomerInboundAt: NOW, openIdentityProposals: 2 }, NOW);
    assert.equal(a.needsAttention, false);
    assert.equal(a.suggestion ?? null, null);
  }
});
check("bands stay ordered: overdue > customer wrote > due today > awaiting decision > new > quote > stalled", () => {
  const p = (over: Partial<LeadLifecycleFacts & { openIdentityProposals: number }>) =>
    evaluateLeadAttention({ ...facts(), ...over, lastCustomerInboundAt: over.lastCustomerInboundAt ?? null }, NOW);
  const overdue = p({ nextFollowUpAt: day(30) });
  const wrote = p({ lastCustomerInboundAt: new Date(NOW.getTime() - 60_000) });
  const today = p({ nextFollowUpAt: new Date(NOW.getTime() + 3_600_000) });
  const decide = p({ openIdentityProposals: 1 });
  const fresh = p({ status: "NEW", createdAt: day(40), lastActivityAt: day(40) });
  const quote = p({ status: "QUOTED", lastActivityAt: day(40) });
  const stalled = p({ status: "OPEN", lastActivityAt: day(40) });
  assert.deepEqual(
    [overdue, wrote, today, decide, fresh, quote, stalled].map((a) => a.reason),
    ["FOLLOWUP_OVERDUE", "CUSTOMER_WROTE", "FOLLOWUP_DUE_TODAY", "AWAITING_OWNER_DECISION", "NEW_UNHANDLED", "QUOTE_NO_ACTIVITY", "STALLED"]
  );
  const ps = [overdue, wrote, today, decide, fresh, quote, stalled].map((a) => a.priority);
  for (let i = 1; i < ps.length; i++) assert.ok(ps[i - 1] > ps[i], `band ${i}: ${ps[i - 1]} > ${ps[i]}`);
});
check("pre-M5 callers (no lifecycle facts) keep exactly the W2 behaviour", () => {
  const a = evaluateLeadAttention({ status: "QUOTED", nextFollowUpAt: null, createdAt: day(40) }, NOW);
  assert.equal(a.reason, null);
  assert.equal(a.nextAction.kind, "set_followup");
});

/* ── the Secretary's briefing ─────────────────────────────────────────────── */
const row = (id: number, over: Partial<LeadBriefingFacts>): LeadBriefingFacts => ({
  id, customerName: `L${id}`, status: "OPEN", nextFollowUpAt: null, followUpNote: null,
  createdAt: day(20), lastActivityAt: day(1), lastCustomerInboundAt: null, openIdentityProposals: 0, ...over,
});
check("briefing counts per reason, top items by priority, CRITICAL on overdue", () => {
  const b = deriveLeadBriefing([
    row(1, { nextFollowUpAt: day(2) }),
    row(2, { status: "NEW", createdAt: day(3), lastActivityAt: day(3) }),
    row(3, { openIdentityProposals: 1 }),
    row(4, { status: "WON" }),
    row(5, {}),
  ], NOW);
  assert.equal(b.counts.open, 4);
  assert.equal(b.counts.FOLLOWUP_OVERDUE, 1);
  assert.equal(b.counts.NEW_UNHANDLED, 1);
  assert.equal(b.counts.AWAITING_OWNER_DECISION, 1);
  assert.equal(b.counts.needsAttention, 3);
  assert.equal(b.state, "CRITICAL");
  assert.deepEqual(b.items.map((i) => i.leadId), [1, 3, 2]);
  assert.ok(b.items.every((i) => i.evidenceClass === "fact" || i.evidenceClass === "inference"));
});
check("briefing is CALM when nothing asks for the owner", () => {
  assert.equal(deriveLeadBriefing([row(1, {})], NOW).state, "CALM");
});

/* ── AI boundary (structural) ─────────────────────────────────────────────── */
check("no LLM / AI client anywhere in the lifecycle, attention, briefing or loader code", () => {
  for (const f of [
    "lib/services/crm/lead-lifecycle-core.ts",
    "lib/services/crm/lead-lifecycle.service.ts",
    "lib/services/crm/lead-attention.ts",
    "lib/services/crm/lead-briefing.ts",
    "lib/business-status/translators/leads.ts",
    "app/api/leads/briefing/route.ts",
  ]) {
    const src = readFileSync(f, "utf8");
    // Imports and network calls, not prose: a comment saying "no LLM" is not a dependency.
    assert.ok(!/from\s+["'][^"']*(openai|anthropic|llm|brain\/provider)[^"']*["']|\bfetch\s*\(|new\s+OpenAI\b/i.test(src), f);
  }
});

console.log(failed.length === 0
  ? `\nM5 LEAD LIFECYCLE CORE PASS — ${passed} checks green.`
  : `\nM5 LEAD LIFECYCLE CORE FAIL — ${failed.length} failed of ${passed + failed.length}: ${failed.join("; ")}`);
if (failed.length) process.exit(1);
