/**
 * D2 — the canonical issuer statement and its digest (#1081): agreed key order, nulls for absent fields, stable
 * bytes, lowercase hex64 accepted by the link library. Pure.
 *
 *   npx tsx lib/billing/issuer-declaration/statement.test.ts
 */
import { isStatementSha256 } from "@/lib/auth/issuer-declaration-link";
import {
  buildIssuerStatement,
  canonicalIssuerStatementJson,
  ISSUER_STATEMENT_KEYS,
  ISSUER_STATEMENT_VERSION,
  issuerStatementSha256,
} from "@/lib/billing/issuer-declaration/statement";

// sha256 of the hand-written canonical JSON of the fixture below (computed independently with node:crypto).
const PINNED = "32d4cec4977161c6e9a00df9d421def9e96d51ed289219e6d0d30938d4664bef";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, got?: unknown) {
  if (!cond) {
    console.error("FAIL: D2", name, got !== undefined ? `(got: ${JSON.stringify(got)})` : "");
    failed += 1;
    return;
  }
  passed += 1;
  console.log("OK: D2", name);
}

const AGREED = [
  "statementVersion", "businessId", "kind", "track", "legalForm", "vatStatus", "legalName", "tradeName", "idType",
  "idNumber", "vatRegistrationNumber", "address", "phone", "email", "effectiveFrom", "authorizedUserId",
  "declarantName", "declarantCapacity", "supersedesVersion",
];
ok("key list is exactly the agreed order", JSON.stringify(ISSUER_STATEMENT_KEYS) === JSON.stringify(AGREED));
ok("statementVersion is issuer-declaration-he-v1", ISSUER_STATEMENT_VERSION === "issuer-declaration-he-v1");

const input = {
  businessId: 42, kind: "INITIAL", track: "EXEMPT_DEALER", legalForm: "INDIVIDUAL", vatStatus: "EXEMPT",
  legalName: "ישראל ישראלי", idType: "ISRAELI_ID", idNumber: "000000018", address: "הרצל 1", phone: "0501234567",
  email: "a@example.com", authorizedUserId: 7, declarantName: "ישראל ישראלי", declarantCapacity: "בעל העסק",
};
const s = buildIssuerStatement(input);
ok("built statement keeps the agreed key order", JSON.stringify(Object.keys(s)) === JSON.stringify(AGREED));
ok("absent fields are null, not omitted", s.tradeName === null && s.vatRegistrationNumber === null && s.effectiveFrom === null && s.supersedesVersion === null);
ok("empty string becomes null", buildIssuerStatement({ ...input, tradeName: "" }).tradeName === null);

// Input key order must not matter.
const reversed = Object.fromEntries(Object.entries(input).reverse());
ok("input key order does not change the bytes", canonicalIssuerStatementJson(buildIssuerStatement(reversed)) === canonicalIssuerStatementJson(s));

const json = canonicalIssuerStatementJson(s);
ok("canonical JSON has no whitespace between tokens", !/[:,]\s/.test(json.replace(/"[^"]*"/g, '""')));
ok("canonical JSON starts with statementVersion", json.startsWith('{"statementVersion":"issuer-declaration-he-v1","businessId":42,'));

const sha = issuerStatementSha256(s);
ok("digest is lowercase hex64", /^[0-9a-f]{64}$/.test(sha), sha);
ok("digest accepted by the link library", isStatementSha256(sha));
ok("digest is stable across calls", issuerStatementSha256(buildIssuerStatement(input)) === sha);
// Pinned: changing the canonical form changes every digest and needs a new statementVersion.
ok("digest pinned for the fixture", sha === PINNED, sha);
ok("any field change changes the digest", issuerStatementSha256(buildIssuerStatement({ ...input, phone: "0501234568" })) !== sha);
ok("businessId change changes the digest", issuerStatementSha256(buildIssuerStatement({ ...input, businessId: 43 })) !== sha);
ok("null vs absent are the same", issuerStatementSha256(buildIssuerStatement({ ...input, tradeName: null })) === sha);

console.log(failed ? `\nD2: ${passed} passed, ${failed} FAILED` : `\nD2: ${passed}/${passed} passed`);
if (failed) process.exit(1);
