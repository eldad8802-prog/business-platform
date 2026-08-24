import type { ReactNode } from "react";
import type { Metadata } from "next";
import { ShellChrome } from "@/components/navigation/shell-chrome";

export const metadata: Metadata = { title: "חשבוניות" };

// Product screen outside the (shell) route group — wrap in the same ShellChrome
// so it inherits the one shared bottom navigation bar. Presentation only.
export default function BillingLayout({ children }: { children: ReactNode }) {
  return <ShellChrome>{children}</ShellChrome>;
}
