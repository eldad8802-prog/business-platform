"use client";

/**
 * /setup/activity — the two activity screens right after signup (phase 2, owner-approved design): the category,
 * then the activity packs. Reached from /setup only while `activity_packs` is ON for the business and the owner has
 * not chosen yet; both screens are skippable and lead back to /setup, then the ordinary Home. Signup itself and its
 * legal identity step are untouched.
 */

import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";

import { ActivityPicker } from "@/components/activity-packs/activity-picker";
import { useHideShellChrome } from "@/components/navigation/shell-chrome-visibility";
import { markActivitySkipped } from "@/lib/activity-packs/activity-skip";
import { getClientAuthToken, redirectToLogin } from "@/lib/client-session";

export default function SetupActivityPage() {
  useHideShellChrome(true);
  const router = useRouter();

  useEffect(() => {
    if (!getClientAuthToken()) redirectToLogin();
  }, []);

  const back = useCallback(() => router.replace("/setup"), [router]);
  const skip = useCallback(() => {
    markActivitySkipped();
    router.replace("/setup");
  }, [router]);

  return (
    <main style={{ minHeight: "100vh", background: "#F6F3EC" }}>
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "28px 20px 32px" }}>
        <ActivityPicker mode="setup" onDone={back} onSkip={skip} />
      </div>
    </main>
  );
}
