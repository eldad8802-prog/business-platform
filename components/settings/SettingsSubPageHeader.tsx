"use client";

import BackButton from "@/components/ui/back-button";

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
    <header className="mb-5 rounded-3xl dz-mist px-4 py-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <BackButton href={backHref} />

        <div className="min-w-0 flex-1 text-center">
          <h1 className="truncate text-base font-bold text-[var(--dz-text-primary)]">{title}</h1>
          {subtitle ? (
            <p className="mt-1 text-xs text-[var(--dz-text-muted)]">{subtitle}</p>
          ) : (
            <p className="mt-1 text-xs text-[var(--dz-text-muted)]">הגדרות מערכת</p>
          )}
        </div>

        <div className="h-11 min-w-[44px]" aria-hidden />
      </div>
    </header>
  );
}
