/**
 * P2 · Identity statements — database invariants on the owner connection.
 *   TEST_DATABASE_URL="postgres://…test…" npx tsx lib/services/identity/identity.db.test.ts
 *
 * Run AFTER identity.rls.db.test.ts, which replays the P2 migration verbatim over the `db push`
 * lab: the CHECK constraints and the PARTIAL unique indexes exist only in the migration, never in a
 * `db push` schema. This test asserts they are present before relying on them.
 *
 * Refuses Production.
 */
const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
if (!TEST_DB || !/^postgres(ql)?:\/\//i.test(TEST_DB)) {
  console.error("ABORT: set TEST_DATABASE_URL to a non-production Postgres URL.");
  process.exit(1);
}
if ((() => { try { return new URL(TEST_DB).hostname; } catch { return ""; } })().includes("ep-flat-brook")) {
  console.error("ABORT: TEST_DATABASE_URL is the Production endpoint.");
  process.exit(1);
}
process.env.DATABASE_URL = TEST_DB;

let failed = 0;
function ok(name: string, condition: boolean, detail: unknown = "") {
  if (!condition) {
    console.error("FAIL:", name, detail);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const svc = await import("./identity-statement.service");
  const { adoptIdentitySuggestion, getBusinessIdentity, publicUseInventory, resolveIdentityProvenance } = await import("./business-identity");
  const { IdentityInputError } = await import("./identity-vocabulary");
  const facts = await import("./identity-fact-authority.service");
  const { SIGNAL_RULES_VERSION } = await import("./identity-signals");
  const { buildInputSnapshotData } = await import("@/lib/services/content-plan-persistence-v1.service");
  const { loadIdentityKnowledge } = await import("@/lib/knowledge/snapshot/snapshot-sources");
  const { assembleSnapshot } = await import("@/lib/knowledge/snapshot/assemble");

  const errorOf = async (fn: () => Promise<unknown>): Promise<string | null> => {
    try {
      await fn();
      return null;
    } catch (error) {
      return `${(error as Error).name}: ${String((error as Error).message)}`;
    }
  };
  // Every service call runs in the business's tenant transaction, as the routes do: the identity read
  // model refuses to read Business outside it (B4 keeps Business reads open, so P2 pins them).
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  let currentBusiness = 0;
  const tx = <T>(fn: (t: import("@prisma/client").Prisma.TransactionClient) => Promise<T>) => tenantTx(currentBusiness, fn);

  console.log("\n1 · the migration's own constraints are installed");
  const constraints = await prisma.$queryRawUnsafe<Array<{ conname: string }>>(
    `SELECT conname::text FROM pg_constraint WHERE conrelid = '"BusinessIdentityStatement"'::regclass AND contype = 'c' ORDER BY conname`,
  );
  const indexes = await prisma.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(
    `SELECT indexname::text, indexdef::text FROM pg_indexes WHERE tablename = 'BusinessIdentityStatement'`,
  );
  ok("five CHECK constraints", ["BusinessIdentityStatement_provenance", "BusinessIdentityStatement_public_use", "BusinessIdentityStatement_retired_shape", "BusinessIdentityStatement_source_ref", "BusinessIdentityStatement_value_shape"]
    .every((c) => constraints.some((r) => r.conname === c)), constraints);
  ok("both partial unique indexes, each with its WHERE predicate",
    indexes.some((i) => i.indexname === "BusinessIdentityStatement_active_single_key" && /WHERE/.test(i.indexdef)) &&
    indexes.some((i) => i.indexname === "BusinessIdentityStatement_active_code_key" && /WHERE/.test(i.indexdef)), indexes);
  const factChecks = await prisma.$queryRawUnsafe<Array<{ conname: string }>>(
    `SELECT conname::text FROM pg_constraint WHERE conrelid = '"BusinessIdentityFactAuthority"'::regclass AND contype = 'c' ORDER BY conname`,
  );
  const factIdx = await prisma.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(
    `SELECT indexname::text, indexdef::text FROM pg_indexes WHERE tablename = 'BusinessIdentityFactAuthority'`,
  );
  ok("fact authority: four CHECK constraints", ["BusinessIdentityFactAuthority_public_use", "BusinessIdentityFactAuthority_retired_shape", "BusinessIdentityFactAuthority_source_field", "BusinessIdentityFactAuthority_value_hash"]
    .every((c) => factChecks.some((r) => r.conname === c)), factChecks);
  ok("fact authority: one ACTIVE authority per fact (partial unique index)",
    factIdx.some((i) => i.indexname === "BusinessIdentityFactAuthority_active_fact_key" && /WHERE/.test(i.indexdef)), factIdx);

  const tag = `qa-p2-db-${Date.now()}`;
  const a = await prisma.business.create({ data: { name: `${tag}-A` } });
  currentBusiness = a.id;
  const user = await prisma.user.create({ data: { email: `${tag}@example.test`, password: "not-a-real-password", businessId: a.id } });
  const base = { businessId: a.id, userId: user.id, source: "OWNER_INPUT" as const };
  try {
    console.log("\n2 · raw rows the database itself refuses");
    const raw = (cols: string, vals: string) =>
      errorOf(() => prisma.$executeRawUnsafe(`INSERT INTO "BusinessIdentityStatement" ("businessId", ${cols}, "updatedAt") VALUES (${a.id}, ${vals}, now())`));
    ok("a coded dimension with free text", /value_shape/.test((await raw(`"dimension","code","text","source"`, `'TARGET_AUDIENCE','INDIVIDUALS','families','OWNER_INPUT'`)) ?? ""));
    ok("a text dimension with no text", /value_shape/.test((await raw(`"dimension","source"`, `'DESCRIPTION','OWNER_INPUT'`)) ?? ""));
    ok("a malformed code", /value_shape/.test((await raw(`"dimension","code","source"`, `'TONE','warm; drop','OWNER_INPUT'`)) ?? ""));
    ok("public use on an internal directive (TONE)", /public_use/.test((await raw(`"dimension","code","source","publicUseApproved","publicUseApprovedAt"`, `'TONE','WARM','OWNER_INPUT',true,now()`)) ?? ""));
    ok("public use without a time", /public_use/.test((await raw(`"dimension","text","source","publicUseApproved"`, `'DIFFERENTIATOR','x','OWNER_INPUT',true`)) ?? ""));
    ok("an adopted suggestion without its signal", /provenance/.test((await raw(`"dimension","code","source"`, `'TONE','WARM','OWNER_ADOPTED_SUGGESTION'`)) ?? ""));
    ok("RETIRED without retiredAt", /retired_shape/.test((await raw(`"dimension","code","source","status"`, `'TONE','WARM','OWNER_INPUT','RETIRED'`)) ?? ""));
    await raw(`"dimension","code","source"`, `'TONE','WARM','OWNER_INPUT'`);
    // Postgres 23505 names the key columns; only the partial single-dimension index is keyed on exactly these.
    const secondTone = await raw(`"dimension","code","source"`, `'TONE','PREMIUM','OWNER_INPUT'`);
    ok("two ACTIVE rows for one single-valued dimension", /23505[\s\S]*Key \("businessId", dimension\)=/.test(secondTone ?? ""), secondTone);
    const firstSpeed = await raw(`"dimension","code","source"`, `'POSITIONING','SPEED','OWNER_INPUT'`);
    const secondSpeed = await raw(`"dimension","code","source"`, `'POSITIONING','SPEED','OWNER_INPUT'`);
    ok("the same code ACTIVE twice", firstSpeed === null && /23505[\s\S]*Key \("businessId", dimension, code\)=/.test(secondSpeed ?? ""), [firstSpeed, secondSpeed]);
    await prisma.businessIdentityStatement.updateMany({ where: { businessId: a.id }, data: { status: "RETIRED", retiredAt: new Date() } });
    ok("retired rows keep their place and do not block a new ACTIVE row", (await raw(`"dimension","code","source"`, `'TONE','PREMIUM','OWNER_INPUT'`)) === null);
    await prisma.businessIdentityStatement.updateMany({ where: { businessId: a.id, status: "ACTIVE" }, data: { status: "RETIRED", retiredAt: new Date() } });

    console.log("\n3 · the service: history, idempotency, limits");
    const t1 = await tx((t) => svc.createIdentityStatement({ ...base, dimension: "TONE", code: "WARM" }, t));
    const t1again = await tx((t) => svc.createIdentityStatement({ ...base, dimension: "TONE", code: "WARM" }, t));
    ok("stating the same tone twice is idempotent", t1again.id === t1.id);
    const t2 = await tx((t) => svc.createIdentityStatement({ ...base, dimension: "TONE", code: "PROFESSIONAL" }, t));
    const tones = await prisma.businessIdentityStatement.findMany({ where: { businessId: a.id, dimension: "TONE", id: { gte: t1.id } }, orderBy: { id: "asc" } });
    ok("changing the tone retires the old row and keeps it as history",
      tones.length === 2 && tones[0].status === "RETIRED" && tones[0].retiredByUserId === user.id && tones[1].id === t2.id && tones[1].status === "ACTIVE");
    ok("the statement records who confirmed it", t2.confirmedByUserId === user.id && t2.source === "OWNER_INPUT");

    for (const code of ["SPEED", "EXPERTISE", "BREADTH"]) await tx((t) => svc.createIdentityStatement({ ...base, dimension: "POSITIONING", code }, t));
    ok("a fourth positioning is refused (max 3)", /At most 3/.test((await errorOf(() => tx((t) => svc.createIdentityStatement({ ...base, dimension: "POSITIONING", code: "VALUE" }, t)))) ?? ""));

    await tx((t) => svc.createIdentityStatement({ ...base, dimension: "SECONDARY_OBJECTIVE", code: "BOOK" }, t));
    await tx((t) => svc.createIdentityStatement({ ...base, dimension: "PRIMARY_OBJECTIVE", code: "CALL" }, t));
    ok("a secondary objective equal to the primary is refused",
      /already the primary/.test((await errorOf(() => tx((t) => svc.createIdentityStatement({ ...base, dimension: "SECONDARY_OBJECTIVE", code: "CALL" }, t)))) ?? ""));
    await tx((t) => svc.createIdentityStatement({ ...base, dimension: "PRIMARY_OBJECTIVE", code: "BOOK" }, t));
    const secondaryBook = await prisma.businessIdentityStatement.count({ where: { businessId: a.id, dimension: "SECONDARY_OBJECTIVE", code: "BOOK", status: "ACTIVE" } });
    ok("promoting a secondary objective to primary retires the secondary", secondaryBook === 0);

    ok("contact details cannot be stated", (await errorOf(() => tx((t) => svc.createIdentityStatement({ ...base, dimension: "DESCRIPTION", text: "חייגו 0521234567" }, t))))?.startsWith("IdentityInputError") === true);
    ok("an unknown dimension is refused", (await errorOf(() => tx((t) => svc.createIdentityStatement({ ...base, dimension: "MISSION", text: "x" }, t))))?.startsWith("IdentityInputError") === true);

    console.log("\n4 · public-use authority");
    const d1 = await tx((t) => svc.createIdentityStatement({ ...base, dimension: "DIFFERENTIATOR", text: "אחריות לשנה" }, t));
    ok("a new statement is INTERNAL (not approved) by default", d1.publicUseApproved === false && d1.publicUseApprovedAt === null);
    const d1ok = await tx((t) => svc.setIdentityPublicUse({ businessId: a.id, userId: user.id, statementId: d1.id, approved: true }, t));
    const d1row = await prisma.businessIdentityStatement.findUniqueOrThrow({ where: { id: d1.id } });
    ok("approval is explicit and records who and when", d1ok.publicUseApproved && d1row.publicUseApprovedByUserId === user.id && d1row.publicUseApprovedAt !== null);
    const d2 = await tx((t) => svc.createIdentityStatement({ ...base, dimension: "DIFFERENTIATOR", text: "אחריות לשנתיים", replacesStatementId: d1.id }, t));
    ok("replacing approved text does NOT carry approval over to the new text", d2.publicUseApproved === false);
    ok("…and the approved old text is retired, not deleted", (await prisma.businessIdentityStatement.findUniqueOrThrow({ where: { id: d1.id } })).status === "RETIRED");
    ok("public use on an internal directive is refused by the service",
      /internal and cannot be approved/.test((await errorOf(() => tx((t) => svc.setIdentityPublicUse({ businessId: a.id, userId: user.id, statementId: t2.id, approved: true }, t)))) ?? ""));
    const back = await tx((t) => svc.setIdentityPublicUse({ businessId: a.id, userId: user.id, statementId: d2.id, approved: false }, t));
    ok("withdrawing approval clears it", back.publicUseApproved === false && back.publicUseApprovedAt === null);

    console.log("\n5 · derived suggestions become identity only by adoption");
    await prisma.businessService.create({ data: { businessId: a.id, name: "ביקור בית", type: "SERVICE", fulfillment: "AT_CUSTOMER" } });
    const before = await tx((t) => getBusinessIdentity(a.id, t));
    const home = before.signals.find((s) => s.kind === "FULFILLMENT_MODE" && s.value.fulfillment === "AT_CUSTOMER");
    ok("the signal exists, is a MACHINE_PROPOSAL, and was NOT applied", !!home && home.authority === "MACHINE_PROPOSAL" &&
      !before.statements.some((s) => s.code === "HOME_SERVICE_CUSTOMERS"));
    const adopted = await tx((t) => adoptIdentitySuggestion({ businessId: a.id, userId: user.id, signalKey: home!.key, dimension: "TARGET_AUDIENCE", code: "HOME_SERVICE_CUSTOMERS" }, t));
    ok("adoption stores an owner-confirmed statement that names its signal",
      adopted.source === "OWNER_ADOPTED_SUGGESTION" && adopted.sourceRef === `${SIGNAL_RULES_VERSION}|${home!.key}>TARGET_AUDIENCE:HOME_SERVICE_CUSTOMERS` && adopted.confirmedByUserId === user.id);
    ok("a suggestion the evidence does not support is refused",
      (await errorOf(() => tx((t) => adoptIdentitySuggestion({ businessId: a.id, userId: user.id, signalKey: home!.key, dimension: "TARGET_AUDIENCE", code: "BUSINESSES" }, t))))?.includes("not currently supported") === true);
    ok("a forged signal key is refused",
      (await errorOf(() => tx((t) => adoptIdentitySuggestion({ businessId: a.id, userId: user.id, signalKey: "BOOKING_DEMAND:bookings=999", dimension: "SECONDARY_OBJECTIVE", code: "BOOK" }, t)))) !== null);

    const view = await tx((t) => getBusinessIdentity(a.id, t));
    ok("the read model keeps states apart: facts / owner statements / derived signals",
      view.facts.every((f) => ["UNKNOWN", "KNOWN"].includes(f.state)) &&
      view.statements.every((s) => s.state === "OWNER_CONFIRMED") &&
      view.signals.every((s) => s.authority === "MACHINE_PROPOSAL" && s.publicUse === "INTERNAL_ONLY"));
    ok("unstated dimensions are reported as unknown, not filled", view.unknownDimensions.includes("SERVICE_AREA") && view.unknownDimensions.includes("SPECIALIZATION"));
    ok("with no decision, the business name is KNOWN — existence grants nothing", view.facts.find((f) => f.fact === "BUSINESS_NAME")?.state === "KNOWN" && publicUseInventory(view).every((c) => c.kind !== "FACT"));

    console.log("\n6 · concurrency: the partial index is the last word");
    await tx((t) => svc.retireIdentityStatement({ businessId: a.id, userId: user.id, statementId: t2.id }, t));
    const race = await Promise.allSettled(["WARM", "PREMIUM", "ENERGETIC"].map((code) =>
      tx((t) => svc.createIdentityStatement({ ...base, dimension: "TONE", code }, t))));
    const activeTones = await prisma.businessIdentityStatement.count({ where: { businessId: a.id, dimension: "TONE", status: "ACTIVE" } });
    ok("three parallel tone changes leave exactly one ACTIVE tone", activeTones === 1, race.map((r) => r.status));
    ok("a loser fails loudly (conflict), never silently", race.every((r) => r.status === "fulfilled" || /Conflict|unique|P2002|write conflict|could not serialize|NotFound/i.test(String((r as PromiseRejectedResult).reason))),
      race.map((r) => (r.status === "rejected" ? String(r.reason).slice(0, 120) : "ok")));
    void IdentityInputError;

    console.log("\n7 · identity-fact publication authority");
    await prisma.businessProfile.create({ data: { businessId: a.id, city: "חיפה", billingPhone: "04-8123456", billingEmail: "office@example.test" } });
    const stateOf = async (fact: string) => (await tx((t) => getBusinessIdentity(a.id, t))).facts.find((f) => f.fact === fact)!;
    ok("a billing phone that exists is only KNOWN", (await stateOf("PUBLIC_PHONE")).state === "KNOWN");
    ok("hours with no value are UNKNOWN", (await stateOf("OPENING_HOURS")).state === "UNKNOWN");
    ok("an unknown fact cannot be confirmed or approved",
      /nothing to confirm/.test((await errorOf(() => tx((t) => facts.decideFactAuthority({ businessId: a.id, userId: user.id, fact: "OPENING_HOURS", action: "APPROVE_PUBLIC" }, t)))) ?? ""));
    const sqlHash = (await prisma.$queryRawUnsafe<Array<{ h: string }>>(`SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS h`, "חיפה"))[0].h;
    ok("the app's value hash equals the database's for Hebrew text", sqlHash === facts.factValueHash("חיפה"));
    const confirmed = await tx((t) => facts.decideFactAuthority({ businessId: a.id, userId: user.id, fact: "CITY", action: "CONFIRM" }, t));
    ok("CONFIRM → OWNER_CONFIRMED, not public; who is recorded", (await stateOf("CITY")).state === "OWNER_CONFIRMED" && confirmed!.publicUseApproved === false && confirmed!.confirmedByUserId === user.id);
    ok("…and the row holds a hash, never the value", !JSON.stringify(confirmed).includes("חיפה") && /^[0-9a-f]{64}$/.test(confirmed!.valueHash));
    await tx((t) => facts.decideFactAuthority({ businessId: a.id, userId: user.id, fact: "CITY", action: "APPROVE_PUBLIC" }, t));
    ok("APPROVE_PUBLIC → PUBLIC_USE_APPROVED and in the public inventory",
      (await stateOf("CITY")).state === "PUBLIC_USE_APPROVED" && publicUseInventory(await tx((t) => getBusinessIdentity(a.id, t))).some((c) => c.key === "CITY" && c.value === "חיפה"));
    await prisma.businessProfile.update({ where: { businessId: a.id }, data: { city: "חיפה והקריות" } });
    const lapsed = await stateOf("CITY");
    ok("changing the city lapses the approval by itself: KNOWN, stale, out of the inventory",
      lapsed.state === "KNOWN" && lapsed.authorityStale && !publicUseInventory(await tx((t) => getBusinessIdentity(a.id, t))).some((c) => c.key === "CITY"));
    const reapproved = await tx((t) => facts.decideFactAuthority({ businessId: a.id, userId: user.id, fact: "CITY", action: "APPROVE_PUBLIC" }, t));
    const cityRows = await prisma.businessIdentityFactAuthority.findMany({ where: { businessId: a.id, fact: "CITY" }, orderBy: { id: "asc" } });
    ok("approving the new value retires the old authority and creates a new one (history kept)",
      cityRows.length === 2 && cityRows[0].status === "RETIRED" && cityRows[1].id === reapproved!.id && cityRows[1].status === "ACTIVE");
    await tx((t) => facts.decideFactAuthority({ businessId: a.id, userId: user.id, fact: "PUBLIC_PHONE", action: "APPROVE_PUBLIC" }, t));
    ok("the billing phone becomes public only by explicit designation", (await stateOf("PUBLIC_PHONE")).state === "PUBLIC_USE_APPROVED" && (await stateOf("PUBLIC_EMAIL")).state === "KNOWN");
    await tx((t) => facts.decideFactAuthority({ businessId: a.id, userId: user.id, fact: "PUBLIC_PHONE", action: "WITHDRAW_PUBLIC" }, t));
    ok("withdrawing keeps it OWNER_CONFIRMED but not public", (await stateOf("PUBLIC_PHONE")).state === "OWNER_CONFIRMED");
    ok("a raw authority with the wrong source field is refused by the database",
      /source_field/.test((await errorOf(() => prisma.$executeRawUnsafe(
        `INSERT INTO "BusinessIdentityFactAuthority" ("businessId","fact","sourceField","valueHash","updatedAt") VALUES (${a.id},'BUSINESS_NAME','BusinessProfile.billingLegalName','${"0".repeat(64)}',now())`))) ?? ""));

    console.log("\n8 · Content Studio: explicit choices vs defaults, end to end through persistence");
    const envelope = (data: unknown) => ({ schemaVersion: 1, generatedAt: new Date().toISOString(), source: "user", data });
    const persist = (tone: string, choiceProvenance: unknown) => prisma.contentRun.create({
      data: { businessId: a.id, inputSnapshot: envelope(buildInputSnapshotData({ goal: "trust", audienceTypes: ["new", "interested"], selectedDirection: { tone } as never, choiceProvenance })) as never },
    });
    for (let i = 0; i < 10; i += 1) await persist("warm", { tone: "DEFAULTED", audience: "DERIVED" });
    for (let i = 0; i < 6; i += 1) {
      // a legacy run: persisted before the marker existed
      await prisma.contentRun.create({ data: { businessId: a.id, inputSnapshot: envelope({ goal: "trust", audienceTypes: ["new"], selectedDirection: { tone: "warm" } }) as never } });
    }
    const onlyDefaults = await tx((t) => getBusinessIdentity(a.id, t));
    ok("ten DEFAULTED and six LEGACY runs of 'warm' produce no tone suggestion", !onlyDefaults.signals.some((s) => s.kind === "CONTENT_TONE_PREFERENCE"));
    const stored = await prisma.$queryRawUnsafe<Array<{ p: unknown }>>(`SELECT "inputSnapshot" #> '{data,choiceProvenance}' AS p FROM "ContentRun" WHERE "businessId" = $1 ORDER BY id`, a.id);
    ok("persisted runs keep the distinction: 10 DEFAULTED/DERIVED, 6 with no marker (LEGACY_AMBIGUOUS)",
      stored.filter((r) => JSON.stringify(r.p) === JSON.stringify({ tone: "DEFAULTED", audience: "DERIVED" })).length === 10 && stored.filter((r) => r.p === null).length === 6);
    for (let i = 0; i < 3; i += 1) await persist("premium", { tone: "OWNER_SELECTED", audience: "DERIVED" });
    const withOwner = await tx((t) => getBusinessIdentity(a.id, t));
    const toneSig = withOwner.signals.find((s) => s.kind === "CONTENT_TONE_PREFERENCE");
    ok("three explicit 'premium' picks — and only they — suggest TONE PREMIUM", toneSig?.status === "SUPPORTED" && toneSig.suggestions[0]?.code === "PREMIUM" && toneSig.evidence.observations === 3);
    ok("goal-derived audiences never become an audience suggestion", !withOwner.signals.some((s) => s.kind === "CONTENT_AUDIENCE_PREFERENCE"));

    console.log("\n9 · Business Memory references resolve to the canonical rows");
    const knowledge = await tx((t) => loadIdentityKnowledge(t, a.id, new Date()));
    const empty = { measures: [], temporal: [], claims: [], vendorCategories: [], decisions: [], identity: [], proposals: [], installments: [], actions: [], outcomes: [] };
    const snap = assembleSnapshot(a.id, new Date(), { ...empty, ...knowledge } as never, { facts: [], awaiting: [], unassignedAwaitingCount: 0 } as never, { includeGaps: false });
    const items = snap.knowledge.filter((k) => k.domain === "identity");
    let resolvedAll = true;
    for (const k of items) {
      const r = await tx((t) => resolveIdentityProvenance(a.id, k.provenance[0], t));
      if (!r || r.row.id !== Number(k.subject!.id) || r.row.businessId !== a.id || r.row.status !== "ACTIVE") resolvedAll = false;
    }
    ok("every identity knowledge item resolves through its reference to an ACTIVE row of this business", items.length > 0 && resolvedAll, items.length);
    const activeStatements = await prisma.businessIdentityStatement.count({ where: { businessId: a.id, status: "ACTIVE" } });
    ok("one knowledge item per active statement", items.filter((k) => k.provenance[0].store === "BusinessIdentityStatement").length === activeStatements);
    const factItems = items.filter((k) => k.provenance[0].store === "BusinessIdentityFactAuthority");
    ok("fact authorities in memory: CITY (current, public) and PUBLIC_PHONE (confirmed) — computed in SQL",
      JSON.stringify(factItems.map((k) => [(k.value as { fact: string }).fact, (k.value as { publicUseApproved: boolean }).publicUseApproved]).sort()) === JSON.stringify([["CITY", true], ["PUBLIC_PHONE", false]]));
    const json = JSON.stringify(snap);
    ok("no statement text and no fact value is duplicated into memory",
      !json.includes("אחריות לשנתיים") && !json.includes("חיפה") && !json.includes("04-8123456") && !json.includes("office@example.test"));
    ok("a reference to a retired statement still resolves (history), marked RETIRED",
      (await tx((t) => resolveIdentityProvenance(a.id, { store: "BusinessIdentityStatement", id: t2.id }, t)))?.row.status === "RETIRED");
    ok("an unknown store resolves to nothing", (await tx((t) => resolveIdentityProvenance(a.id, { store: "KnowledgeMeasure", id: t2.id }, t))) === null);
  } finally {
    await prisma.contentRun.deleteMany({ where: { businessId: a.id } });
    await prisma.businessIdentityFactAuthority.deleteMany({ where: { businessId: a.id } });
    await prisma.businessProfile.deleteMany({ where: { businessId: a.id } });
    await prisma.businessIdentityStatement.deleteMany({ where: { businessId: a.id } });
    await prisma.businessService.deleteMany({ where: { businessId: a.id } });
    await prisma.user.deleteMany({ where: { businessId: a.id } });
    await prisma.business.deleteMany({ where: { id: a.id } });
    await prisma.$disconnect();
  }

  if (failed > 0) {
    console.error(`P2 identity DB: ${failed} failed`);
    process.exit(1);
  }
  console.log("P2 identity DB: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
