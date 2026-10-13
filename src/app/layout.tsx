import type { Metadata, Viewport } from "next";
import { Space_Mono, JetBrains_Mono, Nunito, Fredoka } from "next/font/google";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import { THEME_COOKIE, DEFAULT_THEME, isTheme } from "@/lib/theme";
import { InstallPromptCapture } from "@/components/app/InstallPromptCapture";
import { EARLY_INSTALL_CAPTURE_SCRIPT } from "@/lib/install-prompt";
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
  // Installable app (spec 009): static public/manifest.json and /icons/*, which the middleware matcher
  // skips — manifest and icon fetches carry no session cookie.
  manifest: "/manifest.json",
  appleWebApp: { capable: true, title: "Home Share", statusBarStyle: "default" },
  // Next 16 writes only `mobile-web-app-capable` for appleWebApp.capable; iOS before 16.4 reads the apple one.
  other: { "apple-mobile-web-app-capable": "yes" },
  // Config icons replace the file-based app/icon.svg link entirely (Next resolve-metadata), so the
  // favicon is declared here again next to the apple-touch-icon.
  icons: {
    icon: { url: "/icon.svg", type: "image/svg+xml", sizes: "any" },
    apple: { url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#16140f",
};

// Measures the html scrollbar gutter (U14) as --scrollbar-gutter-w for globals.css, which hands
// it to <body> while a dialog or menu locks scrolling (R2-05). Skipped while locked: the gutter
// is dropped then. Written to a <style> in <head> rather than an <html> attribute, which React
// would report as a hydration mismatch.
const SCROLLBAR_GUTTER_SCRIPT = `(function(){var d=document.documentElement,s=document.createElement("style");document.head.appendChild(s);function m(){if(document.body.hasAttribute("data-scroll-locked"))return;s.textContent=":root{--scrollbar-gutter-w:"+(innerWidth-d.getBoundingClientRect().width)+"px}"}m();addEventListener("resize",m)})()`;

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
        {/* Spec 009: first in <body>, so a beforeinstallprompt fired before hydration is kept for InstallPromptCapture. */}
        <script dangerouslySetInnerHTML={{ __html: EARLY_INSTALL_CAPTURE_SCRIPT }} />
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
        {/* Spec 009: keeps the one-time beforeinstallprompt event from any page, /auth/* included. */}
        <InstallPromptCapture />
        <script dangerouslySetInnerHTML={{ __html: SCROLLBAR_GUTTER_SCRIPT }} />
      </body>
    </html>
  );
}
