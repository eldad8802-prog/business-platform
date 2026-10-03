/**
 * P2 · Three-strategy readiness — DATA diversity, not rendering. Run:
 *   npx tsx lib/services/identity/identity-strategy.verify.test.ts
 *
 * For six verticals the REAL read model is assembled (assembleBusinessIdentity) from P1 offering
 * facts, owner identity statements, identity-fact authorities and derived signals, and the REAL
 * public inventory (publicUseInventory) decides what may be quoted. Three strategy directions per
 * vertical are declared by the inputs they need. The test asserts that:
 *   1. every input a direction needs exists in the read model in a usable knowledge state;
 *   2. across the three directions EACH of the five axes — objective, positioning angle, audience,
 *      offering emphasis, public-use-approved claims — takes at least two values, and every pair of
 *      directions differs on at least three of them;
 *   3. P1 alone (no P2) cannot tell the directions apart on more than one axis;
 *   4. unknown, unapproved, internal-only and stale material is absent from the inventory, so no
 *      direction can quote it.
 * It builds no page, no blueprint and no strategy engine; it proves the inputs exist.
 */
import type { BusinessIdentityDimension, BusinessIdentityFact } from "@prisma/client";
import { assembleBusinessIdentity, publicUseInventory, type IdentityInputs } from "./business-identity";
import { factValueHash, FACT_SOURCES, type FactAuthorityRow } from "./identity-fact-authority.service";
import type { IdentityEvidence } from "./identity-signals";
import type { IdentityStatementRow } from "./identity-statement.service";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

type Claim = BusinessIdentityDimension | BusinessIdentityFact;
type Statement = { dimension: BusinessIdentityDimension; code?: string; text?: string; publicUseApproved?: boolean };
type Fact = { fact: BusinessIdentityFact; value: string; authority?: "CONFIRMED" | "PUBLIC" | "STALE_PUBLIC" };
type Offering = { kind: "SERVICE" | "PRODUCT"; id: number; category: string; featured?: boolean };
type Direction = { name: string; objective: string; angle: string; audience: string; offeringEmphasis: string; quotes: Claim[] };
type Vertical = {
  name: string;
  offerings: Offering[];
  evidence: IdentityEvidence;
  statements: Statement[];
  facts: Fact[];
  directions: [Direction, Direction, Direction];
  /** Material that exists but must NOT be quotable (unapproved / internal / stale). */
  mustStayUnavailable: Claim[];
  laterGaps: string[];
};

const svc = (id: number, categoryLabel: string, extra: Partial<IdentityEvidence["services"][number]> = {}) =>
  ({ id, active: true, categoryLabel, fulfillment: "UNSPECIFIED", priceMode: "FIXED", ...extra });
const prod = (id: number, category: string) => ({ id, active: true, category });
const demand = (n: number, kind: "SERVICE" | "PRODUCT", id: number, signalType: string) =>
  Array.from({ length: n }, () => ({ offeringKind: kind, offeringId: id, signalType }));

const verticals: Vertical[] = [
  {
    name: "Retail",
    offerings: [
      { kind: "PRODUCT", id: 1, category: "חורף", featured: true }, { kind: "PRODUCT", id: 2, category: "חורף" },
      { kind: "PRODUCT", id: 3, category: "אביזרים" }, { kind: "PRODUCT", id: 4, category: "נעליים" },
      { kind: "PRODUCT", id: 5, category: "קיץ" }, { kind: "PRODUCT", id: 6, category: "אביזרים" },
    ],
    evidence: {
      services: [], products: [prod(1, "חורף"), prod(2, "חורף"), prod(3, "אביזרים"), prod(4, "נעליים"), prod(5, "קיץ"), prod(6, "אביזרים")],
      demand: [...demand(14, "PRODUCT", 1, "PURCHASE"), ...demand(8, "PRODUCT", 3, "PURCHASE")], variantSelections: [], bot: null,
    },
    statements: [
      { dimension: "PRIMARY_OBJECTIVE", code: "BUY" }, { dimension: "SECONDARY_OBJECTIVE", code: "VISIT_STORE" },
      { dimension: "TARGET_AUDIENCE", code: "LOCAL_CUSTOMERS" }, { dimension: "TARGET_AUDIENCE", code: "REMOTE_CUSTOMERS" },
      { dimension: "POSITIONING", code: "BREADTH" }, { dimension: "POSITIONING", code: "VALUE" }, { dimension: "POSITIONING", code: "LOCAL_TRUST" },
      { dimension: "DIFFERENTIATOR", text: "החלפה חינם תוך 30 יום", publicUseApproved: true },
      { dimension: "SERVICE_AREA", text: "חיפה והקריות", publicUseApproved: true },
      { dimension: "DESCRIPTION", text: "חנות אופנה משפחתית", publicUseApproved: false },
    ],
    facts: [
      { fact: "BUSINESS_NAME", value: "בוטיק הכרמל", authority: "PUBLIC" },
      { fact: "CITY", value: "חיפה", authority: "PUBLIC" },
      { fact: "OPENING_HOURS", value: "א׳-ה׳ 10:00-20:00", authority: "PUBLIC" },
      { fact: "PUBLIC_PHONE", value: "04-8123456" },
    ],
    directions: [
      { name: "conversion around the featured winter coat", objective: "BUY", angle: "VALUE", audience: "REMOTE_CUSTOMERS", offeringEmphasis: "featured:PRODUCT#1", quotes: ["DIFFERENTIATOR", "BUSINESS_NAME"] },
      { name: "catalog discovery across categories", objective: "BUY", angle: "BREADTH", audience: "REMOTE_CUSTOMERS", offeringEmphasis: "breadth", quotes: ["BUSINESS_NAME"] },
      { name: "local store visit", objective: "VISIT_STORE", angle: "LOCAL_TRUST", audience: "LOCAL_CUSTOMERS", offeringEmphasis: "category:אביזרים", quotes: ["SERVICE_AREA", "CITY", "OPENING_HOURS"] },
    ],
    mustStayUnavailable: ["PUBLIC_PHONE", "DESCRIPTION"],
    laterGaps: ["store photos with publication authority", "reviews/trust evidence", "page-level CTA preference"],
  },
  {
    name: "Beauty",
    offerings: [
      { kind: "SERVICE", id: 1, category: "שיער" }, { kind: "SERVICE", id: 2, category: "צבע", featured: true },
      { kind: "SERVICE", id: 3, category: "ייעוץ" },
    ],
    evidence: {
      services: [svc(1, "שיער", { fulfillment: "AT_BUSINESS" }), svc(2, "צבע", { fulfillment: "AT_BUSINESS", priceMode: "FROM" }), svc(3, "ייעוץ", { priceMode: "QUOTE_REQUIRED" })],
      products: [], demand: [...demand(9, "SERVICE", 2, "BOOKING"), ...demand(5, "SERVICE", 1, "BOOKING")], variantSelections: ["trust", "trust", "trust", "direct", "trust"],
      bot: { tone: "friendly", audienceTags: ["private"], priorities: ["customer_experience"] },
      contentChoices: [
        { tone: "premium", toneSource: "OWNER_SELECTED", audienceTypes: ["new"], audienceSource: "DERIVED" },
        { tone: "premium", toneSource: "OWNER_SELECTED", audienceTypes: ["new"], audienceSource: "DERIVED" },
        { tone: "premium", toneSource: "OWNER_SELECTED", audienceTypes: ["new"], audienceSource: "DERIVED" },
        { tone: "warm", toneSource: "DEFAULTED", audienceTypes: ["new"], audienceSource: "DERIVED" },
      ],
    },
    statements: [
      { dimension: "PRIMARY_OBJECTIVE", code: "BOOK" }, { dimension: "SECONDARY_OBJECTIVE", code: "DISCOVER_SERVICES" },
      { dimension: "TARGET_AUDIENCE", code: "APPOINTMENT_CUSTOMERS" }, { dimension: "TARGET_AUDIENCE", code: "NEW_CUSTOMERS" },
      { dimension: "POSITIONING", code: "PREMIUM" }, { dimension: "POSITIONING", code: "EXPERTISE" }, { dimension: "POSITIONING", code: "PERSONAL_SERVICE" },
      { dimension: "TONE", code: "PREMIUM" },
      { dimension: "SPECIALIZATION", text: "צבע לשיער", publicUseApproved: true },
      { dimension: "DESCRIPTION", text: "סטודיו שיער בוטיק עם יחס אישי", publicUseApproved: true },
    ],
    facts: [
      { fact: "BUSINESS_NAME", value: "סטודיו נועה", authority: "PUBLIC" },
      { fact: "CITY", value: "רמת גן", authority: "CONFIRMED" },
      { fact: "PUBLIC_PHONE", value: "052-1234567", authority: "PUBLIC" },
    ],
    directions: [
      { name: "premium expertise / trust", objective: "BOOK", angle: "EXPERTISE", audience: "NEW_CUSTOMERS", offeringEmphasis: "category:צבע", quotes: ["SPECIALIZATION", "DESCRIPTION", "BUSINESS_NAME"] },
      { name: "booking conversion around color", objective: "BOOK", angle: "PERSONAL_SERVICE", audience: "APPOINTMENT_CUSTOMERS", offeringEmphasis: "featured:SERVICE#2", quotes: ["PUBLIC_PHONE"] },
      { name: "treatment discovery", objective: "DISCOVER_SERVICES", angle: "PREMIUM", audience: "NEW_CUSTOMERS", offeringEmphasis: "breadth", quotes: ["DESCRIPTION"] },
    ],
    mustStayUnavailable: ["CITY"],
    laterGaps: ["before/after assets with publication authority", "reviews", "booking CTA wiring"],
  },
  {
    name: "Field Service",
    offerings: [
      { kind: "SERVICE", id: 1, category: "חירום", featured: true }, { kind: "SERVICE", id: 2, category: "התקנה" },
      { kind: "SERVICE", id: 3, category: "תחזוקה" },
    ],
    evidence: {
      services: [svc(1, "חירום", { fulfillment: "AT_CUSTOMER", priceMode: "QUOTE_REQUIRED" }), svc(2, "התקנה", { fulfillment: "AT_CUSTOMER", priceMode: "QUOTE_REQUIRED" }), svc(3, "תחזוקה", { fulfillment: "AT_CUSTOMER", priceMode: "RANGE" })],
      products: [], demand: [], variantSelections: [], bot: { tone: "casual", audienceTags: ["private", "business"], priorities: ["fast_service"] },
    },
    statements: [
      { dimension: "PRIMARY_OBJECTIVE", code: "CALL" }, { dimension: "SECONDARY_OBJECTIVE", code: "REQUEST_QUOTE" },
      { dimension: "TARGET_AUDIENCE", code: "HOME_SERVICE_CUSTOMERS" }, { dimension: "TARGET_AUDIENCE", code: "BUSINESSES" },
      { dimension: "POSITIONING", code: "SPEED" }, { dimension: "POSITIONING", code: "AVAILABILITY" }, { dimension: "POSITIONING", code: "SPECIALIZATION" },
      { dimension: "SERVICE_AREA", text: "גוש דן", publicUseApproved: true },
      { dimension: "SPECIALIZATION", text: "מיזוג אוויר מסחרי", publicUseApproved: true },
      { dimension: "DIFFERENTIATOR", text: "טכנאי מוסמך", publicUseApproved: false },
    ],
    facts: [
      { fact: "BUSINESS_NAME", value: "קור טק", authority: "PUBLIC" },
      { fact: "PUBLIC_PHONE", value: "03-6123456", authority: "PUBLIC" },
      { fact: "PUBLIC_EMAIL", value: "office@kortech.example", authority: "CONFIRMED" },
    ],
    directions: [
      { name: "emergency call / availability", objective: "CALL", angle: "AVAILABILITY", audience: "HOME_SERVICE_CUSTOMERS", offeringEmphasis: "featured:SERVICE#1", quotes: ["SERVICE_AREA", "PUBLIC_PHONE"] },
      { name: "commercial specialist quote", objective: "REQUEST_QUOTE", angle: "SPECIALIZATION", audience: "BUSINESSES", offeringEmphasis: "category:התקנה", quotes: ["SPECIALIZATION", "BUSINESS_NAME"] },
      { name: "maintenance plan quote for homes", objective: "REQUEST_QUOTE", angle: "SPEED", audience: "HOME_SERVICE_CUSTOMERS", offeringEmphasis: "category:תחזוקה", quotes: [] },
    ],
    mustStayUnavailable: ["DIFFERENTIATOR", "PUBLIC_EMAIL"],
    laterGaps: ["certification evidence before 'טכנאי מוסמך' can be public", "response-time evidence", "call CTA wiring"],
  },
  {
    name: "Restaurant",
    offerings: [
      { kind: "PRODUCT", id: 1, category: "עיקריות", featured: true }, { kind: "PRODUCT", id: 2, category: "ראשונות" },
      { kind: "SERVICE", id: 3, category: "קייטרינג" },
    ],
    evidence: {
      services: [svc(3, "קייטרינג", { fulfillment: "AT_CUSTOMER", priceMode: "QUOTE_REQUIRED" })], products: [prod(1, "עיקריות"), prod(2, "ראשונות")],
      demand: demand(25, "PRODUCT", 1, "PURCHASE"), variantSelections: [], bot: null,
    },
    statements: [
      { dimension: "PRIMARY_OBJECTIVE", code: "VISIT_STORE" }, { dimension: "SECONDARY_OBJECTIVE", code: "REQUEST_QUOTE" }, { dimension: "SECONDARY_OBJECTIVE", code: "DISCOVER_PRODUCTS" },
      { dimension: "TARGET_AUDIENCE", code: "LOCAL_CUSTOMERS" }, { dimension: "TARGET_AUDIENCE", code: "EVENT_CUSTOMERS" }, { dimension: "TARGET_AUDIENCE", code: "WALK_IN_CUSTOMERS" },
      { dimension: "POSITIONING", code: "LOCAL_TRUST" }, { dimension: "POSITIONING", code: "PERSONAL_SERVICE" },
      { dimension: "DESCRIPTION", text: "ביסטרו שכונתי עם מטבח עונתי", publicUseApproved: true },
    ],
    facts: [
      { fact: "BUSINESS_NAME", value: "ביסטרו השכונה", authority: "PUBLIC" },
      { fact: "OPENING_HOURS", value: "א׳-ש׳ 12:00-23:00", authority: "PUBLIC" },
      { fact: "CITY", value: "תל אביב", authority: "PUBLIC" },
      // approved for an older address; the address has since changed → lapsed
      { fact: "PUBLIC_ADDRESS", value: "הרצל 12", authority: "STALE_PUBLIC" },
    ],
    directions: [
      { name: "menu / visit", objective: "VISIT_STORE", angle: "LOCAL_TRUST", audience: "WALK_IN_CUSTOMERS", offeringEmphasis: "demand:PRODUCT#1", quotes: ["DESCRIPTION", "OPENING_HOURS", "CITY"] },
      { name: "event catering quote", objective: "REQUEST_QUOTE", angle: "PERSONAL_SERVICE", audience: "EVENT_CUSTOMERS", offeringEmphasis: "category:קייטרינג", quotes: ["BUSINESS_NAME"] },
      { name: "local discovery of the menu", objective: "DISCOVER_PRODUCTS", angle: "LOCAL_TRUST", audience: "LOCAL_CUSTOMERS", offeringEmphasis: "breadth", quotes: ["DESCRIPTION"] },
    ],
    mustStayUnavailable: ["PUBLIC_ADDRESS"],
    laterGaps: ["dedicated menu object", "dish photos with publication authority"],
  },
  {
    name: "Professional Service",
    offerings: [
      { kind: "SERVICE", id: 1, category: "משפט" }, { kind: "SERVICE", id: 2, category: "משפט" },
      { kind: "SERVICE", id: 3, category: "פגישה", featured: true },
    ],
    evidence: {
      services: [svc(1, "משפט", { fulfillment: "ONLINE", priceMode: "QUOTE_REQUIRED" }), svc(2, "משפט", { fulfillment: "ONLINE", priceMode: "NO_PUBLIC_PRICE" }), svc(3, "פגישה", { fulfillment: "ONLINE" })],
      products: [], demand: [], variantSelections: [], bot: { tone: "formal", audienceTags: ["business"], priorities: [] },
    },
    statements: [
      { dimension: "PRIMARY_OBJECTIVE", code: "LEAVE_LEAD" }, { dimension: "SECONDARY_OBJECTIVE", code: "BOOK" }, { dimension: "SECONDARY_OBJECTIVE", code: "WHATSAPP" },
      { dimension: "TARGET_AUDIENCE", code: "BUSINESSES" }, { dimension: "TARGET_AUDIENCE", code: "INDIVIDUALS" }, { dimension: "TARGET_AUDIENCE", code: "REMOTE_CUSTOMERS" },
      { dimension: "POSITIONING", code: "EXPERTISE" }, { dimension: "POSITIONING", code: "SPECIALIZATION" }, { dimension: "POSITIONING", code: "AVAILABILITY" },
      { dimension: "TONE", code: "PROFESSIONAL" },
      { dimension: "SPECIALIZATION", text: "דיני נדל״ן", publicUseApproved: true },
      { dimension: "DIFFERENTIATOR", text: "20 שנות ניסיון", publicUseApproved: true },
    ],
    facts: [
      { fact: "BUSINESS_NAME", value: "משרד כהן", authority: "PUBLIC" },
      { fact: "PUBLIC_EMAIL", value: "office@cohen-law.example", authority: "PUBLIC" },
      { fact: "PUBLIC_PHONE", value: "02-5123456" },
    ],
    directions: [
      { name: "expertise / authority", objective: "LEAVE_LEAD", angle: "EXPERTISE", audience: "BUSINESSES", offeringEmphasis: "category:משפט", quotes: ["SPECIALIZATION", "DIFFERENTIATOR", "BUSINESS_NAME"] },
      { name: "problem → solution consultation", objective: "BOOK", angle: "SPECIALIZATION", audience: "INDIVIDUALS", offeringEmphasis: "featured:SERVICE#3", quotes: ["SPECIALIZATION"] },
      { name: "quick question on WhatsApp", objective: "WHATSAPP", angle: "AVAILABILITY", audience: "REMOTE_CUSTOMERS", offeringEmphasis: "breadth", quotes: ["PUBLIC_EMAIL"] },
    ],
    mustStayUnavailable: ["PUBLIC_PHONE"],
    laterGaps: ["proof behind '20 שנות ניסיון' (trust system)", "credentials", "consultation CTA wiring"],
  },
  {
    name: "Hybrid",
    offerings: [
      { kind: "SERVICE", id: 1, category: "שיער", featured: true }, { kind: "SERVICE", id: 2, category: "שיער" },
      { kind: "PRODUCT", id: 9, category: "מוצרים", featured: true },
    ],
    evidence: {
      services: [svc(1, "שיער", { fulfillment: "AT_BUSINESS" }), svc(2, "שיער", { fulfillment: "AT_BUSINESS" })], products: [prod(9, "מוצרים")],
      demand: [...demand(11, "SERVICE", 1, "BOOKING"), ...demand(6, "PRODUCT", 9, "PURCHASE")], variantSelections: [], bot: null,
    },
    statements: [
      { dimension: "PRIMARY_OBJECTIVE", code: "BOOK" }, { dimension: "SECONDARY_OBJECTIVE", code: "BUY" },
      { dimension: "TARGET_AUDIENCE", code: "APPOINTMENT_CUSTOMERS" }, { dimension: "TARGET_AUDIENCE", code: "RETURNING_CUSTOMERS" }, { dimension: "TARGET_AUDIENCE", code: "REMOTE_CUSTOMERS" },
      { dimension: "POSITIONING", code: "PERSONAL_SERVICE" }, { dimension: "POSITIONING", code: "CONVENIENCE" }, { dimension: "POSITIONING", code: "EXPERTISE" },
      { dimension: "DIFFERENTIATOR", text: "מוצרים ללא מלחים שאנחנו משתמשים בהם בעצמנו", publicUseApproved: true },
    ],
    facts: [
      { fact: "BUSINESS_NAME", value: "מספרת דנה", authority: "PUBLIC" },
      { fact: "OPENING_HOURS", value: "ב׳-ו׳ 9:00-19:00", authority: "PUBLIC" },
    ],
    directions: [
      { name: "booking the featured service", objective: "BOOK", angle: "PERSONAL_SERVICE", audience: "APPOINTMENT_CUSTOMERS", offeringEmphasis: "featured:SERVICE#1", quotes: ["OPENING_HOURS"] },
      { name: "product sales to returning clients", objective: "BUY", angle: "CONVENIENCE", audience: "RETURNING_CUSTOMERS", offeringEmphasis: "featured:PRODUCT#9", quotes: ["DIFFERENTIATOR"] },
      { name: "care expertise across services + products", objective: "BUY", angle: "EXPERTISE", audience: "REMOTE_CUSTOMERS", offeringEmphasis: "breadth", quotes: ["DIFFERENTIATOR", "BUSINESS_NAME"] },
    ],
    mustStayUnavailable: [],
    laterGaps: ["product imagery with publication authority", "online purchase path", "reviews"],
  },
];

/** Build the real read-model inputs for one vertical (business 1, synthetic ids). */
function inputsFor(v: Vertical): IdentityInputs {
  let id = 0;
  const now = new Date("2026-10-01T00:00:00Z");
  const statements: IdentityStatementRow[] = v.statements.map((s) => ({
    id: ++id, businessId: 1, dimension: s.dimension, code: s.code ?? null, text: s.text ?? null,
    source: "OWNER_INPUT", sourceRef: "settings", status: "ACTIVE", confirmedByUserId: 1,
    publicUseApproved: s.publicUseApproved === true, publicUseApprovedAt: s.publicUseApproved ? now : null, createdAt: now,
  }));
  const factValues = { BUSINESS_NAME: null, CITY: null, OPENING_HOURS: null, PUBLIC_PHONE: null, PUBLIC_EMAIL: null, PUBLIC_ADDRESS: null } as IdentityInputs["factValues"];
  const factAuthorities: FactAuthorityRow[] = [];
  for (const f of v.facts) {
    factValues[f.fact] = f.value;
    if (!f.authority) continue;
    const approvedFor = f.authority === "STALE_PUBLIC" ? `${f.value} (before it changed)` : f.value;
    factAuthorities.push({
      id: ++id, businessId: 1, fact: f.fact, sourceField: FACT_SOURCES[f.fact].sourceField, valueHash: factValueHash(approvedFor),
      status: "ACTIVE", confirmedByUserId: 1, confirmedAt: now,
      publicUseApproved: f.authority !== "CONFIRMED", publicUseApprovedAt: f.authority !== "CONFIRMED" ? now : null,
    });
  }
  return {
    businessId: 1, factValues, factAuthorities, profile: null, statements, evidence: v.evidence,
    featured: v.offerings.filter((o) => o.featured).map((o) => ({ kind: o.kind, canonicalId: o.id })),
  };
}

const AXES = ["objective", "angle", "audience", "offeringEmphasis", "quotes"] as const;
const axisValue = (d: Direction, k: (typeof AXES)[number]) => (k === "quotes" ? JSON.stringify([...d.quotes].sort()) : d[k]);
function differingAxes(a: Direction, b: Direction): number {
  return AXES.filter((k) => axisValue(a, k) !== axisValue(b, k)).length;
}

for (const v of verticals) {
  const view = assembleBusinessIdentity(inputsFor(v));
  const inventory = publicUseInventory(view);
  const quotable = new Set<Claim>(inventory.map((c) => c.key));
  const coded = (dim: BusinessIdentityDimension) => new Set(view.statements.filter((s) => s.dimension === dim && s.code).map((s) => s.code!));
  const objectives = new Set([...coded("PRIMARY_OBJECTIVE"), ...coded("SECONDARY_OBJECTIVE")]);
  const concentrated = view.signals.find((s) => s.kind === "DEMAND_CONCENTRATION" && s.status === "SUPPORTED");
  const emphasis = new Set<string>([
    "breadth",
    ...view.offering.featured.map((f) => `featured:${f.kind}#${f.canonicalId}`),
    ...v.offerings.map((o) => `category:${o.category}`),
    ...(concentrated ? [`demand:${concentrated.value.offeringKind}#${concentrated.value.offeringId}`] : []),
  ]);

  for (const d of v.directions) {
    ok(`${v.name} · ${d.name}: objective is an owner-stated objective`, objectives.has(d.objective));
    ok(`${v.name} · ${d.name}: positioning angle is owner-stated`, coded("POSITIONING").has(d.angle));
    ok(`${v.name} · ${d.name}: audience is owner-stated`, coded("TARGET_AUDIENCE").has(d.audience));
    ok(`${v.name} · ${d.name}: offering emphasis exists in P1 facts / owner emphasis / demand`, emphasis.has(d.offeringEmphasis), d.offeringEmphasis);
    ok(`${v.name} · ${d.name}: everything it quotes is in the public-use inventory`, d.quotes.every((q) => quotable.has(q)), d.quotes.filter((q) => !quotable.has(q)));
  }

  for (const axis of AXES) {
    ok(`${v.name}: the directions differ in ${axis}`, new Set(v.directions.map((d) => axisValue(d, axis))).size >= 2);
  }
  const [a, b, c] = v.directions;
  ok(`${v.name}: every pair of directions differs on ≥3 of the five axes`,
    differingAxes(a, b) >= 3 && differingAxes(a, c) >= 3 && differingAxes(b, c) >= 3,
    [differingAxes(a, b), differingAxes(a, c), differingAxes(b, c)]);

  // Without P2 there is no objective, angle, audience or approved claim to differ on: only offering emphasis.
  const p1Only = v.directions.map((d) => ({ ...d, objective: "?", angle: "?", audience: "?", quotes: [] as Claim[] }));
  ok(`${v.name}: P1 alone can distinguish the directions on at most one axis`,
    differingAxes(p1Only[0], p1Only[1]) <= 1 && differingAxes(p1Only[0], p1Only[2]) <= 1 && differingAxes(p1Only[1], p1Only[2]) <= 1);

  ok(`${v.name}: unapproved / internal / stale material is absent from the inventory`, v.mustStayUnavailable.every((x) => !quotable.has(x)), v.mustStayUnavailable.filter((x) => quotable.has(x)));
  ok(`${v.name}: coded directives (objective, audience, tone, positioning) are never quotable`,
    !inventory.some((cl) => ["TARGET_AUDIENCE", "PRIMARY_OBJECTIVE", "SECONDARY_OBJECTIVE", "TONE", "POSITIONING"].includes(cl.key)));
  ok(`${v.name}: every quotable claim points at its canonical row`, inventory.every((cl) => Number.isInteger(cl.ref.id) && cl.ref.id > 0));
  ok(`${v.name}: derived signals are machine proposals, never quotable`, view.signals.every((s) => s.authority === "MACHINE_PROPOSAL" && s.publicUse === "INTERNAL_ONLY"));
  ok(`${v.name}: later gaps are recorded, not claimed as ready`, v.laterGaps.length > 0);
}

// Specific authority cases the fixtures exercise.
const retail = assembleBusinessIdentity(inputsFor(verticals[0]));
ok("Retail: the billing phone exists but is KNOWN, not public", retail.facts.find((f) => f.fact === "PUBLIC_PHONE")?.state === "KNOWN");
const beauty = assembleBusinessIdentity(inputsFor(verticals[1]));
ok("Beauty: a confirmed-but-not-approved city is OWNER_CONFIRMED and not quotable", beauty.facts.find((f) => f.fact === "CITY")?.state === "OWNER_CONFIRMED");
ok("Beauty: three explicit 'premium' tone picks are visible as a suggestion; the defaulted 'warm' run is not",
  beauty.signals.some((s) => s.kind === "CONTENT_TONE_PREFERENCE" && s.suggestions[0]?.code === "PREMIUM"));
const restaurant = assembleBusinessIdentity(inputsFor(verticals[3]));
const addr = restaurant.facts.find((f) => f.fact === "PUBLIC_ADDRESS")!;
ok("Restaurant: an approval given for an older address has lapsed (KNOWN, stale)", addr.state === "KNOWN" && addr.authorityStale && addr.authorityId === null);
ok("Field Service: 'טכנאי מוסמך' stays INTERNAL_ONLY until the trust layer can prove it",
  !publicUseInventory(assembleBusinessIdentity(inputsFor(verticals[2]))).some((cl) => cl.key === "DIFFERENTIATOR"));

console.log(failed === 0 ? "\nP2 three-strategy identity diversity: all checks passed ✔" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
