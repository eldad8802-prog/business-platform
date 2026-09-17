/**
 * T4 — the inbound-email management plane, held to its contract.
 *
 * Three kinds of proof live here, and the difference matters:
 *
 *   EXECUTED   — `isExpired` and the T3 evaluator are pure, so their behaviour
 *                is called rather than described.
 *   STRUCTURAL — every database query in the service is read from its own
 *                source and checked for tenant scoping, because "this query is
 *                scoped" is a property of the text, and a query that lost its
 *                scope would still typecheck.
 *   ABSENCE    — the things that must NOT be here: a write on the read path, a
 *                status the caller can choose, a verification email.
 *
 * What is NOT proven offline is stated at the bottom rather than implied.
 *
 *   npx tsx lib/services/inbound-email/inbound-email-management.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { isExpired, INBOUND_ADDRESS_GRACE_DAYS } from "./inbound-email-management.service";
import { evaluateSenderAuthorization } from "@/lib/inbound-email/sender-auth/evaluate-sender-authorization";

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const SERVICE_PATH = "lib/services/inbound-email/inbound-email-management.service.ts";
const GUARD_PATH = "lib/services/inbound-email/inbound-email-management-guard.ts";
const ROUTES = [
  "app/api/inbound-email/settings/route.ts",
  "app/api/inbound-email/address/route.ts",
  "app/api/inbound-email/senders/route.ts",
];
const PAGE_PATH = "app/settings/inbound-email/page.tsx";
const CARD_PATH = "components/settings/InboundEmailCard.tsx";

/**
 * Source with `//` and `*` commentary removed: a comment is not behaviour.
 *
 * Line endings are normalised first. The sources are CRLF, and every
 * function-body slice below finds its end with a `"\n}"` boundary — which never
 * matches against `\r\n`, so each slice silently ran to the end of the file and
 * every "this function does not do X" check saw the whole service.
 */
function code(rel: string): string {
  return read(rel)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter(
      (l) =>
        !l.trimStart().startsWith("//") &&
        !l.trimStart().startsWith("*") &&
        !l.trimStart().startsWith("/*")
    )
    .join("\n");
}

const service = code(SERVICE_PATH);
const guard = code(GUARD_PATH);

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(what: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${what}`);
  } catch (error) {
    failed += 1;
    failures.push(what);
    console.log(`  FAIL  ${what}`);
    console.log(`        ${(error as Error).message.split("\n")[0]}`);
  }
}

console.log("\nT4 — inbound email management plane\n");

// ── Tenancy: A1-A6 ───────────────────────────────────────────────────────────

check("A1-A5: every database call in the service is tenant-scoped", () => {
  // Two independent guarantees, and both are required. `tenantTx` establishes
  // the row-level-security context; the explicit `businessId` in each `where`
  // means an id from another tenant matches no row even before RLS is asked.
  const calls = [...service.matchAll(/tx\.(inboundEmail\w+)\.(\w+)\(\{([\s\S]*?)\n {4}\}\)/g)];
  assert.ok(calls.length >= 6, `expected several scoped queries, found ${calls.length}`);
  for (const [, model, method, body] of calls) {
    assert.ok(
      /businessId/.test(body!),
      `tx.${model}.${method} has no businessId in its arguments`
    );
  }
  // And nothing reaches the database outside a tenant transaction.
  assert.ok(!/\bprisma\./.test(service), "the service uses the global client somewhere");
});

check("A6: no route accepts a businessId from the caller", () => {
  for (const rel of [...ROUTES, GUARD_PATH]) {
    const src = code(rel);
    assert.ok(
      !/body\.businessId|body\?\.businessId|searchParams\.get\("businessId"\)/.test(src),
      `${rel} reads businessId from the request`
    );
  }
  // The only source of tenancy is the session.
  assert.ok(
    /getCurrentUser/.test(guard) && /user as \{ businessId\?: number \}/.test(guard),
    "the guard does not derive the tenant from the authenticated user"
  );
});

check("A7-A8: the operations that decide which address is current are serialised", () => {
  assert.ok(
    /pg_advisory_xact_lock/.test(service),
    "nothing serialises concurrent address initialisation or rotation"
  );
  assert.ok(
    !/pg_advisory_lock\(/.test(service),
    "a session-level lock would outlive the transaction and leak"
  );
  // The lock must be taken BEFORE the read it protects, or two callers both see
  // "no active address" and both create one.
  for (const fn of ["initializeInboundAddress", "rotateInboundAddress"]) {
    const start = service.indexOf(`export async function ${fn}`);
    assert.ok(start > 0, `${fn} is missing`);
    const body = service.slice(start, service.indexOf("\n}", start));
    const lock = body.indexOf("lockAddresses");
    const firstRead = body.indexOf("findFirst");
    assert.ok(lock > 0, `${fn} takes no lock`);
    assert.ok(lock < firstRead, `${fn} reads before it locks`);
  }
});

// ── Address: B1-B10 ──────────────────────────────────────────────────────────

check("B1: the approved generator mints the address, not something local", () => {
  assert.ok(/mintInboundLocalPart\(\)/.test(service), "the approved generator is not used");
  assert.ok(
    !/randomBytes|Math\.random|crypto\.getRandomValues/.test(service),
    "the service mints entropy of its own"
  );
});

check("B2: no business identifier is woven into the address", () => {
  const start = service.indexOf("function mintAddressRow");
  const body = service.slice(start, service.indexOf("\n}", start));
  assert.ok(
    !/buildInboundAddress|businessId\s*\+|`\$\{businessId\}/.test(body),
    "businessId leaks into the minted address"
  );
});

check("B3: tokenHash and crypto material never leave the server", () => {
  // The view type is the contract with the browser. Whatever is not in it
  // cannot be serialised to a client.
  const view = service.slice(
    service.indexOf("export type InboundAddressView"),
    service.indexOf("export type InboundSenderView")
  );
  for (const secret of ["tokenHash", "localPartEncrypted", "localPartIv", "localPartTag", "encryptionKeyId"]) {
    assert.ok(!view.includes(secret), `${secret} is part of the client-facing view`);
  }
  for (const rel of ROUTES) {
    const src = code(rel);
    assert.ok(!/tokenHash/.test(src), `${rel} mentions tokenHash`);
  }
});

check("B4-B5: an unreadable address fails closed and never regenerates", () => {
  const start = service.indexOf("function toView");
  const body = service.slice(start, service.indexOf("\n}\n", start));
  assert.ok(/return null/.test(body), "decryption failure has no closed path");
  assert.ok(
    !/mintAddressRow|rotate|create\(/.test(body),
    "the decrypt path can create or rotate an address"
  );
  assert.ok(
    /addressUnreadable/.test(service),
    "the caller is never told the address could not be read"
  );
  // And the plaintext is never reconstructed from the routing hash.
  assert.ok(
    !/decrypt\w*\(\s*row\.tokenHash/.test(service),
    "something tries to derive the address from tokenHash"
  );
});

check("B6 / S1: the read path performs no write at all", () => {
  const start = service.indexOf("export async function getInboundEmailSettings");
  const body = service.slice(start, service.indexOf("\n}\n", start));
  for (const write of [".create(", ".update(", ".updateMany(", ".delete(", ".deleteMany(", ".upsert("]) {
    assert.ok(!body.includes(write), `the settings read performs ${write}`);
  }
  assert.ok(!/logAuditEvent/.test(body), "the settings read writes an audit event");
  // The GET route likewise only reads.
  const route = code("app/api/inbound-email/settings/route.ts");
  assert.ok(
    !/initializeInboundAddress|rotateInboundAddress|addAuthorizedSender/.test(route),
    "the settings GET route can mutate"
  );
});

check("B7-B8: rotation retires the old address and mints a genuinely new one", () => {
  const start = service.indexOf("export async function rotateInboundAddress");
  const body = service.slice(start, service.indexOf("\n}\n", start));
  assert.ok(/status: "RETIRING"/.test(body), "the previous address is not retired");
  assert.ok(/graceUntil/.test(body), "no grace deadline is set");
  assert.ok(/mintAddressRow\(businessId\)/.test(body), "no new address is minted");
  assert.ok(/status: "ACTIVE"/.test(body), "the replacement is not made current");
  // Both writes inside one transaction: no instant with two current addresses,
  // and none with zero.
  const tx = body.indexOf("tenantTx(");
  assert.ok(tx > 0 && tx < body.indexOf('status: "RETIRING"'), "rotation is not transactional");
  assert.equal(INBOUND_ADDRESS_GRACE_DAYS, 30, "the approved grace is thirty days");
});

check("B9 EXECUTED: expiry is decided by the clock, not by a job having run", () => {
  const now = new Date("2026-09-17T12:00:00Z");
  const future = new Date("2026-10-17T12:00:00Z");
  const past = new Date("2026-09-01T12:00:00Z");

  assert.equal(isExpired("ACTIVE", null, now), false, "an active address reads as expired");
  assert.equal(isExpired("RETIRING", future, now), false, "a retiring address inside grace is expired");
  assert.equal(isExpired("RETIRING", past, now), true, "a retiring address past its grace is still usable");
  assert.equal(isExpired("RETIRING", now, now), true, "the deadline itself is not inclusive");
  assert.equal(isExpired("RETIRING", null, now), true, "a retiring address with no deadline is usable");
  assert.equal(isExpired("REVOKED", future, now), true, "a revoked address is usable while it has a grace date");
});

check("B10: a retiring address can be stopped at once, and only a retiring one", () => {
  const start = service.indexOf("export async function revokeRetiringAddress");
  const body = service.slice(start, service.indexOf("\n}\n", start));
  assert.ok(/status: "RETIRING"/.test(body), "the update is not restricted to retiring addresses");
  assert.ok(/status: "REVOKED"/.test(body) && /revokedAt/.test(body), "revocation is not recorded");
  assert.ok(/businessId/.test(body), "the update is not tenant-scoped");
  // The current address has no revoke path: nothing would replace it.
  assert.ok(
    !/status: "ACTIVE"[\s\S]{0,200}REVOKED/.test(body),
    "the current address can be revoked, leaving nowhere to forward to"
  );
});

// ── Senders: S2-S10 ──────────────────────────────────────────────────────────

check("S2-S3: a new sender is always pending, and the caller cannot say otherwise", () => {
  const start = service.indexOf("export async function addAuthorizedSender");
  const body = service.slice(start, service.indexOf("\n}\n", start));
  assert.ok(/status: "PENDING_VERIFICATION"/.test(body), "a new sender is not pending");
  assert.ok(!/status: "VERIFIED"/.test(body), "this function can produce a verified sender");
  assert.ok(!/verifiedAt/.test(body), "this function can set a verification timestamp");
  // Nothing in any route forwards a caller-chosen status, key or timestamp.
  for (const rel of ROUTES) {
    const src = code(rel);
    for (const field of ["body.status", "body.activeEmailKey", "body.verifiedAt", "body.revokedAt"]) {
      assert.ok(!src.includes(field), `${rel} accepts ${field} from the caller`);
    }
  }
});

check("S4: normalization stays trim().toLowerCase() and nothing more", () => {
  assert.ok(/normalizeEmail\(/.test(service), "the canonical normalizer is not used");
  assert.ok(
    !/replace\(\/\\\.\/g|split\("\+"\)|\.replace\(\/\+.*@/.test(service),
    "the service collapses dots or plus tags, inventing alias semantics"
  );
});

check("S5-S7: a current duplicate is idempotent; revoked history is left alone", () => {
  const start = service.indexOf("export async function addAuthorizedSender");
  const body = service.slice(start, service.indexOf("\n}\n", start));
  // The lookup is by the CURRENT-identity key, so revoked rows are invisible to
  // it and a fresh registration creates a new row rather than reviving one.
  assert.ok(/activeEmailKey: email/.test(body), "the duplicate check does not use the current key");
  assert.ok(/created: false/.test(body), "an existing sender is not returned idempotently");
  assert.ok(
    !/status: "PENDING_VERIFICATION"[\s\S]{0,120}update/.test(body),
    "an existing row is updated instead of a new one created"
  );
  assert.ok(!/\.update\(|\.updateMany\(/.test(body), "adding a sender rewrites an existing row");
});

check("S8: revocation clears the current-identity key so the address frees up", () => {
  const start = service.indexOf("export async function revokeAuthorizedSender");
  const body = service.slice(start, service.indexOf("\n}\n", start));
  assert.ok(/activeEmailKey: null/.test(body), "the key is not cleared, so re-registration stays blocked");
  assert.ok(/status: "REVOKED"/.test(body), "the row is not revoked");
  assert.ok(!/delete/i.test(body), "revocation deletes history");
  assert.ok(
    /status: \{ in: \["PENDING_VERIFICATION", "VERIFIED"\] \}/.test(body),
    "an already-revoked row can be revoked again, rewriting its timestamp"
  );
});

check("S9 EXECUTED: a revoked sender is refused by the T3 evaluator", () => {
  const evidence = {
    envelopeMailFrom: "supplier@vendor.example",
    headerFrom: "supplier@vendor.example",
    spfVerdict: "PASS" as const,
    dkimVerdict: "PASS" as const,
    dmarcVerdict: "PASS" as const,
    headerFromDomainClassification: "PRIVATE_CONTROLLED" as const,
  };
  const verified = evaluateSenderAuthorization({
    configuredSender: { normalizedEmail: "supplier@vendor.example", status: "VERIFIED" },
    ...evidence,
  });
  assert.equal(verified.decision, "AUTHORIZED", "the control case does not authorize");

  // The same perfect evidence, after revocation.
  const revoked = evaluateSenderAuthorization({
    configuredSender: { normalizedEmail: "supplier@vendor.example", status: "REVOKED" },
    ...evidence,
  });
  assert.equal(revoked.decision, "UNAUTHORIZED", "a revoked sender still authorizes");
  assert.equal(revoked.reason, "SENDER_REVOKED");

  // And a freshly re-registered one is pending, which also cannot authorize.
  const pending = evaluateSenderAuthorization({
    configuredSender: { normalizedEmail: "supplier@vendor.example", status: "PENDING_VERIFICATION" },
    ...evidence,
  });
  assert.equal(pending.decision, "UNAUTHORIZED");
  assert.equal(pending.reason, "SENDER_PENDING_VERIFICATION");
});

check("S10: T4 creates, stores and logs no verification material", () => {
  const all = [service, guard, ...ROUTES.map(code), code(CARD_PATH)].join("\n");
  for (const forbidden of [
    "inboundEmailSenderChallenge",
    "challengeHash",
    "sendMail",
    "sendEmail",
    "nodemailer",
    "resend",
    "verificationCode",
  ]) {
    assert.ok(!all.includes(forbidden), `T4 reaches verification machinery: ${forbidden}`);
  }
});

check("the UI offers no verification action it cannot perform", () => {
  const card = code(CARD_PATH);
  assert.ok(!/שלח אימות|שלחי אימות|resend|אמת עכשיו/.test(card), "a dead verification button exists");
  assert.ok(/ממתין לאימות/.test(card), "the pending state is not shown to the owner");
});

// ── Feature flag: F1-F5 ──────────────────────────────────────────────────────

check("F1: the page does not exist while the feature is off", () => {
  const page = code(PAGE_PATH);
  assert.ok(/isInboundEmailEnabled\(\)/.test(page), "the page never checks the flag");
  assert.ok(/notFound\(\)/.test(page), "the page renders something when the flag is off");
});

check("F2: every endpoint refuses before doing anything while the flag is off", () => {
  assert.ok(/isInboundEmailEnabled\(\)/.test(guard), "the guard never checks the flag");
  // Checked FIRST: before the session is read, before the rate limiter, before
  // any query. A disabled feature must not even reveal whether a session works.
  const guardBody = guard.slice(guard.indexOf("export async function guardInboundManagement"));
  const flagAt = guardBody.indexOf("isInboundEmailEnabled()");
  const authAt = guardBody.indexOf("getCurrentUser");
  const limitAt = guardBody.indexOf("consumeRateLimit");
  assert.ok(flagAt > 0 && flagAt < authAt, "the flag is checked after authentication");
  assert.ok(flagAt < limitAt, "the flag is checked after rate limiting");

  for (const rel of ROUTES) {
    const src = code(rel);
    assert.ok(/guardInboundManagement/.test(src), `${rel} bypasses the guard`);
    // No handler reaches the service before the guard has returned ok.
    const guardAt = src.indexOf("guardInboundManagement");
    const firstService = Math.min(
      ...["getInboundEmailSettings", "initializeInboundAddress", "rotateInboundAddress", "addAuthorizedSender", "revokeAuthorizedSender", "revokeRetiringAddress"]
        .map((n) => src.indexOf(n + "("))
        .filter((i) => i > 0)
    );
    assert.ok(guardAt < firstService, `${rel} calls the service before guarding`);
  }
});

check("F3-F4: nothing lazily creates or mutates behind the flag", () => {
  // The only writes in the whole surface are the four named actions, each
  // reached through an explicit POST body. There is no other entry point.
  const address = code("app/api/inbound-email/address/route.ts");
  const senders = code("app/api/inbound-email/senders/route.ts");
  assert.ok(!/export async function GET/.test(address), "the address route answers GET");
  assert.ok(!/export async function GET/.test(senders), "the senders route answers GET");
  for (const action of ["initialize", "rotate", "revoke"]) {
    assert.ok(address.includes(`=== "${action}"`), `the address route lost the ${action} action`);
  }
});

check("F5: nothing in this increment sends mail", () => {
  const all = [service, guard, ...ROUTES.map(code), code(PAGE_PATH), code(CARD_PATH)].join("\n");
  for (const forbidden of ["smtp", "SES", "SendEmailCommand", "transport.send", "mailer"]) {
    assert.ok(!all.includes(forbidden), `T4 reaches a mail transport: ${forbidden}`);
  }
});

// ── Scope ────────────────────────────────────────────────────────────────────

check("T4 touches no intake machinery", () => {
  const all = [service, guard, ...ROUTES.map(code)].join("\n");
  for (const forbidden of [
    "S3Client",
    "SQSClient",
    "parseInboundMime",
    "ingestDocument",
    "inboundEmailMessage",
    "inboundEmailAttachmentImport",
  ]) {
    assert.ok(!all.includes(forbidden), `T4 reaches intake machinery: ${forbidden}`);
  }
});

check("security-sensitive mutations are recorded, without recording the secret", () => {
  for (const event of [
    "INBOUND_EMAIL_ADDRESS_CREATED",
    "INBOUND_EMAIL_ADDRESS_ROTATED",
    "INBOUND_EMAIL_ADDRESS_REVOKED",
    "INBOUND_EMAIL_SENDER_ADDED",
    "INBOUND_EMAIL_SENDER_REVOKED",
  ]) {
    assert.ok(service.includes(event), `${event} is never recorded`);
  }
  // The audit payloads must not carry the routing capability or the address.
  const payloads = [...service.matchAll(/payload: \{([^}]*)\}/g)].map((m) => m[1]!);
  for (const p of payloads) {
    for (const secret of ["tokenHash", "localPart", "address", "normalizedEmail", "email"]) {
      assert.ok(!p.includes(secret), `an audit payload carries ${secret}`);
    }
  }
});

check("every mutation is rate limited, and the limits are named", () => {
  for (const key of ["initialize", "rotate", "revokeAddress", "addSender", "revokeSender"]) {
    assert.ok(guard.includes(`${key}:`), `no limit is defined for ${key}`);
  }
  const address = code("app/api/inbound-email/address/route.ts");
  const senders = code("app/api/inbound-email/senders/route.ts");
  assert.ok(
    (address.match(/INBOUND_MANAGEMENT_LIMITS\./g) ?? []).length === 3,
    "an address action is unlimited"
  );
  assert.ok(
    (senders.match(/INBOUND_MANAGEMENT_LIMITS\./g) ?? []).length === 2,
    "a sender action is unlimited"
  );
});

/**
 * NOT PROVEN HERE, and not implied to be.
 *
 * A7 to A10 are proven STRUCTURALLY: the lock exists, it is taken before the
 * read it protects, and every query carries its tenant. Proving them by racing
 * two real requests needs PostgreSQL, which this file does not open. The
 * database half of A10 — a revoked sender plus a fresh add producing a second
 * row — was executed against PostgreSQL 17 during the T4-DB migration
 * rehearsal, where it is recorded as D3.
 *
 * B4's cryptographic detail is likewise structural: that a wrong key yields no
 * plaintext is a property of AES-GCM and of the crypto module's own tests, not
 * something re-proven here.
 */

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failures.length > 0) console.log(`  failing: ${failures.join(" | ")}`);
console.log("");
process.exit(failed === 0 ? 0 : 1);
