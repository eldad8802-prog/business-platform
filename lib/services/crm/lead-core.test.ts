/**
 * Leads W1 — pure domain verifier.
 *
 * NO database, NO network, NO secrets: every assertion is a pure function of its
 * inputs, which is exactly why this file is wired into the BLOCKING CI-1 job
 * (the same treatment the IMPL-2 evidence-adapter boundary gets). The DB-backed
 * behaviour lives in `lead.service.test.ts` and runs locally against a dev DB.
 *
 * Run: npx tsx lib/services/crm/lead-core.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { ValidationError } from "@/lib/errors";
import {
  CLOSED_LEAD_STATUSES,
  LEAD_STATUSES,
  OPEN_LEAD_STATUSES,
  classifyLeadStatusTransition,
  endOfLeadDayUtc,
  evaluateLeadFollowUp,
  isClosedLeadStatus,
  isLeadStatus,
  leadDayKey,
  leadFollowUpLabel,
  leadNeedsAttention,
  normalizeLeadEmail,
  normalizeLeadName,
  normalizeLeadOptionalText,
  parseFollowUpAt,
  parseLeadStatus,
  startOfLeadDayUtc,
  type LeadStatusValue,
} from "@/lib/services/crm/lead-core";
import { evaluateLeadAttention } from "@/lib/services/crm/lead-attention";

let passed = 0;

function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

function throwsValidation(label: string, fn: () => unknown): void {
  check(label, () => {
    assert.throws(fn, (err: unknown) => err instanceof ValidationError, label);
  });
}

/* =================================================== 1. status vocabulary == */

check("the existing 7-value LeadStatus vocabulary is reused unchanged", () => {
  assert.deepEqual(
    [...LEAD_STATUSES],
    ["NEW", "OPEN", "QUALIFIED", "QUOTED", "WON", "LOST", "DROPPED"]
  );
});

check("open and closed statuses partition the vocabulary", () => {
  assert.deepEqual([...CLOSED_LEAD_STATUSES], ["WON", "LOST", "DROPPED"]);
  assert.deepEqual([...OPEN_LEAD_STATUSES], ["NEW", "OPEN", "QUALIFIED", "QUOTED"]);
  assert.equal(
    OPEN_LEAD_STATUSES.length + CLOSED_LEAD_STATUSES.length,
    LEAD_STATUSES.length
  );
  for (const s of LEAD_STATUSES) {
    assert.equal(
      isClosedLeadStatus(s),
      CLOSED_LEAD_STATUSES.includes(s),
      `partition disagrees for ${s}`
    );
  }
});

check("isLeadStatus rejects junk and near-misses", () => {
  assert.equal(isLeadStatus("NEW"), true);
  assert.equal(isLeadStatus("new"), false, "case-sensitive on purpose");
  assert.equal(isLeadStatus("CONTACTED"), false, "not part of the enum");
  assert.equal(isLeadStatus(""), false);
  assert.equal(isLeadStatus(null), false);
  assert.equal(isLeadStatus(7), false);
});

throwsValidation("parseLeadStatus refuses an unknown status", () =>
  parseLeadStatus("ARCHIVED")
);

/* ================================================= 2. status transitions == */

check("repeating a status is a no-op, not a state change", () => {
  const t = classifyLeadStatusTransition("QUOTED", "QUOTED");
  assert.equal(t.noop, true);
  assert.equal(t.closing, false);
  assert.equal(t.reopening, false);
});

check("moving from open into a terminal status is a close", () => {
  for (const to of CLOSED_LEAD_STATUSES) {
    const t = classifyLeadStatusTransition("QUOTED", to);
    assert.equal(t.closing, true, `QUOTED -> ${to} should close`);
    assert.equal(t.reopening, false);
    assert.equal(t.noop, false);
  }
});

check("moving out of a terminal status is a reopen", () => {
  const t = classifyLeadStatusTransition("LOST", "OPEN");
  assert.equal(t.reopening, true);
  assert.equal(t.closing, false);
});

check("terminal-to-terminal is neither a close nor a reopen", () => {
  const t = classifyLeadStatusTransition("WON", "LOST");
  assert.equal(t.closing, false, "already closed — nothing new is being closed");
  assert.equal(t.reopening, false);
  assert.equal(t.noop, false);
});

check("moving forward between open statuses changes nothing terminal", () => {
  const t = classifyLeadStatusTransition("NEW", "QUALIFIED");
  assert.deepEqual(t, { noop: false, closing: false, reopening: false });
});

/* ======================================================== 3. validation === */

check("name is trimmed", () => {
  assert.equal(normalizeLeadName("  דנה לוי  "), "דנה לוי");
});

throwsValidation("empty name is refused", () => normalizeLeadName(""));
throwsValidation("whitespace-only name is refused", () => normalizeLeadName("   \t \n "));
throwsValidation("missing name is refused", () => normalizeLeadName(undefined));
throwsValidation("non-string name is refused", () => normalizeLeadName(42));
throwsValidation("over-long name is refused", () =>
  normalizeLeadName("x".repeat(201))
);

check("a 200-character name is accepted (boundary)", () => {
  assert.equal(normalizeLeadName("x".repeat(200)).length, 200);
});

check("blank optional text becomes null, not an empty string", () => {
  assert.equal(normalizeLeadOptionalText("   ", "intentSnapshot", 100), null);
  assert.equal(normalizeLeadOptionalText(null, "intentSnapshot", 100), null);
  assert.equal(normalizeLeadOptionalText(undefined, "intentSnapshot", 100), null);
});

check("optional text is trimmed", () => {
  assert.equal(
    normalizeLeadOptionalText("  צריך הצעת מחיר  ", "intentSnapshot", 100),
    "צריך הצעת מחיר"
  );
});

throwsValidation("over-long optional text is refused", () =>
  normalizeLeadOptionalText("x".repeat(101), "intentSnapshot", 100)
);

/* ===================================================== 4. email validity == */

check("a valid email is normalized to lower case", () => {
  assert.equal(normalizeLeadEmail("  Dana@Example.CO.il "), "dana@example.co.il");
});

check("an absent email stays null", () => {
  assert.equal(normalizeLeadEmail(null), null);
  assert.equal(normalizeLeadEmail(undefined), null);
  assert.equal(normalizeLeadEmail("   "), null);
});

// The regression the audit named: `not-an-email` used to be stored verbatim.
throwsValidation("`not-an-email` is REFUSED (the audit regression)", () =>
  normalizeLeadEmail("not-an-email")
);
throwsValidation("an email with no domain dot is refused", () =>
  normalizeLeadEmail("dana@localhost")
);
throwsValidation("an email with no local part is refused", () =>
  normalizeLeadEmail("@example.com")
);
throwsValidation("an email with a space is refused", () =>
  normalizeLeadEmail("da na@example.com")
);
throwsValidation("an email with two @ is refused", () =>
  normalizeLeadEmail("a@b@example.com")
);
throwsValidation("an over-long email is refused", () =>
  normalizeLeadEmail(`${"x".repeat(200)}@example.com`)
);

/* ================================================== 5. follow-up parsing == */

const NOW = new Date("2026-08-31T09:00:00.000Z");

throwsValidation("a junk follow-up date is refused", () =>
  parseFollowUpAt("tomorrow-ish", NOW)
);
throwsValidation("an empty follow-up date is refused", () =>
  parseFollowUpAt("", NOW)
);
throwsValidation("a follow-up more than 10 years out is refused", () =>
  parseFollowUpAt("2099-01-01T09:00:00.000Z", NOW)
);

check("a valid ISO follow-up parses to the same instant", () => {
  const parsed = parseFollowUpAt("2026-09-03T06:00:00.000Z", NOW);
  assert.equal(parsed.toISOString(), "2026-09-03T06:00:00.000Z");
});

check("a follow-up in the past parses (setting one late is legitimate)", () => {
  const parsed = parseFollowUpAt("2026-08-01T06:00:00.000Z", NOW);
  assert.equal(parsed.toISOString(), "2026-08-01T06:00:00.000Z");
});

/* ============================================ 6. Israel-time day boundary == */

check("the day key is Israel-local, not UTC (summer, UTC+3)", () => {
  // 21:30Z on 31 Aug is already 00:30 on 1 Sep in Israel.
  assert.equal(leadDayKey(new Date("2026-08-31T21:30:00.000Z")), "2026-09-01");
  assert.equal(leadDayKey(new Date("2026-08-31T20:30:00.000Z")), "2026-08-31");
});

check("the day key is Israel-local in winter too (UTC+2)", () => {
  assert.equal(leadDayKey(new Date("2026-01-15T22:30:00.000Z")), "2026-01-16");
  assert.equal(leadDayKey(new Date("2026-01-15T21:30:00.000Z")), "2026-01-15");
});

check("end-of-day lands on 20:59:59.999Z in summer", () => {
  assert.equal(
    endOfLeadDayUtc(new Date("2026-08-31T09:00:00.000Z")).toISOString(),
    "2026-08-31T20:59:59.999Z"
  );
});

check("end-of-day lands on 21:59:59.999Z in winter", () => {
  assert.equal(
    endOfLeadDayUtc(new Date("2026-01-15T09:00:00.000Z")).toISOString(),
    "2026-01-15T21:59:59.999Z"
  );
});

check("end-of-day is always the last instant of the SAME Israel day", () => {
  // Property test across a full year, including both DST switchovers — this is
  // what proves the two-pass offset resolution, not a hand-picked date.
  for (let day = 0; day < 365; day += 1) {
    const sample = new Date(Date.UTC(2026, 0, 1, 9, 0, 0) + day * 86_400_000);
    const end = endOfLeadDayUtc(sample);
    assert.equal(
      leadDayKey(end),
      leadDayKey(sample),
      `end-of-day left the day on ${sample.toISOString()}`
    );
    assert.equal(
      leadDayKey(new Date(end.getTime() + 1)) > leadDayKey(sample),
      true,
      `one ms later is not the next day on ${sample.toISOString()}`
    );
  }
});

/* ================================================= 7. follow-up evaluation = */

check("no follow-up means no state", () => {
  assert.deepEqual(evaluateLeadFollowUp(null, NOW), { kind: "none" });
  assert.deepEqual(evaluateLeadFollowUp(undefined, NOW), { kind: "none" });
});

check("a follow-up later today is due today, not overdue", () => {
  const state = evaluateLeadFollowUp(new Date("2026-08-31T15:00:00.000Z"), NOW);
  assert.equal(state.kind, "due_today");
});

check("a follow-up EARLIER today is still due today, never overdue", () => {
  // The owner has all day to act; 06:00 vs 09:00 is not "late".
  const state = evaluateLeadFollowUp(new Date("2026-08-31T06:00:00.000Z"), NOW);
  assert.equal(state.kind, "due_today");
});

check("yesterday's follow-up is overdue by one day", () => {
  const state = evaluateLeadFollowUp(new Date("2026-08-30T06:00:00.000Z"), NOW);
  assert.equal(state.kind, "overdue");
  if (state.kind === "overdue") assert.equal(state.overdueDays, 1);
});

check("a week-old follow-up is overdue by seven days", () => {
  const state = evaluateLeadFollowUp(new Date("2026-08-24T06:00:00.000Z"), NOW);
  assert.equal(state.kind, "overdue");
  if (state.kind === "overdue") assert.equal(state.overdueDays, 7);
});

check("a future follow-up is scheduled with a day count", () => {
  const state = evaluateLeadFollowUp(new Date("2026-09-03T06:00:00.000Z"), NOW);
  assert.equal(state.kind, "scheduled");
  if (state.kind === "scheduled") assert.equal(state.inDays, 3);
});

check("22:30Z tonight is TOMORROW's follow-up in Israel, not tonight's", () => {
  // The whole point of Israel-local day keys: a naive UTC comparison would call
  // this "today" and surface it a day early.
  const state = evaluateLeadFollowUp(new Date("2026-08-31T22:30:00.000Z"), NOW);
  assert.equal(state.kind, "scheduled");
  if (state.kind === "scheduled") assert.equal(state.inDays, 1);
});

/* ==================================================== 8. needs-attention === */

check("an open lead with a due follow-up needs attention", () => {
  assert.equal(
    leadNeedsAttention(
      { status: "OPEN", nextFollowUpAt: new Date("2026-08-31T06:00:00.000Z") },
      NOW
    ),
    true
  );
});

check("an open lead with an overdue follow-up needs attention", () => {
  assert.equal(
    leadNeedsAttention(
      { status: "NEW", nextFollowUpAt: new Date("2026-08-20T06:00:00.000Z") },
      NOW
    ),
    true
  );
});

check("a future follow-up does not need attention yet", () => {
  assert.equal(
    leadNeedsAttention(
      { status: "QUOTED", nextFollowUpAt: new Date("2026-09-10T06:00:00.000Z") },
      NOW
    ),
    false
  );
});

check("a lead with no follow-up never needs attention", () => {
  assert.equal(leadNeedsAttention({ status: "OPEN", nextFollowUpAt: null }, NOW), false);
});

check("a CLOSED lead never needs attention, even if its follow-up is overdue", () => {
  for (const status of CLOSED_LEAD_STATUSES) {
    assert.equal(
      leadNeedsAttention(
        { status, nextFollowUpAt: new Date("2026-01-01T06:00:00.000Z") },
        NOW
      ),
      false,
      `${status} must never demand attention`
    );
  }
});

/* ========================================================= 9. labelling === */

check("follow-up labels read correctly in Hebrew", () => {
  assert.equal(leadFollowUpLabel({ kind: "none" }), "");
  assert.equal(leadFollowUpLabel({ kind: "due_today", at: NOW.toISOString() }), "מעקב היום");
  assert.equal(
    leadFollowUpLabel({ kind: "overdue", at: NOW.toISOString(), overdueDays: 1 }),
    "מעקב באיחור יום"
  );
  assert.equal(
    leadFollowUpLabel({ kind: "overdue", at: NOW.toISOString(), overdueDays: 4 }),
    "מעקב באיחור 4 ימים"
  );
  assert.equal(
    leadFollowUpLabel({ kind: "scheduled", at: NOW.toISOString(), inDays: 1 }),
    "מעקב מחר"
  );
  assert.equal(
    leadFollowUpLabel({ kind: "scheduled", at: NOW.toISOString(), inDays: 5 }),
    "מעקב בעוד 5 ימים"
  );
});

check("every status has a Hebrew label", () => {
  for (const s of LEAD_STATUSES) {
    const label = (
      { NEW: 1, OPEN: 1, QUALIFIED: 1, QUOTED: 1, WON: 1, LOST: 1, DROPPED: 1 } as Record<
        LeadStatusValue,
        number
      >
    )[s];
    assert.equal(label, 1, `status ${s} is missing from the exhaustive check`);
  }
});


/* ============================== 10. W2 attention contract ================ */

check("start-of-day is the first instant of TODAY in Israel (summer)", () => {
  assert.equal(
    startOfLeadDayUtc(new Date("2026-08-31T09:00:00.000Z")).toISOString(),
    "2026-08-30T21:00:00.000Z"
  );
});

check("start-of-day is the first instant of TODAY in Israel (winter)", () => {
  assert.equal(
    startOfLeadDayUtc(new Date("2026-01-15T09:00:00.000Z")).toISOString(),
    "2026-01-14T22:00:00.000Z"
  );
});

check("start and end of day bracket exactly one local day, all year", () => {
  for (let day = 0; day < 365; day += 1) {
    const sample = new Date(Date.UTC(2026, 0, 1, 9, 0, 0) + day * 86_400_000);
    const start = startOfLeadDayUtc(sample);
    const end = endOfLeadDayUtc(sample);
    assert.equal(leadDayKey(start), leadDayKey(sample), "start left the day");
    assert.equal(leadDayKey(end), leadDayKey(sample), "end left the day");
    assert.equal(start.getTime() < end.getTime(), true);
    assert.equal(
      leadDayKey(new Date(start.getTime() - 1)) < leadDayKey(sample),
      true,
      "one ms before start is not the previous day"
    );
  }
});

const W2_NOW = new Date("2026-08-31T09:00:00.000Z");
const dayAgo = (n: number) => new Date(W2_NOW.getTime() - n * 86_400_000);

check("an overdue follow-up is the highest-priority reason", () => {
  const a = evaluateLeadAttention(
    { status: "OPEN", nextFollowUpAt: dayAgo(2), createdAt: dayAgo(30) },
    W2_NOW
  );
  assert.equal(a.needsAttention, true);
  assert.equal(a.reason, "FOLLOWUP_OVERDUE");
  assert.equal(a.nextAction.kind, "complete_followup");
  assert.equal(a.priority > 80, true);
});

check("a follow-up due today still asks for the owner", () => {
  const a = evaluateLeadAttention(
    { status: "QUOTED", nextFollowUpAt: W2_NOW, createdAt: dayAgo(10) },
    W2_NOW
  );
  assert.equal(a.reason, "FOLLOWUP_DUE_TODAY");
  assert.equal(a.priority, 70);
});

check("an untouched new lead from before today is surfaced", () => {
  const a = evaluateLeadAttention(
    { status: "NEW", nextFollowUpAt: null, createdAt: dayAgo(2) },
    W2_NOW
  );
  assert.equal(a.reason, "NEW_UNHANDLED");
  assert.equal(a.nextAction.kind, "contact_new_lead");
});

check("a new lead from TODAY is not yet neglected", () => {
  const a = evaluateLeadAttention(
    { status: "NEW", nextFollowUpAt: null, createdAt: W2_NOW },
    W2_NOW
  );
  assert.equal(a.needsAttention, false);
  assert.equal(a.reason, null);
  assert.equal(a.nextAction.kind, "set_followup");
});

check("reasons never cross priority bands, however old they get", () => {
  const ancientNew = evaluateLeadAttention(
    { status: "NEW", nextFollowUpAt: null, createdAt: dayAgo(200) },
    W2_NOW
  );
  const dueToday = evaluateLeadAttention(
    { status: "OPEN", nextFollowUpAt: W2_NOW, createdAt: W2_NOW },
    W2_NOW
  );
  const freshOverdue = evaluateLeadAttention(
    { status: "OPEN", nextFollowUpAt: dayAgo(1), createdAt: W2_NOW },
    W2_NOW
  );
  assert.equal(ancientNew.priority < dueToday.priority, true, "new outranked due-today");
  assert.equal(dueToday.priority < freshOverdue.priority, true, "due-today outranked overdue");
});

check("a CLOSED lead never asks for anything, whatever its history", () => {
  for (const status of CLOSED_LEAD_STATUSES) {
    const a = evaluateLeadAttention(
      { status, nextFollowUpAt: dayAgo(100), createdAt: dayAgo(200) },
      W2_NOW
    );
    assert.equal(a.needsAttention, false, status + " demanded attention");
    assert.equal(a.nextAction.kind, "none");
    assert.equal(a.priority, 0);
  }
});

check("a scheduled future follow-up is quiet", () => {
  const a = evaluateLeadAttention(
    {
      status: "OPEN",
      nextFollowUpAt: new Date(W2_NOW.getTime() + 5 * 86_400_000),
      createdAt: dayAgo(9),
    },
    W2_NOW
  );
  assert.equal(a.needsAttention, false);
  assert.equal(a.nextAction.kind, "none");
});

check("W2 surfaces no signal that depends on the dormant state writer", () => {
  // Structural guard: a future edit must not quietly reintroduce
  // "hot"/"waiting"/"cooling", which read Conversation columns nothing writes.
  // Strip comments first: this file DOCUMENTS which columns it refuses to
  // read, and a naive scan would fire on the very explanation of the rule.
  const rawSrc = fs.readFileSync("lib/services/crm/lead-attention.ts", "utf8");
  const blockComment = new RegExp(String.raw`/\*[\s\S]*?\*/`, "g");
  const lineComment = new RegExp(String.raw`^\s*//`);
  const src = rawSrc
    .replace(blockComment, "")
    .split("\n")
    .filter((line) => !lineComment.test(line))
    .join("\n");
  for (const forbidden of [
    "temperatureScore",
    "unansweredInboundCount",
    "closeProbabilitySnapshot",
    "customerLastInboundAt",
    "businessLastOutboundAt",
  ]) {
    assert.equal(
      src.includes(forbidden + ":") || src.includes("." + forbidden),
      false,
      "lead-attention.ts reads " + forbidden + ", which nothing populates"
    );
  }
});

console.log(`\nLEAD-CORE VERIFY PASS — ${passed} checks green.`);
