import { getConfig } from "@/lib/config";
import { requireAdmin } from "@/lib/security/require-admin";

export default async function Page() {
  await requireAdmin();
  const { areas, gazetteer, ...rest } = getConfig();
  const thresholds: [string, string][] = [
    ["Puffer Kachelbox", `${gazetteer.bboxBufferKm} km`],
    ["Puffer Land", `${gazetteer.landBufferKm} km`],
    ["Küstenabstand", `${gazetteer.coastDistanceM} m`],
    ["Puffer Insel-Elternobjekt", `${gazetteer.islandParentBufferM} m`],
    ["Trigramm-Ähnlichkeit (sicher)", String(gazetteer.merge.trigramMin)],
    ["Trigramm-Ähnlichkeit (unsicher)", String(gazetteer.merge.uncertainTrigramMin)],
    [
      "Zusammenführungsabstand",
      Object.entries(gazetteer.merge.distanceM)
        .map(([type, m]) => `${type === "default" ? "sonst" : type} ${m} m`)
        .join(", "),
    ],
    ["Faktor Abstand (unsicher)", String(gazetteer.merge.uncertainDistanceFactor)],
    ["Wikidata-Verknüpfung bis", `${gazetteer.merge.wikidataLinkDistanceM} m`],
    ["GeoNames neues Objekt ab", `${gazetteer.merge.geonamesNewObjectRadiusM} m`],
    ["Overpass", `${gazetteer.overpass.timeoutSeconds} s Timeout, ${gazetteer.overpass.ratePerMinute}/min`],
    ["Wikidata", `${gazetteer.wikidata.ratePerMinute}/min, Sprachen ${gazetteer.wikidata.languages.join(", ")}`],
    ["GeoNames", `${gazetteer.geonames.countries.join(", ")}, alle ${gazetteer.geonames.refreshDays} Tage`],
    ["Kein Ankern bei", gazetteer.noAnchoringKinds.join(", ")],
  ];
  return (
    <div className="space-y-4 text-sm">
      <h1 className="text-lg font-semibold">Einstellungen</h1>

      <h2 className="font-semibold">Reviere</h2>
      <table className="w-full text-left">
        <thead>
          <tr className="border-b">
            <th className="py-1 pr-4">Key</th>
            <th className="py-1 pr-4">Namen</th>
            <th className="py-1 pr-4">Kachelbox</th>
            <th className="py-1 pr-4">Zyklus</th>
            <th className="py-1 pr-4">Küstenabschnitte</th>
          </tr>
        </thead>
        <tbody>
          {areas.map((area) => (
            <tr key={area.key} className="border-b align-top">
              <td className="py-1 pr-4 font-mono">{area.key}</td>
              <td className="py-1 pr-4">
                {Object.entries(area.names)
                  .map(([lang, name]) => `${lang}: ${name}`)
                  .join(" · ")}
              </td>
              <td className="py-1 pr-4 font-mono">{area.tileBbox ? area.tileBbox.join(", ") : "keine"}</td>
              <td className="py-1 pr-4">{area.cycleDays} Tage</td>
              <td className="py-1 pr-4">{area.coastSections.map((s) => s.names.de).join(", ") || "keine"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="font-semibold">Gazetteer-Schwellen</h2>
      <table className="text-left">
        <tbody>
          {thresholds.map(([label, value]) => (
            <tr key={label} className="border-b">
              <th className="py-1 pr-4 font-normal">{label}</th>
              <td className="py-1 pr-4">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="font-semibold">Aktive Konfiguration</h2>
      {Object.entries(rest).map(([name, value]) => (
        <section key={name}>
          <h3 className="mb-1 font-mono">{name}</h3>
          <pre className="overflow-x-auto rounded bg-neutral-100 p-3">{JSON.stringify(value, null, 2)}</pre>
        </section>
      ))}
    </div>
  );
}
