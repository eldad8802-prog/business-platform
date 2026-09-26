/**
 * SEC-F — audit-chain verifier.
 *
 *   AUDIT_CHAIN_KEY=… [AUDIT_CHAIN_KEY_ID=k1] [AUDIT_CHAIN_RETIRED_KEYS=id:secret,…] \
 *   VERIFY_DATABASE_URL=postgresql://… npx tsx scripts/security/verify-audit-chain.ts [--business <id>] [--table <T>]
 *
 * Reads every row of BillingAuditEvent / PayablesAuditEvent / PaymentAuditEvent
 * (read-only), groups by business, and recomputes every link: HMAC, predecessor,
 * sequence continuity, key id, and unchained rows written after a chain began.
 * It detects modification, deletion, insertion and reordering of any row that
 * is not the chain's newest; tail truncation is caught only against a head
 * recorded outside the database, so the head of every chain is printed for an
 * operator to anchor.
 *
 * The connection must be able to read across tenants (the migration owner, or
 * a read-only role with BYPASSRLS). It never writes.
 *
 * Exit: 0 all chains verify · 1 at least one finding · 2 could not run.
 */
import { PrismaClient } from "@prisma/client";
import {
  loadAuditChainKeyring,
  verifyAuditChain,
  type AuditChainTable,
  type ChainReport,
  type StoredAuditRow,
} from "@/lib/audit/audit-chain";

const REFS: Record<AuditChainTable, string[]> = {
  BillingAuditEvent: ["billingDocumentId"],
  PayablesAuditEvent: ["allocationId", "commitmentId", "installmentId", "paymentId"],
  PaymentAuditEvent: ["paymentRequestId"],
};

type RawRow = Record<string, unknown>;

export function toStoredRow(table: AuditChainTable, r: RawRow): StoredAuditRow {
  const refs: Record<string, number | null> = {};
  for (const k of REFS[table]) refs[k] = r[k] === null || r[k] === undefined ? null : Number(r[k]);
  return {
    id: Number(r.id),
    businessId: Number(r.businessId),
    eventType: String(r.eventType),
    source: String(r.source),
    summary: String(r.summary),
    metadata: r.metadata ?? null,
    eventHash: String(r.eventHash),
    occurredAt: r.occurredAt instanceof Date ? r.occurredAt : new Date(String(r.occurredAt)),
    actorUserId: r.actorUserId === null || r.actorUserId === undefined ? null : Number(r.actorUserId),
    refs,
    chainSeq: r.chainSeq === null || r.chainSeq === undefined ? null : Number(r.chainSeq),
    prevHash: (r.prevHash as string | null) ?? null,
    chainHash: (r.chainHash as string | null) ?? null,
    chainKeyId: (r.chainKeyId as string | null) ?? null,
  };
}

export async function verifyDatabase(
  db: PrismaClient,
  opts: { tables?: AuditChainTable[]; businessId?: number } = {}
): Promise<ChainReport[]> {
  const keyring = loadAuditChainKeyring();
  const tables = opts.tables ?? (Object.keys(REFS) as AuditChainTable[]);
  const reports: ChainReport[] = [];
  for (const table of tables) {
    const where = opts.businessId ? `WHERE "businessId" = ${Number(opts.businessId)}` : "";
    const rows = (await db.$queryRawUnsafe(`SELECT * FROM "${table}" ${where} ORDER BY "businessId", "id"`)) as RawRow[];
    const byBiz = new Map<number, StoredAuditRow[]>();
    for (const r of rows) {
      const s = toStoredRow(table, r);
      if (!byBiz.has(s.businessId)) byBiz.set(s.businessId, []);
      byBiz.get(s.businessId)!.push(s);
    }
    for (const [biz, list] of byBiz) reports.push(verifyAuditChain(table, biz, list, keyring));
  }
  return reports;
}

async function main() {
  const url = process.env.VERIFY_DATABASE_URL;
  if (!url) {
    console.error("VERIFY_DATABASE_URL is required");
    process.exit(2);
  }
  if (!loadAuditChainKeyring().current && !process.env.AUDIT_CHAIN_RETIRED_KEYS) {
    console.error("AUDIT_CHAIN_KEY (or AUDIT_CHAIN_RETIRED_KEYS) is required to verify");
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const bizArg = args.indexOf("--business");
  const tableArg = args.indexOf("--table");
  const db = new PrismaClient({ datasourceUrl: url });
  try {
    const reports = await verifyDatabase(db, {
      businessId: bizArg >= 0 ? Number(args[bizArg + 1]) : undefined,
      tables: tableArg >= 0 ? [args[tableArg + 1] as AuditChainTable] : undefined,
    });
    let findings = 0;
    for (const r of reports) {
      findings += r.findings.length;
      console.log(
        JSON.stringify({
          table: r.table,
          businessId: r.businessId,
          chained: r.chained,
          legacyUnchained: r.legacyUnchained,
          head: r.head,
          findings: r.findings,
        })
      );
    }
    console.log(findings === 0 ? "AUDIT CHAIN: VERIFIED" : `AUDIT CHAIN: ${findings} FINDING(S)`);
    process.exit(findings === 0 ? 0 : 1);
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && /verify-audit-chain\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((e) => {
    console.error(`VERIFY ERROR: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  });
}
