"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadFacebookSdk } from "./facebook-sdk";
import { getEmbeddedSignupConfig } from "./embedded-signup-config";

/**
 * Embedded Signup orchestration (Ticket 3 — CAPTURE ONLY).
 *
 * Lifecycle:
 *   idle → launching → (success | cancelled | error)
 *
 * On success it captures `code` + identifiers IN MEMORY only. Nothing is sent
 * to our backend, persisted, logged, or written to URL/localStorage/
 * sessionStorage. The `code` value is never passed to console.* anywhere.
 *
 * The `code` arrives via the FB.login callback; the `waba_id` /
 * `phone_number_id` / `business_id` arrive via the `WA_EMBEDDED_SIGNUP`
 * window message event. The two are correlated here.
 */
export type EmbeddedSignupPhase =
  | "idle"
  | "launching"
  | "success"
  | "cancelled"
  | "error";

export type EmbeddedSignupResult = {
  /** Sensitive — held in memory only, never logged or persisted. */
  code: string;
  phoneNumberId?: string;
  wabaId?: string;
  businessId?: string;
};

type CapturedIds = {
  phoneNumberId?: string;
  wabaId?: string;
  businessId?: string;
};

function isFacebookOrigin(origin: string): boolean {
  return (
    typeof origin === "string" &&
    (origin === "https://www.facebook.com" ||
      origin === "https://web.facebook.com" ||
      origin.endsWith(".facebook.com"))
  );
}

export function useEmbeddedSignup() {
  const [phase, setPhase] = useState<EmbeddedSignupPhase>("idle");
  const [result, setResult] = useState<EmbeddedSignupResult | null>(null);

  const idsRef = useRef<CapturedIds>({});
  const listenerRef = useRef<((event: MessageEvent) => void) | null>(null);

  const removeListener = useCallback(() => {
    if (listenerRef.current) {
      window.removeEventListener("message", listenerRef.current);
      listenerRef.current = null;
    }
  }, []);

  // Cleanup any dangling listener on unmount.
  useEffect(() => removeListener, [removeListener]);

  const launch = useCallback(async () => {
    const config = getEmbeddedSignupConfig();
    if (!config) {
      setPhase("error");
      return;
    }

    setResult(null);
    idsRef.current = {};
    setPhase("launching");

    // Listener for the WA_EMBEDDED_SIGNUP message event (carries the ids).
    const onMessage = (event: MessageEvent) => {
      if (!isFacebookOrigin(event.origin)) return;

      let payload: unknown;
      try {
        payload =
          typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (
        !payload ||
        typeof payload !== "object" ||
        (payload as { type?: unknown }).type !== "WA_EMBEDDED_SIGNUP"
      ) {
        return;
      }

      const data =
        (payload as { data?: Record<string, unknown> }).data ?? {};
      if (data.phone_number_id) {
        idsRef.current.phoneNumberId = String(data.phone_number_id);
      }
      if (data.waba_id) {
        idsRef.current.wabaId = String(data.waba_id);
      }
      if (data.business_id) {
        idsRef.current.businessId = String(data.business_id);
      }

      const evt = (payload as { event?: unknown }).event;
      if (evt === "CANCEL") {
        setPhase((prev) => (prev === "success" ? prev : "cancelled"));
        removeListener();
      } else if (evt === "ERROR") {
        setPhase((prev) => (prev === "success" ? prev : "error"));
        removeListener();
      }
    };

    listenerRef.current = onMessage;
    window.addEventListener("message", onMessage);

    let FB;
    try {
      FB = await loadFacebookSdk(config);
    } catch {
      setPhase("error");
      removeListener();
      return;
    }

    try {
      FB.login(
        (response) => {
          const code = response?.authResponse?.code;
          if (code) {
            setResult({ code, ...idsRef.current });
            setPhase("success");
          } else {
            // Popup closed / cancelled without returning a code.
            setPhase((prev) => (prev === "success" ? prev : "cancelled"));
          }
          removeListener();
        },
        {
          config_id: config.configId,
          response_type: "code",
          override_default_response_type: true,
          // Coexistence path — onboard an existing WhatsApp Business App number.
          // Confirm param names against current Meta docs during live testing.
          extras: {
            setup: {},
            featureType: "whatsapp_business_app_onboarding",
            sessionInfoVersion: "3",
          },
        }
      );
    } catch {
      setPhase("error");
      removeListener();
    }
  }, [removeListener]);

  const reset = useCallback(() => {
    idsRef.current = {};
    setResult(null);
    setPhase("idle");
    removeListener();
  }, [removeListener]);

  return { phase, result, launch, reset };
}
