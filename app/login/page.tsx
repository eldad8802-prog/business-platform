"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [bootLoading, setBootLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("token");

    if (token) {
      router.replace("/");
      return;
    }

    setBootLoading(false);
  }, [router]);

  const handleLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    try {
      setLoading(true);
      setError(null);

      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          password,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || "שגיאה בהתחברות");
      }

      if (!data?.token) {
        throw new Error("לא התקבל token מהשרת");
      }

      localStorage.setItem("token", data.token);

      if (data.user) {
        localStorage.setItem("user", JSON.stringify(data.user));
      }

      router.replace("/");
    } catch (err) {
      console.error("login error:", err);
      setError(err instanceof Error ? err.message : "שגיאה בהתחברות");
    } finally {
      setLoading(false);
    }
  };

  const pageStyle: React.CSSProperties = {
    minHeight: "100vh",
    background: "#f8fafc",
    direction: "rtl",
    padding: "24px 16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  const cardStyle: React.CSSProperties = {
    width: "100%",
    maxWidth: 460,
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 22,
    boxShadow: "0 10px 30px rgba(15, 23, 42, 0.07)",
    overflow: "hidden",
  };

  const headerStyle: React.CSSProperties = {
    padding: "28px 24px 18px",
    background: "linear-gradient(135deg, #ffffff 0%, #f8fafc 55%, #eef2ff 100%)",
    borderBottom: "1px solid #eef2f7",
  };

  const bodyStyle: React.CSSProperties = {
    padding: 24,
  };

  const labelStyle: React.CSSProperties = {
    display: "block",
    marginBottom: 8,
    fontWeight: 600,
    color: "#111827",
    fontSize: 14,
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "12px 14px",
    marginBottom: 16,
    border: "1px solid #d1d5db",
    borderRadius: 12,
    outline: "none",
    fontSize: 15,
    background: "#fff",
    boxSizing: "border-box",
  };

  const primaryButtonStyle: React.CSSProperties = {
    width: "100%",
    padding: "13px 16px",
    borderRadius: 12,
    border: "1px solid #111827",
    background: "#111827",
    color: "#ffffff",
    cursor: loading ? "not-allowed" : "pointer",
    fontWeight: 700,
    fontSize: 15,
  };

  if (bootLoading) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <div style={{ padding: 24, textAlign: "center" }}>טוען...</div>
        </div>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <div style={headerStyle}>
          <h1 style={{ margin: "0 0 8px 0", fontSize: 30, color: "#111827" }}>
            התחברות
          </h1>
          <p style={{ margin: 0, color: "#6b7280", lineHeight: 1.6 }}>
            התחבר כדי להמשיך לניהול המערכת שלך.
          </p>
        </div>

        <form style={bodyStyle} onSubmit={handleLogin}>
          <label style={labelStyle}>אימייל</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={inputStyle}
            placeholder="הכנס אימייל"
            autoComplete="email"
          />

          <label style={labelStyle}>סיסמה</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
            placeholder="הכנס סיסמה"
            autoComplete="current-password"
          />

          {error && (
            <div
              style={{
                marginBottom: 16,
                padding: 12,
                borderRadius: 12,
                background: "#fef2f2",
                border: "1px solid #fecaca",
                color: "#991b1b",
                fontSize: 14,
              }}
            >
              {error}
            </div>
          )}

          <button type="submit" disabled={loading} style={primaryButtonStyle}>
            {loading ? "מתחבר..." : "התחבר"}
          </button>

          <p
            style={{
              marginTop: 18,
              marginBottom: 0,
              color: "#6b7280",
              textAlign: "center",
              lineHeight: 1.7,
            }}
          >
            אין לך חשבון?{" "}
            <span
              style={{
                color: "#111827",
                cursor: "pointer",
                fontWeight: 700,
                textDecoration: "underline",
              }}
              onClick={() => router.push("/register")}
            >
              להרשמה
            </span>
          </p>
        </form>
      </div>
    </div>
  );
}