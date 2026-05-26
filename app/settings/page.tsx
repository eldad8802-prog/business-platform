import Link from "next/link";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { SettingsSection } from "@/components/settings/SettingsSection";

export default function SettingsHubPage() {
  return (
    <>
      <header className="mb-5 rounded-3xl bg-white px-4 py-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <Link
            href="/"
            className="flex h-11 min-w-[44px] items-center justify-center rounded-2xl border border-gray-200 px-3 text-sm font-medium text-gray-700"
            aria-label="חזרה לדף הבית"
          >
            →
          </Link>

          <div className="min-w-0 flex-1 text-center">
            <h1 className="text-base font-bold text-gray-900">הגדרות מערכת</h1>
            <p className="mt-1 text-xs text-gray-500">נדיר, גלובלי וטכני בלבד</p>
          </div>

          <div className="h-11 min-w-[44px]" aria-hidden />
        </div>
      </header>

      <SettingsSection
        title="מרכז הגדרות"
        description="ניהול שוטף של העסק נמצא בתוך כל פיצ׳ר — לא כאן"
      >
        <p className="text-sm leading-6 text-gray-600">
          כאן תופיענה בעתיד העדפות סביבת עבודה, צוות, חיבורים, אבטחה, מנוי והרשאות
          AI ברמת המערכת בלבד.
        </p>
      </SettingsSection>

      <div className="mt-4">
        <SettingsNav />
      </div>
    </>
  );
}
