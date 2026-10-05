"use client";

/**
 * The business logo: the stored `billingLogoDataUrl`, or the business's
 * initials on the approved dark-teal disc when there is none.
 *
 * `editable` adds the camera button. It saves through the existing
 * invoice-profile endpoint (same field, same validation the documents use)
 * after shrinking the picture to an encoding that endpoint accepts.
 */
import { useId, useRef, useState } from "react";

import { CameraGlyph } from "@/components/ui/warm-surface/glyphs";

import { saveBusinessLogo } from "../data/use-account-data";
import { LOGO_ACCEPT, LOGO_ERROR_MESSAGE, prepareLogo } from "../data/prepare-logo";
import styles from "./business-logo.module.css";

export function businessInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return Array.from(words[0]).slice(0, 2).join("");
  return Array.from(words[0])[0] + Array.from(words[1])[0];
}

type Props = {
  name: string;
  logoDataUrl: string | null;
  size: number;
  /** Visual variant: the profile hero disc, or the smaller disc on the teal account card. */
  variant?: "hero" | "onTeal";
  editable?: boolean;
  /** Called after a logo was saved, so the caller can reload what it shows. */
  onSaved?: () => void;
  className?: string;
};

export function BusinessLogo({ name, logoDataUrl, size, variant = "hero", editable = false, onSaved, className }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const shown = preview ?? logoDataUrl;
  const initials = businessInitials(name);

  async function onPick(file: File | null) {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const prepared = await prepareLogo(file);
      if (!prepared.ok) {
        setError(LOGO_ERROR_MESSAGE[prepared.reason]);
        return;
      }
      const result = await saveBusinessLogo(prepared.dataUrl);
      if (result !== "ok") {
        setError(LOGO_ERROR_MESSAGE[result]);
        return;
      }
      setPreview(prepared.dataUrl);
      onSaved?.();
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className={[styles.wrap, className].filter(Boolean).join(" ")}>
      <span
        className={[styles.disc, variant === "onTeal" ? styles.discOnTeal : styles.discHero].join(" ")}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.34) }}
      >
        {shown ? (
          // A data URL from the business's own profile — next/image adds nothing here.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shown} alt={`הלוגו של ${name}`} className={styles.img} />
        ) : (
          <span aria-hidden="true">{initials}</span>
        )}
        {!shown ? <span className={styles.srOnly}>{`אין לוגו לעסק ${name}`}</span> : null}
      </span>

      {editable ? (
        <>
          <button
            type="button"
            className={styles.camera}
            aria-label={shown ? "החלפת לוגו" : "העלאת לוגו"}
            aria-describedby={error ? errorId : undefined}
            aria-busy={busy}
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? <span className={styles.spinner} aria-hidden="true" /> : <CameraGlyph size={16} />}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept={LOGO_ACCEPT}
            className={styles.input}
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => void onPick(e.target.files?.[0] ?? null)}
          />
          {error ? (
            <p id={errorId} role="alert" className={styles.error}>
              {error}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
