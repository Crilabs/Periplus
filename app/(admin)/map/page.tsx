import { requireAdmin } from "@/lib/security/require-admin";
import { PageHeader } from "../_components/ui";
import { MapView } from "../_components/map-view";

export default async function Page() {
  await requireAdmin();
  return (
    <>
      <PageHeader
        title="Karte"
        description="Reviere, Kacheln, Ausschlussflächen, Geo-Objekte und Orte im sichtbaren Ausschnitt. Ein Klick auf ein Objekt zeigt seine Eckdaten."
      />
      <MapView />
    </>
  );
}
