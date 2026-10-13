"use client";

import { useTranslations } from "next-intl";

/** /settings: below md the layout shows only the category list; from md this fills the right column. */
export default function SettingsIndexPage() {
  const t = useTranslations("Settings");
  return <p className="text-pretty text-sm text-faint">{t("chooseCategory")}</p>;
}
