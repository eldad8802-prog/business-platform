import type { ReactNode } from "react";
import { RefreshCoordinator } from "@/components/auth/refresh-coordinator";

/**
 * Onboarding is authenticated but draws no ShellChrome, so it carries the session
 * coordinator itself: the token is kept fresh, and the page leaves for /login
 * when the server ends the session.
 */
export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return <RefreshCoordinator>{children}</RefreshCoordinator>;
}
