/**
 * BusinessBotProfile validators (Stage 1). Run with:
 *   npx tsx lib/features/bot/bot-profile.verify.test.ts
 *
 * Covers: allow-list validation, unknown-enum dropping, array filter+dedupe,
 * objection shape/size caps, identity length limits, partial-patch behaviour,
 * forgiving read-side coercion, and content predicates for the area-state map.
 */
import assert from "node:assert/strict";
import {
  validateVoice,
  validatePersonality,
  validateApproach,
  validateBotPatch,
  coerceStoredProfile,
  hasVoiceContent,
  hasPersonalityContent,
  hasApproachContent,
  MAX_DISPLAY_NAME_CHARS,
  MAX_OBJECTIONS,
} from "./index";

// ── 1. voice: valid passes, unknown enum dropped, arrays filtered+deduped ─────
{
  const r = validateVoice({
    tone: "friendly",
    languages: ["he", "en", "he", "klingon"],
    audienceTags: ["private", "nope"],
  });
  assert.ok(r.ok);
  assert.equal(r.value.tone, "friendly");
  assert.deepEqual(r.value.languages, ["he", "en"]); // dedupe + drop unknown
  assert.deepEqual(r.value.audienceTags, ["private"]);
}
{
  // unknown scalar tone is dropped, not an error
  const r = validateVoice({ tone: "shouty" });
  assert.ok(r.ok);
  assert.equal(r.value.tone, undefined);
  assert.equal(Object.keys(r.value).length, 0);
}
{
  // wrong structural type is a hard error
  const r = validateVoice("nope");
  assert.equal(r.ok, false);
}

// ── 2. personality ───────────────────────────────────────────────────────────
{
  const r = validatePersonality({ traits: ["friendly", "patient", "x"], verbosity: "medium" });
  assert.ok(r.ok);
  assert.deepEqual(r.value.traits, ["friendly", "patient"]);
  assert.equal(r.value.verbosity, "medium");
}

// ── 3. approach: priorities + objections shape/caps ──────────────────────────
{
  const r = validateApproach({
    saleStyle: "soft",
    initiativeLevel: "informative",
    priorities: ["customer_experience", "fast_service"],
    objections: [
      { label: "יקר לי", response: "מדגיש ערך" },
      { label: "  ", response: "ignored — empty label" },
    ],
  });
  assert.ok(r.ok);
  assert.equal(r.value.saleStyle, "soft");
  assert.deepEqual(r.value.priorities, ["customer_experience", "fast_service"]);
  assert.equal(r.value.objections?.length, 1); // empty-label row dropped
  assert.equal(r.value.objections?.[0].label, "יקר לי");
}
{
  // too many objections → hard error
  const many = Array.from({ length: MAX_OBJECTIONS + 1 }, (_, i) => ({
    label: `q${i}`,
    response: "a",
  }));
  const r = validateApproach({ objections: many });
  assert.equal(r.ok, false);
}
{
  // malformed objection entry → hard error
  const r = validateApproach({ objections: ["not-an-object"] });
  assert.equal(r.ok, false);
}

// ── 4. validateBotPatch: identity + nested profile, partial behaviour ────────
{
  const r = validateBotPatch({
    displayName: "  רוני מ-רויאל  ",
    profile: { personality: { traits: ["friendly"] } },
  });
  assert.ok(r.ok);
  assert.equal(r.value.displayName, "רוני מ-רויאל"); // trimmed
  assert.equal(r.value.avatar, undefined); // not provided → absent (partial)
  assert.deepEqual(r.value.profile?.personality?.traits, ["friendly"]);
}
{
  // empty string identity → null
  const r = validateBotPatch({ displayName: "" });
  assert.ok(r.ok);
  assert.equal(r.value.displayName, null);
}
{
  // oversized displayName → hard error
  const r = validateBotPatch({ displayName: "x".repeat(MAX_DISPLAY_NAME_CHARS + 1) });
  assert.equal(r.ok, false);
}
{
  // no recognizable fields → error
  const r = validateBotPatch({ unrelated: true });
  assert.equal(r.ok, false);
}
{
  // body not an object → error
  const r = validateBotPatch(null);
  assert.equal(r.ok, false);
}

// ── 5. coerceStoredProfile: forgiving read, drops junk ───────────────────────
{
  const p = coerceStoredProfile({
    voice: { tone: "casual", languages: ["he", "bad"] },
    personality: { verbosity: "loud" }, // invalid → dropped
    approach: null,
  });
  assert.equal(p.voice?.tone, "casual");
  assert.deepEqual(p.voice?.languages, ["he"]);
  assert.equal(p.personality, undefined); // nothing valid → block omitted
  assert.equal(p.approach, undefined);
}
{
  assert.deepEqual(coerceStoredProfile(null), {});
}

// ── 6. content predicates ────────────────────────────────────────────────────
assert.equal(hasVoiceContent({ tone: "friendly" }), true);
assert.equal(hasVoiceContent({}), false);
assert.equal(hasVoiceContent(undefined), false);
assert.equal(hasPersonalityContent({ traits: ["direct"] }), true);
assert.equal(hasPersonalityContent({}), false);
assert.equal(hasApproachContent({ objections: [{ label: "x", response: "y" }] }), true);
assert.equal(hasApproachContent({}), false);

console.log("bot-profile.verify: all assertions passed ✓");
