/**
 * Business Intake M4 — identity + routing, pure suite. Run with:
 *   npx tsx lib/intake/identity/identity-core.test.ts
 *
 * No database. Pins the frozen rules and the identity primitives:
 *   - a message / an order / a call can never become a Lead (R0)
 *   - explicit leads route to Lead; uncertain identity requires owner review
 *   - commerce has no handler yet → 'unavailable' (dead-letter, payload kept)
 *   - identifier hashes: deterministic, kind- and scope-separated, never the value
 *   - placeholder emails and names are never identifiers
 *   - provider ids only exist inside their scope
 *   - identity locks: phone shares M2's WhatsApp sender lock; global order
 *   - proposal fingerprint is order-independent and evidence-sensitive
 *   - no AI / LLM / fuzzy matching anywhere in the identity or routing code
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  hashIdentifier,
  identifierHash,
  identifiersFromHints,
  isPlaceholderEmail,
  providerScope,
} from "./identifiers";
import { identityLockKeys } from "./locks";
import { proposalFingerprint } from "./proposals";
import { decideRoute } from "../routing/rules";
import { INBOUND_SENDER_ADVISORY_NAMESPACE, inboundSenderLockKey } from "../../services/conversation/inbound-customer-message.service";

let checks = 0;
function test(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}

console.log("\nM4 identity + routing — pure suite\n");

// ── routing rules ──────────────────────────────────────────────────────────
const route = (family: never, target: never, identityState: never = "unresolved" as never, core: never[] = []) =>
  decideRoute({ family, eventType: "x.y", target, identityState, coreDestinations: core });

test("R0: a MESSAGE targeting lead is FORBIDDEN (WhatsApp message ≠ Lead)", () => {
  const d = route("MESSAGE" as never, "lead" as never);
  assert.equal(d.rule, "R0_FORBIDDEN_LEAD");
  assert.equal(d.executor, "forbidden");
});

test("R0: an order (COMMERCE) or a CALL targeting lead is FORBIDDEN (Order ≠ Lead)", () => {
  assert.equal(route("COMMERCE" as never, "lead" as never).rule, "R0_FORBIDDEN_LEAD");
  assert.equal(route("CALL" as never, "lead" as never).rule, "R0_FORBIDDEN_LEAD");
  assert.equal(route("FORM_SUBMISSION" as never, "lead" as never).rule, "R0_FORBIDDEN_LEAD");
});

test("R1: a MESSAGE to conversation stays with the adapter (M2 path), never a lead", () => {
  const d = route("MESSAGE" as never, "conversation" as never, "resolved" as never);
  assert.deepEqual([d.rule, d.destination, d.executor], ["R1_MESSAGE", "conversation", "adapter"]);
});

test("R4: an explicit LEAD routes to Lead; the core runs it only when the adapter opted in", () => {
  assert.equal(route("LEAD" as never, "lead" as never, "resolved" as never, ["lead" as never]).executor, "core");
  assert.equal(route("LEAD" as never, "lead" as never, "resolved" as never).executor, "adapter");
});

test("R4: uncertain identity (candidate / ambiguous / conflict) requires owner review", () => {
  for (const s of ["candidate", "ambiguous", "conflict"]) {
    assert.equal(route("LEAD" as never, "lead" as never, s as never, ["lead" as never]).ownerReviewRequired, true, s);
  }
  for (const s of ["resolved", "unresolved", "not_applicable"]) {
    assert.equal(route("LEAD" as never, "lead" as never, s as never, ["lead" as never]).ownerReviewRequired, false, s);
  }
});

test("R5: COMMERCE → commerce, 'unavailable' until a handler exists (never Lead)", () => {
  const d = route("COMMERCE" as never, "commerce" as never);
  assert.deepEqual([d.rule, d.destination, d.executor], ["R5_COMMERCE", "commerce", "unavailable"]);
});

test("R2/R3/R6/R7/R8: status, document, form, none and the default are distinct named rules", () => {
  assert.equal(route("MESSAGE" as never, "message_status" as never).rule, "R2_MESSAGE_STATUS");
  assert.equal(route("MESSAGE" as never, "document" as never).rule, "R3_DOCUMENT");
  assert.equal(route("FORM_SUBMISSION" as never, "attention" as never).rule, "R6_FORM_ATTENTION");
  assert.equal(route("MESSAGE" as never, "none" as never).rule, "R7_NONE");
  assert.equal(route("EMAIL" as never, "attention" as never).rule, "R8_ATTENTION_DEFAULT");
});

test("identity state never turns a MESSAGE into a Lead (all states)", () => {
  for (const s of ["resolved", "candidate", "ambiguous", "unresolved", "conflict", "not_applicable"]) {
    assert.notEqual(route("MESSAGE" as never, "conversation" as never, s as never, ["lead" as never]).destination, "lead");
  }
});

// ── identifiers ─────────────────────────────────────────────────────────────
test("identifier hash: deterministic, sha256 shape, never contains the value", () => {
  const a = identifierHash({ kind: "email", scope: "", value: "dana@example.test" });
  assert.equal(a, identifierHash({ kind: "email", scope: "", value: "dana@example.test" }));
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a.includes("dana"), false);
});

test("identifier hash: kind- and scope-separated (same value, different meaning, different hash)", () => {
  const v = "972501234567";
  const phone = identifierHash({ kind: "phone", scope: "", value: v });
  const prov1 = identifierHash({ kind: "provider", scope: "meta.lead_ads:page1", value: v });
  const prov2 = identifierHash({ kind: "provider", scope: "meta.lead_ads:page2", value: v });
  assert.notEqual(phone, prov1);
  assert.notEqual(prov1, prov2);
});

test("placeholder / malformed emails are never identifiers", () => {
  for (const e of ["noreply@shop.co.il", "no-reply@x.com", "test@anything.io", "a@example.com", "x@y.invalid", "nolocal"]) {
    assert.equal(isPlaceholderEmail(e), true, e);
  }
  for (const e of ["dana@example.test", "roi@company.co.il"]) assert.equal(isPlaceholderEmail(e), false, e);
});

test("provider scope: required; ids are never global", () => {
  assert.equal(providerScope("meta.lead_ads", "page-1"), "meta.lead_ads:page-1");
  assert.equal(providerScope("meta.lead_ads", null), null);
  assert.equal(providerScope("Bad Key", "p"), null);
  assert.equal(providerScope("x", "has space"), null);
});

test("identifiersFromHints: phone, email, scoped provider id — names are NEVER identifiers", () => {
  const ids = identifiersFromHints(
    { phone: "972501234567", email: "dana@example.test", providerUserId: "u1", displayName: "Dana", companyName: "Levi" },
    { sourceKey: "reference.lead_form", accountRef: "form-A" }
  );
  assert.deepEqual(ids.map((i) => i.kind).sort(), ["email", "phone", "provider"]);
  assert.equal(ids.find((i) => i.kind === "provider")?.scope, "reference.lead_form:form-A");
  const noScope = identifiersFromHints({ providerUserId: "u1" }, { sourceKey: "x", accountRef: null });
  assert.equal(noScope.length, 0, "a provider id without its account scope is not an identifier");
  const placeholder = identifiersFromHints({ email: "noreply@x.com" }, { sourceKey: "x", accountRef: "a" });
  assert.equal(placeholder.length, 0);
});

// ── locks ─────────────────────────────────────────────────────────────────
test("identity locks: phone uses M2's WhatsApp sender lock (same namespace AND key)", () => {
  const [[ns, key]] = identityLockKeys(7, [{ kind: "phone", scope: "", value: "972501234567" }]);
  assert.equal(ns, INBOUND_SENDER_ADVISORY_NAMESPACE);
  assert.equal(key, inboundSenderLockKey(7, "972501234567"));
});

test("identity locks: deterministic global order, deduplicated, business-scoped", () => {
  const ids = [
    { kind: "email" as const, scope: "", value: "dana@example.test" },
    { kind: "phone" as const, scope: "", value: "972501234567" },
    { kind: "email" as const, scope: "", value: "dana@example.test" },
  ];
  const a = identityLockKeys(7, ids);
  const b = identityLockKeys(7, [...ids].reverse());
  assert.deepEqual(a, b, "same order whatever the input order");
  assert.equal(a.length, 2, "duplicates collapse");
  assert.notDeepEqual(identityLockKeys(8, ids), a, "another business locks other keys");
});

// ── proposals ───────────────────────────────────────────────────────────────
test("proposal fingerprint: order-independent, sensitive to candidates / links / reason", () => {
  const links = [hashIdentifier({ kind: "email", scope: "", value: "a@b.test" }), hashIdentifier({ kind: "phone", scope: "", value: "972500000000" })];
  const f1 = proposalFingerprint({ reason: "ambiguous", candidateIds: [3, 1], links });
  const f2 = proposalFingerprint({ reason: "ambiguous", candidateIds: [1, 3], links: [...links].reverse() });
  assert.equal(f1, f2);
  assert.notEqual(f1, proposalFingerprint({ reason: "conflict", candidateIds: [1, 3], links }));
  assert.notEqual(f1, proposalFingerprint({ reason: "ambiguous", candidateIds: [1], links }));
  assert.match(f1, /^sha256:[0-9a-f]{64}$/);
});

// ── structural: no AI / fuzzy identity; no provider branching in routing ─────
test("identity + routing code carries no LLM call, no fuzzy / similarity matching", () => {
  const dirs = ["lib/intake/identity", "lib/intake/routing"];
  for (const d of dirs) {
    for (const f of readdirSync(path.join(process.cwd(), d)).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
      const code = readFileSync(path.join(process.cwd(), d, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      assert.equal(/openai|anthropic|llm|levenshtein|similarity|fuzzy|trigram|soundex|ILIKE|contains:/i.test(code), false, `${d}/${f}`);
    }
  }
});

test("routing rules never name a provider", () => {
  const code = readFileSync(path.join(process.cwd(), "lib/intake/routing/rules.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/^import[\s\S]*?from\s+"[^"]+";/gm, "");
  assert.equal(/whatsapp|meta|google|shopify/i.test(code), false);
});

console.log(`\nALL M4 IDENTITY CORE TESTS PASSED — ${checks} checks\n`);
