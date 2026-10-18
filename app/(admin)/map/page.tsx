import { requireAdmin } from "@/lib/security/require-admin";
import { MapView } from "../_components/map-view";

export default async function Page() {
  await requireAdmin();
  return (
    <>
      <h1 className="mb-3 text-lg font-semibold">Karte</h1>
      <MapView />
    </>
  );
}
