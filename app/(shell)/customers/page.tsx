"use client";

import { CrmUnselectedDesk } from "@/components/crm/crm-unselected-desk";

export default function CustomersIndexPage() {
  return (
    <CrmUnselectedDesk
      icon={
        <svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
          <circle cx="9" cy="8" r="3.2" />
          <path d="M3.5 19a5.5 5.5 0 0 1 11 0" strokeLinecap="round" />
          <path d="M16 5.2a3.2 3.2 0 0 1 0 5.9M17.5 19a5.5 5.5 0 0 0-2.7-4.7" strokeLinecap="round" />
        </svg>
      }
      title="בחרו לקוח מהרשימה"
      description="בחירת לקוח תציג את הפרטים, ההערות, הקבצים והפעילות שלו."
      lead="הכרטיס הוא מקום העבודה, לא דף נפרד"
      facts={[
        { title: "פרטי קשר", body: "שם, טלפון, אימייל ועיר — אותו כרטיס שנפתח מהשורה." },
        { title: "הערות וקבצים", body: "מה שכבר שמור על הלקוח, בלי מסך נוסף." },
        { title: "פעילות", body: "אם יש תורים או תנועה, הם מופיעים כאן ליד הרשימה." },
      ]}
    />
  );
}
