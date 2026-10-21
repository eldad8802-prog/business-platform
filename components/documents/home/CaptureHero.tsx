"use client";

import {
  UploadIcon,
  CameraIcon,
  GmailLogo,
  WhatsappLogo,
} from "./home-icons";
import { ComingSoonPill } from "@/components/ui/coming-soon/ComingSoonPill";
import { useI18n } from "@/components/i18n/I18nProvider";

type CaptureHeroProps = {
  /** Opens the file picker. Invoked synchronously inside the click handler so the
   * user gesture is preserved (iOS Safari blocks deferred picker opens). */
  onUpload: () => void;
  onCamera: () => void;
  onGmail: () => void;
  onWhatsapp: () => void;
  uploading: boolean;
};

/**
 * The single canonical intake surface — upload / camera CTAs plus the automatic
 * Gmail / WhatsApp import options, all on the teal brand gradient. These buttons
 * ARE the intake chooser (no intermediate modal), which is what keeps the file
 * picker openable within the iOS user gesture.
 */
export default function CaptureHero({
  onUpload,
  onCamera,
  onGmail,
  onWhatsapp,
  uploading,
}: CaptureHeroProps) {
  const { t } = useI18n();
  return (
    <section className="dz-hero" aria-label={t("documents.home.captureAria")}>
      <span className="dz-hero__eyebrow">
        <span className="dz-hero__pdot" />
        {t("documents.home.captureEyebrow")}
      </span>
      <h2 className="dz-hero__title">{t("documents.home.captureTitle")}</h2>
      <p className="dz-hero__sub">{t("documents.home.captureSub")}</p>

      <div className="dz-cta-row">
        <button
          type="button"
          className="dz-cta dz-cta--solid"
          onClick={onUpload}
          disabled={uploading}
        >
          <UploadIcon />
          {uploading ? t("documents.home.uploading") : t("documents.home.uploadFile")}
        </button>
        <button
          type="button"
          className="dz-cta dz-cta--ghost"
          onClick={onCamera}
          disabled={uploading}
        >
          <CameraIcon />
          {t("documents.home.camera")}
        </button>
      </div>

      <div className="dz-or">
        <span>{t("documents.home.orImport")}</span>
      </div>

      <div className="dz-hero__imports">
        <button type="button" className="dz-himport" onClick={onGmail}>
          <span className="dz-hlogo dz-hlogo--gmail">
            <GmailLogo />
          </span>
          {t("documents.home.fromGmail")}
        </button>
        {/* Importing from WhatsApp needs the WhatsApp Business connection, not open yet: inactive, "בקרוב". */}
        <button type="button" className="dz-himport" onClick={onWhatsapp} disabled aria-disabled style={{ opacity: 0.6, cursor: "not-allowed" }}>
          <span className="dz-hlogo">
            <WhatsappLogo />
          </span>
          {t("documents.home.fromWhatsapp")}
          <ComingSoonPill />
        </button>
      </div>

      <div className="dz-hero__hint">{t("documents.home.fileHint")}</div>
    </section>
  );
}
