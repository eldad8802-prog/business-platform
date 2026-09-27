/**
 * SEC-F code battery — the REAL services and the REAL login route against a
 * FRESH lab with the SEC-F migration applied, as the NOBYPASSRLS non-owner
 * runtime role:
 *
 *   SECF_SUPER_URL=postgresql://<super>@127.0.0.1:<port>/postgres npx tsx .secf/code-battery.ts
 *
 *   K-*  keyed audit chain: billing + payables writers chain their rows; eight
 *        concurrent writes of one business serialise into one linear chain; the
 *        verifier passes the clean chain and flags a modification, a deletion
 *        and a reordering made with the owner (triggers dropped, i.e. the
 *        strongest attacker short of the key)
 *   S-*  the real /api/auth/login writes AUTH_LOGIN_FAILURE rows whose payload
 *        holds no email, no password, no token and no raw IP (keys asserted)
 *
 * Exit 0 all pass · 1 a control failed · 2 setup crash (never a pass).
 */
import { applyMigrationFile, freshLab, SECF_MIGRATION } from "./lab.mjs";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(id: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${id}`); }
  else { fail++; failures.push(id); console.log(`  [FAIL] ${id}${detail ? " — " + detail : ""}`); }
}
function code(e: unknown): string {
  const m = (e as { meta?: { code?: string } })?.meta?.code ?? /Code: `([0-9A-Z]{5})`|code: "([0-9A-Z]{5})"/.exec(String((e as Error)?.message))?.slice(1).find(Boolean);
  return m ?? `NOT_SQL:${String((e as Error)?.message ?? e).slice(0, 160)}`;
}

const EMAIL = "secf.owner@example.co.il";
const PASSWORD = "Correct-Horse-9!";
const WRONG = "Wrong-Password-1!";

async function main() {
  console.log("== phase 0: fresh lab + SEC-F migration ==");
  const lab = await freshLab();
  applyMigrationFile(SECF_MIGRATION, lab.ownerUrl);

  process.env.DATABASE_URL = lab.rtUrl; // lib/prisma = the restricted runtime
  process.env.AUTH_DATABASE_URL = lab.ownerUrl; // the auth plane's own grants are not under test here
  process.env.AUDIT_CHAIN_KEY = "5ecf".repeat(16); // synthetic 32-byte key
  process.env.AUDIT_CHAIN_KEY_ID = "lab1";
  process.env.SECURITY_EVENT_IP_KEY = "lab-ip-key-".repeat(4);
  process.env.RATE_LIMIT_BACKEND = "memory";
  process.env.AUTH_TOKEN_SECRET = "secf_lab_auth_secret_synthetic_0123456789";

  const { PrismaClient } = await import("@prisma/client");
  const owner = new PrismaClient({ datasourceUrl: lab.ownerUrl });
  const adm = new PrismaClient({ datasourceUrl: lab.admUrl });
  const { prisma } = await import("@/lib/prisma");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const { createBillingAuditEventTx } = await import("@/lib/services/billing/billing-audit.service");
  const { writeAudit } = await import("@/lib/services/payables/payables.service");
  const { verifyDatabase } = await import("../scripts/security/verify-audit-chain");
  const bcrypt = (await import("bcrypt")).default;

  const one = async <T>(sql: string, ...p: unknown[]) => ((await owner.$queryRawUnsafe(sql, ...p)) as T[])[0];
  const biz = (await one<{ id: number }>(`INSERT INTO "Business"("name","updatedAt") VALUES ('secf-code', now()) RETURNING id`)).id;
  const hash = await bcrypt.hash(PASSWORD, 4);
  const user = (await one<{ id: number }>(
    `INSERT INTO "User"("email","password","businessId","updatedAt") VALUES ($1,$2,$3, now()) RETURNING id`, EMAIL, hash, biz)).id;
  const doc = (await one<{ id: number }>(`INSERT INTO "BillingDocument"("businessId","documentType","updatedAt") VALUES ($1,'TAX_INVOICE', now()) RETURNING id`, biz)).id;

  // ── K: keyed chain through the real writers ────────────────────────────────
  console.log("== K: keyed audit chain (real writers, runtime role) ==");
  const billingEvent = (i: number) => tenantTx(biz, (tx) => createBillingAuditEventTx(tx, {
    businessId: biz, billingDocumentId: doc, actorUserId: user, eventType: "BILLING_DRAFT_HEADER_UPDATED",
    summary: `edit ${i}`, metadata: { i, total: `${i}.00`, when: new Date() },
  }));
  for (let i = 1; i <= 3; i++) await billingEvent(i);
  for (let i = 1; i <= 3; i++) {
    await tenantTx(biz, (tx) => writeAudit(tx, { businessId: biz, eventType: "COMMITMENT_UPDATED", summary: `p${i}`, actorUserId: user, commitmentId: i, metadata: { i } }));
  }
  const rowsB = (await owner.$queryRawUnsafe(`SELECT "chainSeq","prevHash","chainKeyId" FROM "BillingAuditEvent" WHERE "businessId"=$1 ORDER BY id`, biz)) as { chainSeq: number; prevHash: string; chainKeyId: string }[];
  ok("K-BILLING-CHAINED billing writer links every row (1..3, GENESIS first, key id stored)",
    rowsB.length === 3 && rowsB.map((r) => r.chainSeq).join(",") === "1,2,3" && rowsB[0].prevHash === "GENESIS" && rowsB.every((r) => r.chainKeyId === "lab1"), JSON.stringify(rowsB));
  const rowsP = (await owner.$queryRawUnsafe(`SELECT "chainSeq" FROM "PayablesAuditEvent" WHERE "businessId"=$1 ORDER BY id`, biz)) as { chainSeq: number }[];
  ok("K-PAYABLES-CHAINED payables writer links every row", rowsP.map((r) => r.chainSeq).join(",") === "1,2,3", JSON.stringify(rowsP));

  const conc = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => billingEvent(100 + i)));
  const concFailed = conc.filter((r) => r.status === "rejected").map((r) => code((r as PromiseRejectedResult).reason));
  ok("K-CONCURRENT eight concurrent writes of one business all succeed (advisory lock, no fork)", concFailed.length === 0, concFailed.join(","));
  const seqs = ((await owner.$queryRawUnsafe(`SELECT "chainSeq" FROM "BillingAuditEvent" WHERE "businessId"=$1 ORDER BY "chainSeq"`, biz)) as { chainSeq: number }[]).map((r) => r.chainSeq);
  ok("K-LINEAR the chain is 1..11 with no gap or duplicate", seqs.join(",") === Array.from({ length: 11 }, (_, i) => i + 1).join(","), seqs.join(","));

  try {
    await tenantTx(biz, (tx) => tx.billingAuditEvent.updateMany({ where: { businessId: biz }, data: { summary: "x" } }));
    ok("K-RT-UPDATE runtime rewrite through Prisma is refused (42501)", false, "no error");
  } catch (e) {
    ok("K-RT-UPDATE runtime rewrite through Prisma is refused (42501)", code(e) === "42501", code(e));
  }

  const clean = await verifyDatabase(owner, { businessId: biz });
  ok("K-VERIFY-CLEAN verifier passes both chains", clean.length === 2 && clean.every((r) => r.findings.length === 0 && r.chained > 0), JSON.stringify(clean.map((r) => [r.table, r.chained, r.findings])));

  // The strongest attacker without the key: the owner, triggers dropped.
  await owner.$executeRawUnsafe(`DROP TRIGGER secf_append_only ON "BillingAuditEvent"`);
  await owner.$executeRawUnsafe(`UPDATE "BillingAuditEvent" SET "summary"='tampered' WHERE "businessId"=$1 AND "chainSeq"=2`, biz);
  let r = (await verifyDatabase(owner, { businessId: biz, tables: ["BillingAuditEvent"] }))[0];
  ok("K-TAMPER-MODIFY verifier flags MAC_MISMATCH at seq 2", r.findings.some((f) => f.code === "MAC_MISMATCH" && f.chainSeq === 2), JSON.stringify(r.findings));
  await owner.$executeRawUnsafe(`DELETE FROM "BillingAuditEvent" WHERE "businessId"=$1 AND "chainSeq"=5`, biz);
  r = (await verifyDatabase(owner, { businessId: biz, tables: ["BillingAuditEvent"] }))[0];
  ok("K-TAMPER-DELETE verifier flags SEQ_GAP after seq 4", r.findings.some((f) => f.code === "SEQ_GAP" && f.chainSeq === 6), JSON.stringify(r.findings));
  await owner.$executeRawUnsafe(`UPDATE "BillingAuditEvent" SET "chainSeq" = -1 WHERE "businessId"=$1 AND "chainSeq"=7`, biz).catch(() => {});
  await owner.$executeRawUnsafe(`ALTER TABLE "BillingAuditEvent" DROP CONSTRAINT "BillingAuditEvent_chain_shape_chk"`);
  await owner.$executeRawUnsafe(`UPDATE "BillingAuditEvent" SET "chainSeq" = -1 WHERE "businessId"=$1 AND "chainSeq"=7`, biz);
  await owner.$executeRawUnsafe(`UPDATE "BillingAuditEvent" SET "chainSeq" = 7 WHERE "businessId"=$1 AND "chainSeq"=8`, biz);
  await owner.$executeRawUnsafe(`UPDATE "BillingAuditEvent" SET "chainSeq" = 8 WHERE "businessId"=$1 AND "chainSeq"=-1`, biz);
  r = (await verifyDatabase(owner, { businessId: biz, tables: ["BillingAuditEvent"] }))[0];
  ok("K-TAMPER-REORDER verifier flags the swapped pair", r.findings.some((f) => (f.code === "MAC_MISMATCH" || f.code === "PREV_MISMATCH") && (f.chainSeq === 7 || f.chainSeq === 8)), JSON.stringify(r.findings));
  ok("K-PAYABLES-UNTOUCHED the untampered payables chain still verifies",
    (await verifyDatabase(owner, { businessId: biz, tables: ["PayablesAuditEvent"] }))[0].findings.length === 0);

  // ── S: the real login route writes a PII-free security event ─────────────────
  console.log("== S: SecurityEvent from the real /api/auth/login ==");
  const { POST: login } = await import("../app/api/auth/login/route");
  const call = (email: string, password: string) => login(new Request("https://app.example/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify({ email, password }),
  }));
  const wrong = await call(EMAIL, WRONG);
  ok("S-LOGIN-401 wrong password is refused", wrong.status === 401, String(wrong.status));
  const unknown = await call("nobody@example.org", WRONG);
  ok("S-LOGIN-401-UNKNOWN unknown address is refused", unknown.status === 401, String(unknown.status));
  const events = (await adm.$queryRawUnsafe(`SELECT * FROM "SecurityEvent" WHERE "eventType"='AUTH_LOGIN_FAILURE' ORDER BY "occurredAt"`)) as Record<string, unknown>[];
  ok("S-LOGIN-FAILURE-RECORDED two AUTH_LOGIN_FAILURE rows written by the runtime", events.length === 2, `rows=${events.length}`);
  const known = events.find((e) => e.businessId === biz);
  // The route's failure helper is handed the business, not the user id (a refused
  // password is not yet an authenticated user) — asserted as it is.
  ok("S-ATTRIBUTED the known-user failure carries its business and a reason class only",
    !!known && known.userId === null && known.reasonClass === "invalid_credentials" && known.outcome === "FAILURE", JSON.stringify(known));
  ok("S-PREAUTH the unknown-address failure carries no tenant and no user",
    events.some((e) => e.businessId === null && e.userId === null));
  const keys = Object.keys(events[0] ?? {}).sort().join(",");
  ok("S-KEYS row columns are exactly the minimised set",
    keys === "actorKind,businessId,eventType,id,ipHash,metadata,occurredAt,outcome,reasonClass,route,userId", keys);
  const flat = JSON.stringify(events);
  ok("S-NO-PII no email, password, token or raw IP in any stored field",
    !flat.includes("@") && !flat.includes(PASSWORD) && !flat.includes(WRONG) && !flat.includes("203.0.113") && !/eyJ/.test(flat), flat.slice(0, 400));
  // recordLoginFailure is not handed the request (single-line instrumentation in a
  // route workstream B owns), so failures carry no network identity at all; never a raw one.
  ok("S-IPHASH network identity is absent or a keyed hash, never raw", events.every((e) => e.ipHash === null || /^[0-9a-f]{32}$/.test(String(e.ipHash))));
  try {
    await prisma.$queryRawUnsafe(`SELECT count(*) FROM "SecurityEvent"`);
    ok("S-RT-NO-READ the runtime cannot read security events", false, "read succeeded");
  } catch (e) {
    ok("S-RT-NO-READ the runtime cannot read security events", code(e) === "42501", code(e));
  }

  await owner.$disconnect(); await adm.$disconnect(); await prisma.$disconnect();
  console.log(`\nSEC-F code battery: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) { console.log(`FAILED: ${failures.join(" | ")}`); process.exit(1); }
  process.exit(0);
}

main().catch((e) => {
  console.log(`[SETUP-ERROR] ${String((e as Error)?.stack ?? e)}`);
  process.exit(2);
});
