import type { Metadata } from "next";
import { getDb } from "@/lib/db/client";
import { subdivisionOptions } from "@/lib/domain/areas/view";
import { requireAdmin } from "@/lib/security/require-admin";
import { PageHeader } from "../_components/ui";
import { MapView } from "../_components/map-view";

export const metadata: Metadata = { title: "Karte" };

export default async function Page() {
  await requireAdmin();
  return (
    <>
      <PageHeader
        title="Karte"
        description="Reviere, Kacheln, Ausschlussflächen, Geo-Objekte und Orte im sichtbaren Ausschnitt. Ein Klick auf ein Objekt zeigt seine Eckdaten."
      />
      <MapView subdivisions={await subdivisionOptions(getDb())} />
    </>
  );
}
