import type { ReactNode } from "react";
import packageJson from "../../package.json";
import { SettingsSystemFooter } from "@/components/settings/SettingsSystemFooter";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#f8f6f1] text-[#1f2937]" dir="rtl">
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col px-4 pb-8 pt-4 sm:max-w-2xl sm:px-6 lg:max-w-4xl">
        <div className="flex-1">{children}</div>
        <SettingsSystemFooter appVersion={packageJson.version} />
      </div>
    </div>
  );
}
