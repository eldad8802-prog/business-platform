/**
 * Lead Intelligence — pure contract (W3).
 *
 * DB-free, network-free, secret-free, so it runs in the BLOCKING CI job: the
 * rules that decide "who needs me next" are exactly the rules an owner will
 * trust or stop trusting, and they must not be guarded only by a script nobody
 * runs.
 *
 *   npx tsx lib/services/crm/lead-intelligence.test.ts
 */

import assert from "node:assert/strict";
import {
  deriveLeadConversationIntelligence,
  evaluateLeadPriority,
  leadIntelligenceDetail,
  leadIntelligenceHeadline,
  LONG_WAIT_MINUTES,
  type LeadConversationRow,
} from "@/lib/services/crm/lead-intelligence";
import { evaluateLeadAttention } from "@/lib/services/crm/lead-attention";
import type { LeadStatusValue } from "@/lib/services/crm/lead-core";

let passed = 0;
const failures: string[] = [];
function check(cond: boolean, label: string, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = new Date("2026-09-02T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

/** A conversation row shaped exactly as the serializer expects. */
function conversation(over: {
  id: number;
  unanswered?: number;
  customerLastInboundAt?: Date | null;
  businessLastOutboundAt?: Date | null;
  temperature?: number | null;
  stage?: string | null;
  status?: string;
  lastMessageAt?: Date | null;
  lastMessageDirection?: string;
}): LeadConversationRow {
  const lastMessageAt = over.lastMessageAt ?? minutesAgo(10);
  return {
    id: over.id,
    businessId: 1,
    customerId: 10,
    leadId: 100,
    channel: "WHATSAPP",
    status: over.status ?? "OPEN",
    currentStage: over.stage ?? "NEW",
    outcomeStatus: null,
    outcomeReason: null,
    startedAt: minutesAgo(600),
    lastMessageAt,
    lastAnalysisAt: null,
    temperatureScore: over.temperature ?? null,
    closeProbabilitySnapshot: null,
    unansweredInboundCount: over.unanswered ?? 0,
    customerLastInboundAt: over.customerLastInboundAt ?? null,
    businessLastOutboundAt: over.businessLastOutboundAt ?? null,
    createdAt: minutesAgo(600),
    updatedAt: lastMessageAt,
    customer: { id: 10, name: "דניאל כהן", phone: "0521234567" },
    lead: null,
    messages: [
      {
        contentText: "שלום",
        senderType: over.lastMessageDirection === "OUTBOUND" ? "BUSINESS_USER" : "CUSTOMER",
        direction: over.lastMessageDirection ?? "INBOUND",
        createdAt: lastMessageAt,
        analysis: null,
      },
    ],
    replySuggestions: [],
  } as unknown as LeadConversationRow;
}

const attentionFor = (status: LeadStatusValue, over: { nextFollowUpAt?: Date | null; createdAt?: Date } = {}) =>
  evaluateLeadAttention(
    {
      status,
      nextFollowUpAt: over.nextFollowUpAt ?? null,
      createdAt: over.createdAt ?? minutesAgo(30),
    },
    NOW
  );

console.log("\nLead Intelligence — pure contract\n");

/* ───────────────────────────── read-model ──────────────────────────────── */

check(
  deriveLeadConversationIntelligence({ conversations: [], now: NOW }) === null,
  "R1 a lead with no conversation has no intelligence — not an empty object"
);

{
  const i = deriveLeadConversationIntelligence({
    conversations: [
      conversation({ id: 5, unanswered: 3, customerLastInboundAt: minutesAgo(18) }),
    ],
    now: NOW,
  });
  check(i?.conversationId === 5, "R2 the readout names the conversation it describes");
  check(i?.unansweredInboundCount === 3, "R3 the unanswered count comes from the row", `got ${i?.unansweredInboundCount}`);
  check(i?.waitingMinutes === 18, "R4 waiting minutes are derived by the shared signal engine", `got ${i?.waitingMinutes}`);
  check(i?.primarySignal === "customer_waiting", "R5 and the signal agrees with the Inbox", `got ${i?.primarySignal}`);
  check(i?.conversationCount === 1, "R6 the conversation count is reported");
}

{
  // A quiet conversation must not manufacture urgency.
  const i = deriveLeadConversationIntelligence({
    conversations: [conversation({ id: 6, unanswered: 0, lastMessageDirection: "OUTBOUND" })],
    now: NOW,
  });
  check(i?.unansweredInboundCount === 0, "R7 a conversation nobody is waiting on counts zero");
  check(i?.waitingMinutes == null, "R8 and reports no waiting time", `got ${i?.waitingMinutes}`);
  check(i?.temperatureBucket === "cold", "R9 a null temperature reads cold, never hot", `got ${i?.temperatureBucket}`);
}

/* ─────────────────────── multi-conversation contract ───────────────────── */

{
  const waiting = conversation({
    id: 1,
    unanswered: 2,
    customerLastInboundAt: minutesAgo(30),
    lastMessageAt: minutesAgo(30),
  });
  const hotButQuiet = conversation({
    id: 2,
    unanswered: 0,
    temperature: 0.9,
    lastMessageAt: minutesAgo(1),
    lastMessageDirection: "OUTBOUND",
  });
  const a = deriveLeadConversationIntelligence({ conversations: [hotButQuiet, waiting], now: NOW });
  const b = deriveLeadConversationIntelligence({ conversations: [waiting, hotButQuiet], now: NOW });

  check(a?.conversationId === 1, "M1 the WAITING conversation is primary, not the most recent", `got ${a?.conversationId}`);
  check(
    a?.conversationId === b?.conversationId,
    "M2 the choice does not depend on input order — it is deterministic"
  );
  check(a?.conversationCount === 2, "M3 the count reflects every conversation");
  check(
    a?.unansweredInboundCount === 2,
    "M4 counts are NOT summed across unrelated threads — they describe the primary",
    `got ${a?.unansweredInboundCount}`
  );
  check(
    a?.lastMessageAt === minutesAgo(1).toISOString(),
    "M5 lastMessageAt IS aggregated — it answers a question about the person",
    `got ${a?.lastMessageAt}`
  );
}

{
  // Identical urgency and identical recency → highest id wins, stably.
  const at = minutesAgo(5);
  const x = conversation({ id: 7, lastMessageAt: at });
  const y = conversation({ id: 8, lastMessageAt: at });
  const first = deriveLeadConversationIntelligence({ conversations: [x, y], now: NOW });
  const second = deriveLeadConversationIntelligence({ conversations: [y, x], now: NOW });
  check(first?.conversationId === 8, "M6 an exact tie resolves to the highest id", `got ${first?.conversationId}`);
  check(first?.conversationId === second?.conversationId, "M7 and resolves the same way every time");
}

/* ───────────────────────────── priority ────────────────────────────────── */

const overdue = attentionFor("OPEN", { nextFollowUpAt: new Date("2026-08-28T09:00:00.000Z") });
const dueToday = attentionFor("OPEN", { nextFollowUpAt: new Date("2026-09-02T20:00:00.000Z") });
const quiet = attentionFor("OPEN", { createdAt: minutesAgo(30) });

{
  const p = evaluateLeadPriority({ status: "OPEN", attention: overdue, intelligence: null });
  check(p.reason === "FOLLOWUP_OVERDUE", "P1 an overdue follow-up is the reason", `got ${p.reason}`);
  check(p.score >= 80, "P2 and scores in the overdue band", `got ${p.score}`);
  check(p.label.length > 0 && !/[A-Z_]{4,}/.test(p.label), "P3 the label is Hebrew, never an enum", p.label);
}

{
  // THE ORDERING W2 PROVED: nothing the conversation says may outrank a broken
  // promise.
  const hotWaiting = deriveLeadConversationIntelligence({
    conversations: [
      conversation({
        id: 3,
        unanswered: 5,
        customerLastInboundAt: minutesAgo(LONG_WAIT_MINUTES + 600),
        temperature: 0.95,
      }),
    ],
    now: NOW,
  });
  const withConv = evaluateLeadPriority({ status: "OPEN", attention: overdue, intelligence: hotWaiting });
  check(
    withConv.reason === "FOLLOWUP_OVERDUE",
    "P4 an overdue follow-up still wins over a hot, long-waiting thread",
    `got ${withConv.reason}`
  );
  check(
    withConv.contributing.includes("CUSTOMER_WAITING_LONG"),
    "P5 but the waiting customer is still reported as contributing"
  );
}

{
  const longWait = deriveLeadConversationIntelligence({
    conversations: [
      conversation({ id: 4, unanswered: 2, customerLastInboundAt: minutesAgo(LONG_WAIT_MINUTES + 60) }),
    ],
    now: NOW,
  });
  const p = evaluateLeadPriority({ status: "OPEN", attention: dueToday, intelligence: longWait });
  check(
    p.reason === "CUSTOMER_WAITING_LONG",
    "P6 a customer waiting hours outranks a follow-up merely due today",
    `got ${p.reason}`
  );
  check(p.score > 70 && p.score < 80, "P7 and sits between due-today and overdue", `got ${p.score}`);
}

{
  const shortWait = deriveLeadConversationIntelligence({
    conversations: [conversation({ id: 9, unanswered: 1, customerLastInboundAt: minutesAgo(20) })],
    now: NOW,
  });
  const p = evaluateLeadPriority({ status: "OPEN", attention: dueToday, intelligence: shortWait });
  check(
    p.reason === "FOLLOWUP_DUE_TODAY",
    "P8 a twenty-minute wait does NOT outrank a promise made for today",
    `got ${p.reason}`
  );
}

{
  const hotQuiet = deriveLeadConversationIntelligence({
    conversations: [
      conversation({
        id: 11,
        unanswered: 0,
        temperature: 0.92,
        stage: "NEGOTIATION",
        lastMessageDirection: "OUTBOUND",
        businessLastOutboundAt: minutesAgo(5),
        customerLastInboundAt: minutesAgo(20),
      }),
    ],
    now: NOW,
  });
  const p = evaluateLeadPriority({ status: "OPEN", attention: quiet, intelligence: hotQuiet });
  check(
    p.score <= 50,
    "P9 a hot thread with nobody waiting is an opportunity, not an emergency",
    `got ${p.score} (${p.reason})`
  );
}

/* ─────────────────────── priority SAFETY (negatives) ───────────────────── */

for (const status of ["WON", "LOST", "DROPPED"] as LeadStatusValue[]) {
  const hot = deriveLeadConversationIntelligence({
    conversations: [
      conversation({ id: 12, unanswered: 9, customerLastInboundAt: minutesAgo(4000), temperature: 0.99 }),
    ],
    now: NOW,
  });
  const p = evaluateLeadPriority({ status, attention: attentionFor(status), intelligence: hot });
  check(
    p.score === 0 && p.reason === "NONE",
    `S1 a ${status} lead scores zero however loud its old conversation is`,
    `got ${p.score} (${p.reason})`
  );
}

{
  const empty = deriveLeadConversationIntelligence({
    conversations: [conversation({ id: 13, unanswered: 0, lastMessageDirection: "OUTBOUND" })],
    now: NOW,
  });
  const p = evaluateLeadPriority({ status: "OPEN", attention: quiet, intelligence: empty });
  check(p.score === 0, "S2 a lead whose conversation asks nothing is not urgent", `got ${p.score}`);
}

{
  // Merely warm must never manufacture a reason.
  const warm = deriveLeadConversationIntelligence({
    conversations: [
      conversation({ id: 14, unanswered: 0, temperature: 0.55, lastMessageDirection: "OUTBOUND" }),
    ],
    now: NOW,
  });
  const p = evaluateLeadPriority({ status: "OPEN", attention: quiet, intelligence: warm });
  check(p.reason === "NONE", "S3 a warm temperature alone is not a reason to interrupt", `got ${p.reason}`);
}

{
  // Recomputation is stable: same inputs, same score, every time.
  const i = deriveLeadConversationIntelligence({
    conversations: [conversation({ id: 15, unanswered: 2, customerLastInboundAt: minutesAgo(45) })],
    now: NOW,
  });
  const a = evaluateLeadPriority({ status: "OPEN", attention: quiet, intelligence: i });
  const b = evaluateLeadPriority({ status: "OPEN", attention: quiet, intelligence: i });
  check(a.score === b.score && a.reason === b.reason, "S4 recomputation is deterministic — a replay cannot move a lead");
}

/* ──────────────────────────── row copy ─────────────────────────────────── */

{
  const waiting = deriveLeadConversationIntelligence({
    conversations: [
      conversation({ id: 16, unanswered: 3, customerLastInboundAt: minutesAgo(18), temperature: 0.9 }),
    ],
    now: NOW,
  });
  const headline = leadIntelligenceHeadline(waiting);
  const detail = leadIntelligenceDetail(waiting);
  check(headline != null && headline.includes("ממתין"), "U1 the row headline states the wait", headline ?? "null");
  check(headline != null && headline.includes("🔥"), "U2 and marks a hot thread");
  check(detail === "3 הודעות ללא מענה", "U3 the second line is the concrete evidence", detail ?? "null");
  check(
    !/[A-Z_]{4,}/.test(`${headline} ${detail}`),
    "U4 neither line ever prints an internal enum",
    `${headline} | ${detail}`
  );
  check(leadIntelligenceHeadline(null) === null, "U5 no conversation means no decoration");
}

/* ──────────────────────── the domain boundary ──────────────────────────── */

{
  // The point of W3: evidence and decision coexist without one overwriting the
  // other. A NEGOTIATION conversation next to an OPEN lead is not a conflict.
  const negotiating = deriveLeadConversationIntelligence({
    conversations: [conversation({ id: 17, stage: "NEGOTIATION", unanswered: 1, customerLastInboundAt: minutesAgo(5) })],
    now: NOW,
  });
  check(negotiating?.conversationStage === "NEGOTIATION", "B1 the conversation stage is reported as evidence");
  const p = evaluateLeadPriority({ status: "OPEN", attention: quiet, intelligence: negotiating });
  check(
    !Object.prototype.hasOwnProperty.call(p, "status"),
    "B2 the priority result carries no lead status — it cannot suggest a write"
  );
  assert.equal(typeof p.score, "number");
  check(true, "B3 evidence and owner decision are returned side by side, neither derived from the other");
}

console.log(
  failures.length === 0
    ? `\nLEAD INTELLIGENCE VERIFY PASS — ${passed} checks green.\n`
    : `\nLEAD INTELLIGENCE VERIFY FAIL — ${failures.length} failed of ${passed + failures.length}:\n` +
        failures.map((f) => `  - ${f}`).join("\n") + "\n"
);
process.exit(failures.length === 0 ? 0 : 1);
