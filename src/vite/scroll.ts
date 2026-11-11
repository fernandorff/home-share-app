// The ScrollToTop effect. A statement body, never `() => window.scrollTo(0, 0)`: newer Chrome returns a Promise
// from scrollTo, React takes any returned value as the effect's cleanup and throws "is not a function" when the
// page unmounts (every in-app navigation broke in production on 11/11/2026).
export function scrollToTop(): void {
  window.scrollTo(0, 0);
}
