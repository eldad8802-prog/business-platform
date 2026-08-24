/**
 * Business Memory READ-2 (R1) · Claim Reader — invariant/unit tests. npx tsx. No DB.
 *
 * Proves: full 5-tuple lookup (never subject-only, never without businessId, never findFirst), correct
 * tenant scoping, the classification map (absent/supported/conflicting/invalid), non-throwing behavior
 * (→ unavailable), fingerprint pass-through, deterministic (non-precedence) conflict ordering, and that
 * the reader touches no resolver/current-latest/VendorLearning/Evidence-Adapter/Deriver/Writer.
 */
import { readClaim } from "./claim-reader";
import type { ClaimReaderClient, ClaimReaderProjectionRow, ReadClaimQuery } from "./read-claim.contract";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}`); }
}
function section(t: string): void { console.log(`\n${t}`); }

const Q: ReadClaimQuery = {
  businessId: 7,
  subjectDomain: "vendor",
  subjectNormalizedKey: "acme fuel",
  claimType: "vendor-category",
  policyVersionId: 3,
};

type CapturedWhere = {
  businessId_subjectDomain_subjectNormalizedKey_claimType_policyVersionId?: {
    businessId?: number; subjectDomain?: string; subjectNormalizedKey?: string; claimType?: string; policyVersionId?: number;
  };
  subjectNormalizedKey?: unknown;
  businessId?: unknown;
};
type CapturedSelect = { evidenceSetFingerprint?: unknown; candidates?: { select?: { propositionValue?: unknown } } };
type Call = { where: CapturedWhere; select: CapturedSelect };
function makeClient(row: ClaimReaderProjectionRow | null, opts: { throwMsg?: string } = {}) {
  const calls: Call[] = [];
  let findFirstCalled = false;
  const client = {
    derivedClaimProjection: {
      findUnique: async (args: Call): Promise<ClaimReaderProjectionRow | null> => {
        calls.push(args);
        if (opts.throwMsg) throw new Error(opts.throwMsg);
        return row;
      },
      // Poison: if the reader ever reaches for findFirst, flip the flag (it must not).
      findFirst: async () => { findFirstCalled = true; return null; },
    },
  } as unknown as ClaimReaderClient;
  return { client, calls, wasFindFirstCalled: () => findFirstCalled };
}
const cand = (propositionValue: string, evidenceLinks = 1) => ({ propositionValue, _count: { evidenceLinks } });

async function main(): Promise<void> {
  // ── full-identity lookup ─────────────────────────────────────────────────────────────────────────
  section("Lookup — full 5-tuple identity, tenant-scoped, no findFirst / subject-only");
  {
    const { client, calls, wasFindFirstCalled } = makeClient({ evidenceSetFingerprint: "fp", candidates: [cand("fuel")] });
    await readClaim(Q, client);
    const w = calls[0]?.where?.businessId_subjectDomain_subjectNormalizedKey_claimType_policyVersionId;
    check("exactly one findUnique call", calls.length === 1);
    check("compound 5-tuple key used", !!w);
    check("key carries businessId (tenant)", w?.businessId === 7);
    check("key carries subjectDomain", w?.subjectDomain === "vendor");
    check("key carries subjectNormalizedKey", w?.subjectNormalizedKey === "acme fuel");
    check("key carries claimType", w?.claimType === "vendor-category");
    check("key carries policyVersionId", w?.policyVersionId === 3);
    check("no subject-only / businessId-less top-level where", calls[0]?.where?.subjectNormalizedKey === undefined && calls[0]?.where?.businessId === undefined);
    check("findFirst never used", wasFindFirstCalled() === false);
    check("select requests fingerprint + candidate values + link counts", calls[0]?.select?.evidenceSetFingerprint === true && !!calls[0]?.select?.candidates?.select?.propositionValue);
  }

  // ── classification ───────────────────────────────────────────────────────────────────────────────
  section("Classification — absent / supported / conflicting / invalid");
  {
    const r = await readClaim(Q, makeClient(null).client);
    check("no Projection → absent", r.status === "absent");
  }
  {
    const r = await readClaim(Q, makeClient({ evidenceSetFingerprint: "fp1", candidates: [cand("fuel", 4)] }).client);
    check("one candidate → supported", r.status === "supported");
    check("supported carries exact category", r.status === "supported" && r.category === "fuel");
    check("supported carries candidateRefCount (evidence-link count)", r.status === "supported" && r.candidateRefCount === 4);
    check("supported carries fingerprint unchanged", r.status === "supported" && r.evidenceSetFingerprint === "fp1");
    check("supported has no ranking/confidence/score field", !("confidence" in r) && !("score" in r) && !("preferred" in r));
  }
  {
    const r = await readClaim(Q, makeClient({ evidenceSetFingerprint: "fp2", candidates: [cand("tax"), cand("general")] }).client);
    check("two candidates → conflicting", r.status === "conflicting");
    check("conflicting returns ALL candidate values", r.status === "conflicting" && r.candidates.length === 2);
    check("conflicting NEVER selects one (no category field)", !("category" in r));
    check("conflicting deterministic order (stable output, not precedence)", r.status === "conflicting" && JSON.stringify(r.candidates) === JSON.stringify(["general", "tax"]));
    check("conflicting carries fingerprint unchanged", r.status === "conflicting" && r.evidenceSetFingerprint === "fp2");
  }
  {
    const r = await readClaim(Q, makeClient({ evidenceSetFingerprint: "fp3", candidates: [cand("c"), cand("a"), cand("b")] }).client);
    check("3+ candidates preserved + sorted", r.status === "conflicting" && JSON.stringify(r.candidates) === JSON.stringify(["a", "b", "c"]));
  }
  {
    const r = await readClaim(Q, makeClient({ evidenceSetFingerprint: "fp4", candidates: [] }).client);
    check("zero-candidate persisted Projection → invalid", r.status === "invalid");
  }

  // ── non-throwing boundary ────────────────────────────────────────────────────────────────────────
  section("Non-throwing — client/DB error → unavailable");
  {
    let threw = false;
    let r;
    try { r = await readClaim(Q, makeClient(null, { throwMsg: "connection reset" }).client); } catch { threw = true; }
    check("client error does NOT throw", threw === false);
    check("client error → unavailable", r?.status === "unavailable");
    check("unavailable carries a detail", r?.status === "unavailable" && typeof r.detail === "string" && r.detail.length > 0);
  }

  // ── fail-closed input validation (typed, non-throwing) ─────────────────────────────────────────────
  section("Input validation — fail-closed typed, never widens the lookup");
  const badInputs: Array<[string, ReadClaimQuery]> = [
    ["businessId <= 0", { ...Q, businessId: 0 }],
    ["businessId non-integer", { ...Q, businessId: 1.5 }],
    ["policyVersionId <= 0", { ...Q, policyVersionId: 0 }],
    ["empty subjectNormalizedKey", { ...Q, subjectNormalizedKey: "" }],
    ["wrong subjectDomain", { ...Q, subjectDomain: "customer" as unknown as "vendor" }],
    ["wrong claimType", { ...Q, claimType: "x" as unknown as "vendor-category" }],
  ];
  for (const [name, bad] of badInputs) {
    const { client, calls } = makeClient({ evidenceSetFingerprint: "fp", candidates: [cand("fuel")] });
    const r = await readClaim(bad, client);
    check(`${name} → unavailable, and NO DB query issued`, r.status === "unavailable" && calls.length === 0);
  }
}

main()
  .then(() => {
    section("Business Memory READ-2 (R1) · Claim Reader");
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) { console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`); process.exit(1); }
    console.log("All R1 Claim Reader invariants hold. Full-identity · tenant-scoped · classified · non-throwing · inert. ✔");
  })
  .catch((e) => { console.error("test harness error:", e); process.exit(1); });
