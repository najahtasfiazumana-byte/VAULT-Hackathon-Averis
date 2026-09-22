import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SDOC Verifier - shipping document checks",
  description: "From email inbox to discrepancy report: Gemini-powered SI vs draft BL verification with human review.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
