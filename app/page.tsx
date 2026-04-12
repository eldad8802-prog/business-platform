"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type StoredUser = {
  name?: string;
  businessName?: string;
};

type ActionLinkProps = {
  title: string;
  subtitle: string;
  badge?: string;
  href: string;
};

export default function HomePage() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");

  useEffect(() => {
    const token = localStorage.getItem("token");

    if (!token) {
      router.replace("/login");
      return;
    }

    try {
      const rawUser = localStorage.getItem("user");

      if (rawUser) {
        const parsedUser: StoredUser = JSON.parse(rawUser);
        setDisplayName(
          parsedUser.businessName?.trim() || parsedUser.name?.trim() || ""
        );
      }
    } catch (error) {
      console.error("HOME_PARSE_USER_ERROR:", error);
    }
  }, [router]);

  return (
    <main style={styles.page}>
      <div style={styles.shell}>
        <header style={styles.header}>
          <div style={styles.eyebrow}>נקודת התחלה</div>
          <h1 style={styles.title}>{displayName || "נתחיל ממשהו פשוט"}</h1>
          <p style={styles.subtitle}>בחר פעולה אחת והמשך משם</p>
        </header>

        <Link href="/pricing" style={styles.primaryCard}>
          <div style={styles.primaryBadge}>הפעולה הראשית</div>
          <div style={styles.primaryTitle}>חשב מחיר למוצר / שירות</div>
          <div style={styles.primaryText}>
            התחלה פשוטה, ברורה ומהירה עם מנוע התמחור
          </div>
        </Link>

        <section style={styles.section}>
          <div style={styles.sectionTitle}>פעולות נוספות</div>

          <div style={styles.grid}>
            <ActionLink
              title="שיחות עם לקוחות"
              subtitle="כניסה לאינבוקס"
              badge="זמין"
              href="/inbox"
            />

            <ActionLink
              title="יצירת תוכן"
              subtitle="הפיצ׳ר ייפתח בהמשך"
              badge="בקרוב"
              href="/posts"
            />

            <ActionLink
              title="מבצעים"
              subtitle="הפיצ׳ר ייפתח בהמשך"
              badge="בקרוב"
              href="/offers"
            />

            <ActionLink
              title="העסק שלי"
              subtitle="הפיצ׳ר ייפתח בהמשך"
              badge="בקרוב"
              href="/business"
            />
          </div>
        </section>
      </div>
    </main>
  );
}

function ActionLink({ title, subtitle, badge, href }: ActionLinkProps) {
  return (
    <Link href={href} style={styles.card}>
      <div style={styles.cardTopRow}>
        <div style={styles.cardTitle}>{title}</div>
        {badge ? (
          <span
            style={
              badge === "זמין" ? styles.availableBadge : styles.comingSoonBadge
            }
          >
            {badge}
          </span>
        ) : null}
      </div>

      <div style={styles.cardSubtitle}>{subtitle}</div>
    </Link>
  );
}

const baseLinkStyle: React.CSSProperties = {
  width: "100%",
  textDecoration: "none",
  boxSizing: "border-box",
  WebkitTapHighlightColor: "transparent",
  touchAction: "manipulation",
  userSelect: "none",
  display: "block",
};

const styles: { [key: string]: React.CSSProperties } = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%)",
    direction: "rtl",
    overflowX: "hidden",
  },

  shell: {
    width: "100%",
    maxWidth: 560,
    margin: "0 auto",
    padding: "24px 16px 40px",
    boxSizing: "border-box",
  },

  header: {
    marginBottom: 20,
  },

  eyebrow: {
    fontSize: 13,
    fontWeight: 800,
    color: "#64748b",
    marginBottom: 8,
  },

  title: {
    margin: 0,
    fontSize: 28,
    lineHeight: 1.2,
    fontWeight: 800,
    color: "#0f172a",
    wordBreak: "break-word",
  },

  subtitle: {
    margin: "10px 0 0",
    fontSize: 15,
    lineHeight: 1.6,
    color: "#475569",
  },

  primaryCard: {
    ...baseLinkStyle,
    minHeight: 160,
    borderRadius: 24,
    padding: "20px 18px",
    background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
    color: "#ffffff",
    boxShadow: "0 18px 40px rgba(16, 185, 129, 0.22)",
    marginBottom: 24,
  },

  primaryBadge: {
    display: "inline-block",
    fontSize: 12,
    fontWeight: 800,
    padding: "6px 10px",
    borderRadius: 999,
    background: "rgba(255,255,255,0.18)",
    marginBottom: 16,
  },

  primaryTitle: {
    fontSize: 24,
    lineHeight: 1.25,
    fontWeight: 800,
    marginBottom: 8,
    wordBreak: "break-word",
  },

  primaryText: {
    fontSize: 15,
    lineHeight: 1.6,
    opacity: 0.96,
    wordBreak: "break-word",
  },

  section: {
    marginTop: 4,
  },

  sectionTitle: {
    fontSize: 15,
    fontWeight: 800,
    color: "#334155",
    marginBottom: 12,
  },

  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 12,
  },

  card: {
    ...baseLinkStyle,
    minHeight: 118,
    borderRadius: 20,
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    padding: "16px 14px",
    boxShadow: "0 8px 24px rgba(15, 23, 42, 0.05)",
  },

  cardTopRow: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 8,
  },

  cardTitle: {
    fontSize: 16,
    fontWeight: 800,
    lineHeight: 1.35,
    color: "#0f172a",
    wordBreak: "break-word",
  },

  cardSubtitle: {
    marginTop: 10,
    fontSize: 13,
    lineHeight: 1.5,
    color: "#64748b",
    wordBreak: "break-word",
  },

  comingSoonBadge: {
    display: "inline-block",
    fontSize: 12,
    fontWeight: 800,
    color: "#92400e",
    background: "#fef3c7",
    padding: "6px 10px",
    borderRadius: 999,
  },

  availableBadge: {
    display: "inline-block",
    fontSize: 12,
    fontWeight: 800,
    color: "#166534",
    background: "#dcfce7",
    padding: "6px 10px",
    borderRadius: 999,
  },
};