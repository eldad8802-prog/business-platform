/**
 * Run: npx tsx lib/services/payments/payplus-callback-diagnostics.test.ts
 *
 * The temporary first-callback capture.
 *
 * A diagnostic on a payment callback is exactly the kind of code that leaks
 * something later. So the tests here are mostly ADVERSARIAL: they feed the
 * capture a callback stuffed with secrets, keys, card data and a bypass token,
 * and then assert that none of it can be found anywhere in the serialised
 * record. The capture is also asserted to be completely inert while its switch
 * is unset, because that is the state it ships in.
 *
 * The positive assertions are the reason it exists at all: it must answer the
 * method question, the signed-string question and the retry/duplicate question.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  buildPayPlusCallbackDiagnostic,
  payPlusDiagnosticsEnabled,
} from "./providers/payplus/payplus-callback-diagnostics";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`OK: ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

// Every one of these is planted somewhere a real callback could carry it.
const SECRET_KEY = "sk-live-MUST-NEVER-APPEAR-1234567890";
const API_KEY = "ak-live-MUST-NEVER-APPEAR-0987654321";
const BYPASS = "vercel-bypass-MUST-NEVER-APPEAR";
const CARD = "4580123412341234";
const PAYER_EMAIL = "payer.private@example.com";
const PAYER_NAME = "Some Real Person";

const BODY = JSON.stringify({
  transaction_type: "charge",
  transaction: {
    uid: "TXN-1",
    payment_request_uid: "PRQ-1",
    status_code: "000",
    amount: 150,
    currency: "ILS",
    more_info: "4242",
    credit_card_number: CARD,
  },
  customer: { email: PAYER_EMAIL, name: PAYER_NAME },
});

function build(overrides: Partial<Parameters<typeof buildPayPlusCallbackDiagnostic>[0]> = {}) {
  return buildPayPlusCallbackDiagnostic({
    method: "POST",
    url: `https://preview.example/api/payments/webhook/payplus?x-vercel-protection-bypass=${BYPASS}`,
    headers: {
      "user-agent": "PayPlus",
      "content-type": "application/json",
      hash: "Zm9vYmFyc2lnbmF0dXJl",
      "secret-key": SECRET_KEY,
      "api-key": API_KEY,
      cookie: "session=abc123",
      authorization: "Bearer some-token",
    },
    rawBody: BODY,
    ...overrides,
  });
}

async function main() {
  // --- the switch ----------------------------------------------------------
  ok("absent switch means disabled", payPlusDiagnosticsEnabled({}) === false);
  ok(
    "any value other than 1 means disabled",
    payPlusDiagnosticsEnabled({ PAYPLUS_CALLBACK_DIAGNOSTICS: "true" }) === false &&
      payPlusDiagnosticsEnabled({ PAYPLUS_CALLBACK_DIAGNOSTICS: "0" }) === false &&
      payPlusDiagnosticsEnabled({ PAYPLUS_CALLBACK_DIAGNOSTICS: "" }) === false
  );
  ok(
    "exactly \"1\" enables it",
    payPlusDiagnosticsEnabled({ PAYPLUS_CALLBACK_DIAGNOSTICS: "1" }) === true
  );

  // --- THE LEAK TEST -------------------------------------------------------
  //
  // One assertion over the whole serialised record, because a leak anywhere in
  // it is a leak. This is the test that must never be weakened.
  {
    const serialised = JSON.stringify(build());
    for (const [label, secret] of [
      ["the merchant secret key", SECRET_KEY],
      ["the merchant API key", API_KEY],
      ["a Vercel bypass token in the query string", BYPASS],
      ["the card number", CARD],
      ["the payer email", PAYER_EMAIL],
      ["the payer name", PAYER_NAME],
      ["a cookie value", "session=abc123"],
      ["an authorization header value", "Bearer some-token"],
    ] as [string, string][]) {
      ok(`${label} never appears in the record`, !serialised.includes(secret));
    }
    ok(
      "the request body is never reproduced, in whole or in part",
      !serialised.includes(BODY) && !serialised.includes('"amount":150')
    );
  }

  // --- but the header NAMES survive, which is what makes a leak visible -----
  {
    const d = build();
    ok(
      "header names are recorded so an unexpected header is still noticeable",
      d.headerNames.includes("secret-key") &&
        d.headerNames.includes("authorization") &&
        d.headerNames.includes("cookie")
    );
    ok(
      "only the three allowlisted header values are kept",
      Object.keys(d.headers).sort().join(",") === "content-type,hash,user-agent"
    );
    ok(
      "the query parameter NAME is kept while its value is not",
      d.queryNames.join(",") === "x-vercel-protection-bypass"
    );
    ok(
      "the path is recorded without its query string",
      d.path === "/api/payments/webhook/payplus"
    );
  }

  // --- question 1: which method did PayPlus actually use? ------------------
  {
    ok("a POST is recorded as POST", build().method === "POST");
    const g = build({ method: "GET", rawBody: "" });
    ok("a GET is recorded as GET", g.method === "GET");
    ok(
      "an empty body is visible as such rather than as a hash of nothing",
      g.bodyLength === 0 && g.bodySha256 === null && g.bodyIsJson === false
    );
  }

  // --- question 2: which string was signed? --------------------------------
  //
  // When re-serialising reproduces the received bytes, both candidates are the
  // same string and the ambiguity does not exist for that delivery. That is the
  // answer we most want, and it needs no secret to establish.
  {
    const identical = build({ rawBody: JSON.stringify(JSON.parse(BODY)) });
    ok(
      "byte-identical re-serialisation is reported as such",
      identical.reserializedEqualsRaw === true &&
        identical.reserializedSha256 === identical.bodySha256
    );

    // PayPlus pretty-printing its JSON is precisely the case where the two
    // candidates diverge, and the case the adapter carries two readings for.
    const pretty = build({ rawBody: JSON.stringify(JSON.parse(BODY), null, 2) });
    ok(
      "a differently serialised body is reported as differing",
      pretty.reserializedEqualsRaw === false &&
        pretty.reserializedSha256 !== pretty.bodySha256
    );
    ok(
      "and both digests are recorded so the question can be settled offline",
      typeof pretty.bodySha256 === "string" &&
        typeof pretty.reserializedSha256 === "string"
    );
  }

  // --- questions 5 and 6: retry and duplicate behaviour --------------------
  //
  // The digest is what makes a redelivery legible without keeping the payload.
  {
    const first = build();
    const again = build();
    ok(
      "the same bytes twice produce the same digest — a redelivery is visible",
      first.bodySha256 === again.bodySha256
    );
    const other = build({ rawBody: BODY.replace("TXN-1", "TXN-2") });
    ok(
      "different bytes produce a different digest — a new event is visible",
      other.bodySha256 !== first.bodySha256
    );
    ok(
      "the digest is a real SHA-256 of the body",
      first.bodySha256 === createHash("sha256").update(BODY, "utf8").digest("hex")
    );
  }

  // --- shape, without values ----------------------------------------------
  {
    const d = build();
    ok(
      "top-level key names are recorded",
      d.topLevelKeys.join(",") === "customer,transaction,transaction_type"
    );
    ok(
      "the nested transaction key names are recorded, which is where PayPlus nests",
      d.transactionKeys.includes("payment_request_uid") &&
        d.transactionKeys.includes("more_info")
    );
    ok(
      "recording a key name does NOT record its value",
      d.transactionKeys.includes("credit_card_number") &&
        !JSON.stringify(d).includes(CARD)
    );
  }

  // --- it must never throw -------------------------------------------------
  //
  // A diagnostic that can throw is worse than no diagnostic: it would take down
  // the callback it was added to observe.
  {
    for (const [label, input] of [
      ["a non-JSON body", { rawBody: "not json at all" }],
      ["a JSON array body", { rawBody: "[1,2,3]" }],
      ["a body of JSON null", { rawBody: "null" }],
      ["a relative URL", { url: "/api/payments/webhook/payplus" }],
      ["a malformed URL", { url: "::::" }],
      ["no headers at all", { headers: {} }],
      ["a huge body", { rawBody: "x".repeat(500_000) }],
    ] as [string, Record<string, unknown>][]) {
      let threw: unknown = null;
      try {
        buildPayPlusCallbackDiagnostic({
          method: "POST",
          url: "https://preview.example/api/payments/webhook/payplus",
          headers: {},
          rawBody: "",
          ...(input as object),
        } as Parameters<typeof buildPayPlusCallbackDiagnostic>[0]);
      } catch (err) {
        threw = err;
      }
      ok(`${label} is handled without throwing`, threw === null, String(threw));
    }
    assert.equal(
      buildPayPlusCallbackDiagnostic({
        method: "POST",
        url: "https://preview.example/api/payments/webhook/payplus",
        headers: {},
        rawBody: "[1,2,3]",
      }).topLevelKeys.length,
      0
    );
    ok("an array body yields no key names rather than array indices", true);
  }

  console.log(
    `\npayplus-callback-diagnostics: ${pass} passed, ${failures.length} failed`
  );
  if (failures.length > 0) {
    console.log("FAILURES:\n - " + failures.join("\n - "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
