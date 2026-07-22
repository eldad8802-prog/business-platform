"use client";

import {
  UploadIcon,
  CameraIcon,
  GmailLogo,
  WhatsappLogo,
} from "./home-icons";

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
  return (
    <section className="dz-hero" aria-label="קליטת מסמך">
      <span className="dz-hero__eyebrow">
        <span className="dz-hero__pdot" />
        קליטה חכמה
      </span>
      <h2 className="dz-hero__title">נקלוט מסמך חדש?</h2>
      <p className="dz-hero__sub">סרקו, צלמו או העלו — נזהה ספק, סכום ותאריך אוטומטית.</p>

      <div className="dz-cta-row">
        <button
          type="button"
          className="dz-cta dz-cta--solid"
          onClick={onUpload}
          disabled={uploading}
        >
          <UploadIcon />
          {uploading ? "מעלה…" : "העלאת קובץ"}
        </button>
        <button
          type="button"
          className="dz-cta dz-cta--ghost"
          onClick={onCamera}
          disabled={uploading}
        >
          <CameraIcon />
          צילום
        </button>
      </div>

      <div className="dz-or">
        <span>או ייבאו אוטומטית</span>
      </div>

      <div className="dz-hero__imports">
        <button type="button" className="dz-himport" onClick={onGmail}>
          <span className="dz-hlogo dz-hlogo--gmail">
            <GmailLogo />
          </span>
          מ‑Gmail
        </button>
        <button type="button" className="dz-himport" onClick={onWhatsapp}>
          <span className="dz-hlogo">
            <WhatsappLogo />
          </span>
          מ‑WhatsApp
        </button>
      </div>

      <div className="dz-hero__hint">קובץ עד 4MB · PDF או תמונה</div>
    </section>
  );
}
