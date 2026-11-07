"use client";

/**
 * Leads L1.5-b · PR-3 — under a connection on the connections screen: how many enquiries wait for it and why, and
 * how many could not be taken in. Counts only. Rendered only when the server sent `waiting` (the feature
 * intake_status_visibility is on for the business) and there is something to say. Hebrew-first (new screen copy).
 */
export type ConnectionWaiting = { held: number; paused: number; platform: number; notIncluded: number; failed: number; capped: boolean };

const num = (n: number, capped: boolean) => (capped ? `${n.toLocaleString("he-IL")}+` : n.toLocaleString("he-IL"));
/** All three nouns are feminine: פנייה / הזמנה / שיחה. */
export type Noun = { one: string; many: string };
const ENQUIRY: Noun = { one: "פנייה", many: "פניות" };
const count = (n: number, capped: boolean, w: Noun) => (n === 1 && !capped ? `${w.one} אחת` : `${num(n, capped)} ${w.many}`);

export function IntakeWaitingNote({ waiting, noun = ENQUIRY }: { waiting?: ConnectionWaiting | null; noun?: Noun }) {
  const enquiries = (n: number, capped: boolean) => count(n, capped, noun);
  if (!waiting || (waiting.held === 0 && waiting.failed === 0)) return null;
  const lines: { text: string; tone: "muted" | "warn" | "danger" }[] = [];
  if (waiting.paused > 0) lines.push({ text: `${enquiries(waiting.paused, waiting.capped)} ממתינות לחידוש החיבור — הן ייקלטו כשתפעילו אותו מחדש.`, tone: "warn" });
  if (waiting.notIncluded > 0) lines.push({ text: `${enquiries(waiting.notIncluded, waiting.capped)} ממתינות — המקור לא כלול כרגע בחבילה שלכם.`, tone: "warn" });
  if (waiting.platform > 0) lines.push({ text: `${enquiries(waiting.platform, waiting.capped)} נשמרות וממתינות — דוביז השהתה זמנית את הקליטה. אין צורך לעשות דבר.`, tone: "muted" });
  if (waiting.failed > 0) lines.push({ text: `לא הצלחנו להשלים את קליטת ${enquiries(waiting.failed, waiting.capped)}. אנחנו בודקים זאת.`, tone: "danger" });
  const tone = { muted: "text-[var(--dz-text-muted)]", warn: "text-[var(--dz-text-primary)]", danger: "text-[var(--dz-danger)]" } as const;
  return (
    <div className="mt-2 space-y-1 rounded-xl border border-[var(--dz-border)] bg-[var(--dz-surface)] px-3 py-2" data-testid="intake-waiting-note">
      {lines.map((l) => (
        <p key={l.text} className={`text-[11px] font-semibold leading-5 ${tone[l.tone]}`}>{l.text}</p>
      ))}
    </div>
  );
}
