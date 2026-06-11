export function basePageStyle() {
  return {
    minHeight: "100vh",
    background: "#ffffff" as const,
    color: "#0d1b3d",
  };
}

export function mainStyle() {
  return {
    maxWidth: 1080,
    margin: "0 auto",
    padding: "0 18px 150px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 22,
    boxSizing: "border-box" as const,
  };
}

export function primaryDarkButton(disabled?: boolean) {
  return {
    width: "100%",
    minHeight: 58,
    borderRadius: 16,
    border: "none",
    background: disabled
      ? "rgba(7, 91, 255, 0.45)"
      : "linear-gradient(180deg, #176bff 0%, #0050e6 100%)",
    color: "#ffffff",
    fontSize: 17,
    fontWeight: 900,
    cursor: disabled ? "not-allowed" : "pointer",
    boxShadow: disabled ? "none" : "0 14px 30px rgba(7, 91, 255, 0.24)",
  } as const;
}

export function secondaryButton(disabled?: boolean) {
  return {
    width: "100%",
    minHeight: 56,
    borderRadius: 16,
    border: "1px solid #d8e2f2",
    background: "#ffffff",
    color: "#075bff",
    fontSize: 15,
    fontWeight: 900,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
  } as const;
}

export const reviewCard = {
  background: "#ffffff",
  border: "1px solid #e1e8f4",
  borderRadius: 26,
  padding: 22,
  boxShadow: "0 16px 42px rgba(13, 27, 61, 0.07)",
};

export const reviewSoftPanel = {
  border: "1px solid #e1e8f4",
  background: "#f8fbff",
  borderRadius: 20,
  padding: 16,
};

export const reviewInput = {
  width: "100%",
  minHeight: 54,
  padding: "0 14px",
  borderRadius: 16,
  border: "1px solid #d8e2f2",
  background: "#ffffff",
  color: "#0d1b3d",
  fontSize: 16,
  fontWeight: 750,
  boxSizing: "border-box" as const,
};

export const orangePill = {
  borderRadius: 999,
  background: "#fff1e7",
  color: "#f0782b",
  padding: "7px 12px",
  fontSize: 12,
  fontWeight: 950,
};
