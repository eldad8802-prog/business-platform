"use client";

import SmartBackButton from "@/components/ui/smart-back-button";

type Props = {
  title: string;
  subtitle?: string;
  backHref?: string;
};

export function SettingsSubPageHeader({
  title,
  subtitle,
  backHref = "/settings",
}: Props) {
  return (
    <header className="mb-5 rounded-3xl bg-white px-4 py-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        {/* Return to the actual previous screen; fall back to the settings hub
            only when opened via a deep link with no history. */}
        <SmartBackButton fallbackHref={backHref} />

        <div className="min-w-0 flex-1 text-center">
          <h1 className="truncate text-base font-bold text-gray-900">{title}</h1>
          {subtitle ? (
            <p className="mt-1 text-xs text-gray-500">{subtitle}</p>
          ) : (
            <p className="mt-1 text-xs text-gray-500">הגדרות מערכת</p>
          )}
        </div>

        <div className="h-11 min-w-[44px]" aria-hidden />
      </div>
    </header>
  );
}
