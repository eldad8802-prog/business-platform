/**
 * "Who am I acting as?" for the legal identity screens. Pure: no DB, no network, no DOM.
 *
 * The client keeps ONE session token per browser origin (localStorage "token"), shared by every ordinary tab. Signing
 * in to another account in a second tab silently re-points the first tab at that account. On the correction screens
 * that is dangerous: a request would be filed for the other account's business (the server is right to take the
 * tenant from the session; the person just could not see which session it was). So these screens show the account and
 * business they act for, and stop acting once the token changed under them.
 */

export type SignedInIdentity = { userId: number; email: string; businessId: number; businessName: string | null };

/** The /api/auth/me body → the identity, or null when it is not a well-formed signed-in answer. */
export function parseMe(body: unknown): SignedInIdentity | null {
  if (!body || typeof body !== "object") return null;
  const u = (body as { user?: unknown }).user;
  if (!u || typeof u !== "object") return null;
  const { id, email, businessId, businessName } = u as Record<string, unknown>;
  if (!Number.isInteger(id) || !Number.isInteger(businessId) || typeof email !== "string" || email === "") return null;
  return {
    userId: id as number,
    email,
    businessId: businessId as number,
    businessName: typeof businessName === "string" && businessName.trim() !== "" ? businessName.trim() : null,
  };
}

/** One Hebrew line: the account, then the business. The account's own data, shown only to that account. */
export function signedInLine(me: SignedInIdentity): string {
  const biz = me.businessName ? `${me.businessName} (עסק #${me.businessId})` : `עסק #${me.businessId}`;
  return `מחובר/ת כ־${me.email} · ${biz}`;
}

/**
 * Whether the tab must stop acting: the token it loaded with is no longer the browser's token (another tab signed in,
 * signed out or switched account). A refresh-rotated token for the SAME account is also a change here — the screen
 * simply re-reads who it is; erring towards a re-check is the safe side.
 */
export function sessionSwitched(tokenAtLoad: string | null, tokenNow: string | null): boolean {
  return (tokenAtLoad ?? "") !== (tokenNow ?? "");
}

/** Whether a re-read identity is a different account or business from the one the screen loaded with. */
export function identityChanged(atLoad: SignedInIdentity | null, now: SignedInIdentity | null): boolean {
  if (!atLoad || !now) return atLoad !== now;
  return atLoad.userId !== now.userId || atLoad.businessId !== now.businessId;
}
