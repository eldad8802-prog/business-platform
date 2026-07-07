import type { ReactNode } from "react";
import { ShellChrome } from "@/components/navigation/shell-chrome";

// Product screen outside the (shell) route group — wrap in the same ShellChrome
// so it inherits the one shared bottom navigation bar. Presentation only.
export default function SearchLayout({ children }: { children: ReactNode }) {
  return <ShellChrome>{children}</ShellChrome>;
}
