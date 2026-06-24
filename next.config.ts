import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  turbopack: {},
  // The floating dev badge overlaps the fixed bottom nav / modal footer in dev; it never ships
  // to production. Hide it so dev matches prod.
  devIndicators: false,
};

export default withNextIntl(nextConfig);
