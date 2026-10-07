/**
 * File name a `Content-Disposition` header asks for, or `fallback` when it names none.
 * Reads the RFC 5987 `filename*=UTF-8''…` form first, then the plain quoted / unquoted `filename=`.
 * Only the base name is kept (no path), so a header can never point the download elsewhere.
 */
export function fileNameFromContentDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;

  let name: string | undefined;
  const extended = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    try {
      name = decodeURIComponent(extended[1].trim());
    } catch {
      name = undefined; // malformed percent-encoding: try the plain form
    }
  }
  if (!name) {
    const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
    name = (plain?.[1] ?? plain?.[2])?.trim();
  }

  const base = name?.split(/[\\/]/).pop()?.trim();
  return base && base !== "." && base !== ".." ? base : fallback;
}
