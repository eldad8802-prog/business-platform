/**
 * Unit tests for the Invoice-decision orchestrator (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-decision-orchestrator.test.ts
 * Fully injected: no network, no DB.
 */
import {
  requestInvoiceDecision,
  type DecisionOrchestratorDeps,
} from "@/lib/services/billing/authority/billing-authority-decision-orchestrator";
import type { DecisionClientResult } from "@/lib/services/billing/authority/billing-authority-decision-client.types";
import type { DecisionPayloadBuildResult } from "@/lib/services/billing/authority/billing-authority-decision-payload";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const INPUT = {
  action: "Continue" as const,
  accessToken: "t",
  config: { apiBaseUrl: "https://x/shaam/tsandbox", apiVersion: "v1", timeoutMs: 15000 },
  payloadInput: { billingDocumentId: 42, issuerVatNumber: "515000123", accountingSoftwareNumber: "12345678", operatorName: "דנה" },
};
const okBuild: DecisionPayloadBuildResult = { ok: true, payload: { invoice_id: "42", vat_number: 515000123, accounting_software_number: 12345678, user_name: "דנה" } };

function deps(build: DecisionPayloadBuildResult, send: DecisionClientResult | Error): { deps: DecisionOrchestratorDeps; calls: { n: number } } {
  const calls = { n: 0 };
  return {
    calls,
    deps: {
      buildPayload: () => build,
      sendDecision: async () => { calls.n += 1; if (send instanceof Error) throw send; return send; },
    },
  };
}

async function main(): Promise<void> {
  // build fails → local_validation_failed, client NOT called.
  {
    const d = deps({ ok: false, errors: [{ code: "MISSING_OPERATOR_IDENTITY", field: "user_id", message: "x" }] }, { kind: "accepted", httpStatus: 200, response: { status: 200, message: "ok" } });
    const r = await requestInvoiceDecision(INPUT, d.deps);
    ok("build fail → local_validation_failed, no send", r.outcome === "local_validation_failed" && d.calls.n === 0);
  }
  // accepted.
  {
    const d = deps(okBuild, { kind: "accepted", httpStatus: 200, response: { status: 200, message: "Decision accepted" } });
    const r = await requestInvoiceDecision(INPUT, d.deps);
    ok("accepted → accepted (send once)", r.outcome === "accepted" && d.calls.n === 1);
  }
  // 462.
  {
    const d = deps(okBuild, { kind: "already_reported", httpStatus: 462, code: 462, message: "already" });
    const r = await requestInvoiceDecision(INPUT, d.deps);
    ok("462 → already_reported", r.outcome === "already_reported" && r.outcome === "already_reported" && r.code === 462);
  }
  // 463.
  {
    const d = deps(okBuild, { kind: "no_matching_invoice", httpStatus: 463, code: 463, message: "none" });
    const r = await requestInvoiceDecision(INPUT, d.deps);
    ok("463 → no_matching_invoice", r.outcome === "no_matching_invoice");
  }
  // validation.
  {
    const d = deps(okBuild, { kind: "validation_error", httpStatus: 400, classification: "BUSINESS_VALIDATION", message: "bad" });
    const r = await requestInvoiceDecision(INPUT, d.deps);
    ok("400 → authority_validation_failed", r.outcome === "authority_validation_failed");
  }
  // network.
  {
    const d = deps(okBuild, { kind: "infrastructure_error", httpStatus: null, classification: "NETWORK", message: "x" });
    const r = await requestInvoiceDecision(INPUT, d.deps);
    ok("network → infrastructure_failure/NETWORK", r.outcome === "infrastructure_failure" && r.classification === "NETWORK");
  }
  // client throws → infrastructure_failure.
  {
    const d = deps(okBuild, new Error("boom"));
    const r = await requestInvoiceDecision(INPUT, d.deps);
    ok("throw → infrastructure_failure", r.outcome === "infrastructure_failure");
  }
}

main().then(() => {
  if (failed > 0) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
  console.log("\nAll decision orchestrator tests passed.");
}).catch((e) => { console.error(e); process.exit(1); });
