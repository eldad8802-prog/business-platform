"use client";

import Link from "next/link";
import { header, subheader, card } from "./ui";

export default function DocumentsHome() {
  return (
    <div>
      <h1 style={header}>מסמכים</h1>
      <p style={subheader}>
        ניהול, חיפוש ודוחות של כל המסמכים בעסק שלך
      </p>

      <Link href="/documents/upload" style={{ textDecoration: "none", color: "inherit" }}>
        <div style={card}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>📸 העלאת מסמך</div>
          <div style={{ color: "#666", fontSize: 14 }}>
            צילום או העלאה של חשבונית, קבלה או צילום מסך
          </div>
        </div>
      </Link>

      <Link href="/documents/dashboard" style={{ textDecoration: "none", color: "inherit" }}>
        <div style={card}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>📊 דוחות</div>
          <div style={{ color: "#666", fontSize: 14 }}>
            הכנסות, הוצאות, רווח וייצוא לרואה חשבון
          </div>
        </div>
      </Link>

      <Link href="/documents/search" style={{ textDecoration: "none", color: "inherit" }}>
        <div style={card}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>🔍 חיפוש</div>
          <div style={{ color: "#666", fontSize: 14 }}>
            חיפוש מסמכים לפי ספק, קטגוריה או טקסט
          </div>
        </div>
      </Link>
    </div>
  );
}