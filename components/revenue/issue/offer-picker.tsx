import type { IssueOffer } from "@/lib/revenue/issue/issue.types";

type OfferPickerProps = {
  offers: IssueOffer[];
  selectedOffer: IssueOffer | null;
  onSelectOffer: (offer: IssueOffer) => void;
};

export default function OfferPicker({
  offers,
  selectedOffer,
  onSelectOffer,
}: OfferPickerProps) {
  if (!offers.length) {
    return (
      <div
        style={{
          padding: 20,
          borderRadius: 20,
          background: "#ffffff",
          border: "1px solid #e5e7eb",
        }}
      >
        אין כרגע הצעות זמינות.
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gap: 12,
      }}
    >
      {offers.map((offer) => {
        const isSelected = selectedOffer?.id === offer.id;

        return (
          <button
            key={offer.id}
            type="button"
            onClick={() => onSelectOffer(offer)}
            style={{
              width: "100%",
              textAlign: "right",
              padding: "18px 16px",
              borderRadius: 18,
              border: isSelected ? "2px solid #111827" : "1px solid #d1d5db",
              background: isSelected ? "#f9fafb" : "#ffffff",
              cursor: "pointer",
              position: "relative",
              transition: "all 0.2s ease",
              boxShadow: isSelected
                ? "0 8px 24px rgba(17, 24, 39, 0.08)"
                : "none",
            }}
          >
            {isSelected ? (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "4px 10px",
                  borderRadius: 999,
                  background: "#111827",
                  color: "#ffffff",
                  fontSize: 12,
                  fontWeight: 700,
                  marginBottom: 10,
                }}
              >
                נבחר
              </div>
            ) : null}

            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: "#111827",
                marginBottom: 6,
              }}
            >
              {offer.title}
            </div>

            <div
              style={{
                fontSize: 14,
                color: "#6b7280",
                lineHeight: 1.5,
              }}
            >
              {offer.description || "ללא תיאור"}
            </div>
          </button>
        );
      })}
    </div>
  );
}