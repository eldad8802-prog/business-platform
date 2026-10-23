import type { ReactNode } from "react";
import { ShellChrome } from "@/components/navigation/shell-chrome";
import { RefreshCoordinator } from "@/components/auth/refresh-coordinator";
import { EmailVerificationBanner } from "@/components/auth/email-verification-banner";
import { ReminderCenter } from "@/components/notifications/reminder-center";

export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <RefreshCoordinator>
      <ShellChrome topSlot={<EmailVerificationBanner />}>{children}</ShellChrome>
      {/* Task reminders while Dubiz is open (self-disabling unless daily_tasks is on for the business). */}
      <ReminderCenter />
    </RefreshCoordinator>
  );
}
