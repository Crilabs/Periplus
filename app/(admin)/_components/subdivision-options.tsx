import type { SubdivisionOption } from "@/lib/domain/subdivisions/store";

const countryNames = new Intl.DisplayNames(["de"], { type: "region" });

/** German name of an ISO 3166-1 alpha-2 country code; the code itself when the runtime does not know it. */
function countryName(code: string): string {
  try {
    return countryNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The `<option>`s of a subdivision select, grouped by country (German names); options arrive ordered by country. */
export function SubdivisionOptions({ options }: { options: SubdivisionOption[] }) {
  const groups = new Map<string, SubdivisionOption[]>();
  for (const o of options) groups.set(o.country, [...(groups.get(o.country) ?? []), o]);
  return (
    <>
      {[...groups].map(([country, items]) => (
        <optgroup key={country} label={countryName(country)}>
          {items.map((o) => (
            <option key={o.key} value={o.key}>
              {o.name} ({o.key})
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
