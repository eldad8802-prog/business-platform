import Link from "next/link";
import {
  SIGNUP_DISABLED_MESSAGE_HE,
  SIGNUP_DISABLED_TITLE_HE,
  isPublicSignupEnabled,
} from "@/lib/auth/signup-gate";
import RegisterForm from "./register-form";

/**
 * Server-side gate for the registration screen. When public signup is closed
 * the registration form is never sent to the browser at all — the visitor gets
 * a plain Hebrew notice and a route back to login. The real enforcement lives
 * in app/api/auth/register/route.ts; this is the UI half of the same decision.
 *
 * Styling follows the Dubiz Mist tokens used by the login/register screens —
 * no new colors.
 */
export const dynamic = "force-dynamic";

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background:
    "radial-gradient(circle at top right, rgba(30, 106, 74,0.10), transparent 28%), linear-gradient(135deg, var(--dz-surface-muted) 0%, var(--dz-brand-soft) 45%, var(--dz-surface-flat) 100%)",
  direction: "rtl",
  padding: "24px 16px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const cardStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 540,
  background: "rgba(255,255,255,0.96)",
  border: "1px solid var(--dz-border)",
  borderRadius: 28,
  boxShadow: "0 20px 60px rgba(52, 60, 50, 0.12)",
  overflow: "hidden",
  backdropFilter: "blur(8px)",
  padding: "40px 28px",
  textAlign: "center",
};

const titleStyle: React.CSSProperties = {
  margin: "0 0 12px 0",
  fontSize: 28,
  lineHeight: 1.2,
  color: "var(--dz-text-primary)",
  letterSpacing: "-0.02em",
};

const messageStyle: React.CSSProperties = {
  margin: "0 0 28px 0",
  color: "var(--dz-text-secondary)",
  lineHeight: 1.7,
  fontSize: 15,
};

const linkStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "14px 28px",
  borderRadius: 14,
  background: "var(--dz-text-primary)",
  color: "var(--dz-surface-flat)",
  fontWeight: 700,
  fontSize: 15,
  textDecoration: "none",
};

function SignupClosedNotice() {
  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <h1 style={titleStyle}>{SIGNUP_DISABLED_TITLE_HE}</h1>
        <p style={messageStyle}>{SIGNUP_DISABLED_MESSAGE_HE}</p>
        <Link href="/login" style={linkStyle}>
          כניסה למשתמשים קיימים
        </Link>
      </div>
    </div>
  );
}

export default function RegisterPage() {
  if (!isPublicSignupEnabled()) {
    return <SignupClosedNotice />;
  }

  return <RegisterForm />;
}
