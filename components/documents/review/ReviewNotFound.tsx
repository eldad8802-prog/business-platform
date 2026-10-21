"use client";

import { TOKEN } from "@/lib/design/documents-theme";
import BackButton from "@/components/ui/back-button";
import { basePageStyle, mainStyle, primaryDarkButton, reviewCard } from "./review-ui";
import { useI18n } from "@/components/i18n/I18nProvider";

export default function ReviewNotFound({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  return (
    <div style={basePageStyle()}>
      <main style={mainStyle()}>
        {/* Back = the screen the document was opened from (search, inbox,
            home…); the CTA below is an explicit link to the documents hub. */}
        <div style={{ marginBottom: 12 }}>
          <BackButton />
        </div>
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
            {t("documents.review.notFound.title")}
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
            {t("documents.review.notFound.body")}
          </div>
          <div style={{ marginTop: 20 }}>
            <button type="button" style={primaryDarkButton(false)} onClick={onBack}>
              {t("documents.review.notFound.cta")}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
