export interface GlobalErrorMessages {
  title: string;
  description: string;
  reload: string;
}

// The crash screen is the last resort: it must always have text, even if the locale chunk never loads.
// Inlined (not imported from en.json, which would bundle every English message into this chunk);
// global-error-copy.test.ts pins it to `en.json`'s `GlobalError`.
export const FALLBACK_COPY: GlobalErrorMessages = {
  title: "Something went wrong",
  description: "An unexpected error stopped this page. Reloading usually fixes it.",
  reload: "Reload page",
};

/** The localized strings once loaded; the bundled English ones before that, or for any missing key. */
export function globalErrorCopy(loaded?: Partial<GlobalErrorMessages> | null): GlobalErrorMessages {
  return {
    title: loaded?.title || FALLBACK_COPY.title,
    description: loaded?.description || FALLBACK_COPY.description,
    reload: loaded?.reload || FALLBACK_COPY.reload,
  };
}
