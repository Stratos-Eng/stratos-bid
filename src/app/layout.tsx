import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Fraunces } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Stratos - AI-Native Preconstruction Platform",
  description: "Fewer misses. Tighter bids. More wins. AI-powered signage extraction for specialty trade subcontractors.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} font-sans antialiased`}
      >
        <Providers>
          {children}
          {/* Deploy debug marker (safe + tiny). Remove anytime. */}
          <div className="fixed bottom-2 right-2 z-50 text-[10px] text-muted-foreground bg-background/70 backdrop-blur border rounded px-2 py-1">
            ui:b1d393f api: <a className="underline" href="/api/version" target="_blank">/api/version</a>
          </div>
        </Providers>
      </body>
    </html>
  );
}
