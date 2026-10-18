import { Suspense } from "react";
import { Nav } from "./_components/nav";

export default function AdminLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <Nav />
      <div className="flex-1 p-6">
        <Suspense>{children}</Suspense>
      </div>
    </>
  );
}
