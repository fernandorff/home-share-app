import en from "@/messages/en.json";
import pt from "@/messages/pt.json";
import es from "@/messages/es.json";
import fr from "@/messages/fr.json";
import { EXPENSE_CATEGORIES } from "@/lib/categories";
import { DEFAULT_PLATFORMS } from "@/lib/platforms";
import { DEFAULT_PAYMENT_METHODS } from "@/lib/payment-methods";

export type TagKind = "category" | "platform" | "payment";

const LOCALES = [en, pt, es, fr] as const;
const KEYS_BY_KIND: Record<TagKind, readonly string[]> = {
  category: EXPENSE_CATEGORIES,
  platform: DEFAULT_PLATFORMS,
  payment: DEFAULT_PAYMENT_METHODS,
};

/**
 * Every system-default label for `kind`, translated across all 4 supported locales, lowercased.
 * A house's custom name is stored language-independently (a house can have members on different
 * UI languages), so a collision check against only the caller's current locale would miss e.g. a
 * pt-BR member typing "Groceries" (the English label) while the house also has English-viewing
 * members — checking every locale's translation is the only way to catch all real collisions.
 */
function systemLabels(kind: TagKind): Set<string> {
  const keys = KEYS_BY_KIND[kind];
  const out = new Set<string>();
  for (const locale of LOCALES) {
    const group = (locale as unknown as { Expenses?: Record<string, Record<string, string>> }).Expenses?.[kind];
    if (!group) continue;
    for (const k of keys) {
      const label = group[k];
      if (label) out.add(label.trim().toLowerCase());
    }
  }
  return out;
}

/** True if `name` (a house-custom tag being created) collides with a system default's label
 *  in any supported locale — case-insensitive, since "groceries" and "Groceries" read as the
 *  same category to a user despite differing only in case. */
export function isSystemDefaultName(kind: TagKind, name: string): boolean {
  return systemLabels(kind).has(name.trim().toLowerCase());
}
