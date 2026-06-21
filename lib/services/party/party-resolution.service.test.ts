/**
 * Party Resolution T1 (run manually):
 *   npx tsx lib/services/party/party-resolution.service.test.ts
 */
import {
  PartyClaimConfidence,
  PartyClaimStatus,
  PartyResolutionMethod,
  PartyRoleType,
  PartySignalType,
  Prisma,
} from "@prisma/client";
import {
  createClaimTx,
  createPartyTx,
  extractStrongSignals,
  lookupPartyForRoleRow,
  lookupRoleRowsForParty,
  resolvePartyForRoleRowTx,
  type PartyResolutionClaimRow,
  type PartyRow,
} from "@/lib/services/party/party-resolution.service";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const NOW = new Date("2026-06-10T10:00:00.000Z");

type FakeState = {
  parties: PartyRow[];
  claims: PartyResolutionClaimRow[];
  nextPartyId: number;
  nextClaimId: number;
};

function makeFakePartyDb(initial?: Partial<FakeState>) {
  const state: FakeState = {
    parties: initial?.parties ?? [],
    claims: initial?.claims ?? [],
    nextPartyId: initial?.nextPartyId ?? 1,
    nextClaimId: initial?.nextClaimId ?? 1,
  };

  const tx = {
    party: {
      async create(args: {
        data: { businessId: number };
        select: { id: true; businessId: true; createdAt: true; updatedAt: true };
      }) {
        const party: PartyRow = {
          id: state.nextPartyId++,
          businessId: args.data.businessId,
          createdAt: NOW,
          updatedAt: NOW,
        };
        state.parties.push(party);
        return party;
      },
      async findFirst(args: {
        where: { id?: number; businessId?: number };
        select: { id: true; businessId: true; createdAt: true; updatedAt: true };
      }) {
        return (
          state.parties.find(
            (party) =>
              (args.where.id === undefined || party.id === args.where.id) &&
              (args.where.businessId === undefined ||
                party.businessId === args.where.businessId)
          ) ?? null
        );
      },
    },
    partyResolutionClaim: {
      async findMany(args: {
        where: {
          businessId?: number;
          subjectType?: PartyRoleType;
          subjectId?: number;
          partyId?: number;
          signalType?: PartySignalType;
          signalValue?: string;
          status?: PartyClaimStatus;
        };
        select?: Record<string, unknown>;
      }) {
        return state.claims.filter((claim) => {
          if (
            args.where.businessId !== undefined &&
            claim.businessId !== args.where.businessId
          ) {
            return false;
          }
          if (
            args.where.subjectType !== undefined &&
            claim.subjectType !== args.where.subjectType
          ) {
            return false;
          }
          if (
            args.where.subjectId !== undefined &&
            claim.subjectId !== args.where.subjectId
          ) {
            return false;
          }
          if (
            args.where.partyId !== undefined &&
            claim.partyId !== args.where.partyId
          ) {
            return false;
          }
          if (
            args.where.signalType !== undefined &&
            claim.signalType !== args.where.signalType
          ) {
            return false;
          }
          if (
            args.where.signalValue !== undefined &&
            claim.signalValue !== args.where.signalValue
          ) {
            return false;
          }
          if (
            args.where.status !== undefined &&
            claim.status !== args.where.status
          ) {
            return false;
          }
          return true;
        });
      },
      async findFirst(args: {
        where: {
          businessId?: number;
          signalType?: PartySignalType;
          signalValue?: string;
          status?: PartyClaimStatus;
        };
        select: {
          party: {
            select: {
              id: true;
              businessId: true;
              createdAt: true;
              updatedAt: true;
            };
          };
        };
      }) {
        const claim = state.claims.find((row) => {
          if (
            args.where.businessId !== undefined &&
            row.businessId !== args.where.businessId
          ) {
            return false;
          }
          if (
            args.where.signalType !== undefined &&
            row.signalType !== args.where.signalType
          ) {
            return false;
          }
          if (
            args.where.signalValue !== undefined &&
            row.signalValue !== args.where.signalValue
          ) {
            return false;
          }
          if (
            args.where.status !== undefined &&
            row.status !== args.where.status
          ) {
            return false;
          }
          return true;
        });

        if (!claim) {
          return null;
        }

        const party = state.parties.find((row) => row.id === claim.partyId);
        if (!party) {
          return null;
        }

        return { party };
      },
      async create(args: {
        data: {
          businessId: number;
          partyId: number;
          subjectType: PartyRoleType;
          subjectId: number;
          signalType: PartySignalType;
          signalValue: string;
          confidence: PartyClaimConfidence;
          method: PartyResolutionMethod;
          source: string;
          resolvedByUserId: number | null;
          status: PartyClaimStatus;
        };
        select: typeof state.claims[number] extends never ? never : Record<string, boolean>;
      }) {
        const claim: PartyResolutionClaimRow = {
          id: state.nextClaimId++,
          businessId: args.data.businessId,
          partyId: args.data.partyId,
          subjectType: args.data.subjectType,
          subjectId: args.data.subjectId,
          signalType: args.data.signalType,
          signalValue: args.data.signalValue,
          confidence: args.data.confidence,
          method: args.data.method,
          source: args.data.source,
          resolvedByUserId: args.data.resolvedByUserId,
          status: args.data.status,
          createdAt: NOW,
          updatedAt: NOW,
        };
        state.claims.push(claim);
        return claim;
      },
    },
  };

  return {
    tx: tx as unknown as Prisma.TransactionClient,
    state,
  };
}

async function runTests() {
  {
    const fake = makeFakePartyDb();

    const customer = await resolvePartyForRoleRowTx(fake.tx, {
      businessId: 1,
      subjectType: PartyRoleType.CUSTOMER,
      subjectId: 10,
      signals: { phone: "050-111-1111" },
      source: "T1_TEST",
    });

    const lead = await resolvePartyForRoleRowTx(fake.tx, {
      businessId: 1,
      subjectType: PartyRoleType.LEAD,
      subjectId: 20,
      signals: { phone: "0501111111" },
      source: "T1_TEST",
    });

    ok(
      "Customer+Lead same phone share one Party",
      customer.party.id === lead.party.id
    );
    ok("cross-role resolution is APPLIED", lead.outcome === "APPLIED");
  }

  {
    const fake = makeFakePartyDb();

    const first = await resolvePartyForRoleRowTx(fake.tx, {
      businessId: 1,
      subjectType: PartyRoleType.CUSTOMER,
      subjectId: 11,
      signals: { taxId: "514777888" },
      source: "T1_TEST",
    });

    const second = await resolvePartyForRoleRowTx(fake.tx, {
      businessId: 1,
      subjectType: PartyRoleType.LEAD,
      subjectId: 21,
      signals: { taxId: " 514777888 " },
      source: "T1_TEST",
    });

    ok("same taxId shares one Party", first.party.id === second.party.id);
    ok(
      "taxId claim confidence is KNOWN",
      second.claims.some(
        (claim) =>
          claim.signalType === PartySignalType.TAX_ID &&
          claim.confidence === PartyClaimConfidence.KNOWN
      )
    );
  }

  {
    const fake = makeFakePartyDb();

    const result = await resolvePartyForRoleRowTx(fake.tx, {
      businessId: 1,
      subjectType: PartyRoleType.LEAD,
      subjectId: 30,
      signals: { name: "Dana Levi" },
      source: "T1_TEST",
    });

    ok("name-only lead gets singleton Party", result.outcome === "SINGLETON");
    ok("name-only lead gets one anchor claim", result.claims.length === 1);
    const anchor = result.claims[0];
    ok(
      "anchor claim has null signal",
      anchor?.signalType === null && anchor?.signalValue === null
    );
    ok(
      "anchor method is SELF_ANCHOR",
      anchor?.method === PartyResolutionMethod.SELF_ANCHOR
    );
    ok(
      "anchor confidence is UNKNOWN",
      anchor?.confidence === PartyClaimConfidence.UNKNOWN
    );
    ok("singleton party exists", fake.state.parties.length === 1);

    const lookedUp = await lookupPartyForRoleRow(fake.tx, {
      businessId: 1,
      subjectType: PartyRoleType.LEAD,
      subjectId: 30,
    });
    ok("KL-1: name-only subject is lookup-able", lookedUp?.id === result.party.id);
  }

  {
    const fake = makeFakePartyDb();

    const first = await resolvePartyForRoleRowTx(fake.tx, {
      businessId: 1,
      subjectType: PartyRoleType.LEAD,
      subjectId: 31,
      signals: { name: "Shared Name", phone: "050-222-2222" },
      source: "T1_TEST",
    });

    const second = await resolvePartyForRoleRowTx(fake.tx, {
      businessId: 1,
      subjectType: PartyRoleType.LEAD,
      subjectId: 32,
      signals: { name: "Shared Name", phone: "050-333-3333" },
      source: "T1_TEST",
    });

    ok(
      "same name different phones create different Parties",
      first.party.id !== second.party.id
    );
  }

  {
    const fake = makeFakePartyDb();

    const result = await resolvePartyForRoleRowTx(fake.tx, {
      businessId: 1,
      subjectType: PartyRoleType.CUSTOMER,
      subjectId: 40,
      signals: { phone: "050-444-4444" },
      source: "CUSTOMER_CREATE",
    });

    const claim = result.claims[0];
    ok("claim includes provenance source", claim?.source === "CUSTOMER_CREATE");
    ok(
      "phone claim confidence is BELIEVED",
      claim?.confidence === PartyClaimConfidence.BELIEVED
    );
    ok("claim status is ACTIVE", claim?.status === PartyClaimStatus.ACTIVE);
    ok(
      "claim method is DETERMINISTIC_EXACT",
      claim?.method === PartyResolutionMethod.DETERMINISTIC_EXACT
    );
    ok("claim resolvedByUserId defaults null", claim?.resolvedByUserId === null);
  }

  {
    const fake = makeFakePartyDb();

    const phoneParty = await resolvePartyForRoleRowTx(fake.tx, {
      businessId: 1,
      subjectType: PartyRoleType.CUSTOMER,
      subjectId: 50,
      signals: { phone: "050-555-5555" },
      source: "T1_TEST",
    });

    const taxIdParty = await resolvePartyForRoleRowTx(fake.tx, {
      businessId: 1,
      subjectType: PartyRoleType.CUSTOMER,
      subjectId: 51,
      signals: { taxId: "998877665" },
      source: "T1_TEST",
    });

    const conflicted = await resolvePartyForRoleRowTx(fake.tx, {
      businessId: 1,
      subjectType: PartyRoleType.LEAD,
      subjectId: 52,
      signals: { phone: "050-555-5555", taxId: "998877665" },
      source: "T1_TEST",
    });

    ok("signal conflict outcome is CONFLICT", conflicted.outcome === "CONFLICT");
    ok("signal conflict flag is set", conflicted.signalConflict === true);
    ok(
      "conflict does not merge phone Party",
      conflicted.party.id !== phoneParty.party.id
    );
    ok(
      "conflict does not merge taxId Party",
      conflicted.party.id !== taxIdParty.party.id
    );
    ok("conflict creates one anchor claim", conflicted.claims.length === 1);
    const conflictAnchor = conflicted.claims[0];
    ok(
      "conflict anchor has null signal (no pollution)",
      conflictAnchor?.signalType === null && conflictAnchor?.signalValue === null
    );
    ok(
      "conflict anchor method is SELF_ANCHOR",
      conflictAnchor?.method === PartyResolutionMethod.SELF_ANCHOR
    );
    ok(
      "conflict anchor confidence is UNKNOWN",
      conflictAnchor?.confidence === PartyClaimConfidence.UNKNOWN
    );
    ok(
      "conflict anchor source marks conflict",
      conflictAnchor?.source.endsWith(":SIGNAL_CONFLICT") === true
    );

    const afterConflict = await resolvePartyForRoleRowTx(fake.tx, {
      businessId: 1,
      subjectType: PartyRoleType.CUSTOMER,
      subjectId: 53,
      signals: { phone: "050-555-5555" },
      source: "T1_TEST",
    });
    ok(
      "phone signal still resolves to original Party after conflict",
      afterConflict.party.id === phoneParty.party.id
    );

    const lookedUpConflict = await lookupPartyForRoleRow(fake.tx, {
      businessId: 1,
      subjectType: PartyRoleType.LEAD,
      subjectId: 52,
    });
    ok(
      "KL-2: conflict subject is lookup-able",
      lookedUpConflict?.id === conflicted.party.id
    );
  }

  {
    const fake = makeFakePartyDb();

    await resolvePartyForRoleRowTx(fake.tx, {
      businessId: 1,
      subjectType: PartyRoleType.CUSTOMER,
      subjectId: 60,
      signals: { phone: "050-666-6666" },
      source: "T1_TEST",
    });

    await resolvePartyForRoleRowTx(fake.tx, {
      businessId: 1,
      subjectType: PartyRoleType.LEAD,
      subjectId: 61,
      signals: { phone: "050-666-6666" },
      source: "T1_TEST",
    });

    const customerParty = await lookupPartyForRoleRow(fake.tx, {
      businessId: 1,
      subjectType: PartyRoleType.CUSTOMER,
      subjectId: 60,
    });
    const leadParty = await lookupPartyForRoleRow(fake.tx, {
      businessId: 1,
      subjectType: PartyRoleType.LEAD,
      subjectId: 61,
    });
    const members = await lookupRoleRowsForParty(fake.tx, {
      businessId: 1,
      partyId: customerParty!.id,
    });

    ok("lookup role-row to Party works", customerParty !== null);
    ok(
      "lookup returns same Party for both role-rows",
      customerParty?.id === leadParty?.id
    );
    ok("lookup Party to members returns both role-rows", members.length === 2);
  }

  {
    const fake = makeFakePartyDb();

    const businessOne = await resolvePartyForRoleRowTx(fake.tx, {
      businessId: 1,
      subjectType: PartyRoleType.CUSTOMER,
      subjectId: 70,
      signals: { phone: "050-777-7777" },
      source: "T1_TEST",
    });

    const businessTwo = await resolvePartyForRoleRowTx(fake.tx, {
      businessId: 2,
      subjectType: PartyRoleType.CUSTOMER,
      subjectId: 71,
      signals: { phone: "050-777-7777" },
      source: "T1_TEST",
    });

    ok(
      "same phone in different businesses stays isolated",
      businessOne.party.id !== businessTwo.party.id
    );
    ok(
      "tenant isolation keeps separate businessId on parties",
      businessOne.party.businessId === 1 &&
        businessTwo.party.businessId === 2
    );
  }

  {
    const fake = makeFakePartyDb();

    const first = await resolvePartyForRoleRowTx(fake.tx, {
      businessId: 1,
      subjectType: PartyRoleType.CUSTOMER,
      subjectId: 80,
      signals: { phone: "050-888-8888" },
      source: "T1_TEST",
    });

    const replay = await resolvePartyForRoleRowTx(fake.tx, {
      businessId: 1,
      subjectType: PartyRoleType.CUSTOMER,
      subjectId: 80,
      signals: { phone: "050-888-8888" },
      source: "T1_TEST",
    });

    ok("identical replay returns NOOP", replay.outcome === "NOOP");
    ok("identical replay keeps same Party", replay.party.id === first.party.id);
    ok(
      "identical replay does not duplicate claims",
      fake.state.claims.length === 1
    );
  }

  {
    const fake = makeFakePartyDb();
    const party = await createPartyTx(fake.tx, 1);

    const first = await createClaimTx(fake.tx, {
      businessId: 1,
      partyId: party.id,
      subjectType: PartyRoleType.CUSTOMER,
      subjectId: 90,
      signalType: PartySignalType.PHONE,
      signalValue: "972509999999",
      confidence: PartyClaimConfidence.BELIEVED,
      source: "T1_TEST",
    });

    const second = await createClaimTx(fake.tx, {
      businessId: 1,
      partyId: party.id,
      subjectType: PartyRoleType.CUSTOMER,
      subjectId: 90,
      signalType: PartySignalType.PHONE,
      signalValue: "972509999999",
      confidence: PartyClaimConfidence.BELIEVED,
      source: "T1_TEST",
    });

    ok("createClaimTx first write is APPLIED", first.outcome === "APPLIED");
    ok("createClaimTx replay is NOOP", second.outcome === "NOOP");
  }

  {
    const signals = extractStrongSignals({
      phone: "+972-50-123-4567",
      taxId: " 123456789 ",
      name: "Ignored",
    });

    ok("extractStrongSignals canonicalizes phone", signals.phone === "972501234567");
    ok("extractStrongSignals canonicalizes taxId", signals.taxId === "123456789");
  }

  if (failed > 0) {
    console.error(`\n${failed} party resolution T1 check(s) failed.`);
    process.exit(1);
  }

  console.log("\nAll party resolution T1 checks passed.");
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
