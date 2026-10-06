import type { ReactNode } from "react";
import { ShellChrome } from "@/components/navigation/shell-chrome";
import { RefreshCoordinator } from "@/components/auth/refresh-coordinator";

export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <RefreshCoordinator>
      <ShellChrome>{children}</ShellChrome>
    </RefreshCoordinator>
  );
}
