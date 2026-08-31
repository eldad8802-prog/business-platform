"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import IssueHeader from "./issue-header";
import OfferPicker from "./offer-picker";
import CouponDisplay from "./coupon-display";
import IssueEmptyState from "./issue-empty-state";
import IssueLoadingState from "./issue-loading-state";
import FullScreenQrModal from "./full-screen-qr-modal";
import {
  fetchOffers,
  createCoupon,
} from "@/lib/revenue/issue/issue.helpers";
import { TOKEN } from "@/lib/design/tokens";

import type {
  IssueFlowState,
  IssueOffer,
  IssuedCoupon,
} from "@/lib/revenue/issue/issue.types";

export default function IssueScreen() {
  const [flowState, setFlowState] = useState<IssueFlowState>("idle");
  const [offers, setOffers] = useState<IssueOffer[]>([]);
  const [selectedOffer, setSelectedOffer] = useState<IssueOffer | null>(null);
  const [coupon, setCoupon] = useState<IssuedCoupon | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [isFullScreenOpen, setIsFullScreenOpen] = useState(false);

  const autoIssuedRef = useRef(false);

  const searchParams = useSearchParams();
  const offerIdFromQuery = searchParams.get("offerId");
  const autoIssue = searchParams.get("autoIssue") === "1";

  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  useEffect(() => {
    if (!token) {
      setFlowState("error");
      setErrorMessage("אין הרשאה — התחבר מחדש");
      return;
    }

    loadOffers();
  }, []);

  useEffect(() => {
    if (!offerIdFromQuery) return;
    if (offers.length === 0) return;
    if (coupon) return;
    if (autoIssuedRef.current) return;

    const match = offers.find(
      (offer) => String(offer.id) === String(offerIdFromQuery)
    );

    if (!match) {
      setFlowState("error");
      setErrorMessage("לא מצאנו את ההצעה שנבחרה");
      return;
    }

    setSelectedOffer(match);

    if (autoIssue) {
      autoIssuedRef.current = true;
      handleCreateCoupon(match);
    }
  }, [offerIdFromQuery, offers, coupon, autoIssue]);

  const loadOffers = async () => {
    try {
      const data = await fetchOffers(token!);
      setOffers(data);
      setFlowState("idle");
      setErrorMessage("");
    } catch {
      setFlowState("error");
      setErrorMessage("שגיאה בטעינת הצעות");
    }
  };

  const handleCreateCoupon = async (offer: IssueOffer) => {
    try {
      setSelectedOffer(offer);
      setFlowState("creating");
      setErrorMessage("");

      const newCoupon = await createCoupon(offer.id, token!);

      setCoupon(newCoupon);
      setFlowState("ready");
    } catch {
      setFlowState("error");
      setErrorMessage("שגיאה ביצירת קופון");
    }
  };

  const handleSelectOffer = async (offer: IssueOffer) => {
    await handleCreateCoupon(offer);
  };

  const handleReset = () => {
    setFlowState("idle");
    setSelectedOffer(null);
    setCoupon(null);
    setErrorMessage("");
    setIsFullScreenOpen(false);
    autoIssuedRef.current = false;
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "var(--dz-surface-muted)",
        padding: "24px 16px",
      }}
    >
      <div
        style={{
          maxWidth: 720,
          margin: "0 auto",
        }}
      >
        <IssueHeader />

        {flowState === "idle" && !autoIssue && !offerIdFromQuery && (
          <OfferPicker
            offers={offers}
            selectedOffer={selectedOffer}
            onSelectOffer={handleSelectOffer}
          />
        )}

        {flowState === "idle" && !autoIssue && offerIdFromQuery && selectedOffer && (
          <div
            style={{
              background: "var(--dz-surface)",
              borderRadius: 24,
              border: "1px solid var(--dz-border)",
              padding: 20,
            }}
          >
            <div
              style={{
                fontSize: 14,
                color: "var(--dz-text-muted)",
                marginBottom: 8,
              }}
            >
              ההצעה שנבחרה
            </div>

            <div
              style={{
                fontSize: 24,
                fontWeight: 800,
                color: "var(--dz-text-primary)",
                marginBottom: 10,
              }}
            >
              {selectedOffer.title}
            </div>

            <div
              style={{
                fontSize: 15,
                color: "var(--dz-text-secondary)",
                lineHeight: 1.6,
                marginBottom: 16,
              }}
            >
              {selectedOffer.description || "ללא תיאור"}
            </div>

            <button
              type="button"
              onClick={() => handleCreateCoupon(selectedOffer)}
              style={{
                width: "100%",
                padding: "14px 16px",
                borderRadius: 16,
                border: "none",
                background: TOKEN.action.primary.background,
                color: "var(--dz-text-on-brand)",
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              הנפק קופון
            </button>
          </div>
        )}

        {flowState === "idle" && autoIssue && selectedOffer && (
          <div
            style={{
              background: "var(--dz-surface)",
              borderRadius: 24,
              border: "1px solid var(--dz-border)",
              padding: 20,
            }}
          >
            <div
              style={{
                fontSize: 14,
                color: "var(--dz-text-muted)",
                marginBottom: 8,
              }}
            >
              ההצעה שנבחרה
            </div>

            <div
              style={{
                fontSize: 24,
                fontWeight: 800,
                color: "var(--dz-text-primary)",
                marginBottom: 10,
              }}
            >
              {selectedOffer.title}
            </div>

            <div
              style={{
                fontSize: 15,
                color: "var(--dz-text-secondary)",
                lineHeight: 1.6,
              }}
            >
              {selectedOffer.description || "ללא תיאור"}
            </div>
          </div>
        )}

        {flowState === "creating" && <IssueLoadingState />}

        {flowState === "ready" && selectedOffer && coupon && (
          <>
            <CouponDisplay
              offer={selectedOffer}
              coupon={coupon}
              onOpenFullScreen={() => setIsFullScreenOpen(true)}
              onReset={handleReset}
            />

            <FullScreenQrModal
              isOpen={isFullScreenOpen}
              qrValue={coupon.qrValue}
              onClose={() => setIsFullScreenOpen(false)}
            />
          </>
        )}

        {flowState === "error" && (
          <IssueEmptyState
            title="משהו השתבש"
            description={errorMessage}
            actionLabel="נסה שוב"
            onAction={loadOffers}
          />
        )}
      </div>
    </main>
  );
}