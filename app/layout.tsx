import type { Metadata, Viewport } from "next";
import { Heebo } from "next/font/google";
import "./globals.css";

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
      className={`${heebo.variable} h-full antialiased`}
    >
      <body className="min-h-screen w-full overflow-x-hidden flex flex-col">
        {children}
      </body>
    </html>
  );
}