"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

function RevenueHeader({ onBack }: { onBack: () => void }) {
  return (
    <header className="mb-5 rounded-3xl bg-white px-4 py-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={onBack}
          className="flex h-11 min-w-[44px] items-center justify-center rounded-2xl border border-gray-200 px-3 text-sm font-medium text-gray-700"
          aria-label="חזרה"
        >
          →
        </button>

        <div className="flex-1 text-center">
          <p className="text-base font-bold text-gray-900">Revenue Activation</p>
          <p className="mt-1 text-xs text-gray-500">מבצעים וקופונים</p>
        </div>

        <div className="h-11 min-w-[44px]" />
      </div>
    </header>
  );
}

type ActiveCouponCard = {
  publicId: string;
  issuedAt: string;
  expiresAt: string;
  business: {
    id: number;
    name: string;
  };
  offer: {
    id: number;
    title: string;
    customerBenefitText: string;
    description: string | null;
    imageUrl?: string | null;
  };
};

function formatExpiry(expiresAt: string) {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("he-IL");
}

function buildSearchText(coupon: ActiveCouponCard) {
  return [
    coupon.offer.title,
    coupon.offer.customerBenefitText,
    coupon.offer.description ?? "",
    coupon.business.name,
  ]
    .join(" ")
    .toLowerCase();
}

export default function RevenuePage() {
  const router = useRouter();

  const [searchInput, setSearchInput] = useState("");
  const [coupons, setCoupons] = useState<ActiveCouponCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const handleBack = () => {
    router.push("/");
  };

  const handleCreateCoupon = () => {
    router.push("/offers/create");
  };

  const handleOpenCouponDetails = (publicId: string) => {
    router.push(`/revenue/coupons/${publicId}`);
  };

  const loadCoupons = async () => {
    try {
      setLoading(true);
      setError("");

      const res = await fetch("/api/revenue/coupons/active", {
        cache: "no-store",
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || "שגיאה בטעינת קופונים");
      }

      setCoupons(Array.isArray(data?.coupons) ? data.coupons : []);
    } catch (err) {
      console.error("Failed to load active coupons:", err);
      setCoupons([]);
      setError(err instanceof Error ? err.message : "שגיאה בטעינת קופונים");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCoupons();
  }, []);

  const filteredCoupons = useMemo(() => {
    const q = searchInput.trim().toLowerCase();
    const list = q
      ? coupons.filter((coupon) => buildSearchText(coupon).includes(q))
      : coupons;
    return list.slice(0, 6);
  }, [coupons, searchInput]);

  return (
    <main className="min-h-screen bg-[#f8f6f1] text-[#1f2937]">
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col px-4 pb-8 pt-4 sm:max-w-2xl sm:px-6 lg:max-w-4xl">
        <RevenueHeader onBack={handleBack} />

        <section className="mb-4 rounded-[28px] bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold leading-tight text-gray-900">
                קופונים פעילים
              </h1>
              <p className="mt-2 text-sm leading-6 text-gray-600">
                חפש לפי שם קופון, ההטבה, או שם העסק.
              </p>
            </div>

            <div className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#eef7f2] text-2xl">
              🎟️
            </div>
          </div>

          <div className="mt-5">
            <label className="mb-2 block text-xs font-semibold text-gray-600">
              חיפוש
            </label>

            <div className="relative">
              <input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="חפש קופון פעיל…"
                className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3.5 text-base outline-none focus:border-gray-300"
              />

              {searchInput.trim() ? (
                <button
                  type="button"
                  onClick={() => setSearchInput("")}
                  className="absolute left-2 top-1/2 -translate-y-1/2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 active:scale-[0.99]"
                >
                  נקה
                </button>
              ) : null}
            </div>
          </div>
        </section>

        <div className="mb-5 flex justify-center">
          <button
            onClick={handleCreateCoupon}
            className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[#1f7a5a] px-5 py-3 text-sm font-bold text-white shadow-sm transition active:scale-[0.99]"
          >
            <span aria-hidden>＋</span>
            צור קופון
          </button>
        </div>

        <section className="mt-1">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-gray-900">קופונים מובילים</h2>
              <div className="mt-1 text-xs font-semibold text-gray-500">
                {loading ? "טוען…" : `תוצאות: ${filteredCoupons.length}`}
              </div>
            </div>
          </div>

          {loading ? (
            <div className="rounded-[24px] bg-white p-5 text-sm text-gray-600 shadow-sm">
              טוען קופונים פעילים…
            </div>
          ) : error ? (
            <div className="rounded-[24px] bg-white p-5 shadow-sm">
              <div className="text-sm font-semibold text-red-700">{error}</div>
              <button
                type="button"
                onClick={loadCoupons}
                className="mt-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-gray-800"
              >
                נסה שוב
              </button>
            </div>
          ) : filteredCoupons.length === 0 ? (
            <div className="rounded-[24px] bg-white p-5 text-sm text-gray-600 shadow-sm">
              אין כרגע קופונים פעילים להצגה.
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredCoupons.map((coupon) => (
                <button
                  type="button"
                  key={coupon.publicId}
                  onClick={() => handleOpenCouponDetails(coupon.publicId)}
                  aria-label={`קופון פעיל: ${coupon.offer.title} (${coupon.business.name}). תוקף עד ${formatExpiry(
                    coupon.expiresAt
                  )}`}
                  className="rounded-[24px] bg-white p-5 text-right shadow-sm transition active:scale-[0.99] focus:outline-none focus:ring-2 focus:ring-[#1f7a5a]/30"
                >
                  <div className="mb-4 overflow-hidden rounded-[20px] border border-gray-100 bg-[#f8f6f1]">
                    <div className="relative h-[132px] w-full">
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="text-center">
                          <div className="text-2xl">🛍️</div>
                          <div className="mt-1 text-[11px] font-semibold text-gray-500">
                            ללא תמונה
                          </div>
                        </div>
                      </div>

                      {coupon.offer.imageUrl ? (
                        <img
                          src={coupon.offer.imageUrl}
                          alt={coupon.offer.title}
                          className="absolute inset-0 h-full w-full object-cover"
                          loading="lazy"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                      ) : null}
                    </div>
                  </div>

                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-lg font-extrabold leading-6 text-gray-900">
                        {coupon.offer.title}
                      </div>
                      <div className="mt-2 line-clamp-2 text-sm font-semibold leading-6 text-gray-700">
                        {coupon.offer.customerBenefitText ||
                          coupon.offer.description ||
                          "ללא תיאור"}
                      </div>
                    </div>

                    <span className="shrink-0 rounded-full bg-[#e8f6ee] px-2.5 py-1 text-[10px] font-semibold text-[#1f7a5a]">
                      פעיל
                    </span>
                  </div>

                  <div className="mt-4 flex items-end justify-between gap-3">
                    <div className="text-xs font-semibold text-gray-500">
                      {coupon.business.name}
                    </div>

                    <div className="flex flex-col items-end gap-2 text-xs font-semibold text-gray-500">
                      <span>תוקף עד: {formatExpiry(coupon.expiresAt) || "—"}</span>
                      <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[10px] font-semibold text-gray-600">
                        לפרטים
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}