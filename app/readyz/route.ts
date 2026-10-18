import { connection } from "next/server";
import { isReady } from "@/lib/health";

export async function GET(): Promise<Response> {
  await connection(); // never prerender: the check must run per request
  const ready = await isReady();
  return Response.json({ status: ready ? "ok" : "unavailable" }, { status: ready ? 200 : 503 });
}
