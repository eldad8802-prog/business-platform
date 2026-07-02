import Link from "next/link";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";

export default function SettingsBillingPage() {
  return (
    <>
      <SettingsSubPageHeader title="מנוי וחיוב" />
      <SettingsSection title="מנוי Dubiz וחיוב המערכת">
        <p className="text-sm leading-6 text-gray-600">
          כאן יוצגו בעתיד פרטי המנוי לשירות Dubiz והחיוב על השימוש במערכת — בקרוב.
        </p>
        <div className="mt-3 rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3">
          <p className="text-xs leading-5 text-gray-600">
            שים לב: זהו מנוי השירות של Dubiz, ולא חשבוניות ללקוחות שלך. חשבוניות
            לקוחות מנוהלות באזור החשבוניות.
          </p>
          <Link
            href="/billing"
            className="mt-3 inline-flex min-h-11 items-center rounded-2xl border border-gray-200 bg-white px-4 text-sm font-semibold text-gray-700"
          >
            מעבר לחשבוניות לקוחות
          </Link>
        </div>
      </SettingsSection>
    </>
  );
}
