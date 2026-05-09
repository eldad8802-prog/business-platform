"use client";

import DocumentsHeader from "@/components/documents/DocumentsHeader";
import DocumentsActionCard from "@/components/documents/DocumentsActionCard";
import { hero, heroKicker, heroSubText, heroTitle, pageMain } from "./ui";

export default function DocumentsHome() {
  return (
    <div dir="rtl">
      <DocumentsHeader title="מסמכים" />

      <main style={pageMain}>
        <section style={hero}>
          <div style={heroKicker}>מרכז מסמכים</div>
          <h1 style={heroTitle}>מסמכים</h1>
          <p style={heroSubText}>העלאה, חיפוש ודוחות — הכל במקום אחד.</p>
        </section>

        <DocumentsActionCard
          href="/documents/upload"
          icon="📤"
          title="העלאת מסמך"
          subtitle="העלאה, צילום או ייבוא ממייל"
        />

        <DocumentsActionCard
          href="/documents/inbox"
          icon="📥"
          title="תיבת מסמכים"
          subtitle="ממתינים ומאושרים לפי חודש"
        />

        <DocumentsActionCard
          href="/documents/dashboard"
          icon="📊"
          title="דוחות"
          subtitle="הכנסות, הוצאות ורווח לפי חודש"
        />

        <DocumentsActionCard
          href="/documents/search"
          icon="🔍"
          title="חיפוש מסמכים"
          subtitle="חיפוש לפי ספק, קטגוריה או טקסט"
        />
      </main>
    </div>
  );
}
