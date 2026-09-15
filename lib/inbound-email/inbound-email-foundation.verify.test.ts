/**
 * Inbound email foundation — contract and boundary verifier.
 *
 * This increment adds tables and pure functions and NOTHING ELSE. There is no
 * route, no consumer and no UI, so the failures worth preventing are not
 * runtime failures — they are contract failures that would only surface much
 * later, when the pipeline is built on top of this.
 *
 * Three of them in particular:
 *
 *   1. a second definition of what Documents accepts, drifting from the first;
 *   2. an inbound path that reaches a FinancialRecord without a human;
 *   3. a tenant boundary that exists in prose but not in the schema.
 *
 * NO database and NO network. What needs a real Postgres — that RLS actually
 * refuses a cross-tenant read under a least-privilege role — is proven by the
 * D2/P7 battery, not here. What is provable statically is proven statically,
 * and nothing below pretends otherwise: the schema and migration assertions
 * read the actual files and fail if the declaration is missing.
 *
 * Run: npx tsx lib/inbound-email/inbound-email-foundation.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  INBOUND_LOCAL_PREFIX,
  INBOUND_TOKEN_CHARS,
  INBOUND_TOKEN_ENTROPY_BITS,
  buildInboundAddress,
  inboundLocalPartPreview,
  inboundTokenHash,
  isValidInboundLocalPart,
  mintInboundLocalPart,
  normalizeInboundLocalPart,
  parseInboundRecipient,
} from "@/lib/inbound-email/inbound-address";
import {
  decryptInboundLocalPart,
  encryptInboundLocalPart,
  redactInboundAddress,
} from "@/lib/inbound-email/inbound-address-crypto";
import {
  acceptAddress,
  acceptAttachment,
  isMalwareVerdict,
} from "@/lib/inbound-email/inbound-email-acceptance";
import {
  getInboundEmailDiagnostics,
  isInboundEmailEnabled,
  requireInboundEmailDomain,
  requireInboundEmailEnabled,
} from "@/lib/inbound-email/inbound-email-flag";
import {
  DOCUMENT_MAX_UPLOAD_BYTES,
  isAllowedDocumentMime,
} from "@/lib/services/documents/document-ingestion.service";
import { SUPPORTED_DOCUMENT_MIME_TYPES } from "@/lib/services/documents/file-signature";

const results: string[] = [];
function ok(name: string) {
  results.push(name);
}

const ROOT = process.cwd();
const SCHEMA = fs.readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
const MIGRATION_DIR = path.join(
  ROOT,
  "prisma/migrations/20260914120000_inbound_email_foundation"
);
const MIGRATION = fs.readFileSync(path.join(MIGRATION_DIR, "migration.sql"), "utf8");
const LIB_DIR = path.join(ROOT, "lib/inbound-email");

/** The block of schema.prisma belonging to one model. */
function modelBlock(name: string): string {
  const start = SCHEMA.indexOf(`model ${name} {`);
  assert.notEqual(start, -1, `model ${name} must exist in schema.prisma`);
  const end = SCHEMA.indexOf("\n}", start);
  return SCHEMA.slice(start, end);
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Address generation: entropy and format
// ───────────────────────────────────────────────────────────────────────────

assert.ok(
  INBOUND_TOKEN_ENTROPY_BITS >= 128,
  "token entropy must be at least 128 bits"
);
assert.equal(INBOUND_TOKEN_ENTROPY_BITS, 160);
assert.equal(INBOUND_TOKEN_CHARS, INBOUND_TOKEN_ENTROPY_BITS / 5);
ok("entropy is 160 bits and encodes to a whole number of base32 characters");

const SAMPLE = 2000;
const minted = new Set<string>();
for (let i = 0; i < SAMPLE; i++) {
  const localPart = mintInboundLocalPart();
  assert.ok(
    isValidInboundLocalPart(localPart),
    `minted local part must match the format: ${localPart}`
  );
  assert.equal(localPart.length, INBOUND_LOCAL_PREFIX.length + INBOUND_TOKEN_CHARS);
  assert.equal(localPart, localPart.toLowerCase(), "minted parts are lowercase");
  minted.add(localPart);
}
assert.equal(minted.size, SAMPLE, "every minted local part must be distinct");
ok(`${SAMPLE} minted addresses: all well-formed, all distinct`);

// Crockford: the characters that get misread must never appear.
const forbidden = ["i", "l", "o", "u"];
for (const localPart of minted) {
  const random = localPart.slice(INBOUND_LOCAL_PREFIX.length);
  for (const ch of forbidden) {
    assert.ok(!random.includes(ch), `alphabet must exclude "${ch}"`);
  }
}
ok("alphabet excludes i, l, o and u so the address survives being retyped");

// A near-miss must be refused: right alphabet, wrong length.
assert.equal(isValidInboundLocalPart(INBOUND_LOCAL_PREFIX + "abc"), false);
assert.equal(isValidInboundLocalPart("zz" + "0".repeat(INBOUND_TOKEN_CHARS)), false);
assert.equal(isValidInboundLocalPart(""), false);
ok("wrong length, wrong prefix and empty are all refused");

// ───────────────────────────────────────────────────────────────────────────
// 2. Normalisation and hashing: lookup identity
// ───────────────────────────────────────────────────────────────────────────

const sample = mintInboundLocalPart();

assert.equal(normalizeInboundLocalPart(`  ${sample.toUpperCase()}  `), sample);
ok("case and surrounding whitespace do not change the identity");

assert.equal(normalizeInboundLocalPart(`${sample}+supplier`), sample);
ok("a plus-tag added by a forwarder still resolves to the same address");

// Dots must NOT be stripped: that is a Gmail convention, and applying it here
// would make two distinct minted tokens collide.
assert.notEqual(normalizeInboundLocalPart("dz.abc"), "dzabc");
ok("dots are preserved, so distinct tokens cannot collide");

const hash = inboundTokenHash(sample);
assert.match(hash, /^[0-9a-f]{64}$/, "hash is lowercase hex sha-256");
assert.equal(hash, inboundTokenHash(sample.toUpperCase()), "hash is case-stable");
assert.equal(hash, inboundTokenHash(`${sample}+anything`), "hash ignores plus-tags");
assert.notEqual(hash, inboundTokenHash(mintInboundLocalPart()));
ok("token hash is deterministic, normalised and collision-free across samples");

// ───────────────────────────────────────────────────────────────────────────
// 3. The stored preview must not be a usable address
// ───────────────────────────────────────────────────────────────────────────

const preview = inboundLocalPartPreview(sample);
assert.ok(preview.length < sample.length, "preview is shorter than the address");
assert.equal(isValidInboundLocalPart(preview), false, "preview is not a valid address");
assert.ok(
  sample.startsWith(preview.replace("…", "")),
  "preview is a prefix of the address, for recognition only"
);
const revealed = preview.replace("…", "").length - INBOUND_LOCAL_PREFIX.length;
assert.ok(
  (INBOUND_TOKEN_CHARS - revealed) * 5 >= 128,
  "what the preview leaves unrevealed must still exceed 128 bits"
);
ok(`preview reveals ${revealed} characters and leaves ${(INBOUND_TOKEN_CHARS - revealed) * 5} bits`);

// ───────────────────────────────────────────────────────────────────────────
// 4. Recipient parsing: address lookup and tenant resolution input
// ───────────────────────────────────────────────────────────────────────────

const DOMAIN = "in.example.test";
const address = buildInboundAddress(sample, DOMAIN);
assert.equal(address, `${sample}@${DOMAIN}`);

const parsed = parseInboundRecipient(address, DOMAIN);
assert.equal(parsed.ok, true);
assert.equal(parsed.ok && parsed.tokenHash, hash, "parse yields the lookup key");
ok("a valid recipient parses to the same hash the address was stored under");

assert.equal(
  parseInboundRecipient(`${sample}@somewhere-else.test`, DOMAIN).ok,
  false,
  "a foreign domain must never resolve a tenant"
);
assert.equal(parseInboundRecipient("not-an-address", DOMAIN).ok, false);
assert.equal(parseInboundRecipient(`hello@${DOMAIN}`, DOMAIN).ok, false);
assert.equal(parseInboundRecipient("", DOMAIN).ok, false);
ok("foreign domain, malformed input and a non-minted local part are all refused");

assert.equal(
  parseInboundRecipient(`${sample.toUpperCase()}+tag@${DOMAIN.toUpperCase()}`, DOMAIN).ok,
  true,
  "real-world spelling variations still resolve"
);
ok("uppercase and plus-tagged recipients resolve to the same address");

// ───────────────────────────────────────────────────────────────────────────
// 5. Revocation
// ───────────────────────────────────────────────────────────────────────────

assert.deepEqual(acceptAddress({ status: "ACTIVE" }), { ok: true });
assert.deepEqual(acceptAddress({ status: "REVOKED" }), {
  ok: false,
  reason: "REVOKED_ADDRESS",
});
assert.deepEqual(acceptAddress(null), { ok: false, reason: "UNKNOWN_ADDRESS" });
assert.deepEqual(acceptAddress(undefined), { ok: false, reason: "UNKNOWN_ADDRESS" });
ok("a revoked address stops accepting mail; an unknown one never started");

// The schema must be able to express rotation: several addresses per business.
assert.match(
  modelBlock("Business"),
  /inboundEmailAddresses\s+InboundEmailAddress\[\]/,
  "a business must be able to hold several addresses, which is what rotation is"
);
ok("rotation is representable: a business holds many addresses, not one");

// ───────────────────────────────────────────────────────────────────────────
// 6. Idempotency declared in the schema
// ───────────────────────────────────────────────────────────────────────────

assert.match(
  modelBlock("InboundEmailMessage"),
  /@@unique\(\[businessId, providerMessageId\]\)/,
  "redelivery of the same provider message must be refused by the database"
);
ok("duplicate providerMessageId is impossible per tenant");

assert.match(
  modelBlock("InboundEmailAttachmentImport"),
  /@@unique\(\[businessId, contentHashSha256\]\)/,
  "the same file content must not be imported twice for one tenant"
);
ok("duplicate attachment content is impossible per tenant");

assert.match(
  modelBlock("InboundEmailAddress"),
  /tokenHash\s+String\s+@unique/,
  "an address must resolve to exactly one business"
);
ok("token hash is globally unique, so routing can never be ambiguous");

// ───────────────────────────────────────────────────────────────────────────
// 7. Tenant isolation declared structurally, not by convention
// ───────────────────────────────────────────────────────────────────────────

for (const model of [
  "InboundEmailAddress",
  "InboundEmailMessage",
  "InboundEmailAttachmentImport",
]) {
  const block = modelBlock(model);
  assert.match(block, /businessId\s+Int/, `${model} must carry its own tenant id`);
  assert.match(
    block,
    /business\s+Business\s+@relation\(fields: \[businessId\]/,
    `${model} must be owned by a Business`
  );
  assert.match(block, /onDelete: Cascade/, `${model} must not outlive its business`);
}
ok("all three models carry their own businessId and cascade with the business");

// Child rows reference their parent through the COMPOSITE key, so a child can
// never point at a parent in another tenant.
assert.match(
  modelBlock("InboundEmailMessage"),
  /address\s+InboundEmailAddress\s+@relation\(fields: \[businessId, addressId\], references: \[businessId, id\]/,
  "a message must reach its address through the tenant-scoped composite key"
);
assert.match(
  modelBlock("InboundEmailAttachmentImport"),
  /message\s+InboundEmailMessage\s+@relation\(fields: \[businessId, messageId\], references: \[businessId, id\]/,
  "an attachment must reach its message through the tenant-scoped composite key"
);
ok("inbound rows reach their parents through the tenant-scoped composite key");

// The Document reference is DELIBERATELY not composite, and the reason is
// recorded so nobody "fixes" it back. A composite reference here depends on
// Document_businessId_id_key, which the I-8A battery drops on purpose to
// rewind the database and prove that migration re-creates it. Depending on it
// makes that drop fail with 2BP01 and breaks four unrelated batteries.
assert.match(
  modelBlock("InboundEmailAttachmentImport"),
  /document\s+Document\?\s+@relation\(fields: \[documentId\], references: \[id\]\)/,
  "the Document reference must match the existing attachment ledgers"
);
for (const ledger of ["EmailAttachmentImport", "WhatsAppAttachmentImport"]) {
  assert.match(
    modelBlock(ledger),
    /document\s+Document\?\s+@relation\(fields: \[documentId\], references: \[id\]\)/,
    `${ledger} is the precedent this follows and must still look like this`
  );
}
ok("the Document reference matches both existing ledgers, and they are unchanged");

// Row-level security must be declared in the migration for all three tables.
for (const table of [
  "InboundEmailAddress",
  "InboundEmailMessage",
  "InboundEmailAttachmentImport",
]) {
  assert.ok(
    MIGRATION.includes(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`),
    `${table} must have RLS enabled`
  );
  assert.ok(
    MIGRATION.includes(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`),
    `${table} must FORCE RLS, so the owner is not exempt`
  );
  assert.ok(
    new RegExp(`CREATE POLICY [a-z0-9_]+ ON "${table}"`).test(MIGRATION),
    `${table} must have at least one policy`
  );
}
ok("RLS is enabled, forced and policied on all three tables");

assert.ok(
  MIGRATION.includes("app.current_business_id"),
  "policies must key off the transaction-local tenant GUC used by the rest of the schema"
);
ok("policies use the same tenant GUC as every other P7 table");

// ───────────────────────────────────────────────────────────────────────────
// 8. The migration is expand-only
// ───────────────────────────────────────────────────────────────────────────

const destructive = /\b(DROP\s+TABLE|DROP\s+COLUMN|ALTER\s+COLUMN|TRUNCATE|DELETE\s+FROM|UPDATE\s+"[A-Za-z]+"\s+SET)\b/i;
assert.equal(
  destructive.test(MIGRATION),
  false,
  "the migration must not drop, alter or mutate anything that already exists"
);
ok("migration is expand-only: no drop, no column alteration, no data mutation");

assert.ok(
  /pg_roles WHERE rolname = 'app_runtime'/.test(MIGRATION),
  "grants must be role-guarded so the migration runs on a database without the role"
);
ok("grants are role-guarded and therefore portable across environments");

// ───────────────────────────────────────────────────────────────────────────
// 9. Acceptance is DELEGATED, never redefined
// ───────────────────────────────────────────────────────────────────────────

const libFiles = fs
  .readdirSync(LIB_DIR)
  .filter((f) => f.endsWith(".ts") && !f.includes(".test."));
/**
 * Strip comments before scanning for forbidden references.
 *
 * The scans below assert that no inbound-email module CALLS certain things.
 * Without this, a doc comment explaining "this cannot approve anything" would
 * fail the check that nothing approves anything — which is the opposite of
 * what the comment is for, and would push explanation out of the code.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const libSources = libFiles.map((f) => ({
  file: f,
  text: fs.readFileSync(path.join(LIB_DIR, f), "utf8"),
  code: stripComments(fs.readFileSync(path.join(LIB_DIR, f), "utf8")),
}));

for (const { file, text } of libSources) {
  assert.equal(
    /["'`]application\/pdf["'`]|["'`]image\/(jpeg|png)["'`]/.test(text),
    false,
    `${file} must not name accepted MIME types; it must import them`
  );
  assert.equal(
    /15\s*\*\s*1024\s*\*\s*1024|\b15728640\b/.test(text),
    false,
    `${file} must not restate the size cap; it must import it`
  );
}
ok("no module under lib/inbound-email restates the accepted types or the size cap");

// And the delegation actually holds at runtime.
for (const mime of SUPPORTED_DOCUMENT_MIME_TYPES) {
  assert.equal(
    isAllowedDocumentMime(mime),
    true,
    `${mime} is accepted by the canonical rule`
  );
}
const pdfBytes = Buffer.from("%PDF-1.4\nhello");
assert.deepEqual(
  acceptAttachment({ mimeType: "application/pdf", sizeBytes: pdfBytes.length, buffer: pdfBytes }),
  { ok: true }
);
ok("a real PDF declared as a PDF is accepted");

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const mismatch = acceptAttachment({
  mimeType: "application/pdf",
  sizeBytes: pngBytes.length,
  buffer: pngBytes,
});
assert.equal(mismatch.ok, false);
assert.equal(mismatch.ok === false && mismatch.reason, "SIGNATURE_MISMATCH");
ok("a PNG renamed to .pdf is refused on its bytes, not on its name");

assert.equal(
  acceptAttachment({ mimeType: "image/heic", sizeBytes: 10, buffer: pdfBytes }).ok,
  false
);
assert.equal(
  acceptAttachment({ mimeType: "application/zip", sizeBytes: 10, buffer: pdfBytes }).ok,
  false
);
assert.equal(
  acceptAttachment({
    mimeType: "application/pdf",
    sizeBytes: DOCUMENT_MAX_UPLOAD_BYTES + 1,
    buffer: pdfBytes,
  }).ok,
  false
);
assert.equal(
  acceptAttachment({ mimeType: "application/pdf", sizeBytes: 0, buffer: Buffer.alloc(0) }).ok,
  false
);
ok("HEIC, unsupported types, oversize and empty files are all refused");

assert.equal(isMalwareVerdict("FAIL"), true);
assert.equal(isMalwareVerdict("fail"), true);
assert.equal(isMalwareVerdict("PASS"), false);
assert.equal(isMalwareVerdict(null), false);
ok("a positive malware verdict is the only scan result that stops a message");

// ───────────────────────────────────────────────────────────────────────────
// 10. Inbound email cannot bypass review and approval
// ───────────────────────────────────────────────────────────────────────────

for (const { file, code } of libSources) {
  for (const forbidden of [
    "financialRecord",
    "FinancialRecord",
    "approve",
    "prisma.document.create",
    "document.create(",
    "processDocumentPipeline",
    "putDocumentObject",
  ]) {
    assert.equal(
      code.includes(forbidden),
      false,
      `${file} must not reference ${forbidden}: ingestion and approval belong to Documents`
    );
  }
}
ok("no inbound-email module creates a Document, runs the pipeline or touches FinancialRecord");

// The one status an inbound document may reach without a human is the review
// queue. The canonical service is the only thing that may put it there, and it
// only ever returns "processing".
const ingestionSource = fs.readFileSync(
  path.join(ROOT, "lib/services/documents/document-ingestion.service.ts"),
  "utf8"
);
assert.ok(
  ingestionSource.includes('status: "processing"'),
  "the canonical ingestion service still returns processing, never approved"
);
assert.equal(
  /status:\s*"approved"/.test(ingestionSource),
  false,
  "the canonical ingestion service must never mark a document approved"
);
ok("the only ingestion path still ends at processing, never at approved");

// ───────────────────────────────────────────────────────────────────────────
// 11. The feature flag fails closed
// ───────────────────────────────────────────────────────────────────────────

const savedFlag = process.env.INBOUND_EMAIL_ENABLED;
const savedDomain = process.env.INBOUND_EMAIL_DOMAIN;

for (const value of [undefined, "", "false", "TRUE", "True", "1", "yes", " true"]) {
  if (value === undefined) delete process.env.INBOUND_EMAIL_ENABLED;
  else process.env.INBOUND_EMAIL_ENABLED = value;
  assert.equal(
    isInboundEmailEnabled(),
    false,
    `INBOUND_EMAIL_ENABLED=${JSON.stringify(value)} must NOT enable the feature`
  );
  assert.throws(() => requireInboundEmailEnabled(), /disabled/);
}
ok("unset, empty, mistyped and differently-cased values all leave the feature off");

process.env.INBOUND_EMAIL_ENABLED = "true";
assert.equal(isInboundEmailEnabled(), true);
ok('only the exact string "true" enables it');

delete process.env.INBOUND_EMAIL_DOMAIN;
assert.throws(() => requireInboundEmailDomain(), /INBOUND_EMAIL_DOMAIN/);
assert.throws(() => requireInboundEmailEnabled(), /INBOUND_EMAIL_DOMAIN/);
ok("an enabled feature with no domain fails loudly instead of minting dead addresses");

process.env.INBOUND_EMAIL_DOMAIN = "in.example.test";
assert.deepEqual(requireInboundEmailEnabled(), { domain: "in.example.test" });
ok("the gate returns the domain, so a caller cannot check the flag and forget it");

delete process.env.INBOUND_EMAIL_ENABLED;
const diag = getInboundEmailDiagnostics();
assert.equal(diag.enabled, false);
assert.match(diag.reasonIfDisabled, /not "true"/);
ok("diagnostics explain why the feature is off without leaking a value");

if (savedFlag === undefined) delete process.env.INBOUND_EMAIL_ENABLED;
else process.env.INBOUND_EMAIL_ENABLED = savedFlag;
if (savedDomain === undefined) delete process.env.INBOUND_EMAIL_DOMAIN;
else process.env.INBOUND_EMAIL_DOMAIN = savedDomain;

// ───────────────────────────────────────────────────────────────────────────
// 12. The frozen Gmail integration is not touched
// ───────────────────────────────────────────────────────────────────────────

for (const { file, code } of libSources) {
  for (const frozen of [
    "integrations/gmail",
    "gmail.readonly",
    "EmailConnection",
    "OAuthToken",
    "googleapis",
  ]) {
    assert.equal(
      code.includes(frozen),
      false,
      `${file} must not reference ${frozen}: the Gmail integration is frozen and unrelated`
    );
  }
}
ok("no inbound-email module imports, extends or references the Gmail integration");

// ───────────────────────────────────────────────────────────────────────────
// 13. Recoverable address storage: encryption contract
// ───────────────────────────────────────────────────────────────────────────

const KEY_A = Buffer.alloc(32, 7).toString("base64");
const KEY_B = Buffer.alloc(32, 9).toString("base64");
const savedKey = process.env.INBOUND_EMAIL_ENCRYPTION_KEY;

const BIZ = 91;
const secretLocal = mintInboundLocalPart();
const secretHash = inboundTokenHash(secretLocal);

process.env.INBOUND_EMAIL_ENCRYPTION_KEY = KEY_A;
const material = encryptInboundLocalPart(secretLocal, BIZ, secretHash);

assert.equal(
  decryptInboundLocalPart(material, BIZ, secretHash),
  secretLocal,
  "an active address must be readable back by its owner without rotating"
);
ok("encrypt/decrypt round-trips, so an address can be redisplayed");

assert.equal(material.encryptionKeyId, "inbound-email-v1");
assert.notEqual(material.localPartEncrypted, secretLocal);
assert.ok(
  !JSON.stringify(material).includes(secretLocal),
  "the serialised material must not contain the plaintext"
);
ok("stored material carries a key id and no plaintext");

// The ciphertext is bound to its row. Moving it must fail, not decrypt.
assert.equal(
  decryptInboundLocalPart(material, BIZ + 1, secretHash),
  null,
  "a ciphertext moved to another business must not decrypt"
);
assert.equal(
  decryptInboundLocalPart(material, BIZ, inboundTokenHash(mintInboundLocalPart())),
  null,
  "a ciphertext moved to another address row must not decrypt"
);
ok("additional authenticated data binds the ciphertext to businessId and tokenHash");

process.env.INBOUND_EMAIL_ENCRYPTION_KEY = KEY_B;
assert.equal(
  decryptInboundLocalPart(material, BIZ, secretHash),
  null,
  "the wrong key must yield nothing, never a wrong plaintext"
);
ok("a wrong key fails closed");

process.env.INBOUND_EMAIL_ENCRYPTION_KEY = KEY_A;
for (const broken of [
  { ...material, localPartEncrypted: "!!!not-base64!!!" },
  { ...material, localPartTag: Buffer.alloc(16, 1).toString("base64") },
  { ...material, localPartIv: Buffer.alloc(4, 1).toString("base64") },
  { ...material, localPartEncrypted: null },
  { ...material, localPartIv: null },
  { ...material, localPartTag: null },
]) {
  assert.equal(
    decryptInboundLocalPart(broken as never, BIZ, secretHash),
    null,
    "malformed or tampered material must yield nothing"
  );
}
ok("malformed base64, a forged tag, a short nonce and missing columns all fail closed");

delete process.env.INBOUND_EMAIL_ENCRYPTION_KEY;
assert.throws(
  () => encryptInboundLocalPart(secretLocal, BIZ, secretHash),
  /INBOUND_EMAIL_ENCRYPTION_KEY/,
  "minting an address without a key must fail loudly, not silently"
);
assert.equal(
  decryptInboundLocalPart(material, BIZ, secretHash),
  null,
  "a missing key must not be a path to plaintext"
);
ok("an absent key fails closed on both create and decrypt");

// A configuration error must never carry the address it was handling.
process.env.INBOUND_EMAIL_ENCRYPTION_KEY = "too-short";
let captured = "";
try {
  encryptInboundLocalPart(secretLocal, BIZ, secretHash);
} catch (error) {
  captured = `${(error as Error).message}\n${(error as Error).stack ?? ""}`;
}
assert.ok(captured.length > 0, "a malformed key must raise");
assert.ok(
  !captured.includes(secretLocal),
  "the error must not carry the plaintext address"
);
ok("a key configuration error never leaks the address it was handling");

process.env.INBOUND_EMAIL_ENCRYPTION_KEY = KEY_A;

// Redaction is the only shape allowed into a log.
const redacted = redactInboundAddress(`${secretLocal}@in.example.test`);
assert.ok(!redacted.includes(secretLocal), "redaction must drop the token");
assert.ok(redacted.includes("@in.example.test"), "the domain stays, for support");
assert.equal(redactInboundAddress(null), "(none)");
assert.equal(redactInboundAddress(""), "(none)");
ok("the redaction helper keeps the domain and drops the secret");

// No module may log a decrypted address directly.
for (const { file, code } of libSources) {
  const logsPlainLocalPart =
    /console\.(log|warn|error|info)\([^)]*\blocalPart\b(?!Preview|Encrypted|Iv|Tag)/.test(code);
  assert.equal(
    logsPlainLocalPart,
    false,
    `${file} must not log a plaintext local part; use redactInboundAddress`
  );
}
ok("no module logs a plaintext local part");

// The key must be its own, not borrowed from another domain.
const cryptoSource = fs.readFileSync(
  path.join(LIB_DIR, "inbound-address-crypto.ts"),
  "utf8"
);
const cryptoCode = stripComments(cryptoSource);
assert.ok(
  cryptoCode.includes("INBOUND_EMAIL_ENCRYPTION_KEY"),
  "the module must use its own key variable"
);
for (const borrowed of [
  "GMAIL_TOKEN_ENCRYPTION_KEY",
  "AUTH_TOKEN_SECRET",
  "PAYMENTS_ENCRYPTION_KEY",
  "ADMIN_MFA_ENCRYPTION_KEY",
  "WHATSAPP_TOKEN_ENCRYPTION_KEY",
]) {
  assert.equal(
    cryptoCode.includes(borrowed),
    false,
    `the module must not read ${borrowed}: keys are per-domain`
  );
}
ok("the encryption key is dedicated and borrows from no other domain");

// The schema must actually carry the recoverable columns.
const addressBlock = modelBlock("InboundEmailAddress");
for (const column of [
  "localPartEncrypted",
  "localPartIv",
  "localPartTag",
  "encryptionKeyId",
]) {
  assert.match(
    addressBlock,
    new RegExp(`${column}\\s+String`),
    `InboundEmailAddress must carry ${column}`
  );
  assert.ok(
    MIGRATION.includes(`"${column}" TEXT NOT NULL`),
    `the migration must create ${column}`
  );
}
ok("the recoverable columns exist in both the model and the migration");

// A revoked address stays readable for audit, but stops accepting mail.
assert.equal(
  decryptInboundLocalPart(material, BIZ, secretHash),
  secretLocal,
  "revocation is a routing decision, not a reason to lose the record"
);
assert.equal(acceptAddress({ status: "REVOKED" }).ok, false);
assert.equal(acceptAddress({ status: "ACTIVE" }).ok, true);
ok("a revoked address remains readable for audit while refusing new mail");

if (savedKey === undefined) delete process.env.INBOUND_EMAIL_ENCRYPTION_KEY;
else process.env.INBOUND_EMAIL_ENCRYPTION_KEY = savedKey;

// ───────────────────────────────────────────────────────────────────────────

console.log(`\nInbound email foundation — ${results.length} checks passed\n`);
for (const line of results) console.log(`  ok  ${line}`);
console.log("");
