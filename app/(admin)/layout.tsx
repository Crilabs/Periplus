import { Suspense } from "react";
import { Nav } from "./_components/nav";

export default function AdminLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <Nav />
      <main className="min-w-0 lg:pl-56">
        <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
          <Suspense>{children}</Suspense>
        </div>
      </main>
    </>
  );
}
