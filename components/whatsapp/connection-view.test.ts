/**
 * WhatsApp connection state → what the owner sees. Run with:
 *   npx tsx components/whatsapp/connection-view.test.ts
 *
 * Proves the settings screen represents the server's TRUE state: a failed read
 * is an error (never "connect for the first time"), and a row that is not
 * CONNECTED is shown as what it is instead of disappearing.
 */
import assert from "node:assert/strict";
import { connectionStateFromResponse, settingsViewFor } from "./connection-view";
import { WA_COPY, waConnectErrorText } from "./wa-copy";

const row = (status: string) => ({
  connection: {
    businessId: 7,
    status,
    phoneNumberId: "PN1",
    displayPhoneNumber: "+972 50-000-0000",
    wabaId: "WABA1",
    lastVerifiedAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
    lastErrorMessage: "ignored",
  },
});

let checks = 0;
function test(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}

console.log("\nWhatsApp connection view\n");

test("200 + no row → NO CONNECTION (first-time invitation)", () => {
  const s = connectionStateFromResponse(200, { connection: null });
  assert.equal(settingsViewFor(s).kind, "none");
});

for (const status of [401, 403, 500, 502]) {
  test(`${status} on the status read → CONNECTION LOAD ERROR, never the invitation`, () => {
    const v = settingsViewFor(connectionStateFromResponse(status, null));
    assert.deepEqual(v, { kind: "load_error", httpStatus: status });
  });
}

test("network failure / timeout on the status read → CONNECTION LOAD ERROR", () => {
  assert.deepEqual(settingsViewFor(connectionStateFromResponse(null, null)), { kind: "load_error", httpStatus: null });
});

test("200 with an unreadable body → CONNECTION LOAD ERROR (not proof of 'no connection')", () => {
  assert.equal(settingsViewFor(connectionStateFromResponse(200, null)).kind, "load_error");
  assert.equal(settingsViewFor(connectionStateFromResponse(200, { unexpected: 1 })).kind, "load_error");
});

test("CONNECTED → CONNECTED card with the number and ids", () => {
  const v = settingsViewFor(connectionStateFromResponse(200, row("CONNECTED")));
  assert.equal(v.kind, "connected");
  if (v.kind === "connected") {
    assert.equal(v.connection.displayPhoneNumber, "+972 50-000-0000");
    assert.equal(v.connection.phoneNumberId, "PN1");
    assert.equal(v.connection.wabaId, "WABA1");
    assert.equal(v.connection.updatedAt, "2026-09-28T00:00:00.000Z");
  }
});

for (const status of ["REVOKED_BY_META", "ERROR"]) {
  test(`${status} → CONNECTED BUT NEEDS ATTENTION (the row is shown, with a reason)`, () => {
    const v = settingsViewFor(connectionStateFromResponse(200, row(status)));
    assert.equal(v.kind, "attention");
    assert.ok(WA_COPY.attention[status], "an attention reason exists for this status");
  });
}

for (const status of ["DISCONNECTED", "REVOKED"]) {
  test(`${status} → disconnected view that still names the previous number`, () => {
    const v = settingsViewFor(connectionStateFromResponse(200, row(status)));
    assert.equal(v.kind, "disconnected");
    if (v.kind === "disconnected") assert.equal(v.connection.displayPhoneNumber, "+972 50-000-0000");
    assert.ok(WA_COPY.disconnectedNotice[status], "a notice exists for this status");
  });
}

test("the inbox's contract is unchanged: previousStatus null only when no row exists", () => {
  const none = connectionStateFromResponse(200, { connection: null });
  assert.equal(none.phase, "disconnected");
  if (none.phase === "disconnected") assert.equal(none.previousStatus, null);
  const broken = connectionStateFromResponse(200, row("REVOKED_BY_META"));
  assert.equal(broken.phase, "disconnected");
  if (broken.phase === "disconnected") assert.equal(broken.previousStatus, "REVOKED_BY_META");
});

test("the mapped connection never carries server error text", () => {
  const s = connectionStateFromResponse(200, row("ERROR"));
  assert.equal(JSON.stringify(s).includes("ignored"), false);
});

test("every connect error code has an owner-facing Hebrew line; unknown codes fall back", () => {
  for (const code of [
    "timeout", "popup_blocked", "sdk_unavailable", "config_missing", "meta_error", "missing_code", "missing_ids",
    "no_phone_number", "number_taken", "unauthorized", "forbidden", "meta_failed", "server_error", "network",
  ]) {
    assert.ok(WA_COPY.error.reasons[code], `reason for ${code}`);
    assert.equal(waConnectErrorText(code), WA_COPY.error.reasons[code]);
  }
  assert.equal(waConnectErrorText("something_else"), WA_COPY.error.body);
  assert.equal(waConnectErrorText(null), WA_COPY.error.body);
});

console.log(`\nALL CONNECTION VIEW TESTS PASSED — ${checks} checks\n`);
