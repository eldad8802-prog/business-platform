"use client";

import BackButton from "@/components/ui/back-button";

/**
 * Documents back button — a thin wrapper over the app-wide canonical
 * {@link BackButton}. Without `onClick` it returns to the screen the user
 * actually came from (falling back to the route registry's parent); pass
 * `onClick` only for an in-screen step.
 */
export default function DocumentsBackButton({
  onClick,
  label = "חזרה",
}: {
  onClick?: () => void;
  label?: string;
}) {
  return <BackButton onClick={onClick} label={label} />;
}
