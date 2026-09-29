/**
 * Production RLS evidence through the APPLICATION'S OWN runtime identity.
 * SCRIPT-ONLY, READ-ONLY, counts only.
 *
 *   OWNER_DATABASE_URL=… RUNTIME_DATABASE_URL=… npx tsx scripts/ops/runtime-rls-evidence.ts \
 *     --expected-runtime-user app_runtime_prod --allow-host ep-flat-brook-am4bhq1y
 *
 * Two connections, two identities, never mixed:
 *
 *   OWNER   (OWNER_DATABASE_URL — the evidence owner login)
 *           catalog facts only: which OTHER business to probe (an id, nothing
 *           more), how many rows tenant 38 owns (for the positive counter-check),
 *           the runtime role's catalog facts, and the Installment sequence
 *           uniqueness proven from pg_index by index identity.
 *
 *   RUNTIME (RUNTIME_DATABASE_URL — authenticated DIRECTLY as the runtime login,
 *           e.g. app_runtime_prod; no SET ROLE anywhere)
 *           the isolation probe: tenant 38's context, another business's
 *           context, and no context — counts only.
 *
 * Fail closed, in this order, before any tenant probe:
 *   1. the runtime URL is missing, pooled, or not the allow-listed host → REFUSED
 *   2. the session is not read-only by Postgres (default_transaction_read_only
 *      must be `on` after SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY,
 *      on a single connection) → REFUSED
 *   3. the connected user is not exactly the expected runtime login, is a
 *      superuser, has BYPASSRLS, or is not a member of app_runtime → REFUSED
 * Then any cross-tenant or no-context visibility > 0 → FAIL.
 *
 * Exit codes: 0 PASS · 1 FAIL (isolation) · 3 REFUSED (precondition) · 2 usage.
 * Output: counts, booleans and business ids only. Credentials are never printed.
 */
import { PrismaClient } from "@prisma/client";

export const QA_BUSINESS_ID = 38;
const QA_MARKER = "QA-P2";

export class RefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedError";
  }
}

/** Precondition 1 — refuse before connecting. Never echoes the URL. */
export function assertSafeUrl(label: string, raw: string | undefined, allowHost: string | null): string {
  if (!raw || raw.trim() === "") throw new RefusedError(`${label} is not configured — the probe cannot run (NOT a pass)`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RefusedError(`${label} is not a valid connection URL`);
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new RefusedError(`${label} is not a Postgres URL`);
  if (/-pooler\./i.test(url.hostname) || url.searchParams.get("pgbouncer") === "true") {
    throw new RefusedError(`${label} is a pooled connection — tenant session context is not reliable through a pooler; a direct URL is required`);
  }
  if (allowHost && !url.hostname.includes(allowHost)) {
    throw new RefusedError(`${label} does not target the verified Production endpoint`);
  }
  url.searchParams.set("connection_limit", "1");
  return url.toString();
}

type Db = PrismaClient;

/** Precondition 2 — the session is read-only BY POSTGRES, verified. */
export async function enforceReadOnly(db: Db, label: string): Promise<void> {
  await db.$executeRawUnsafe("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  await verifyReadOnly(db, label);
}
export async function verifyReadOnly(db: Db, label: string): Promise<void> {
  const [r] = await db.$queryRawUnsafe<Array<{ default_transaction_read_only: string }>>("SHOW default_transaction_read_only");
  if (r?.default_transaction_read_only !== "on") {
    throw new RefusedError(`${label} session is not read-only (default_transaction_read_only=${r?.default_transaction_read_only})`);
  }
}

export type RuntimeIdentity = { user: string; superuser: boolean; bypassRls: boolean; memberOfAppRuntime: boolean };

/** Precondition 3 — exactly the expected runtime login, unable to bypass RLS. */
export async function verifyRuntimeIdentity(db: Db, expectedUser: string): Promise<RuntimeIdentity> {
  const [r] = await db.$queryRawUnsafe<Array<{ usr: string; sup: boolean; byp: boolean; member: boolean }>>(
    `SELECT current_user AS usr, r.rolsuper AS sup, r.rolbypassrls AS byp,
            pg_has_role(current_user, 'app_runtime', 'MEMBER') AS member
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const id: RuntimeIdentity = { user: r.usr, superuser: r.sup, bypassRls: r.byp, memberOfAppRuntime: r.member };
  if (id.user !== expectedUser) throw new RefusedError(`connected as ${id.user}, expected ${expectedUser} — refusing to probe under the wrong identity`);
  if (id.superuser) throw new RefusedError(`${id.user} is a superuser — it bypasses RLS; refusing`);
  if (id.bypassRls) throw new RefusedError(`${id.user} has BYPASSRLS — an isolation probe would be meaningless; refusing`);
  if (!id.memberOfAppRuntime) throw new RefusedError(`${id.user} is not a member of app_runtime — not the application's runtime identity; refusing`);
  return id;
}

export type OwnerFacts = {
  probeOtherBusinessId: number;
  own38Commitments: number;
  own38QaP2Commitments: number;
  runtimeRoleCatalog: { exists: boolean; canLogin: boolean; bypassRls: boolean; memberOfAppRuntime: boolean };
  installmentSequenceUnique: { index: string; exists: boolean; unique: boolean; table: string | null; columns: string[] };
};

/** Owner side: catalog facts and ids only. */
export async function ownerFacts(db: Db, runtimeUser: string): Promise<OwnerFacts> {
  const [b] = await db.$queryRawUnsafe<Array<{ id: number | null }>>(
    `SELECT min("id")::int AS id FROM "Business" WHERE "id" <> ${QA_BUSINESS_ID}`,
  );
  if (b?.id == null) throw new RefusedError("no second business exists to probe against");
  const [own] = await db.$queryRawUnsafe<Array<{ all: bigint; qa: bigint }>>(
    `SELECT (SELECT count(*) FROM "Commitment" WHERE "businessId" = ${QA_BUSINESS_ID}) AS "all",
            (SELECT count(*) FROM "Commitment" WHERE "businessId" = ${QA_BUSINESS_ID} AND "title" LIKE '${QA_MARKER}%') AS qa`,
  );
  const [role] = await db.$queryRawUnsafe<Array<{ ex: boolean; login: boolean | null; byp: boolean | null; member: boolean | null }>>(
    `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS ex,
            (SELECT rolcanlogin FROM pg_roles WHERE rolname = $1) AS login,
            (SELECT rolbypassrls FROM pg_roles WHERE rolname = $1) AS byp,
            CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)
                 THEN pg_has_role($1, 'app_runtime', 'MEMBER') END AS member`,
    runtimeUser,
  );
  // Uniqueness by index IDENTITY: the named index, its UNIQUE flag, its table,
  // and its key columns in order — read from pg_index / pg_attribute, not text.
  const idx = await db.$queryRawUnsafe<Array<{ uniq: boolean; tbl: string; cols: string[] }>>(
    `SELECT i.indisunique AS uniq, t.relname AS tbl,
            array_agg(a.attname::text ORDER BY k.ord) AS cols
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE c.relname = 'Installment_commitmentId_sequence_key' AND c.relkind = 'i'
      GROUP BY i.indisunique, t.relname`,
  );
  return {
    probeOtherBusinessId: b.id,
    own38Commitments: Number(own.all),
    own38QaP2Commitments: Number(own.qa),
    runtimeRoleCatalog: { exists: role.ex, canLogin: !!role.login, bypassRls: !!role.byp, memberOfAppRuntime: !!role.member },
    installmentSequenceUnique: {
      index: "Installment_commitmentId_sequence_key",
      exists: idx.length === 1,
      unique: idx[0]?.uniq ?? false,
      table: idx[0]?.tbl ?? null,
      columns: idx[0]?.cols ?? [],
    },
  };
}

export type ProbeResult = {
  identity: RuntimeIdentity;
  in38: { qaP2Visible: number; ownCommitmentsVisible: number; otherCommitments: number; otherInstallments: number; otherPayments: number; otherWorkflow: number };
  inOther: { commitments38: number; installments38: number; workflow38: number; payments38: number; allocations38: number };
  noContext: { commitments: number; payments: number };
};

const n = (v: bigint | number) => Number(v);

/** Runtime side: the isolation probe. Counts only; session-level tenant GUC. */
export async function runtimeProbe(db: Db, expectedUser: string, probeOtherBusinessId: number): Promise<ProbeResult> {
  const identity = await verifyRuntimeIdentity(db, expectedUser);
  const context = (id: string) => db.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, false)`, id);

  await context(String(QA_BUSINESS_ID));
  const [a] = await db.$queryRawUnsafe<Array<Record<string, bigint>>>(`
    SELECT (SELECT count(*) FROM "Commitment" WHERE "title" LIKE '${QA_MARKER}%')           AS qa,
           (SELECT count(*) FROM "Commitment")                                            AS own,
           (SELECT count(*) FROM "Commitment" WHERE "businessId" <> ${QA_BUSINESS_ID})          AS c,
           (SELECT count(*) FROM "Installment" WHERE "businessId" <> ${QA_BUSINESS_ID})         AS i,
           (SELECT count(*) FROM "Payment" WHERE "businessId" <> ${QA_BUSINESS_ID})             AS p,
           (SELECT count(*) FROM "InstallmentWorkflow" WHERE "businessId" <> ${QA_BUSINESS_ID}) AS w`);

  await context(String(probeOtherBusinessId));
  const [o] = await db.$queryRawUnsafe<Array<Record<string, bigint>>>(`
    SELECT (SELECT count(*) FROM "Commitment" WHERE "businessId" = ${QA_BUSINESS_ID})          AS c,
           (SELECT count(*) FROM "Installment" WHERE "businessId" = ${QA_BUSINESS_ID})         AS i,
           (SELECT count(*) FROM "InstallmentWorkflow" WHERE "businessId" = ${QA_BUSINESS_ID}) AS w,
           (SELECT count(*) FROM "Payment" WHERE "businessId" = ${QA_BUSINESS_ID})             AS p,
           (SELECT count(*) FROM "PaymentAllocation" WHERE "businessId" = ${QA_BUSINESS_ID})   AS a`);

  await context("");
  const [z] = await db.$queryRawUnsafe<Array<Record<string, bigint>>>(`
    SELECT (SELECT count(*) FROM "Commitment") AS c, (SELECT count(*) FROM "Payment") AS p`);

  await verifyReadOnly(db, "runtime");
  return {
    identity,
    in38: { qaP2Visible: n(a.qa), ownCommitmentsVisible: n(a.own), otherCommitments: n(a.c), otherInstallments: n(a.i), otherPayments: n(a.p), otherWorkflow: n(a.w) },
    inOther: { commitments38: n(o.c), installments38: n(o.i), workflow38: n(o.w), payments38: n(o.p), allocations38: n(o.a) },
    noContext: { commitments: n(z.c), payments: n(z.p) },
  };
}

/** Verdict from owner facts + runtime probe. Pure. */
export function verdict(owner: OwnerFacts, probe: ProbeResult): { pass: boolean; failures: string[]; positiveCheck: string } {
  const failures: string[] = [];
  const zero = (label: string, v: number) => v !== 0 && failures.push(`${label} = ${v}`);
  zero("38→other commitments", probe.in38.otherCommitments);
  zero("38→other installments", probe.in38.otherInstallments);
  zero("38→other payments", probe.in38.otherPayments);
  zero("38→other workflow", probe.in38.otherWorkflow);
  zero("other→38 commitments", probe.inOther.commitments38);
  zero("other→38 installments", probe.inOther.installments38);
  zero("other→38 workflow", probe.inOther.workflow38);
  zero("other→38 payments", probe.inOther.payments38);
  zero("other→38 allocations", probe.inOther.allocations38);
  zero("no-context commitments", probe.noContext.commitments);
  zero("no-context payments", probe.noContext.payments);
  let positiveCheck: string;
  if (owner.own38QaP2Commitments > 0) {
    positiveCheck = `QA-P2 rows visible to 38: ${probe.in38.qaP2Visible} of ${owner.own38QaP2Commitments}`;
    if (probe.in38.qaP2Visible !== owner.own38QaP2Commitments) failures.push(positiveCheck);
  } else if (owner.own38Commitments > 0) {
    positiveCheck = `QA-P2 counter-check NOT YET AVAILABLE; business 38's own commitments visible to 38: ${probe.in38.ownCommitmentsVisible} of ${owner.own38Commitments}`;
    if (probe.in38.ownCommitmentsVisible !== owner.own38Commitments) failures.push(positiveCheck);
  } else {
    positiveCheck = "POSITIVE COUNTER-CHECK NOT YET AVAILABLE (business 38 owns no commitment rows)";
  }
  if (!owner.installmentSequenceUnique.exists || !owner.installmentSequenceUnique.unique ||
      owner.installmentSequenceUnique.table !== "Installment" ||
      JSON.stringify(owner.installmentSequenceUnique.columns) !== JSON.stringify(["commitmentId", "sequence"])) {
    failures.push(`Installment sequence uniqueness not established: ${JSON.stringify(owner.installmentSequenceUnique)}`);
  }
  return { pass: failures.length === 0, failures, positiveCheck };
}

function arg(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] ?? null : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const expected = arg(argv, "--expected-runtime-user");
  const allowHost = arg(argv, "--allow-host");
  if (!expected) {
    console.error("--expected-runtime-user is required");
    process.exit(2);
  }
  let owner: Db | null = null;
  let runtime: Db | null = null;
  try {
    // 1 · refuse unsafe URLs before any connection
    const ownerUrl = assertSafeUrl("OWNER_DATABASE_URL", process.env.OWNER_DATABASE_URL, allowHost);
    const runtimeUrl = assertSafeUrl("RUNTIME_DATABASE_URL", process.env.RUNTIME_DATABASE_URL, allowHost);
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    runtime = new PrismaClient({ datasourceUrl: runtimeUrl });
    // 2 · read-only by Postgres, on both sessions
    await enforceReadOnly(owner, "owner");
    await enforceReadOnly(runtime, "runtime");
    console.log("read-only: owner on · runtime on");
    // owner-side facts (ids and counts only)
    const facts = await ownerFacts(owner, expected);
    console.log(JSON.stringify({ ownerFacts: facts }));
    // 3 · identity, then the probe
    const probe = await runtimeProbe(runtime, expected, facts.probeOtherBusinessId);
    const v = verdict(facts, probe);
    console.log(JSON.stringify({ runtimeProbe: probe, positiveCheck: v.positiveCheck, verdict: v.pass ? "PASS" : "FAIL", failures: v.failures }, null, 2));
    process.exitCode = v.pass ? 0 : 1;
  } catch (e) {
    if (e instanceof RefusedError) {
      console.error(`REFUSED: ${e.message}`);
      process.exitCode = 3;
    } else {
      // Never print a connection string: Prisma errors can echo the URL.
      console.error(`ERROR: ${(e as Error).name}: ${String((e as Error).message).replace(/postgres(ql)?:\/\/\S+/g, "postgresql://***")}`);
      process.exitCode = 1;
    }
  } finally {
    await owner?.$disconnect();
    await runtime?.$disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/ops/runtime-rls-evidence.ts")) {
  void main();
}
