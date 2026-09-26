/**
 * SEC-F — keyed audit chain, pure verification (no DB, no network):
 *   npx tsx lib/audit/audit-chain.verify.test.ts
 *
 * Builds a chain exactly as the writer does, then proves the verifier passes it
 * clean and flags each tamper class with its specific finding code.
 */
import {
  AUDIT_CHAIN_GENESIS,
  computeChainHash,
  loadAuditChainKeyring,
  verifyAuditChain,
  type AuditChainKeyring,
  type ChainFindingCode,
  type StoredAuditRow,
} from "@/lib/audit/audit-chain";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failed++;
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

const KEY = "a".repeat(64); // 32 bytes hex — synthetic
const keyring: AuditChainKeyring = loadAuditChainKeyring({ AUDIT_CHAIN_KEY: KEY, AUDIT_CHAIN_KEY_ID: "k1" } as NodeJS.ProcessEnv);
const TABLE = "BillingAuditEvent" as const;

function build(n: number): StoredAuditRow[] {
  const rows: StoredAuditRow[] = [];
  let prev = AUDIT_CHAIN_GENESIS;
  for (let i = 1; i <= n; i++) {
    const content = {
      businessId: 7,
      eventType: "BILLING_DOC_ISSUED",
      source: "USER",
      summary: `event ${i}`,
      metadata: { totalAmount: `${i}00.00`, nested: { b: 2, a: [1, "x"] }, at: new Date(Date.UTC(2026, 8, i)) },
      eventHash: "0".repeat(64),
      occurredAt: new Date(Date.UTC(2026, 8, i, 10, 0, 0, 123)),
      actorUserId: 3,
      refs: { billingDocumentId: 100 + i },
    };
    const chainHash = computeChainHash(keyring.current!.secret, TABLE, i, prev, content);
    // what the verifier reads back: JSONB turns the Date into a string
    rows.push({ ...content, metadata: JSON.parse(JSON.stringify(content.metadata)), id: i * 10, chainSeq: i, prevHash: prev, chainHash, chainKeyId: "k1" });
    prev = chainHash;
  }
  return rows;
}

function codes(rows: StoredAuditRow[], kr: AuditChainKeyring = keyring): ChainFindingCode[] {
  return verifyAuditChain(TABLE, 7, rows, kr).findings.map((f) => f.code);
}

console.log("== audit chain verifier ==");
{
  const r = verifyAuditChain(TABLE, 7, build(6), keyring);
  ok("clean chain verifies with no findings", r.findings.length === 0, JSON.stringify(r.findings));
  ok("head is reported for external anchoring", r.head?.chainSeq === 6 && /^[0-9a-f]{64}$/.test(r.head.chainHash));
}
{
  const rows = build(5);
  rows[2] = { ...rows[2], summary: "rewritten" };
  const c = codes(rows);
  ok("MODIFY summary → MAC_MISMATCH", c.includes("MAC_MISMATCH") && c.length === 1, c.join(","));
}
{
  const rows = build(5);
  rows[1] = { ...rows[1], metadata: { ...(rows[1].metadata as object), totalAmount: "1.00" } };
  ok("MODIFY metadata amount → MAC_MISMATCH", codes(rows).includes("MAC_MISMATCH"));
}
{
  const rows = build(5);
  rows[3] = { ...rows[3], actorUserId: 99 };
  ok("MODIFY actor → MAC_MISMATCH", codes(rows).includes("MAC_MISMATCH"));
}
{
  const rows = build(5);
  rows.splice(2, 1);
  const c = codes(rows);
  ok("DELETE a middle row → SEQ_GAP + PREV_MISMATCH", c.includes("SEQ_GAP") && c.includes("PREV_MISMATCH"), c.join(","));
}
{
  const rows = build(5);
  // Reorder: swap the content of rows 2 and 3 but keep their link fields.
  const a = rows[1];
  const b = rows[2];
  rows[1] = { ...b, id: a.id, chainSeq: a.chainSeq, prevHash: a.prevHash, chainHash: a.chainHash };
  rows[2] = { ...a, id: b.id, chainSeq: b.chainSeq, prevHash: b.prevHash, chainHash: b.chainHash };
  const c = codes(rows);
  ok("REORDER two rows' content → MAC_MISMATCH", c.filter((x) => x === "MAC_MISMATCH").length === 2, c.join(","));
}
{
  const rows = build(5);
  // Reorder: swap the sequence numbers (links move with them)
  const s1 = rows[1].chainSeq;
  rows[1] = { ...rows[1], chainSeq: rows[2].chainSeq };
  rows[2] = { ...rows[2], chainSeq: s1 };
  const c = codes(rows);
  ok("REORDER by swapping sequence numbers → detected", c.includes("MAC_MISMATCH") || c.includes("PREV_MISMATCH"), c.join(","));
}
{
  const rows = build(5);
  // An attacker without the key re-signs a modified row with an unkeyed hash
  rows[4] = { ...rows[4], summary: "forged", chainHash: "f".repeat(64) };
  ok("FORGE the newest row without the key → MAC_MISMATCH", codes(rows).includes("MAC_MISMATCH"));
}
{
  const rows = build(4);
  rows.push({ ...rows[3], id: 999, chainSeq: null, prevHash: null, chainHash: null, chainKeyId: null, summary: "sneaked in" });
  ok("UNCHAINED row after the chain began → UNCHAINED_AFTER_GENESIS", codes(rows).includes("UNCHAINED_AFTER_GENESIS"));
}
{
  const rows = build(3);
  const legacy = { ...rows[0], id: 1, chainSeq: null, prevHash: null, chainHash: null, chainKeyId: null };
  const r = verifyAuditChain(TABLE, 7, [legacy, ...rows], keyring);
  ok("legacy unchained rows BEFORE the chain are counted, not flagged", r.findings.length === 0 && r.legacyUnchained === 1, JSON.stringify(r.findings));
}
{
  const other = loadAuditChainKeyring({ AUDIT_CHAIN_KEY: "b".repeat(64), AUDIT_CHAIN_KEY_ID: "k1" } as NodeJS.ProcessEnv);
  ok("WRONG key → every link MAC_MISMATCH", codes(build(3), other).filter((x) => x === "MAC_MISMATCH").length === 3);
  const none = loadAuditChainKeyring({} as NodeJS.ProcessEnv);
  ok("NO key for the row's key id → UNKNOWN_KEY", codes(build(2), none).every((x) => x === "UNKNOWN_KEY"));
}
{
  const rotated = loadAuditChainKeyring({ AUDIT_CHAIN_KEY: "c".repeat(64), AUDIT_CHAIN_KEY_ID: "k2", AUDIT_CHAIN_RETIRED_KEYS: `k1:${KEY}` } as NodeJS.ProcessEnv);
  ok("ROTATION: retired key still verifies old rows", codes(build(3), rotated).length === 0);
}
{
  const short = loadAuditChainKeyring({ AUDIT_CHAIN_KEY: "abcd" } as NodeJS.ProcessEnv);
  ok("a key shorter than 32 bytes is refused (no current key)", short.current === null);
}

console.log(failed === 0 ? "AUDIT CHAIN VERIFY: ALL PASS" : `AUDIT CHAIN VERIFY: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
