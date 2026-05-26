import { card } from "@/app/(shell)/documents/ui";
import DocumentsHeader from "@/components/documents/DocumentsHeader";
import { basePageStyle, mainStyle, primaryDarkButton } from "./review-ui";

export default function ReviewNotFound({ onBack }: { onBack: () => void }) {
  return (
    <div dir="rtl" style={basePageStyle()}>
      <DocumentsHeader title="בדיקת מסמך" />
      <main style={mainStyle()}>
        <div style={card}>
          <div
            style={{
              fontSize: 22,
              color: "#111827",
              margin: 0,
              textAlign: "center",
              fontWeight: 900,
            }}
          >
            לא מצאנו את המסמך
          </div>
          <div
            style={{
              fontSize: 15,
              color: "#6b7280",
              textAlign: "center",
              marginTop: 12,
            }}
          >
            נסה לחזור לרשימת המסמכים ולפתוח שוב.
          </div>
          <div style={{ marginTop: 18 }}>
            <button type="button" style={primaryDarkButton(false)} onClick={onBack}>
              חזרה למסמכים
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
