import Link from "next/link";
import { SettingsNav } from "@/components/settings/SettingsNav";

export default function SettingsHubPage() {
  return (
    <>
      <header className="mb-5 rounded-3xl bg-white px-4 py-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <Link
            href="/app"
            className="flex h-11 min-w-[44px] items-center justify-center rounded-2xl border border-gray-200 px-3 text-sm font-medium text-gray-700"
            aria-label="חזרה לדף הבית"
          >
            →
          </Link>

          <div className="min-w-0 flex-1 text-center">
            <h1 className="text-base font-bold text-gray-900">הגדרות</h1>
          </div>

          <div className="h-11 min-w-[44px]" aria-hidden />
        </div>
      </header>

      <SettingsNav />
    </>
  );
}
