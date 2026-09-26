"use client";

import { CrmUnselectedDesk } from "@/components/crm/crm-unselected-desk";

export default function LeadsIndexPage() {
  return (
    <CrmUnselectedDesk
      icon={
        <svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
          <path d="M3 5h18M6 12h12M10 19h4" strokeLinecap="round" />
        </svg>
      }
      title="בחרו ליד מהרשימה"
      description="בחירת ליד תציג את הפרטים, מה הוא ביקש, המעקב וההיסטוריה שלו."
      lead="הליד נשאר ברשימה בזמן שסוגרים אותו"
      facts={[
        { title: "מה הוא ביקש", body: "הבקשה והפרטים נפתחים ליד הרשימה, בלי לעזוב את התור." },
        { title: "מעקב", body: "הצעד הבא נשאר על הכרטיס, לא במסך אחר." },
        { title: "היסטוריה", body: "מה שכבר קרה עם הליד מופיע באותו כרטיס." },
      ]}
    />
  );
}
