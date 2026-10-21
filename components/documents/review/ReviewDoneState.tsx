"use client";

import ReviewOutcomeRow from "./ReviewOutcomeRow";
import { primaryDarkButton, reviewCard, secondaryButton } from "./review-ui";
import { TOKEN } from "@/lib/design/documents-theme";
import { useI18n } from "@/components/i18n/I18nProvider";

export type ReviewDoneStateProps = {
  approvedAs: "financial" | "document" | null;
  directionDisplay: string;
  amountDisplay: string;
  nextPendingDocumentId: number | null;
  onNext: () => void;
  onHub: () => void;
  onSearch: () => void;
};

export default function ReviewDoneState({
  approvedAs,
  directionDisplay,
  amountDisplay,
  nextPendingDocumentId,
  onNext,
  onHub,
  onSearch,
}: ReviewDoneStateProps) {
  const { t } = useI18n();
  return (
    <section
      style={{
        ...reviewCard,
        maxWidth: 660,
        width: "100%",
        margin: "0 auto",
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: 92,
          height: 92,
          borderRadius: 999,
          background: TOKEN.semantic.success.bg,
          color: TOKEN.semantic.success.ink,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 48,
          fontWeight: TOKEN.weight.bold,
          margin: "4px auto 18px",
          boxShadow: TOKEN.shadow.elevated,
        }}
      >
        ✓
      </div>
      <h2
        style={{
          margin: 0,
          color: TOKEN.ink.primary,
          fontSize: TOKEN.font.hero,
          lineHeight: 1.3,
          fontWeight: TOKEN.weight.bold,
        }}
      >
        {t("documents.review.done.title")}
      </h2>
      <p
        style={{
          margin: "10px 0 20px",
          color: TOKEN.ink.muted,
          fontSize: TOKEN.font.body,
          fontWeight: TOKEN.weight.semibold,
          lineHeight: 1.6,
        }}
      >
        {approvedAs === "financial"
          ? t("documents.review.done.bodyFinancial", { direction: directionDisplay, amount: amountDisplay })
          : t("documents.review.done.bodyDocument")}
      </p>

      <div
        style={{
          border: `1px solid ${TOKEN.border.DEFAULT}`,
          background: TOKEN.surface.inset,
          borderRadius: TOKEN.radius.card,
          textAlign: "start",
          overflow: "hidden",
        }}
      >
        <ReviewOutcomeRow
          icon="✓"
          title={t("documents.review.done.savedTitle")}
          body={
            approvedAs === "financial"
              ? t("documents.review.done.savedFinancial")
              : t("documents.review.done.savedDocument")
          }
        />
        <ReviewOutcomeRow
          icon="✓"
          title={t("documents.review.done.availableTitle")}
          body={
            approvedAs === "financial"
              ? t("documents.review.done.availableFinancial")
              : t("documents.review.done.availableDocument")
          }
        />
      </div>

      <div
        style={{
          marginTop: 20,
          border: `1px solid ${TOKEN.border.DEFAULT}`,
          borderRadius: TOKEN.radius.card,
          padding: 16,
          background: TOKEN.surface.card,
        }}
      >
        <div style={{ color: TOKEN.ink.primary, fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.bold, marginBottom: 12 }}>
          {t("documents.review.done.whatNext")}
        </div>
        <button type="button" style={primaryDarkButton(false)} onClick={onNext}>
          {nextPendingDocumentId ? t("documents.review.done.verifyNext") : t("documents.review.done.backToQueue")}
        </button>
        <button
          type="button"
          style={{ ...secondaryButton(false), marginTop: 10 }}
          onClick={onHub}
        >
          {t("documents.review.done.backToDocuments")}
        </button>
      </div>

      {approvedAs === "financial" ? (
        <button
          type="button"
          style={{
            border: "none",
            background: "transparent",
            color: TOKEN.brand.mid,
            marginTop: 14,
            fontSize: 13,
            fontWeight: TOKEN.weight.bold,
            cursor: "pointer",
          }}
          onClick={onSearch}
        >
          {t("documents.review.done.goToSearch")}
        </button>
      ) : null}
    </section>
  );
}
