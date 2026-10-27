/**
 * Leads L1 · G-06 — CloudTalk API-key failures are visible, bounded and recoverable, pure suite. Run with:
 *   npx tsx lib/intake/calls/cloudtalk-credentials.test.ts
 *
 * No database, no network (CloudTalk's call-history API is stubbed in-process). Pins:
 *   - a missing / refused key (CloudTalk 401 / 403) raises a connection notice and DEFERS — no outcome guessed
 *   - the wait is bounded: after CLOUDTALK_CREDENTIAL_WAIT_MS from arrival the receipt dead-letters with the
 *     same code (no endless retry; the caller's number then leaves with the 30-day failed-payload retention)
 *   - transient trouble (429, 5xx / network) is NOT a credential failure and never raises the notice
 *   - a lookup CloudTalk answers clears the notice; saving a key re-arms what the code held back
 *   - the notice carries only the endpoint id and a fixed code — never a number, never a key
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { IntakeTerminalError, type ClaimedIntakeEvent } from "@/lib/intake/core/contract";
import {
  CLOUDTALK_CREDENTIAL_CODES,
  CLOUDTALK_CREDENTIAL_WAIT_MS,
  hydrateCloudTalkCall,
  setCloudTalkFetchForTests,
  type CloudTalkCallRefV1,
} from "./cloudtalk";

let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log(`  ok  ${name}`);
}

const NOW = new Date("2026-10-28T09:00:00.000Z");
const ref: CloudTalkCallRefV1 = {
  v: 1, kind: "cloudtalk_call_ref", callId: "777", direction: "inbound", startedAt: "2026-10-28T08:50:00.000Z",
  durationSec: 12, isVoicemail: false, externalNumber: "+972501234567", businessLine: "97230000000",
};
const event = (receivedAt: Date): ClaimedIntakeEvent => ({
  id: 1, businessId: 9, sourceKey: "telephony.cloudtalk", family: "CALL", eventType: "call.ended_inbound", externalEventId: "sha256:x",
  providerAccountRef: "pub_ct_1", occurredAt: new Date(ref.startedAt), receivedAt, status: "RECEIVED", attempts: 1,
  payload: ref as never, metadata: null,
});
const KEY = { apiKeyId: "KEYID", apiKeySecret: "KEYSECRET" };
type Notice = [string, string | null];
async function run(opts: { key?: typeof KEY | null; status?: number; json?: unknown; throws?: boolean; age?: number }) {
  const notices: Notice[] = [];
  setCloudTalkFetchForTests(async () => {
    if (opts.throws) throw new Error("network");
    return { status: opts.status ?? 200, json: opts.json ?? null };
  });
  const r = await hydrateCloudTalkCall(
    { businessId: 9, now: NOW },
    event(new Date(NOW.getTime() - (opts.age ?? 60_000))),
    async () => (opts.key === undefined ? KEY : opts.key),
    undefined,
    async (publicId, code) => { notices.push([publicId, code]); }
  ).then((h) => ({ h, err: null as unknown }), (err: unknown) => ({ h: null, err }));
  return { ...r, notices };
}
const answered = { responseData: { data: [{ Cdr: { answered_at: "2026-10-28 08:50:05", is_voicemail: "0" } }] } };

async function main() {
  console.log("\nLeads L1 · G-06 CloudTalk credentials — pure suite\n");

  await test("no API key → deferred 6 h, the connection is told CLOUDTALK_API_KEY_MISSING", async () => {
    const { h, notices } = await run({ key: null });
    assert.equal(h?.kind, "deferred");
    if (h?.kind === "deferred") {
      assert.equal(h.code, "cloudtalk_api_key_missing");
      assert.equal(h.until.getTime(), NOW.getTime() + 6 * 3_600_000);
    }
    assert.deepEqual(notices, [["pub_ct_1", "CLOUDTALK_API_KEY_MISSING"]]);
  });

  await test("CloudTalk refuses the key (401 and 403) → deferred, CLOUDTALK_API_KEY_INVALID, no outcome guessed", async () => {
    for (const status of [401, 403]) {
      const { h, notices } = await run({ status });
      assert.deepEqual([h?.kind, h?.kind === "deferred" ? h.code : null], ["deferred", "cloudtalk_api_key_invalid"]);
      assert.deepEqual(notices, [["pub_ct_1", "CLOUDTALK_API_KEY_INVALID"]]);
    }
  });

  await test("bounded: past the credential wait the receipt dead-letters with the same code (no endless retry)", async () => {
    const justBefore = await run({ status: 401, age: CLOUDTALK_CREDENTIAL_WAIT_MS - 60_000 });
    assert.equal(justBefore.h?.kind, "deferred");
    for (const key of [KEY, null]) {
      const { err, notices } = await run({ key, status: 401, age: CLOUDTALK_CREDENTIAL_WAIT_MS });
      assert.ok(err instanceof IntakeTerminalError, "terminal → markDeadLetter → 30-day payload retention");
      assert.equal((err as IntakeTerminalError).code, key ? "cloudtalk_api_key_invalid" : "cloudtalk_api_key_missing");
      assert.equal(notices.length, 1, "the owner still sees why");
    }
    assert.equal(CLOUDTALK_CREDENTIAL_WAIT_MS, 7 * 24 * 3_600_000);
  });

  await test("transient trouble is not a credential failure: 429 defers 5 min, 5xx / network retry — no notice either way", async () => {
    const limited = await run({ status: 429 });
    assert.deepEqual([limited.h?.kind, limited.h?.kind === "deferred" ? limited.h.code : null], ["deferred", "cloudtalk_rate_limited"]);
    assert.deepEqual(limited.notices, []);
    for (const opts of [{ status: 502 }, { throws: true }]) {
      const { err, notices } = await run(opts);
      assert.ok(err instanceof Error && !(err instanceof IntakeTerminalError), "a plain error → markFailed → backoff");
      assert.deepEqual(notices, []);
    }
  });

  await test("a lookup CloudTalk answers clears the notice and hydrates the real outcome", async () => {
    const { h, notices } = await run({ json: answered });
    assert.equal(h?.kind, "hydrated");
    assert.deepEqual(notices, [["pub_ct_1", null]]);
    const notYet = await run({ json: { responseData: { data: [] } } });
    assert.deepEqual([notYet.h?.kind, notYet.notices], ["deferred", [["pub_ct_1", null]]]);
  });

  await test("the notice carries the endpoint id and a fixed code only — never a number or a key", async () => {
    const all = [...(await run({ key: null })).notices, ...(await run({ status: 401 })).notices];
    const flat = JSON.stringify(all);
    assert.doesNotMatch(flat, /972|5012|KEYID|KEYSECRET/);
    for (const [, code] of all) assert.ok(code === null || (CLOUDTALK_CREDENTIAL_CODES as readonly string[]).includes(code));
  });

  await test("structural: wired for real — the adapter reports health, saving a key clears it and re-arms", async () => {
    const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
    assert.match(read("lib/intake/calls/providers.ts"),
      /setReceivingConnectionIssue\(CLOUDTALK_SOURCE, publicId, code, CLOUDTALK_CREDENTIAL_CODES\)/);
    const route = read("app/api/integrations/acquisition/[id]/route.ts");
    assert.match(route, /setReceivingConnectionIssue\("telephony\.cloudtalk", existing\.publicId, null, CLOUDTALK_CREDENTIAL_CODES\)/);
    assert.match(route, /rearmBlockedEvents\(businessId, "telephony\.cloudtalk", existing\.publicId, CLOUDTALK_CREDENTIAL_CODES\)/);
    const svc = read("lib/intake/acquisition/connection.service.ts");
    const fn = svc.slice(svc.indexOf("export async function setReceivingConnectionIssue("), svc.indexOf("export async function setConnectionHealth("));
    assert.match(fn, /status: "ACTIVE"/);
    assert.doesNotMatch(fn, /status: "ERROR"/, "never ERROR: the endpoint resolver accepts ACTIVE only (ERROR would 401 new calls)");
    const store = read("lib/intake/intake-event.store.ts");
    const from = store.indexOf("export async function rearmBlockedEvents(");
    const rearm = store.slice(from, store.indexOf("\n}\n", from));
    assert.match(rearm, /payloadPurgedAt: null/, "a purged receipt is never re-armed");
    assert.match(rearm, /providerAccountRef,/, "only the connection whose key was fixed");
    assert.match(rearm, /"metadata" - 'deadLetterReportedAt'/, "a re-armed receipt that dead-letters again is reported again (G-07)");
  });

  setCloudTalkFetchForTests(null);
  console.log(`\nALL L1 CLOUDTALK-CREDENTIAL TESTS PASSED — ${checks} checks\n`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
