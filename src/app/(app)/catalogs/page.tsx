"use client";

import { useTranslations } from "next-intl";
import { TagManager } from "@/components/app/TagManager";
import { EXPENSE_CATEGORIES } from "@/lib/categories";
import { DEFAULT_PLATFORMS } from "@/lib/platforms";
import { DEFAULT_PAYMENT_METHODS } from "@/lib/payment-methods";
import { LIMITS } from "@/lib/constants";

export default function CatalogsPage() {
  const t = useTranslations("Catalogs");
  const tExp = useTranslations("Expenses");

  return (
    <div className="flex flex-col gap-5">
      {/* h1 (was a SectionTitle/h2) so every page has the same title tag + hierarchy (U7/BL-33). */}
      <h1 className="font-display text-2xl font-bold tracking-tight text-ink">{t("title")}</h1>
      <p className="-mt-3 text-sm text-faint">{t("subtitle")}</p>

      <TagManager
        label={t("sectionCategories")}
        kind={t("kindCategory")}
        apiBase="/api/categories"
        responseKey="categories"
        defaultKeys={EXPENSE_CATEGORIES}
        defaultLabel={(k) => tExp(`category.${k}`)}
        nameMax={LIMITS.CATEGORY_NAME}
      />
      <TagManager
        label={t("sectionPlatforms")}
        kind={t("kindPlatform")}
        apiBase="/api/platforms"
        responseKey="platforms"
        defaultKeys={DEFAULT_PLATFORMS}
        defaultLabel={(k) => tExp(`platform.${k}`)}
        nameMax={LIMITS.PLATFORM_NAME}
      />
      <TagManager
        label={t("sectionPayments")}
        kind={t("kindPayment")}
        apiBase="/api/payment-methods"
        responseKey="paymentMethods"
        defaultKeys={DEFAULT_PAYMENT_METHODS}
        defaultLabel={(k) => tExp(`payment.${k}`)}
        nameMax={LIMITS.PAYMENT_NAME}
      />
    </div>
  );
}
