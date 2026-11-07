/**
 * N10 — the PRODUCTION Approval document list (pure rules, no DB, no network).
 *
 * Run: npx tsx lib/services/billing/authority/billing-authority-pilot-approval-documents.verify.test.ts
 */
import {
  AUTHORITY_PRODUCTION_PILOT_APPROVAL_DOCUMENTS_ENV_VAR as DOCS,
  AUTHORITY_PRODUCTION_PILOT_DOCUMENT_NOT_AUTHORIZED,
  AUTHORITY_PRODUCTION_PILOT_ENV_VAR as BIZ,
  AUTHORITY_PRODUCTION_PILOT_OPERATIONS_ENV_VAR as OPS,
  AUTHORITY_PRODUCTION_PILOT_REFUSAL_CODES,
  describeAuthorityProductionPilotRefusal,
  isAuthorityProductionPilotRefusalCode,
  parseAuthorityProductionPilotApprovalDocuments,
  resolveAuthorityProductionApprovalDocumentRefusal,
  resolveAuthorityProductionPilotIssueRefusal,
} from "@/lib/services/billing/authority/billing-authority-production-pilot";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

const P = "PRODUCTION" as const;
const S = "SANDBOX" as const;
const NOT = AUTHORITY_PRODUCTION_PILOT_DOCUMENT_NOT_AUTHORIZED;

// ── grammar ──────────────────────────────────────────────────────────────────
const keys = (raw: string | undefined) => [...parseAuthorityProductionPilotApprovalDocuments(raw).keys].sort().join(" ");
const status = (raw: string | undefined) => parseAuthorityProductionPilotApprovalDocuments(raw).status;
ok("unset / empty → unset, nothing authorized", status(undefined) === "unset" && status("") === "unset" && keys(undefined) === "");
ok("one entry → ok", status("PRODUCTION:42:1001") === "ok" && keys("PRODUCTION:42:1001") === "42:1001");
ok("several entries → ok", keys("PRODUCTION:42:1001,PRODUCTION:57:2002") === "42:1001 57:2002");
ok("five entries → ok", status(Array.from({ length: 5 }, (_, i) => `PRODUCTION:42:${i + 1}`).join(",")) === "ok");
for (const bad of [
  "SANDBOX:42:1001", "production:42:1001", "PRODUCTION:42", "42:1001", "PRODUCTION:42:1001:9", "PRODUCTION:0:1001",
  "PRODUCTION:42:0", "PRODUCTION:-1:1001", "PRODUCTION:42:1.5", "PRODUCTION:042:1001", " PRODUCTION:42:1001",
  "PRODUCTION:42:1001 ", "PRODUCTION:42:1001,", ",PRODUCTION:42:1001", "PRODUCTION:42:1001,PRODUCTION:42:1001",
  "PRODUCTION:42:1001;PRODUCTION:57:2", "PRODUCTION:12345678901:1",
  Array.from({ length: 6 }, (_, i) => `PRODUCTION:42:${i + 1}`).join(","),
]) {
  ok(`invalid "${bad.slice(0, 40)}" → invalid, NOTHING authorized (not a partial list)`, status(bad) === "invalid" && keys(bad) === "");
}
ok("one bad entry invalidates the good ones too", keys("PRODUCTION:42:1001,SANDBOX:42:1002") === "");

// ── send gate ────────────────────────────────────────────────────────────────
const env = { [DOCS]: "PRODUCTION:42:1001" };
ok("listed business + document → allowed", resolveAuthorityProductionApprovalDocumentRefusal(42, 1001, P, env) === null);
ok("same document id under ANOTHER business → refused", resolveAuthorityProductionApprovalDocumentRefusal(57, 1001, P, env) === NOT);
ok("another document of the listed business → refused", resolveAuthorityProductionApprovalDocumentRefusal(42, 1002, P, env) === NOT);
ok("missing list → refused", resolveAuthorityProductionApprovalDocumentRefusal(42, 1001, P, {}) === NOT);
ok("invalid list → refused", resolveAuthorityProductionApprovalDocumentRefusal(42, 1001, P, { [DOCS]: "PRODUCTION:42:1001 " }) === NOT);
ok("environment token is part of the binding (SANDBOX entry never authorizes PRODUCTION)",
  resolveAuthorityProductionApprovalDocumentRefusal(42, 1001, P, { [DOCS]: "SANDBOX:42:1001" }) === NOT);
ok("SANDBOX is never gated", resolveAuthorityProductionApprovalDocumentRefusal(57, 9, S, {}) === null);
ok("non-integer ids → refused", resolveAuthorityProductionApprovalDocumentRefusal(Number.NaN, 1001, P, env) === NOT);

// ── issue gate ───────────────────────────────────────────────────────────────
const open = { [BIZ]: "42", [OPS]: "oauth,refresh,approval", [DOCS]: "PRODUCTION:42:1001" };
const issue = (o: Partial<{ businessId: number; billingDocumentId: number; environment: "PRODUCTION" | "SANDBOX"; wouldBeReady: boolean }>, e: Record<string, string>) =>
  resolveAuthorityProductionPilotIssueRefusal({ businessId: 42, billingDocumentId: 1001, environment: P, wouldBeReady: true, ...o }, e);
ok("issue: authorized READY document → issues", issue({}, open) === null);
ok("issue: unauthorized READY document of the pilot business, Approval open → refused (stays a draft)", issue({ billingDocumentId: 1002 }, open) === NOT);
ok("issue: a document that needs no allocation is never refused", issue({ billingDocumentId: 1002, wouldBeReady: false }, open) === null);
ok("issue: today's \"oauth\" (Approval not open) → unchanged, issues", issue({ billingDocumentId: 1002 }, { ...open, [OPS]: "oauth" }) === null);
ok("issue: operations unset → unchanged, issues", issue({ billingDocumentId: 1002 }, { [BIZ]: "42" }) === null);
ok("issue: a business not on the pilot list → unchanged, issues", issue({ businessId: 57, billingDocumentId: 1002 }, open) === null);
ok("issue: SANDBOX → unchanged, issues", issue({ billingDocumentId: 1002, environment: S }, open) === null);
ok("issue: Approval open but the document list missing → every READY document refused", issue({}, { [BIZ]: "42", [OPS]: "oauth,refresh,approval" }) === NOT);
ok("issue: \"oauth,submissions\" also requires the list", issue({ billingDocumentId: 1002 }, { ...open, [OPS]: "oauth,submissions" }) === NOT);

// ── code ─────────────────────────────────────────────────────────────────────
ok("the new code is a pilot refusal (provably not sent)",
  isAuthorityProductionPilotRefusalCode(NOT) && AUTHORITY_PRODUCTION_PILOT_REFUSAL_CODES.includes(NOT) && AUTHORITY_PRODUCTION_PILOT_REFUSAL_CODES.length === 4);
ok("its internal description names neither ids nor env values", !/\d/.test(describeAuthorityProductionPilotRefusal(NOT)));

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
