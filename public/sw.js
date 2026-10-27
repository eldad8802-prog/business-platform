/*
 * Dubiz service worker — Web Push for task reminders (owner-approved plan, 2026-10-21) and for booking requests that
 * wait on the owner (Milestone C, D3).
 *
 * It does ONE thing: show what the server pushed, and open the right screen when it is tapped. There is deliberately
 * no fetch handler and no cache — the app is never served from here, so a deploy is never stale. The worker holds no
 * token and performs no action itself: a tap opens the signed-in screen with the item and the chosen action in the
 * URL, and that page performs it (a task: complete / snooze; a booking request: approve / decline after the owner
 * confirms on the screen).
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const booking = data.kind === "booking" && typeof data.requestId === "number";
  const title = typeof data.title === "string" && data.title ? data.title : booking ? "בקשה לתור" : "תזכורת";
  const local = typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//");
  // A task reminder keeps its original fallback; a booking request falls back to the requests tab.
  const url = booking ? (local ? data.url : "/calendar?view=requests") : local ? data.url : "/tasks";
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    tag: typeof data.tag === "string" ? data.tag : undefined,
    renotify: true,
    dir: "rtl",
    lang: "he",
    icon: "/icons/dubiz-192.png",
    badge: "/icons/dubiz-192.png",
    data: booking
      ? { url, kind: "booking", requestId: data.requestId }
      : { url, taskId: typeof data.taskId === "number" ? data.taskId : null },
    actions: booking
      ? [
          { action: "approve", title: "אישור" },
          { action: "decline", title: "דחייה" },
        ]
      : [
          { action: "done", title: "בוצע" },
          { action: "snooze", title: "עוד שעה" },
        ],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  let url = data.url || "/tasks";
  if (data.kind === "booking" && typeof data.requestId === "number") {
    url = `/calendar?view=requests&request=${data.requestId}`;
    if (event.action === "approve" || event.action === "decline") url += `&requestAction=${event.action}`;
  } else if (data.taskId && (event.action === "done" || event.action === "snooze")) {
    url = `/tasks?task=${data.taskId}&reminderAction=${event.action}`;
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin && "navigate" in w) {
          return w.focus().then(() => w.navigate(url));
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
