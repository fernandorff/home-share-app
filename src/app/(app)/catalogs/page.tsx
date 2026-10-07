"use client";

import { useTranslations } from "next-intl";
import { TagManager } from "@/components/app/TagManager";
import { PageHeader } from "@/components/ui/PageHeader";
import { EXPENSE_CATEGORIES } from "@/lib/categories";
import { DEFAULT_PLATFORMS } from "@/lib/platforms";
import { DEFAULT_PAYMENT_METHODS } from "@/lib/payment-methods";
import { LIMITS } from "@/lib/constants";

export default function CatalogsPage() {
  const t = useTranslations("Catalogs");
  const tExp = useTranslations("Expenses");

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

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
