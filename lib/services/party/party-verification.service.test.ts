/**
 * Party Backfill Verification T2b-3 (run manually):
 *   npx tsx lib/services/party/party-verification.service.test.ts
 */
import { PartyRoleType, PartySignalType } from "@prisma/client";
import {
  comparePartyClaimCounts,
  rowsChecksum,
  snapshotCounts,
  verifyBackfill,
  type PartyRecord,
  type SubjectRow,
  type VerificationClaim,
  type VerificationDeps,
} from "@/lib/services/party/party-verification.service";

let failed = 0;
function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

type Seed = {
  businessIds: number[];
  customers: Record<number, SubjectRow[]>;
  leads: Record<number, SubjectRow[]>;
  parties: Record<number, PartyRecord[]>;
  claims: Record<number, VerificationClaim[]>;
};

let loadCalls = 0;
function makeDeps(seed: Seed): VerificationDeps {
  return {
    listBusinessIds: async () => {
      loadCalls += 1;
      return seed.businessIds;
    },
    loadCustomers: async (b) => {
      loadCalls += 1;
      return seed.customers[b] ?? [];
    },
    loadLeads: async (b) => {
      loadCalls += 1;
      return seed.leads[b] ?? [];
    },
    loadParties: async (b) => {
      loadCalls += 1;
      return seed.parties[b] ?? [];
    },
    loadActiveClaims: async (b) => {
      loadCalls += 1;
      return seed.claims[b] ?? [];
    },
  };
}

function signalClaim(
  partyId: number,
  subjectId: number,
  signalValue: string,
  subjectType: PartyRoleType = PartyRoleType.CUSTOMER
): VerificationClaim {
  return {
    partyId,
    subjectType,
    subjectId,
    signalType: PartySignalType.PHONE,
    signalValue,
    source: "BACKFILL",
  };
}

function anchorClaim(
  partyId: number,
  subjectId: number,
  subjectType: PartyRoleType = PartyRoleType.CUSTOMER,
  source = "BACKFILL"
): VerificationClaim {
  return {
    partyId,
    subjectType,
    subjectId,
    signalType: null,
    signalValue: null,
    source,
  };
}

async function runTests() {
  // 1. Clean state: totality holds, isolation holds, no invariant violation.
  {
    const seed: Seed = {
      businessIds: [1],
      customers: { 1: [{ id: 10 }, { id: 11 }] },
      leads: { 1: [{ id: 20 }] },
      parties: { 1: [{ id: 100, businessId: 1 }, { id: 101, businessId: 1 }, { id: 102, businessId: 1 }] },
      claims: {
        1: [
          signalClaim(100, 10, "+972500000000"),
          signalClaim(101, 11, "+972511111111"),
          anchorClaim(102, 20, PartyRoleType.LEAD),
        ],
      },
    };
    const report = await verifyBackfill(makeDeps(seed));
    const b = report.perBusiness[0];
    ok("clean: ok true", b.ok === true && report.totals.ok === true);
    ok("clean: totality holds", b.totalityHolds === true);
    ok("clean: isolation holds", b.tenantIsolationHolds === true);
    ok("clean: no signal invariant", b.noSignalInvariantViolation === true);
    ok("clean: counts customers/leads", b.customers === 2 && b.leads === 1);
    ok("clean: counts parties/claims", b.parties === 3 && b.claims === 3);
    ok("clean: signal vs anchor counts", b.signalClaims === 2 && b.anchorClaims === 1);
  }

  // 2. Missing subject (a Customer with no ACTIVE claim) → totality fails.
  {
    const seed: Seed = {
      businessIds: [1],
      customers: { 1: [{ id: 10 }, { id: 11 }] }, // 11 has no claim
      leads: { 1: [{ id: 20 }] }, // 20 has no claim either
      parties: { 1: [{ id: 100, businessId: 1 }] },
      claims: { 1: [signalClaim(100, 10, "+972500000000")] },
    };
    const report = await verifyBackfill(makeDeps(seed));
    const b = report.perBusiness[0];
    ok("missing: detected count", b.missingSubjects === 2);
    ok("missing: totality fails", b.totalityHolds === false && b.ok === false);
    ok("missing: customer sampled", b.missingSubjectSamples.includes("CUSTOMER:11"));
    ok("missing: lead sampled", b.missingSubjectSamples.includes("LEAD:20"));
    ok("missing: in totals", report.totals.missingSubjects === 2 && report.totals.ok === false);
  }

  // 3. Tenant mismatch: a claim in business 1 points to a Party owned by business 2.
  {
    const seed: Seed = {
      businessIds: [1, 2],
      customers: { 1: [{ id: 10 }], 2: [{ id: 30 }] },
      leads: {},
      parties: { 1: [{ id: 100, businessId: 1 }], 2: [{ id: 200, businessId: 2 }] },
      claims: {
        1: [signalClaim(200, 10, "+972500000000")], // party 200 belongs to business 2!
        2: [signalClaim(200, 30, "+972522222222")],
      },
    };
    const report = await verifyBackfill(makeDeps(seed));
    const b1 = report.perBusiness.find((x) => x.businessId === 1)!;
    ok("tenant: violation detected", b1.tenantViolations === 1);
    ok("tenant: isolation fails", b1.tenantIsolationHolds === false && b1.ok === false);
    ok("tenant: sampled", b1.tenantViolationSamples.some((s) => s.includes("party=200")));
    ok("tenant: in totals", report.totals.tenantViolations === 1 && report.totals.ok === false);
  }

  // 4. Orphan claim (partyId references no known Party) → tenant violation too.
  {
    const seed: Seed = {
      businessIds: [1],
      customers: { 1: [{ id: 10 }] },
      leads: {},
      parties: { 1: [] }, // no parties at all
      claims: { 1: [signalClaim(999, 10, "+972500000000")] },
    };
    const report = await verifyBackfill(makeDeps(seed));
    const b = report.perBusiness[0];
    ok("orphan: counted as tenant violation", b.tenantViolations === 1);
    ok("orphan: sampled owner none", b.tenantViolationSamples.some((s) => s.includes("owner=none")));
  }

  // 5. Same signal → multiple parties → invariant violation.
  {
    const seed: Seed = {
      businessIds: [1],
      customers: { 1: [{ id: 10 }, { id: 11 }] },
      leads: {},
      parties: { 1: [{ id: 100, businessId: 1 }, { id: 101, businessId: 1 }] },
      claims: {
        1: [
          signalClaim(100, 10, "+972500000000"),
          signalClaim(101, 11, "+972500000000"), // SAME phone, different party
        ],
      },
    };
    const report = await verifyBackfill(makeDeps(seed));
    const b = report.perBusiness[0];
    ok("invariant: detected", b.signalInvariantViolations === 1);
    ok("invariant: flag false", b.noSignalInvariantViolation === false && b.ok === false);
    ok("invariant: sampled", b.signalInvariantSamples.some((s) => s.includes("2 parties")));
    ok("invariant: in totals", report.totals.signalInvariantViolations === 1);
  }

  // 6. Conflict anchors counted from source suffix.
  {
    const seed: Seed = {
      businessIds: [1],
      customers: { 1: [{ id: 10 }, { id: 11 }] },
      leads: {},
      parties: { 1: [{ id: 100, businessId: 1 }, { id: 101, businessId: 1 }] },
      claims: {
        1: [
          anchorClaim(100, 10, PartyRoleType.CUSTOMER, "BACKFILL"),
          anchorClaim(101, 11, PartyRoleType.CUSTOMER, "BACKFILL:SIGNAL_CONFLICT"),
        ],
      },
    };
    const report = await verifyBackfill(makeDeps(seed));
    const b = report.perBusiness[0];
    ok("conflict: counted from suffix", b.conflicts === 1);
    ok("conflict: anchorClaims total", b.anchorClaims === 2);
    ok("conflict: still ok (fail-safe)", b.ok === true);
  }

  // 7. rowsChecksum: deterministic, order-independent, sensitive to change.
  {
    const a = rowsChecksum([{ id: 1, phone: "x" }, { id: 2, phone: "y" }]);
    const b = rowsChecksum([{ id: 2, phone: "y" }, { id: 1, phone: "x" }]);
    const c = rowsChecksum([{ id: 1, phone: "x" }, { id: 2, phone: "Z" }]);
    ok("checksum: order-independent", a === b);
    ok("checksum: sensitive to change", a !== c);
  }

  // 8. comparePartyClaimCounts: idempotency readiness.
  {
    const same = comparePartyClaimCounts({ parties: 5, claims: 9 }, { parties: 5, claims: 9 });
    const grew = comparePartyClaimCounts({ parties: 5, claims: 9 }, { parties: 6, claims: 11 });
    ok("idempotent: no growth → true", same.idempotent === true && same.partiesAdded === 0 && same.claimsAdded === 0);
    ok("idempotent: growth → false", grew.idempotent === false && grew.partiesAdded === 1 && grew.claimsAdded === 2);
  }

  // 9. snapshotCounts pulls totals for before/after comparison.
  {
    const seed: Seed = {
      businessIds: [1],
      customers: { 1: [{ id: 10 }] },
      leads: {},
      parties: { 1: [{ id: 100, businessId: 1 }] },
      claims: { 1: [signalClaim(100, 10, "+972500000000")] },
    };
    const report = await verifyBackfill(makeDeps(seed));
    const snap = snapshotCounts(report);
    ok("snapshot: parties/claims", snap.parties === 1 && snap.claims === 1);
  }

  // 10. Read-only: verification issues no writes — the ports expose only loaders.
  {
    const seed: Seed = {
      businessIds: [1],
      customers: { 1: [{ id: 10 }] },
      leads: {},
      parties: { 1: [{ id: 100, businessId: 1 }] },
      claims: { 1: [signalClaim(100, 10, "+972500000000")] },
    };
    const deps = makeDeps(seed);
    const before = loadCalls;
    await verifyBackfill(deps);
    ok("read-only: only loader ports invoked", loadCalls > before);
    const keys = Object.keys(deps);
    ok("read-only: no write port exposed", keys.every((k) => k.startsWith("list") || k.startsWith("load")));
  }

  if (failed > 0) {
    console.error(`\n${failed} party verification T2b-3 check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll party verification T2b-3 checks passed.");
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
