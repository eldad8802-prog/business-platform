import { Gveret_Levin } from "next/font/google";

/**
 * The handwriting face of the Secretary's reminder notes (owner-approved mockup, 24.10.2026): note titles and
 * their short lines only. Self-hosted by next/font at build time — no request to an outside service at runtime.
 * Everything else on the screen stays in the Dubiz face.
 */
export const noteHand = Gveret_Levin({ weight: "400", subsets: ["hebrew"], variable: "--font-note-hand", display: "swap" });
