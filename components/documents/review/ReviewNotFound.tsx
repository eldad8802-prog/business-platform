import { TOKEN } from "@/lib/design/documents-theme";
import { basePageStyle, mainStyle, primaryDarkButton, reviewCard } from "./review-ui";

export default function ReviewNotFound({ onBack }: { onBack: () => void }) {
  return (
    <div dir="rtl" style={basePageStyle()}>
      <main style={mainStyle()}>
        <div style={{ ...reviewCard, maxWidth: 560, width: "100%", margin: "40px auto 0" }}>
          <div
            style={{
              fontSize: 24,
              color: TOKEN.ink.primary,
              margin: 0,
              textAlign: "center",
              fontWeight: 950,
            }}
          >
            לא מצאנו את המסמך
          </div>
          <div
            style={{
              fontSize: 15,
              color: TOKEN.ink.muted,
              textAlign: "center",
              marginTop: 12,
              lineHeight: 1.6,
            }}
          >
            נסה לחזור למסמכים ולפתוח את המסמך שוב.
          </div>
          <div style={{ marginTop: 20 }}>
            <button type="button" style={primaryDarkButton(false)} onClick={onBack}>
              חזרה למסמכים
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
