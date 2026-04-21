export type IssueFlowState = "idle" | "creating" | "ready" | "error";

export type IssueOffer = {
  id: number;
  title: string;
  description: string | null;
  status?: string | null;
};

export type IssuedCoupon = {
  id: number;
  offerId: number;
  issuingBusinessId: number;
  token: string;
  qrValue: string;
  issuedAt: string;
  expiresAt: string | null;
  status: string;
  redeemedAt: string | null;
};

export type CreateCouponResponse = {
  coupon: IssuedCoupon;
};