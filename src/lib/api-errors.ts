"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { ApiError } from "@/lib/api";

/**
 * Translates an API error: when the backend sent a known `code`, show its
 * localized message; otherwise fall back to the screen's translated message.
 * The raw pt-BR `err.message` is never surfaced to the user.
 */
export function useApiError() {
  const t = useTranslations("ApiErrors");
  return useCallback(
    (err: unknown, fallback: string): string => {
      if (err instanceof ApiError && err.code && t.has(err.code)) {
        return t(err.code);
      }
      return fallback;
    },
    [t]
  );
}
