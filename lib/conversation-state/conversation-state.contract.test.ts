/**
 * Conversation State Writer — structural contract (W2.5).
 *
 * The behavioural suite (`conversation-state.w25.test.ts`) proves idempotency,
 * counting and tenant refusal against a real database — and therefore stays
 * local, like `verify:leads-service`.
 *
 * This file is the part that can run in the BLOCKING CI job: a pure fs scan,
 * no DB, no network, no secrets. It exists because the two blockers the
 * activation audit found were both *shapes* of code, and a shape can be
 * reintroduced by a refactor long after the behavioural proof stopped being
 * run:
 *
 *   1. the counter was a read-modify-write `increment`, so a replay double-counted;
 *   2. the single write was `conversation.update({ where: { id } })`, with no
 *      businessId predicate — a conversation id from another tenant was a
 *      usable write handle.
 *
 * Both are now closed. This guard fails if either comes back.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SERVICE = path.join(ROOT, "lib/conversation-state/conversation-state.service.ts");
const SCHEMA = path.join(ROOT, "prisma/schema.prisma");

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail?: string) {
  checks += 1;
  if (condition) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
}

const service = readFileSync(SERVICE, "utf8");
const schema = readFileSync(SCHEMA, "utf8");

// Comments explain the rules; they must not be able to satisfy them.
const code = service
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//") && !line.trimStart().startsWith("/*"))
  .join("\n");

console.log("\nConversation State Writer — structural contract\n");

// ── Blocker 1: the counter must be derived, never incremented ───────────────
ok(
  "B1 the writer never uses a Prisma atomic increment",
  !/increment\s*:/.test(code),
  "an `increment:` reappeared — a replay would double-count"
);
ok(
  "B1 unansweredInboundCount is written from a derived value",
  /unansweredInboundCount:\s*unansweredAfterEvent/.test(code),
  "the counter is no longer assigned from the derivation"
);
ok(
  "B1 the derivation counts inbound messages after the last outbound",
  /\$queryRaw/.test(code) &&
    /FROM "Message"/.test(code) &&
    /'INBOUND'/.test(code) &&
    /'OUTBOUND'/.test(code),
  "the derivation query is gone"
);
ok(
  "B1 the derivation is a parameterized tagged template",
  // `$queryRaw` used as a TAG binds every `${...}` as a bound parameter. The
  // unsafe forms are the ones that concatenate: `$queryRawUnsafe`, `Prisma.raw`.
  /\$queryRaw</.test(code) && !/queryRawUnsafe/.test(code) && !/Prisma\.raw/.test(code),
  "raw SQL is being built by concatenation instead of bound parameters"
);

// ── Blocker 2: the write must carry a tenant predicate ──────────────────────
ok(
  "B2 the writer never mutates a conversation by id alone",
  !/conversation\.update\s*\(/.test(code),
  "`conversation.update(` is back — a foreign id becomes a write handle"
);
ok(
  "B2 the single write is an updateMany scoped by businessId",
  /conversation\.updateMany\(\s*\{\s*[\s\S]{0,120}?where:\s*\{[^}]*businessId/.test(code),
  "the updateMany lost its businessId predicate"
);
ok(
  "B2 a write that matched no row is reported, not assumed",
  /updated\.count\s*!==\s*1/.test(code),
  "the writer no longer checks that exactly one row was written"
);

// ── Tenant guard on the evidence itself ─────────────────────────────────────
ok(
  "T1 a message from another business is refused as evidence",
  /message\.businessId\s*!==\s*conversation\.businessId/.test(code),
  "the tenant_mismatch guard is gone"
);
ok(
  "T1 the refusal vocabulary still carries tenant_mismatch",
  /"tenant_mismatch"/.test(service) && /"conversation_not_found"/.test(service),
  "a refusal reason was dropped from the result type"
);

// ── Ordering: the stamps must be monotonic ──────────────────────────────────
ok(
  "O1 lastMessageAt is monotonic",
  /const lastMessageAt = latest\(/.test(code),
  "lastMessageAt is assigned directly again — a replayed old message rewinds it"
);
ok(
  "O1 both party stamps are monotonic",
  /customerLastInboundAt\s*=\s*isCustomerInbound[\s\S]{0,80}latest\(/.test(code) &&
    /businessLastOutboundAt\s*=\s*isOutbound[\s\S]{0,80}latest\(/.test(code),
  "an inbound/outbound stamp lost its monotonic guard"
);

// ── The flag stays the only activation switch ───────────────────────────────
ok(
  "F1 the writer is still gated by CONVERSATION_STATE_WRITER_ENABLED",
  /CONVERSATION_STATE_WRITER_ENABLED/.test(service) &&
    /if \(!isConversationStateWriterEnabled\(\)\)/.test(code),
  "the feature gate was removed or renamed"
);

// ── Send idempotency: the index the /api/message guard depends on ───────────
ok(
  "S1 Message carries clientRequestId unique per business",
  /@@unique\(\[businessId, clientRequestId\]\)/.test(schema),
  "the send-idempotency index is gone; duplicate sends stop being suppressed"
);
ok(
  "S1 Message is indexed for the derivation query",
  /@@index\(\[conversationId, createdAt\]\)/.test(schema),
  "the (conversationId, createdAt) index is gone; the counter derivation seq-scans"
);

console.log(
  failures === 0
    ? `\nCONVERSATION-STATE CONTRACT PASS — ${checks} checks green.\n`
    : `\nCONVERSATION-STATE CONTRACT FAIL — ${failures} of ${checks} checks failed.\n`
);
process.exit(failures === 0 ? 0 : 1);
