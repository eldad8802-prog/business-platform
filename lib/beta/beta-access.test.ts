/**
 * Closed-beta access policy — pure proofs (no database, no network):
 *   npx tsx lib/beta/beta-access.test.ts
 *
 *   A. the switch: only "on" restricts; off never reads the enrollment; fail-closed only while on
 *   B. the decision table, and that it restricts — never grants
 *   C. the route gate: 403 FEATURE_COMING_SOON for exactly the gated capability of an enrolled business
 *   D. the issue pre-check: refuses EXACTLY the drafts the Tax Authority rules mark READY — it asks
 *      evaluateAuthorityReadinessAtIssue, it does not restate it — and nothing else, and never reads
 *      the draft when the business is not restricted
 *   E. invitation codes: bound to one address, constant-length, fail closed without a secret
 *   F. coverage: every route that STARTS a gated integration calls the gate with the right capability,
 *      and the privacy / read / disconnect / webhook routes do not
 */

import fs from "node:fs";
import path from "node:path";
import { BillingAuthoritySubmissionStatus, BillingDocumentType, CustomerTaxIdType, Prisma } from "@prisma/client";

import {
  BETA_GATED_CAPABILITIES,
  areBetaRestrictionsOn,
  decideBetaAccess,
  resolveBetaAccess,
  type BetaPolicyDeps,
} from "./beta-access-policy";
import {
  BETA_ALLOCATION_COMING_SOON_CODE,
  FEATURE_COMING_SOON_CODE,
  betaGate,
  betaIssueGate,
  type BetaIssueGateDeps,
  type IssueReadinessDraft,
} from "./beta-gate";
import { evaluateAuthorityReadinessAtIssue } from "@/lib/services/billing/authority/billing-authority-readiness";
import { INVITE_CODE_LENGTH, inviteCodeFor, parseSignupInvite } from "@/lib/auth/signup-invite";
import { parseBetaAccessResponse } from "./use-beta-access";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  - ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  - ${name}`);
  }
}

function policy(on: boolean, enrolled: boolean | Error): BetaPolicyDeps & { reads: number } {
  const deps = {
    reads: 0,
    restrictionsOn: () => on,
    isEnrolled: async () => {
      deps.reads += 1;
      if (enrolled instanceof Error) throw enrolled;
      return enrolled;
    },
  };
  return deps;
}

async function main(): Promise<void> {
  // ── A. the switch ────────────────────────────────────────────────────────
  ok("A1 'on' turns restrictions on", areBetaRestrictionsOn({ BETA_COHORT_RESTRICTIONS: "on" }));
  for (const v of [undefined, "", "off", "ON", "On", "true", "1", "yes", " on"]) {
    ok(`A2 ${JSON.stringify(v)} leaves them off`, !areBetaRestrictionsOn({ BETA_COHORT_RESTRICTIONS: v }));
  }
  {
    const d = policy(false, true);
    const a = await resolveBetaAccess(7, d);
    ok("A3 switch off: an ENROLLED business is not restricted", !a.restricted && BETA_GATED_CAPABILITIES.every((c) => !a.comingSoon[c]));
    ok("A4 switch off: the enrollment is never read (no database work at all)", d.reads === 0);
  }
  {
    const d = policy(false, new Error("db down"));
    const a = await resolveBetaAccess(7, d);
    ok("A5 switch off: even a broken database cannot restrict anyone", !a.restricted && d.reads === 0);
  }
  {
    const d = policy(true, new Error("db down"));
    const a = await resolveBetaAccess(7, d);
    ok("A6 switch on + enrollment unreadable: fail closed (restricted)", a.restricted && BETA_GATED_CAPABILITIES.every((c) => a.comingSoon[c]));
  }

  // ── B. decision table ────────────────────────────────────────────────────
  const table: Array<[boolean, boolean | "unknown", boolean]> = [
    [false, false, false],
    [false, true, false],
    [false, "unknown", false],
    [true, false, false],
    [true, true, true],
    [true, "unknown", true],
  ];
  for (const [on, enrolled, expected] of table) {
    const a = decideBetaAccess({ restrictionsOn: on, enrolled });
    ok(`B1 on=${on} enrolled=${enrolled} → restricted=${expected}`, a.restricted === expected);
    ok(`B2 on=${on} enrolled=${enrolled} → every capability ${expected ? "coming soon" : "open"}`,
      BETA_GATED_CAPABILITIES.every((c) => a.comingSoon[c] === expected));
  }
  ok("B3 the gated capabilities are exactly Meta WhatsApp, Meta lead ads, Tax Authority",
    JSON.stringify([...BETA_GATED_CAPABILITIES]) === JSON.stringify(["META_WHATSAPP", "META_LEAD_ADS", "TAX_AUTHORITY"]));
  {
    const a = decideBetaAccess({ restrictionsOn: false, enrolled: false });
    let threw = false;
    try {
      (a.comingSoon as Record<string, boolean>).META_WHATSAPP = true;
    } catch {
      threw = true;
    }
    ok("B4 the 'nobody restricted' answer is immutable (cannot be flipped by a caller)", threw || a.comingSoon.META_WHATSAPP === false);
  }

  // ── C. route gate ────────────────────────────────────────────────────────
  for (const cap of BETA_GATED_CAPABILITIES) {
    const refused = await betaGate(1, cap, policy(true, true));
    const body = refused ? await refused.json() : null;
    ok(`C1 ${cap}: enrolled + on → 403`, refused?.status === 403);
    ok(`C2 ${cap}: code FEATURE_COMING_SOON, names the capability, Hebrew message`,
      body?.code === FEATURE_COMING_SOON_CODE && body?.capability === cap && /בקרוב/.test(body?.error ?? ""));
    ok(`C3 ${cap}: not cached`, refused?.headers.get("cache-control") === "no-store");
    ok(`C4 ${cap}: not enrolled + on → proceed (null)`, (await betaGate(1, cap, policy(true, false))) === null);
    ok(`C5 ${cap}: enrolled + off → proceed (null)`, (await betaGate(1, cap, policy(false, true))) === null);
  }

  // ── D. issue pre-check ───────────────────────────────────────────────────
  const NOW = new Date("2026-10-11T10:00:00Z"); // threshold ₪5,000 from 2026-06-01
  const dec = (n: number) => new Prisma.Decimal(n);
  const base: IssueReadinessDraft = {
    documentType: BillingDocumentType.TAX_INVOICE,
    vatAmount: dec(1080),
    subtotalAmount: dec(6000),
    currency: "ILS",
    customerTaxId: "515555555",
    customerTaxIdType: CustomerTaxIdType.AUTHORIZED_DEALER,
  };
  function issueDeps(on: boolean, enrolled: boolean, draft: IssueReadinessDraft | null) {
    const p = policy(on, enrolled);
    const deps: BetaIssueGateDeps & { loads: number } = {
      ...p,
      loads: 0,
      loadDraft: async () => {
        deps.loads += 1;
        return draft;
      },
      now: () => NOW,
    };
    return deps;
  }
  {
    const r = await betaIssueGate(1, 10, issueDeps(true, true, base));
    const body = r ? await r.json() : null;
    ok("D1 beta + tax invoice that needs an allocation number → 409 before anything is written",
      r?.status === 409 && body?.code === BETA_ALLOCATION_COMING_SOON_CODE && /בקרוב/.test(body?.error ?? ""));
  }
  {
    const d = issueDeps(false, true, base);
    ok("D2 switch off: a qualifying invoice issues as before, the draft is not even read",
      (await betaIssueGate(1, 10, d)) === null && d.loads === 0);
  }
  {
    const d = issueDeps(true, false, base);
    ok("D3 not in the beta: a qualifying invoice issues as before, the draft is not even read",
      (await betaIssueGate(1, 10, d)) === null && d.loads === 0);
  }
  ok("D4 draft not found → proceed (the issue answers 404 itself)", (await betaIssueGate(1, 10, issueDeps(true, true, null))) === null);

  // The grid: the gate refuses iff the Tax Authority rules say READY — for every combination.
  const types = Object.values(BillingDocumentType);
  const taxIdTypes: Array<CustomerTaxIdType | null> = [null, ...Object.values(CustomerTaxIdType)];
  const subtotals = [0, 4999.99, 5000, 25000];
  const vats = [0, 900];
  const currencies = ["ILS", "USD"];
  const taxIds = [null, "", "515555555"];
  let gridCases = 0;
  let gridMismatch = 0;
  let refusedCount = 0;
  for (const documentType of types)
    for (const customerTaxIdType of taxIdTypes)
      for (const s of subtotals)
        for (const v of vats)
          for (const currency of currencies)
            for (const customerTaxId of taxIds) {
              const draft: IssueReadinessDraft = {
                documentType, customerTaxIdType, customerTaxId, currency,
                subtotalAmount: dec(s), vatAmount: dec(v),
              };
              const expectedReady =
                evaluateAuthorityReadinessAtIssue({ ...draft, invoiceDate: NOW }) === BillingAuthoritySubmissionStatus.READY;
              const refused = (await betaIssueGate(1, 10, issueDeps(true, true, draft))) !== null;
              gridCases += 1;
              if (refused) refusedCount += 1;
              if (refused !== expectedReady) gridMismatch += 1;
            }
  ok(`D5 over ${gridCases} drafts the pre-check refuses exactly the READY ones (mismatches: ${gridMismatch})`, gridMismatch === 0);
  ok(`D6 the grid exercises both outcomes (refused ${refusedCount}, issued ${gridCases - refusedCount})`,
    refusedCount > 0 && refusedCount < gridCases);
  for (const t of [BillingDocumentType.RECEIPT, BillingDocumentType.CREDIT_NOTE, BillingDocumentType.QUOTE]) {
    ok(`D7 beta: a ${t} is never refused, even with qualifying amounts`,
      (await betaIssueGate(1, 10, issueDeps(true, true, { ...base, documentType: t }))) === null);
  }
  ok("D8 beta: a tax invoice to a private customer issues (NOT_REQUIRED)",
    (await betaIssueGate(1, 10, issueDeps(true, true, { ...base, customerTaxIdType: CustomerTaxIdType.PRIVATE_ID }))) === null);
  ok("D9 beta: a tax invoice under the threshold issues",
    (await betaIssueGate(1, 10, issueDeps(true, true, { ...base, subtotalAmount: dec(4999.99) }))) === null);

  // ── E. invitation codes ──────────────────────────────────────────────────
  const SECRET = "x".repeat(40);
  const code = inviteCodeFor("Tester@Example.com", SECRET);
  const inv = parseSignupInvite(SECRET);
  ok("E1 code length is fixed", code.length === INVITE_CODE_LENGTH && /^[A-Za-z0-9_-]+$/.test(code));
  ok("E2 deterministic and case/space-insensitive on the address", code === inviteCodeFor("  tester@example.COM ", SECRET));
  ok("E3 verifies for its own address", inv.verify("tester@example.com", code));
  ok("E4 does not verify for another address", !inv.verify("other@example.com", code));
  ok("E5 malformed / non-string codes never verify",
    [undefined, null, 42, "", code + "x", code.slice(1), "!".repeat(INVITE_CODE_LENGTH)].every((c) => !inv.verify("tester@example.com", c)));
  ok("E6 no secret / short secret → not configured, nothing verifies",
    !parseSignupInvite(undefined).configured && !parseSignupInvite("short").configured &&
    !parseSignupInvite("y".repeat(31)).verify("tester@example.com", inviteCodeFor("tester@example.com", "y".repeat(31))));
  ok("E7 another secret yields another code", inviteCodeFor("tester@example.com", "z".repeat(40)) !== code);

  // ── client parse ─────────────────────────────────────────────────────────
  ok("G1 client: a malformed answer marks nothing coming soon",
    [null, {}, { comingSoon: "x" }, { comingSoon: { META_WHATSAPP: "true" } }].every((d) => {
      const c = parseBetaAccessResponse(d);
      return !c.META_WHATSAPP && !c.META_LEAD_ADS && !c.TAX_AUTHORITY;
    }));
  ok("G2 client: a true answer is honoured per capability",
    JSON.stringify(parseBetaAccessResponse({ comingSoon: { META_WHATSAPP: true, META_LEAD_ADS: false, TAX_AUTHORITY: true } })) ===
      JSON.stringify({ META_WHATSAPP: true, META_LEAD_ADS: false, TAX_AUTHORITY: true }));

  // ── F. coverage ──────────────────────────────────────────────────────────
  const ROOT = process.cwd();
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
  const GATED: Array<[string, string]> = [
    ["app/api/integrations/whatsapp/embedded-signup/route.ts", `betaGate(user.businessId, "META_WHATSAPP")`],
    ["app/api/integrations/acquisition/meta/pages/route.ts", `betaGate(businessId, "META_LEAD_ADS")`],
    ["app/api/integrations/acquisition/meta/connect/route.ts", `betaGate(businessId, "META_LEAD_ADS")`],
    ["app/api/taxes/oauth/connect/route.ts", `betaGate(user.businessId, "TAX_AUTHORITY")`],
    ["app/api/billing/documents/[id]/authority-decision/route.ts", `betaGate(user.businessId, "TAX_AUTHORITY")`],
    ["app/api/billing/documents/[id]/issue/route.ts", `betaIssueGate(user.businessId, billingDocumentId)`],
  ];
  for (const [file, call] of GATED) ok(`F1 gated: ${file}`, read(file).includes(call));

  // Every route that imports an integration START function must be in GATED (a new entry point fails here).
  const STARTERS = [
    "completeEmbeddedSignup", "exchangeLoginCode", "bindMetaPage",
    "resolveAuthorityOAuthStart", "executeAuthorityDecision", "issueBillingDocument",
  ];
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/^route\.tsx?$/.test(e.name)) routes.push(rel);
    }
  };
  walk("app");
  const gatedSet = new Set(GATED.map(([f]) => f));
  const ungatedStarters = routes.filter((r) => {
    const src = read(r);
    return STARTERS.some((fn) => new RegExp(`import[^;]*\\b${fn}\\b[^;]*;`, "s").test(src)) && !gatedSet.has(r);
  });
  ok(`F2 no route starts a gated integration without the gate (${routes.length} routes scanned; ungated: ${ungatedStarters.join(", ") || "none"})`,
    ungatedStarters.length === 0);

  const MUST_STAY_OPEN = [
    "app/api/integrations/whatsapp/connection/route.ts",
    "app/api/integrations/whatsapp/connection/disconnect/route.ts",
    "app/api/integrations/whatsapp/connection/meta-data/route.ts",
    "app/api/integrations/whatsapp/webhook/route.ts",
    "app/api/intake/acquisition/meta/route.ts",
    "app/api/integrations/acquisition/route.ts",
    "app/api/integrations/acquisition/[id]/route.ts",
    "app/api/taxes/oauth/callback/route.ts",
    "app/api/taxes/authority/status/route.ts",
    "app/api/message/route.ts",
  ];
  for (const file of MUST_STAY_OPEN) {
    const src = read(file);
    ok(`F3 not gated (read / privacy / disconnect / webhook): ${file}`, !/betaGate|betaIssueGate|beta-access-policy/.test(src));
  }
  ok("F4 the issue SERVICE and every Tax Authority module are untouched by the beta (no import of lib/beta)",
    !read("lib/services/billing/billing-issue.service.ts").includes("lib/beta") &&
      fs.readdirSync(path.join(ROOT, "lib/services/billing/authority")).every((f) => !read(`lib/services/billing/authority/${f}`).includes("lib/beta")));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
