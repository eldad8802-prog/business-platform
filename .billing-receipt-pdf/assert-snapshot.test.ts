/**
 * The single approved exception to the billing freeze (2026-11-09): assertSnapshotV1 accepts an EMPTY goods-line array
 * for a pure RECEIPT only. Pure (no DB/network/clock). The snapshots are the A0 fixtures — built by the EXISTING
 * snapshot builders for all five types — so nothing here invents a document shape.
 *
 * Proves: every type with its lines passes as before; with no lines ONLY a RECEIPT passes; a missing / non-array
 * `lines` is still refused for every type, RECEIPT included; every other check still refuses a RECEIPT.
 *
 * Run: npx tsx .billing-receipt-pdf/assert-snapshot.test.ts
 */
import { assertSnapshotV1 } from "../lib/services/billing/pdf/billing-pdf-template";
import { buildCases } from "../.billing-a0/fixtures";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}
const accepts = (s: unknown) => {
  try {
    assertSnapshotV1(s);
    return true;
  } catch {
    return false;
  }
};
const refusal = (s: unknown) => {
  try {
    assertSnapshotV1(s);
    return "accepted";
  } catch (e) {
    return (e as Error).message;
  }
};
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const cases = buildCases();
const types = [...new Set(cases.map((c) => c.type as string))].sort();
ok("the A0 fixtures cover the five existing types", types.join() === "CREDIT_NOTE,QUOTE,RECEIPT,TAX_INVOICE,TAX_INVOICE_RECEIPT", types.join());

console.log("as before: every fixture passes as it is");
for (const c of cases) ok(`${c.key} passes unchanged`, accepts(c.snapshot), refusal(c.snapshot));

console.log("no goods lines: only a RECEIPT passes");
const withLines = cases.filter((c) => Array.isArray((c.snapshot as { lines: unknown[] }).lines) && (c.snapshot as { lines: unknown[] }).lines.length > 0);
for (const c of withLines) {
  const s = clone(c.snapshot) as { lines: unknown[] };
  s.lines = [];
  ok(`${c.key} with no lines is still refused`, refusal(s) === "Invalid issued snapshot: lines must be a non-empty array", refusal(s));
}
const receipts = cases.filter((c) => c.type === "RECEIPT");
ok("the RECEIPT fixtures have no goods lines (the shape real issuance freezes)", receipts.length >= 1 && receipts.every((c) => (c.snapshot as { lines: unknown[] }).lines.length === 0));
for (const c of receipts) ok(`${c.key} with no lines passes`, accepts(c.snapshot), refusal(c.snapshot));

console.log("the array itself is still required — for a RECEIPT too");
for (const c of [...receipts, ...withLines.slice(0, 2)]) {
  for (const [label, value] of [["missing", undefined], ["null", null], ["object", {}], ["string", "x"]] as const) {
    const s = clone(c.snapshot) as Record<string, unknown>;
    if (value === undefined) delete s.lines;
    else s.lines = value;
    ok(`${c.key}: lines ${label} → refused`, refusal(s) === "Invalid issued snapshot: lines must be a non-empty array", refusal(s));
  }
}

console.log("every other check still refuses a RECEIPT");
const r = receipts[0].snapshot as unknown as Record<string, Record<string, unknown> | unknown>;
type Loose = { schemaVersion?: unknown; document: Record<string, unknown>; issuer: Record<string, unknown>; customer: Record<string, unknown>; totals?: unknown };
const broken: [string, (s: Loose) => void, string][] = [
  ["schemaVersion", (s) => (s.schemaVersion = 2), "Unsupported issuedSnapshot.schemaVersion"],
  ["document.numberFormatted", (s) => delete s.document.numberFormatted, "document.numberFormatted missing"],
  ["issuer.name", (s) => delete s.issuer.name, "issuer.name missing"],
  ["customer.name", (s) => delete s.customer.name, "customer.name missing"],
  ["totals", (s) => delete s.totals, "totals"],
];
for (const [label, mutate, expected] of broken) {
  const s = clone(r) as unknown as Loose;
  mutate(s);
  ok(`RECEIPT without ${label} → refused`, refusal(s).includes(expected), refusal(s));
}
ok("not an object → refused", refusal(null) === "Invalid issued snapshot: not an object");

console.log(`\n${pass}/${pass + failures.length} passed`);
if (failures.length) process.exit(1);
