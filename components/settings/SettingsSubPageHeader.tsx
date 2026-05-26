"use client";

import { useRouter } from "next/navigation";

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
  const router = useRouter();

  return (
    <header className="mb-5 rounded-3xl bg-white px-4 py-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => router.push(backHref)}
          className="flex h-11 min-w-[44px] items-center justify-center rounded-2xl border border-gray-200 px-3 text-sm font-medium text-gray-700"
          aria-label="חזרה להגדרות"
        >
          →
        </button>

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
