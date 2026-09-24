/**
 * SEC-E — the mutation driver for the negative proofs (AD-2A style).
 *
 * Usage:  node .sec-e/mutate.mjs <ID>
 *
 * Every anchor must occur EXACTLY once, or this throws: a mutation that silently fails
 * to apply leaves the tree unchanged, and the "red" that follows would mean nothing.
 * It prints the files it changed; the workflow hashes them before and after, and
 * restores them with `git checkout` and a byte-identical sha256 check.
 *
 * This script only mutates. Restoring is the caller's job.
 */
import fs from "node:fs";

const JOB = "lib/services/account/erasure-job.ts";
const SVC = "lib/services/account/account-deletion.service.ts";
const ROUTE = "app/api/account/route.ts";
const AUTH = "lib/auth.ts";
const REFRESH = "lib/auth/refresh-session.ts";
const SESSIONS = "lib/auth/session-directory.ts";
const TX = "lib/tenant/transaction.ts";
const ADAPTER = "lib/services/account/account-deletion.prisma-store.ts";
const SCHEMA = "prisma/schema.prisma";

const touched = new Set();
function replaceOnce(file, anchor, replacement) {
  const text = fs.readFileSync(file, "utf8");
  const n = text.split(anchor).length - 1;
  if (n !== 1) throw new Error(`${file}: anchor must occur exactly once, found ${n}: ${JSON.stringify(anchor.slice(0, 90))}`);
  fs.writeFileSync(file, text.split(anchor).join(replacement));
  touched.add(file);
}
function insertPrismaField(model, line) {
  const text = fs.readFileSync(SCHEMA, "utf8");
  const re = new RegExp(`(^model ${model} \\{\\r?\\n)`, "m");
  if (!re.test(text)) throw new Error(`no model ${model} in the schema`);
  fs.writeFileSync(SCHEMA, text.replace(re, (m) => `${m}  ${line}\n`));
  touched.add(SCHEMA);
}

const GATE_OFF = () => {
  // The lifecycle gate, removed from BOTH places a pre-deletion credential is honoured.
  replaceOnce(AUTH, "    if (user.business && !acceptsNormalWrites(user.business)) {\n      return null;\n    }\n", "");
  replaceOnce(
    REFRESH,
    '    if (!user.business || !acceptsNormalWrites(user.business)) {\n      return { kind: "invalid", reason: "account_quarantined" };\n    }\n',
    ""
  );
};
const REVOKE_OFF = () => {
  replaceOnce(SESSIONS, "  const db = authDb();\n  const users = await db.user.updateMany({", "  const db = authDb();\n  if (Date.now() > 0) return { users: 0, sessions: 0 };\n  const users = await db.user.updateMany({");
  replaceOnce(SESSIONS, "  const secrets = await db.authSessionSecret.deleteMany({", "  if (Date.now() > 0) return { secrets: 0, sessions: 0 };\n  const secrets = await db.authSessionSecret.deleteMany({");
};

const MUTATIONS = {
  // H-5 — the sweeper finds nothing: a stranded business stays stranded.
  SWEEP_OFF: () => replaceOnce(JOB, "  const ids = await store.listStrandedErasures(batch * 5);", "  const ids: number[] = [];"),
  // H-5 — the route goes back to the pre-fix call: a failure after quarantine is a 500.
  ACCEPT_OFF: () => {
    replaceOnce(ROUTE, "  requestAccountDeletion,\n", "  deleteOwnBusinessAccount as requestAccountDeletion,\n");
  },
  // M-12(a) — the lifecycle gate removed. The PROOF expects this to stay GREEN for m12a:
  // revocation alone must reject a pre-deletion credential.
  GATE_OFF,
  // M-12(a) — gate removed AND revocation removed: now the credential must be accepted.
  GATE_AND_REVOKE_OFF: () => {
    GATE_OFF();
    REVOKE_OFF();
  },
  // M-12(c) — the in-transaction lifecycle gate removed from the tenant wrapper.
  INFLIGHT_OFF: () => replaceOnce(TX, "      await assertTenantTxAcceptsWrites(tx, businessId);\n", ""),
  // M-13 — the content-prefix erasure removed from the adapter.
  CONTENT_OFF: () => replaceOnce(ADAPTER, '        await deletePublicAssetsOfBusiness(businessId, "content");\n', ""),
  // M-12(b) — an exhausted revoke is reported as a provider-side revoke.
  TRUTH_OFF: () =>
    replaceOnce(JOB, 'await record({ ...base, outcome: "REVOKE_FAILED_LOCAL_DELETED", reason: safeCode(`retries_exhausted:', 'await record({ ...base, outcome: "REVOKED", reason: safeCode(`retries_exhausted:'),
  // M-12(b) — credentials destroyed BEFORE the provider revoke (the plaintext is gone).
  ORDER_OFF: () =>
    replaceOnce(JOB, '    stage = "PROVIDER_REVOKE";\n    await revokeProviderGrants(', '    await store.destroyIntegrationCredentials(businessId, now);\n    stage = "PROVIDER_REVOKE";\n    await revokeProviderGrants('),
  // M-13 / F-6 — a personal column added to indebted models (contract proofs).
  DEBT_SUPPLIER: () => insertPrismaField("Supplier", "nationalId String?"),
  DEBT_APPOINTMENT: () => insertPrismaField("Appointment", "nationalId String?"),
  // L-18 — the WhatsApp number is no longer released (contract proof).
  IDENT_OFF: () => replaceOnce(ADAPTER, "              phoneNumberId: `erased-${businessId}`,\n", ""),
  // C27 — the auth-plane session erasure is no longer called (contract proof).
  SESSIONS_OFF: () => replaceOnce(ADAPTER, "    await eraseSessionsOfBusinessUsers(businessId);\n", ""),
};

const id = process.argv[2];
if (!MUTATIONS[id]) {
  console.error(`usage: node .sec-e/mutate.mjs <${Object.keys(MUTATIONS).join("|")}>`);
  process.exit(2);
}
MUTATIONS[id]();
console.log(`[mutate] applied ${id} -> ${[...touched].join(" ")}`);
