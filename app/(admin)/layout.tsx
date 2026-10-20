import { Nav } from "./_components/nav";

// No <Suspense> around {children} here: on a client navigation this layout is shared and a boundary in it never
// shows. Each page brings its own boundary through the loading.tsx beside it (see _components/page-loading.tsx).
export default function AdminLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <Nav />
      <main className="min-w-0 lg:pl-56">
        <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-10 lg:py-8">{children}</div>
      </main>
    </>
  );
}
