import type { ReactNode } from "react";

/**
 * Shared width/padding wrapper for the Corporate (marketing) area.
 * Mobile-first: narrow column on phones, widening at sm/lg breakpoints.
 */
export function CorporateContainer({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`mx-auto w-full max-w-md px-4 sm:max-w-3xl sm:px-6 lg:max-w-5xl ${className}`}
    >
      {children}
    </div>
  );
}
