"use client";

/**
 * The Secretary's full calendar (/secretary?screen=calendar[&day=YYYY-MM-DD]) — the month view that lived on the
 * main screen until the stations layout (24.10.2026), now reached from the "לוח שנה" station and from
 * "לוח שנה מלא" under the week strip. Same reads, same kinds, same notes; nothing new is fetched or written.
 */

import BackButton from "@/components/ui/back-button";
import type { BriefingApi } from "@/lib/obligations/secretary-client";
import { SecretaryCalendar } from "./secretary-calendar";
import { HUB_OBLIGATION_LIMIT, useHubData } from "./secretary-hub-data";
import { calendarEvents } from "./secretary-hub-model";
import { secretaryVars } from "./secretary-ui";
import s from "./secretary-hub.module.css";

export function SecretaryCalendarScreen({ briefing, day }: { briefing: BriefingApi; day: string | null }) {
  const data = useHubData(briefing.generatedAt);
  const summary = typeof data.summary === "object" ? data.summary : null;
  const obligations = typeof data.obligations === "object" ? data.obligations : null;
  const events = calendarEvents({ obligations: obligations?.list ?? [], tasks: Array.isArray(data.tasks) ? data.tasks : [], summary });
  const notes = [
    data.tasks === "off" ? null : "משימות מוצגות עד שבוע קדימה.",
    summary ? "תחזית: מועדים צפויים של הוצאות קבועות, עד 30 יום קדימה. היא עוד לא נרשמה ולא שולמה." : null,
    "שולם: לפי הרישום בהתחייבות, ביום המועד שלה.",
    data.obligations === "unavailable" ? "לא הצלחתי לטעון את מועדי ההתחייבויות." : null,
    obligations?.truncated ? `מוצגות ${HUB_OBLIGATION_LIMIT.toLocaleString("he-IL")} ההתחייבויות הראשונות.` : null,
  ].filter((n): n is string => n !== null);

  return (
    <main className={s.calPage} style={secretaryVars()} dir="rtl" aria-labelledby="sec-calendar-page-title">
      <BackButton fallback="/secretary" />
      <h1 id="sec-calendar-page-title" className={s.calPageTitle}>לוח שנה</h1>
      <SecretaryCalendar events={events} notes={notes} loading={data.obligations === "loading"} initialDay={day} title="משימות ומועדי תשלום" />
    </main>
  );
}
