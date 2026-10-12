import type { ReactNode } from "react";
import { ShellChrome } from "@/components/navigation/shell-chrome";
import { RefreshCoordinator } from "@/components/auth/refresh-coordinator";
import { EmailVerificationBanner } from "@/components/auth/email-verification-banner";

export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <RefreshCoordinator>
      <ShellChrome topSlot={<EmailVerificationBanner />}>{children}</ShellChrome>
    </RefreshCoordinator>
  );
}
