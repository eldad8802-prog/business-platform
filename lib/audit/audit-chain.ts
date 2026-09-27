/**
 * SEC-F — keyed, chained audit trail (tamper EVIDENCE, not tamper-proofing).
 *
 * WHAT THE OLD `eventHash` WAS, AND WHY IT IS NOT ENOUGH
 *
 * `eventHash` is an unkeyed sha256 of the row's own fields. Anyone able to
 * rewrite a row can recompute it, and a deleted or reordered row leaves no
 * trace. It is a checksum, never a tamper-evident record, and nothing in this
 * module calls it one. It stays as it is for compatibility.
 *
 * THE CONSTRUCTION
 *
 * Each audit table carries, per business, a linear chain:
 *
 *   chainHash_n = HMAC-SHA256(K[keyId], "dubiz.audit.v1" | table | businessId
 *                              | chainSeq_n | prevHash_n | canonical(row_n))
 *   prevHash_1  = "GENESIS";  prevHash_n = chainHash_{n-1}
 *
 * K is a server secret (AUDIT_CHAIN_KEY) the database never holds, so an actor
 * with full database write access but not the key cannot produce a valid link
 * for a modified, inserted or re-ordered row, and deleting a row breaks the
 * sequence. The database itself (migration 20260926140000) refuses UPDATE and
 * DELETE and refuses a chained insert that does not extend the current head;
 * the MAC is what detects a rewrite that went around the database's guards
 * (a dropped trigger, a restored dump, direct storage access).
 *
 * WHAT IT DOES NOT PROVE: truncation of the chain's TAIL (the newest rows) is
 * detectable only against an externally recorded head (seq + hash). The
 * verifier prints the head so an operator can anchor it outside the database.
 *
 * Writers serialise per (table, business) with a transaction-scoped advisory
 * lock, so concurrent audit writes of one business queue rather than fork.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";

export const AUDIT_CHAIN_DOMAIN = "dubiz.audit.v1";
export const AUDIT_CHAIN_GENESIS = "GENESIS";

export type AuditChainTable = "BillingAuditEvent" | "PayablesAuditEvent" | "PaymentAuditEvent";

/** Advisory-lock namespace (first int of the two-int form); arbitrary, fixed. */
const LOCK_NAMESPACE: Record<AuditChainTable, number> = {
  BillingAuditEvent: 0x5ecf0001,
  PayablesAuditEvent: 0x5ecf0002,
  PaymentAuditEvent: 0x5ecf0003,
};

export type AuditChainKey = { id: string; secret: Buffer };
export type AuditChainKeyring = { current: AuditChainKey | null; all: Map<string, Buffer> };

const MIN_KEY_BYTES = 32;

function decodeSecret(raw: string): Buffer | null {
  const s = raw.trim();
  if (!s) return null;
  const buf = /^[0-9a-f]+$/i.test(s) && s.length % 2 === 0 ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  return buf.length >= MIN_KEY_BYTES ? buf : null;
}

/**
 * AUDIT_CHAIN_KEY        current secret (hex or base64, >= 32 bytes)
 * AUDIT_CHAIN_KEY_ID     its id (default "k1"); stored on every row it signs
 * AUDIT_CHAIN_RETIRED_KEYS  "id:secret,id:secret" — verification only, after rotation
 */
export function loadAuditChainKeyring(env: NodeJS.ProcessEnv = process.env): AuditChainKeyring {
  const all = new Map<string, Buffer>();
  for (const part of (env.AUDIT_CHAIN_RETIRED_KEYS ?? "").split(",")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const secret = decodeSecret(part.slice(i + 1));
    if (secret) all.set(part.slice(0, i).trim(), secret);
  }
  const secret = decodeSecret(env.AUDIT_CHAIN_KEY ?? "");
  const id = (env.AUDIT_CHAIN_KEY_ID ?? "k1").trim() || "k1";
  if (!secret) return { current: null, all };
  all.set(id, secret);
  return { current: { id, secret }, all };
}

/** Stable JSON: sorted keys, `undefined` dropped the way JSON/JSONB drops it. */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const rec = value as Record<string, unknown>;
  return `{${Object.keys(rec)
    .filter((k) => rec[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`)
    .join(",")}}`;
}

/**
 * The JSON value exactly as it will be read back from a JSONB column (Dates
 * become strings, undefined disappears). The MAC is computed over this so a
 * verifier reading the row reproduces it byte for byte.
 */
export function asStoredJson(value: unknown): unknown {
  return value === undefined || value === null ? null : JSON.parse(JSON.stringify(value));
}

/** The immutable content of a row that the MAC covers. */
export type AuditChainContent = {
  businessId: number;
  eventType: string;
  source: string;
  summary: string;
  metadata: unknown;
  eventHash: string;
  occurredAt: Date;
  actorUserId: number | null;
  /** Table-specific subject references (billingDocumentId, commitmentId, …). */
  refs: Record<string, number | null>;
};

export type AuditChainLink = { chainSeq: number; prevHash: string; chainHash: string; chainKeyId: string };

export function computeChainHash(
  secret: Buffer,
  table: AuditChainTable,
  seq: number,
  prevHash: string,
  content: AuditChainContent
): string {
  const body = canonicalJson({
    actorUserId: content.actorUserId,
    businessId: content.businessId,
    eventHash: content.eventHash,
    eventType: content.eventType,
    metadata: asStoredJson(content.metadata),
    occurredAt: content.occurredAt.toISOString(),
    refs: content.refs,
    source: content.source,
    summary: content.summary,
  });
  return createHmac("sha256", secret)
    .update(`${AUDIT_CHAIN_DOMAIN}\n${table}\n${content.businessId}\n${seq}\n${prevHash}\n${body}`, "utf8")
    .digest("hex");
}

let warnedMissingKey = false;

/**
 * Compute the next link for `content` inside the caller's transaction, holding
 * the per-(table,business) advisory lock until that transaction ends. Returns
 * null — and the caller writes an UNCHAINED row — only when no key is
 * configured; that is logged loudly and reported by the verifier, because an
 * audit trail must never break the money path it records.
 */
export async function nextAuditChainLink(
  tx: Prisma.TransactionClient,
  table: AuditChainTable,
  content: AuditChainContent,
  keyring: AuditChainKeyring = loadAuditChainKeyring()
): Promise<AuditChainLink | null> {
  if (!keyring.current) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.error(JSON.stringify({ event: "AUDIT_CHAIN_KEY_MISSING", table, note: "writing unchained audit rows" }));
    }
    return null;
  }
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock($1::int, $2::int)`, LOCK_NAMESPACE[table], content.businessId);
  const head = (await tx.$queryRawUnsafe(
    `SELECT "chainSeq", "chainHash" FROM "${table}" WHERE "businessId" = $1 AND "chainSeq" IS NOT NULL ORDER BY "chainSeq" DESC LIMIT 1`,
    content.businessId
  )) as { chainSeq: number; chainHash: string }[];
  const seq = head.length ? Number(head[0].chainSeq) + 1 : 1;
  const prevHash = head.length ? head[0].chainHash : AUDIT_CHAIN_GENESIS;
  return {
    chainSeq: seq,
    prevHash,
    chainHash: computeChainHash(keyring.current.secret, table, seq, prevHash, content),
    chainKeyId: keyring.current.id,
  };
}

/* ─────────────────────────────── verification ─────────────────────────────── */

export type StoredAuditRow = AuditChainContent & {
  id: number;
  chainSeq: number | null;
  prevHash: string | null;
  chainHash: string | null;
  chainKeyId: string | null;
};

export type ChainFindingCode =
  | "MAC_MISMATCH" // row content (or its link fields) changed after signing
  | "PREV_MISMATCH" // prevHash does not name the previous link — reordering / insertion
  | "SEQ_GAP" // a sequence number is missing — deletion
  | "SEQ_DUPLICATE"
  | "BAD_GENESIS"
  | "UNKNOWN_KEY"
  | "UNCHAINED_AFTER_GENESIS"; // a row written without a link after the chain began

export type ChainFinding = { code: ChainFindingCode; businessId: number; rowId: number; chainSeq: number | null; detail: string };

export type ChainReport = {
  table: AuditChainTable;
  businessId: number;
  chained: number;
  legacyUnchained: number;
  head: { chainSeq: number; chainHash: string } | null;
  findings: ChainFinding[];
};

function macEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Verify one business's chain. `rows` in any order (they are ordered by id
 * here, which is insertion order for these SERIAL tables).
 */
export function verifyAuditChain(
  table: AuditChainTable,
  businessId: number,
  rows: StoredAuditRow[],
  keyring: AuditChainKeyring
): ChainReport {
  const findings: ChainFinding[] = [];
  const byId = [...rows].sort((a, b) => a.id - b.id);
  const firstChainedId = byId.find((r) => r.chainSeq !== null)?.id ?? null;
  let legacyUnchained = 0;
  for (const r of byId) {
    if (r.chainSeq !== null) continue;
    if (firstChainedId !== null && r.id > firstChainedId) {
      findings.push({ code: "UNCHAINED_AFTER_GENESIS", businessId, rowId: r.id, chainSeq: null, detail: "row written without a chain link after the chain began" });
    } else {
      legacyUnchained++;
    }
  }
  const chained = byId.filter((r) => r.chainSeq !== null).sort((a, b) => (a.chainSeq as number) - (b.chainSeq as number));
  let prev: StoredAuditRow | null = null;
  for (const r of chained) {
    const seq = r.chainSeq as number;
    if (prev && seq === prev.chainSeq) {
      findings.push({ code: "SEQ_DUPLICATE", businessId, rowId: r.id, chainSeq: seq, detail: `sequence ${seq} appears twice` });
      continue;
    }
    const expectedSeq = prev ? (prev.chainSeq as number) + 1 : 1;
    if (seq !== expectedSeq) {
      findings.push({ code: "SEQ_GAP", businessId, rowId: r.id, chainSeq: seq, detail: `expected sequence ${expectedSeq}, found ${seq}` });
    }
    if (!prev && seq === 1 && r.prevHash !== AUDIT_CHAIN_GENESIS) {
      findings.push({ code: "BAD_GENESIS", businessId, rowId: r.id, chainSeq: seq, detail: "first link does not name GENESIS" });
    }
    if (prev && r.prevHash !== prev.chainHash) {
      findings.push({ code: "PREV_MISMATCH", businessId, rowId: r.id, chainSeq: seq, detail: "prevHash does not name the preceding link" });
    }
    if (prev && r.id < prev.id) {
      findings.push({ code: "PREV_MISMATCH", businessId, rowId: r.id, chainSeq: seq, detail: "sequence order disagrees with insertion order" });
    }
    const secret = r.chainKeyId ? keyring.all.get(r.chainKeyId) : undefined;
    if (!secret) {
      findings.push({ code: "UNKNOWN_KEY", businessId, rowId: r.id, chainSeq: seq, detail: `no key for id ${r.chainKeyId}` });
    } else {
      const expected = computeChainHash(secret, table, seq, r.prevHash ?? "", r);
      if (!r.chainHash || !macEqual(expected, r.chainHash)) {
        findings.push({ code: "MAC_MISMATCH", businessId, rowId: r.id, chainSeq: seq, detail: "HMAC does not match the stored row" });
      }
    }
    prev = r;
  }
  return {
    table,
    businessId,
    chained: chained.length,
    legacyUnchained,
    head: prev ? { chainSeq: prev.chainSeq as number, chainHash: prev.chainHash as string } : null,
    findings,
  };
}
