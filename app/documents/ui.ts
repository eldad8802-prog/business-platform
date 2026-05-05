export const layout = {
  minHeight: "100vh",
  background: "#f8fafc",
};

export const header = {
  fontSize: 28,
  fontWeight: 950,
  margin: 0,
  lineHeight: 1.25,
  color: "#111827",
};

export const subheader = {
  color: "#6b7280",
  fontSize: 14,
  marginTop: 8,
  marginBottom: 0,
  lineHeight: 1.7,
};

export const topBar = {
  display: "grid",
  gridTemplateColumns: "48px 1fr 48px",
  alignItems: "center",
  marginBottom: 20,
};

export const backBtn = {
  width: 40,
  height: 40,
  borderRadius: 14,
  border: "1px solid #e5e7eb",
  background: "#fff",
  fontSize: 18,
};

export const topTitle = {
  textAlign: "center" as const,
  fontSize: 16,
  fontWeight: 600,
};

export const card = {
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 26,
  padding: 18,
  boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
};

export const sectionTitle = {
  fontWeight: 950,
  marginBottom: 10,
  color: "#111827",
};

export const input = {
  width: "100%",
  padding: 12,
  borderRadius: 14,
  border: "1px solid #d1d5db",
  fontSize: 16,
  marginTop: 6,
  boxSizing: "border-box" as const,
};

export const primaryBtn = {
  width: "100%",
  minHeight: 54,
  padding: 14,
  background: "#111827",
  color: "#ffffff",
  border: "none",
  borderRadius: 18,
  fontSize: 15,
  fontWeight: 950,
  marginTop: 16,
};

export const secondaryBtn = {
  width: "100%",
  minHeight: 52,
  padding: 12,
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 18,
  fontSize: 14,
  fontWeight: 900,
  marginTop: 10,
};

export const emptyState = {
  ...card,
  textAlign: "center" as const,
  color: "#6b7280",
};

export const pageMain = {
  maxWidth: 980,
  margin: "0 auto",
  padding: 16,
  display: "flex",
  flexDirection: "column" as const,
  gap: 16,
};

export const hero = {
  borderRadius: 30,
  padding: 22,
  background:
    "linear-gradient(135deg, #111827 0%, #1f2937 50%, #0f766e 100%)",
  color: "#ffffff",
  boxShadow: "0 18px 44px rgba(15, 23, 42, 0.22)",
  display: "flex",
  flexDirection: "column" as const,
  gap: 12,
};

export const heroKicker = {
  fontSize: 12,
  opacity: 0.8,
  fontWeight: 800,
  marginBottom: 10,
};

export const heroTitle = {
  margin: 0,
  fontSize: 28,
  lineHeight: 1.25,
  fontWeight: 950,
};

export const heroSubText = {
  margin: "8px 0 0",
  color: "rgba(255,255,255,0.78)",
  fontSize: 14,
  lineHeight: 1.7,
};

export const alertError = {
  border: "1px solid #fecaca",
  background: "#fef2f2",
  color: "#991b1b",
  borderRadius: 18,
  padding: 14,
  fontSize: 14,
  fontWeight: 800,
  lineHeight: 1.5,
};

export const alertSuccess = {
  border: "1px solid #bbf7d0",
  background: "#f0fdf4",
  color: "#166534",
  borderRadius: 18,
  padding: 14,
  fontSize: 14,
  fontWeight: 800,
  lineHeight: 1.5,
};