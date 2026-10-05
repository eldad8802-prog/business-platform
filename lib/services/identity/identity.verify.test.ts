/**
 * P2 · Identity vocabulary and derived signals, without a database. Run:
 *   npx tsx lib/services/identity/identity.verify.test.ts
 *
 * The properties that break silently: a guess stored as knowledge, a price read as positioning, a
 * demand count read as popularity, a person's trait read as an audience, contact data slipping into
 * identity text, an internal directive becoming publishable.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveIdentitySignals, SIGNAL_RULES_VERSION, suggestionRef, THRESHOLDS, type IdentityEvidence } from "./identity-signals";
import {
  readChoiceProvenance,
  sanitizeChoiceProvenance,
  toneProvenanceFor,
  vibeSourceOnContinue,
} from "@/lib/features/content/choice-provenance";
import { buildInputSnapshotData } from "@/lib/services/content-plan-persistence-v1.service";
import {
  DIMENSION_RULES,
  IdentityInputError,
  normalizeStatementValue,
  TARGET_AUDIENCE_CODES,
} from "./identity-vocabulary";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}
function throws(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof IdentityInputError ? error.message : `unexpected: ${String(error)}`;
  }
}

const empty: IdentityEvidence = { services: [], products: [], demand: [], variantSelections: [], bot: null };
const svc = (id: number, extra: Partial<IdentityEvidence["services"][number]> = {}) => ({
  id, active: true, categoryLabel: null, fulfillment: "UNSPECIFIED", priceMode: null, ...extra,
});
const prod = (id: number, category: string | null = null) => ({ id, active: true, category });

/* ── vocabulary ── */
{
  ok("coded dimensions refuse free text", throws(() => normalizeStatementValue("TARGET_AUDIENCE", { text: "families" })) !== null);
  ok("unknown codes are refused", throws(() => normalizeStatementValue("TONE", { code: "SARCASTIC" })) !== null);
  ok("text dimensions refuse codes", throws(() => normalizeStatementValue("DIFFERENTIATOR", { code: "SPEED" })) !== null);
  ok("empty text is refused, not stored as unknown", throws(() => normalizeStatementValue("DESCRIPTION", { text: "   " })) !== null);
  ok("over-long text is refused", throws(() => normalizeStatementValue("SERVICE_AREA", { text: "א".repeat(81) })) !== null);
  ok("a phone number cannot enter identity text", throws(() => normalizeStatementValue("DESCRIPTION", { text: "התקשרו 052-123-4567" })) !== null);
  ok("an email cannot enter identity text", throws(() => normalizeStatementValue("DIFFERENTIATOR", { text: "כתבו ל a@b.co" })) !== null);
  ok("a link cannot enter identity text", throws(() => normalizeStatementValue("DESCRIPTION", { text: "www.example.com" })) !== null);
  ok("a year range is not mistaken for a phone", throws(() => normalizeStatementValue("DIFFERENTIATOR", { text: "פעילים 2010-2024" })) === null);
  const norm = normalizeStatementValue("SPECIALIZATION", { text: "  צבע   לשיער  " });
  ok("text is whitespace-normalised", norm.text === "צבע לשיער" && norm.code === null);
  ok("only claim-like text dimensions are public-use eligible",
    Object.entries(DIMENSION_RULES).every(([d, r]) => r.publicUseEligible === ["DESCRIPTION", "SPECIALIZATION", "DIFFERENTIATOR", "SERVICE_AREA"].includes(d)));
  ok("the audience list has no person-trait code (age, family, religion, ethnicity, health, politics, orientation)",
    !TARGET_AUDIENCE_CODES.some((c) => /AGE|YOUNG|SENIOR|PARENT|FAMIL|RELIG|ETHN|HEALTH|POLIT|GENDER|ORIENT|WOMEN|MEN\b/.test(c)));
  ok("the migration's coded/text CHECK lists match the vocabulary", (() => {
    // P3-A replaced the value-shape CHECK with a superset (CONVERSION_DECLARATION is CODED): the latest
    // migration is the authority for the coded/text lists; the single-valued list is still P2's.
    const sql = readFileSync(join(process.cwd(), "prisma/migrations/20261004090000_p2_business_identity/migration.sql"), "utf8");
    const p3a = readFileSync(join(process.cwd(), "prisma/migrations/20261008090100_p3a_trust_claims/migration.sql"), "utf8");
    const coded = Object.entries(DIMENSION_RULES).filter(([, r]) => r.kind === "CODED").map(([d]) => `'${d}'`).join(", ");
    const text = Object.entries(DIMENSION_RULES).filter(([, r]) => r.kind === "TEXT").map(([d]) => `'${d}'`).join(", ");
    const single = Object.entries(DIMENSION_RULES).filter(([, r]) => r.single).map(([d]) => `'${d}'`).join(", ");
    return p3a.includes(`IN (${coded})`) && p3a.includes(`IN (${text})`) && sql.includes(`IN (${single})`);
  })());
}

/* ── derived signals: unknown stays unknown ── */
{
  const none = deriveIdentitySignals(empty);
  ok("a business with no evidence gets no suggestion at all", none.every((s) => s.suggestions.length === 0));
  ok("…and says why: INSUFFICIENT_EVIDENCE with what it has and needs",
    none.some((s) => s.kind === "OFFERING_MIX" && s.status === "INSUFFICIENT_EVIDENCE" && s.evidence.need === THRESHOLDS.offeringMix));
  ok("every signal is an internal machine proposal", none.concat(deriveIdentitySignals({ ...empty, services: [svc(1), svc(2), svc(3)] }))
    .every((s) => s.authority === "MACHINE_PROPOSAL" && s.publicUse === "INTERNAL_ONLY"));
}

/* ── derived signals: no price, demand or single event becomes positioning ── */
{
  const expensive: IdentityEvidence = {
    ...empty,
    services: Array.from({ length: 8 }, (_, i) => svc(i + 1, { priceMode: "FIXED", categoryLabel: `c${i % 2}` })),
  };
  const sigs = deriveIdentitySignals(expensive);
  ok("prices never produce PREMIUM or VALUE", sigs.every((s) => s.suggestions.every((x) => x.code !== "PREMIUM" && x.code !== "VALUE")));

  const hot: IdentityEvidence = {
    ...empty,
    services: [svc(1), svc(2), svc(3)],
    demand: Array.from({ length: 30 }, (_, i) => ({ offeringKind: "SERVICE" as const, offeringId: i < 25 ? 1 : 2, signalType: "PURCHASE" })),
  };
  const conc = deriveIdentitySignals(hot).find((s) => s.kind === "DEMAND_CONCENTRATION");
  ok("concentrated demand is reported internally…", conc?.status === "SUPPORTED" && conc.value.offeringId === 1);
  ok("…suggests nothing, and carries the not-a-popularity-claim caveat",
    conc!.suggestions.length === 0 && conc!.caveats.some((c) => /not evidence for a 'most popular' claim/.test(c)) && conc!.caveats.includes("does not set featuredByOwner"));

  const one = deriveIdentitySignals({ ...empty, services: [svc(1)], demand: [{ offeringKind: "SERVICE", offeringId: 1, signalType: "BOOKING", appointmentStatus: "COMPLETED" }] });
  ok("one booking suggests nothing (not 'fast', not 'appointment customers')",
    one.every((s) => s.suggestions.length === 0) && one.some((s) => s.kind === "BOOKING_DEMAND" && s.status === "INSUFFICIENT_EVIDENCE"));

  const booked = deriveIdentitySignals({ ...empty, services: [svc(1)], demand: Array.from({ length: 12 }, () => ({ offeringKind: "SERVICE" as const, offeringId: 1, signalType: "BOOKING", appointmentStatus: "COMPLETED" })) });
  ok("sustained COMPLETED bookings suggest APPOINTMENT_CUSTOMERS only — demand is not booking capability, never BOOK", (() => {
    const b = booked.find((s) => s.kind === "BOOKING_DEMAND");
    return b?.status === "SUPPORTED" && b.suggestions.some((x) => x.code === "APPOINTMENT_CUSTOMERS") && !b.suggestions.some((x) => x.code === "BOOK")
      && b.caveats.some((c) => /not booking capability/.test(c));
  })());
  const requested = deriveIdentitySignals({ ...empty, services: [svc(1)], demand: Array.from({ length: 12 }, (_, i) => ({ offeringKind: "SERVICE" as const, offeringId: 1, signalType: "BOOKING", appointmentStatus: ["PROPOSED", "CONFIRMED", "CANCELED", "NO_SHOW"][i % 4] })) });
  ok("proposed / confirmed / cancelled / no-show bookings are not booking evidence", requested.every((s) => s.kind !== "BOOKING_DEMAND" || s.suggestions.length === 0));

  const unspecified = deriveIdentitySignals({ ...empty, services: [svc(1), svc(2), svc(3)] });
  ok("UNSPECIFIED fulfillment is not evidence of anything", !unspecified.some((s) => s.kind === "FULFILLMENT_MODE"));
  const home = deriveIdentitySignals({ ...empty, services: [svc(1, { fulfillment: "AT_CUSTOMER" })] });
  ok("an owner-set AT_CUSTOMER service suggests HOME_SERVICE_CUSTOMERS", home.some((s) => s.kind === "FULFILLMENT_MODE" && s.suggestions[0]?.code === "HOME_SERVICE_CUSTOMERS"));
}

/* ── derived signals: breadth and focus need enough labelled offerings ── */
{
  const few = deriveIdentitySignals({ ...empty, products: [prod(1, "a"), prod(2, "b"), prod(3, "c"), prod(4, "d")] });
  ok("four labelled offerings are too few to call a catalog broad", few.some((s) => s.kind === "CATEGORY_BREADTH" && s.status === "INSUFFICIENT_EVIDENCE"));
  const broad = deriveIdentitySignals({ ...empty, products: ["a", "b", "c", "d", "a", "b"].map((c, i) => prod(i + 1, c)) });
  ok("six offerings over four categories suggest BREADTH", broad.some((s) => s.kind === "CATEGORY_BREADTH" && s.suggestions[0]?.code === "BREADTH"));
  const focused = deriveIdentitySignals({ ...empty, services: Array.from({ length: 6 }, (_, i) => svc(i + 1, { categoryLabel: "שיער" })) });
  const f = focused.find((s) => s.kind === "CATEGORY_BREADTH");
  ok("one category suggests SPECIALIZATION, with the not-proof-of-expertise caveat",
    f?.suggestions[0]?.code === "SPECIALIZATION" && f.caveats.includes("a focused catalog is not proof of expertise"));
  const unlabelled = deriveIdentitySignals({ ...empty, services: Array.from({ length: 10 }, (_, i) => svc(i + 1)) });
  ok("unlabelled offerings are not read as one category", unlabelled.some((s) => s.kind === "CATEGORY_BREADTH" && s.status === "INSUFFICIENT_EVIDENCE"));
}

/* ── derived signals: explicit owner choices elsewhere, and only those ── */
{
  const bot = deriveIdentitySignals({ ...empty, bot: { tone: "formal", audienceTags: ["parents", "seniors", "young", "business", "private"], priorities: ["fast_service", "closing_deals"] } });
  const codes = bot.flatMap((s) => s.suggestions.map((x) => `${x.dimension}:${x.code}`)).sort();
  ok("bot choices map to business-level suggestions only",
    JSON.stringify(codes) === JSON.stringify(["POSITIONING:SPEED", "TARGET_AUDIENCE:BUSINESSES", "TARGET_AUDIENCE:INDIVIDUALS", "TONE:PROFESSIONAL"]), codes);
  ok("parents / seniors / young are never read as an audience", !bot.some((s) => /parents|seniors|young/.test(JSON.stringify(s.value))));

  const variants = deriveIdentitySignals({ ...empty, variantSelections: ["trust", "trust", "trust", "trust", "direct"] });
  const v = variants.find((s) => s.kind === "CONTENT_VARIANT_PREFERENCE");
  ok("a repeated explicit content pick is observed, internally, without a suggestion", v?.status === "SUPPORTED" && v.value.variantKey === "trust" && v.suggestions.length === 0);
  const src = readFileSync(join(process.cwd(), "lib/services/identity/business-identity.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const jsonPaths = [...src.matchAll(/"inputSnapshot" #>>? '\{([^}]*)\}'/g)].map((m) => m[1]).sort();
  ok("from a content run the loader extracts exactly three JSON paths: the tone, its provenance, the audience",
    JSON.stringify(jsonPaths) === JSON.stringify(["data,audienceTypes", "data,choiceProvenance", "data,selectedDirection,tone"]), jsonPaths);
  ok("…and never the prompt, context, insight answers or brandTone",
    !/contentGoalPrompt|creatorContext|contentInsightAnswers|brandTone|contentText/.test(src));
  ok("the evidence loader never selects customer, lead, conversation or billing data",
    !/tx\.(customer|lead|conversation|message|whatsapp|appointment|billing)/i.test(src) && !/billing(Phone|Email|Address|TaxId)\s*:\s*true/.test(src));
  ok("an adoption names the rules version that proposed it", suggestionRef("BOT_TONE:botTone=formal", { dimension: "TONE", code: "PROFESSIONAL" }) === `${SIGNAL_RULES_VERSION}|BOT_TONE:botTone=formal>TONE:PROFESSIONAL`);
}

/* ── Content Studio: an explicit owner choice is never confused with a default ── */
{
  ok("no vibe at all → the tone is DEFAULTED", toneProvenanceFor(undefined, undefined) === "DEFAULTED" && toneProvenanceFor(null, "OWNER_SELECTED") === "DEFAULTED");
  ok("a vibe clicked in this visit → OWNER_SELECTED", vibeSourceOnContinue(true, undefined) === "OWNER_SELECTED");
  ok("a vibe restored from saved state with no record → UNKNOWN, not OWNER_SELECTED", vibeSourceOnContinue(false, undefined) === "UNKNOWN" && vibeSourceOnContinue(false, "DEFAULTED") === "UNKNOWN");
  ok("an owner-selected vibe carried forward stays OWNER_SELECTED", vibeSourceOnContinue(false, "OWNER_SELECTED") === "OWNER_SELECTED");
  ok("a vibe with an unknown origin gives an UNKNOWN tone", toneProvenanceFor("warm_personal", undefined) === "UNKNOWN" && toneProvenanceFor("warm_personal", "OWNER_SELECTED") === "OWNER_SELECTED");
  ok("server: a forged label is reduced to UNKNOWN", JSON.stringify(sanitizeChoiceProvenance({ tone: "VERY_SURE", audience: 7 }, { tone: "warm", audienceTypes: ["new"] })) === JSON.stringify({ tone: "UNKNOWN", audience: "UNKNOWN" }));
  ok("server: OWNER_SELECTED with no value is not evidence", JSON.stringify(sanitizeChoiceProvenance({ tone: "OWNER_SELECTED", audience: "OWNER_SELECTED" }, { tone: "", audienceTypes: [] })) === JSON.stringify({ tone: "UNKNOWN", audience: "UNKNOWN" }));
  ok("server: no marker at all → UNKNOWN on a new run", JSON.stringify(sanitizeChoiceProvenance(undefined, { tone: "warm", audienceTypes: ["new"] })) === JSON.stringify({ tone: "UNKNOWN", audience: "UNKNOWN" }));
  ok("reader: a run persisted before the marker is LEGACY_AMBIGUOUS", JSON.stringify(readChoiceProvenance(undefined)) === JSON.stringify({ tone: "LEGACY_AMBIGUOUS", audience: "LEGACY_AMBIGUOUS" }));
  const snap = buildInputSnapshotData({ selectedDirection: { tone: "warm" } as never, audienceTypes: ["new"], choiceProvenance: { tone: "DEFAULTED", audience: "DERIVED" } });
  ok("every newly persisted run carries the marker", JSON.stringify(snap.choiceProvenance) === JSON.stringify({ tone: "DEFAULTED", audience: "DERIVED" }));

  const run = (tone: string, toneSource: string, audienceTypes: string[] = ["new", "interested"], audienceSource = "DERIVED") => ({ tone, toneSource, audienceTypes, audienceSource });
  const defaults = deriveIdentitySignals({ ...empty, contentChoices: Array.from({ length: 12 }, () => run("warm", "DEFAULTED")) });
  ok("twelve DEFAULTED 'warm' tones suggest nothing", defaults.every((s) => s.suggestions.length === 0) && !defaults.some((s) => s.kind === "CONTENT_TONE_PREFERENCE"));
  const legacy = deriveIdentitySignals({ ...empty, contentChoices: Array.from({ length: 12 }, () => run("warm", "LEGACY_AMBIGUOUS")) });
  ok("twelve LEGACY_AMBIGUOUS runs suggest nothing — history is not backfilled as owner choice", legacy.every((s) => s.suggestions.length === 0));
  const unknown = deriveIdentitySignals({ ...empty, contentChoices: Array.from({ length: 12 }, () => run("premium", "UNKNOWN")) });
  ok("twelve UNKNOWN-origin tones suggest nothing", unknown.every((s) => s.suggestions.length === 0));
  const owner = deriveIdentitySignals({ ...empty, contentChoices: [run("premium", "OWNER_SELECTED"), run("premium", "OWNER_SELECTED"), run("premium", "OWNER_SELECTED"), ...Array.from({ length: 10 }, () => run("warm", "DEFAULTED"))] });
  const tone = owner.find((s) => s.kind === "CONTENT_TONE_PREFERENCE");
  ok("three explicit 'premium' picks suggest TONE PREMIUM — ten defaulted 'warm' runs do not outvote them",
    tone?.status === "SUPPORTED" && tone.suggestions[0]?.code === "PREMIUM" && tone.value.sharePct === 100);
  const two = deriveIdentitySignals({ ...empty, contentChoices: [run("warm", "OWNER_SELECTED"), run("warm", "OWNER_SELECTED"), ...Array.from({ length: 10 }, () => run("warm", "DEFAULTED"))] });
  ok("two explicit picks are INSUFFICIENT — defaults never top them up", two.some((s) => s.kind === "CONTENT_TONE_PREFERENCE" && s.status === "INSUFFICIENT_EVIDENCE" && s.evidence.observations === 2));
  const derivedAudience = deriveIdentitySignals({ ...empty, contentChoices: Array.from({ length: 12 }, () => run("warm", "DEFAULTED", ["new", "existing"], "DERIVED")) });
  ok("goal-DERIVED audiences suggest no audience", !derivedAudience.some((s) => s.kind === "CONTENT_AUDIENCE_PREFERENCE"));
  const ownerAudience = deriveIdentitySignals({ ...empty, contentChoices: Array.from({ length: 3 }, () => run("warm", "UNKNOWN", ["existing", "ready"], "OWNER_SELECTED")) });
  ok("explicitly selected audiences ('existing') suggest RETURNING_CUSTOMERS; funnel stages ('ready') suggest nothing",
    JSON.stringify(ownerAudience.filter((s) => s.kind === "CONTENT_AUDIENCE_PREFERENCE").flatMap((s) => s.suggestions.map((x) => x.code))) === JSON.stringify(["RETURNING_CUSTOMERS"]));

  const flow = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  ok("the vibe step records an explicit click, not the restored value", /setVibeClicked\(true\)/.test(flow("app/(shell)/content/page.tsx")) && /vibeSourceOnContinue\(vibeClicked/.test(flow("app/(shell)/content/page.tsx")));
  ok("the setup step labels the tone by its origin and the goal-computed audience as DERIVED",
    /toneProvenanceFor\(existing\.vibe, existing\.vibeSource\)/.test(flow("app/(shell)/content/setup/page.tsx")) && /audience: "DERIVED"/.test(flow("app/(shell)/content/setup/page.tsx")));
  ok("the plan request carries the marker", /choiceProvenance: merged\.choiceProvenance/.test(flow("app/(shell)/content/creator-plan/page.tsx")));
}

/* ── determinism ── */
{
  const e: IdentityEvidence = { ...empty, services: [svc(2, { categoryLabel: "b" }), svc(1, { categoryLabel: "a" })], demand: [] };
  const reversed: IdentityEvidence = { ...e, services: [...e.services].reverse() };
  ok("row order does not change the signals", JSON.stringify(deriveIdentitySignals(e)) === JSON.stringify(deriveIdentitySignals(reversed)));
}

console.log(failed === 0 ? "\nP2 identity vocabulary + signals: all checks passed ✔" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
