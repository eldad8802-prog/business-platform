/**
 * D2 / P7-W4A — signed Gmail OAuth state proofs (tsx-runnable, no network).
 *
 *   AUTH_TOKEN_SECRET=test-secret npx tsx lib/services/integrations/gmail/signed-state.service.test.ts
 */
process.env.AUTH_TOKEN_SECRET =
  process.env.AUTH_TOKEN_SECRET || "w4a-test-secret-not-a-real-secret";

import {
  createSignedGmailState,
  verifySignedGmailState,
  GMAIL_STATE_TTL_SECONDS,
} from "./signed-state.service";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

function tamperPayload(
  state: string,
  mutate: (p: Record<string, unknown>) => void
): string {
  const [payloadB64, sig] = state.split(".");
  const payload = JSON.parse(
    Buffer.from(payloadB64, "base64url").toString("utf8")
  ) as Record<string, unknown>;
  mutate(payload);
  return (
    Buffer.from(JSON.stringify(payload), "utf8").toString("base64url") +
    "." +
    sig
  );
}

function main(): void {
  // Valid round-trip binds the tenant.
  const state = createSignedGmailState({ businessId: 7, userId: 3 });
  const v = verifySignedGmailState(state);
  ok("valid state verifies", v.ok);
  if (v.ok) {
    ok("verified businessId = 7", v.state.businessId === 7);
    ok("verified userId = 3", v.state.userId === 3);
    ok("nonce present", v.state.nonce.length > 0);
  }

  // Two states for the same tenant differ (fresh nonce).
  const state2 = createSignedGmailState({ businessId: 7, userId: 3 });
  ok("states are unique per issuance", state !== state2);

  // businessId tampering → bad signature.
  const forgedBiz = tamperPayload(state, (p) => {
    p.businessId = 999;
  });
  const vb = verifySignedGmailState(forgedBiz);
  ok(
    "tampered businessId rejected",
    !vb.ok && vb.reason === "bad_signature",
    JSON.stringify(vb)
  );

  // nonce tampering → bad signature.
  const forgedNonce = tamperPayload(state, (p) => {
    p.nonce = "attacker-nonce";
  });
  const vn = verifySignedGmailState(forgedNonce);
  ok("tampered nonce rejected", !vn.ok && vn.reason === "bad_signature");

  // Signature swap between two valid states → bad signature.
  const [p1] = state.split(".");
  const [, s2] = state2.split(".");
  const spliced = `${p1}.${s2}`;
  const vs = verifySignedGmailState(spliced);
  ok("signature from another state rejected", !vs.ok && vs.reason === "bad_signature");

  // Expiry.
  const expired = verifySignedGmailState(
    state,
    Date.now() + (GMAIL_STATE_TTL_SECONDS + 5) * 1000
  );
  ok("expired state rejected", !expired.ok && expired.reason === "expired");

  // Wrong purpose: re-sign a payload with a different purpose using the same
  // key would require the signer — a payload-tampered purpose fails signature,
  // which is the enforced boundary.
  const forgedPurpose = tamperPayload(state, (p) => {
    p.purpose = "tax-oauth-state";
  });
  const vp = verifySignedGmailState(forgedPurpose);
  ok("wrong-purpose (tampered) rejected", !vp.ok && vp.reason === "bad_signature");

  // Malformed inputs never throw.
  for (const junk of [null, "", "abc", "a.b.c", "onlypayload.", ".onlysig", "x".repeat(3000)]) {
    const r = verifySignedGmailState(junk as string | null);
    ok(`malformed input (${String(junk).slice(0, 12) || "empty"}) rejected`, !r.ok);
  }

  // An auth Bearer token must not validate as a Gmail state (purpose/key
  // separation) — simulate with a same-shape envelope signed differently.
  const bogus =
    Buffer.from(
      JSON.stringify({ v: 1, purpose: "gmail-oauth-state", businessId: 7, userId: 3, nonce: "n", iat: 0, exp: 9999999999 }),
      "utf8"
    ).toString("base64url") + "." + Buffer.from("not-a-real-sig").toString("base64url");
  ok("foreign-signed envelope rejected", !verifySignedGmailState(bogus).ok);

  console.log(`\n[signed-state.test] PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
  console.log("ALL CHECKS PASS");
}

main();
