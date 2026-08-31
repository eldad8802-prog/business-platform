"use client";

import { useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { useRouter } from "next/navigation";
import { QRCodeCanvas } from "qrcode.react";
import type {
  IssueOffer,
  IssuedCoupon,
} from "@/lib/revenue/issue/issue.types";
import {
  formatIssueDate,
  getOfferSummary,
} from "@/lib/revenue/issue/issue.helpers";

type CouponDisplayProps = {
  offer: IssueOffer;
  coupon: IssuedCoupon;
  onOpenFullScreen: () => void;
  onReset: () => void;
};

export default function CouponDisplay({
  offer,
  coupon,
  onOpenFullScreen,
}: CouponDisplayProps) {
  const router = useRouter();
  const [shareMessage, setShareMessage] = useState("");

  const offerSummary = getOfferSummary(offer.title, offer.description);

  const whatsappText = [
    "היי,",
    `נוצר עבורך קופון לשימוש בתנאים הבאים: ${offer.title}`,
    offerSummary ? `פרטי הקופון: ${offerSummary}` : "",
    `קוד קופון: ${coupon.token}`,
    `תוקף: ${formatIssueDate(coupon.expiresAt)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const handleShareToWhatsApp = () => {
    try {
      const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(
        whatsappText
      )}`;

      window.location.href = whatsappUrl;
      setShareMessage("פותח WhatsApp...");
    } catch (error) {
      console.error("WhatsApp share error:", error);
      setShareMessage("לא הצלחנו לפתוח WhatsApp");
    }
  };

  const handleCopyMessage = async () => {
    try {
      await navigator.clipboard.writeText(whatsappText);
      setShareMessage("ההודעה הועתקה");
    } catch (error) {
      console.error("Copy message error:", error);
      setShareMessage("לא הצלחנו להעתיק את ההודעה");
    }
  };

  return (
    <div
      style={{
        background: "var(--dz-surface)",
        borderRadius: 24,
        border: "1px solid var(--dz-border)",
        padding: 20,
      }}
    >
      <div style={{ display: "grid", gap: 16 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-start",
          }}
        >
          <button
            type="button"
            onClick={() => router.push("/promotions/coupons")}
            style={{
              padding: "10px 14px",
              borderRadius: 12,
              border: "1px solid var(--dz-border-strong)",
              background: "var(--dz-surface)",
              color: "var(--dz-text-primary)",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            חזרה
          </button>
        </div>

        <div
          style={{
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "var(--dz-text-muted)",
              marginBottom: 6,
            }}
          >
            קופון מוכן למימוש
          </div>

          <div
            style={{
              fontSize: 14,
              color: "var(--dz-text-secondary)",
              lineHeight: 1.6,
            }}
          >
            זהו השלב השני בזרימת הקופונים. אפשר לשתף, להציג, ולהמשיך לשימוש
            בפועל.
          </div>
        </div>

        <div
          style={{
            width: "100%",
            maxWidth: 320,
            margin: "0 auto",
            padding: 16,
            borderRadius: 20,
            background: "var(--dz-surface)",
            border: "1px solid var(--dz-border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <QRCodeCanvas
            value={coupon.qrValue}
            size={280}
            includeMargin
            style={{
              width: "100%",
              height: "auto",
              maxWidth: 280,
              display: "block",
            }}
          />
        </div>

        <div style={{ textAlign: "right" }}>
          <div
            style={{
              fontSize: 14,
              color: "var(--dz-text-muted)",
              marginBottom: 6,
            }}
          >
            מה הלקוח מקבל
          </div>

          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: "var(--dz-text-primary)",
              marginBottom: 8,
              lineHeight: 1.3,
            }}
          >
            {offer.title}
          </div>

          <div
            style={{
              fontSize: 13,
              color: "var(--dz-text-muted)",
              marginBottom: 10,
            }}
          >
            קופון לשימוש ממוקד בתנאים ברורים
          </div>

          <div
            style={{
              fontSize: 15,
              color: "var(--dz-text-secondary)",
              lineHeight: 1.6,
              marginBottom: 14,
            }}
          >
            {offerSummary}
          </div>

          <div
            style={{
              display: "grid",
              gap: 6,
              fontSize: 14,
              color: "var(--dz-text-muted)",
              lineHeight: 1.8,
            }}
          >
            <div>קוד קופון: {coupon.token}</div>
            <div>נוצר: {formatIssueDate(coupon.issuedAt)}</div>
            <div>תוקף: {formatIssueDate(coupon.expiresAt)}</div>
          </div>
        </div>

        {shareMessage && (
          <div
            style={{
              padding: "12px 14px",
              borderRadius: 14,
              background: "var(--dz-success-bg-soft)",
              border: "1px solid var(--dz-success-border)",
              color: "var(--dz-success)",
              fontSize: 14,
              fontWeight: 700,
              textAlign: "center",
            }}
          >
            {shareMessage}
          </div>
        )}

        <div style={{ display: "grid", gap: 10 }}>
          <button
            type="button"
            onClick={handleShareToWhatsApp}
            style={{
              padding: "14px 16px",
              borderRadius: 16,
              border: "none",
              background: TOKEN.action.primary.background,
              color: "var(--dz-text-on-brand)",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            שתף ב־WhatsApp
          </button>

          <button
            type="button"
            onClick={handleCopyMessage}
            style={{
              padding: "14px 16px",
              borderRadius: 16,
              border: "1px solid var(--dz-border-strong)",
              background: "var(--dz-surface)",
              color: "var(--dz-text-primary)",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            העתק הודעה
          </button>

          <button
            type="button"
            onClick={onOpenFullScreen}
            style={{
              padding: "14px 16px",
              borderRadius: 16,
              border: "1px solid var(--dz-border-strong)",
              background: "var(--dz-surface)",
              color: "var(--dz-text-primary)",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            הצג במסך מלא
          </button>
        </div>
      </div>
    </div>
  );
}
