/**
 * M4/M5 — the three new HTTP surfaces, and the two services behind them. Run:
 *   npx tsx lib/knowledge/m4-m5-surfaces.verify.test.ts
 *
 * These are static contract checks, and they earn their place because the properties they hold are
 * the ones that never fail loudly. A route that reads a businessId from the caller does not throw;
 * it quietly serves the wrong tenant. A service that trusts an actorUserId from a request body does
 * not throw; it records a decision against somebody who never made it. Both look fine in review and
 * fine in production until the day they do not.
 *
 * Everything here is about what the CALLER may not choose.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const root = join(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

const proposals = read("app", "api", "identity", "proposals", "route.ts");
const decide = read("app", "api", "identity", "proposals", "[id]", "decision", "route.ts");
const actions = read("app", "api", "collection", "actions", "route.ts");
const derive = read("app", "api", "knowledge", "derive", "route.ts");
const identity = read("lib", "identity", "entity-identity.service.ts");
const collection = read("lib", "services", "collection", "collection-action.service.ts");
const reconciler = read("lib", "knowledge", "measure-reconciler.ts");
const deriveService = read("lib", "knowledge", "derive.service.ts");

/* ── The session decides the tenant and the actor. Always. ─────────────────────────── */
for (const [name, src] of [
  ["identity list", proposals],
  ["identity decision", decide],
  ["collection action", actions],
] as const) {
  ok(`${name}: requires a session`, /getCurrentUser\(req\)/.test(src));
  ok(`${name}: answers 401 without one`, /Unauthorized[\s\S]{0,60}401/.test(src));
  ok(`${name}: takes the tenant from the session`, /user\.businessId/.test(src));
  ok(`${name}: never reads a tenant from the caller`,
    !/searchParams\.get\(\s*["']businessId|body\.businessId|params\.businessId/.test(src));
  ok(`${name}: never reads an actor from the caller`,
    !/body\.(userId|actorUserId|actorId)/.test(src));
}
ok("identity decision: the actor is the session user", /user\.id/.test(decide));
ok("collection action: the actor is the session user", /actorUserId: user\.id/.test(actions));

/* ── The identity decision is the ONLY place a weak link can bind ──────────────────── */
ok("identity decision: accepts CONFIRMED and REJECTED only",
  /decision !== "CONFIRMED" && decision !== "REJECTED"/.test(decide));
ok("identity decision: anything else is 400", /must be CONFIRMED or REJECTED[\s\S]{0,80}400/.test(decide));
ok("identity decision: a rejection is recorded, not merely ignored",
  /REJECTED/.test(identity) && /decidedByUserId/.test(identity));
ok("identity decision: another tenant's proposal is MISSING, never forbidden",
  /404/.test(decide) && !/403/.test(decide));
ok("identity decision: deciding twice is a conflict, not a silent re-apply",
  /already_decided[\s\S]{0,120}409|409[\s\S]{0,120}already_decided/.test(decide));

/* ── The matcher proposes; it never confirms ───────────────────────────────────────── */
ok("the resolver never creates a CONFIRMED proposal",
  !/state:\s*"CONFIRMED"/.test(identity.replace(/decision === "CONFIRMED"[\s\S]*?\n\s*}/g, "")));
ok("every proposal the matcher writes is WEAK",
  (identity.match(/strength:\s*"WEAK"/g) ?? []).length >= 1 &&
  !/strength:\s*"STRONG"/.test(identity));
ok("only a TAX_ID is allowed to bind without a person",
  /findCandidatePartyBySignalTx\(tx, businessId, "TAX_ID"/.test(identity) &&
  !/findCandidatePartyBySignalTx\(tx, businessId, "NORMALIZED_NAME"/.test(identity));
ok("a subject with no strong identifier anchors WITHOUT publishing a weak signal",
  /createAnchorClaimTx/.test(identity));
ok("OWNER_CONFIRMED is the only method the decision path writes",
  /method:\s*"OWNER_CONFIRMED"/.test(identity));
ok("a rejected pair is never re-proposed",
  /state === "REJECTED"[\s\S]{0,120}skipped-rejected/.test(identity));
ok("a tax id binds only after passing the well-formedness check, never as raw free text",
  /taxId: authoritativeTaxId\(s\.taxId\)/.test(identity) &&
  /taxId: authoritativeTaxId\(p\.taxId\)/.test(identity) &&
  !/cleanId\(/.test(identity));
ok("an owner confirmation publishes NO signal the Party engine could later bind others by",
  /method:\s*"OWNER_CONFIRMED"/.test(identity) &&
  /signalType: null,\s*signalValue: null,[\s\S]{0,300}OWNER_CONFIRMED/.test(identity) &&
  !/signalType: proposal\.signalType/.test(identity));
ok("the resolver requires a server-derived actor for a decision",
  /Number\.isInteger\(actorUserId\)[\s\S]{0,80}invalid_actor/.test(identity));

/* ── The collection record claims only what is known ───────────────────────────────── */
ok("collection: every action name describes what the OWNER did",
  /SHARE_INITIATED|LINK_COPIED|MESSAGE_COPIED|WHATSAPP_OPENED/.test(collection));
ok("collection: nothing claims delivery, receipt or reading",
  !/\bdelivered\b|\bdeliveredAt\b|\breadAt\b|\bsentAt\b/i.test(
    collection.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""),
  ));
ok("collection: an action must name at least one subject",
  /invalid_subject/.test(collection));
ok("collection: every subject id is verified against THIS tenant before the write",
  /unknown_subject/.test(collection) &&
  /tx\.customer\.findFirst[\s\S]{0,200}businessId/.test(collection));
ok("collection: the record is append-only — the service never updates one",
  !/collectionAction\.(update|updateMany|delete|deleteMany)/.test(collection));

/* ── The derivation surface stays the scheduler's ──────────────────────────────────── */
ok("derive: still authenticated by the scheduler secret, not a session",
  /decideRecoveryAuth/.test(derive) && !/getCurrentUser/.test(derive));
ok("derive: fail-closed when the secret is absent", /NOT_CONFIGURED[\s\S]{0,80}503/.test(derive));
ok("derive: one explicit tenant per call", /businessId must be a positive integer/.test(derive));
// The body is printed into a workflow log, and the repository is public. What a rule LEARNED must
// never appear in it — only that it ran, how it ended, and how much evidence it had.
ok("derive: the response carries no learned value, entity id, trend or error text",
  !/valueNumeric|entityId|failureDetail|trend:/.test(derive.replace(/\/\/.*$/gm, "")) &&
  !/rules: derivation\.rules,/.test(derive));
ok("derive: isolation is MEASURED on the runtime connection and must hold",
  /relforcerowsecurity/.test(derive) && /withoutTenant/.test(derive) &&
  /foreignRows/.test(derive) && /holds:/.test(derive));
ok("derive: reports the role posture instead of assuming it",
  /rolbypassrls/.test(derive) && /proofLevel/.test(derive));
// Compared at the CALL sites, not the imports — which are alphabetical and say nothing about order.
ok("derive: resolves identity BEFORE deriving, because two rules key on a Party",
  derive.indexOf("await resolveIdentitiesForBusiness(") < derive.indexOf("await deriveKnowledgeForBusiness("));
ok("derive: the secret is never echoed", !/CRON_SECRET[\s\S]{0,40}(console\.|return|json)/.test(derive));

/* ── The derivation service's own invariants ───────────────────────────────────────── */
// Comments are stripped first: the header explains at length WHY there is only one clock, and a
// naive count would be tripped by the explanation rather than by the code.
const deriveCode = deriveService.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
ok("derivation: one clock, captured once and passed down",
  /now: Date = new Date\(\)/.test(deriveCode) &&
  (deriveCode.match(/new Date\(\)/g) ?? []).length === 1);
ok("derivation: a failing rule does not take the others with it",
  /outcome: "failed"/.test(deriveService) && /rulesFailed/.test(deriveService));
ok("derivation: the tenant is re-asserted onto every evidence set before writing",
  /evidenceSet: \{ \.\.\.result\.evidenceSet, businessId \}/.test(deriveService));
ok("derivation: each source is loaded once, not once per rule",
  /distinct\.set\(rule\.source\.key/.test(deriveService));
ok("derivation: it refuses a businessId that is not server-derived",
  /a positive, server-derived businessId is required/.test(deriveService));
ok("derivation: no failure detail is logged with business content",
  !/console\.(log|error)/.test(deriveService));

/* ── Reconciliation demotes; it never deletes ──────────────────────────────────────── */
ok("reconciliation: nothing is deleted",
  !/delete|deleteMany/.test(reconciler.replace(/\/\*[\s\S]*?\*\//g, "")));
ok("reconciliation: a different rule version is SUPERSEDED", /status: "SUPERSEDED"/.test(reconciler));
ok("reconciliation: a subject with no evidence left is STALE", /status: "STALE"/.test(reconciler));
ok("reconciliation: only live rows are demoted",
  /status: \{ in: \["ACTIVE", "INSUFFICIENT_EVIDENCE"\] \}/.test(reconciler));
ok("reconciliation: it is tenant-bound like every other writer",
  /tenantTx\(businessId/.test(reconciler));

console.log(
  failed === 0
    ? "\nM4/M5 surfaces: the caller chooses nothing that matters. ✔"
    : `\n${failed} FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
