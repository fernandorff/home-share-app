// Vite entry (spec 013, 4.1): what src/app/layout.tsx does on the server, done in the browser. The theme is
// set by the inline script in index.html; the locale's messages load before the first render, so a
// non-English user never sees English first.
import "@/app/globals.css";
import "./fonts.css";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Outlet, RouterProvider, useLocation } from "react-router";
import { IntlProvider } from "use-intl";
import { InstallPromptCapture } from "@/components/app/InstallPromptCapture";
import * as Sentry from "@sentry/react";
import { buildSentryOptions } from "@/lib/observability/options";
import { LOCALES, type Locale } from "@/i18n/locales";
import { routes } from "./routes";
import { scrollToTop } from "./scroll";

// Browser Sentry (spec 007) through the same-origin tunnel Axum proxies to Sentry (/monitoring).
// VITE_SENTRY_DSN / VITE_SENTRY_ENVIRONMENT / VITE_SENTRY_TRACES_SAMPLE_RATE are inlined at build time; CI passes
// them as build args even when unset, so an empty string means "not set" (|| rather than ??).
const sentry = buildSentryOptions({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.MODE,
  tracesSampleRate: import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE,
});
if (sentry) Sentry.init({ ...sentry, tunnel: "/monitoring", integrations: [Sentry.browserTracingIntegration()] });

const cookie = /(?:^|; )locale=([^;]*)/.exec(document.cookie)?.[1];
const locale: Locale = (LOCALES as readonly string[]).includes(cookie ?? "") ? (cookie as Locale) : "en";
const messages = (await import(`../messages/${locale}.json`).catch(() => import("../messages/en.json"))).default;
document.documentElement.lang = locale;

// Next scrolls to the top on push/Link; react-router does not. Path changes only, so the
// `router.replace(...)` query updates (activity, house param) keep their place.
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(scrollToTop, [pathname]);
  return <Outlet />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <IntlProvider locale={locale} messages={messages} timeZone="UTC">
      <RouterProvider router={createBrowserRouter([{ element: <ScrollToTop />, children: routes }])} />
    </IntlProvider>
    <InstallPromptCapture />
  </StrictMode>
);
