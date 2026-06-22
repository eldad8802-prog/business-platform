/**
 * BotFieldAnswer mapper validation (pure, no DB). Run with:
 *   npx tsx lib/features/conversation/bot-answers/bot-answer.verify.test.ts
 *
 * Asserts the pure create-payload mapper: defaults, verbatim rawValue, and
 * override passthrough. The repository helpers are DB-bound and type-checked
 * by tsc; they are intentionally not exercised here.
 */
import assert from "node:assert/strict";
import { buildAnswerCreateData } from "./bot-answer.mapper";

// ── 1. Defaults applied; rawValue verbatim ───────────────────────────────────
const d = buildAnswerCreateData({
  businessId: 1,
  conversationId: 2,
  fieldKey: "party_phone",
  rawValue: "050-1234567",
});
assert.equal(d.businessId, 1);
assert.equal(d.conversationId, 2);
assert.equal(d.fieldKey, "party_phone");
assert.equal(d.parseStatus, "UNPARSED");
assert.equal(d.partyRole, "CUSTOMER");
assert.equal(d.rawKind, "text");
assert.equal(d.sourceMessageId, null);
assert.equal(d.rawValue, "050-1234567");

// ── 2. rawValue is NOT trimmed/normalized (immutable snapshot) ───────────────
const spaced = buildAnswerCreateData({
  businessId: 1,
  conversationId: 2,
  fieldKey: "notes",
  rawValue: "  כן בבקשה  ",
});
assert.equal(spaced.rawValue, "  כן בבקשה  ");

// ── 3. Overrides honored ─────────────────────────────────────────────────────
const o = buildAnswerCreateData({
  businessId: 7,
  conversationId: 8,
  fieldKey: "appointment_date",
  rawValue: "מחר בבוקר",
  sourceMessageId: 99,
  partyRole: "SUPPLIER",
  rawKind: "media",
});
assert.equal(o.sourceMessageId, 99);
assert.equal(o.partyRole, "SUPPLIER");
assert.equal(o.rawKind, "media");
assert.equal(o.parseStatus, "UNPARSED"); // still unparsed regardless of overrides

console.log("bot-answer.verify: all assertions passed ✓");
