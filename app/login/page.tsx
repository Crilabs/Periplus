import { Suspense } from "react";
import { safeNext } from "@/lib/security/safe-next";
import { LoginForm } from "./login-form";

async function Form({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return <LoginForm next={safeNext(Array.isArray(next) ? next[0] : next)} />;
}

export default function Page(props: PageProps<"/login">) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Periplus</h1>
      <Suspense>
        <Form searchParams={props.searchParams} />
      </Suspense>
    </main>
  );
}
