/**
 * BotComposeContext + 9B voice (Stage 9A/9B). Run with:
 *   npx tsx lib/features/bot/bot-compose-context.verify.test.ts
 *
 * Proves: the pure mapper + voice transform, AND that the planner is
 * byte-identical without a context, changes ONLY the welcome wording with one,
 * and never touches questions / finalAction / reply kind.
 */
import assert from "node:assert/strict";
import {
  applyVoiceToWelcome,
  buildBotComposeContext,
  type BotComposeContext,
} from "./index";
import { planStarterBotReply } from "../conversation/starter-bot";

// ── 1. applyVoiceToWelcome (pure, mechanical) ────────────────────────────────
const ctxRoni: BotComposeContext = {
  identity: { displayName: "רוני" },
  voice: { tone: "friendly", languages: ["he"] },
  personalityVerbosity: null,
};
assert.equal(applyVoiceToWelcome("היי! תודה שפנית.", ctxRoni), "היי! תודה שפנית.\n— רוני");
// no-op when name already present
assert.equal(applyVoiceToWelcome("היי, כאן רוני", ctxRoni), "היי, כאן רוני");
// no-op when no name
const ctxNoName: BotComposeContext = { identity: { displayName: null }, voice: { tone: null, languages: [] }, personalityVerbosity: null };
assert.equal(applyVoiceToWelcome("היי!", ctxNoName), "היי!");

// ── 2. buildBotComposeContext (mapper) ───────────────────────────────────────
{
  const c = buildBotComposeContext({
    displayName: "רוני מ-רויאל",
    profile: { voice: { tone: "friendly", languages: ["he", "en"] }, personality: { verbosity: "medium" } },
  });
  assert.equal(c.identity.displayName, "רוני מ-רויאל");
  assert.equal(c.voice.tone, "friendly");
  assert.deepEqual(c.voice.languages, ["he", "en"]);
  assert.equal(c.personalityVerbosity, "medium");
  // null profile → empty voice
  const empty = buildBotComposeContext({ displayName: null, profile: null });
  assert.equal(empty.identity.displayName, null);
  assert.deepEqual(empty.voice.languages, []);
}

// ── planner golden fixtures ──────────────────────────────────────────────────
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
const baseInput = (qi: number) =>
  ({ settings, conversation: { id: 1 }, analysis: { intent: "x", stage: "y" }, nextQuestionIndex: qi }) as never;

// ── 3. flag OFF (no context) → byte-identical anchor ─────────────────────────
{
  const r0 = planStarterBotReply(baseInput(0));
  assert.equal(r0.replyText, "היי! כמה פרטים ונמשיך.\n\nמה השם שלך?");
  assert.equal(r0.replyKind, "WELCOME");
  // calling again with explicit undefined context is identical
  const r0b = planStarterBotReply(baseInput(0), undefined);
  assert.deepEqual(r0b, r0);
}

// ── 4. context present → welcome carries the bot name; question unchanged ─────
{
  const withCtx = planStarterBotReply(baseInput(0), ctxRoni);
  assert.equal(withCtx.replyKind, "WELCOME");
  assert.ok(withCtx.replyText.includes("רוני"), "welcome should carry the name");
  assert.ok(withCtx.replyText.includes("מה השם שלך?"), "first question unchanged");
  assert.equal(withCtx.nextQuestionIndex, 1);
  assert.equal(withCtx.replyText, "היי! כמה פרטים ונמשיך.\n— רוני\n\nמה השם שלך?");
}

// ── 5. voice affects WELCOME only — questions + terminal unchanged by context ─
{
  const q1 = planStarterBotReply(baseInput(1));
  const q1ctx = planStarterBotReply(baseInput(1), ctxRoni);
  assert.deepEqual(q1ctx, q1); // question step: context has no effect

  const term = planStarterBotReply(baseInput(2));
  const termCtx = planStarterBotReply(baseInput(2), ctxRoni);
  assert.deepEqual(termCtx, term); // terminal/finalAction: context has no effect
  assert.equal(term.finalAction, "COLLECT_DETAILS");
}

console.log("bot-compose-context.verify: all assertions passed ✓");
