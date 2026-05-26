import type { ReactNode } from "react";
import { ShellChrome } from "@/components/navigation/shell-chrome";

export default function ShellLayout({ children }: { children: ReactNode }) {
  return <ShellChrome>{children}</ShellChrome>;
}
