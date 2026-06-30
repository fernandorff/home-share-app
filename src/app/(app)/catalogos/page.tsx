"use client";

import { useTranslations } from "next-intl";
import { SectionTitle } from "@/components/ui/Card";
import { TagManager } from "@/components/app/TagManager";
import { EXPENSE_CATEGORIES } from "@/lib/categories";
import { DEFAULT_PLATFORMS } from "@/lib/platforms";
import { DEFAULT_PAYMENT_METHODS } from "@/lib/payment-methods";
import { LIMITS } from "@/lib/constants";

export default function CatalogosPage() {
  const t = useTranslations("Catalogs");
  const tExp = useTranslations("Expenses");

  return (
    <div className="flex flex-col gap-5">
      <SectionTitle>{t("title")}</SectionTitle>
      <p className="-mt-3 text-sm text-faint">{t("subtitle")}</p>

      <TagManager
        label={t("sectionCategories")}
        apiBase="/api/categories"
        responseKey="categories"
        defaultKeys={EXPENSE_CATEGORIES}
        defaultLabel={(k) => tExp(`category.${k}`)}
        nameMax={LIMITS.CATEGORY_NAME}
      />
      <TagManager
        label={t("sectionPlatforms")}
        apiBase="/api/platforms"
        responseKey="platforms"
        defaultKeys={DEFAULT_PLATFORMS}
        defaultLabel={(k) => tExp(`platform.${k}`)}
        nameMax={LIMITS.PLATFORM_NAME}
      />
      <TagManager
        label={t("sectionPayments")}
        apiBase="/api/payment-methods"
        responseKey="paymentMethods"
        defaultKeys={DEFAULT_PAYMENT_METHODS}
        defaultLabel={(k) => tExp(`payment.${k}`)}
        nameMax={LIMITS.PAYMENT_NAME}
      />
    </div>
  );
}
