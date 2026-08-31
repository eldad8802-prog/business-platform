import { SettingsNav } from "@/components/settings/SettingsNav";
import BackButton from "@/components/ui/back-button";

export default function SettingsHubPage() {
  return (
    <>
      <header className="mb-5 rounded-3xl bg-[var(--dz-surface)] px-4 py-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <BackButton href="/app" label="חזרה לדף הבית" />

          <div className="min-w-0 flex-1 text-center">
            <h1 className="text-base font-bold text-[var(--dz-text-primary)]">הגדרות</h1>
          </div>

          <div className="h-11 min-w-[44px]" aria-hidden />
        </div>
      </header>

      <SettingsNav />
    </>
  );
}
