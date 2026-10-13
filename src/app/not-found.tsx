import Link from "next/link";
import { getTranslations } from "next-intl/server";

export default async function NotFound() {
  const t = await getTranslations("NotFound");

  return (
    <main className="paper-grain flex min-h-dvh flex-col items-center justify-center px-4 py-10 text-center">
      <div className="w-full max-w-sm">
        <p className="font-display text-2xl font-bold tracking-tight text-ink">
          HOME<span className="text-stamp">SHARE</span>
        </p>
        <h1 className="mt-8 font-display text-lg font-bold uppercase tracking-wide text-ink">
          {t("title")}
        </h1>
        <p className="mt-2 text-sm text-ink-soft">{t("description")}</p>
        <Link
          href="/expenses"
          className="mt-8 inline-flex min-h-11 items-center justify-center rounded-md border border-ink bg-ink px-4 py-2.5 font-display text-[0.8rem] font-bold uppercase tracking-wider text-paper transition-all hover:bg-stamp-text hover:border-stamp-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-paper md:min-h-0"
        >
          {t("back")}
        </Link>
      </div>
    </main>
  );
}
