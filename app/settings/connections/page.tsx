import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { PaymentConnectionCard } from "@/components/settings/PaymentConnectionCard";
import { IntegrationStatusCards } from "@/components/settings/IntegrationStatusCards";

export default function SettingsConnectionsPage() {
  return (
    <>
      <SettingsSubPageHeader title="חיבורים" />
      <div className="mb-4">
        <PaymentConnectionCard />
      </div>
      <div className="mb-4">
        <IntegrationStatusCards />
      </div>
      <SettingsSection>
        <p className="text-sm leading-6 text-gray-600">
          מוצג כאן מצב החיבורים הקיימים. ניהול החיבור עצמו מתבצע במסך הייעודי של כל
          אינטגרציה.
        </p>
      </SettingsSection>
    </>
  );
}
