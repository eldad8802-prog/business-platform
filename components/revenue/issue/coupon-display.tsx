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
import { useI18n } from "@/components/i18n/I18nProvider";

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
  const { t, locale, formatDate } = useI18n();
  // Hebrew keeps the legacy issue-date text byte-for-byte; other languages use the shared formatter.
  const showDate = (value: string | null | undefined) =>
    locale === "he" ? formatIssueDate(value) : formatDate(value, "dateTime");
  const [shareMessage, setShareMessage] = useState("");

  const offerSummary = getOfferSummary(offer.title, offer.description);

  // The share text goes to the CUSTOMER (outbound message), not the interface — it stays in the
  // business's Hebrew until outbound messages follow a stored customer language (i18n B-4).
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
      setShareMessage(t("billing.couponIssue.whatsappOpening"));
    } catch (error) {
      console.error("WhatsApp share error:", error);
      setShareMessage(t("billing.couponIssue.whatsappFailed"));
    }
  };

  const handleCopyMessage = async () => {
    try {
      await navigator.clipboard.writeText(whatsappText);
      setShareMessage(t("billing.couponIssue.messageCopied"));
    } catch (error) {
      console.error("Copy message error:", error);
      setShareMessage(t("billing.couponIssue.copyFailed"));
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
            {t("common.back")}
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
            {t("billing.couponIssue.couponReady")}
          </div>

          <div
            style={{
              fontSize: 14,
              color: "var(--dz-text-secondary)",
              lineHeight: 1.6,
            }}
          >
            {t("billing.couponIssue.couponReadyHelp")}
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

        <div style={{ textAlign: "start" }}>
          <div
            style={{
              fontSize: 14,
              color: "var(--dz-text-muted)",
              marginBottom: 6,
            }}
          >
            {t("billing.couponIssue.customerGets")}
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
            {t("billing.couponIssue.couponTagline")}
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
            <div>{t("billing.couponIssue.couponCode", { code: coupon.token })}</div>
            <div>{t("billing.couponIssue.createdAt", { date: showDate(coupon.issuedAt) })}</div>
            <div>{t("billing.couponIssue.validUntil", { date: showDate(coupon.expiresAt) })}</div>
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
            {t("billing.couponIssue.shareWhatsapp")}
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
            {t("billing.couponIssue.copyMessage")}
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
            {t("billing.couponIssue.showFullScreen")}
          </button>
        </div>
      </div>
    </div>
  );
}
