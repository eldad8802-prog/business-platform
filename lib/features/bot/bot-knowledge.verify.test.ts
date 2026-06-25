/**
 * Bot Knowledge foundation (Stage 4). Run with:
 *   npx tsx lib/features/bot/bot-knowledge.verify.test.ts
 */
import assert from "node:assert/strict";
import {
  validateKnowledge,
  coerceKnowledge,
  emptyKnowledge,
  hasKnowledgeContent,
  MAX_FAQ_ITEMS,
} from "./index";

// ── 1. defaults / empty ──────────────────────────────────────────────────────
assert.deepEqual(emptyKnowledge(), { hours: null, address: null, notes: null, faq: [] });
assert.equal(hasKnowledgeContent(emptyKnowledge()), false);

// ── 2. valid save: hours/address/notes/faq ───────────────────────────────────
{
  const r = validateKnowledge({
    hours: "  א׳–ה׳ 9:00–19:00 ",
    address: "הרצל 24, ירושלים",
    notes: "חניה בחצר",
    faq: [
      { question: "יש חניה?", answer: "כן, בחצר" },
      { question: "  ", answer: "dropped — empty question" },
    ],
  });
  assert.ok(r.ok);
  assert.equal(r.value.hours, "א׳–ה׳ 9:00–19:00"); // trimmed
  assert.equal(r.value.faq.length, 1); // empty-question row dropped
  assert.equal(r.value.faq[0].question, "יש חניה?");
  assert.equal(hasKnowledgeContent(r.value), true);
}

// ── 3. empty strings → null; empty knowledge has no content ──────────────────
{
  const r = validateKnowledge({ hours: "", address: "", notes: "", faq: [] });
  assert.ok(r.ok);
  assert.deepEqual(r.value, { hours: null, address: null, notes: null, faq: [] });
  assert.equal(hasKnowledgeContent(r.value), false);
}

// ── 4. errors: wrong types / oversized / too many ────────────────────────────
{
  assert.equal(validateKnowledge(null).ok, false);
  assert.equal(validateKnowledge({ hours: 123 }).ok, false);
  assert.equal(validateKnowledge({ faq: "nope" }).ok, false);
  assert.equal(validateKnowledge({ faq: ["x"] }).ok, false); // non-object item
  assert.equal(validateKnowledge({ notes: "x".repeat(2001) }).ok, false);
  const many = Array.from({ length: MAX_FAQ_ITEMS + 1 }, (_, i) => ({ question: `q${i}`, answer: "a" }));
  assert.equal(validateKnowledge({ faq: many }).ok, false);
}

// ── 5. coerceKnowledge (read-side, forgiving) ────────────────────────────────
{
  const k = coerceKnowledge({ hours: "9-5", address: null, notes: 999, faq: [{ question: "q", answer: "a" }] });
  assert.equal(k.hours, "9-5");
  assert.equal(k.notes, null); // invalid type dropped
  assert.equal(k.faq.length, 1);
  assert.deepEqual(coerceKnowledge(null), emptyKnowledge());
}

console.log("bot-knowledge.verify: all assertions passed ✓");
