/*
 * Dubiz service worker — task reminders by Web Push (owner-approved plan, 2026-10-21).
 *
 * It does ONE thing: show a reminder the server pushed, and open the right screen when it is tapped. There is
 * deliberately no fetch handler and no cache — the app is never served from here, so a deploy is never stale.
 * The worker holds no token: a tap opens /tasks with the task and the chosen action in the URL, and the signed-in
 * page performs the action (complete / snooze) itself.
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
  const title = typeof data.title === "string" && data.title ? data.title : "תזכורת";
  const url = typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//") ? data.url : "/tasks";
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    tag: typeof data.tag === "string" ? data.tag : undefined,
    renotify: true,
    dir: "rtl",
    lang: "he",
    icon: "/icons/dubiz-192.png",
    badge: "/icons/dubiz-192.png",
    data: { url, taskId: typeof data.taskId === "number" ? data.taskId : null },
    actions: [
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
  if (data.taskId && (event.action === "done" || event.action === "snooze")) {
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
