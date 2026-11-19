"use client";

/**
 * A visible "acting as" strip for the legal identity screens (see lib/legal-identity/signed-in-as.ts for why).
 * It reads /api/auth/me with the tab's token and watches the shared token: when another tab signs in, out or switches
 * account, the strip turns into a warning and `onSwitched` lets the screen stop acting until it is reloaded.
 */

import { useEffect, useRef, useState } from "react";

import { getClientAuthToken } from "@/lib/client-session";
import { identityChanged, parseMe, sessionSwitched, signedInLine, type SignedInIdentity } from "@/lib/legal-identity/signed-in-as";

async function readMe(): Promise<SignedInIdentity | null> {
  try {
    const res = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${getClientAuthToken() ?? ""}` }, cache: "no-store" });
    if (!res.ok) return null;
    return parseMe(await res.json());
  } catch {
    return null;
  }
}

export function SignedInAs({ onSwitched }: { onSwitched?: (switched: boolean) => void }) {
  const [me, setMe] = useState<SignedInIdentity | null>(null);
  const [switched, setSwitched] = useState(false);
  const atLoad = useRef<{ token: string | null; me: SignedInIdentity | null } | null>(null);

  useEffect(() => {
    let alive = true;
    const token = getClientAuthToken();
    void readMe().then((m) => {
      if (!alive) return;
      atLoad.current = { token, me: m };
      setMe(m);
    });
    const recheck = () => {
      const base = atLoad.current;
      if (!base || !sessionSwitched(base.token, getClientAuthToken())) return;
      void readMe().then((m) => {
        if (!alive) return;
        // Same account and business behind a rotated token: adopt it quietly. Anything else stops the screen.
        if (!identityChanged(base.me, m)) {
          atLoad.current = { token: getClientAuthToken(), me: m };
          return;
        }
        setMe(m);
        setSwitched(true);
        onSwitched?.(true);
      });
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === "token") recheck();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      alive = false;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [onSwitched]);

  if (switched) {
    return (
      <div role="alert" style={{ background: "var(--dz-danger-soft, #fde8e8)", color: "var(--dz-danger)", border: "1px solid var(--dz-danger)", borderRadius: 12, padding: "10px 12px", fontSize: 14, fontWeight: 600 }}>
        החשבון בדפדפן הוחלף בלשונית אחרת{me ? ` (עכשיו: ${signedInLine(me)})` : ""}. רעננו את הדף ובדקו את שורת החשבון לפני כל פעולה.
      </div>
    );
  }
  if (!me) return null;
  return (
    <div data-testid="signed-in-as" style={{ background: "var(--dz-surface-raised-flat)", border: "1px solid var(--dz-border)", borderRadius: 12, padding: "8px 12px", fontSize: 13, color: "var(--dz-text-secondary)", overflowWrap: "anywhere" }}>
      {signedInLine(me)}
    </div>
  );
}
