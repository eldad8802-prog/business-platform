/**
 * Business Memory IMPL-5A · Claim persistence Writer — invariant test. npx tsx. DB-FREE.
 *
 * Uses an injected FAKE client whose $transaction models real rollback (buffer ops; commit on success,
 * discard on throw), so atomicity/idempotency are provable without a database.
 */
import { materializeClaim } from "./claim-writer";
import { MaterializationRejected } from "./claim-writer.validate";
import type { ClaimWriterClient, ClaimWriterTx, MaterializationCommand } from "./claim-writer.contract";
import type { EvidenceRef } from "@/lib/business-memory/evidence";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}`); }
}
function section(t: string): void { console.log(`\n${t}`); }
async function rejects(name: string, fn: () => Promise<unknown>, kind = MaterializationRejected): Promise<void> {
  let threw: unknown = null;
  try { await fn(); } catch (e) { threw = e; }
  check(name, threw instanceof kind);
}

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────
const ref = (id: number, businessId = 1): EvidenceRef => ({ kind: "review-event", businessId, recordId: id });
type Result = MaterializationCommand["result"];
function result(over: Partial<Result> = {}): Result {
  return {
    subject: { domain: "vendor", normalizedKey: "acme", businessId: 1 },
    claimType: "vendor-category",
    policyVersionId: 10,
    evidenceSetIdentity: { refs: [ref(1), ref(2), ref(3)], ordering: "occurredAt-asc,ordinal-asc", fingerprint: "fp" },
    state: "supported",
    candidates: [{ claimType: "vendor-category", propositionValue: "Office", supportingRefs: [ref(1)] }],
    ...over,
  } as Result;
}
const slotKey = (w: { businessId: number; subjectDomain: string; subjectNormalizedKey: string; claimType: string; policyVersionId: number }) =>
  `${w.businessId}|${w.subjectDomain}|${w.subjectNormalizedKey}|${w.claimType}|${w.policyVersionId}`;

// Fake client: a committed store + a transactional $transaction that rolls back on throw.
function makeClient(opts: { policyIds?: Set<number>; seedSlots?: string[]; failOnCreate?: boolean } = {}) {
  const store = new Map<string, { data: unknown }>();
  for (const s of opts.seedSlots ?? []) store.set(s, { data: {} });
  const policyIds = opts.policyIds ?? new Set([10]);
  let created = 0;
  const client: ClaimWriterClient = {
    async $transaction(fn) {
      const ops: Array<{ type: "delete"; key: string } | { type: "create"; key: string; data: unknown }> = [];
      const tx: ClaimWriterTx = {
        derivationPolicyVersion: {
          async findUnique({ where }) { return policyIds.has(where.id) ? { id: where.id } : null; },
        },
        derivedClaimProjection: {
          async deleteMany({ where }) { const key = slotKey(where); ops.push({ type: "delete", key }); return { count: store.has(key) ? 1 : 0 }; },
          async create({ data }) { if (opts.failOnCreate) throw new Error("simulated create failure"); const key = slotKey(data); ops.push({ type: "create", key, data }); return { id: ++created }; },
        },
      };
      const r = await fn(tx); // if this throws, ops are discarded below (rollback)
      for (const op of ops) { if (op.type === "delete") store.delete(op.key); else store.set(op.key, { data: op.data }); }
      return r;
    },
  };
  return { client, store };
}

async function main(): Promise<void> {
  // ── Validation (fail-closed, pre-mutation) ────────────────────────────────────────────────────
  section("Validation — reject before any mutation (§6/§7)");
  {
    const { client, store } = makeClient();
    await rejects("tenant mismatch (subject.businessId != command.businessId)",
      () => materializeClaim({ businessId: 2, result: result() }, client));
    await rejects("cross-tenant supporting ref",
      () => materializeClaim({ businessId: 1, result: result({ candidates: [{ claimType: "vendor-category", propositionValue: "Office", supportingRefs: [ref(1, 2)] }], evidenceSetIdentity: { refs: [ref(1, 2)], ordering: "occurredAt-asc,ordinal-asc", fingerprint: "fp" } }) }, client));
    await rejects("cross-tenant evidenceSet ref",
      () => materializeClaim({ businessId: 1, result: result({ evidenceSetIdentity: { refs: [ref(1, 2)], ordering: "occurredAt-asc,ordinal-asc", fingerprint: "fp" } }) }, client));
    await rejects("supporting ref outside evidenceSet",
      () => materializeClaim({ businessId: 1, result: result({ candidates: [{ claimType: "vendor-category", propositionValue: "Office", supportingRefs: [ref(99)] }] }) }, client));
    await rejects("duplicate proposition value",
      () => materializeClaim({ businessId: 1, result: result({ state: "conflicting", candidates: [
        { claimType: "vendor-category", propositionValue: "Office", supportingRefs: [ref(1)] },
        { claimType: "vendor-category", propositionValue: "Office", supportingRefs: [ref(2)] }] }) }, client));
    await rejects("candidate with zero supporting refs",
      () => materializeClaim({ businessId: 1, result: result({ candidates: [{ claimType: "vendor-category", propositionValue: "Office", supportingRefs: [] }] }) }, client));
    await rejects("state 'supported' with 2 candidates (state/rowset mismatch)",
      () => materializeClaim({ businessId: 1, result: result({ state: "supported", candidates: [
        { claimType: "vendor-category", propositionValue: "Office", supportingRefs: [ref(1)] },
        { claimType: "vendor-category", propositionValue: "Travel", supportingRefs: [ref(2)] }] }) }, client));
    check("no DB mutation occurred on any rejected command", store.size === 0);
  }

  // ── PolicyVersion existence (W-A) ─────────────────────────────────────────────────────────────
  section("PolicyVersion existence guard (§4/§17) — fail closed, no partial write");
  {
    const { client, store } = makeClient({ policyIds: new Set([]) }); // no policy version exists
    await rejects("missing policyVersionId rejected inside tx", () => materializeClaim({ businessId: 1, result: result() }, client));
    check("rollback: nothing persisted when policy version missing", store.size === 0);
  }

  // ── Supported ─────────────────────────────────────────────────────────────────────────────────
  section("Supported → projection + one candidate");
  {
    const { client, store } = makeClient();
    const out = await materializeClaim({ businessId: 1, result: result() }, client);
    check("action = created", out.action === "created");
    check("candidateCount = 1, evidenceLinkCount = 1", out.candidateCount === 1 && out.evidenceLinkCount === 1);
    check("one projection persisted", store.size === 1);
  }

  // ── Conflicting (no winner) ───────────────────────────────────────────────────────────────────
  section("Conflicting → both candidates, no winner");
  {
    const { client, store } = makeClient();
    const r = result({ state: "conflicting", candidates: [
      { claimType: "vendor-category", propositionValue: "Office", supportingRefs: [ref(1), ref(3)] },
      { claimType: "vendor-category", propositionValue: "Inventory", supportingRefs: [ref(2)] }] });
    const out = await materializeClaim({ businessId: 1, result: r }, client);
    const data = [...store.values()][0].data as { candidates: { create: Array<{ propositionValue: string }> } };
    const values = data.candidates.create.map((c) => c.propositionValue);
    check("both candidates persisted", values.includes("Office") && values.includes("Inventory"));
    check("candidates ordered by proposition value (Inventory<Office; not precedence)", values.join(",") === "Inventory,Office");
    check("candidateCount = 2, evidenceLinkCount = 3", out.candidateCount === 2 && out.evidenceLinkCount === 3);
  }

  // ── Insufficient / withdrawn → delete slot, no empty root ─────────────────────────────────────
  section("Insufficient / withdrawn → delete existing slot, create nothing");
  {
    const seed = slotKey({ businessId: 1, subjectDomain: "vendor", subjectNormalizedKey: "acme", claimType: "vendor-category", policyVersionId: 10 });
    for (const state of ["insufficient", "withdrawn"] as const) {
      const withExisting = makeClient({ seedSlots: [seed] });
      const out1 = await materializeClaim({ businessId: 1, result: result({ state, candidates: [] }) }, withExisting.client);
      check(`${state} with existing slot → deleted`, out1.action === "deleted" && withExisting.store.size === 0);
      const noExisting = makeClient();
      const out2 = await materializeClaim({ businessId: 1, result: result({ state, candidates: [] }) }, noExisting.client);
      check(`${state} with no slot → no-op, no row created`, out2.action === "no-op" && noExisting.store.size === 0);
    }
  }

  // ── Replace (atomic) + idempotency ────────────────────────────────────────────────────────────
  section("Replace atomically + idempotent replay");
  {
    const seed = slotKey({ businessId: 1, subjectDomain: "vendor", subjectNormalizedKey: "acme", claimType: "vendor-category", policyVersionId: 10 });
    const { client, store } = makeClient({ seedSlots: [seed] });
    const out = await materializeClaim({ businessId: 1, result: result() }, client);
    check("existing slot replaced (action=replaced)", out.action === "replaced");
    check("still exactly one projection for the slot", store.size === 1);
    // replay: same command again → same logical state
    const out2 = await materializeClaim({ businessId: 1, result: result() }, client);
    check("replay is idempotent (same single slot, action=replaced)", out2.action === "replaced" && store.size === 1);
  }

  // ── Failure mid-write → full rollback ─────────────────────────────────────────────────────────
  section("Mid-write failure → transaction rolls back all changes");
  {
    const seed = slotKey({ businessId: 1, subjectDomain: "vendor", subjectNormalizedKey: "acme", claimType: "vendor-category", policyVersionId: 10 });
    const { client, store } = makeClient({ seedSlots: [seed], failOnCreate: true });
    let threw = false;
    try { await materializeClaim({ businessId: 1, result: result() }, client); } catch { threw = true; }
    check("create failure propagates (no swallow)", threw);
    check("rollback: prior projection still intact (delete NOT committed)", store.has(seed) && store.size === 1);
  }

  // ── Static: no Resolver / VendorLearning / RIA / Adapter-read / Deriver in the Writer ──────────
  section("Static — narrow Writer: no resolver/VendorLearning/RIA/adapter-read/deriver/confidence");
  {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = __dirname;
    const code = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n")).join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    check("no VendorLearning", !/vendorLearning|VendorLearning/.test(code));
    check("no RIA / C1", !/referent-identity|\bRia[A-Z]|detection-grammar/.test(code));
    check("no policy resolver (findUnique on policy key / resolveVendorCategory / current / latest)", !/resolveVendorCategory|\.key\b|findFirst|currentVersion|latestVersion/.test(code));
    check("no Evidence Adapter read in the writer", !/readOwnerDecisionEvidence|createReviewEventEvidenceReader/.test(code));
    check("no Deriver invocation in the writer", !/deriveVendorCategory\b/.test(code));
    check("no confidence / recommendation / winner", !/\bconfidence\b|recommendation|pickWinner|winner/i.test(code));
    check("no clock / random", !/Date\.now|new Date|Math\.random/.test(code));
  }

  section("Business Memory IMPL-5A · Claim Writer invariants");
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`); process.exit(1); }
  console.log("All IMPL-5A Claim-writer invariants hold. Narrow · atomic · idempotent · inert. ✔");
}

main().catch((err) => { console.error(err); process.exit(1); });
