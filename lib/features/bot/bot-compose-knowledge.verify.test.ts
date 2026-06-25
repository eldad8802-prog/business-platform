/**
 * 9C knowledge matcher + planner integration. Run with:
 *   npx tsx lib/features/bot/bot-compose-knowledge.verify.test.ts
 */
import assert from "node:assert/strict";
import { matchKnowledgeIntent, type BotComposeContext } from "./index";
import { planStarterBotReply } from "../conversation/starter-bot";

const knowledge = {
  faq: [{ question: "יש חניה?", answer: "כן, יש חניה בחצר" }],
  hours: "א׳–ה׳ 9:00–19:00",
  address: "הרצל 24, ירושלים",
  notes: "הערה פנימית",
};

// ── 1. matcher: conservative matches + null otherwise ────────────────────────
assert.equal(matchKnowledgeIntent("יש חניה?", knowledge)?.matchType, "faq");
assert.equal(matchKnowledgeIntent("יש חניה?", knowledge)?.replyText, "כן, יש חניה בחצר");
assert.equal(matchKnowledgeIntent("חניה", knowledge)?.matchType, "faq"); // q.includes(msg)
assert.equal(matchKnowledgeIntent("מתי אתם פתוחים?", knowledge)?.matchType, "hours");
assert.ok(matchKnowledgeIntent("מתי אתם פתוחים?", knowledge)?.replyText.includes("א׳–ה׳"));
assert.equal(matchKnowledgeIntent("איפה אתם נמצאים?", knowledge)?.matchType, "address");
assert.ok(matchKnowledgeIntent("איפה אתם נמצאים?", knowledge)?.replyText.includes("הרצל 24"));
// ambiguous / unrelated → null
assert.equal(matchKnowledgeIntent("שלום מה שלומך היום", knowledge), null);
// too short → null
assert.equal(matchKnowledgeIntent("מה", knowledge), null);
// no knowledge → null
assert.equal(matchKnowledgeIntent("יש חניה?", undefined), null);
// notes never matched (no trigger) — a message containing the note text still won't surface notes
assert.equal(matchKnowledgeIntent("הערה פנימית", knowledge), null);

// ── planner fixtures ─────────────────────────────────────────────────────────
const settings = {
  enabled: true,
  mode: "STARTER",
  channel: "WHATSAPP",
  welcomeMessage: "היי! כמה פרטים ונמשיך.",
  questions: { items: ["מה השם שלך?", "מתי נוח לך?"] },
  finalAction: "COLLECT_DETAILS",
  finalActionPayload: null,
  handoffRules: { version: 1, workMode: "SMART_DRAFTS" },
};
const input = (qi: number) =>
  ({ settings, conversation: { id: 1 }, analysis: { intent: "x", stage: "y" }, nextQuestionIndex: qi }) as never;

const ctx = (customerMessageText: string, withKnowledge = true): BotComposeContext => ({
  identity: { displayName: null }, // isolate knowledge (no voice)
  voice: { tone: null, languages: [] },
  personalityVerbosity: null,
  knowledge: withKnowledge ? knowledge : undefined,
  customerMessageText,
});

// ── 2. knowledge match → KNOWLEDGE draft (priority) ──────────────────────────
{
  const r = planStarterBotReply(input(0), ctx("יש חניה?"));
  assert.equal(r.replyKind, "KNOWLEDGE");
  assert.equal(r.replyText, "כן, יש חניה בחצר");
  assert.equal(r.shouldDraftReply, true);
  assert.equal(r.reason, "KNOWLEDGE_FAQ");
}

// ── 3. no match → full fallback to existing flow (welcome) ───────────────────
{
  const baseline = planStarterBotReply(input(0));
  const r = planStarterBotReply(input(0), ctx("שלום מה שלומך היום"));
  assert.deepEqual(r, baseline); // identical to existing behaviour
}

// ── 4. knowledge undefined → byte-identical even with a "matching" message ───
{
  const baseline = planStarterBotReply(input(0));
  const r = planStarterBotReply(input(0), ctx("יש חניה?", false));
  assert.deepEqual(r, baseline);
}

// ── 5. questions + finalAction never changed by a non-matching knowledge ctx ─
{
  const q1 = planStarterBotReply(input(1));
  assert.deepEqual(planStarterBotReply(input(1), ctx("שלום", true)), q1);
  const term = planStarterBotReply(input(2));
  assert.deepEqual(planStarterBotReply(input(2), ctx("שלום", true)), term);
  assert.equal(term.finalAction, "COLLECT_DETAILS");
}

// ── 6. hours + address answers via planner ───────────────────────────────────
{
  assert.equal(planStarterBotReply(input(1), ctx("מתי אתם פתוחים?")).replyKind, "KNOWLEDGE");
  assert.ok(planStarterBotReply(input(1), ctx("מתי אתם פתוחים?")).replyText.includes("שעות"));
  assert.equal(planStarterBotReply(input(1), ctx("איפה אתם?")).replyKind, "KNOWLEDGE");
}

console.log("bot-compose-knowledge.verify: all assertions passed ✓");
