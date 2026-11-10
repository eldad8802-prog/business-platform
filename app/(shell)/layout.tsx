import type { ReactNode } from "react";
import { ShellChrome } from "@/components/navigation/shell-chrome";
import { RefreshCoordinator } from "@/components/auth/refresh-coordinator";
import { ReminderCenter } from "@/components/notifications/reminder-center";
import { StaleClientReload } from "@/components/navigation/stale-client-reload";

export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <RefreshCoordinator>
      {/* No account notices above the screens: email verification lives in Settings → Security. */}
      <ShellChrome>{children}</ShellChrome>
      {/* Task reminders while Dubiz is open (self-disabling unless daily_tasks is on for the business). */}
      <ReminderCenter />
      {/* A page from an older deployment (e.g. a home-screen app kept alive across a deploy) reloads once. */}
      <StaleClientReload />
    </RefreshCoordinator>
  );
}
