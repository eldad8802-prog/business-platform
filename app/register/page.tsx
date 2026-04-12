"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function RegisterPage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [businessName, setBusinessName] = useState("");
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

  const handleRegister = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    try {
      setLoading(true);
      setError(null);

      const registerRes = await fetch("/api/auth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          businessName,
          email,
          password,
        }),
      });

      const registerData = await registerRes.json();

      if (!registerRes.ok) {
        throw new Error(registerData?.error || "שגיאה בהרשמה");
      }

      const loginRes = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          password,
        }),
      });

      const loginData = await loginRes.json();

      if (!loginRes.ok) {
        throw new Error(loginData?.error || "שגיאה בהתחברות");
      }

      if (!loginData?.token) {
        throw new Error("לא התקבל token מהשרת");
      }

      localStorage.setItem("token", loginData.token);

      if (loginData.user) {
        localStorage.setItem("user", JSON.stringify(loginData.user));
      }

      router.replace("/");
    } catch (err) {
      console.error("register error:", err);
      setError(err instanceof Error ? err.message : "שגיאה בהרשמה");
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
    maxWidth: 520,
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

  const helperTextStyle: React.CSSProperties = {
    marginTop: -4,
    marginBottom: 12,
    color: "#6b7280",
    fontSize: 13,
    lineHeight: 1.5,
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
            הרשמה
          </h1>
          <p style={{ margin: 0, color: "#6b7280", lineHeight: 1.6 }}>
            צור חשבון חדש כדי להתחיל לעבוד עם המערכת. פרטי העסק המתקדמים
            יושלמו בשלב קצר אחרי הכניסה.
          </p>
        </div>

        <form style={bodyStyle} onSubmit={handleRegister}>
          <label style={labelStyle}>שם מלא</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={inputStyle}
            placeholder="הכנס שם מלא"
          />

          <label style={labelStyle}>שם העסק</label>
          <input
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            style={inputStyle}
            placeholder="הכנס את שם העסק"
          />
          <div style={helperTextStyle}>
            זהו השם הראשוני של העסק שלך במערכת. אפשר יהיה לעדכן פרטים נוספים
            בהמשך.
          </div>

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
            autoComplete="new-password"
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
            {loading ? "יוצר חשבון..." : "צור חשבון"}
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
            כבר יש לך חשבון?{" "}
            <span
              style={{
                color: "#111827",
                cursor: "pointer",
                fontWeight: 700,
                textDecoration: "underline",
              }}
              onClick={() => router.push("/login")}
            >
              להתחברות
            </span>
          </p>
        </form>
      </div>
    </div>
  );
}