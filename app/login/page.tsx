import Image from "next/image";
import { Suspense } from "react";
import { safeNext } from "@/lib/security/safe-next";
import logo from "@/app/_brand/logo.png";
import { LoginForm } from "./login-form";

async function Form({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return <LoginForm next={safeNext(Array.isArray(next) ? next[0] : next)} />;
}

export default function Page(props: PageProps<"/login">) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-10 text-ink">
      <div className="w-full max-w-sm overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
        {/* The logo is white on transparent; the rail navy sets it apart from the card. */}
        <div className="bg-rail px-6 py-6 sm:px-8">
          <h1>
            <Image src={logo} alt="Periplus" priority className="h-9 w-auto" />
          </h1>
        </div>
        <div className="p-6 sm:p-8">
          <Suspense>
            <Form searchParams={props.searchParams} />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
