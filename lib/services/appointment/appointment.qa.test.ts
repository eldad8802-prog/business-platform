/**
 * QA harness for the Appointment service layer (Step 2).
 *
 *   npx tsx lib/services/appointment/appointment.qa.test.ts
 *
 * DB-backed, deterministic, no browser / no UI / no routes. Creates an isolated
 * throwaway Business + User + Conversations, exercises the service end-to-end,
 * and tears everything down at the end (FK-safe order).
 *
 * Coverage: happy path (create + createFromPending), lifecycle (allowed +
 * forbidden; through the locked primitive since P0-2), duplicate prevention, atomic rollback, actor handling, tenant
 * isolation, edge cases (no_pending / pending_malformed / invalid_input).
 */

import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import * as appt from "./appointment.service";
import { lockBusinessAppointments } from "./appointment-request";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import {
  ALLOWED_TRANSITIONS,
  assertTransition,
  canTransition,
} from "./appointment.lifecycle";
import type { ActorContext, AppointmentResult } from "./appointment.types";
import type { AppointmentStatus } from "@prisma/client";

type CaseResult = { group: string; name: string; ok: boolean; detail?: string };
const results: CaseResult[] = [];

async function record(group: string, name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ group, name, ok: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ group, name, ok: false, detail });
  }
}

/**
 * A lifecycle move as every product path makes it (P0-2: the lock-less confirm / complete / markNoShow / cancel
 * wrappers are removed): a tenant transaction, the per-business lock, then the one primitive, transitionWithinTx.
 */
function lifecycle(
  to: AppointmentStatus,
  input: { appointmentId: number; businessId: number; actor: ActorContext; reason?: string }
): Promise<AppointmentResult> {
  return tenantTx(input.businessId, async (tx) => {
    await lockBusinessAppointments(tx, input.businessId);
    const current = await tx.appointment.findFirst({ where: { id: input.appointmentId, businessId: input.businessId } });
    if (!current) return { ok: false, reason: "appointment_not_found" };
    return appt.transitionWithinTx(tx, current, to, input.actor, input.reason ? { appendNote: input.reason } : {});
  });
}

const ALL_STATUSES: AppointmentStatus[] = [
  "PROPOSED",
  "CONFIRMED",
  "COMPLETED",
  "NO_SHOW",
  "CANCELED",
];

async function main() {
  // ── Setup ────────────────────────────────────────────────────────────────
  const business = await prisma.business.create({
    data: { name: "QA Appointment Biz" },
  });
  const otherBusiness = await prisma.business.create({
    data: { name: "QA Appointment Other Biz" },
  });
  const user = await prisma.user.create({
    data: {
      email: `qa-appt-${Date.now()}@test.local`,
      password: "x",
      businessId: business.id,
    },
  });

  const ownerActor: ActorContext = {
    actor: "OWNER",
    userId: user.id,
    sourceChannel: "INBOX_WEB",
  };

  async function makeConversation(): Promise<number> {
    const c = await prisma.conversation.create({
      data: { businessId: business.id, channel: "WHATSAPP" },
    });
    return c.id;
  }

  async function makeMessage(conversationId: number): Promise<number> {
    const m = await prisma.message.create({
      data: {
        conversationId,
        businessId: business.id,
        channel: "WHATSAPP",
        direction: "INBOUND",
        senderType: "CUSTOMER",
        contentText: "מתי אפשר להגיע?",
      },
    });
    return m.id;
  }

  async function makeConversationWithPending(
    customerHint: string | null
  ): Promise<{ conversationId: number; messageId: number }> {
    const conversationId = await makeConversation();
    const messageId = await makeMessage(conversationId);
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        pendingAppointmentRequest: {
          createdAt: new Date().toISOString(),
          createdByOwnerId: user.id,
          originMessageId: messageId,
          customerHint,
        },
      },
    });
    return { conversationId, messageId };
  }

  try {
    // ── 1. Happy path: createFromPending ────────────────────────────────────
    await record("happy / createFromPending", "*", async () => {
      const { conversationId, messageId } = await makeConversationWithPending(
        "יום חמישי אחר הצהריים"
      );
      const res = await appt.createFromPending({
        conversationId,
        businessId: business.id,
        actor: ownerActor,
      });
      assert.ok(res.ok, `expected ok, got ${JSON.stringify(res)}`);
      if (res.ok) {
        assert.equal(res.appointment.status, "PROPOSED");
        assert.equal(res.appointment.notes, "יום חמישי אחר הצהריים");
        assert.equal(res.appointment.sourceConversationId, conversationId);
        assert.equal(res.appointment.sourceMessageId, messageId);
        assert.equal(res.appointment.createdByActor, "OWNER");
        assert.equal(res.appointment.sourceChannel, "INBOX_WEB");
        assert.equal(res.appointment.createdByUserId, user.id);
        assert.equal(res.appointment.businessId, business.id);
      }
      // pending cleared
      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { pendingAppointmentRequest: true },
      });
      assert.equal(conv?.pendingAppointmentRequest, null);
    });

    // ── 2. Happy path: direct create ────────────────────────────────────────
    await record("happy / create (direct)", "*", async () => {
      const conversationId = await makeConversation();
      const res = await appt.create({
        businessId: business.id,
        actor: ownerActor,
        links: { conversationId },
        details: { title: "פגישת ייעוץ", durationMinutes: 30 },
      });
      assert.ok(res.ok, JSON.stringify(res));
      if (res.ok) {
        assert.equal(res.appointment.status, "PROPOSED");
        assert.equal(res.appointment.title, "פגישת ייעוץ");
        assert.equal(res.appointment.durationMinutes, 30);
      }
    });

    // ── 3. Duplicate prevention: already_converted ──────────────────────────
    await record("duplicate / create then createFromPending", "*", async () => {
      const { conversationId } = await makeConversationWithPending("hint");
      // direct create makes an active appointment WITHOUT clearing pending
      const first = await appt.create({
        businessId: business.id,
        actor: ownerActor,
        links: { conversationId },
      });
      assert.ok(first.ok);
      // pending still present -> conversion must refuse
      const second = await appt.createFromPending({
        conversationId,
        businessId: business.id,
        actor: ownerActor,
      });
      assert.ok(!second.ok && second.reason === "already_converted", JSON.stringify(second));
      // exactly one appointment for the conversation
      const count = await prisma.appointment.count({
        where: { sourceConversationId: conversationId },
      });
      assert.equal(count, 1);
    });

    await record("duplicate / create twice same conversation", "*", async () => {
      const conversationId = await makeConversation();
      const a = await appt.create({
        businessId: business.id,
        actor: ownerActor,
        links: { conversationId },
      });
      assert.ok(a.ok);
      const b = await appt.create({
        businessId: business.id,
        actor: ownerActor,
        links: { conversationId },
      });
      assert.ok(!b.ok && b.reason === "already_converted", JSON.stringify(b));
    });

    await record("duplicate / CANCELED does not block new", "*", async () => {
      const conversationId = await makeConversation();
      const a = await appt.create({
        businessId: business.id,
        actor: ownerActor,
        links: { conversationId },
      });
      assert.ok(a.ok);
      if (a.ok) {
        const c = await lifecycle("CANCELED", {
          appointmentId: a.appointment.id,
          businessId: business.id,
          actor: ownerActor,
        });
        assert.ok(c.ok);
      }
      const b = await appt.create({
        businessId: business.id,
        actor: ownerActor,
        links: { conversationId },
      });
      assert.ok(b.ok, `CANCELED should not block: ${JSON.stringify(b)}`);
    });

    // ── 4. Atomic rollback ──────────────────────────────────────────────────
    await record("atomicity / rollback leaves pending intact", "*", async () => {
      const { conversationId } = await makeConversationWithPending("rollback-hint");
      let threw = false;
      try {
        // non-existent createdByUserId -> FK violation inside the tx -> rollback
        await appt.createFromPending({
          conversationId,
          businessId: business.id,
          actor: { actor: "OWNER", userId: 2_000_000_000, sourceChannel: "INBOX_WEB" },
        });
      } catch {
        threw = true;
      }
      assert.ok(threw, "expected FK failure to throw");
      // pending NOT cleared
      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { pendingAppointmentRequest: true },
      });
      assert.notEqual(conv?.pendingAppointmentRequest, null);
      // no appointment created
      const count = await prisma.appointment.count({
        where: { sourceConversationId: conversationId },
      });
      assert.equal(count, 0);
    });

    // ── 5. Lifecycle — allowed ──────────────────────────────────────────────
    await record("lifecycle / PROPOSED->CONFIRMED->COMPLETED", "*", async () => {
      const a = await appt.create({ businessId: business.id, actor: ownerActor });
      assert.ok(a.ok);
      if (!a.ok) return;
      const c1 = await lifecycle("CONFIRMED", {
        appointmentId: a.appointment.id,
        businessId: business.id,
        actor: ownerActor,
      });
      assert.ok(c1.ok && c1.appointment.status === "CONFIRMED");
      const c2 = await lifecycle("COMPLETED", {
        appointmentId: a.appointment.id,
        businessId: business.id,
        actor: ownerActor,
      });
      assert.ok(c2.ok && c2.appointment.status === "COMPLETED");
    });

    await record("lifecycle / CONFIRMED->NO_SHOW", "*", async () => {
      const a = await appt.create({ businessId: business.id, actor: ownerActor });
      assert.ok(a.ok);
      if (!a.ok) return;
      await lifecycle("CONFIRMED", { appointmentId: a.appointment.id, businessId: business.id, actor: ownerActor });
      const r = await lifecycle("NO_SHOW", {
        appointmentId: a.appointment.id,
        businessId: business.id,
        actor: ownerActor,
      });
      assert.ok(r.ok && r.appointment.status === "NO_SHOW");
    });

    await record("lifecycle / PROPOSED->CANCELED", "*", async () => {
      const a = await appt.create({ businessId: business.id, actor: ownerActor });
      assert.ok(a.ok);
      if (!a.ok) return;
      const r = await lifecycle("CANCELED", {
        appointmentId: a.appointment.id,
        businessId: business.id,
        actor: ownerActor,
        reason: "לקוח ביטל",
      });
      assert.ok(r.ok && r.appointment.status === "CANCELED");
      assert.ok((r.appointment.notes ?? "").includes("לקוח ביטל"));
    });

    // ── 6. Lifecycle — forbidden ────────────────────────────────────────────
    await record("lifecycle / PROPOSED->COMPLETED forbidden", "*", async () => {
      const a = await appt.create({ businessId: business.id, actor: ownerActor });
      assert.ok(a.ok);
      if (!a.ok) return;
      const r = await lifecycle("COMPLETED", {
        appointmentId: a.appointment.id,
        businessId: business.id,
        actor: ownerActor,
      });
      assert.ok(!r.ok && r.reason === "invalid_transition", JSON.stringify(r));
    });

    await record("lifecycle / terminal CANCELED->CONFIRMED forbidden", "*", async () => {
      const a = await appt.create({ businessId: business.id, actor: ownerActor });
      assert.ok(a.ok);
      if (!a.ok) return;
      await lifecycle("CANCELED", { appointmentId: a.appointment.id, businessId: business.id, actor: ownerActor });
      const r = await lifecycle("CONFIRMED", {
        appointmentId: a.appointment.id,
        businessId: business.id,
        actor: ownerActor,
      });
      assert.ok(!r.ok && r.reason === "invalid_transition", JSON.stringify(r));
    });

    await record("lifecycle / transition table matches assertTransition (pure)", "*", () => {
      for (const from of ALL_STATUSES) {
        for (const to of ALL_STATUSES) {
          const allowed = ALLOWED_TRANSITIONS[from].includes(to);
          assert.equal(canTransition(from, to), allowed);
          assert.equal(assertTransition(from, to).ok, allowed);
        }
      }
    });

    // ── 7. Reschedule — removed (P0-2) ──────────────────────────────────────
    // The lock-less reschedule and lifecycle wrappers are gone; a timed move goes through moveAppointment (ownerWrite,
    // overlap check under the lock), covered by .appt/app-battery.ts (C, M). Here: they cannot come back unnoticed,
    // and the old create cannot write a time.
    await record("reschedule / lock-less wrappers removed (P0-2)", "*", () => {
      for (const k of ["reschedule", "confirm", "complete", "markNoShow", "cancel"]) assert.ok(!(k in appt), `${k} still exported`);
    });

    await record("create / a start time passed anyway is not written (P0-2)", "*", async () => {
      const r = await appt.create({
        businessId: business.id,
        actor: ownerActor,
        details: { title: "x", startsAt: new Date("2026-07-01T09:00:00.000Z") } as never,
      });
      assert.ok(r.ok, JSON.stringify(r));
      if (r.ok) assert.equal(r.appointment.startsAt, null);
    });

    // ── 8. Actor handling (owner decision 6: only the owner acts as a user) ──
    await record("actor / BOT", "*", async () => {
      const res = await appt.create({
        businessId: business.id,
        actor: { actor: "BOT", userId: null, sourceChannel: "WHATSAPP_BOT" },
      });
      assert.ok(res.ok);
      if (res.ok) {
        assert.equal(res.appointment.createdByActor, "BOT");
        assert.equal(res.appointment.sourceChannel, "WHATSAPP_BOT");
        assert.equal(res.appointment.createdByUserId, null);
      }
    });

    await record("actor / SYSTEM", "*", async () => {
      const res = await appt.create({
        businessId: business.id,
        actor: { actor: "SYSTEM", userId: null, sourceChannel: "IMPORT" },
      });
      assert.ok(res.ok);
      if (res.ok) {
        assert.equal(res.appointment.createdByActor, "SYSTEM");
        assert.equal(res.appointment.sourceChannel, "IMPORT");
        assert.equal(res.appointment.createdByUserId, null);
      }
    });

    await record("actor / BOT or SYSTEM attributed to a user -> invalid_input", "*", async () => {
      for (const actor of ["BOT", "SYSTEM", "CUSTOMER"] as const) {
        const r = await appt.create({
          businessId: business.id,
          actor: { actor, userId: user.id, sourceChannel: "PUBLIC_BOOKING" },
        });
        assert.ok(!r.ok && r.reason === "invalid_input", `${actor}: ${JSON.stringify(r)}`);
      }
    });

    await record("actor / OWNER without a user -> invalid_input", "*", async () => {
      const r = await appt.create({
        businessId: business.id,
        actor: { actor: "OWNER", userId: null, sourceChannel: "INBOX_WEB" },
      });
      assert.ok(!r.ok && r.reason === "invalid_input", JSON.stringify(r));
    });

    // ── 9. Tenant isolation ─────────────────────────────────────────────────
    await record("tenant / lifecycle on wrong business -> not_found", "*", async () => {
      const a = await appt.create({ businessId: business.id, actor: ownerActor });
      assert.ok(a.ok);
      if (!a.ok) return;
      const r = await lifecycle("CONFIRMED", {
        appointmentId: a.appointment.id,
        businessId: otherBusiness.id,
        actor: ownerActor,
      });
      assert.ok(!r.ok && r.reason === "appointment_not_found", JSON.stringify(r));
      // and it was NOT mutated
      const fresh = await prisma.appointment.findUnique({ where: { id: a.appointment.id } });
      assert.equal(fresh?.status, "PROPOSED");
    });

    await record("tenant / getById wrong business -> null", "*", async () => {
      const a = await appt.create({ businessId: business.id, actor: ownerActor });
      assert.ok(a.ok);
      if (!a.ok) return;
      const found = await appt.getById(a.appointment.id, otherBusiness.id);
      assert.equal(found, null);
    });

    await record("tenant / createFromPending wrong business -> conversation_not_found", "*", async () => {
      const { conversationId } = await makeConversationWithPending("hint");
      const r = await appt.createFromPending({
        conversationId,
        businessId: otherBusiness.id,
        actor: ownerActor,
      });
      assert.ok(!r.ok && r.reason === "conversation_not_found", JSON.stringify(r));
    });

    // ── 10. Edge cases ──────────────────────────────────────────────────────
    await record("edge / no_pending", "*", async () => {
      const conversationId = await makeConversation();
      const r = await appt.createFromPending({
        conversationId,
        businessId: business.id,
        actor: ownerActor,
      });
      assert.ok(!r.ok && r.reason === "no_pending", JSON.stringify(r));
    });

    await record("edge / pending_malformed", "*", async () => {
      const conversationId = await makeConversation();
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { pendingAppointmentRequest: { foo: 1 } },
      });
      const r = await appt.createFromPending({
        conversationId,
        businessId: business.id,
        actor: ownerActor,
      });
      assert.ok(!r.ok && r.reason === "pending_malformed", JSON.stringify(r));
    });

    await record("edge / invalid_input (bad ids)", "*", async () => {
      const r = await appt.createFromPending({
        conversationId: -1,
        businessId: 0,
        actor: ownerActor,
      });
      assert.ok(!r.ok && r.reason === "invalid_input", JSON.stringify(r));
    });

    await record("edge / invalid_input (bad actor)", "*", async () => {
      const r = await appt.create({
        businessId: business.id,
        actor: { actor: "OWNER", userId: 0, sourceChannel: "INBOX_WEB" },
      });
      assert.ok(!r.ok && r.reason === "invalid_input", JSON.stringify(r));
    });
  } finally {
    // ── Teardown ──────────────────────────────────────────────────────────
    // Since milestone A every appointment write is journalled, and the journal is append-only (only a cascade from
    // Business may remove its rows). Deleting the businesses removes appointments, journal, messages, conversations
    // and users in one cascading statement.
    await prisma.business.deleteMany({
      where: { id: { in: [business.id, otherBusiness.id] } },
    });
    await prisma.$disconnect();
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
main()
  .then(() => {
    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    console.log("");
    console.log("=== APPOINTMENT QA RESULTS ===");
    for (const r of results) {
      console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.group} :: ${r.name}`);
      if (!r.ok && r.detail) console.log(`       ${r.detail}`);
    }
    console.log("");
    console.log(`Summary: ${passed}/${results.length} passed, ${failed.length} failed`);
    if (failed.length > 0) process.exitCode = 1;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
