import { Suspense, type ReactNode } from "react";
import type { Metadata } from "next";
import { ShellChrome } from "@/components/navigation/shell-chrome";

export const metadata: Metadata = { title: "חשבוניות" };

// Product screen outside the (shell) route group — wrap in the same ShellChrome
// so it inherits the one shared bottom navigation bar. Presentation only.
//
// The Suspense boundary is what `useSearchParams` requires to be prerenderable:
// the screen reads `?create=1` so that "+ → חשבונית חדשה" opens the create flow
// rather than the list. The fallback is empty on purpose — the screen paints
// its own loading state a frame later, and a second one here would flash.
export default function BillingLayout({ children }: { children: ReactNode }) {
  return (
    <ShellChrome>
      <Suspense fallback={null}>{children}</Suspense>
    </ShellChrome>
  );
}
