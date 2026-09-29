"use client";

import { CrmUnselectedDesk } from "@/components/crm/crm-unselected-desk";

export default function SuppliersIndexPage() {
  return (
    <CrmUnselectedDesk
      icon={
        <svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
          <path d="M3 7.5 12 3l9 4.5M5 9.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9 20v-6h6v6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      }
      title="בחרו ספק מהרשימה"
      description="בחירת ספק תציג את פרטי הקשר, ההזמנות והפעילות שלו."
      lead="ההזמנות נשארות על כרטיס הספק"
      facts={[
        { title: "פרטי קשר", body: "איך מגיעים לספק, באותו כרטיס של הרשימה." },
        { title: "הזמנות", body: "הזמנות שכבר קיימות לספק הזה, לא רשימה צפה בנפרד." },
        { title: "פעילות", body: "מה שזז מול הספק מופיע ליד הבחירה." },
      ]}
    />
  );
}
