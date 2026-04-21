"use client";

import { useEffect, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";

type Offer = {
  id: number;
  title: string;
  description: string | null;
  customerBenefitText: string;
  validUntil: string;
  isActive: boolean;
};

export default function OffersPage() {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedOfferId, setSelectedOfferId] = useState<number | null>(null);
  const [generatedTokens, setGeneratedTokens] = useState<Record<number, string>>(
    {}
  );
  const [creatingCouponFor, setCreatingCouponFor] = useState<number | null>(
    null
  );

  const fetchOffers = async () => {
    try {
      setLoading(true);
      setError(null);

      const authToken = localStorage.getItem("token");

      if (!authToken) {
        setError("No token found in localStorage");
        setOffers([]);
        return;
      }

      const res = await fetch("/api/offers", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
        cache: "no-store",
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to load offers");
        setOffers([]);
        return;
      }

      const nextOffers = Array.isArray(data.offers) ? data.offers : [];
      setOffers(nextOffers);

      if (nextOffers.length > 0 && selectedOfferId === null) {
        setSelectedOfferId(nextOffers[0].id);
      }
    } catch (err) {
      console.error("fetchOffers error:", err);
      setError("Failed to load offers");
      setOffers([]);
    } finally {
      setLoading(false);
    }
  };

  const createCoupon = async (offerId: number) => {
    try {
      setError(null);
      setCreatingCouponFor(offerId);

      const authToken = localStorage.getItem("token");

      if (!authToken) {
        setError("No token found in localStorage");
        return;
      }

      const res = await fetch(`/api/offers/${offerId}/coupon`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to create coupon");
        return;
      }

      if (data.coupon?.token) {
        setGeneratedTokens((prev) => ({
          ...prev,
          [offerId]: data.coupon.token,
        }));
      } else {
        setError("Coupon created but token missing");
      }
    } catch (err) {
      console.error("createCoupon error:", err);
      setError("Failed to create coupon");
    } finally {
      setCreatingCouponFor(null);
    }
  };

  useEffect(() => {
    fetchOffers();
  }, []);

  const visibleOffers = offers.slice(0, 6);

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 20,
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ margin: 0 }}>Offers</h1>
        <button onClick={fetchOffers}>🔄 Refresh</button>
      </div>

      {loading && <p>Loading...</p>}

      {!loading && error && (
        <div
          style={{
            marginBottom: 16,
            padding: 12,
            border: "1px solid #e5a1a1",
            background: "#fff5f5",
            borderRadius: 10,
          }}
        >
          {error}
        </div>
      )}

      {!loading && !error && visibleOffers.length === 0 && <p>No offers found.</p>}

      {!loading && !error && visibleOffers.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 16,
          }}
        >
          {visibleOffers.map((offer) => {
            const isSelected = selectedOfferId === offer.id;
            const generatedToken = generatedTokens[offer.id];

            return (
              <div
                key={offer.id}
                onClick={() => setSelectedOfferId(offer.id)}
                style={{
                  border: isSelected ? "2px solid #111827" : "1px solid #d1d5db",
                  borderRadius: 14,
                  padding: 16,
                  cursor: "pointer",
                  background: isSelected ? "#f8fafc" : "#ffffff",
                  boxShadow: isSelected
                    ? "0 8px 24px rgba(0,0,0,0.08)"
                    : "0 2px 8px rgba(0,0,0,0.04)",
                  transition: "all 0.15s ease",
                }}
              >
                <div style={{ marginBottom: 10 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <h3 style={{ margin: 0 }}>{offer.title}</h3>
                    {isSelected && (
                      <span
                        style={{
                          fontSize: 12,
                          padding: "4px 8px",
                          borderRadius: 999,
                          background: "#111827",
                          color: "#fff",
                        }}
                      >
                        Selected
                      </span>
                    )}
                  </div>
                </div>

                {offer.description && (
                  <p style={{ margin: "0 0 8px 0" }}>{offer.description}</p>
                )}

                <p style={{ margin: "0 0 8px 0" }}>
                  <strong>Benefit:</strong> {offer.customerBenefitText}
                </p>

                <p style={{ margin: "0 0 8px 0" }}>
                  <strong>Valid until:</strong>{" "}
                  {new Date(offer.validUntil).toLocaleString()}
                </p>

                <p style={{ margin: "0 0 16px 0" }}>
                  <strong>Status:</strong> {offer.isActive ? "Active" : "Inactive"}
                </p>

                {isSelected ? (
                  <>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        createCoupon(offer.id);
                      }}
                      disabled={creatingCouponFor === offer.id}
                      style={{
                        padding: "10px 14px",
                        borderRadius: 10,
                        border: "1px solid #d1d5db",
                        background: "#fff",
                        cursor: "pointer",
                        fontWeight: 600,
                      }}
                    >
                      {creatingCouponFor === offer.id
                        ? "Creating..."
                        : "🎟 Create QR Coupon"}
                    </button>

                    {generatedToken && (
                      <div
                        style={{
                          marginTop: 18,
                          padding: 16,
                          border: "1px solid #cbd5e1",
                          borderRadius: 12,
                          background: "#ffffff",
                          textAlign: "center",
                        }}
                      >
                        <h4 style={{ marginTop: 0, marginBottom: 12 }}>Coupon QR</h4>

                        <div style={{ marginBottom: 12 }}>
                          <QRCodeCanvas value={generatedToken} size={180} />
                        </div>

                        <div
                          style={{
                            fontSize: 12,
                            color: "#374151",
                            marginBottom: 6,
                          }}
                        >
                          Token
                        </div>

                        <code
                          style={{
                            wordBreak: "break-all",
                            display: "block",
                            fontSize: 12,
                          }}
                        >
                          {generatedToken}
                        </code>
                      </div>
                    )}
                  </>
                ) : (
                  <div
                    style={{
                      padding: "10px 12px",
                      borderRadius: 10,
                      background: "#f3f4f6",
                      color: "#4b5563",
                      fontSize: 14,
                    }}
                  >
                    לחץ על הכרטיס כדי לפתוח אפשרות ליצירת QR
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}