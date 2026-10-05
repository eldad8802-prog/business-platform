/**
 * All-Feature Learning Coverage — evidence kinds name the record they point at. No database. Run:
 *   npx tsx lib/knowledge/coverage/evidence-kinds.test.ts
 *
 * Every evidence kind a coverage rule emits must be mapped to its table (COVERAGE_EVIDENCE_STORES),
 * and the derived refs of the rules whose ids are easy to mislabel are checked directly: COLL-01
 * points at the INVOICE, CONV-01/02 at the CONVERSATION — not at a collection action or a message.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COVERAGE_EVIDENCE_STORES } from "./evidence-kinds";
import { deriveReminderTiming, type IncomeDocumentObservation } from "../rules/income";
import { deriveFirstReply, deriveUnanswered24h } from "../rules/funnel";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const FILES = ["lib/knowledge/rules/income.ts", "lib/knowledge/rules/funnel.ts", "lib/knowledge/rules/operations.ts"];
for (const f of FILES) {
  const src = readFileSync(join(process.cwd(), f), "utf8");
  for (const m of src.matchAll(/evidenceKind(?::|,)\s*"([^"]+)"/g)) {
    ok(`${f}: evidence kind "${m[1]}" is mapped to a table`, m[1] in COVERAGE_EVIDENCE_STORES);
  }
}
const temporal = readFileSync(join(process.cwd(), "lib/knowledge/temporal/rules.ts"), "utf8");
const coverageTemporal = temporal.slice(temporal.indexOf("All-Feature Learning Coverage W2/W3"));
for (const m of coverageTemporal.matchAll(/evidenceKind: "([^"]+)"/g)) {
  ok(`temporal (coverage): evidence kind "${m[1]}" is mapped to a table`, m[1] in COVERAGE_EVIDENCE_STORES);
}

const NOW = new Date("2026-10-01T09:00:00Z");
const DAY = 86_400_000;
const docs: IncomeDocumentObservation[] = [1, 2, 3].map((i) => ({
  recordId: 700 + i, businessId: 5, docType: "TAX_INVOICE", customerId: null, issuedAt: new Date(NOW.getTime() - (90 + i) * DAY), total: 100,
  expectedAt: new Date(NOW.getTime() - (60 + i) * DAY), settledAt: null, creditedOut: false, hasCreditNote: false,
  firstReminderAt: new Date(NOW.getTime() - (55 + i) * DAY),
}));
const coll = deriveReminderTiming(docs, NOW, 5)[0];
ok("COLL-01 evidence is the invoice (billing-document), by invoice id",
  coll.evidenceSet.refs.length === 3 && coll.evidenceSet.refs.every((r) => r.kind === "billing-document" && r.recordId >= 701 && r.recordId <= 703), coll.evidenceSet.refs);

const openings = [1, 2, 3, 4, 5].map((i) => ({ recordId: 900 + i, businessId: 5, firstInboundAt: new Date(NOW.getTime() - (10 + i) * DAY), firstReplyAt: new Date(NOW.getTime() - (10 + i) * DAY + 3_600_000) }));
for (const m of [...deriveFirstReply(openings, NOW, 5), ...deriveUnanswered24h(openings, NOW, 5)]) {
  ok(`${m.measureKey} evidence is the conversation, by conversation id`,
    m.evidenceSet.refs.length === 5 && m.evidenceSet.refs.every((r) => r.kind === "conversation" && r.recordId > 900), m.evidenceSet.refs);
}

console.log(failed === 0 ? "\nEvidence kinds: every coverage link names the table its id lives in. ✔" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
