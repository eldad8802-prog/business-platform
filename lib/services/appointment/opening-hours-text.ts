/**
 * G19 — the calendar's weekly hours as one Hebrew line for BusinessProfile.openingHours (the free text the bot and
 * the business knowledge read). PURE. Written only when the owner taps "לעדכן גם את שעות הפתיחה בפרופיל העסק" after
 * saving the calendar hours — never automatically, and the bot itself is unchanged.
 *
 *   "ראשון–חמישי 09:00–17:00 · שישי 09:00–13:00 · שבת סגור"
 * Consecutive days with the same hours are joined; a night that runs past midnight (a day ending 24:00 and the next
 * starting 00:00 — how the calendar stores it, G17) reads as one range: "שלישי 20:00–02:00".
 */
export const HEBREW_DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

type Rule = { weekday: number; startMinute: number; endMinute: number };

const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** null when no hours are set at all (nothing to write). */
export function openingHoursText(rules: Rule[]): string | null {
  const days: Array<Array<{ s: number; e: number }>> = Array.from({ length: 7 }, () => []);
  for (const r of rules) if (r.weekday >= 0 && r.weekday <= 6 && r.endMinute > r.startMinute) days[r.weekday].push({ s: r.startMinute, e: r.endMinute });
  for (const d of days) d.sort((a, b) => a.s - b.s);
  if (days.every((d) => d.length === 0)) return null;
  // A night past midnight: the day's last range ends at 24:00 and the next day's first starts at 00:00 — carried
  // over (shown on the evening's day), unless the next day is open all day (then it stands on its own).
  const shown = days.map((d) => d.map((r) => ({ ...r })));
  for (let i = 0; i < 7; i++) {
    const today = shown[i];
    const next = shown[(i + 1) % 7];
    const last = today[today.length - 1];
    const first = next[0];
    if (!last || !first || last.e !== 1440 || first.s !== 0 || first.e === 1440 || last.s === 0) continue;
    last.e = 1440 + first.e;
    next.shift();
  }
  const text = shown.map((d) => (d.length ? d.map((r) => `${hhmm(r.s)}–${r.e === 1440 ? "24:00" : hhmm(r.e)}`).join(", ") : "סגור"));
  const parts: string[] = [];
  let i = 0;
  while (i < 7) {
    let j = i;
    while (j + 1 < 7 && text[j + 1] === text[i]) j++;
    parts.push(`${j > i ? `${HEBREW_DAYS[i]}–${HEBREW_DAYS[j]}` : HEBREW_DAYS[i]} ${text[i]}`);
    i = j + 1;
  }
  return parts.join(" · ");
}
