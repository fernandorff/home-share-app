import type { Metadata, Viewport } from "next";
import { Space_Mono, JetBrains_Mono, Nunito, Fredoka } from "next/font/google";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import { THEME_COOKIE, DEFAULT_THEME, isTheme } from "@/lib/theme";
import "./globals.css";

// preload: false on all 5 files (BL-32/P7) — only one theme's fonts are ever actually used
// (--font-mono/--font-display point at default's or bolitas's pair depending on data-theme), so
// eagerly preloading all 5 wastes ~190KB on every load; the browser now only fetches the 2-3
// files the active theme's CSS actually resolves to.
const spaceMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-space-mono",
  display: "swap",
  preload: false,
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
  preload: false,
});

// Fonts for the "bolitas" theme (cozy cottage-ledger). Always loaded; the
// active theme decides which family the --font-mono/--font-display tokens point to.
const nunito = Nunito({
  subsets: ["latin"],
  variable: "--font-nunito",
  display: "swap",
  preload: false,
});

const fredoka = Fredoka({
  subsets: ["latin"],
  variable: "--font-fredoka",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: "Home Share",
  description: "Shared household expenses, split right.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#16140f",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  const themeCookie = (await cookies()).get(THEME_COOKIE)?.value;
  const theme = isTheme(themeCookie) ? themeCookie : DEFAULT_THEME;
  return (
    <html
      lang={locale}
      data-theme={theme}
      className={`${spaceMono.variable} ${jetbrainsMono.variable} ${nunito.variable} ${fredoka.variable}`}
    >
      <body className="antialiased">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
