/**
 * L-8 — the knowledge-derive route's own secret. Run: npx tsx lib/security/knowledge-derive-secret.test.ts
 */
import assert from "node:assert/strict";
import { decideRecoveryAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";
import { resolveKnowledgeDeriveSecret, __resetKnowledgeDeriveSecretWarning } from "./knowledge-derive-secret";

let fail = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { fail += 1; console.log(`FAIL: ${name} — ${(e as Error).message}`); }
};
const D = "d".repeat(40);
const C = "c".repeat(40);

t("L8 dedicated secret wins; CRON_SECRET no longer opens the route", () => {
  const r = resolveKnowledgeDeriveSecret({ KNOWLEDGE_DERIVE_SECRET: D, CRON_SECRET: C }, () => {});
  assert.equal(r.source, "KNOWLEDGE_DERIVE_SECRET");
  assert.equal(decideRecoveryAuth(`Bearer ${D}`, r.secret), "AUTHORIZED");
  assert.equal(decideRecoveryAuth(`Bearer ${C}`, r.secret), "UNAUTHORIZED");
});
t("L8 a too-short dedicated secret is NOT_CONFIGURED — never a fallback to CRON_SECRET", () => {
  const r = resolveKnowledgeDeriveSecret({ KNOWLEDGE_DERIVE_SECRET: "short", CRON_SECRET: C }, () => {});
  assert.equal(decideRecoveryAuth(`Bearer ${C}`, r.secret), "NOT_CONFIGURED");
});
t("L8 unset dedicated secret: transitional CRON_SECRET fallback, warned exactly once, value never logged", () => {
  __resetKnowledgeDeriveSecretWarning();
  const logs: string[] = [];
  const r1 = resolveKnowledgeDeriveSecret({ CRON_SECRET: C }, (m) => logs.push(m));
  resolveKnowledgeDeriveSecret({ CRON_SECRET: C }, (m) => logs.push(m));
  assert.equal(r1.source, "CRON_SECRET_FALLBACK");
  assert.equal(decideRecoveryAuth(`Bearer ${C}`, r1.secret), "AUTHORIZED");
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes(C));
});
t("L8 nothing configured: fail closed (NOT_CONFIGURED)", () => {
  const r = resolveKnowledgeDeriveSecret({}, () => {});
  assert.equal(r.source, "NONE");
  assert.equal(decideRecoveryAuth(`Bearer ${C}`, r.secret), "NOT_CONFIGURED");
});
console.log(fail ? `\n${fail} FAILED` : "\nknowledge-derive secret: OK");
process.exit(fail ? 1 : 0);
