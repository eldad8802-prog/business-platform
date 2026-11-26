import { SetupWizard } from "@/features/calendar/setup-wizard";

/** /calendar/setup — the first-time setup wizard (G9), behind the appointments flag; only for an empty calendar. */
export default function CalendarSetupPage() {
  return <SetupWizard />;
}
