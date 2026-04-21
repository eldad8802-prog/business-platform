export const layout = {
  maxWidth: 720,
  margin: "0 auto",
  padding: "20px 16px 32px",
};

export const header = {
  fontSize: 24,
  fontWeight: 700,
  margin: 0,
};

export const subheader = {
  color: "#666",
  fontSize: 14,
  marginTop: 6,
  marginBottom: 20,
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
  borderRadius: 10,
  border: "1px solid #e7e7e7",
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
  border: "1px solid #eee",
  borderRadius: 14,
  padding: 16,
  marginBottom: 14,
};

export const sectionTitle = {
  fontWeight: 600,
  marginBottom: 8,
};

export const input = {
  width: "100%",
  padding: 12,
  borderRadius: 10,
  border: "1px solid #ddd",
  fontSize: 16,
  marginTop: 6,
  boxSizing: "border-box" as const,
};

export const primaryBtn = {
  width: "100%",
  padding: 14,
  background: "#111",
  color: "#fff",
  border: "none",
  borderRadius: 12,
  fontSize: 16,
  marginTop: 16,
};

export const secondaryBtn = {
  width: "100%",
  padding: 12,
  background: "#f5f5f5",
  border: "none",
  borderRadius: 12,
  fontSize: 14,
  marginTop: 10,
};

export const emptyState = {
  ...card,
  textAlign: "center" as const,
  color: "#666",
};