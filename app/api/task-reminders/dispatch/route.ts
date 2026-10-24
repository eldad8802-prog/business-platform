import { NextRequest, NextResponse } from "next/server";

import { authorizeReminderDispatch } from "@/lib/services/tasks/reminder-dispatch-auth";
import { dispatchDueReminders } from "@/lib/services/tasks/task-reminders.service";

/**
 * Reminder dispatcher — sends every due personal-task reminder (bell + Web Push), exactly once.
 *
 * The only caller (lib/services/tasks/reminder-dispatch-auth.ts): QStash — a message published for each reminder's
 * moment, and a schedule every few minutes as the safety net — verified by signature for THIS url. Never a user session and never a
 * tenant from the caller: the due reminders come from task_reminders_due() (identifiers only) and each one is
 * claimed inside its own business's tenant transaction. The body is ignored beyond its signature. The response is
 * counts only. Concurrent runs are safe: the claim has one winner.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest, body: string) {
  const auth = await authorizeReminderDispatch({
    signature: req.headers.get("upstash-signature"),
    body,
  });
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const out = await dispatchDueReminders(new Date());
    return NextResponse.json({ ok: true, via: auth.via, ...out });
  } catch {
    console.error("[tasks] reminder dispatch failed");
    return NextResponse.json({ error: "dispatch_failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return handle(req, await req.text());
}

