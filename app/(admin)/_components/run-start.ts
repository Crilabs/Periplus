import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";

// Not a "use server" module: its function takes a callback and must never become a server action endpoint.

/**
 * Starts a run and redirects to it. A scope lacking an input (`RunScopeNotReady`) redirects to `errorPath` with
 * `?error=<reason>` instead, which that page shows in German.
 */
export async function startAndRedirect(start: () => Promise<{ id: string }>, errorPath: string): Promise<void> {
  let target: string;
  try {
    target = `/runs/${(await start()).id}`;
  } catch (e) {
    if (!(e instanceof RunScopeNotReady)) throw e;
    target = `${errorPath}?error=${e.reason}`;
  }
  revalidatePath("/runs");
  redirect(target);
}
