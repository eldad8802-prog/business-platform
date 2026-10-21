import { json, tasksRoute } from "@/lib/services/tasks/tasks-http";
import { dispatchDueReminders, unseenReminders } from "@/lib/services/tasks/task-reminders.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET — the in-app reminder poll (app shell, every minute and on return to the tab). First dispatches whatever is
 * due for the caller's OWN business (so an open app shows a reminder on time even when a scheduled call is late;
 * the claim keeps it to one send), then returns the reminders the owner has not seen yet. Flag OFF ⇒ 404.
 */
export async function GET(req: Request) {
  return tasksRoute(req, async ({ actor }) => {
    const now = new Date();
    try {
      await dispatchDueReminders(now, actor.businessId);
    } catch {
      /* the scheduled dispatcher remains the guarantee; the poll still answers */
    }
    return json({ reminders: await unseenReminders(actor.businessId, now) });
  });
}
