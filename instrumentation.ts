/**
 * Next.js calls register() once when a server instance starts. On the Node.js runtime it validates
 * env and config (lib/startup.ts); the import sits inside the runtime check so the Edge bundle never
 * includes Node-only code.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateStartup } = await import("@/lib/startup");
    validateStartup();
  }
}
