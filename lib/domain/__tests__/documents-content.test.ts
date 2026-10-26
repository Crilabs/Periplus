import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectLanguage } from "@/lib/domain/documents/language";
import { extractPublishedAt, observedFrom } from "@/lib/domain/documents/metadata";
import { contentHash, normalizeMarkdown, normalizeText } from "@/lib/domain/documents/normalize";
import { shingleHashes, shingleWords } from "@/lib/domain/documents/shingles";
import { structuredToMarkdown } from "@/lib/domain/documents/structured";

const html = (name: string) => readFileSync(join("test/fixtures/html", name), "utf8");
const languages = { deu: "de", eng: "en", ell: "el", ita: "it", hrv: "hr", fra: "fr" };
const fetchedAt = new Date("2026-10-19T10:00:00Z");
const bytes = (s: string) => new TextEncoder().encode(s);

describe("normalizeMarkdown", () => {
  it("unifies line ends, drops zero-width characters and trailing blanks, collapses blank lines", () => {
    expect(normalizeMarkdown("a  \r\n\r\n\r\n\r\nb​")).toBe("a\n\nb\n");
  });
  it("composes to NFC and keeps exactly one final newline", () => {
    expect(normalizeMarkdown("Café\rx \t\n\n\n")).toBe("Café\nx\n");
    expect(normalizeMarkdown("﻿a‌b‍c")).toBe("abc\n");
  });
  it("is idempotent", () => {
    const once = normalizeMarkdown("# T \r\n\r\n\r\n\r\ntext​  \n\n\n\n");
    expect(normalizeMarkdown(once)).toBe(once);
  });
  it("is idempotent when a zero-width character separates a base letter and its combining mark", () => {
    const once = normalizeMarkdown("e\u200B\u0301 text");
    expect(once).toBe("\u00e9 text\n");
    expect(normalizeMarkdown(once)).toBe(once);
  });
});

describe("contentHash", () => {
  it("is the sha256 hex of the text", () => {
    expect(contentHash("a\n")).toBe("87428fc522803d31065e7bce3cf03fe475096631e5e07bbd7a0fde60c4cf25c7");
  });
});

describe("normalizeText", () => {
  it("unifies quotes, dashes and whitespace", () => {
    expect(normalizeText("„Taverne“ – offen   jetzt")).toBe('"Taverne" - offen jetzt');
  });
  it("maps every quote and dash variant, keeps case and accents", () => {
    expect(normalizeText(" «Ά» ”x“ ‚y‘ ’z’ ‹w› a‐b‑c‒d—e―f \n Ώρα ")).toBe(
      "\"Ά\" \"x\" 'y' 'z' 'w' a-b-c-d-e-f Ώρα",
    );
  });
  it("composes to NFC", () => {
    expect(normalizeText("Café")).toBe("Café");
  });
});

describe("detectLanguage", () => {
  const greekParagraph =
    "Το λιμάνι της Αίγινας προσφέρει καλή προστασία από τους βόρειους ανέμους, αλλά το καλοκαίρι γεμίζει γρήγορα με σκάφη.";
  it("detects Greek", () => {
    expect(detectLanguage(greekParagraph, languages)).toBe("el");
  });
  it("detects German", () => {
    expect(
      detectLanguage("Die Bucht bietet guten Schutz vor dem Meltemi, der Ankergrund ist Sand mit einzelnen Seegrasfeldern.", languages),
    ).toBe("de");
  });
  it("returns null for text below 50 characters", () => {
    expect(detectLanguage("Hi", languages)).toBeNull();
  });
});

describe("extractPublishedAt", () => {
  it("prefers meta article:published_time", () => {
    expect(extractPublishedAt({ html: html("article.html"), url: "https://x.gr/2023/07/aegina", hint: "2020-01-01", fetchedAt })).toBe(
      "2024-05-01",
    );
  });
  it("reads datePublished from JSON-LD @graph and skips broken JSON-LD", () => {
    expect(extractPublishedAt({ html: html("jsonld.html"), url: "https://x.gr/a", hint: null, fetchedAt })).toBe("2024-06-03");
  });
  it("reads a top-level JSON-LD array", () => {
    const page = `<script type="application/ld+json">[{"@type":"Article","datePublished":"2022-02-28"}]</script>`;
    expect(extractPublishedAt({ html: page, url: "https://x.gr/a", hint: null, fetchedAt })).toBe("2022-02-28");
  });
  it("falls back to the converter hint", () => {
    expect(extractPublishedAt({ html: "<p>x</p>", url: "https://x.gr/a", hint: "2021-03-04T00:00:00Z", fetchedAt })).toBe("2021-03-04");
  });
  it("reads year and month from the URL, day defaults to 01", () => {
    expect(extractPublishedAt({ html: null, url: "https://x.gr/2023/07/aegina", hint: null, fetchedAt })).toBe("2023-07-01");
  });
  it("reads year, month and day from the URL", () => {
    expect(extractPublishedAt({ html: null, url: "https://x.gr/blog/2019/11/23/poros", hint: null, fetchedAt })).toBe("2019-11-23");
  });
  it("ignores digit runs that are not a date path", () => {
    expect(extractPublishedAt({ html: null, url: "https://x.gr/p/120230/07", hint: null, fetchedAt })).toBeNull();
    expect(extractPublishedAt({ html: null, url: "https://x.gr/2023/13/x", hint: null, fetchedAt })).toBeNull();
  });
  it("discards dates before 1990 and after fetchedAt + 1 day, then tries the next candidate", () => {
    const page = (d: string) => `<meta property="article:published_time" content="${d}">`;
    expect(extractPublishedAt({ html: page("1989-12-31"), url: "https://x.gr/a", hint: null, fetchedAt })).toBeNull();
    expect(extractPublishedAt({ html: page("2026-10-20"), url: "https://x.gr/a", hint: null, fetchedAt })).toBe("2026-10-20");
    expect(extractPublishedAt({ html: page("2026-10-21"), url: "https://x.gr/a", hint: null, fetchedAt })).toBeNull();
    expect(extractPublishedAt({ html: page("2030-01-01"), url: "https://x.gr/2023/07/a", hint: null, fetchedAt })).toBe("2023-07-01");
  });
  it("discards impossible calendar dates", () => {
    expect(extractPublishedAt({ html: null, url: "https://x.gr/a", hint: "2023-02-30", fetchedAt })).toBeNull();
  });
  it("returns null without any candidate", () => {
    expect(extractPublishedAt({ html: null, url: "https://x.gr/a", hint: null, fetchedAt })).toBeNull();
  });
});

describe("observedFrom", () => {
  it("uses the publication date when known", () => {
    expect(observedFrom("2024-06-03", fetchedAt)).toEqual({ observedAt: "2024-06-03", basis: "published" });
  });
  it("uses the UTC fetch day otherwise", () => {
    expect(observedFrom(null, new Date("2026-10-19T23:30:00Z"))).toEqual({ observedAt: "2026-10-19", basis: "fetched" });
  });
});

describe("shingles", () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

  it("splits like normalizeName", () => {
    expect(shingleWords("Ἄγιος Νικόλαος, (Ύδρας)! 2-ος")).toEqual(["αγιοσ", "νικολαοσ", "υδρασ", "2", "οσ"]);
  });
  it("returns no hashes below 15 words, one per distinct 15-word window otherwise", () => {
    expect(shingleHashes(words(14))).toEqual([]);
    expect(shingleHashes(words(15))).toHaveLength(1);
    expect(shingleHashes(words(16))).toHaveLength(2);
  });
  it("hashes as the signed first 8 bytes of sha256 over the joined words", () => {
    // sha256("w0 w1 … w14") starts with e7ea1fa0033fcead → negative as a signed 64-bit integer
    expect(shingleHashes(words(15))).toEqual([BigInt.asIntN(64, 0xe7ea1fa0033fceadn)]);
    expect(shingleHashes(words(15))).toEqual([-1735539934288163155n]);
  });
  it("drops repeated windows", () => {
    const repeated = Array.from({ length: 30 }, () => "ena").join(" ");
    expect(shingleHashes(repeated)).toHaveLength(1);
  });
  it("ignores accents, case and final sigma", () => {
    const greek =
      "Ἄγιος Νικόλαος είναι ένας ήσυχος κόλπος στη νότια πλευρά της Αίγινας με καλό κράτημα σε άμμο και φύκια";
    const plain = "αγιοσ νικολαοσ ειναι ενασ ησυχοσ κολποσ στη νοτια πλευρα τησ αιγινασ με καλο κρατημα σε αμμο και φυκια";
    expect(shingleHashes(greek)).toEqual(shingleHashes(plain));
    expect(shingleHashes(greek)).toHaveLength(4); // 18 words
  });
  it("supports another window size", () => {
    expect(shingleHashes(words(5), 3)).toHaveLength(3);
  });
});

describe("structuredToMarkdown", () => {
  it("a csv becomes a markdown table with its header", () => {
    const csv = 'name,depth,note\r\nMoni,8,"sand, weed"\nPerdika,5,"say ""hi"" | wave"\n';
    expect(structuredToMarkdown(bytes(csv), "csv")).toBe(
      [
        "| name | depth | note |",
        "| --- | --- | --- |",
        "| Moni | 8 | sand, weed |",
        '| Perdika | 5 | say "hi" \\| wave |',
        "",
      ].join("\n"),
    );
  });
  it("a csv with semicolons in the header line is split at semicolons", () => {
    expect(structuredToMarkdown(bytes("name;depth\nMoni;8,5\n"), "csv")).toBe("| name | depth |\n| --- | --- |\n| Moni | 8,5 |\n");
  });
  it("a csv keeps at most 500 data rows", () => {
    const csv = ["n", ...Array.from({ length: 600 }, (_, i) => String(i))].join("\n");
    const lines = structuredToMarkdown(bytes(csv), "csv").trimEnd().split("\n");
    expect(lines).toHaveLength(502);
    expect(lines.at(-1)).toBe("| 499 |");
  });
  it("geojson properties become rows with lon and lat of the first point", () => {
    const geojson = JSON.stringify({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { name: "Moni", depth: 8 }, geometry: { type: "Point", coordinates: [23.4, 37.7] } },
        {
          type: "Feature",
          properties: { name: "Line\nbreak", kind: "zone" },
          geometry: { type: "Polygon", coordinates: [[[23.1, 37.2], [23.2, 37.2], [23.1, 37.3], [23.1, 37.2]]] },
        },
        { type: "Feature", properties: null, geometry: null },
      ],
    });
    expect(structuredToMarkdown(bytes(geojson), "geojson")).toBe(
      [
        "| name | depth | kind | lon | lat |",
        "| --- | --- | --- | --- | --- |",
        "| Moni | 8 |  | 23.4 | 37.7 |",
        "| Line break |  | zone | 23.1 | 37.2 |",
        "|  |  |  |  |  |",
        "",
      ].join("\n"),
    );
  });
  it("kml placemarks become a table with name and coordinates", () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><name>Moni</name><Point><coordinates>23.4,37.7,0</coordinates></Point></Placemark>
  <Folder><Placemark><name>Zone</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
    23.1,37.2,0 23.2,37.2,0 23.1,37.2,0
  </coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Folder>
</Document></kml>`;
    expect(structuredToMarkdown(bytes(kml), "kml")).toBe(
      ["| name | lon | lat |", "| --- | --- | --- |", "| Moni | 23.4 | 37.7 |", "| Zone | 23.1 | 37.2 |", ""].join("\n"),
    );
  });
});
