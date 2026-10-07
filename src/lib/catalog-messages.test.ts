import { describe, it, expect } from "vitest";
import { createTranslator } from "next-intl";
import en from "@/messages/en.json";
import pt from "@/messages/pt.json";
import es from "@/messages/es.json";
import fr from "@/messages/fr.json";

const LOCALES = { en, pt, es, fr } as const;
const KINDS = ["categories", "platforms", "paymentMethods"] as const;

function catalogs(locale: keyof typeof LOCALES) {
  return createTranslator({ locale, messages: LOCALES[locale], namespace: "Catalogs" });
}
function apiErrors(locale: keyof typeof LOCALES) {
  return createTranslator({ locale, messages: LOCALES[locale], namespace: "ApiErrors" });
}

// R3-17: both collision messages open with the same words, and the delete body has a subject.
describe("Catalogs collision messages (R3-17)", () => {
  const OPENING = {
    en: "This name already exists",
    pt: "Esse nome já existe",
    es: "Este nombre ya existe",
    fr: "Ce nom existe déjà",
  } as const;

  it.each(Object.keys(LOCALES) as (keyof typeof LOCALES)[])(
    "%s: DUPLICATE_NAME and SYSTEM_DEFAULT_COLLISION start with the same words",
    (locale) => {
      const t = apiErrors(locale);
      expect(t("DUPLICATE_NAME").startsWith(OPENING[locale])).toBe(true);
      expect(t("SYSTEM_DEFAULT_COLLISION").startsWith(OPENING[locale])).toBe(true);
    }
  );

  it("en: the exact texts", () => {
    const t = apiErrors("en");
    expect(t("DUPLICATE_NAME")).toBe("This name already exists in this house");
    expect(t("SYSTEM_DEFAULT_COLLISION")).toBe("This name already exists as a system default");
  });

  it("pt/es/fr: the exact texts", () => {
    expect(apiErrors("pt")("DUPLICATE_NAME")).toBe("Esse nome já existe nesta casa");
    expect(apiErrors("pt")("SYSTEM_DEFAULT_COLLISION")).toBe("Esse nome já existe como padrão do sistema");
    expect(apiErrors("es")("DUPLICATE_NAME")).toBe("Este nombre ya existe en esta casa");
    expect(apiErrors("es")("SYSTEM_DEFAULT_COLLISION")).toBe("Este nombre ya existe como predeterminado del sistema");
    expect(apiErrors("fr")("DUPLICATE_NAME")).toBe("Ce nom existe déjà dans cette maison");
    expect(apiErrors("fr")("SYSTEM_DEFAULT_COLLISION")).toBe("Ce nom existe déjà comme valeur par défaut du système");
  });
});

describe("Catalogs.deleteExplanation (R3-17)", () => {
  it("en: opens with a subject, uses typographic quotes, closes with the irreversible warning", () => {
    expect(catalogs("en")("deleteExplanation", { name: "Farmácia", count: 7 })).toBe(
      "This will remove “Farmácia” from 7 expenses. This action cannot be undone."
    );
    expect(catalogs("en")("deleteExplanation", { name: "Farmácia", count: 1 })).toBe(
      "This will remove “Farmácia” from 1 expense. This action cannot be undone."
    );
    // Nothing is linked: drop the "from N expenses" clause instead of "from 0 expenses".
    expect(catalogs("en")("deleteExplanation", { name: "Farmácia", count: 0 })).toBe(
      "This will remove “Farmácia”. This action cannot be undone."
    );
  });

  it("pt: =0 / one / other plural forms", () => {
    expect(catalogs("pt")("deleteExplanation", { name: "Farmácia", count: 7 })).toBe(
      "Isso vai remover “Farmácia” de 7 despesas. Esta ação não pode ser desfeita."
    );
    expect(catalogs("pt")("deleteExplanation", { name: "Farmácia", count: 1 })).toBe(
      "Isso vai remover “Farmácia” de 1 despesa. Esta ação não pode ser desfeita."
    );
    expect(catalogs("pt")("deleteExplanation", { name: "Farmácia", count: 0 })).toBe(
      "Isso vai remover “Farmácia”. Esta ação não pode ser desfeita."
    );
  });

  it("es: typographic quotes + plural", () => {
    expect(catalogs("es")("deleteExplanation", { name: "Farmácia", count: 7 })).toBe(
      "Esto quitará “Farmácia” de 7 gastos. Esta acción no se puede deshacer."
    );
    expect(catalogs("es")("deleteExplanation", { name: "Farmácia", count: 1 })).toBe(
      "Esto quitará “Farmácia” de 1 gasto. Esta acción no se puede deshacer."
    );
    expect(catalogs("es")("deleteExplanation", { name: "Farmácia", count: 0 })).toBe(
      "Esto quitará “Farmácia”. Esta acción no se puede deshacer."
    );
  });

  it("fr: « {name} » guillemets + plural", () => {
    expect(catalogs("fr")("deleteExplanation", { name: "Pharmacie", count: 7 })).toBe(
      "Cela retirera « Pharmacie » de 7 dépenses. Cette action est irréversible."
    );
    expect(catalogs("fr")("deleteExplanation", { name: "Pharmacie", count: 1 })).toBe(
      "Cela retirera « Pharmacie » de 1 dépense. Cette action est irréversible."
    );
    expect(catalogs("fr")("deleteExplanation", { name: "Pharmacie", count: 0 })).toBe(
      "Cela retirera « Pharmacie ». Cette action est irréversible."
    );
  });

  it("no locale keeps straight double quotes around the name", () => {
    for (const locale of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
      // Parsed JSON value (a raw `\"` would show up here as `"`) and every plural branch.
      expect(LOCALES[locale].Catalogs.deleteExplanation).not.toContain('"');
      for (const count of [0, 1, 2]) {
        expect(catalogs(locale)("deleteExplanation", { name: "X", count })).not.toContain('"');
      }
    }
  });
});

// R3-18: the toast names the object, so three sections' toasts never read the same.
describe("Catalogs createdToast / deletedToast (R3-18)", () => {
  const EXPECTED = {
    en: {
      created: ["Category added", "Platform added", "Payment method added"],
      deleted: ["Category deleted", "Platform deleted", "Payment method deleted"],
    },
    pt: {
      created: ["Categoria adicionada", "Plataforma adicionada", "Forma de pagamento adicionada"],
      deleted: ["Categoria excluída", "Plataforma excluída", "Forma de pagamento excluída"],
    },
    es: {
      created: ["Categoría añadida", "Plataforma añadida", "Forma de pago añadida"],
      deleted: ["Categoría eliminada", "Plataforma eliminada", "Forma de pago eliminada"],
    },
    fr: {
      created: ["Catégorie ajoutée", "Plateforme ajoutée", "Moyen de paiement ajouté"],
      deleted: ["Catégorie supprimée", "Plateforme supprimée", "Moyen de paiement supprimé"],
    },
  } as const;

  it.each(Object.keys(LOCALES) as (keyof typeof LOCALES)[])("%s: one distinct toast per section", (locale) => {
    const t = catalogs(locale);
    const created = KINDS.map((kind) => t("createdToast", { kind }));
    const deleted = KINDS.map((kind) => t("deletedToast", { kind }));
    expect(created).toEqual(EXPECTED[locale].created);
    expect(deleted).toEqual(EXPECTED[locale].deleted);
    expect(new Set(created).size).toBe(3);
    expect(new Set(deleted).size).toBe(3);
  });
});
