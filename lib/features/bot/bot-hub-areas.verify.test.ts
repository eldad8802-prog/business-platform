/**
 * Hub area-state map (Stage 1). Run with:
 *   npx tsx lib/features/bot/bot-hub-areas.verify.test.ts
 *
 * Asserts the upgraded areas (personality / approach / voice) and that the
 * still-soon / unchanged areas keep their Stage 0 behaviour.
 */
import assert from "node:assert/strict";
import {
  computeBotAreaStates,
  BOT_HUB_AREA_IDS,
  type BotHubSignals,
} from "./index";

const EMPTY: BotHubSignals = {
  welcomeOk: false,
  questionsCount: 0,
  finishOk: false,
  productLinkOk: false,
  workModeManual: false,
  identityNamed: false,
  voiceExtrasOk: false,
  personalityOk: false,
  approachOk: false,
};

// ── 1. all 12 areas present ──────────────────────────────────────────────────
{
  const map = computeBotAreaStates(EMPTY);
  assert.equal(Object.keys(map).length, 12);
  for (const id of BOT_HUB_AREA_IDS) {
    assert.ok(map[id], `missing area ${id}`);
  }
}

// ── 2. empty → personality/approach partial (NOT soon), memory/learning soon ──
{
  const map = computeBotAreaStates(EMPTY);
  assert.equal(map.personality, "partial");
  assert.equal(map.approach, "partial");
  assert.equal(map.voice, "partial");
  assert.equal(map.memory, "soon");
  assert.equal(map.learning, "soon");
  assert.equal(map.forbidden, "ready");
  assert.equal(map.handoff, "ready");
}

// ── 3. content → ready ───────────────────────────────────────────────────────
{
  const map = computeBotAreaStates({
    ...EMPTY,
    personalityOk: true,
    approachOk: true,
  });
  assert.equal(map.personality, "ready");
  assert.equal(map.approach, "ready");
}

// ── 4. voice: ready only with welcome + (name OR extras) ─────────────────────
{
  assert.equal(computeBotAreaStates({ ...EMPTY, welcomeOk: true }).voice, "partial");
  assert.equal(
    computeBotAreaStates({ ...EMPTY, welcomeOk: true, identityNamed: true }).voice,
    "ready"
  );
  assert.equal(
    computeBotAreaStates({ ...EMPTY, welcomeOk: true, voiceExtrasOk: true }).voice,
    "ready"
  );
}

// ── 5. conversation / knowledge / allowed runtime-derived ────────────────────
{
  const map = computeBotAreaStates({
    ...EMPTY,
    questionsCount: 3,
    productLinkOk: true,
    finishOk: true,
  });
  assert.equal(map.conversation, "ready");
  assert.equal(map.knowledge, "ready");
  assert.equal(map.allowed, "ready");
}

console.log("bot-hub-areas.verify: all assertions passed ✓");
