import type { Metadata, Viewport } from "next";
import { Heebo, Rubik } from "next/font/google";
import "./globals.css";
import { AccessibilityFab } from "@/components/ui/accessibility/accessibility-fab";

// Heebo is the official Dubiz typeface (Design System v1). It is Hebrew-first
// (full Hebrew + Latin coverage by Oded Ezer), unlike Geist which has no Hebrew
// and left all Hebrew UI text falling back to a system font. Loaded once here
// as --font-heebo and inherited app-wide; weights 300-600 per the DS.
const heebo = Heebo({
  subsets: ["hebrew", "latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-heebo",
  display: "swap",
});

// Rubik is the display companion for numerals and large headings on the home
// screen (per the approved home mockup): it renders figures and the greeting /
// day-state lines. Body copy stays Heebo — Rubik is exposed as --font-rubik and
// opted into only where the design calls for it. Hebrew + Latin so numbers and
// Hebrew headings share one voice.
const rubik = Rubik({
  subsets: ["hebrew", "latin"],
  weight: ["500", "600", "700"],
  variable: "--font-rubik",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Business Platform",
  description: "Business platform app",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="he"
      dir="rtl"
      className={`${heebo.variable} ${rubik.variable} h-full antialiased`}
    >
      <body className="min-h-screen w-full overflow-x-hidden flex flex-col">
        {children}
        <AccessibilityFab />
      </body>
    </html>
  );
}