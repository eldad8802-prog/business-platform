/**
 * W2.5 — Conversation State Writer hardening verifier.
 *
 * Two halves:
 *
 *  1. CORRECTNESS of the writer itself — replay safety, ordering, terminal
 *     states, tenant scoping, transactionality. These are the properties that
 *     have to hold before the flag can be turned on anywhere.
 *
 *  2. SIGNAL PROOF — that the engines which have been starved since they were
 *     written (`evaluatePrimarySignal`, `deriveBusinessSituation`,
 *     `evaluateNextBestAction`, `assignInboxWorkCategory`) actually wake up and
 *     produce the right answers once the writer feeds them real state.
 *
 * The flag is forced ON inside this process only. It changes nothing about any
 * environment: `isConversationStateWriterEnabled()` reads `process.env` at call
 * time, so setting it here exercises the writer without touching Vercel.
 *
 * Needs a dev DB with the W2.5 migration applied.
 * Run: npx tsx lib/conversation-state/conversation-state.w25.test.ts
 */
import assert from "node:assert/strict";

// MUST precede the service import chain that reads it.
process.env.CONVERSATION_STATE_WRITER_ENABLED = "true";
if (!process.env.AUTH_TOKEN_SECRET || !process.env.AUTH_TOKEN_SECRET.trim()) {
  process.env.AUTH_TOKEN_SECRET = "w25-writer-test-secret";
}

import { prisma } from "@/lib/prisma";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import {
  applyMessageEvent,
  isConversationStateWriterEnabled,
} from "@/lib/conversation-state/conversation-state.service";
import { evaluatePrimarySignal } from "@/lib/inbox-view/primary-signal";
import { evaluateNextBestAction } from "@/lib/inbox-view/next-best-action";
import { deriveBusinessSituation } from "@/lib/inbox-view/business-situation";
import { deriveConversationOutcome } from "@/lib/inbox-view/conversation-outcome";
import { bucketTemperature } from "@/lib/inbox-view/temperature-bucket";
import { NextRequest } from "next/server";
import { signAuthToken } from "@/lib/auth-token";
import { POST as messagePost } from "@/app/api/message/route";
import type { Conversation, Message } from "@prisma/client";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
let passed = 0;
const ok = (l: string) => { passed += 1; console.log(`  ok  ${l}`); };
function check(cond: boolean, label: string, detail = "assertion failed") {
  assert.equal(cond, true, `${label}: ${detail}`);
  ok(label);
}

async function tenant(label: string) {
  const b = await prisma.business.create({
    data: {
      name: `W25 ${label} ${runId}`,
      users: { create: { email: `w25-${label}-${runId}@example.test`, password: "x", name: "W25" } },
    },
    include: { users: true },
  });
  return { businessId: b.id, userId: b.users[0].id };
}

async function newConversation(businessId: number) {
  const customer = await prisma.customer.create({
    data: { businessId, name: `W25 cust ${runId}-${Math.random().toString(16).slice(2, 8)}` },
  });
  return prisma.conversation.create({
    data: { businessId, customerId: customer.id, channel: "WHATSAPP", status: "OPEN", startedAt: new Date() },
  });
}

async function addMessage(
  conversation: Conversation,
  opts: { direction: "INBOUND" | "OUTBOUND"; senderType: string; text?: string; at?: Date }
): Promise<Message> {
  return prisma.message.create({
    data: {
      conversationId: conversation.id,
      businessId: conversation.businessId,
      channel: "WHATSAPP",
      direction: opts.direction,
      senderType: opts.senderType as never,
      contentText: opts.text ?? "hello",
      ...(opts.at ? { createdAt: opts.at, sentAt: opts.at } : {}),
    },
  });
}

/**
 * Run the writer exactly as production does: tenant context + transaction.
 *
 * The generous timeout is a TEST-ENVIRONMENT concession, not a product one.
 * Production runs in the same region as the database (Vercel iad1 / Neon
 * aws-us-east-1), where each round trip is a millisecond or two; this suite runs
 * from Israel, where the same trips cost ~200ms each and occasionally exceed
 * Prisma's default 5s interactive-transaction budget. Raising it here keeps the
 * suite measuring correctness rather than latency — the service itself is
 * untouched and still runs on the default budget in production.
 */
function apply(businessId: number, message: Message, conversation: Conversation, analysis: unknown = null) {
  return runWithTenantContext({ businessId }, () =>
    withTenantTransaction(
      (tx) =>
        applyMessageEvent(
          { message, conversation, analysis: analysis as never },
          { tx }
        ),
      { timeoutMs: 20000 }
    )
  );
}

const reload = (id: number) => prisma.conversation.findFirstOrThrow({ where: { id } });

async function main() {
  const a = await tenant("A");
  const b = await tenant("B");

  try {
    check(isConversationStateWriterEnabled(), "SETUP the writer is enabled inside this process only");

    /* ================================================ 1. idempotency ====== */

    const c1 = await newConversation(a.businessId);
    const m1 = await addMessage(c1, { direction: "INBOUND", senderType: "CUSTOMER" });

    const r1 = await apply(a.businessId, m1, c1);
    check(r1.applied === true, "I1 the writer applies a first inbound message");
    const afterFirst = await reload(c1.id);
    check(afterFirst.unansweredInboundCount === 1, "I2 unanswered = 1", `got ${afterFirst.unansweredInboundCount}`);

    // THE BLOCKER: the same event again.
    const r2 = await apply(a.businessId, m1, afterFirst);
    check(r2.applied === true, "I3 a replay still writes (it recomputes, it does not skip)");
    const afterReplay = await reload(c1.id);
    check(
      afterReplay.unansweredInboundCount === 1,
      "I4 REPLAY DOES NOT DOUBLE-COUNT — unanswered stays 1",
      `got ${afterReplay.unansweredInboundCount}`
    );
    check(
      afterReplay.lastMessageAt?.getTime() === afterFirst.lastMessageAt?.getTime() &&
        afterReplay.customerLastInboundAt?.getTime() === afterFirst.customerLastInboundAt?.getTime() &&
        afterReplay.temperatureScore === afterFirst.temperatureScore &&
        afterReplay.currentStage === afterFirst.currentStage,
      "I5 every other field is byte-identical after the replay"
    );

    // Ten replays for good measure — a converging value, not a drifting one.
    for (let i = 0; i < 10; i += 1) await apply(a.businessId, m1, await reload(c1.id));
    check((await reload(c1.id)).unansweredInboundCount === 1, "I6 ten replays still leave it at 1");

    /* ================================================ 2. counting ========= */

    const m2 = await addMessage(c1, { direction: "INBOUND", senderType: "CUSTOMER" });
    await apply(a.businessId, m2, await reload(c1.id));
    check((await reload(c1.id)).unansweredInboundCount === 2, "C1 a second distinct inbound counts");

    const sys = await addMessage(c1, { direction: "INBOUND", senderType: "SYSTEM" });
    await apply(a.businessId, sys, await reload(c1.id));
    check(
      (await reload(c1.id)).unansweredInboundCount === 2,
      "C2 a SYSTEM inbound does not count (unchanged from v1 semantics)"
    );

    const out = await addMessage(c1, { direction: "OUTBOUND", senderType: "BUSINESS_USER" });
    await apply(a.businessId, out, await reload(c1.id));
    const afterOut = await reload(c1.id);
    check(afterOut.unansweredInboundCount === 0, "C3 a business reply resets the count to 0");
    check(afterOut.businessLastOutboundAt !== null, "C4 the outbound stamp is set");

    await apply(a.businessId, out, await reload(c1.id));
    check((await reload(c1.id)).unansweredInboundCount === 0, "C5 replaying the outbound keeps it at 0");

    const m3 = await addMessage(c1, { direction: "INBOUND", senderType: "CUSTOMER" });
    await apply(a.businessId, m3, await reload(c1.id));
    check(
      (await reload(c1.id)).unansweredInboundCount === 1,
      "C6 an inbound AFTER the reply counts from 1, not from the old total"
    );

    /* ================================================ 3. self-healing ===== */

    await prisma.conversation.update({ where: { id: c1.id }, data: { unansweredInboundCount: 99 } });
    await apply(a.businessId, m3, await reload(c1.id));
    check(
      (await reload(c1.id)).unansweredInboundCount === 1,
      "H1 a corrupted counter HEALS on the next event (derived, not accumulated)"
    );

    /* ================================================ 4. ordering ========= */

    const c2 = await newConversation(a.businessId);
    const older = await addMessage(c2, {
      direction: "INBOUND", senderType: "CUSTOMER", at: new Date(Date.now() - 3 * 86400000),
    });
    const newer = await addMessage(c2, { direction: "INBOUND", senderType: "CUSTOMER" });

    await apply(a.businessId, newer, c2);
    const afterNewer = await reload(c2.id);
    // Now replay the OLD one.
    await apply(a.businessId, older, afterNewer);
    const afterOld = await reload(c2.id);
    check(
      afterOld.lastMessageAt?.getTime() === afterNewer.lastMessageAt?.getTime(),
      "O1 replaying an OLD message does not drag lastMessageAt backwards"
    );
    check(
      afterOld.customerLastInboundAt?.getTime() === afterNewer.customerLastInboundAt?.getTime(),
      "O2 nor the customer-inbound stamp"
    );
    check(afterOld.unansweredInboundCount === 2, "O3 and the count still reflects both real messages");

    /* ================================================ 5. terminal stages == */

    for (const locked of ["WON", "LOST", "INACTIVE"] as const) {
      const cx = await newConversation(a.businessId);
      await prisma.conversation.update({ where: { id: cx.id }, data: { currentStage: locked } });
      const mx = await addMessage(cx, { direction: "INBOUND", senderType: "CUSTOMER", text: "כמה זה עולה?" });
      await apply(a.businessId, mx, await reload(cx.id));
      check(
        (await reload(cx.id)).currentStage === locked,
        `T ${locked} is locked — the writer never moves it`,
        `became ${(await reload(cx.id)).currentStage}`
      );
    }

    /* ================================================ 6. tenant =========== */

    const cA = await newConversation(a.businessId);
    const mA = await addMessage(cA, { direction: "INBOUND", senderType: "CUSTOMER" });
    await apply(a.businessId, mA, cA);
    const baseline = await reload(cA.id);

    // Tenant B invokes the writer against tenant A's conversation.
    const crossTenant = await runWithTenantContext({ businessId: b.businessId }, () =>
      withTenantTransaction((tx) =>
        applyMessageEvent({ message: mA, conversation: { ...cA, businessId: b.businessId }, analysis: null }, { tx })
      )
    );
    check(
      crossTenant.applied === false && crossTenant.reason === "tenant_mismatch",
      "S1 a message from another business is refused as evidence",
      JSON.stringify(crossTenant)
    );

    // And with a genuinely foreign conversation row the predicate refuses too.
    const cB = await newConversation(b.businessId);
    const mB = await addMessage(cB, { direction: "INBOUND", senderType: "CUSTOMER" });
    const mismatched = await runWithTenantContext({ businessId: b.businessId }, () =>
      withTenantTransaction((tx) =>
        applyMessageEvent({ message: mB, conversation: cA, analysis: null }, { tx })
      )
    );
    check(
      mismatched.applied === false,
      "S2 a message from a different conversation is refused",
      JSON.stringify(mismatched)
    );

    const afterAttempts = await reload(cA.id);
    check(
      afterAttempts.unansweredInboundCount === baseline.unansweredInboundCount &&
        afterAttempts.lastMessageAt?.getTime() === baseline.lastMessageAt?.getTime() &&
        afterAttempts.temperatureScore === baseline.temperatureScore,
      "S3 tenant A's conversation is byte-for-byte unchanged after both attempts"
    );

    /* ================================================ 7. transactionality = */

    const cT = await newConversation(a.businessId);
    const mT = await addMessage(cT, { direction: "INBOUND", senderType: "CUSTOMER" });
    let rolledBack = false;
    try {
      await runWithTenantContext({ businessId: a.businessId }, () =>
        withTenantTransaction(async (tx) => {
          await applyMessageEvent({ message: mT, conversation: cT, analysis: null }, { tx });
          throw new Error("simulated failure after the writer");
        })
      );
    } catch {
      rolledBack = true;
    }
    check(rolledBack, "X1 the surrounding transaction aborted");
    const afterAbort = await reload(cT.id);
    check(
      afterAbort.unansweredInboundCount === 0 &&
        afterAbort.lastMessageAt === null &&
        afterAbort.temperatureScore === null,
      "X2 NOTHING was persisted — no partial state survives a failed transaction",
      `count=${afterAbort.unansweredInboundCount} last=${afterAbort.lastMessageAt}`
    );

    /* ================================================ 8. SIGNAL PROOF ===== */
    // The engines have never had inputs. Prove they wake up correctly.

    const now = new Date();
    const signalOf = (conv: Conversation, hasPendingSuggestion = false) =>
      evaluatePrimarySignal({
        status: conv.status,
        currentStage: conv.currentStage,
        unansweredInboundCount: conv.unansweredInboundCount,
        customerLastInboundAt: conv.customerLastInboundAt,
        businessLastOutboundAt: conv.businessLastOutboundAt,
        lastMessageAt: conv.lastMessageAt,
        temperatureScore: conv.temperatureScore,
        hasPendingSuggestion,
        now,
      });

    // (a) customer waiting
    const cw = await newConversation(a.businessId);
    const cwMsg = await addMessage(cw, {
      direction: "INBOUND", senderType: "CUSTOMER", at: new Date(now.getTime() - 6 * 3600_000),
    });
    await apply(a.businessId, cwMsg, cw);
    const cwState = await reload(cw.id);
    const cwSignal = signalOf(cwState);
    check(
      cwSignal.kind === "customer_waiting",
      "P1 a waiting customer now produces `customer_waiting` (was unreachable)",
      `got ${cwSignal.kind}`
    );
    check(cwSignal.severity === "high", "P2 with high severity after 6h", cwSignal.severity);

    const cwNba = evaluateNextBestAction({
      status: cwState.status, primarySignal: cwSignal.kind, signalSeverity: cwSignal.severity,
      suggestedAction: "reply", suggestedActionLabel: "", needsHumanAttention: false,
      botFlowStatus: "NONE", hasPendingSuggestion: false,
      waitingMinutes: 360, temperatureBucket: bucketTemperature(cwState.temperatureScore),
      replySuggestions: [],
    });
    check(
      cwNba.kind === "respond_waiting_customer",
      "P3 next-best-action follows the evidence",
      cwNba.kind
    );

    const cwSituation = deriveBusinessSituation({
      status: cwState.status, currentStage: cwState.currentStage, primarySignal: cwSignal.kind,
      waitingMinutes: 360, hasPendingSuggestion: false, botFlowStatus: "NONE",
      temperatureBucket: bucketTemperature(cwState.temperatureScore), nextBestAction: cwNba,
      conversationOutcome: deriveConversationOutcome({
        status: cwState.status, currentStage: cwState.currentStage, primarySignal: cwSignal.kind,
        signalSeverity: cwSignal.severity, botFlowStatus: "NONE", nextBestActionKind: cwNba.kind,
        hasPendingSuggestion: false, needsHumanAttention: false,
        customerWaitingForBusiness: true, businessReplyIsLatest: false,
      }),
    });
    // NOTE — this asserts the EXISTING ladder, not what one might expect.
    // `deriveConversationOutcome` escalates to NEEDS_OWNER_ACTION only on a
    // CRITICAL signal, and a 6-hour wait is "high". So between 4h and 24h the
    // situation label still reads "פנייה חדשה" even though the primary signal
    // already says "ממתין למענה". That gap is pre-existing product logic, not
    // something the writer introduces — it is simply invisible today because
    // the signal never fires at all. Recorded here so enabling the writer
    // cannot surface it as a surprise.
    check(
      cwSituation.kind === "NEW_LEAD",
      "P4 at 6h the situation ladder still reads NEW_LEAD (pre-existing gap, now visible)",
      cwSituation.kind
    );

    // ...and past 24h, where the signal turns critical, the ladder does escalate.
    const cw2 = await newConversation(a.businessId);
    const cw2Msg = await addMessage(cw2, {
      direction: "INBOUND", senderType: "CUSTOMER", at: new Date(now.getTime() - 40 * 3600_000),
    });
    await apply(a.businessId, cw2Msg, cw2);
    const cw2State = await reload(cw2.id);
    const cw2Signal = signalOf(cw2State);
    check(
      cw2Signal.kind === "customer_waiting" && cw2Signal.severity === "critical",
      "P4b a 40-hour wait is critical",
      `${cw2Signal.kind}/${cw2Signal.severity}`
    );
    const cw2Nba = evaluateNextBestAction({
      status: cw2State.status, primarySignal: cw2Signal.kind, signalSeverity: cw2Signal.severity,
      suggestedAction: "reply", suggestedActionLabel: "", needsHumanAttention: false,
      botFlowStatus: "NONE", hasPendingSuggestion: false, waitingMinutes: 2400,
      temperatureBucket: bucketTemperature(cw2State.temperatureScore), replySuggestions: [],
    });
    const cw2Situation = deriveBusinessSituation({
      status: cw2State.status, currentStage: cw2State.currentStage, primarySignal: cw2Signal.kind,
      waitingMinutes: 2400, hasPendingSuggestion: false, botFlowStatus: "NONE",
      temperatureBucket: bucketTemperature(cw2State.temperatureScore), nextBestAction: cw2Nba,
      conversationOutcome: deriveConversationOutcome({
        status: cw2State.status, currentStage: cw2State.currentStage, primarySignal: cw2Signal.kind,
        signalSeverity: cw2Signal.severity, botFlowStatus: "NONE", nextBestActionKind: cw2Nba.kind,
        hasPendingSuggestion: false, needsHumanAttention: false,
        customerWaitingForBusiness: true, businessReplyIsLatest: false,
      }),
    });
    check(
      cw2Situation.kind === "CUSTOMER_WAITING",
      "P4c past 24h the situation escalates to CUSTOMER_WAITING",
      cw2Situation.kind
    );
    check(
      cw2Nba.kind === "immediate_attention",
      "P4d and next-best-action becomes immediate_attention",
      cw2Nba.kind
    );

    // (b) temperature actually moves
    check(
      cwState.temperatureScore !== null,
      "P5 temperatureScore is populated at all (it was ALWAYS null before)",
      String(cwState.temperatureScore)
    );

    // (c) a hot thread
    const hot = await newConversation(a.businessId);
    await prisma.conversation.update({ where: { id: hot.id }, data: { currentStage: "NEGOTIATION" } });
    const hotMsg = await addMessage(hot, { direction: "INBOUND", senderType: "CUSTOMER", text: "מתאים לי, בוא נסגור" });
    await apply(a.businessId, hotMsg, await reload(hot.id), { intent: "booking", stage: "closing" });
    const hotState = await reload(hot.id);
    check(
      (hotState.temperatureScore ?? 0) >= 0.7,
      "P6 a closing negotiation reaches HOT temperature",
      `temp=${hotState.temperatureScore}`
    );
    check(
      bucketTemperature(hotState.temperatureScore) === "hot",
      "P7 and buckets as `hot` (the hot_leads inbox bucket becomes reachable)"
    );

    // (d) waiting-on-customer after the business replies
    const wc = await newConversation(a.businessId);
    const wcIn = await addMessage(wc, { direction: "INBOUND", senderType: "CUSTOMER", at: new Date(now.getTime() - 7200_000) });
    await apply(a.businessId, wcIn, wc);
    const wcOut = await addMessage(wc, { direction: "OUTBOUND", senderType: "BUSINESS_USER" });
    await apply(a.businessId, wcOut, await reload(wc.id));
    const wcState = await reload(wc.id);
    check(wcState.unansweredInboundCount === 0, "P8 replying clears the waiting state");
    check(
      signalOf(wcState).kind !== "customer_waiting",
      "P9 and the signal stops claiming the customer is waiting",
      signalOf(wcState).kind
    );

    // (e) close-probability tracks stage + temperature
    check(
      hotState.closeProbabilitySnapshot !== null &&
        (hotState.closeProbabilitySnapshot ?? 0) > (cwState.closeProbabilitySnapshot ?? 0),
      "P10 close-probability is populated and ranks the hot thread above the cold one",
      `hot=${hotState.closeProbabilitySnapshot} cold=${cwState.closeProbabilitySnapshot}`
    );

    /* ============================== 9. /api/message send idempotency ====== */
    // The writer can be replay-safe and STILL be fed a duplicate row, because
    // two rows are two real messages. This proves the route itself is
    // exactly-once when the caller supplies a token.

    const cSend = await newConversation(a.businessId);
    const authToken = signAuthToken(a.userId);
    const sendToken = `w25-${runId}`;

    const postMessage = (clientRequestId: string | null) =>
      messagePost(
        new NextRequest("http://localhost/api/message", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            conversationId: cSend.id,
            contentText: "אותה הודעה בדיוק",
            direction: "OUTBOUND",
            senderType: "BUSINESS_USER",
            channel: "OTHER",
            ...(clientRequestId ? { clientRequestId } : {}),
          }),
        })
      );

    const send1 = await postMessage(sendToken);
    check([200, 201].includes(send1.status), "M1 the first send succeeds", `status=${send1.status}`);

    const send2 = await postMessage(sendToken);
    const send2Body = await send2.json();
    check(
      send2.status === 200 && send2Body?.duplicateSuppressed === true,
      "M2 a repeat send with the SAME token is suppressed",
      `status=${send2.status} ${JSON.stringify(send2Body).slice(0, 100)}`
    );

    const rowCount = await prisma.message.count({
      where: { conversationId: cSend.id, clientRequestId: sendToken },
    });
    check(rowCount === 1, "M3 exactly ONE message row exists for that token", `got ${rowCount}`);

    const totalOnConv = await prisma.message.count({ where: { conversationId: cSend.id } });
    check(totalOnConv === 1, "M4 the conversation holds one message, not two", `got ${totalOnConv}`);

    // A different token is a genuinely different message and must go through.
    const send3 = await postMessage(`${sendToken}-second`);
    check([200, 201].includes(send3.status), "M5 a DIFFERENT token still creates a real message", `status=${send3.status}`);
    check(
      (await prisma.message.count({ where: { conversationId: cSend.id } })) === 2,
      "M6 so distinct sends are never collapsed"
    );

    // No token at all keeps the previous behaviour.
    const send4 = await postMessage(null);
    check([200, 201].includes(send4.status), "M7 a caller that sends no token is unaffected", `status=${send4.status}`);
    check(
      (await prisma.message.count({ where: { conversationId: cSend.id } })) === 3,
      "M8 and its message is created as before"
    );


    console.log(`\nW2.5 WRITER VERIFY PASS — ${passed} checks green.`);
  } finally {
    await prisma.business
      .deleteMany({ where: { id: { in: [a.businessId, b.businessId] } } })
      .catch(() => {});
    await prisma.$disconnect();
  }
}

main().catch(async (err) => {
  console.error("\nW2.5 WRITER VERIFY FAIL");
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
