import { DOMParser } from "linkedom";

const MAX_ROWS = 500;

type Cell = string | number | boolean | null | undefined | object;

function cell(value: Cell): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

/** GFM table; every row is padded or cut to the header's width. */
function table(header: string[], rows: Cell[][]): string {
  const line = (cells: Cell[]) => `| ${header.map((_, i) => cell(cells[i])).join(" | ")} |`;
  return [line(header), `| ${header.map(() => "---").join(" | ")} |`, ...rows.map(line)].join("\n") + "\n";
}

/** RFC 4180 records: quoted fields may hold the separator, line breaks and `""`; empty lines are skipped. */
function parseCsv(text: string, separator: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  const endRecord = () => {
    record.push(field);
    if (record.length > 1 || record[0] !== "") records.push(record);
    record = [];
    field = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === separator) {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
    } else field += ch;
  }
  if (field !== "" || record.length > 0) endRecord();
  return records;
}

/** `;` when the first line has more semicolons than commas (European exports), else `,`. */
function csvSeparator(text: string): string {
  const first = text.slice(0, text.search(/\r|\n|$/));
  const count = (c: string) => first.split(c).length - 1;
  return count(";") > count(",") ? ";" : ",";
}

function csvToMarkdown(text: string): string {
  const [header = [], ...rows] = parseCsv(text, csvSeparator(text));
  return table(header, rows.slice(0, MAX_ROWS));
}

/** First `[lon, lat]` pair in nested GeoJSON coordinates. */
function firstPosition(coords: unknown): [number, number] | null {
  if (!Array.isArray(coords) || coords.length === 0) return null;
  if (typeof coords[0] === "number" && typeof coords[1] === "number") return [coords[0], coords[1]];
  return firstPosition(coords[0]);
}

type Geometry = { type?: string; coordinates?: unknown; geometries?: Geometry[] } | null | undefined;

function firstPoint(geometry: Geometry): [number, number] | null {
  if (!geometry) return null;
  if (geometry.type === "GeometryCollection") return firstPoint(geometry.geometries?.[0]);
  return firstPosition(geometry.coordinates);
}

type Feature = { properties?: Record<string, Cell> | null; geometry?: Geometry };

function geojsonToMarkdown(text: string): string {
  const data = JSON.parse(text) as { type?: string; features?: Feature[] } & Feature;
  const features = (data.type === "FeatureCollection" ? (data.features ?? []) : [data]).slice(0, MAX_ROWS);
  const keys: string[] = [];
  for (const f of features) for (const k of Object.keys(f.properties ?? {})) if (!keys.includes(k)) keys.push(k);
  const rows = features.map((f) => {
    const point = firstPoint(f.geometry);
    return [...keys.map((k) => f.properties?.[k]), point?.[0], point?.[1]];
  });
  return table([...keys, "lon", "lat"], rows);
}

function kmlToMarkdown(text: string): string {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  const placemarks = [...doc.getElementsByTagName("Placemark")].slice(0, MAX_ROWS);
  const rows = placemarks.map((p) => {
    const name = p.getElementsByTagName("name")[0]?.textContent ?? null;
    const first = (p.getElementsByTagName("coordinates")[0]?.textContent ?? "").trim().split(/\s+/)[0];
    const [lon, lat] = first ? first.split(",") : [];
    return [name, lon, lat];
  });
  return table(["name", "lon", "lat"], rows);
}

/**
 * Markdown table of a structured file, at most 500 rows: CSV with its header row; GeoJSON with one row per
 * feature (properties plus `lon`, `lat` of the first point); KML with name and first coordinate per `Placemark`.
 */
export function structuredToMarkdown(raw: Uint8Array, kind: "csv" | "geojson" | "kml"): string {
  const text = new TextDecoder("utf-8").decode(raw);
  if (kind === "csv") return csvToMarkdown(text);
  if (kind === "geojson") return geojsonToMarkdown(text);
  return kmlToMarkdown(text);
}
