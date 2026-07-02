import type { ReactNode } from "react";
import { ShellChrome } from "@/components/navigation/shell-chrome";
import { SkipLink } from "@/components/ui/skip-link";

export default function ShellLayout({ children }: { children: ReactNode }) {
  // WP1 A-4: the skip link is the first focusable element in the app shell,
  // targeting the #main-content container inside ShellChrome.
  return (
    <>
      <SkipLink />
      <ShellChrome>{children}</ShellChrome>
    </>
  );
}
