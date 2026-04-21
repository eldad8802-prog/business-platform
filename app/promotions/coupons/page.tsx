"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  fetchCoupons,
  rankCoupons,
  type CouponListItem,
} from "@/lib/revenue/issue/issue.helpers";

export default function CouponsHomePage() {
  const router = useRouter();

  const [searchInput, setSearchInput] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [coupons, setCoupons] = useState<CouponListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setError("אין הרשאה — התחבר מחדש");
      return;
    }

    loadCoupons();
  }, []);

  const loadCoupons = async () => {
    try {
      setLoading(true);
      setError("");

      const data = await fetchCoupons(token!);
      setCoupons(data);
    } catch (err) {
      console.error("Failed to load coupons:", err);
      setError("לא הצלחנו לטעון קופונים כרגע");
      setCoupons([]);
    } finally {
      setLoading(false);
    }
  };

  const filteredCoupons = useMemo(() => {
    const normalized = appliedSearch.trim().toLowerCase();
    const ranked = rankCoupons(coupons);

    if (!normalized) {
      return ranked.slice(0, 6);
    }

    return ranked.filter((coupon) => {
      const text = [coupon.title, coupon.description, coupon.city]
        .join(" ")
        .toLowerCase();

      return text.includes(normalized);
    });
  }, [appliedSearch, coupons]);

  const handleSearch = () => {
    setAppliedSearch(searchInput);
  };

  const handleClearSearch = () => {
    setSearchInput("");
    setAppliedSearch("");
  };

  return (
    <main style={styles.page}>
      <div style={styles.container}>
        <div style={styles.headerBlock}>
          <div style={styles.topRow}>
            <button
              type="button"
              onClick={() => router.push("/promotions")}
              style={styles.backButton}
            >
              חזרה
            </button>
          </div>

          <div style={styles.eyebrow}>Promotions / Coupons</div>
          <h1 style={styles.title}>קופונים</h1>
          <p style={styles.description}>
            כאן נמצאים הקופונים הפעילים, אזור החיפוש, ואפשרות ליצור קופון חדש
            מתוך שכבת הקופונים.
          </p>
        </div>

        <section style={styles.searchSection}>
          <div style={styles.sectionTitle}>חיפוש קופונים פעילים</div>

          <div style={styles.searchRow}>
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleSearch();
                }
              }}
              placeholder="חפש מוצר או שירות + עיר"
              style={styles.searchInput}
            />

            <button type="button" onClick={handleSearch} style={styles.searchButton}>
              חפש
            </button>

            <button type="button" onClick={handleClearSearch} style={styles.clearButton}>
              נקה
            </button>
          </div>

          <div style={styles.searchHint}>
            לדוגמה: טיפול פנים אשקלון, מסעדה תל אביב, אימון אישי אשדוד
          </div>
        </section>

        <section style={styles.actionsSection}>
          <div>
            <div style={styles.sectionTitle}>פעולות</div>
            <div style={styles.actionsHint}>
              יצירת קופון חדש היא פעולה נפרדת מאזור החיפוש.
            </div>
          </div>

          <button
            type="button"
            onClick={() => router.push("/offers/create")}
            style={styles.createButton}
          >
            צור קופון
          </button>
        </section>

        <section style={styles.resultsSection}>
          <div style={styles.resultsHeader}>
            <div style={styles.sectionTitle}>
              {appliedSearch ? "תוצאות חיפוש" : "6 הקופונים המובילים"}
            </div>

            <div style={styles.resultsCount}>{filteredCoupons.length} תוצאות</div>
          </div>

          {loading ? (
            <div style={styles.emptyState}>טוען קופונים...</div>
          ) : error ? (
            <div style={styles.emptyState}>{error}</div>
          ) : filteredCoupons.length === 0 ? (
            <div style={styles.emptyState}>
              לא נמצאו קופונים פעילים שמתאימים לחיפוש שלך.
            </div>
          ) : (
            <div style={styles.grid}>
              {filteredCoupons.map((coupon) => (
                <div key={coupon.id} style={styles.card}>
                  <div style={styles.cardTopRow}>
                    <div style={styles.cardTitle}>{coupon.title}</div>
                    <span style={styles.activeBadge}>פעיל</span>
                  </div>

                  <div style={styles.cardDescription}>{coupon.description}</div>

                  <button
                    type="button"
                    onClick={() =>
                      router.push(`/revenue/issue?offerId=${coupon.id}&autoIssue=1`)
                    }
                    style={styles.cardButton}
                  >
                    עבור להנפקת קופון
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    padding: "24px 16px 40px",
    background: "#f8f5ef",
    direction: "rtl",
  },
  container: {
    maxWidth: 980,
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    gap: 20,
  },
  headerBlock: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 24,
    padding: 24,
  },
  topRow: {
    display: "flex",
    justifyContent: "flex-start",
    marginBottom: 12,
  },
  backButton: {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid #d1d5db",
    background: "#ffffff",
    color: "#111827",
    fontWeight: 700,
    cursor: "pointer",
  },
  eyebrow: {
    fontSize: 13,
    fontWeight: 800,
    color: "#5f6b66",
    marginBottom: 10,
  },
  title: {
    margin: 0,
    fontSize: 34,
    lineHeight: 1.15,
    color: "#111827",
  },
  description: {
    marginTop: 12,
    marginBottom: 0,
    fontSize: 16,
    lineHeight: 1.7,
    color: "#4b5563",
  },
  searchSection: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 20,
    padding: 18,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: 800,
    color: "#111827",
  },
  searchRow: {
    display: "grid",
    gridTemplateColumns: "1fr auto auto",
    gap: 10,
    alignItems: "center",
  },
  searchInput: {
    width: "100%",
    padding: "14px 16px",
    borderRadius: 14,
    border: "1px solid #d1d5db",
    fontSize: 16,
    background: "#ffffff",
    boxSizing: "border-box",
  },
  searchButton: {
    padding: "14px 18px",
    borderRadius: 14,
    border: "none",
    background: "#111827",
    color: "#ffffff",
    fontWeight: 800,
    cursor: "pointer",
  },
  clearButton: {
    padding: "14px 18px",
    borderRadius: 14,
    border: "1px solid #d1d5db",
    background: "#ffffff",
    color: "#111827",
    fontWeight: 800,
    cursor: "pointer",
  },
  searchHint: {
    fontSize: 13,
    color: "#6b7280",
    lineHeight: 1.6,
  },
  actionsSection: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 20,
    padding: 18,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    flexWrap: "wrap",
  },
  actionsHint: {
    marginTop: 6,
    fontSize: 13,
    color: "#6b7280",
  },
  createButton: {
    padding: "14px 20px",
    borderRadius: 16,
    background: "#111827",
    color: "#ffffff",
    border: "none",
    fontWeight: 800,
    cursor: "pointer",
    minWidth: 160,
  },
  resultsSection: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  resultsHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
  },
  resultsCount: {
    fontSize: 13,
    fontWeight: 700,
    color: "#6b7280",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: 12,
  },
  card: {
    background: "#ffffff",
    padding: 16,
    borderRadius: 18,
    border: "1px solid #e5e7eb",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  cardTopRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  cardTitle: {
    fontWeight: 800,
    fontSize: 16,
    color: "#111827",
  },
  activeBadge: {
    fontSize: 12,
    fontWeight: 800,
    color: "#14532d",
    background: "#dcfce7",
    borderRadius: 999,
    padding: "6px 10px",
    whiteSpace: "nowrap",
  },
  cardDescription: {
    fontSize: 14,
    lineHeight: 1.6,
    color: "#4b5563",
  },
  cardButton: {
    marginTop: "auto",
    padding: "12px 14px",
    borderRadius: 12,
    border: "none",
    background: "#111827",
    color: "#ffffff",
    fontWeight: 700,
    cursor: "pointer",
  },
  emptyState: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 18,
    padding: 20,
    color: "#6b7280",
    fontSize: 14,
    textAlign: "center",
  },
};