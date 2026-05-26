import type { ReviewState } from "@/lib/documents/review/types";

export default function ReviewHero({ state }: { state: ReviewState }) {
  return (
    <section style={{ textAlign: "center", padding: "4px 0 6px" }}>
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: 999,
          background: "#002b6b",
          color: "#ffffff",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 18,
          fontWeight: 950,
          marginBottom: 8,
        }}
      >
        {state === "done" ? "3" : "2"}
      </div>
      <h1
        style={{
          margin: 0,
          color: "#0f172a",
          fontSize: 28,
          lineHeight: 1.2,
          fontWeight: 950,
        }}
      >
        {state === "done" ? "אישור הושלם - התוצאה העסקית" : "בדיקת מסמך - אישור מערכת"}
      </h1>
      <p
        style={{
          margin: "6px 0 0",
          color: "#64748b",
          fontSize: 14,
          lineHeight: 1.6,
          fontWeight: 800,
        }}
      >
        {state === "done"
          ? "המסמך נוסף לדוחות - מה עכשיו?"
          : "המערכת ניתחה את המסמך - אתה רק מאשר ומתקן במידת הצורך"}
      </p>
    </section>
  );
}
