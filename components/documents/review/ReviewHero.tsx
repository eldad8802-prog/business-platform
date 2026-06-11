import type { ReviewState } from "@/lib/documents/review/types";

export default function ReviewHero({ state }: { state: ReviewState }) {
  return (
    <section style={{ textAlign: "center", padding: "34px 0 8px" }}>
      <div
        aria-hidden
        style={{
          width: 58,
          height: 58,
          borderRadius: 18,
          border: "2px solid #0d1b3d",
          color: "#0d1b3d",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 18,
          position: "relative",
        }}
      >
        <span
          style={{
            position: "absolute",
            width: 28,
            height: 4,
            borderRadius: 999,
            background: "#0d1b3d",
            top: 19,
          }}
        />
        <span
          style={{
            position: "absolute",
            width: 22,
            height: 4,
            borderRadius: 999,
            background: state === "done" ? "#ff8a2a" : "#0d1b3d",
            top: 32,
          }}
        />
      </div>
      <h1
        style={{
          margin: 0,
          color: "#0d1b3d",
          fontSize: 42,
          lineHeight: 1.2,
          fontWeight: 950,
          letterSpacing: 0,
        }}
      >
        {state === "done" ? "המסמך אומת" : "אימות מסמך"}
      </h1>
      <p
        style={{
          margin: "12px auto 0",
          color: "#6b7899",
          fontSize: 18,
          lineHeight: 1.6,
          fontWeight: 700,
          maxWidth: 560,
        }}
      >
        {state === "done"
          ? "המסמך נשמר באמת הפיננסית של העסק."
          : "בדוק את הפרטים, תקן אם צריך, ואשר את המסמך."}
      </p>
    </section>
  );
}
