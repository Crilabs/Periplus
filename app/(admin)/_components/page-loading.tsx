/**
 * Fallback of every admin page while it waits for the request (session check, then its data).
 *
 * Every admin page starts with `requireAdmin()`, which reads the session cookie at request time, so nothing of the
 * page can be prerendered. With Cache Components that read needs a `<Suspense>` boundary *below* the layout a
 * navigation shares, or the navigation blocks (Next's "blocking-prerender-dynamic"). The admin layout's own
 * boundary only covers a page load: on a client navigation it sits above the re-rendered part. Hence one
 * `loading.tsx` next to every `page.tsx`, each re-exporting this component: it wraps exactly that page,
 * remounts on every navigation into it (other id, other query) and shows this static placeholder at once.
 */
export default function PageLoading() {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 py-10 text-sm text-muted">
      <span aria-hidden className="size-2 animate-pulse rounded-full bg-current" />
      Lädt …
    </div>
  );
}
