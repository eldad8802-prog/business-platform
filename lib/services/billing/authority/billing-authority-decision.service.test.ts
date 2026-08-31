/**
 * Unit tests for the held-decision execution service (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-decision.service.test.ts
 * Fully injected: no network, no DB.
 */
import {
  BillingAuthorityDecisionType,
  BillingAuthoritySubmissionStatus,
  BillingDocumentStatus,
} from "@prisma/client";
import { ConflictError } from "@/lib/errors";
import {
  executeAuthorityDecision,
  type DecisionExecutionDeps,
  type LoadedDecisionContext,
} from "@/lib/services/billing/authority/billing-authority-decision.service";
import type { DecisionDomainResult } from "@/lib/services/billing/authority/billing-authority-decision-orchestrator";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const IN = (action: "Cancel" | "Continue" | "FurtherObjection") => ({ businessId: 1, billingDocumentId: 42, actorUserId: 3, action });

const VALID_SNAPSHOT = {
  schemaVersion: 1, issuedAt: "2026-06-15T10:00:00.000Z",
  document: { id: 42, type: "TAX_INVOICE", status: "ISSUED", number: 7, numberFormatted: "000007", currency: "ILS", allocationNumber: null, referenceDocumentId: null },
  issuer: { id: 3, name: "דוביז", legalName: "דוביז", taxId: "515000123", vatRegistration: "515000123", address: null, phone: null, email: null, logoUrl: null, bankDetails: null },
  customer: { id: 7, name: "לקוח", legalName: null, taxId: null, phone: null, email: null, city: "תל אביב", address: null },
  lines: [{ lineIndex: 0, description: "שירות", quantity: "1.0000", unitPrice: "100.0000", vatRatePercent: "17.00", lineSubtotal: "100.00", vatAmount: "17.00", lineTotal: "117.00" }],
  totals: { subtotal: "100.00", vat: "17.00", total: "117.00" },
  tax: { currency: "ILS", defaultVatRate: null, vatMode: "EXCLUSIVE" },
  metadata: { locale: "he-IL", timezone: "Asia/Jerusalem", actorUserId: 1, source: "manual" },
  pdfTemplateStyle: "CLASSIC", extensions: {},
} as unknown as LoadedDecisionContext["issuedSnapshot"];

function heldContext(over: Partial<LoadedDecisionContext["submission"]> = {}): LoadedDecisionContext {
  return {
    id: 42, businessId: 1, status: BillingDocumentStatus.ISSUED,
    issuedSnapshot: VALID_SNAPSHOT,
    submission: { id: 55, status: BillingAuthoritySubmissionStatus.HELD, heldDecisionType: null, heldDecisionReportedAt: null, ...over },
  };
}

type Spies = { record: number; audit: number; send: number };
function makeDeps(cfg: { ctx?: LoadedDecisionContext | null; decision?: DecisionDomainResult; recordThrows?: Error }): { deps: DecisionExecutionDeps; spies: Spies } {
  const spies: Spies = { record: 0, audit: 0, send: 0 };
  const deps: DecisionExecutionDeps = {
    loadContext: async () => (cfg.ctx === undefined ? heldContext() : cfg.ctx),
    loadOperatorName: async () => "דנה כהן",
    resolveEnvironment: () => "SANDBOX",
    resolveRuntimeContext: async () => ({ ok: true, context: { accessToken: "tkn", approvalConfig: { apiBaseUrl: "https://x/shaam/tsandbox", apiVersion: "v2", timeoutMs: 15000 }, accountingSoftwareNumber: "12345678", connectionId: 5, environment: "SANDBOX" } }),
    requestDecision: async () => { spies.send += 1; return cfg.decision ?? { outcome: "accepted", message: "Decision accepted" }; },
    // W4E-B-2: the port now carries the trusted tenant, so the double takes
    // (businessId, fn) — the businessId is unused here because there is no DB.
    runInTransaction: (_businessId: number, fn: (tx: never) => unknown) =>
      fn({} as never),
    recordDecision: async () => { spies.record += 1; if (cfg.recordThrows) throw cfg.recordThrows; return { outcome: "APPLIED", status: BillingAuthoritySubmissionStatus.HELD, decisionType: BillingAuthorityDecisionType.PROCEED_WITHOUT_ALLOCATION, reportedAt: new Date("2026-07-18T00:00:00.000Z"), auditWritten: true }; },
    now: () => new Date("2026-07-18T00:00:00.000Z"),
    newCorrelationId: () => "corr-1",
  };
  // best-effort audit is called via createBillingAuditEventBestEffort (real module) —
  // it swallows errors; we count indirectly by not injecting it. Track via decision path instead.
  return { deps, spies };
}

async function main(): Promise<void> {
  // Continue accepted → recorded once, deliverable true.
  {
    const { deps, spies } = makeDeps({ decision: { outcome: "accepted", message: "Decision accepted" } });
    const r = await executeAuthorityDecision(IN("Continue"), deps);
    ok("Continue accepted → decision_recorded, deliverable, record once", r.outcome === "decision_recorded" && r.outcome === "decision_recorded" && r.deliverable === true && spies.record === 1);
  }
  // Cancel accepted → recorded, deliverable false.
  {
    const { deps } = makeDeps({ decision: { outcome: "accepted", message: "Decision accepted" } });
    const r = await executeAuthorityDecision(IN("Cancel"), deps);
    ok("Cancel accepted → decision_recorded, NOT deliverable", r.outcome === "decision_recorded" && r.outcome === "decision_recorded" && r.deliverable === false && r.decisionType === "ABANDONED");
  }
  // FurtherObjection accepted → recorded, deliverable false.
  {
    const { deps } = makeDeps({ decision: { outcome: "accepted", message: "Decision accepted" } });
    const r = await executeAuthorityDecision(IN("FurtherObjection"), deps);
    ok("FurtherObjection accepted → recorded, NOT deliverable", r.outcome === "decision_recorded" && r.outcome === "decision_recorded" && r.deliverable === false && r.decisionType === "HEARING_REQUESTED");
  }
  // Not HELD → not_held, NO send, NO record.
  {
    const { deps, spies } = makeDeps({ ctx: { id: 42, businessId: 1, status: BillingDocumentStatus.ISSUED, issuedSnapshot: {} as never, submission: { id: 55, status: BillingAuthoritySubmissionStatus.SUBMITTED, heldDecisionType: null, heldDecisionReportedAt: null } } });
    const r = await executeAuthorityDecision(IN("Continue"), deps);
    ok("not HELD → not_held, no send/record", r.outcome === "not_held" && spies.send === 0 && spies.record === 0);
  }
  // Already decided (same) → idempotent, NO send.
  {
    const { deps, spies } = makeDeps({ ctx: heldContext({ heldDecisionType: BillingAuthorityDecisionType.PROCEED_WITHOUT_ALLOCATION, heldDecisionReportedAt: new Date("2026-07-17T00:00:00.000Z") }) });
    const r = await executeAuthorityDecision(IN("Continue"), deps);
    ok("already decided (same) → idempotent, no send", r.outcome === "already_recorded_idempotent" && spies.send === 0);
  }
  // Already decided (different) → conflict, NO send.
  {
    const { deps, spies } = makeDeps({ ctx: heldContext({ heldDecisionType: BillingAuthorityDecisionType.ABANDONED, heldDecisionReportedAt: new Date("2026-07-17T00:00:00.000Z") }) });
    const r = await executeAuthorityDecision(IN("Continue"), deps);
    ok("already decided (different) → conflict, no send", r.outcome === "already_decided_conflict" && spies.send === 0);
  }
  // 462 → reconciliation_required, NO record (no state change).
  {
    const { deps, spies } = makeDeps({ decision: { outcome: "already_reported", code: 462, message: "already" } });
    const r = await executeAuthorityDecision(IN("Continue"), deps);
    ok("462 → reconciliation_required, no record", r.outcome === "reconciliation_required" && spies.record === 0);
  }
  // 463 → no_matching_invoice, NO record.
  {
    const { deps, spies } = makeDeps({ decision: { outcome: "no_matching_invoice", code: 463, message: "none" } });
    const r = await executeAuthorityDecision(IN("Continue"), deps);
    ok("463 → no_matching_invoice, no record", r.outcome === "no_matching_invoice" && spies.record === 0);
  }
  // network → infrastructure_failed, NO record (no false state).
  {
    const { deps, spies } = makeDeps({ decision: { outcome: "infrastructure_failure", classification: "NETWORK", message: "x" } });
    const r = await executeAuthorityDecision(IN("Continue"), deps);
    ok("network → infrastructure_failed, no record, safeToRetry", r.outcome === "infrastructure_failed" && r.outcome === "infrastructure_failed" && r.safeToRetry === true && spies.record === 0);
  }
  // authority validation → no record.
  {
    const { deps, spies } = makeDeps({ decision: { outcome: "authority_validation_failed", message: "bad" } });
    const r = await executeAuthorityDecision(IN("Continue"), deps);
    ok("authority validation → no record", r.outcome === "authority_validation_failed" && spies.record === 0);
  }
  // double-decision race: record throws ConflictError → already_decided_conflict.
  {
    const { deps } = makeDeps({ decision: { outcome: "accepted", message: "ok" }, recordThrows: new ConflictError("AUTHORITY_HELD_DECISION_CONFLICT", "race") });
    const r = await executeAuthorityDecision(IN("Continue"), deps);
    ok("accepted but record conflicts → already_decided_conflict", r.outcome === "already_decided_conflict");
  }
  // local validation (e.g. missing operator identity) surfaced by the orchestrator
  // → local_validation_failed, NO record (build/validation is tested in the payload suite).
  {
    const { deps, spies } = makeDeps({ decision: { outcome: "local_validation_failed", errors: [{ code: "MISSING_OPERATOR_IDENTITY", field: "user_id", message: "x" }] } });
    const r = await executeAuthorityDecision(IN("Continue"), deps);
    ok("local_validation_failed → no record", r.outcome === "local_validation_failed" && r.outcome === "local_validation_failed" && r.errorCode === "MISSING_OPERATOR_IDENTITY" && spies.record === 0);
  }
}

main().then(() => {
  if (failed > 0) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
  console.log("\nAll decision service tests passed.");
}).catch((e) => { console.error(e); process.exit(1); });
