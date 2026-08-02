import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";

/**
 * PrimaryCta — the shared public Primary action button.
 *
 * This is the ONLY place the public marketing/auth pages should build a primary
 * CTA. All visual styling lives in the single `dz-btn-primary` class in
 * `app/globals.css` (the Dubiz DS v1 teal spec) — this component just picks the
 * right element and applies that class, so there is no per-page CSS to drift.
 *
 * - Pass `href` → renders a Next `<Link>` (marketing CTAs).
 * - Omit `href` → renders a `<button>` (form submits; supports `disabled`,
 *   `type="submit"`, `onClick`, …).
 * - Width is intrinsic by default. Pass `block` for full-width (form submits).
 */
type BaseProps = {
  children: ReactNode;
  /** Full-width (100%). Default is intrinsic width — never auto-stretches. */
  block?: boolean;
  className?: string;
};

type LinkCtaProps = BaseProps & { href: string } & Omit<
    ComponentProps<typeof Link>,
    "href" | "className" | "children"
  >;

type ButtonCtaProps = BaseProps & { href?: undefined } & Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "className" | "children"
  >;

function classes(block?: boolean, extra?: string): string {
  return ["dz-btn-primary", block ? "dz-btn-primary--block" : "", extra]
    .filter(Boolean)
    .join(" ");
}

export function PrimaryCta(props: LinkCtaProps | ButtonCtaProps) {
  if (props.href !== undefined) {
    const { href, children, block, className, ...rest } = props;
    return (
      <Link href={href} className={classes(block, className)} {...rest}>
        {children}
      </Link>
    );
  }

  const { children, block, className, type, ...rest } = props;
  return (
    <button type={type ?? "button"} className={classes(block, className)} {...rest}>
      {children}
    </button>
  );
}
