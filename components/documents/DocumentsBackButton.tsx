"use client";

import BackButton from "@/components/ui/back-button";

/**
 * Documents back button — now a thin wrapper over the app-wide canonical
 * {@link BackButton} so every screen shares one identical control. Kept as a
 * named export so existing Documents call sites don't change.
 */
export default function DocumentsBackButton({
  onClick,
  label = "חזרה",
}: {
  onClick: () => void;
  label?: string;
}) {
  return <BackButton onClick={onClick} label={label} />;
}
