import { getConfig } from "@/lib/config";
import { requireAdmin } from "@/lib/security/require-admin";

export default async function Page() {
  await requireAdmin();
  const config = getConfig();
  return (
    <div className="space-y-4 text-sm">
      <h1 className="text-lg font-semibold">Einstellungen</h1>
      <h2 className="font-semibold">Aktive Konfiguration</h2>
      {Object.entries(config).map(([name, value]) => (
        <section key={name}>
          <h3 className="mb-1 font-mono">{name}</h3>
          <pre className="overflow-x-auto rounded bg-neutral-100 p-3">{JSON.stringify(value, null, 2)}</pre>
        </section>
      ))}
    </div>
  );
}
