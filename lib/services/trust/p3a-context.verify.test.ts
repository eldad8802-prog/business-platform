/**
 * P3-A · Application slice — pure verification of the canonical BusinessIdentityContext, the trust-claim
 * authority rules, the conversion resolver, the AI / Business-Memory projections and the safety gates.
 * Run:
 *   npx tsx lib/services/trust/p3a-context.verify.test.ts
 *
 * The REAL read model is assembled (assembleIdentityContext → assembleBusinessIdentity, evaluateTrustClaim,
 * resolveConversion) from synthetic rows; service write paths are driven through a fake transaction that
 * records what would reach the database. Tenant isolation at the database (T1 / T16 / T17) is proven
 * by lib/services/identity/identity.rls.db.test.ts and lib/services/trust/trust-claim.db.test.ts.
 */
import type { BusinessIdentityDimension, BusinessIdentityFact, Prisma } from "@prisma/client";
import { assembleSnapshot } from "@/lib/knowledge/snapshot/assemble";
import type { DomainState, StoredKnowledge } from "@/lib/knowledge/snapshot/snapshot-sources";
import { getBusinessContentProfile, gateUnsourcedTestimonialStyle, TESTIMONIAL_STYLE_AVAILABLE } from "@/lib/services/business-content-profile.service";
import { getFormatRecommendations } from "@/lib/services/content-recommendation.service";
import { WHATSAPP_CLOUD_PLATFORM_PROVEN, type ConversionResolution } from "@/lib/services/conversion/conversion-resolver";
import { assembleBusinessIdentity, publicUseInventory, type IdentityInputs } from "@/lib/services/identity/business-identity";
import { assembleIdentityContext, identityContextForAi, type BusinessIdentityContext, type IdentityContextInputs } from "@/lib/services/identity/business-identity-context";
import { factValueHash, FACT_SOURCES, IDENTITY_FACTS, type FactAuthorityRow } from "@/lib/services/identity/identity-fact-authority.service";
import type { IdentityEvidence } from "@/lib/services/identity/identity-signals";
import { setIdentityPublicUse, type IdentityStatementRow } from "@/lib/services/identity/identity-statement.service";
import { claimLikeMatches, IdentityInputError, normalizeObjectiveChannel, OBJECTIVE_CHANNELS } from "@/lib/services/identity/identity-vocabulary";
import { CLAIM_CLASS, normalizeTrustClaim, servedCustomersBucket, TrustClaimInputError, wordingHash } from "./trust-claim-catalogue";
import {
  attachVerificationDocument,
  confirmTrustClaim,
  evaluateTrustClaim,
  listActiveTrustClaims,
  loadServedCustomers,
  setTrustClaimPublicUse,
  TRUST_CLAIM_SELECT,
  verificationDocumentRef,
  type TrustClaimRow,
} from "./trust-claim.service";
import { MAX_TRUST_DOCUMENT_BYTES, prepareTrustDocument, putTrustDocument, readTrustDocument } from "./trust-document-storage";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`OK: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}
async function rejects(fn: () => Promise<unknown>, type: new (...a: never[]) => Error): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (error) {
    return error instanceof type;
  }
}
function throwsSync(fn: () => unknown, type: new (...a: never[]) => Error): boolean {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof type;
  }
}

const NOW = new Date("2026-10-05T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/* ─── fixtures ────────────────────────────────────────────────────────────────────────────────── */

type FactFx = { fact: BusinessIdentityFact; value: string; authority?: "CONFIRMED" | "PUBLIC" | "STALE_PUBLIC" };
type StatementFx = { dimension: BusinessIdentityDimension; code?: string; text?: string; channel?: string; publicUseApproved?: boolean };
type Fx = {
  businessId?: number;
  facts?: FactFx[];
  statements?: StatementFx[];
  claims?: TrustClaimRow[];
  served?: number;
  whatsapp?: IdentityContextInputs["whatsappStatus"];
  webForm?: boolean;
  evidence?: Partial<IdentityEvidence>;
};

function inputsFor(fx: Fx): IdentityContextInputs {
  const businessId = fx.businessId ?? 1;
  let id = 0;
  const statements: IdentityStatementRow[] = (fx.statements ?? []).map((s) => ({
    id: ++id, businessId, dimension: s.dimension, code: s.code ?? null, text: s.text ?? null,
    source: "OWNER_INPUT", sourceRef: "settings", channel: (s.channel ?? null) as IdentityStatementRow["channel"], status: "ACTIVE", confirmedByUserId: 1,
    publicUseApproved: s.publicUseApproved === true, publicUseApprovedAt: s.publicUseApproved ? NOW : null, createdAt: NOW,
  }));
  const factValues = Object.fromEntries(IDENTITY_FACTS.map((f) => [f, null])) as IdentityInputs["factValues"];
  const factAuthorities: FactAuthorityRow[] = [];
  for (const f of fx.facts ?? []) {
    factValues[f.fact] = f.value;
    if (!f.authority) continue;
    const decidedFor = f.authority === "STALE_PUBLIC" ? `${f.value} (before it changed)` : f.value;
    factAuthorities.push({
      id: 100 + ++id, businessId, fact: f.fact, sourceField: FACT_SOURCES[f.fact].sourceField, valueHash: factValueHash(decidedFor),
      status: "ACTIVE", confirmedByUserId: 1, confirmedAt: NOW,
      publicUseApproved: f.authority !== "CONFIRMED", publicUseApprovedAt: f.authority !== "CONFIRMED" ? NOW : null,
    });
  }
  const evidence: IdentityEvidence = { services: [], products: [], demand: [], variantSelections: [], bot: null, ...fx.evidence };
  return {
    identity: { businessId, factValues, factAuthorities, profile: null, statements, evidence, featured: [] },
    trustClaims: fx.claims ?? [],
    servedCustomers: fx.served ?? 0,
    whatsappStatus: fx.whatsapp ?? null,
    webFormLive: fx.webForm ?? false,
    now: NOW,
  };
}
const ctxFor = (fx: Fx) => assembleIdentityContext(inputsFor(fx));

let claimSeq = 0;
function claimRow(
  kind: string,
  params: Record<string, unknown>,
  opts: { approved?: boolean; verified?: boolean; confirmedAt?: Date; served?: number | null; businessId?: number } = {},
): TrustClaimRow {
  const confirmedAt = opts.confirmedAt ?? ago(1);
  const n = normalizeTrustClaim(kind, params, { now: confirmedAt, servedCustomers: opts.served ?? null });
  return {
    id: ++claimSeq, businessId: opts.businessId ?? 1, claimKind: n.kind, claimClass: n.claimClass, scopeKey: n.scopeKey,
    params: n.params, wording: n.wording,
    evidenceRuleId: n.evidence?.ruleId ?? null, evidenceRuleVersion: n.evidence?.ruleVersion ?? null,
    evidenceCondition: (n.evidence?.condition ?? null) as Prisma.JsonValue,
    confirmedByUserId: 1, confirmedAt,
    verificationMethod: opts.verified ? "OWNER_DOCUMENT" : null,
    verificationAttachmentMimeType: opts.verified ? "application/pdf" : null,
    verifiedAt: opts.verified ? confirmedAt : null,
    validUntil: n.validUntil,
    publicUseApproved: opts.approved === true, publicUseApprovedAt: opts.approved ? confirmedAt : null,
    status: "ACTIVE",
  };
}

const svc = (id: number, extra: Partial<IdentityEvidence["services"][number]> = {}) =>
  ({ id, active: true, categoryLabel: "כללי", fulfillment: "UNSPECIFIED", priceMode: "FIXED", ...extra });
const prod = (id: number, category = "כללי") => ({ id, active: true, category });
const bookings = (n: number, status: string) =>
  Array.from({ length: n }, () => ({ offeringKind: "SERVICE" as const, offeringId: 1, signalType: "BOOKING", appointmentStatus: status }));

const usable = (r: ConversionResolution) => r.paths.filter((p) => p.terminal && (p.state === "AVAILABLE" || p.state === "AVAILABLE_UNOBSERVED"));
const channel = (ctx: BusinessIdentityContext, c: string) => ctx.conversion.channels.find((x) => x.channel === c)!;
const path = (ctx: BusinessIdentityContext, objective: string, c: string | null) => ctx.conversion.paths.find((p) => p.objective === objective && p.channel === c)!;
const conflictCodes = (ctx: BusinessIdentityContext) => ctx.conversion.conflicts.map((c) => c.code);

/** A fake transaction that records every call and serves canned reads. */
function fakeTx(reads: Record<string, unknown>) {
  const calls: { model: string; op: string; args: unknown }[] = [];
  const model = (name: string) =>
    new Proxy({}, {
      get: (_t, op: string) => async (args: unknown) => {
        calls.push({ model: name, op, args });
        const r = reads[`${name}.${op}`];
        return typeof r === "function" ? (r as (a: unknown) => unknown)(args) : r;
      },
    });
  const tx = new Proxy({}, {
    get: (_t, prop: string) => {
      if (prop === "$queryRaw") {
        return async (strings: TemplateStringsArray, ...values: unknown[]) => {
          calls.push({ model: "$queryRaw", op: "raw", args: { sql: strings.join("?"), values } });
          return reads.$queryRaw ?? [{ n: 0 }];
        };
      }
      return model(prop);
    },
  }) as unknown as Prisma.TransactionClient;
  return { tx, calls };
}

async function main(): Promise<void> {
/* ─── T2 · internal fact ≠ public-approved fact ───────────────────────────────────────────────── */
{
  const ctx = ctxFor({
    facts: [
      { fact: "PUBLIC_PHONE", value: "03-5550000" },
      { fact: "PUBLIC_EMAIL", value: "a@b.co", authority: "CONFIRMED" },
      { fact: "BUSINESS_NAME", value: "סטודיו נועה", authority: "PUBLIC" },
    ],
  });
  ok("T2 a KNOWN fact (value only) is not public", !ctx.publicUse.facts.some((f) => f.key === "PUBLIC_PHONE"));
  ok("T2 an OWNER_CONFIRMED fact is still not public", !ctx.publicUse.facts.some((f) => f.key === "PUBLIC_EMAIL"));
  ok("T2 only the PUBLIC_USE_APPROVED fact is public", ctx.publicUse.facts.length === 1 && ctx.publicUse.facts[0].key === "BUSINESS_NAME");
  ok("T2 a known-but-unapproved phone does not make PHONE a conversion channel",
    channel(ctx, "PHONE").state === "NOT_AUTHORIZED" && channel(ctx, "PHONE").blocking.includes("PUBLIC_PHONE_NOT_APPROVED"));
  ok("T2 an owner-confirmed email does not make EMAIL a conversion channel", channel(ctx, "EMAIL").state === "NOT_AUTHORIZED");
  const stale = ctxFor({ facts: [{ fact: "PUBLIC_PHONE", value: "03-5550001", authority: "STALE_PUBLIC" }], statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "CALL" }] });
  ok("T2 an approval for an older value lapses: not public, AUTHORITY_LAPSED conflict",
    !stale.publicUse.facts.length && channel(stale, "PHONE").blocking.includes("AUTHORITY_LAPSED") && conflictCodes(stale).includes("AUTHORITY_LAPSED"));
}

/* ─── T3 · connected WhatsApp ≠ an automatically selected public CTA ────────────────────────── */
{
  const connected = ctxFor({ whatsapp: "CONNECTED", facts: [{ fact: "PUBLIC_WHATSAPP", value: "+972501112222" }] });
  ok("T3 a connected WhatsApp with an unapproved number is NOT_AUTHORIZED", channel(connected, "WHATSAPP_CLOUD").state === "NOT_AUTHORIZED");
  ok("T3 …it sets no primary objective (UNSET) and recommends nothing on WhatsApp",
    connected.conversion.effectivePrimary === "UNSET" && !connected.conversion.recommendations.some((r) => r.channel === "WHATSAPP_CLOUD"));
  const approved = ctxFor({ whatsapp: "CONNECTED", facts: [{ fact: "PUBLIC_WHATSAPP", value: "+972501112222", authority: "PUBLIC" }] });
  ok("T3 connected + approved number is still PLATFORM_UNPROVEN, never auto-selected",
    channel(approved, "WHATSAPP_CLOUD").state === "PLATFORM_UNPROVEN" && approved.conversion.effectivePrimary === "UNSET" && approved.conversion.recommendations.length === 0);
  ok("T3 the Cloud path is not a usable path, so the business falls back to SURFACE_ONLY", approved.conversion.fallback === "SURFACE_ONLY");
  ok("T3 the platform flag is off until the M2 Production proof", WHATSAPP_CLOUD_PLATFORM_PROVEN === false);
  const broken = ctxFor({ whatsapp: "ERROR", facts: [{ fact: "PUBLIC_WHATSAPP", value: "+972501112222", authority: "PUBLIC" }], statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "WHATSAPP", channel: "WHATSAPP_CLOUD" }] });
  ok("T3 a connection in ERROR is DEGRADED and the owner's choice is flagged CHANNEL_DEGRADED",
    channel(broken, "WHATSAPP_CLOUD").state === "DEGRADED" && conflictCodes(broken).includes("CHANNEL_DEGRADED") && broken.conversion.effectivePrimary === "UNRESOLVED");
}

/* ─── T4 · approved public phone enables PHONE where the objective permits ─────────────────── */
{
  const call = ctxFor({ facts: [{ fact: "PUBLIC_PHONE", value: "03-5550000", authority: "PUBLIC" }], statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "CALL" }] });
  ok("T4 an approved phone makes PHONE AVAILABLE_UNOBSERVED", channel(call, "PHONE").state === "AVAILABLE_UNOBSERVED");
  ok("T4 CALL resolves to PHONE", JSON.stringify(call.conversion.effectivePrimary) === JSON.stringify({ objective: "CALL", channel: "PHONE" }));
  ok("T4 the phone is not a booking channel unless the owner declares booking by message",
    path(call, "BOOK", "PHONE").state === "NOT_DECLARED" && path(call, "BOOK", "PHONE").blocking.includes("BOOKING_BY_MESSAGE_NOT_DECLARED"));
  const book = ctxFor({ facts: [{ fact: "PUBLIC_PHONE", value: "03-5550000", authority: "PUBLIC" }], statements: [{ dimension: "CONVERSION_DECLARATION", code: "BOOKING_BY_MESSAGE" }, { dimension: "PRIMARY_OBJECTIVE", code: "BOOK", channel: "PHONE" }] });
  ok("T4 …and with the declaration, BOOK via PHONE is usable", path(book, "BOOK", "PHONE").state === "AVAILABLE_UNOBSERVED" && typeof book.conversion.effectivePrimary === "object");
  ok("T4 the objective × channel matrix refuses a channel the objective does not permit (VISIT_STORE by phone)",
    throwsSync(() => normalizeObjectiveChannel("PRIMARY_OBJECTIVE", "VISIT_STORE", "PHONE"), IdentityInputError));
  ok("T4 a channel never attaches to a non-objective dimension", throwsSync(() => normalizeObjectiveChannel("TONE", "WARM", "PHONE"), IdentityInputError));
  ok("T4 discovery objectives carry no channel", OBJECTIVE_CHANNELS.DISCOVER_SERVICES.length === 0 && throwsSync(() => normalizeObjectiveChannel("PRIMARY_OBJECTIVE", "DISCOVER_SERVICES", "PHONE"), IdentityInputError));
  ok("T4 a missing channel stays null (the resolver picks the best usable path)", normalizeObjectiveChannel("PRIMARY_OBJECTIVE", "CALL", undefined) === null);
}

/* ─── T5 · missing authority → SURFACE_ONLY / missing-authority, never a fabricated CTA ─────── */
{
  const bare = ctxFor({ facts: [{ fact: "PUBLIC_PHONE", value: "03-5550000" }, { fact: "PUBLIC_ADDRESS", value: "הרצל 1" }], statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "CALL" }] });
  ok("T5 no approved contact → SURFACE_ONLY", bare.conversion.fallback === "SURFACE_ONLY" && bare.publicUse.conversion.fallback === "SURFACE_ONLY");
  ok("T5 …no recommendation at all", bare.conversion.recommendations.length === 0);
  ok("T5 …the owner's objective is UNRESOLVED with a capability conflict, not replaced",
    bare.conversion.effectivePrimary === "UNRESOLVED" && conflictCodes(bare).includes("PREFERENCE_CAPABILITY_CONFLICT"));
  ok("T5 …and the missing authority is named", bare.conversion.missingAuthority.includes("PUBLIC_PHONE_NOT_APPROVED"));
  ok("T5 an address alone is not a storefront", channel(bare, "IN_PERSON").state === "NOT_AUTHORIZED");
}

/* ─── T6–T10 · trust-claim authority ─────────────────────────────────────────────────────────── */
{
  const internal = claimRow("FOUNDED_YEAR", { foundedYear: 2004 });
  const ctx = ctxFor({ claims: [internal] });
  ok("T6 a confirmed but unapproved claim is not public", ctx.publicUse.trustClaims.length === 0 && ctx.trust.claims[0].publicEffective === false);
  ok("T6 the wording is rendered server-side from the parameters", internal.wording === "פועלים מאז 2004");

  const lic = claimRow("LICENSED", { licenseType: "חשמלאי מוסמך", issuer: "משרד העבודה" }, { approved: true });
  const licView = evaluateTrustClaim(lic, { now: NOW, servedCustomers: null });
  ok("T7 a LICENSED claim without its private document has NEEDS_DOCUMENT and is not public even if flagged approved",
    licView.issues.includes("NEEDS_DOCUMENT") && !licView.publicEffective);
  const cert = claimRow("CERTIFIED", { certificationName: "קוסמטיקאית מוסמכת", issuer: "משרד הכלכלה" }, { approved: true, verified: true });
  const certView = evaluateTrustClaim(cert, { now: NOW, servedCustomers: null });
  ok("T7 with the document it may be public, labelled PROVIDED_BY_BUSINESS (never 'verified')",
    certView.publicEffective && certView.verification.label === "PROVIDED_BY_BUSINESS" && /לפי מידע שמסר העסק/.test(cert.wording));
  ok("T7 the claim class map: licence / certificate / dealer require verification",
    CLAIM_CLASS.LICENSED === "VERIFICATION_REQUIRED" && CLAIM_CLASS.CERTIFIED === "VERIFICATION_REQUIRED" && CLAIM_CLASS.AUTHORIZED_DEALER === "VERIFICATION_REQUIRED");

  const expired = claimRow("CERTIFIED", { certificationName: "עזרה ראשונה", issuer: "מד״א", validUntil: ymd(ago(10)) }, { approved: true, verified: true, confirmedAt: ago(60) });
  const due = claimRow("FOUNDED_YEAR", { foundedYear: 1999 }, { approved: true, confirmedAt: ago(400) });
  const t8 = ctxFor({ claims: [expired, due] });
  ok("T8 an expired claim is excluded from public use (EXPIRED)", t8.trust.claims.find((c) => c.id === expired.id)!.issues.includes("EXPIRED") && !t8.publicUse.trustClaims.some((c) => c.id === expired.id));
  ok("T8 a claim not re-confirmed for 12 months is excluded (RECONFIRM_DUE)", t8.trust.claims.find((c) => c.id === due.id)!.issues.includes("RECONFIRM_DUE") && !t8.publicUse.trustClaims.some((c) => c.id === due.id));
  ok("T8 both are listed for owner review", t8.trust.needsReview.length === 2);

  const { tx, calls } = fakeTx({ "businessTrustClaim.findMany": [] });
  await listActiveTrustClaims(1, tx);
  const where = (calls[0].args as { where: Record<string, unknown> }).where;
  ok("T9 the context reads ACTIVE claims of the business only — a retired claim never reaches it", where.status === "ACTIVE" && where.businessId === 1);
  ok("T9 the read never selects the private key or document hash", !("verificationAttachmentKey" in TRUST_CLAIM_SELECT) && !("verificationAttachmentSha256" in TRUST_CLAIM_SELECT));

  const founded = claimRow("FOUNDED_YEAR", { foundedYear: 2010 }, { approved: true });
  const t10 = ctxFor({ claims: [founded, cert] });
  ok("T10 approved claims with no open issue are in the public read model with their label",
    t10.publicUse.trustClaims.length === 2 &&
    t10.publicUse.trustClaims.find((c) => c.id === founded.id)?.label === null &&
    t10.publicUse.trustClaims.find((c) => c.id === cert.id)?.label === "PROVIDED_BY_BUSINESS");

  const { tx: tx2, calls: calls2 } = fakeTx({ "businessTrustClaim.findFirst": lic, "businessTrustClaim.updateMany": { count: 1 } });
  ok("T7 the service refuses to approve a claim with an open issue", await rejects(() => setTrustClaimPublicUse({ businessId: 1, userId: 1, claimId: lic.id, approved: true }, tx2, NOW), TrustClaimInputError));
  ok("T7 …and wrote nothing", !calls2.some((c) => c.op === "updateMany"));
  const { tx: tx3, calls: calls3 } = fakeTx({ "businessTrustClaim.findFirst": lic, "businessTrustClaim.updateMany": { count: 1 } });
  await setTrustClaimPublicUse({ businessId: 1, userId: 1, claimId: lic.id, approved: false }, tx3, NOW);
  ok("T7 withdrawing public use is always allowed", calls3.some((c) => c.op === "updateMany"));
  ok("T7 approval must be an explicit boolean (no truthy strings)",
    await rejects(() => setTrustClaimPublicUse({ businessId: 1, userId: 1, claimId: lic.id, approved: "yes" }, fakeTx({}).tx, NOW), TrustClaimInputError));

  const approvedCert = claimRow("CERTIFIED", { certificationName: "x", issuer: "y" }, { approved: true, verified: true });
  const { tx: tx4, calls: calls4 } = fakeTx({ "businessTrustClaim.findFirst": approvedCert, "businessTrustClaim.updateMany": { count: 1 } });
  await attachVerificationDocument({ businessId: 1, userId: 1, claimId: approvedCert.id, storageKey: "biz/1/trust/claim-1/doc-1-a.pdf", sha256: "0".repeat(64), mimeType: "application/pdf" }, tx4, NOW);
  const docData = (calls4.find((c) => c.op === "updateMany")!.args as { data: Record<string, unknown> }).data;
  ok("T7 replacing the document withdraws public use (approval was for the previous evidence)", docData.publicUseApproved === false && docData.verificationMethod === "OWNER_DOCUMENT");
  ok("T7 a document cannot be attached to a kind that takes none",
    await rejects(() => attachVerificationDocument({ businessId: 1, userId: 1, claimId: founded.id, storageKey: "biz/1/trust/x.pdf", sha256: "0".repeat(64), mimeType: "application/pdf" }, fakeTx({ "businessTrustClaim.findFirst": founded }).tx, NOW), TrustClaimInputError));

  const { tx: tx5, calls: calls5 } = fakeTx({ "businessTrustClaim.findFirst": null, "businessTrustClaim.create": founded });
  await confirmTrustClaim({ businessId: 1, userId: 1, kind: "FOUNDED_YEAR", params: { foundedYear: 2010 } }, tx5, NOW);
  const created = (calls5.find((c) => c.op === "create")!.args as { data: Record<string, unknown> }).data;
  ok("T6 a claim is always created INTERNAL (no public-use field in the insert) with its wording hash",
    !("publicUseApproved" in created) && created.wordingHash === wordingHash("פועלים מאז 2010"));
  ok("T6 parameters cannot smuggle links or contacts",
    throwsSync(() => normalizeTrustClaim("AUTHORIZED_DEALER", { brand: "www.brand.com" }, { now: NOW, servedCustomers: null }), TrustClaimInputError));
  ok("T6 a validity date must be in the future", throwsSync(() => normalizeTrustClaim("CERTIFIED", { certificationName: "x", issuer: "y", validUntil: ymd(ago(1)) }, { now: NOW, servedCustomers: null }), TrustClaimInputError));
  ok("T6 unknown kinds (e.g. TESTIMONIAL, RATING) are refused", throwsSync(() => normalizeTrustClaim("TESTIMONIAL", {}, { now: NOW, servedCustomers: null }), TrustClaimInputError)
    && throwsSync(() => normalizeTrustClaim("RATING", {}, { now: NOW, servedCustomers: null }), TrustClaimInputError));
}

/* ─── T11 · SERVED_CUSTOMERS never from billing / customer-table counts ─────────────────────── */
{
  const { tx, calls } = fakeTx({ $queryRaw: [{ n: 42 }] });
  const n = await loadServedCustomers(1, tx);
  const sql = (calls[0].args as { sql: string }).sql;
  ok("T11 served customers = DISTINCT customers of COMPLETED appointments ∪ WON leads",
    n === 42 && /FROM "Appointment"/.test(sql) && /'COMPLETED'/.test(sql) && /FROM "Lead"/.test(sql) && /'WON'/.test(sql) && /UNION/.test(sql));
  ok("T11 …never the Customer table, billing, invoices, sales or payments",
    !/FROM\s+"Customer"/.test(sql) && !/Billing|Invoice|Sale|Payment|Receipt/i.test(sql) && calls.length === 1);

  const { tx: tx2, calls: calls2 } = fakeTx({ $queryRaw: [{ n: 40 }], "customer.count": 100_000, "businessTrustClaim.findFirst": null });
  ok("T11 a threshold the evidence does not reach is refused",
    await rejects(() => confirmTrustClaim({ businessId: 1, userId: 1, kind: "SERVED_CUSTOMERS", params: { threshold: 50 } }, tx2, NOW), TrustClaimInputError));
  ok("T11 …the customer table was never consulted and nothing was created", !calls2.some((c) => c.model === "customer" || c.op === "create"));
  ok("T11 only the public buckets exist (no exact number)",
    throwsSync(() => normalizeTrustClaim("SERVED_CUSTOMERS", { threshold: 137 }, { now: NOW, servedCustomers: 500 }), TrustClaimInputError));
  ok("T11 the supported bucket is the largest bucket at or below the evidence", servedCustomersBucket(49) === null && servedCustomersBucket(50) === 50 && servedCustomersBucket(730) === 500);

  const served = claimRow("SERVED_CUSTOMERS", { threshold: 200 }, { approved: true, served: 260 });
  ok("T11 the claim carries its rule (p3.evidence.v1) and condition", served.evidenceRuleVersion === "p3.evidence.v1" && (served.evidenceCondition as { gte: number }).gte === 200);
  ok("T11 while the evidence holds, it is public", ctxFor({ claims: [served], served: 260 }).publicUse.trustClaims.length === 1);
  const lapsed = ctxFor({ claims: [served], served: 150 });
  ok("T11 when the evidence drops below the threshold the claim lapses (EVIDENCE_LAPSED) and leaves public use",
    lapsed.trust.claims[0].issues.includes("EVIDENCE_LAPSED") && lapsed.publicUse.trustClaims.length === 0);
  ok("T11 the internal count is never a public value", !JSON.stringify(lapsed.publicUse).includes("150") && !JSON.stringify(identityContextForAi(lapsed)).includes("\"count\""));
  const ruleChanged = { ...served, evidenceRuleVersion: "p3.evidence.v0" };
  ok("T11 a claim confirmed under another evidence rule is not public (EVIDENCE_RULE_CHANGED)",
    evaluateTrustClaim(ruleChanged, { now: NOW, servedCustomers: 999 }).issues.includes("EVIDENCE_RULE_CHANGED"));
}

/* ─── T12 · claim-like P2 text: flagged for review, never auto-converted, never withdrawn ───── */
{
  const ctx = ctxFor({
    statements: [
      { dimension: "DIFFERENTIATOR", text: "חשמלאים מוסמכים מאז 1998", publicUseApproved: true },
      { dimension: "SPECIALIZATION", text: "המובילים בארץ בתיקון מזגנים", publicUseApproved: false },
      { dimension: "DESCRIPTION", text: "תיקונים ביתיים בתל אביב", publicUseApproved: true },
    ],
  });
  ok("T12 claim-like text is listed for owner review with the claim kinds it reads like",
    ctx.trust.claimLikeStatements.length === 2 &&
    ctx.trust.claimLikeStatements[0].suggestedClaimKinds.includes("CERTIFIED") && ctx.trust.claimLikeStatements[0].suggestedClaimKinds.includes("FOUNDED_YEAR"));
  ok("T12 a prohibited superlative maps to no claim kind (it cannot be carried at all)", ctx.trust.claimLikeStatements[1].suggestedClaimKinds.includes(null));
  ok("T12 nothing is converted: no trust claim exists", ctx.trust.claims.length === 0 && ctx.publicUse.trustClaims.length === 0);
  ok("T12 nothing is withdrawn: the approved statement stays approved, marked needsOwnerReview",
    ctx.publicUse.statements.find((s) => s.value.includes("1998"))?.needsOwnerReview === true &&
    ctx.publicUse.statements.find((s) => s.value.includes("תל אביב"))?.needsOwnerReview === false);
  ok("T12 the AI projection does not treat the flagged text as public", identityContextForAi(ctx).ownerConfirmed.differentiators[0].publicUseApproved === false);
  ok("T12 plain text is not flagged", claimLikeMatches("תיקונים ביתיים בתל אביב").length === 0 && claimLikeMatches("שירות אישי וזמין").length === 0);
  ok("T12 licences, certificates, guarantees, counts and rankings are recognised",
    ["רישיון קבלן", "certified", "אחריות לשנה", "מעל 500 לקוחות", "number 1", "הכי טובים"].every((t) => claimLikeMatches(t).length > 0));

  const { tx, calls } = fakeTx({ "businessIdentityStatement.findFirst": { id: 7, dimension: "DIFFERENTIATOR", text: "בעלי רישיון מאז 2001" }, "businessIdentityStatement.updateMany": { count: 1 }, "businessIdentityStatement.findFirstOrThrow": {} });
  ok("T12 claim-like text cannot be newly approved as plain text", await rejects(() => setIdentityPublicUse({ businessId: 1, userId: 1, statementId: 7, approved: true }, tx), IdentityInputError));
  ok("T12 …and nothing was written", !calls.some((c) => c.op === "updateMany"));
  const { tx: tx2, calls: calls2 } = fakeTx({ "businessIdentityStatement.findFirst": { id: 7, dimension: "DIFFERENTIATOR", text: "בעלי רישיון מאז 2001" }, "businessIdentityStatement.updateMany": { count: 1 }, "businessIdentityStatement.findFirstOrThrow": {} });
  await setIdentityPublicUse({ businessId: 1, userId: 1, statementId: 7, approved: false }, tx2);
  ok("T12 the owner can always withdraw it", calls2.some((c) => c.op === "updateMany"));
}

/* ─── T13 · PLATFORM_UNPROVEN: owner-selectable, never auto-recommended ─────────────────────── */
{
  const ctx = ctxFor({
    whatsapp: "CONNECTED",
    facts: [{ fact: "PUBLIC_WHATSAPP", value: "+972501112222", authority: "PUBLIC" }, { fact: "PUBLIC_PHONE", value: "03-5550000", authority: "PUBLIC" }],
    statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "WHATSAPP", channel: "WHATSAPP_CLOUD" }],
  });
  ok("T13 the owner's PLATFORM_UNPROVEN choice stands as the effective primary",
    JSON.stringify(ctx.conversion.effectivePrimary) === JSON.stringify({ objective: "WHATSAPP", channel: "WHATSAPP_CLOUD" }));
  ok("T13 …visibly flagged", conflictCodes(ctx).includes("PLATFORM_UNPROVEN"));
  ok("T13 …but never recommended", !ctx.conversion.recommendations.some((r) => r.channel === "WHATSAPP_CLOUD"));
  ok("T13 …and not a usable path in the AI projection", !identityContextForAi(ctx).conversion.usablePaths.some((p) => p.channel === "WHATSAPP_CLOUD"));
  const unset = ctxFor({ whatsapp: "CONNECTED", facts: [{ fact: "PUBLIC_WHATSAPP", value: "+972501112222", authority: "PUBLIC" }], statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "WHATSAPP" }] });
  ok("T13 without an explicit channel, an unproven-only objective is still the owner's (flagged), never upgraded to a recommendation",
    conflictCodes(unset).includes("PLATFORM_UNPROVEN") && unset.conversion.recommendations.length === 0);
}

/* ─── T14 · booking recommendation needs real capability AND completed-booking evidence ─────── */
{
  const demandOnly = ctxFor({ evidence: { services: [svc(1)], demand: bookings(12, "COMPLETED") } });
  ok("T14 completed-booking demand alone recommends no BOOK path (no capability)",
    demandOnly.identity.signals.some((s) => s.kind === "BOOKING_DEMAND" && s.status === "SUPPORTED") && !demandOnly.conversion.recommendations.some((r) => r.objective === "BOOK"));
  ok("T14 BOOKING_DEMAND never suggests BOOK as an objective",
    demandOnly.identity.signals.find((s) => s.kind === "BOOKING_DEMAND")!.suggestions.every((x) => x.code !== "BOOK"));
  const proposed = ctxFor({ evidence: { services: [svc(1)], demand: [...bookings(8, "PROPOSED"), ...bookings(8, "CANCELED")] } });
  ok("T14 proposed / cancelled appointments are not booking evidence", !proposed.identity.signals.some((s) => s.kind === "BOOKING_DEMAND" && s.status === "SUPPORTED"));
  const capable = ctxFor({
    evidence: { services: [svc(1)], demand: bookings(12, "COMPLETED") },
    facts: [{ fact: "PUBLIC_PHONE", value: "03-5550000", authority: "PUBLIC" }],
    statements: [{ dimension: "CONVERSION_DECLARATION", code: "BOOKING_BY_MESSAGE" }],
  });
  ok("T14 evidence + a declared, authorised booking channel recommends BOOK on that channel",
    capable.conversion.recommendations.some((r) => r.objective === "BOOK" && r.channel === "PHONE"));
  const noEvidence = ctxFor({ facts: [{ fact: "PUBLIC_PHONE", value: "03-5550000", authority: "PUBLIC" }], statements: [{ dimension: "CONVERSION_DECLARATION", code: "BOOKING_BY_MESSAGE" }] });
  ok("T14 capability without booking evidence does not recommend BOOK", !noEvidence.conversion.recommendations.some((r) => r.objective === "BOOK"));
  ok("T14 Dubiz online booking and checkout are NOT_SUPPORTED_BY_PLATFORM", channel(capable, "DUBIZ_BOOKING").state === "NOT_SUPPORTED_BY_PLATFORM" && channel(capable, "DUBIZ_CHECKOUT").state === "NOT_SUPPORTED_BY_PLATFORM");
}

/* ─── T15 · testimonial content unavailable without sourced testimonials ────────────────────── */
{
  const types = ["hair_salon", "beauty_clinic", "restaurant", "catering", "retail_store", "real_estate", "law_firm", "medical_clinic", "fitness",
    "personal_trainer", "coaching", "consulting", "creative_studio", "photography", "event_business", "wedding_business", "home_services", "cleaning", "repair", "other"];
  const styles = types.flatMap((t) => (["leads", "trust", "exposure", "sales"] as const).map((g) => getBusinessContentProfile({ businessType: t, primaryGoal: g }).contentStyle));
  ok("T15 no content profile yields the testimonial style (every vertical × goal)", !styles.includes("testimonial"));
  ok("T15 the gate is closed and maps testimonial → demonstration",
    TESTIMONIAL_STYLE_AVAILABLE === false && gateUnsourcedTestimonialStyle({ ...getBusinessContentProfile({ businessType: "other" }), contentStyle: "testimonial" }).contentStyle === "demonstration");
  const formats = ["leads", "trust", "exposure", "sales"].flatMap((goal) => ["cta", "show_difference", "explain", "story", "proof", "behind_the_scenes"].flatMap((angle) =>
    (["ai", "camera", "voice"] as const).flatMap((mode) => getFormatRecommendations({ goal, contentAngle: angle, mode }).map((r) => r.format))));
  ok("T15 no format recommendation is a testimonial", !formats.some((f) => /testimonial/i.test(f)));
  ok("T15 the AI rules forbid inventing testimonials, reviews and ratings", identityContextForAi(ctxFor({})).rules.some((r) => /testimonials, reviews, ratings/.test(r)));
}

/* ─── T17 (pure part) · private evidence stays private and per-business ─────────────────────── */
{
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(100)]);
  const doc = prepareTrustDocument({ businessId: 3, claimId: 9, mimeType: "application/pdf", body: pdf });
  ok("T17 the storage key is built server-side under the business's private trust prefix", doc.storageKey.startsWith("biz/3/trust/claim-9/doc-") && doc.storageKey.endsWith(".pdf"));
  ok("T17 the sha256 is computed from the real bytes", /^[0-9a-f]{64}$/.test(doc.sha256));
  ok("T17 a file whose bytes do not match its declared type is refused",
    throwsSync(() => prepareTrustDocument({ businessId: 3, claimId: 9, mimeType: "image/png", body: pdf }), TrustClaimInputError));
  ok("T17 an unlisted type (html / svg) is refused", throwsSync(() => prepareTrustDocument({ businessId: 3, claimId: 9, mimeType: "text/html", body: Buffer.from("<html>") }), TrustClaimInputError)
    && throwsSync(() => prepareTrustDocument({ businessId: 3, claimId: 9, mimeType: "image/svg+xml", body: Buffer.from("<svg/>") }), TrustClaimInputError));
  ok("T17 an oversize file is refused", throwsSync(() => prepareTrustDocument({ businessId: 3, claimId: 9, mimeType: "application/pdf", body: Buffer.concat([pdf, Buffer.alloc(MAX_TRUST_DOCUMENT_BYTES)]) }), TrustClaimInputError));
  ok("T17 another business's object key can be neither read nor written",
    await rejects(() => readTrustDocument({ businessId: 1, storageKey: doc.storageKey }), TrustClaimInputError) &&
    await rejects(() => putTrustDocument({ businessId: 1, storageKey: doc.storageKey, body: pdf, mimeType: "application/pdf" }), TrustClaimInputError));
  ok("T17 attaching a key outside the business's trust prefix is refused",
    await rejects(() => attachVerificationDocument({ businessId: 1, userId: 1, claimId: 5, storageKey: "biz/3/trust/claim-9/doc.pdf", sha256: "0".repeat(64), mimeType: "application/pdf" },
      fakeTx({ "businessTrustClaim.findFirst": claimRow("LICENSED", { licenseType: "a", issuer: "b" }) }).tx, NOW), TrustClaimInputError));
  const { tx } = fakeTx({ "businessTrustClaim.findFirst": { verificationAttachmentKey: "biz/3/trust/claim-9/doc.pdf", verificationAttachmentMimeType: "application/pdf" } });
  ok("T17 a stored reference outside the business's prefix is never served", (await verificationDocumentRef({ businessId: 1, claimId: 9 }, tx)) === null);
}

/* ─── T18 · AI / Business-Memory context keeps authority classes apart ───────────────────────── */
{
  const ctx = ctxFor({
    facts: [{ fact: "PUBLIC_PHONE", value: "03-5550000" }, { fact: "PUBLIC_EMAIL", value: "a@b.co", authority: "PUBLIC" }],
    statements: [{ dimension: "DESCRIPTION", text: "מספרה שכונתית", publicUseApproved: true }, { dimension: "SPECIALIZATION", text: "צבע לשיער" }],
    claims: [claimRow("LICENSED", { licenseType: "a", issuer: "b" }, { approved: true }), claimRow("FOUNDED_YEAR", { foundedYear: 2001 }, { approved: true })],
    evidence: { services: [svc(1), svc(2), svc(3)] },
  });
  const ai = identityContextForAi(ctx);
  ok("T18 public facts and known-but-not-public facts are separate lists",
    ai.publicApproved.facts.some((f) => f.fact === "PUBLIC_EMAIL") && !ai.publicApproved.facts.some((f) => f.fact === "PUBLIC_PHONE") && ai.knownButNotPublic.includes("PUBLIC_PHONE"));
  ok("T18 owner text carries its own public-use flag", ai.ownerConfirmed.description[0].publicUseApproved === true && ai.ownerConfirmed.specializations[0].publicUseApproved === false);
  ok("T18 only effective trust claims are public; blocked ones are listed with their issues",
    ai.publicApproved.trustClaims.length === 1 && ai.unverifiedOrBlockedClaims.length === 1 && ai.unverifiedOrBlockedClaims[0].issues.includes("NEEDS_DOCUMENT"));
  ok("T18 derived recommendations are labelled MACHINE_PROPOSAL", ai.derived.authority === "MACHINE_PROPOSAL");
  ok("T18 the projection never carries the private document or its key", !/verificationAttachment|biz\/\d+\/trust/.test(JSON.stringify(ai)));

  const stored = {
    measures: [], temporal: [], claims: [], vendorCategories: [], decisions: [], identity: [], proposals: [], installments: [], actions: [], outcomes: [],
    identityStatements: [{ id: 41, dimension: "PRIMARY_OBJECTIVE", code: "REQUEST_QUOTE", channel: "PHONE", source: "OWNER_INPUT", sourceRef: "settings", status: "ACTIVE", confirmedByUserId: 1, publicUseApproved: false, createdAt: ago(2) }],
    identityFacts: [],
    trustClaims: [
      claimRow("FOUNDED_YEAR", { foundedYear: 2001 }, { approved: true }),
      claimRow("LICENSED", { licenseType: "a", issuer: "b" }),
      claimRow("CERTIFIED", { certificationName: "x", issuer: "y", validUntil: ymd(ago(5)) }, { verified: true, confirmedAt: ago(40) }),
    ],
    servedCustomers: null,
  } as unknown as StoredKnowledge;
  const snap = assembleSnapshot(1, NOW, stored, { facts: [], awaiting: [], unassignedAwaitingCount: 0 } as unknown as DomainState, { includeGaps: true });
  const trust = snap.knowledge.filter((k) => k.domain === "trust");
  ok("T18 Business Memory: active claims are OWNER_CONFIRMED items pointing at their row; an expired one is not knowledge",
    trust.length === 2 && trust.every((k) => k.authority === "OWNER_CONFIRMED" && k.provenance[0].store === "BusinessTrustClaim"));
  ok("T18 Business Memory: never the wording or parameters, never 'externally verified'",
    trust.every((k) => !("wording" in k.value) && !("params" in k.value) && (k.value as { externallyVerified: boolean }).externallyVerified === false));
  ok("T18 Business Memory: an undocumented licence enters as provided-by-business false, not public",
    trust.some((k) => (k.value as { claimKind: string; providedByBusiness: boolean; publicEffective: boolean }).claimKind === "LICENSED" &&
      (k.value as { providedByBusiness: boolean }).providedByBusiness === false && (k.value as { publicEffective: boolean }).publicEffective === false));
  const objective = snap.knowledge.find((k) => k.slot === "identity|PRIMARY_OBJECTIVE|REQUEST_QUOTE");
  ok("T18 Business Memory: an objective carries its channel", (objective?.value as { channel?: string } | undefined)?.channel === "PHONE");
}

/* ─── T19 · deterministic readiness with explicit missing inputs and conflicts ───────────────── */
{
  const empty = ctxFor({});
  ok("T19 an empty business names exactly what is missing",
    JSON.stringify(empty.readiness.missingRequiredInputs) === JSON.stringify(["DESCRIPTION", "TARGET_AUDIENCE", "PRIMARY_OBJECTIVE", "PUBLIC_BUSINESS_NAME", "PUBLIC_CONTACT", "ANY_USABLE_CONVERSION_PATH"]));
  ok("T19 …per dimension", !empty.readiness.identity.ready && !empty.readiness.publicFacts.ready && !empty.readiness.conversion.ready && empty.readiness.trust.missing.includes("PUBLIC_TRUST_CLAIM"));
  const flagged = ctxFor({ statements: [{ dimension: "DIFFERENTIATOR", text: "מספר 1 בעיר", publicUseApproved: true }] });
  ok("T19 approved claim-like text is a blocking review item", flagged.readiness.trust.missing.includes("REVIEW_CLAIM_LIKE_TEXT") && flagged.readiness.hasBlockingConflicts);
  const conflicted = ctxFor({ statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "VISIT_STORE" }] });
  ok("T19 an unfulfillable objective is a blocking conflict", conflicted.readiness.hasBlockingConflicts && conflicted.readiness.conversion.missing.includes("USABLE_PATH_FOR_PRIMARY_OBJECTIVE"));
  const ready = ctxFor({
    facts: [{ fact: "BUSINESS_NAME", value: "x", authority: "PUBLIC" }, { fact: "PUBLIC_PHONE", value: "03-5550000", authority: "PUBLIC" }],
    statements: [{ dimension: "DESCRIPTION", text: "מספרה" }, { dimension: "TARGET_AUDIENCE", code: "LOCAL_CUSTOMERS" }, { dimension: "PRIMARY_OBJECTIVE", code: "CALL" }],
    claims: [claimRow("FOUNDED_YEAR", { foundedYear: 2001 }, { approved: true })],
  });
  ok("T19 a complete business is ready on every dimension with no blocking conflict",
    ready.readiness.identity.ready && ready.readiness.publicFacts.ready && ready.readiness.conversion.ready && ready.readiness.trust.ready && !ready.readiness.hasBlockingConflicts && ready.readiness.missingRequiredInputs.length === 0);
  const a = JSON.stringify(ctxFor({ evidence: { services: [svc(1), svc(2)] }, facts: [{ fact: "PUBLIC_PHONE", value: "1", authority: "PUBLIC" }] }));
  const b = JSON.stringify(ctxFor({ evidence: { services: [svc(1), svc(2)] }, facts: [{ fact: "PUBLIC_PHONE", value: "1", authority: "PUBLIC" }] }));
  ok("T19 the context is deterministic (same inputs → byte-identical output)", a === b);
}

/* ─── T20 · legacy P2 behaviour is unchanged ─────────────────────────────────────────────────── */
{
  const inputs = inputsFor({
    facts: [{ fact: "CITY", value: "חיפה", authority: "PUBLIC" }, { fact: "PUBLIC_PHONE", value: "04-1", authority: "CONFIRMED" }],
    statements: [{ dimension: "TONE", code: "WARM" }, { dimension: "SERVICE_AREA", text: "הקריות", publicUseApproved: true }, { dimension: "PRIMARY_OBJECTIVE", code: "CALL" }],
    evidence: { services: [svc(1), svc(2), svc(3)] },
  });
  const ctx = assembleIdentityContext(inputs);
  const p2 = assembleBusinessIdentity(inputs.identity);
  ok("T20 the context embeds the P2 view unchanged", JSON.stringify(ctx.identity) === JSON.stringify(p2));
  ok("T20 the public inventory is P2's (facts + statements, same refs)",
    JSON.stringify(ctx.publicUse.facts) === JSON.stringify(publicUseInventory(p2).filter((c) => c.kind === "FACT")) &&
    ctx.publicUse.statements.map((s) => s.ref.id).join() === publicUseInventory(p2).filter((c) => c.kind === "STATEMENT").map((s) => s.ref.id).join());
  ok("T20 an objective without a channel (every pre-P3-A row) still resolves", ctx.conversion.preference[0].channel === null && ctx.conversion.preference[0].objective === "CALL");
  ok("T20 the P2 fact list now includes PUBLIC_WHATSAPP, UNKNOWN by default", p2.facts.find((f) => f.fact === "PUBLIC_WHATSAPP")?.state === "UNKNOWN");
}

/* ─── channel states (one per channel) + EXTERNAL_LINK never invents a shop link ─────────────── */
{
  const all = ctxFor({
    whatsapp: "CONNECTED",
    webForm: true,
    facts: [
      { fact: "PUBLIC_PHONE", value: "03-5550000", authority: "PUBLIC" }, { fact: "PUBLIC_EMAIL", value: "a@b.co", authority: "PUBLIC" },
      { fact: "PUBLIC_ADDRESS", value: "הרצל 1", authority: "PUBLIC" }, { fact: "OPENING_HOURS", value: "א-ה 9-18", authority: "PUBLIC" },
      { fact: "PUBLIC_WHATSAPP", value: "+972501112222", authority: "PUBLIC" },
    ],
    statements: ["ACCEPTS_VISITS", "WHATSAPP_ON_PUBLIC_PHONE", "EXTERNAL_SHOP", "QUOTES_ON_REQUEST", "BOOKING_BY_MESSAGE"].map((code) => ({ dimension: "CONVERSION_DECLARATION" as const, code })),
  });
  const states = Object.fromEntries(all.conversion.channels.map((c) => [c.channel, c.state]));
  ok("channels: PHONE / EMAIL / WHATSAPP_LINK / IN_PERSON = AVAILABLE_UNOBSERVED when authorised and declared",
    ["PHONE", "EMAIL", "WHATSAPP_LINK", "IN_PERSON"].every((c) => states[c] === "AVAILABLE_UNOBSERVED"), states);
  ok("channels: WHATSAPP_CLOUD = PLATFORM_UNPROVEN, DUBIZ_FORM = AVAILABLE (observed), DUBIZ_BOOKING / CHECKOUT = NOT_SUPPORTED_BY_PLATFORM",
    states.WHATSAPP_CLOUD === "PLATFORM_UNPROVEN" && states.DUBIZ_FORM === "AVAILABLE" && states.DUBIZ_BOOKING === "NOT_SUPPORTED_BY_PLATFORM" && states.DUBIZ_CHECKOUT === "NOT_SUPPORTED_BY_PLATFORM");
  ok("channels: EXTERNAL_LINK stays NOT_AUTHORIZED even with EXTERNAL_SHOP declared (no canonical shop-link authority)",
    states.EXTERNAL_LINK === "NOT_AUTHORIZED" && channel(all, "EXTERNAL_LINK").blocking.includes("NO_CANONICAL_SHOP_LINK_AUTHORITY"));
  ok("channels: no URL ever appears in the context", !/https?:\/\//.test(JSON.stringify(all)));
  ok("channels: WHATSAPP_LINK needs the owner's declaration that the public phone takes WhatsApp",
    channel(ctxFor({ facts: [{ fact: "PUBLIC_PHONE", value: "1", authority: "PUBLIC" }] }), "WHATSAPP_LINK").state === "NOT_DECLARED");
  ok("channels: DUBIZ_FORM is NOT_CONFIGURED without a live website form", channel(ctxFor({}), "DUBIZ_FORM").state === "NOT_CONFIGURED");
}

/* ─── six verticals: the context is useful and the invariants hold for each ─────────────────── */
{
  type V = { name: string; fx: Fx; expect: (ctx: BusinessIdentityContext) => [string, boolean][] };
  const verticals: V[] = [
    {
      name: "Retail",
      fx: {
        evidence: { products: [prod(1, "חורף"), prod(2, "חורף"), prod(3, "קיץ"), prod(4, "קיץ")] },
        facts: [{ fact: "BUSINESS_NAME", value: "בוטיק", authority: "PUBLIC" }, { fact: "PUBLIC_ADDRESS", value: "הרצל 1", authority: "PUBLIC" }, { fact: "OPENING_HOURS", value: "9-19", authority: "PUBLIC" }],
        statements: [
          { dimension: "CONVERSION_DECLARATION", code: "ACCEPTS_VISITS" }, { dimension: "CONVERSION_DECLARATION", code: "EXTERNAL_SHOP" },
          { dimension: "PRIMARY_OBJECTIVE", code: "VISIT_STORE" }, { dimension: "SECONDARY_OBJECTIVE", code: "BUY", channel: "EXTERNAL_LINK" },
        ],
      },
      expect: (ctx) => [
        ["visiting the store is the effective primary", JSON.stringify(ctx.conversion.effectivePrimary) === JSON.stringify({ objective: "VISIT_STORE", channel: "IN_PERSON" })],
        ["buying via an external link is a conflict (no shop-link authority), not a CTA", ctx.conversion.conflicts.some((c) => c.objective === "BUY" && c.detail.includes("NO_CANONICAL_SHOP_LINK_AUTHORITY"))],
        ["buying in person is a usable path", usable(ctx.conversion).some((p) => p.objective === "BUY" && p.channel === "IN_PERSON")],
      ],
    },
    {
      name: "Beauty",
      fx: {
        evidence: { services: [svc(1), svc(2), svc(3)], demand: bookings(14, "COMPLETED") },
        facts: [{ fact: "PUBLIC_PHONE", value: "052-0000000", authority: "PUBLIC" }],
        statements: [{ dimension: "CONVERSION_DECLARATION", code: "BOOKING_BY_MESSAGE" }, { dimension: "CONVERSION_DECLARATION", code: "WHATSAPP_ON_PUBLIC_PHONE" }, { dimension: "PRIMARY_OBJECTIVE", code: "BOOK" }],
        claims: [claimRow("CERTIFIED", { certificationName: "קוסמטיקאית מוסמכת", issuer: "משרד הכלכלה" }, { approved: true, verified: true })],
      },
      expect: (ctx) => [
        ["BOOK resolves to the best usable message channel (WhatsApp link)", JSON.stringify(ctx.conversion.effectivePrimary) === JSON.stringify({ objective: "BOOK", channel: "WHATSAPP_LINK" })],
        ["BOOK is recommended from completed bookings", ctx.conversion.recommendations.some((r) => r.objective === "BOOK")],
        ["the documented certificate is public, labelled", ctx.publicUse.trustClaims.length === 1 && ctx.publicUse.trustClaims[0].label === "PROVIDED_BY_BUSINESS"],
      ],
    },
    {
      name: "Field Service",
      fx: {
        whatsapp: "CONNECTED",
        evidence: { services: [svc(1, { fulfillment: "AT_CUSTOMER", priceMode: "QUOTE_REQUIRED" }), svc(2, { fulfillment: "AT_CUSTOMER", priceMode: "QUOTE_REQUIRED" }), svc(3, { priceMode: "QUOTE_REQUIRED" })] },
        facts: [{ fact: "PUBLIC_PHONE", value: "050-1", authority: "PUBLIC" }, { fact: "PUBLIC_WHATSAPP", value: "+972501", authority: "PUBLIC" }],
        statements: [{ dimension: "CONVERSION_DECLARATION", code: "QUOTES_ON_REQUEST" }, { dimension: "PRIMARY_OBJECTIVE", code: "REQUEST_QUOTE", channel: "WHATSAPP_CLOUD" }],
        claims: [claimRow("LICENSED", { licenseType: "חשמלאי", issuer: "משרד העבודה" }, { approved: true })],
      },
      expect: (ctx) => [
        ["the owner's WhatsApp Cloud quote path stands, flagged PLATFORM_UNPROVEN", conflictCodes(ctx).includes("PLATFORM_UNPROVEN") && typeof ctx.conversion.effectivePrimary === "object"],
        ["the recommendation is the proven phone path, not the Cloud path", ctx.conversion.recommendations.find((r) => r.objective === "REQUEST_QUOTE")?.channel === "PHONE"],
        ["an undocumented licence is not public", ctx.publicUse.trustClaims.length === 0 && ctx.trust.needsReview[0]?.issues.includes("NEEDS_DOCUMENT")],
      ],
    },
    {
      name: "Restaurant",
      fx: {
        served: 320,
        evidence: { services: [svc(1)] },
        facts: [{ fact: "PUBLIC_ADDRESS", value: "דיזנגוף 10", authority: "PUBLIC" }, { fact: "OPENING_HOURS", value: "12-23", authority: "PUBLIC" }],
        statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "VISIT_STORE" }],
        claims: [claimRow("SERVED_CUSTOMERS", { threshold: 200 }, { approved: true, served: 320 })],
      },
      expect: (ctx) => [
        ["without the visits declaration the store visit is UNRESOLVED", ctx.conversion.effectivePrimary === "UNRESOLVED" && channel(ctx, "IN_PERSON").blocking.includes("VISITS_NOT_DECLARED")],
        ["and with no other path the business is SURFACE_ONLY", ctx.conversion.fallback === "SURFACE_ONLY"],
        ["the evidence-backed customer claim is public; the supported bucket is internal", ctx.publicUse.trustClaims.length === 1 && ctx.trust.servedCustomers.supportedBucket === 200],
        ["a larger threshold than the evidence is refused", throwsSync(() => normalizeTrustClaim("SERVED_CUSTOMERS", { threshold: 500 }, { now: NOW, servedCustomers: 320 }), TrustClaimInputError)],
      ],
    },
    {
      name: "Professional Service",
      fx: {
        webForm: true,
        evidence: { services: [svc(1), svc(2), svc(3)] },
        facts: [{ fact: "PUBLIC_EMAIL", value: "office@x.co", authority: "PUBLIC" }],
        statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "LEAVE_LEAD" }],
        claims: [claimRow("FOUNDED_YEAR", { foundedYear: 2005 }, { approved: true }), claimRow("GUARANTEE", { coverage: "ייעוץ", duration: "30 יום", conditions: "בכפוף לתנאים" }, { approved: true, confirmedAt: ago(380) })],
      },
      expect: (ctx) => [
        ["leaving a lead resolves to the live website form", JSON.stringify(ctx.conversion.effectivePrimary) === JSON.stringify({ objective: "LEAVE_LEAD", channel: "DUBIZ_FORM" })],
        ["the founding year is public; the guarantee due for re-confirmation is not",
          ctx.publicUse.trustClaims.length === 1 && ctx.publicUse.trustClaims[0].kind === "FOUNDED_YEAR" && ctx.trust.needsReview.some((c) => c.kind === "GUARANTEE" && c.issues.includes("RECONFIRM_DUE"))],
      ],
    },
    {
      name: "Hybrid",
      fx: {
        whatsapp: "ERROR",
        evidence: { services: [svc(1), svc(2)], products: [prod(1), prod(2)] },
        facts: [{ fact: "PUBLIC_PHONE", value: "03-9", authority: "STALE_PUBLIC" }, { fact: "PUBLIC_WHATSAPP", value: "+9725", authority: "PUBLIC" }],
        statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "CALL" }, { dimension: "SECONDARY_OBJECTIVE", code: "WHATSAPP", channel: "WHATSAPP_CLOUD" }],
      },
      expect: (ctx) => [
        ["a phone changed after approval lapses the CALL objective", ctx.conversion.effectivePrimary === "UNRESOLVED" && conflictCodes(ctx).includes("AUTHORITY_LAPSED")],
        ["a WhatsApp connection in error is CHANNEL_DEGRADED", conflictCodes(ctx).includes("CHANNEL_DEGRADED")],
        ["nothing usable → SURFACE_ONLY, no CTA", ctx.conversion.fallback === "SURFACE_ONLY" && ctx.conversion.recommendations.length === 0],
        ["the readiness model blocks on the conflicts", ctx.readiness.hasBlockingConflicts],
      ],
    },
  ];
  for (const v of verticals) {
    const ctx = ctxFor(v.fx);
    for (const [name, cond] of v.expect(ctx)) ok(`${v.name}: ${name}`, cond);
    const usableKeys = new Set(usable(ctx.conversion).map((p) => `${p.objective}|${p.channel}`));
    ok(`${v.name}: every recommendation is a usable path (never PLATFORM_UNPROVEN)`, ctx.conversion.recommendations.every((r) => usableKeys.has(`${r.objective}|${r.channel}`)));
    ok(`${v.name}: public facts are exactly the approved, current facts`, ctx.publicUse.facts.every((f) => ctx.identity.facts.find((x) => x.fact === f.key)?.state === "PUBLIC_USE_APPROVED"));
    ok(`${v.name}: public trust claims are exactly the effective ones`, ctx.publicUse.trustClaims.every((c) => ctx.trust.claims.find((x) => x.id === c.id)?.publicEffective === true));
    ok(`${v.name}: SURFACE_ONLY ⇔ no usable path`, (ctx.conversion.fallback === "SURFACE_ONLY") === (usableKeys.size === 0));
    ok(`${v.name}: deterministic`, JSON.stringify(ctxFor(v.fx)) === JSON.stringify(ctx));
  }
}
}

main().then(() => {
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nP3-A application context: all ${passed} checks passed ✔`);
  if (failed) process.exit(1);
}, (error) => {
  console.error(error);
  process.exit(1);
});
