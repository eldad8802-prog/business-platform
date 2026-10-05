/**
 * Landing knowledge — pure verification (`npm run verify:landing-knowledge`).
 *
 * The REAL canonical context is assembled (assembleIdentityContext) from synthetic rows, then read
 * by buildLandingKnowledge. It pins:
 *   1. chapter states are deterministic and explainable (COMPLETE / IN_PROGRESS / MISSING + needs);
 *   2. readiness is a count of complete chapters — no percentage exists;
 *   3. the preview is filled ONLY from approved public material, never from internal statements,
 *      unapproved facts, internal trust claims or claim-like text under review;
 *   4. "learned" holds only SUPPORTED deterministic signals, and drops what the owner already adopted;
 *   5. publishing does not exist (published is always false);
 *   6. the screen keeps every write on an existing endpoint and invents no score.
 * Database tenant isolation of the context is proven by identity.rls.db.test.ts (unchanged reads).
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import type { BusinessIdentityDimension, BusinessIdentityFact, Prisma } from "@prisma/client";

import { normalizeTrustClaim } from "@/lib/services/trust/trust-claim-catalogue";
import type { TrustClaimRow } from "@/lib/services/trust/trust-claim.service";

import type { IdentityInputs } from "./business-identity";
import { assembleIdentityContext, type IdentityContextInputs } from "./business-identity-context";
import { factValueHash, FACT_SOURCES, IDENTITY_FACTS, type FactAuthorityRow } from "./identity-fact-authority.service";
import type { IdentityEvidence } from "./identity-signals";
import type { IdentityStatementRow } from "./identity-statement.service";
import { buildLandingKnowledge, type LandingKnowledge } from "./landing-knowledge";

let passed = 0;
function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

const NOW = new Date("2026-10-05T12:00:00.000Z");

type Fx = {
  facts?: { fact: BusinessIdentityFact; value: string; authority?: "CONFIRMED" | "PUBLIC" }[];
  statements?: { dimension: BusinessIdentityDimension; code?: string; text?: string; channel?: string; publicUseApproved?: boolean }[];
  category?: string | null;
  claims?: TrustClaimRow[];
  evidence?: Partial<IdentityEvidence>;
  declarations?: string[];
};

function ctxFor(fx: Fx) {
  const businessId = 7;
  let id = 0;
  const statements: IdentityStatementRow[] = [
    ...(fx.statements ?? []),
    ...(fx.declarations ?? []).map((code) => ({ dimension: "CONVERSION_DECLARATION" as BusinessIdentityDimension, code })),
  ].map((s) => ({
    id: ++id,
    businessId,
    dimension: s.dimension,
    code: ("code" in s ? s.code : null) ?? null,
    text: ("text" in s ? s.text : null) ?? null,
    source: "OWNER_INPUT",
    sourceRef: "settings",
    channel: (("channel" in s ? s.channel : null) ?? null) as IdentityStatementRow["channel"],
    status: "ACTIVE",
    confirmedByUserId: 1,
    publicUseApproved: "publicUseApproved" in s && s.publicUseApproved === true,
    publicUseApprovedAt: "publicUseApproved" in s && s.publicUseApproved ? NOW : null,
    createdAt: NOW,
  }));
  const factValues = Object.fromEntries(IDENTITY_FACTS.map((f) => [f, null])) as IdentityInputs["factValues"];
  const factAuthorities: FactAuthorityRow[] = [];
  for (const f of fx.facts ?? []) {
    factValues[f.fact] = f.value;
    if (!f.authority) continue;
    factAuthorities.push({
      id: 100 + ++id,
      businessId,
      fact: f.fact,
      sourceField: FACT_SOURCES[f.fact].sourceField,
      valueHash: factValueHash(f.value),
      status: "ACTIVE",
      confirmedByUserId: 1,
      confirmedAt: NOW,
      publicUseApproved: f.authority === "PUBLIC",
      publicUseApprovedAt: f.authority === "PUBLIC" ? NOW : null,
    });
  }
  const inputs: IdentityContextInputs = {
    identity: {
      businessId,
      factValues,
      factAuthorities,
      profile: fx.category === undefined ? null : { category: fx.category, subCategory: null, businessModel: null },
      statements,
      evidence: { services: [], products: [], demand: [], variantSelections: [], bot: null, ...fx.evidence },
      featured: [],
    },
    trustClaims: fx.claims ?? [],
    servedCustomers: 0,
    whatsappStatus: null,
    webFormLive: false,
    now: NOW,
  };
  return assembleIdentityContext(inputs);
}

function claimRow(kind: string, params: Record<string, unknown>, approved: boolean): TrustClaimRow {
  const n = normalizeTrustClaim(kind, params, { now: NOW, servedCustomers: null });
  return {
    id: 1,
    businessId: 7,
    claimKind: n.kind,
    claimClass: n.claimClass,
    scopeKey: n.scopeKey,
    params: n.params,
    wording: n.wording,
    evidenceRuleId: null,
    evidenceRuleVersion: null,
    evidenceCondition: null as Prisma.JsonValue,
    confirmedByUserId: 1,
    confirmedAt: NOW,
    verificationMethod: null,
    verificationAttachmentMimeType: null,
    verifiedAt: null,
    validUntil: n.validUntil,
    publicUseApproved: approved,
    publicUseApprovedAt: approved ? NOW : null,
    status: "ACTIVE",
  };
}

const chapter = (k: LandingKnowledge, key: string) => k.chapters.find((c) => c.key === key)!;
const section = (k: LandingKnowledge, role: string) => k.preview.sections.find((s) => s.role === role)!;

console.log("Landing knowledge");

/* 1 · a business that has said nothing */
check("empty business: every chapter MISSING, 0 of 4, nothing previewed, nothing learned", () => {
  const k = buildLandingKnowledge(ctxFor({}));
  assert.deepEqual(k.chapters.map((c) => c.state), ["MISSING", "MISSING", "MISSING", "MISSING"]);
  assert.equal(k.completeChapters, 0);
  assert.equal(k.totalChapters, 4);
  assert.ok(k.preview.sections.every((s) => s.items.length === 0));
  assert.equal(k.learned.suggestions.length + k.learned.observations.length, 0);
  assert.equal(k.preview.published, false);
});

/* 2 · deterministic chapter rules */
check("who: category alone is IN_PROGRESS and still needs the one-sentence description", () => {
  const c = chapter(buildLandingKnowledge(ctxFor({ category: "Food" })), "who");
  assert.equal(c.state, "IN_PROGRESS");
  assert.deepEqual(c.needs, ["DESCRIPTION"]);
});

check("who: description + category is COMPLETE", () => {
  const c = chapter(buildLandingKnowledge(ctxFor({ category: "Food", statements: [{ dimension: "DESCRIPTION", text: "מאפייה שכונתית" }] })), "who");
  assert.equal(c.state, "COMPLETE");
});

check("audience: one target audience completes the chapter", () => {
  const k = buildLandingKnowledge(ctxFor({ statements: [{ dimension: "TARGET_AUDIENCE", code: "LOCAL_CUSTOMERS" }] }));
  assert.equal(chapter(k, "audience").state, "COMPLETE");
});

check("why: tone alone is IN_PROGRESS; positioning + a trust claim is COMPLETE", () => {
  const partial = chapter(buildLandingKnowledge(ctxFor({ statements: [{ dimension: "TONE", code: "WARM" }] })), "why");
  assert.equal(partial.state, "IN_PROGRESS");
  assert.deepEqual(partial.needs, ["POSITIONING", "DIFFERENTIATOR_OR_TRUST"]);
  const full = chapter(
    buildLandingKnowledge(ctxFor({ statements: [{ dimension: "POSITIONING", code: "EXPERTISE" }], claims: [claimRow("FOUNDED_YEAR", { foundedYear: 2010 }, false)] })),
    "why",
  );
  assert.equal(full.state, "COMPLETE");
});

check("action: an objective with no usable way to do it is IN_PROGRESS (needs a usable path)", () => {
  const c = chapter(buildLandingKnowledge(ctxFor({ statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "CALL" }] })), "action");
  assert.equal(c.state, "IN_PROGRESS");
  assert.deepEqual(c.needs, ["USABLE_PATH"]);
});

check("action: CALL with an approved public phone is COMPLETE", () => {
  const c = chapter(
    buildLandingKnowledge(ctxFor({ statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "CALL" }], facts: [{ fact: "PUBLIC_PHONE", value: "03-5550000", authority: "PUBLIC" }] })),
    "action",
  );
  assert.equal(c.state, "COMPLETE");
});

check("readiness is the count of COMPLETE chapters — all four", () => {
  const k = buildLandingKnowledge(
    ctxFor({
      category: "Food",
      statements: [
        { dimension: "DESCRIPTION", text: "מאפייה שכונתית" },
        { dimension: "TARGET_AUDIENCE", code: "LOCAL_CUSTOMERS" },
        { dimension: "POSITIONING", code: "EXPERTISE" },
        { dimension: "DIFFERENTIATOR", text: "אופים כל בוקר" },
        { dimension: "PRIMARY_OBJECTIVE", code: "CALL" },
      ],
      facts: [{ fact: "PUBLIC_PHONE", value: "03-5550000", authority: "PUBLIC" }],
    }),
  );
  assert.equal(k.completeChapters, 4);
});

/* 3 · the preview reads approved public material only */
check("preview: an internal description is counted as awaiting approval, never shown", () => {
  const k = buildLandingKnowledge(ctxFor({ statements: [{ dimension: "DESCRIPTION", text: "טקסט פנימי" }] }));
  const hero = section(k, "HERO");
  assert.equal(hero.status, "NEEDS_APPROVAL");
  assert.equal(hero.awaitingApproval, 1);
  assert.ok(!JSON.stringify(k.preview).includes("טקסט פנימי"));
});

check("preview: approved name and description appear; unapproved phone does not", () => {
  const k = buildLandingKnowledge(
    ctxFor({
      statements: [{ dimension: "DESCRIPTION", text: "מאפייה שכונתית", publicUseApproved: true }],
      facts: [
        { fact: "BUSINESS_NAME", value: "מאפיית השקמה", authority: "PUBLIC" },
        { fact: "PUBLIC_PHONE", value: "03-1111111", authority: "CONFIRMED" },
      ],
    }),
  );
  assert.equal(section(k, "HERO").status, "READY");
  assert.deepEqual(section(k, "HERO").items.map((i) => i.text), ["מאפיית השקמה", "מאפייה שכונתית"]);
  assert.equal(section(k, "CONTACT").items.length, 0);
  assert.equal(section(k, "CONTACT").awaitingApproval, 1);
  assert.ok(!JSON.stringify(k.preview).includes("03-1111111"));
});

check("preview: an approved differentiator that reads like a trust claim is held back", () => {
  const k = buildLandingKnowledge(ctxFor({ statements: [{ dimension: "DIFFERENTIATOR", text: "הכי טובים בעיר", publicUseApproved: true }] }));
  assert.equal(section(k, "DIFFERENTIATORS").items.length, 0);
});

check("preview: an internal trust claim is pending; an approved one shows its server wording", () => {
  const internal = buildLandingKnowledge(ctxFor({ claims: [claimRow("FOUNDED_YEAR", { foundedYear: 2010 }, false)] }));
  assert.equal(section(internal, "TRUST").status, "NEEDS_APPROVAL");
  assert.equal(section(internal, "TRUST").items.length, 0);
  const approved = buildLandingKnowledge(ctxFor({ claims: [claimRow("FOUNDED_YEAR", { foundedYear: 2010 }, true)] }));
  assert.equal(section(approved, "TRUST").status, "READY");
  assert.ok(section(approved, "TRUST").items[0].text.includes("2010"));
});

check("preview: every shown item is one of context.publicUse's values — nothing else", () => {
  const ctx = ctxFor({
    category: "Food",
    statements: [
      { dimension: "DESCRIPTION", text: "תיאור", publicUseApproved: true },
      { dimension: "SPECIALIZATION", text: "לחם מחמצת", publicUseApproved: true },
      { dimension: "SERVICE_AREA", text: "חיפה" },
      { dimension: "PRIMARY_OBJECTIVE", code: "CALL" },
    ],
    facts: [
      { fact: "BUSINESS_NAME", value: "שם", authority: "PUBLIC" },
      { fact: "PUBLIC_PHONE", value: "03-5550000", authority: "PUBLIC" },
    ],
    claims: [claimRow("FOUNDED_YEAR", { foundedYear: 2010 }, true)],
  });
  const allowed = new Set<string>([
    ...ctx.publicUse.facts.map((f) => f.value),
    ...ctx.publicUse.statements.map((s) => s.value),
    ...ctx.publicUse.trustClaims.map((c) => c.wording),
  ]);
  for (const sec of buildLandingKnowledge(ctx).preview.sections) {
    for (const item of sec.items) {
      if (item.source === "CONVERSION") continue;
      assert.ok(allowed.has(item.text), `${sec.role} showed "${item.text}"`);
    }
  }
});

check("preview: the call to action exists only for a usable primary path", () => {
  const none = buildLandingKnowledge(ctxFor({ statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "CALL" }] }));
  assert.equal(section(none, "CALL_TO_ACTION").items.length, 0);
  const usable = buildLandingKnowledge(
    ctxFor({ statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "CALL" }], facts: [{ fact: "PUBLIC_PHONE", value: "03-5550000", authority: "PUBLIC" }] }),
  );
  assert.equal(section(usable, "CALL_TO_ACTION").status, "READY");
});

/* 4 · learned = supported deterministic signals, minus what the owner adopted */
check("learned: a supported signal offers its suggestion; once adopted it is gone", () => {
  const bot = { tone: "friendly", audienceTags: [], priorities: [] };
  const offered = buildLandingKnowledge(ctxFor({ evidence: { bot } }));
  assert.ok(offered.learned.suggestions.some((g) => g.dimension === "TONE" && g.code === "WARM"));
  const adopted = buildLandingKnowledge(ctxFor({ evidence: { bot }, statements: [{ dimension: "TONE", code: "WARM" }] }));
  assert.ok(!adopted.learned.suggestions.some((g) => g.dimension === "TONE" && g.code === "WARM"));
});

check("learned: insufficient evidence produces nothing", () => {
  const k = buildLandingKnowledge(ctxFor({ evidence: { variantSelections: ["a"] } }));
  assert.equal(k.learned.suggestions.length + k.learned.observations.length, 0);
});

/* 5 · the screen: existing endpoints only, no score */
check("the screen writes only through the existing identity / trust endpoints", () => {
  const api = fs.readFileSync("components/business/identity/landing/identity-api.ts", "utf8");
  const urls = [...api.matchAll(/fetch\(\s*[`"]([^`"]+)[`"]/g)].map((m) => m[1].replace(/\$\{[^}]+\}/g, ":id"));
  const allowed = new Set([
    "/api/business/identity-context",
    "/api/business/identity",
    "/api/business/identity/:id",
    "/api/business/identity/facts",
    "/api/business/identity/suggestions",
    "/api/business/trust-claims",
    "/api/business/trust-claims/:id",
    "/api/business/trust-claims/:id/document",
  ]);
  assert.ok(urls.length >= 8);
  for (const u of urls) assert.ok(allowed.has(u), `unexpected endpoint ${u}`);
});

check("no percentage, AI score or 'published' claim on the screen", () => {
  const files = ["IdentityScreen.tsx", "panels.tsx", "chapters.tsx", "controls.tsx"].map((f) =>
    fs.readFileSync(`components/business/identity/landing/${f}`, "utf8"),
  );
  for (const src of files) {
    assert.ok(!/\d+%|percent/.test(src), "a percentage is rendered");
    assert.ok(!/פורסם בהצלחה|הדף שלך באוויר|ציון/.test(src), "claims publishing or a score");
  }
  assert.ok(files.join("").includes("לא פורסם"));
});

console.log(`\nLANDING KNOWLEDGE VERIFY PASS — ${passed} checks green.`);
