/**
 * 9D goals/approach closing integration. Run with:
 *   npx tsx lib/features/bot/bot-compose-goals-approach.verify.test.ts
 */
import assert from "node:assert/strict";
import {
  deriveComposeStyle,
  chooseClosingTemplate,
  type BotComposeApproach,
  type BotComposeContext,
} from "./index";
import { planStarterBotReply } from "../conversation/starter-bot";

function ctx(opts: {
  goals?: string[];
  approach?: BotComposeApproach;
  verbosity?: "short" | "medium" | "detailed";
}): BotComposeContext {
  return {
    identity: { displayName: null },
    voice: { tone: null, languages: [] },
    personalityVerbosity: opts.verbosity ?? null,
    goals: opts.goals,
    approach: opts.approach,
  };
}

// ── 1. deriveComposeStyle ────────────────────────────────────────────────────
assert.equal(deriveComposeStyle(ctx({})), null); // no basis
assert.equal(deriveComposeStyle(ctx({ goals: [] })), null);
{
  const s = deriveComposeStyle(ctx({ goals: ["appointment_booking"], verbosity: "short" }));
  assert.ok(s && s.schedulingGoal === true && s.verbosity === "short");
}
{
  const s = deriveComposeStyle(ctx({ approach: { saleStyle: "active", initiativeLevel: null, priorities: [] } }));
  assert.ok(s && s.schedulingGoal === false && s.sellingLean === "active");
}

// ── 2. chooseClosingTemplate — only generic acknowledgements + a basis ───────
assert.equal(chooseClosingTemplate(ctx({ goals: ["faq"] }), "SEND_LINK"), null); // URL closing untouched
assert.equal(chooseClosingTemplate(ctx({ goals: ["faq"] }), "ESCALATE"), null); // handoff untouched
assert.equal(chooseClosingTemplate(ctx({}), "LEAVE_MESSAGE"), null); // no basis → null
{
  const sched = chooseClosingTemplate(ctx({ goals: ["appointment_booking"], verbosity: "short" }), "COLLECT_DETAILS");
  assert.equal(sched, "קיבלתי 👍 אחזור לאשר את התור.");
}
{
  // aggressive approach → benign suffix only, no price/promise
  const aggressive = chooseClosingTemplate(
    ctx({ approach: { saleStyle: "active", initiativeLevel: null, priorities: [] }, verbosity: "medium" }),
    "LEAVE_MESSAGE"
  )!;
  assert.ok(aggressive.includes("נשמח להציע"));
  for (const bad of ["מחיר", "₪", "הנחה", "מובטח", "זמין", "בטוח"]) {
    assert.ok(!aggressive.includes(bad), `closing must not contain "${bad}"`);
  }
}

// ── planner fixtures ─────────────────────────────────────────────────────────
const base = {
  enabled: true,
  mode: "STARTER",
  channel: "WHATSAPP",
  welcomeMessage: "היי! כמה פרטים ונמשיך.",
  questions: { items: ["מה השם שלך?", "מתי נוח לך?"] },
  finalActionPayload: null,
  handoffRules: { version: 1, workMode: "SMART_DRAFTS" },
};
const input = (settings: object, qi: number) =>
  ({ settings, conversation: { id: 1 }, analysis: { intent: "x", stage: "y" }, nextQuestionIndex: qi }) as never;

// ── 3. terminal closing override (scheduling) — kind/finalAction unchanged ────
{
  const settings = { ...base, finalAction: "COLLECT_DETAILS" };
  const baseline = planStarterBotReply(input(settings, 2));
  const withCtx = planStarterBotReply(input(settings, 2), ctx({ goals: ["appointment_booking"], verbosity: "medium" }));
  assert.equal(withCtx.replyKind, baseline.replyKind); // COMPLETE unchanged
  assert.equal(withCtx.finalAction, "COLLECT_DETAILS"); // value unchanged
  assert.notEqual(withCtx.replyText, baseline.replyText); // only wording changed
  assert.equal(withCtx.replyText, "תודה! קיבלתי את הפרטים, אחזור אליך לאישור התור.");
}

// ── 4. no goals/approach → identical; no context → identical ─────────────────
{
  const settings = { ...base, finalAction: "COLLECT_DETAILS" };
  const baseline = planStarterBotReply(input(settings, 2));
  assert.deepEqual(planStarterBotReply(input(settings, 2), ctx({})), baseline);
  assert.deepEqual(planStarterBotReply(input(settings, 2), undefined), baseline);
}

// ── 5. SEND_LINK closing (URL) is never overridden ───────────────────────────
{
  const settings = { ...base, finalAction: "SEND_LINK", finalActionPayload: { websiteUrl: "https://x.co/cat" } };
  const baseline = planStarterBotReply(input(settings, 2));
  const withCtx = planStarterBotReply(input(settings, 2), ctx({ goals: ["appointment_booking"] }));
  assert.deepEqual(withCtx, baseline);
  assert.ok(withCtx.replyText.includes("https://x.co/cat"));
}

// ── 6. ESCALATE stays HANDOFF, closing untouched ─────────────────────────────
{
  const settings = { ...base, finalAction: "ESCALATE" };
  const baseline = planStarterBotReply(input(settings, 2));
  const withCtx = planStarterBotReply(input(settings, 2), ctx({ goals: ["appointment_booking"] }));
  assert.equal(withCtx.replyKind, "HANDOFF");
  assert.deepEqual(withCtx, baseline);
}

// ── 7. mid-flow + welcome unaffected by goals/approach context ───────────────
{
  const settings = { ...base, finalAction: "COLLECT_DETAILS" };
  const c = ctx({ goals: ["appointment_booking"], approach: { saleStyle: "active", initiativeLevel: null, priorities: [] } });
  assert.deepEqual(planStarterBotReply(input(settings, 1), c), planStarterBotReply(input(settings, 1))); // question
  assert.deepEqual(planStarterBotReply(input(settings, 0), c), planStarterBotReply(input(settings, 0))); // welcome (no voice)
}

console.log("bot-compose-goals-approach.verify: all assertions passed ✓");
