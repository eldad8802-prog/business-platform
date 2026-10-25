import { Suspense } from "react";

import { CalendarScreen } from "@/features/calendar/calendar-screen";

/**
 * /calendar — "יומן ותורים" (Appointments milestone B). Behind the appointments flag: every /api/appointments route
 * answers 404 while it is OFF, the navigation does not list the screen, and the screen itself says it is not active.
 */
export default function CalendarPage() {
  return (
    <Suspense fallback={null}>
      <CalendarScreen />
    </Suspense>
  );
}
