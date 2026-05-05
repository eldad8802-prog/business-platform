"use client";

import Link from "next/link";
import PageHeader from "@/components/ui/page-header";
import { card, hero, heroKicker, heroSubText, heroTitle, pageMain } from "./ui";

export default function DocumentsHome() {
  return (
    <div dir="rtl">
      <PageHeader title="מסמכים" />

      <main style={pageMain}>
        <section style={hero}>
          <div style={heroKicker}>מרכז מסמכים</div>
          <h1 style={heroTitle}>מסמכים</h1>
          <p style={heroSubText}>העלאה, חיפוש ודוחות — הכל במקום אחד.</p>
        </section>

        <Link
          href="/documents/upload"
          style={{ textDecoration: "none", color: "inherit" }}
        >
          <div style={{ ...card, cursor: "pointer" }}>
            <div style={{ fontWeight: 950, marginBottom: 6, color: "#111827" }}>
              העלאת מסמך
            </div>
            <div style={{ color: "#6b7280", fontSize: 14, lineHeight: 1.6 }}>
              העלאה, צילום או ייבוא ממייל — ואז בדיקה קצרה ושמירה.
            </div>
          </div>
        </Link>

        <Link
          href="/documents/dashboard"
          style={{ textDecoration: "none", color: "inherit" }}
        >
          <div style={{ ...card, cursor: "pointer" }}>
            <div style={{ fontWeight: 950, marginBottom: 6, color: "#111827" }}>
              דוחות
            </div>
            <div style={{ color: "#6b7280", fontSize: 14, lineHeight: 1.6 }}>
              הכנסות, הוצאות ורווח לפי חודש.
            </div>
          </div>
        </Link>

        <Link
          href="/documents/search"
          style={{ textDecoration: "none", color: "inherit" }}
        >
          <div style={{ ...card, cursor: "pointer" }}>
            <div style={{ fontWeight: 950, marginBottom: 6, color: "#111827" }}>
              חיפוש מסמכים
            </div>
            <div style={{ color: "#6b7280", fontSize: 14, lineHeight: 1.6 }}>
              חפש לפי ספק, קטגוריה או טקסט.
            </div>
          </div>
        </Link>
      </main>
    </div>
  );
}