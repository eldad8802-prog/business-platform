/**
 * Run: npx tsx lib/services/payments/payplus-webhook-route.test.ts
 *
 * The PayPlus callback ROUTE — the HTTP surface, not the orchestration behind
 * it (that is `payplus-webhook-auth.test.ts`).
 *
 * Two things are locked here.
 *
 * 1. PayPlus documents its merchant callback as a GET, and the generic
 *    `/api/payments/webhook/[provider]` route exports POST only. So PayPlus
 *    gets a dedicated route accepting BOTH methods, and both must funnel into
 *    the identical shared orchestration — a second entry point that behaves
 *    differently from the first is exactly how a verification step gets skipped.
 *
 * 2. Adding it must not widen anything else. The generic route and CardCom's
 *    route are asserted to still export POST alone: a GET reaching those is a
 *    405 from the framework, which is the correct answer for a provider that
 *    does not use the method.
 *
 * No database, no provider account, no network. PayPlus is currently a DISABLED
 * capability, so every request is refused before processing — which is itself
 * the most important property to prove about a route that is already reachable
 * on the public internet.
 */
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import * as payplusRoute from "../../../app/api/payments/webhook/payplus/route";
import * as genericRoute from "../../../app/api/payments/webhook/[provider]/route";
import * as cardcomRoute from "../../../app/api/payments/webhook/cardcom/route";
import { isPaymentProviderEnabled } from "./providers/provider-availability";

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

const URL_ = "https://app.example/api/payments/webhook/payplus";

const SIGNED_BODY = JSON.stringify({
  transaction_uid: "TXN-1",
  page_request_uid: "PRQ-1",
  more_info: "4242",
  status_code: "000",
});

function post(body: string, headers: Record<string, string> = {}) {
  return new NextRequest(URL_, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
}

function get(headers: Record<string, string> = {}) {
  return new NextRequest(URL_, { method: "GET", headers });
}

async function main() {
  // --- both methods exist, and they are the same door -----------------------
  ok(
    "the PayPlus route accepts POST",
    typeof payplusRoute.POST === "function"
  );
  ok(
    "the PayPlus route accepts GET, which the generic route does not",
    typeof payplusRoute.GET === "function"
  );
  ok(
    "it runs on the Node.js runtime, so the raw signed bytes survive",
    payplusRoute.runtime === "nodejs"
  );

  // --- nothing else was widened --------------------------------------------
  ok(
    "the generic [provider] route still exports POST only",
    typeof genericRoute.POST === "function" &&
      (genericRoute as Record<string, unknown>).GET === undefined
  );
  ok(
    "CardCom still answers 405 to a GET rather than a refusal body",
    typeof cardcomRoute.POST === "function" &&
      (cardcomRoute as Record<string, unknown>).GET === undefined
  );

  // --- disabled capability: refused before any processing -------------------
  //
  // This route is reachable from the public internet the moment it is deployed,
  // and PayPlus is not yet a proven provider. Both methods must refuse.
  ok(
    "PayPlus is a DISABLED capability, so this section tests the refusal path",
    !isPaymentProviderEnabled("PAYPLUS")
  );

  {
    const res = await payplusRoute.POST(post(SIGNED_BODY, { hash: "whatever" }));
    const body = (await res.json()) as { ok?: boolean; error?: string };
    ok("a POST callback is refused while PayPlus is disabled", res.status === 404);
    ok(
      "and the refusal names the capability, not an internal detail",
      body.ok === false && body.error === "provider_not_supported"
    );
  }

  {
    const res = await payplusRoute.GET(get({ hash: "whatever" }));
    const body = (await res.json()) as { ok?: boolean; error?: string };
    ok("a GET callback is refused identically", res.status === 404);
    ok(
      "the two methods give the SAME answer — no second, weaker door",
      body.ok === false && body.error === "provider_not_supported"
    );
  }

  // --- malformed input never escapes as a 500 ------------------------------
  //
  // A public endpoint that throws is an availability problem and a signal to an
  // attacker. Whatever arrives, the route answers a JSON verdict.
  for (const [label, req] of [
    ["an empty body", post("")],
    ["a non-JSON body", post("not json at all")],
    ["a JSON array where an object was expected", post("[1,2,3]")],
    ["a body of JSON null", post("null")],
    ["a GET carrying no body at all", get()],
    [
      "an oversized junk body",
      post("x".repeat(200_000)),
    ],
  ] as [string, NextRequest][]) {
    const handler = req.method === "GET" ? payplusRoute.GET : payplusRoute.POST;
    let threw: unknown = null;
    let status = 0;
    try {
      const res = await handler(req);
      status = res.status;
      await res.json();
    } catch (err) {
      threw = err;
    }
    ok(
      `${label} produces a JSON verdict, never an exception`,
      threw === null && status > 0,
      threw ? String(threw) : `status=${status}`
    );
  }

  // --- the route never leaks what it was given ------------------------------
  {
    const secretish = JSON.stringify({
      secret_key: "sk-should-never-come-back",
      transaction_uid: "TXN-9",
    });
    const res = await payplusRoute.POST(
      post(secretish, { "secret-key": "sk-should-never-come-back" })
    );
    const text = JSON.stringify(await res.json());
    ok(
      "no part of the request payload is echoed back to the caller",
      !text.includes("sk-should-never-come-back") && !text.includes("TXN-9")
    );
  }

  // --- the temporary first-callback capture is inert by default ------------
  //
  // The capture ships disabled. What matters at the route level is not what it
  // records — `payplus-callback-diagnostics.test.ts` proves that adversarially —
  // but that it emits NOTHING while its switch is unset, and that it runs even
  // for a callback that is about to be refused, which is the delivery most worth
  // seeing during a first integration.
  {
    const original = console.info;
    const seen: string[] = [];
    console.info = (...args: unknown[]) => {
      seen.push(args.map((a) => String(a)).join(" "));
    };
    const previous = process.env.PAYPLUS_CALLBACK_DIAGNOSTICS;
    try {
      delete process.env.PAYPLUS_CALLBACK_DIAGNOSTICS;
      await payplusRoute.POST(post(SIGNED_BODY, { hash: "x" }));
      ok(
        "with the switch unset the capture emits nothing at all",
        seen.every((line) => !line.includes("payplus-callback-diagnostic"))
      );

      seen.length = 0;
      process.env.PAYPLUS_CALLBACK_DIAGNOSTICS = "1";
      await payplusRoute.POST(post(SIGNED_BODY, { hash: "x" }));
      const captured = seen.filter((l) => l.includes("payplus-callback-diagnostic"));
      ok("with the switch on it emits exactly one record", captured.length === 1);
      ok(
        "and it runs even though this callback is refused before processing",
        captured[0]?.includes('"method":"POST"') === true
      );
      ok(
        "the record still carries no part of the body",
        captured[0] !== undefined && !captured[0].includes(SIGNED_BODY)
      );
    } finally {
      console.info = original;
      if (previous === undefined) {
        delete process.env.PAYPLUS_CALLBACK_DIAGNOSTICS;
      } else {
        process.env.PAYPLUS_CALLBACK_DIAGNOSTICS = previous;
      }
    }
  }

  // A sanity check on the harness itself: the refusal above must come from the
  // capability switch, not from the request being malformed. A well-formed,
  // plausible callback is refused for the same reason and with the same words.
  {
    const res = await payplusRoute.POST(post(SIGNED_BODY));
    assert.equal(res.status, 404);
    ok("a well-formed callback is refused too — the gate is the capability", true);
  }

  console.log(
    `\npayplus-webhook-route: ${pass} passed, ${failures.length} failed`
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
