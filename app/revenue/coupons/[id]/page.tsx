"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { QRCodeCanvas } from "qrcode.react";
import { useHideShellChrome } from "@/components/navigation/shell-chrome-visibility";
import { useI18n } from "@/components/i18n/I18nProvider";
import { intlTag, type Locale } from "@/lib/i18n/config";
import type { Translator } from "@/lib/i18n/translate";

type PublicCouponDetailsDTO = {
  coupon: {
    publicId: string;
    status: "ACTIVE" | "REDEEMED" | "EXPIRED" | "CANCELLED";
    issuedAt: string;
    expiresAt: string;
    redeemedAt: string | null;
  };
  offer: {
    id: number;
    title: string;
    customerBenefitText: string;
    description: string | null;
    imageUrl: string | null;
  };
  business: {
    id: number;
    name: string;
  };
};

type CouponCodeDTO = {
  token: string;
  qrValue: string;
  redeemLink: string;
};

function formatDate(value: string | null | undefined, locale: Locale) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(intlTag(locale));
}

function statusLabel(status: PublicCouponDetailsDTO["coupon"]["status"], t: Translator) {
  switch (status) {
    case "ACTIVE":
      return { text: t("billing.couponPage.statusActive"), className: "bg-[var(--dz-success-bg)] text-[var(--dz-brand)]" };
    case "REDEEMED":
      return { text: t("billing.couponPage.statusRedeemed"), className: "bg-[var(--dz-surface-muted)] text-[var(--dz-text-secondary)]" };
    case "EXPIRED":
      return { text: t("billing.couponPage.statusExpired"), className: "bg-[var(--dz-warning-bg)] text-[var(--dz-warning)]" };
    case "CANCELLED":
      return { text: t("billing.couponPage.statusCancelled"), className: "bg-[var(--dz-danger-bg)] text-[var(--dz-danger)]" };
    default:
      return { text: status, className: "bg-[var(--dz-surface-muted)] text-[var(--dz-text-secondary)]" };
  }
}

export default function RevenueCouponDetailsPage() {
  // CONSUMER surface. It shares the `/revenue` prefix — and therefore the
  // Revenue layout's ShellChrome — with the owner's management screens, but a
  // customer holding a coupon must never be handed the business's navigation.
  // Declared here rather than assumed from the URL: the chrome policy follows
  // from what the surface *is*. With chrome off the shell drops its offsets, so
  // this page lays out exactly as it did before the layout existed.
  useHideShellChrome(true);
  const router = useRouter();
  const { t, locale } = useI18n();
  const params = useParams<{ id: string }>();
  const publicId = params?.id || "";

  const [details, setDetails] = useState<PublicCouponDetailsDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [viewMode, setViewMode] = useState<"details" | "code">("details");
  const [codeLoading, setCodeLoading] = useState(false);
  const [codeError, setCodeError] = useState("");
  const [codeErrorKind, setCodeErrorKind] = useState<
    "none" | "login" | "forbidden" | "generic"
  >("none");
  const [code, setCode] = useState<CouponCodeDTO | null>(null);
  const [shareMessage, setShareMessage] = useState("");
  const [qrSize, setQrSize] = useState<220 | 320>(220);

  const canRevealCode = useMemo(() => {
    if (!details) return false;
    if (details.coupon.status !== "ACTIVE") return false;
    const expiresMs = new Date(details.coupon.expiresAt).getTime();
    return !Number.isNaN(expiresMs) && expiresMs > Date.now();
  }, [details]);

  const loadDetails = async () => {
    try {
      setLoading(true);
      setError("");

      if (!publicId) {
        throw new Error(t("billing.couponPage.invalidId"));
      }

      const res = await fetch(`/api/revenue/coupons/${publicId}`, {
        cache: "no-store",
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || t("billing.couponPage.loadError"));
      }

      setDetails(data);
    } catch (err) {
      console.error("Failed to load coupon details:", err);
      setDetails(null);
      setError(err instanceof Error ? err.message : t("billing.couponPage.loadError"));
    } finally {
      setLoading(false);
    }
  };

  const loadCode = async () => {
    try {
      setCodeLoading(true);
      setCodeError("");
      setCodeErrorKind("none");
      setShareMessage("");
      setViewMode("code");

      // W1-01: /code is authenticated + issuer-only. Attach the business bearer
      // token; anonymous → login CTA, non-issuer → clear 403 message.
      const token =
        typeof window !== "undefined" ? localStorage.getItem("token") : null;
      if (!token) {
        setCode(null);
        setCodeErrorKind("login");
        setCodeError(t("billing.couponPage.codeLoginRequired"));
        return;
      }

      const res = await fetch(`/api/revenue/coupons/${publicId}/code`, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.status === 401) {
        setCode(null);
        setCodeErrorKind("login");
        setCodeError(t("billing.couponPage.codeSessionExpired"));
        return;
      }
      if (res.status === 403) {
        setCode(null);
        setCodeErrorKind("forbidden");
        setCodeError(t("billing.couponPage.codeForbidden"));
        return;
      }

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || t("billing.couponPage.codeUnavailable"));
      }

      setCode(data);
    } catch (err) {
      console.error("Failed to load coupon code:", err);
      setCode(null);
      setCodeErrorKind("generic");
      setCodeError(err instanceof Error ? err.message : t("billing.couponPage.codeUnavailable"));
    } finally {
      setCodeLoading(false);
    }
  };

  const renderCodeErrorBlock = () =>
    codeError ? (
      <div className="mt-3 rounded-2xl border border-[var(--dz-danger-border)] bg-[var(--dz-danger-bg-soft)] p-4 text-sm font-semibold text-[var(--dz-danger)]">
        {codeError}
        {codeErrorKind === "login" ? (
          <button
            type="button"
            onClick={() => router.push("/login")}
            className="mt-3 block w-full rounded-2xl bg-[var(--dz-brand)] px-4 py-3 text-sm font-bold text-[var(--dz-text-on-brand)] active:scale-[0.99]"
          >
            {t("billing.couponPage.login")}
          </button>
        ) : null}
      </div>
    ) : null;

  useEffect(() => {
    loadDetails();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicId]);

  const handleCopy = async (text: string, successMsg: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setShareMessage(successMsg);
    } catch (err) {
      console.error("clipboard error:", err);
      setShareMessage(t("billing.couponPage.copyFailed"));
    }
  };

  const handleShareWhatsApp = (text: string) => {
    try {
      const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
      window.location.href = whatsappUrl;
      setShareMessage(t("billing.couponIssue.whatsappOpening"));
    } catch (err) {
      console.error("whatsapp error:", err);
      setShareMessage(t("billing.couponIssue.whatsappFailed"));
    }
  };

  // `fetch()`ing the page HTML won't include client-rendered text,
  // so keep a stable marker for smoke tests.
  const REVEAL_BUTTON_LABEL = t("billing.couponPage.revealCode");

  if (loading) {
    return (
      <main className="min-h-screen bg-[var(--dz-background)] px-4 pb-10 pt-4 text-[var(--dz-text-primary)]">
        <div className="mx-auto w-full max-w-md sm:max-w-2xl lg:max-w-4xl">
          <div className="rounded-[24px] dz-mist p-5 shadow-sm">
            {t("billing.couponPage.loadingDetails")}
          </div>
        </div>
      </main>
    );
  }

  if (error || !details) {
    return (
      <main className="min-h-screen bg-[var(--dz-background)] px-4 pb-10 pt-4 text-[var(--dz-text-primary)]">
        <div className="mx-auto w-full max-w-md sm:max-w-2xl lg:max-w-4xl">
          <div className="rounded-[24px] dz-mist p-5 shadow-sm">
            <div className="text-sm font-semibold text-[var(--dz-danger)]">
              {error || t("billing.couponPage.loadFailed")}
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => router.push("/revenue")}
                className="rounded-2xl border border-[var(--dz-border)] dz-mist px-4 py-3 text-sm font-semibold"
              >
                {t("common.back")}
              </button>
              <button
                type="button"
                onClick={loadDetails}
                className="rounded-2xl bg-[var(--dz-brand)] px-4 py-3 text-sm font-semibold text-[var(--dz-text-on-brand)]"
              >
                {t("billing.couponIssue.tryAgain")}
              </button>
            </div>
          </div>
        </div>
      </main>
    );
  }

  const badge = statusLabel(details.coupon.status, t);
  // The share text below goes to the CUSTOMER (outbound message), so it keeps the business's
  // Hebrew — including its own "no description" fallback and date — whatever the viewer's language.
  const benefitText = details.offer.customerBenefitText || details.offer.description || "";
  const benefit = benefitText || t("billing.couponIssue.noDescription");
  const shareBenefit = benefitText || "ללא תיאור";

  const whatsappText = code
    ? [
        "היי,",
        `קופון: ${details.offer.title}`,
        `מה מקבלים: ${shareBenefit}`,
        `קוד קופון: ${code.token}`,
        `תוקף עד: ${formatDate(details.coupon.expiresAt, "he")}`,
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const renderDetailsView = () => (
    <>
      <div className="overflow-hidden rounded-[28px] dz-mist shadow-sm">
        <div className="relative h-[220px] w-full bg-[var(--dz-background)]">
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <div className="text-3xl">🛍️</div>
              <div className="mt-1 text-xs font-semibold text-[var(--dz-text-muted)]">
                {t("billing.couponPage.noImage")}
              </div>
            </div>
          </div>

          {details.offer.imageUrl ? (
            <img
              src={details.offer.imageUrl}
              alt={details.offer.title}
              className="absolute inset-0 h-full w-full object-cover"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          ) : null}
        </div>

        <div className="p-5">
          <div className="text-2xl font-extrabold leading-tight text-[var(--dz-text-primary)]">
            {details.offer.title}
          </div>

          <div className="mt-3 text-base font-semibold leading-7 text-[var(--dz-text-secondary)]">
            {benefit}
          </div>

          {details.offer.description ? (
            <div className="mt-3 text-sm leading-7 text-[var(--dz-text-muted)]">
              {details.offer.description}
            </div>
          ) : null}

          <div className="mt-5 grid gap-2 text-sm text-[var(--dz-text-muted)]">
            <div>
              <span className="font-semibold text-[var(--dz-text-primary)]">{t("billing.couponPage.businessLabel")}</span>{" "}
              {details.business.name}
            </div>
            <div>
              <span className="font-semibold text-[var(--dz-text-primary)]">{t("billing.couponPage.validUntilLabel")}</span>{" "}
              {formatDate(details.coupon.expiresAt, locale)}
            </div>
            {details.coupon.status === "REDEEMED" && details.coupon.redeemedAt ? (
              <div>
                <span className="font-semibold text-[var(--dz-text-primary)]">{t("billing.couponPage.redeemedLabel")}</span>{" "}
                {formatDate(details.coupon.redeemedAt, locale)}
              </div>
            ) : null}
          </div>

          <div className="mt-6">
            <button
              type="button"
              disabled={!canRevealCode || codeLoading}
              onClick={loadCode}
              className={`w-full rounded-2xl px-4 py-3.5 text-sm font-bold text-[var(--dz-text-on-brand)] transition ${
                canRevealCode && !codeLoading
                  ? "bg-[var(--dz-brand)] active:scale-[0.99]"
                  : "bg-[var(--dz-border-strong)] cursor-not-allowed"
              }`}
            >
              {codeLoading ? t("billing.couponPage.loadingCode") : REVEAL_BUTTON_LABEL}
            </button>

            {!canRevealCode ? (
              <div className="mt-2 text-xs font-semibold text-[var(--dz-text-muted)]">
                {t("billing.couponPage.activeOnly")}
              </div>
            ) : null}

            {renderCodeErrorBlock()}
          </div>
        </div>
      </div>
    </>
  );

  const renderCodeView = () => (
    <div className="overflow-hidden rounded-[28px] dz-mist shadow-sm">
      <div className="p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-base font-extrabold text-[var(--dz-text-primary)]">
              {t("billing.couponPage.codeTitle")}
            </div>
            <div className="mt-1 text-xs font-semibold text-[var(--dz-text-muted)]">
              {t("billing.couponPage.codeHelp")}
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              setViewMode("details");
              setShareMessage("");
              setQrSize(220);
            }}
            className="shrink-0 rounded-2xl border border-[var(--dz-border)] dz-mist px-3 py-2 text-xs font-semibold text-[var(--dz-text-secondary)] active:scale-[0.99]"
          >
            {t("billing.couponPage.backToDetails")}
          </button>
        </div>

        {codeLoading ? (
          <div className="rounded-2xl border border-[var(--dz-border)] bg-[var(--dz-surface-muted)] p-4 text-sm font-semibold text-[var(--dz-text-secondary)]">
            {t("billing.couponPage.loadingCode")}
          </div>
        ) : codeError ? (
          renderCodeErrorBlock()
        ) : code ? (
          <>
            <div className="mt-3 flex justify-center">
              <div className="rounded-[20px] border border-[var(--dz-border)] dz-mist p-4">
                <QRCodeCanvas value={code.qrValue} size={qrSize} includeMargin />
              </div>
            </div>

            <div className="mt-3 flex justify-center gap-2">
              <button
                type="button"
                onClick={() => setQrSize((prev) => (prev === 220 ? 320 : 220))}
                className="rounded-2xl border border-[var(--dz-border)] dz-mist px-4 py-3 text-sm font-semibold active:scale-[0.99]"
              >
                {qrSize === 220 ? t("billing.couponPage.enlargeQr") : t("billing.couponPage.shrinkQr")}
              </button>
            </div>

            <div className="mt-4 rounded-2xl border border-[var(--dz-border)] bg-[var(--dz-surface-muted)] p-4">
              <div className="text-xs font-semibold text-[var(--dz-text-muted)]">{t("billing.couponPage.code")}</div>
              <div className="mt-1 break-all font-mono text-sm font-bold text-[var(--dz-text-primary)]">
                {code.token}
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => handleCopy(code.token, t("billing.couponPage.codeCopied"))}
                  className="flex-1 rounded-2xl border border-[var(--dz-border)] dz-mist px-4 py-3 text-sm font-semibold active:scale-[0.99]"
                >
                  {t("billing.couponPage.copyCode")}
                </button>
                <button
                  type="button"
                  onClick={() => handleCopy(code.qrValue, t("billing.couponPage.linkCopied"))}
                  className="flex-1 rounded-2xl border border-[var(--dz-border)] dz-mist px-4 py-3 text-sm font-semibold active:scale-[0.99]"
                >
                  {t("billing.couponPage.copyLink")}
                </button>
              </div>
            </div>

            <div className="mt-3 grid gap-2">
              <button
                type="button"
                onClick={() => handleShareWhatsApp(whatsappText)}
                className="w-full rounded-2xl bg-[var(--dz-text-primary)] px-4 py-3.5 text-sm font-bold text-[var(--dz-text-on-brand)] active:scale-[0.99]"
              >
                {t("billing.couponIssue.shareWhatsapp")}
              </button>
            </div>

            {shareMessage ? (
              <div className="mt-3 rounded-2xl border border-[var(--dz-success-border)] bg-[var(--dz-success-bg-soft)] p-4 text-sm font-semibold text-[var(--dz-success)]">
                {shareMessage}
              </div>
            ) : null}
          </>
        ) : (
          <div className="rounded-2xl border border-[var(--dz-border)] bg-[var(--dz-surface-muted)] p-4 text-sm font-semibold text-[var(--dz-text-secondary)]">
            {t("billing.couponPage.noCode")}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <main className="min-h-screen bg-[var(--dz-background)] px-4 pb-10 pt-4 text-[var(--dz-text-primary)]">
      <div className="mx-auto w-full max-w-md sm:max-w-2xl lg:max-w-4xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => router.push("/revenue")}
            className="rounded-2xl border border-[var(--dz-border)] dz-mist px-4 py-3 text-sm font-semibold text-[var(--dz-text-secondary)]"
          >
            {t("common.back")}
          </button>

          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${badge.className}`}
          >
            {badge.text}
          </span>
        </div>

        {viewMode === "details" ? renderDetailsView() : renderCodeView()}
      </div>
    </main>
  );
}

