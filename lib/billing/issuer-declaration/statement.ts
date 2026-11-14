/**
 * The canonical issuer declaration (#1081) and its digest. The digest is what the emailed link is bound to
 * (lib/auth/issuer-declaration-link.ts) and what the declaration row stores; it is computed server-side from the
 * current database state both when the link is requested and when it is confirmed, so a change in between is a
 * BINDING_MISMATCH and nothing is recorded.
 *
 * Key order and value shapes were agreed with session 23 and are part of the contract: changing either changes
 * every digest, which needs a new statementVersion.
 *
 * effectiveFrom is null for the first declaration: it takes effect on confirmation (the row stores the confirmation
 * time). A later filing that names a date carries it as an ISO-8601 string.
 */

import { createHash } from "node:crypto";

export const ISSUER_STATEMENT_VERSION = "issuer-declaration-he-v1";

export const ISSUER_STATEMENT_KEYS = [
  "statementVersion",
  "businessId",
  "kind",
  "track",
  "legalForm",
  "vatStatus",
  "legalName",
  "tradeName",
  "idType",
  "idNumber",
  "vatRegistrationNumber",
  "address",
  "phone",
  "email",
  "effectiveFrom",
  "authorizedUserId",
  "declarantName",
  "declarantCapacity",
  "supersedesVersion",
] as const;

export type IssuerStatementKey = (typeof ISSUER_STATEMENT_KEYS)[number];
export type IssuerStatement = Record<IssuerStatementKey, string | number | null>;

export type IssuerStatementInput = Partial<Record<Exclude<IssuerStatementKey, "statementVersion">, string | number | null | undefined>>;

/** The statement in the agreed key order; every absent field is null (never omitted, never ""). */
export function buildIssuerStatement(input: IssuerStatementInput): IssuerStatement {
  const out = {} as IssuerStatement;
  for (const key of ISSUER_STATEMENT_KEYS) {
    if (key === "statementVersion") {
      out[key] = ISSUER_STATEMENT_VERSION;
      continue;
    }
    const v = input[key];
    out[key] = v === undefined || v === "" ? null : v;
  }
  return out;
}

/** The exact bytes that are hashed: JSON in key order, no whitespace, UTF-8. */
export function canonicalIssuerStatementJson(statement: IssuerStatement): string {
  const ordered: Record<string, string | number | null> = {};
  for (const key of ISSUER_STATEMENT_KEYS) ordered[key] = statement[key] ?? null;
  return JSON.stringify(ordered);
}

/** sha256 of the canonical JSON, lowercase hex (64) — the form the link and the declaration row accept. */
export function issuerStatementSha256(statement: IssuerStatement): string {
  return createHash("sha256").update(canonicalIssuerStatementJson(statement), "utf8").digest("hex");
}
