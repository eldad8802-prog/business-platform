/**
 * CardCom reversal — refund, void, and the difference between a refusal and
 * silence.
 *
 * WHY THIS FILE EXISTS
 *
 * Every other call in this adapter may throw when the network fails, because a
 * payment that was never created simply is not created. A reversal inverts
 * that: the instruction may have arrived and executed, and only the answer may
 * have been lost. The domain releases a reservation when the adapter throws —
 * so an adapter that throws on a timeout is an adapter that authorises a second
 * refund for money that already left.
 *
 * That single distinction is what most of this file is about:
 *
 *   CardCom says "no"        → throws        → the domain releases
 *   the network says nothing → UNKNOWN       → the domain keeps holding
 *
 * The contract under test is CardCom's own, read from the official v11
 * OpenAPI: POST /api/v11/Transactions/RefundByTransactionId, required
 * ApiName + ApiPassword + TransactionId, with PartialSum for a partial
 * reversal, CancelOnly for a pre-deposit void, and AllowMultipleRefunds to
 * permit more than one.
 *
 * No network. The HTTP client is injected.
 *
 * Run: npx tsx lib/services/payments/providers/cardcom/cardcom-reversal.test.ts
 */
import {
  cardComDescriptor,
  createCardComProvider,
  externalRefundReference,
  type CardComHttpResponse,
} from "./cardcom.provider";
import type { RefundPaymentInput, RefundStatusInput } from "../payment-provider.types";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

type Call = { url: string; body: Record<string, unknown> };

/** Records what was sent and replays a scripted answer. */
function harness(
  answer: () => Promise<CardComHttpResponse> | CardComHttpResponse
) {
  const calls: Call[] = [];
  const provider = createCardComProvider({
    baseUrl: "https://cardcom.test",
    publicBaseUrl: "https://dubiz.test",
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return answer();
    },
  });
  return { provider, calls };
}

const jsonResponse = (status: number, body: unknown): CardComHttpResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const CREDENTIAL = JSON.stringify({ apiName: "cardtest26", apiPassword: "cardcom26" });

function refundInput(over: Partial<RefundPaymentInput> = {}): RefundPaymentInput {
  return {
    merchantId: "1000",
    credential: CREDENTIAL,
    amount: "5.00",
    currency: "ILS",
    description: "QA reversal",
    paymentRequestId: 6,
    intent: "REFUND",
    reversalId: 77,
    settlement: {
      providerTransactionId: "253736273",
      amount: "5.00",
      currency: "ILS",
      rawPayload: null,
    },
    ...over,
  };
}

function statusInput(over: Partial<RefundStatusInput> = {}): RefundStatusInput {
  return {
    merchantId: "1000",
    credential: CREDENTIAL,
    providerRefundId: "999111",
    reversalId: 77,
    amount: "5.00",
    settlement: {
      providerTransactionId: "253736273",
      amount: "5.00",
      currency: "ILS",
      rawPayload: null,
    },
    ...over,
  };
}

async function main() {
  console.log("CardCom reversal\n");

  // ---------------------------------------------------- the request shape ---
  {
    const { provider, calls } = harness(() =>
      jsonResponse(200, { ResponseCode: 0, Description: "OK", NewTranzactionId: 999111 })
    );
    const result = await provider.refundPayment!(refundInput({ amount: "5.00" }));

    ok("a full refund reports REFUNDED", result.outcome === "REFUNDED");
    ok("and carries CardCom's own id for the reversal", result.providerRefundId === "999111");
    ok("the provider was called exactly once", calls.length === 1);
    ok(
      "on the documented refund endpoint",
      calls[0]!.url.endsWith("/api/v11/Transactions/RefundByTransactionId"),
      calls[0]!.url
    );

    const body = calls[0]!.body;
    ok("it sends the API name", body.ApiName === "cardtest26");
    ok(
      "it sends the API password, which this endpoint requires",
      body.ApiPassword === "cardcom26"
    );
    ok(
      "it reverses the original numeric transaction id",
      body.TransactionId === 253736273
    );
    ok(
      "it carries our own stable reference for this intent",
      body.ExternalRefundDealId === externalRefundReference(77)
    );
    ok("a refund is not a cancellation", body.CancelOnly === false);
    ok(
      "a full refund sends no PartialSum",
      !Object.prototype.hasOwnProperty.call(body, "PartialSum")
    );
  }

  // ------------------------------------------------------ partial refund ---
  {
    const { provider, calls } = harness(() =>
      jsonResponse(200, { ResponseCode: 0, NewTranzactionId: 999112 })
    );
    const result = await provider.refundPayment!(refundInput({ amount: "2.00" }));
    ok("a partial refund settles", result.outcome === "REFUNDED");
    ok("and sends PartialSum", calls[0]!.body.PartialSum === 2);
    ok(
      "and permits CardCom to accept a later second part",
      calls[0]!.body.AllowMultipleRefunds === true
    );
  }

  // --------------------------------------------------------------- void ---
  {
    const { provider, calls } = harness(() =>
      jsonResponse(200, { ResponseCode: 0, NewTranzactionId: 999113 })
    );
    const result = await provider.refundPayment!(
      refundInput({ intent: "VOID", amount: "5.00" })
    );
    ok("a void settles", result.outcome === "REFUNDED");
    ok("and asks CardCom to cancel rather than refund", calls[0]!.body.CancelOnly === true);
    ok(
      "a void never asks for multiple reversals",
      calls[0]!.body.AllowMultipleRefunds === false
    );
  }

  // ------------------------------------- a verdict versus silence ----------
  {
    // CardCom answered, and the answer is no. The domain must release.
    const { provider } = harness(() =>
      jsonResponse(200, { ResponseCode: 6, Description: "עסקה לא נמצאה" })
    );
    let threw: unknown = null;
    try {
      await provider.refundPayment!(refundInput());
    } catch (error) {
      threw = error;
    }
    ok("an authoritative refusal THROWS", threw !== null);
    ok(
      "and carries CardCom's reason",
      threw instanceof Error && /עסקה לא נמצאה/.test(threw.message),
      threw instanceof Error ? threw.message : String(threw)
    );
  }

  {
    // The connection died. The instruction may have executed.
    const { provider } = harness(() => {
      throw new Error("ECONNRESET");
    });
    const result = await provider.refundPayment!(refundInput());
    ok("a transport failure is UNKNOWN, never a refusal", result.outcome === "UNKNOWN");
    ok("and names no reversal", result.providerRefundId === null);
  }

  {
    const { provider } = harness(() => jsonResponse(504, { }));
    const result = await provider.refundPayment!(refundInput());
    ok("a gateway timeout is UNKNOWN", result.outcome === "UNKNOWN");
  }

  {
    const { provider } = harness(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    }));
    const result = await provider.refundPayment!(refundInput());
    ok("an unreadable body is UNKNOWN", result.outcome === "UNKNOWN");
  }

  {
    const { provider } = harness(() => jsonResponse(200, { Something: "else" }));
    const result = await provider.refundPayment!(refundInput());
    ok(
      "a 200 with no response code establishes nothing",
      result.outcome === "UNKNOWN"
    );
  }

  // ------------------------------------------------ configuration errors ---
  {
    const { provider, calls } = harness(() => jsonResponse(200, { ResponseCode: 0 }));
    let threw: unknown = null;
    try {
      await provider.refundPayment!(
        refundInput({ credential: JSON.stringify({ apiName: "x", apiPassword: "" }) })
      );
    } catch (error) {
      threw = error;
    }
    ok("a missing API password is refused before anything is sent", threw !== null);
    ok("and nothing reached the provider", calls.length === 0);
  }

  {
    const { provider, calls } = harness(() => jsonResponse(200, { ResponseCode: 0 }));
    let threw: unknown = null;
    try {
      await provider.refundPayment!(
        refundInput({
          settlement: {
            providerTransactionId: null,
            amount: "5.00",
            currency: "ILS",
            rawPayload: null,
          },
        })
      );
    } catch (error) {
      threw = error;
    }
    ok("a payment with no CardCom transaction id cannot be reversed", threw !== null);
    ok("and nothing was sent", calls.length === 0);
  }

  // ------------------------------------------------------- verification ---
  {
    const { provider, calls } = harness(() =>
      jsonResponse(200, [{ InternalDealNumber: 999111, DealType61: "53" }])
    );
    const status = await provider.getRefundStatus!(statusInput());
    ok("a reversal CardCom holds verifies as REFUNDED", status.outcome === "REFUNDED");
    ok(
      "asked on the documented transaction-info endpoint",
      calls[0]!.url.endsWith("/api/v11/Transactions/GetTransactionInfoById")
    );
    ok(
      "by the reversal's own deal number",
      calls[0]!.body.InternalDealNumber === 999111
    );
    ok("with the terminal", calls[0]!.body.TerminalNumber === 1000);
  }

  {
    const { provider, calls } = harness(() => jsonResponse(200, []));
    const status = await provider.getRefundStatus!(
      statusInput({ providerRefundId: null })
    );
    ok(
      "with no reversal id, verification answers UNKNOWN",
      status.outcome === "UNKNOWN"
    );
    ok("and never guesses by asking a broad query", calls.length === 0);
    ok(
      "and says why, for the person who has to investigate",
      /no documented query/.test(status.detail ?? ""),
      status.detail ?? ""
    );
  }

  {
    const { provider } = harness(() => {
      throw new Error("ETIMEDOUT");
    });
    const status = await provider.getRefundStatus!(statusInput());
    ok("verification that cannot reach CardCom is UNKNOWN", status.outcome === "UNKNOWN");
  }

  {
    const { provider } = harness(() => jsonResponse(200, []));
    const status = await provider.getRefundStatus!(statusInput());
    ok(
      "an empty result is UNKNOWN, not a rejection",
      status.outcome === "UNKNOWN",
      "absence of a row is not a statement that it never happened"
    );
  }

  // ------------------------------------------------------- capabilities ---
  {
    const c = cardComDescriptor.capabilities;
    ok("CardCom declares refund", c.refund === true);
    ok("CardCom declares partial refund", c.partialRefund === true);
    ok("CardCom declares void", c.void === true);
    ok("CardCom declares refund verification", c.refundVerification === true);
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    console.log("CARDCOM REVERSAL: FAIL");
    process.exit(1);
  }
  console.log("CARDCOM REVERSAL: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
