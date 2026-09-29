"use client";

import { useMemo, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";

/**
 * Desktop context column for the content studio (shown from 1200 by
 * `content-desktop.css`).
 *
 * Every studio step reads and writes one `content_flow` object in
 * localStorage. On a phone the owner holds earlier answers in their head; on
 * desktop they are listed beside the step, so the next decision is made with
 * the previous ones in view. It lists only what was actually chosen. It is
 * not a step rail: the studio branches (camera or AI) and a rail would imply
 * one path. Read-only — changing an answer still happens on its own step.
 *
 * The labels mirror the option lists on each step's page. A page file may
 * only export what Next allows, so they cannot be imported from there.
 */

type ContentFlow = {
  vibe?: string;
  canFilm?: boolean;
  primaryGoal?: string;
  selectedPlatform?: string;
  directionType?: string;
  creatorContext?: string | null;
  selectedFormat?: string;
};

const VIBE: Record<string, string> = {
  professional_clean: "נקי ומקצועי",
  warm_personal: "חם ואישי",
  bold_energetic: "אנרגטי ודינמי",
  premium_luxury: "פרמיום ויוקרתי",
};

const GOAL: Record<string, string> = {
  leads: "שישלחו הודעה",
  exposure: "שיכירו אותי",
  trust: "שיסמכו עליי",
  sales: "שיקנו / יזמינו",
  brand: "שיזכרו אותי",
};

const PLATFORM: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  facebook: "Facebook",
  unknown: "עדיין לא ידוע",
};

const DIRECTION: Record<string, string> = {
  authentic: "שיחה אמיתית",
  attention: "פתיחה חזקה",
  proof: "סיפור קצר",
  differentiation: "משהו שונה",
  direct: "ישיר ולעניין",
};

const FORMAT: Record<string, string> = {
  reel: "רילס",
  video: "וידאו",
  image: "תמונה",
  post: "פוסט",
};

const HOW_IT_WORKS = [
  "בוחרים איך התוכן ירגיש ומה הוא צריך לעשות",
  "בוחרים כיוון, ו-Dubiz כותב תסריט לעסק שלך",
  "מצטלמים בעצמך, או ש-Dubiz מייצר בלי צילום",
  "מקבלים סרטון מוכן לפרסום",
];

// The raw string is the snapshot: equal strings compare equal, so an
// unchanged flow never re-renders. `storage` covers another tab; within this
// tab each step writes before it navigates, and the route change re-renders
// this layout-level component, which reads the snapshot again.
function readRaw(): string | null {
  try {
    return localStorage.getItem("content_flow");
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function parseFlow(raw: string | null): ContentFlow {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ContentFlow;
  } catch {
    return {};
  }
}

function rowsFor(flow: ContentFlow): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string | undefined }> = [
    { label: "תחושה", value: flow.vibe ? VIBE[flow.vibe] : undefined },
    {
      label: "מול המצלמה",
      value: typeof flow.canFilm === "boolean" ? (flow.canFilm ? "כן" : "עדיף לא") : undefined,
    },
    { label: "מטרה", value: flow.primaryGoal ? GOAL[flow.primaryGoal] : undefined },
    { label: "איפה יעלה", value: flow.selectedPlatform ? PLATFORM[flow.selectedPlatform] : undefined },
    { label: "כיוון", value: flow.directionType ? DIRECTION[flow.directionType] : undefined },
    { label: "פורמט", value: flow.selectedFormat ? FORMAT[flow.selectedFormat] : undefined },
    {
      label: "על העסק",
      value: typeof flow.creatorContext === "string" && flow.creatorContext.trim()
        ? flow.creatorContext.trim()
        : undefined,
    },
  ];
  return rows.filter((row): row is { label: string; value: string } => Boolean(row.value));
}

/**
 * The legacy chain (flow → mode → context, intent/value/style → mode, summary)
 * is linked from nowhere in the product. Its steps use full-width fixed
 * buttons that would run under this column, so on those routes the brief is
 * not rendered and they behave exactly as they did before it existed.
 */
const LEGACY_STEPS = new Set(["flow", "mode", "intent", "value", "style", "context", "summary"]);

export function StudioBrief() {
  // Subscribing to the pathname makes every route change re-render the brief.
  const pathname = usePathname() ?? "";
  const raw = useSyncExternalStore(subscribe, readRaw, () => null);
  const rows = useMemo(() => rowsFor(parseFlow(raw)), [raw]);
  if (LEGACY_STEPS.has(pathname.split("/")[2] ?? "")) return null;

  return (
    <aside className="studio-brief" aria-label="התוכן שנבנה">
      {rows.length > 0 ? (
        <>
          <h2>התוכן שנבנה</h2>
          <p>מה שבחרת עד עכשיו. כל בחירה משתנה בשלב שלה.</p>
          <dl>
            {rows.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <>
          <h2>איך זה עובד</h2>
          <p>כמה בחירות קצרות, ובסוף סרטון מוכן. הבחירות יופיעו כאן בזמן שבונים.</p>
          <ol>
            {HOW_IT_WORKS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </>
      )}
    </aside>
  );
}
