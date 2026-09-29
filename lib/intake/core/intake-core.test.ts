/**
 * Business Intake core (M3) — pure unit suite. Run with:
 *   npx tsx lib/intake/core/intake-core.test.ts
 *
 * No database, no network. Proves the deterministic pieces every adapter
 * relies on: event identity (collision-free, never random), attribution
 * sanitising (no query strings / PII), contact-hint normalization (shared
 * normalizers, malformed hints dropped not guessed), registry governance,
 * lifecycle state derivation, and log-field allow-listing. Plus structural
 * guards that keep the core provider-neutral.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { deriveEventIdentity, isValidReceiptKey, MissingEventIdentityError, sha256Key } from "./event-identity";
import { sanitizeAttribution, sanitizeUrl } from "./attribution";
import { normalizeContactHints } from "./contact";
import { IntakeRegistry } from "./registry";
import { deriveIntakeState } from "./trace";
import { sanitizeLogFields } from "./observability";
import { isValidEventType, isValidSourceKey, type IntakeAdapter } from "./contract";
import { receiptKey } from "../whatsapp/whatsapp-intake";

let checks = 0;
function test(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}

console.log("\nBusiness Intake core — pure suite\n");

// ── event identity ──────────────────────────────────────────────────────────
test("identity is deterministic and hashed (sha256:<hex>), never the raw id", () => {
  const a = deriveEventIdentity({ providerEventId: "wamid.ABC" });
  const b = deriveEventIdentity({ providerEventId: "wamid.ABC" });
  assert.deepEqual(a, b);
  assert.equal(isValidReceiptKey(a.externalEventId), true);
  assert.equal(a.externalEventId.includes("ABC"), false);
  assert.equal(a.dedupeBasis, "provider_event_id");
});

test("WhatsApp keys are byte-identical to M2 (redelivery after deploy still dedupes)", () => {
  assert.equal(deriveEventIdentity({ providerEventId: "wamid.X" }).externalEventId, receiptKey("wamid.X"));
  assert.equal(receiptKey("wamid.X"), sha256Key("wamid.X"));
});

test("account-scoped ids differ per account; unscoped ids do not depend on account", () => {
  const a1 = deriveEventIdentity({ providerEventId: "123", accountScope: "form-A" });
  const a2 = deriveEventIdentity({ providerEventId: "123", accountScope: "form-B" });
  const u = deriveEventIdentity({ providerEventId: "123" });
  assert.notEqual(a1.externalEventId, a2.externalEventId);
  assert.notEqual(a1.externalEventId, u.externalEventId);
});

test("fingerprint identity: explicit basis, separator-safe, and never equal to an id key", () => {
  const f1 = deriveEventIdentity({ fingerprint: ["ab", "c"] });
  const f2 = deriveEventIdentity({ fingerprint: ["a", "bc"] });
  assert.notEqual(f1.externalEventId, f2.externalEventId, "(ab,c) ≠ (a,bc)");
  assert.equal(f1.dedupeBasis, "content_fingerprint");
  assert.notEqual(deriveEventIdentity({ fingerprint: ["x"] }).externalEventId, deriveEventIdentity({ providerEventId: "x" }).externalEventId);
});

test("missing provider identity is REFUSED — never keyed by something random or accidental", () => {
  assert.throws(() => deriveEventIdentity({ providerEventId: "  " }), MissingEventIdentityError);
  assert.throws(() => deriveEventIdentity({ fingerprint: [] }), MissingEventIdentityError);
  assert.throws(() => deriveEventIdentity({ fingerprint: [null, " "] }), MissingEventIdentityError);
});

// ── vocab ─────────────────────────────────────────────────────────────────
test("sourceKey / eventType vocabulary (mirrors the DB CHECK)", () => {
  for (const ok of ["whatsapp", "meta.lead_ads", "google.lead_forms", "reference.lead_form"]) assert.equal(isValidSourceKey(ok), true, ok);
  for (const bad of ["WhatsApp", "meta..x", ".x", "x.", "has space", "a/b", "", "x".repeat(65)]) assert.equal(isValidSourceKey(bad), false, bad);
  assert.equal(isValidEventType("message.status"), true);
  assert.equal(isValidEventType("Message.Status"), false);
});

// ── attribution ─────────────────────────────────────────────────────────────
test("URLs keep origin+path only; utm_* lifted; other query/fragment dropped", () => {
  const r = sanitizeUrl("https://shop.example.com/landing?utm_source=fb&utm_campaign=spring&email=a@b.com&phone=0501234567#x");
  assert.equal(r.url, "https://shop.example.com/landing");
  assert.deepEqual(r.utm, { source: "fb", campaign: "spring" });
});

test("non-http URLs are dropped", () => {
  assert.equal(sanitizeUrl("javascript:alert(1)").url, undefined);
  assert.equal(sanitizeUrl("mailto:a@b.com").url, undefined);
  assert.equal(sanitizeUrl("not a url").url, undefined);
});

test("attribution keeps the contract shape only, bounded, control chars stripped", () => {
  const a = sanitizeAttribution({
    channel: "meta_lead_ads",
    campaignId: "123",
    adSetId: "456",
    formId: "789",
    landingPage: "https://x.co/p?utm_medium=cpc&token=SECRET",
    utm: { source: "facebook" },
    headline: "Hello\u0000\nworld",
    unknownKey: "dropped",
    campaign: "x".repeat(500),
    firstTouchAt: "2026-09-01T10:00:00Z",
  });
  assert.ok(a);
  assert.equal(a!.v, 1);
  assert.equal(a!.landingPage, "https://x.co/p");
  assert.deepEqual(a!.utm, { medium: "cpc", source: "facebook" });
  assert.equal(a!.headline, "Hello world");
  assert.equal(a!.campaign!.length, 200);
  assert.equal("unknownKey" in a!, false);
  assert.equal(JSON.stringify(a).includes("SECRET"), false);
  assert.equal(a!.firstTouchAt, "2026-09-01T10:00:00.000Z");
});

test("an empty attribution is null, not { v: 1 }", () => {
  assert.equal(sanitizeAttribution({}), null);
  assert.equal(sanitizeAttribution({ landingPage: "ftp://x" }), null);
  assert.equal(sanitizeAttribution(null), null);
});

// ── contact hints ───────────────────────────────────────────────────────────
test("phone via the canonical normalizer (Customer's unique is keyed on it)", () => {
  const r = normalizeContactHints({ phone: "050-123-4567" });
  assert.equal(r.hints?.phone, "972501234567");
  assert.equal(r.signals.phone, "valid");
});

test("email lower-cased + trimmed (signup identity); malformed hints DROPPED, marked invalid", () => {
  const r = normalizeContactHints({ email: "  Dana@Example.COM ", phone: "12" });
  assert.equal(r.hints?.email, "dana@example.com");
  assert.equal(r.hints?.phone, undefined);
  assert.equal(r.signals.phone, "invalid");
  const bad = normalizeContactHints({ email: "not-an-email" });
  assert.equal(bad.hints, null);
  assert.equal(bad.signals.email, "invalid");
});

test("names bounded and control chars stripped; nothing → null hints", () => {
  const r = normalizeContactHints({ displayName: "  Roi\u0007  Cohen ", companyName: "x".repeat(300) });
  assert.equal(r.hints?.displayName, "Roi Cohen");
  assert.equal(r.hints?.companyName?.length, 120);
  assert.deepEqual(normalizeContactHints({}), { hints: null, signals: {} });
});

// ── registry ─────────────────────────────────────────────────────────────────
function fakeAdapter(over: Partial<IntakeAdapter> = {}): IntakeAdapter {
  return {
    sourceKey: "reference.test",
    families: ["LEAD"],
    normalizerVersion: "reference.test@1",
    resolveTenant: async () => null,
    normalize: () => ({ ok: false, code: "x" }),
    route: async () => ({ kind: "ignored", code: "x" }),
    ...over,
  };
}
test("registry refuses invalid / duplicate / familyless / badly-versioned adapters", () => {
  const r = new IntakeRegistry().register(fakeAdapter());
  assert.throws(() => r.register(fakeAdapter()), /duplicate/);
  assert.throws(() => new IntakeRegistry().register(fakeAdapter({ sourceKey: "Bad Key" })), /invalid sourceKey/);
  assert.throws(() => new IntakeRegistry().register(fakeAdapter({ families: [] })), /no families/);
  assert.throws(() => new IntakeRegistry().register(fakeAdapter({ normalizerVersion: "v1" })), /normalizerVersion/);
  assert.equal(r.get("reference.test")?.sourceKey, "reference.test");
  assert.equal(r.get("nope"), null);
});

// ── lifecycle state ──────────────────────────────────────────────────────────
test("state derivation: received / processing / retrying / dead_letter / processed / ignored", () => {
  const now = new Date("2026-09-29T12:00:00Z");
  const later = new Date(now.getTime() + 60_000);
  const earlier = new Date(now.getTime() - 60_000);
  assert.equal(deriveIntakeState({ status: "RECEIVED", nextAttemptAt: null, lastAttemptAt: null }, now), "received");
  assert.equal(deriveIntakeState({ status: "RECEIVED", nextAttemptAt: later, lastAttemptAt: earlier }, now), "processing");
  assert.equal(deriveIntakeState({ status: "PERSISTED", nextAttemptAt: earlier, lastAttemptAt: earlier }, now), "received");
  assert.equal(deriveIntakeState({ status: "FAILED", nextAttemptAt: later, lastAttemptAt: earlier }, now), "retrying");
  assert.equal(deriveIntakeState({ status: "FAILED", nextAttemptAt: null, lastAttemptAt: earlier }, now), "dead_letter");
  assert.equal(deriveIntakeState({ status: "PROCESSED", nextAttemptAt: null, lastAttemptAt: earlier }, now), "processed");
  assert.equal(deriveIntakeState({ status: "IGNORED", nextAttemptAt: null, lastAttemptAt: earlier }, now), "ignored");
});

// ── observability ─────────────────────────────────────────────────────────────
test("log fields: allow-list only; values sanitized; content / contact / tokens never pass", () => {
  const out = sanitizeLogFields({
    businessId: 7,
    sourceKey: "whatsapp",
    code: "prisma:P2002",
    text: "hello customer",
    phone: "972501234567",
    token: "EAAG...",
    payload: "{...}",
  } as never);
  assert.deepEqual(Object.keys(out).sort(), ["businessId", "code", "sourceKey"]);
  assert.equal(sanitizeLogFields({ code: "a b<script>" }).code, "a_b_script_");
});

// ── structural: the core stays provider-neutral ─────────────────────────────
test("the core never branches on a provider", () => {
  const dir = path.join(process.cwd(), "lib/intake/core");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
    // Import specifiers are paths, not logic: the repository's canonical phone
    // normalizer happens to live under integrations/whatsapp/phone.ts.
    const code = readFileSync(path.join(dir, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/^import[\s\S]*?from\s+"[^"]+";/gm, "");
    assert.equal(/whatsapp|meta\b|google|WHATSAPP|wamid/i.test(code), false, `${f} mentions a provider`);
  }
});

test("the Production registry registers only real adapters (no reference/test source)", () => {
  const src = readFileSync(path.join(process.cwd(), "lib/intake/sources.ts"), "utf8");
  assert.equal(/reference|synthetic|test/i.test(src.replace(/\/\*[\s\S]*?\*\//g, "")), false);
});

test("no payload type carries a businessId (the tenant is never chosen by a payload)", () => {
  const src = readFileSync(path.join(process.cwd(), "lib/intake/core/contract.ts"), "utf8");
  const draft = src.slice(src.indexOf("export type IntakeReceiptDraft"), src.indexOf("/** A claimed receipt"));
  assert.equal(/businessId/.test(draft.replace(/\/\*[\s\S]*?\*\//g, "")), false);
});

console.log(`\nALL INTAKE CORE TESTS PASSED — ${checks} checks\n`);
