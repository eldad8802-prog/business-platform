import type { ReactNode } from "react";
import { ShellChrome } from "@/components/navigation/shell-chrome";
import { KindTransitionFlagProvider } from "@/components/legal-identity/kind-transition-flag-context";
import { isBusinessKindTransitionEnabled } from "@/lib/legal-identity/kind-transition-flag";

// Product screen outside the (shell) route group — wrap in the same ShellChrome
// so it inherits the one shared bottom navigation bar. Presentation only.
// The "מעבר לעוסק מורשה" flag (server-side) tells the business screen whether to ask its API at all; off → no request.
export default function BusinessLayout({ children }: { children: ReactNode }) {
  return (
    <KindTransitionFlagProvider enabled={isBusinessKindTransitionEnabled()}>
      <ShellChrome>{children}</ShellChrome>
    </KindTransitionFlagProvider>
  );
}
