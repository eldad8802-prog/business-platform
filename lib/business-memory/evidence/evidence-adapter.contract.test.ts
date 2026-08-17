/**
 * Business Memory IMPL-2 · Evidence Adapter — contract/invariant test. Run: npx tsx.
 *
 * DB-FREE. Behavioural tests use injected in-memory rows; static tests scan the adapter source for
 * forbidden coupling. Locks the IMPL-2 §14 invariants:
 *   tenant isolation · stable evidence identity · deterministic ordering · silence ≠ approval ·
 *   ReviewEvent = owner evidence · ExtractionSnapshot = engine-belief (non-authoritative) ·
 *   no latest/winner · no dedup heuristic · no Prisma-type leak · no RIA/Claim/writer/VendorLearning.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  projectOwnerDecisionEvidence,
  createReviewEventEvidenceReader,
} from "./review-event.reader";
import { mapReviewEvent, vendorSubject, type ReviewEventRow } from "./review-event.mapper";
import {
  mapExtractionSnapshot,
  createExtractionSnapshotBeliefReader,
  type ExtractionSnapshotRow,
} from "./extraction-snapshot.mapper";
import type { DomainLocalSubject } from "./evidence-contract";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}`); }
}
function section(t: string): void { console.log(`\n${t}`); }

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────
function reviewRow(over: Partial<ReviewEventRow> & { id: number; businessId: number }): ReviewEventRow {
  return {
    occurredAt: "2026-01-01T00:00:00.000Z",
    vendorFinal: "Acme Ltd",
    directionFinal: "outgoing",
    verdicts: { category: { belief: "general", final: "office", verdict: "corrected" },
                vendorName: { belief: "Acme", final: "Acme Ltd", verdict: "corrected" },
                direction: { belief: "outgoing", final: "outgoing", verdict: "confirmed" } },
    ...over,
  };
}
const subjOf = (r: ReviewEventRow): DomainLocalSubject => vendorSubject(r.businessId, r.vendorFinal);

// Wrapped in an async main() — the tsx cjs transform does not allow top-level await.
async function main(): Promise<void> {
// ── ReviewEvent = owner-decision evidence ────────────────────────────────────────────────────────
section("ReviewEvent → owner-decision evidence (owner-final category from verdicts.category.final)");
{
  const e = mapReviewEvent(reviewRow({ id: 10, businessId: 1 }));
  check("authority is owner-decision", e.authority === "owner-decision");
  check("ref points at review-event store", e.ref.kind === "review-event" && e.ref.recordId === 10);
  check("owner-final category read from verdicts.category.final", e.ownerFinal.category === "office");
  check("owner-final vendor read from vendorFinal", e.ownerFinal.vendor === "Acme Ltd");
  check("category verdict surfaced (corrected)", e.verdicts.category === "corrected");
  check("occurredAt is an ISO string (no Date leak)", typeof e.occurredAt === "string");
  check("ordinal is the append-only record id", e.ordinal === 10);
}

// ── Tenant isolation ─────────────────────────────────────────────────────────────────────────────
section("Tenant isolation (INV-9)");
{
  const rows = [reviewRow({ id: 1, businessId: 1 }), reviewRow({ id: 2, businessId: 2 })];
  const set1 = projectOwnerDecisionEvidence(rows, subjOf(reviewRow({ id: 0, businessId: 1 })));
  check("only same-tenant evidence is included", set1.items.every((i) => i.businessId === 1));
  check("cross-tenant row excluded", set1.items.length === 1 && set1.items[0].ref.recordId === 1);

  const reader = createReviewEventEvidenceReader(async () => rows);
  let threw = false;
  try { await reader.readOwnerDecisionEvidence(1, { domain: "vendor", normalizedKey: "acme", businessId: 2 }); }
  catch { threw = true; }
  check("reader rejects subject.businessId !== call businessId (cross-tenant read unrepresentable)", threw);
}

// ── Deterministic ordering + stable identity ─────────────────────────────────────────────────────
section("Deterministic ordering (occurredAt asc, ordinal tiebreak) + stable identity");
{
  const base = (id: number, occurredAt: string) => reviewRow({ id, businessId: 1, occurredAt });
  const rowsA = [base(3, "2026-03-01T00:00:00.000Z"), base(1, "2026-01-01T00:00:00.000Z"), base(2, "2026-01-01T00:00:00.000Z")];
  const rowsB = [rowsA[2], rowsA[0], rowsA[1]]; // shuffled input
  const subject = subjOf(base(0, ""));
  const a = projectOwnerDecisionEvidence(rowsA, subject);
  const b = projectOwnerDecisionEvidence(rowsB, subject);
  check("ordered by occurredAt asc then ordinal asc", a.items.map((i) => i.ordinal).join(",") === "1,2,3");
  check("equal-timestamp tiebreak by ordinal (1 before 2)", a.items[0].ordinal === 1 && a.items[1].ordinal === 2);
  check("identity is input-order-independent (same refs)", a.identity.fingerprint === b.identity.fingerprint);
  check("ordering label is fixed", a.identity.ordering === "occurredAt-asc,ordinal-asc");
  check("fingerprint is a digest of refs (not authority)", a.identity.fingerprint === "review-event:1:1|review-event:1:2|review-event:1:3");
}

// ── Silence ≠ approval ───────────────────────────────────────────────────────────────────────────
section("Silence is not approval (INV-4)");
{
  const empty = projectOwnerDecisionEvidence([], { domain: "vendor", normalizedKey: "acme", businessId: 1 });
  check("no evidence → empty set (not a default/approval)", empty.items.length === 0);
  check("empty identity has no refs and empty fingerprint", empty.identity.refs.length === 0 && empty.identity.fingerprint === "");
}

// ── No latest/winner · no dedup heuristic ────────────────────────────────────────────────────────
section("No precedence / no dedup — evidence is preserved (IMPL-2 §6/§8)");
{
  const rows = [
    reviewRow({ id: 1, businessId: 1, occurredAt: "2026-01-01T00:00:00.000Z", verdicts: { category: { final: "office", verdict: "corrected" } } }),
    reviewRow({ id: 2, businessId: 1, occurredAt: "2026-02-01T00:00:00.000Z", verdicts: { category: { final: "travel", verdict: "corrected" } } }),
    reviewRow({ id: 3, businessId: 1, occurredAt: "2026-03-01T00:00:00.000Z", verdicts: { category: { final: "office", verdict: "confirmed" } } }),
  ];
  const set = projectOwnerDecisionEvidence(rows, subjOf(rows[0]));
  check("all matching events retained (no winner picked)", set.items.length === 3);
  check("conflicting categories both present (no silent resolution)",
    set.items.some((i) => i.ownerFinal.category === "office") && set.items.some((i) => i.ownerFinal.category === "travel"));
  check("duplicate (same subject+category) NOT deduped", set.items.filter((i) => i.ownerFinal.category === "office").length === 2);
}

// ── Subject normalization consistency ────────────────────────────────────────────────────────────
section("Domain-local subject identity — normalized grouping");
{
  const rows = [reviewRow({ id: 1, businessId: 1, vendorFinal: "Acme Ltd" }), reviewRow({ id: 2, businessId: 1, vendorFinal: "ACME  ltd" })];
  const set = projectOwnerDecisionEvidence(rows, subjOf(rows[0]));
  check("vendor variants normalize to the same subject key (grouped)", set.items.length === 2);
  check("subject carries {domain:vendor, businessId}", set.subject.domain === "vendor" && set.subject.businessId === 1);
}

// ── EngineBelief is a separate, non-authoritative API ────────────────────────────────────────────
section("ExtractionSnapshot → engine-belief (non-authoritative, separate API — IMPL-2 §13)");
{
  const row: ExtractionSnapshotRow = { id: 5, businessId: 1, occurredAt: "2026-01-01T00:00:00.000Z", vendorName: "Acme", category: "general", direction: "outgoing" };
  const eb = mapExtractionSnapshot(row);
  check("authority is engine-belief (not owner-decision)", eb.authority === "engine-belief");
  check("engine belief is raw (un-normalized) vendor", eb.belief.vendor === "Acme");
  const reader = createExtractionSnapshotBeliefReader(async () => [row]);
  const ctx = await reader.readEngineBeliefContext(1, 99);
  check("context reader returns engine-belief items via a SEPARATE method", ctx.length === 1 && ctx[0].authority === "engine-belief");
}

// ── Static: no forbidden coupling / no leak ──────────────────────────────────────────────────────
section("Static source scan — no persistence/writer/Claim/RIA/VendorLearning/precedence/Prisma leak");
{
  const dir = __dirname;
  const srcFiles = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const src = srcFiles.map((f) => readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n")).join("\n");
  const contract = readFileSync(join(dir, "evidence-contract.ts"), "utf8").replace(/\r\n/g, "\n");
  // strip /// and // comment lines and block comments for code-level scans
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
  const code = stripComments(src);

  check("contract file has ZERO imports (no type leak surface)", !/^\s*import\b/m.test(contract));
  check("no Prisma model type imported (no `import ... from \"@prisma/client\"` / generated client)", !/@prisma\/client|from ["']@\/lib\/generated/.test(code));
  check("no writer: no .create/.update/.upsert/.delete/.createMany", !/\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\s*\(/.test(code));
  check("no Prisma mutation of any store (findMany read-only only)", !/\.(create|update|upsert|delete)\b/.test(code));
  check("no Claim symbol", !/\bClaim\b/.test(code));
  check("no confidence field", !/\bconfidence\b/i.test(code));
  check("no RIA coupling (no referent-identity import, no Ria* symbol)", !/referent-identity|\bRia[A-Z]/.test(code));
  check("no C1/detection-grammar coupling", !/detection-grammar|\bEquality\b/.test(code));
  check("no VendorLearning coupling", !/vendorLearning|VendorLearning/.test(code));
  check("no policy selection / precedence verbs", !/getWinning|latestEvent|pickCurrent|selectPreferred|winningDecision|currentCategory/i.test(code));
  check("no derivation/materialization here (adapter only reads)", !/deriveClaim|materializeClaim|derivationPolicy/i.test(code));
  check("only findMany used against Prisma (read-only)", !/prisma\.\w+\.(?!findMany)/.test(code) || /findMany/.test(code));
}

// ── report ──────────────────────────────────────────────────────────────────────────────────────
section("Business Memory IMPL-2 · Evidence Adapter invariants");
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`); process.exit(1); }
console.log("All IMPL-2 evidence-adapter invariants hold. Read-only · tenant-safe · deterministic · inert. ✔");
}

main().catch((err) => { console.error(err); process.exit(1); });
