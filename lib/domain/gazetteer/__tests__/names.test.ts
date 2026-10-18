import { and, eq, isNull, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects } from "@/lib/db/schema";
import {
  addNames,
  ensureFallbackNames,
  isGreek,
  normalizeName,
  transliterateElot743,
} from "@/lib/domain/gazetteer/names";
import { withRollback } from "@/test/db";

// Outside the pilot box 23.0-23.75 E x 37.0-38.0 N.
const geom = geomFromGeoJson({ type: "Point", coordinates: [25.1, 35.3] });

async function insertGeoObject(tx: Db): Promise<string> {
  const [row] = await tx.insert(geoObjects).values({ type: "bay", origin: "osm", geom }).returning({ id: geoObjects.id });
  return row!.id;
}

async function validNames(tx: Db, geoObjectId: string) {
  return tx
    .select({
      name: geoNames.name,
      nameNormalized: geoNames.nameNormalized,
      language: geoNames.language,
      script: geoNames.script,
      origin: geoNames.origin,
      isPreferred: geoNames.isPreferred,
    })
    .from(geoNames)
    .where(and(eq(geoNames.geoObjectId, geoObjectId), isNull(geoNames.validTo)))
    .orderBy(geoNames.language, geoNames.origin, geoNames.name);
}

describe("transliterateElot743", () => {
  it.each([
    ["Αίγινα", "Aigina"],
    ["Πόρος", "Poros"],
    ["Ύδρα", "Ydra"],
    ["Σπέτσες", "Spetses"],
    ["Ερμιόνη", "Ermioni"],
    ["Μέθανα", "Methana"],
    ["Αγκίστρι", "Agkistri"],
    ["Πόρτο Χέλι", "Porto Cheli"],
    ["Επίδαυρος", "Epidavros"],
    ["Ναύπλιο", "Nafplio"],
    ["Άγιος Γεώργιος", "Agios Georgios"],
    ["Ντόκος", "Ntokos"],
    ["Μπούρτζι", "Mpourtzi"],
  ])("transliterates %s to %s", (el, latin) => expect(transliterateElot743(el)).toBe(latin));

  it("lets the diaeresis split a digraph", () => {
    expect(transliterateElot743("Ταΐζω")).toBe("Taizo");
    expect(transliterateElot743("Προϋπόθεση")).toBe("Proypothesi");
    expect(transliterateElot743("Νεϋόρκη")).toBe("Neyorki");
  });

  it("writes αυ/ευ as af/ef before voiceless consonants and at the end of a word", () => {
    expect(transliterateElot743("ευχή")).toBe("efchi");
    expect(transliterateElot743("Ευαγγελίστρια")).toBe("Evangelistria");
    expect(transliterateElot743("ταυ")).toBe("taf");
  });

  it("keeps all-caps words in capitals and passes non-Greek characters through", () => {
    expect(transliterateElot743("ΑΓΙΑ ΜΑΡΙΝΑ (Αίγινα)")).toBe("AGIA MARINA (Aigina)");
  });
});

describe("normalizeName", () => {
  it("normalizes accents, case and final sigma", () => {
    expect(normalizeName("Άγιος  Γεώργιος")).toBe("αγιοσ γεωργιοσ");
    expect(normalizeName("Pórto-Chéli")).toBe("porto cheli");
  });

  it("removes the diaeresis and trims punctuation", () => {
    expect(normalizeName(" Ταΐζω, (Ϊ)! ")).toBe("ταιζω ι");
  });
});

describe("isGreek", () => {
  it("is true when Greek letters outnumber Latin ones", () => {
    expect(isGreek("Πόρτο Χέλι")).toBe(true);
    expect(isGreek("Porto Cheli")).toBe(false);
    expect(isGreek("Όρμος Bay")).toBe(true);
    expect(isGreek("123")).toBe(false);
  });
});

describe("addNames", () => {
  it("writes the Greek name plus its transliteration once", async () => {
    await withRollback(async (tx) => {
      const id = await insertGeoObject(tx);
      expect(await addNames(tx, id, [{ name: "Πόρτο Χέλι", language: "el", origin: "osm" }])).toBe(2);
      expect(await addNames(tx, id, [{ name: "Πόρτο Χέλι", language: "el", origin: "osm" }])).toBe(0);
      expect(await validNames(tx, id)).toEqual([
        {
          name: "Πόρτο Χέλι",
          nameNormalized: "πορτο χελι",
          language: "el",
          script: "greek",
          origin: "osm",
          isPreferred: true,
        },
        {
          name: "Porto Cheli",
          nameNormalized: "porto cheli",
          language: "el",
          script: "latin",
          origin: "transliteration",
          isPreferred: false,
        },
      ]);
    });
  });

  it("prefers the first osm name per language, else the first one, and keeps an existing preference", async () => {
    await withRollback(async (tx) => {
      const id = await insertGeoObject(tx);
      await addNames(tx, id, [
        { name: "Porto Heli", language: "en", origin: "wikidata" },
        { name: "Porto Cheli", language: "en", origin: "osm" },
        { name: "Portocheli", language: "en", origin: "osm" },
        { name: "Porto Cheli", language: "de", origin: "wikidata" },
      ]);
      await addNames(tx, id, [{ name: "Porto Kheli", language: "en", origin: "osm" }]);
      const preferred = (await validNames(tx, id)).filter((n) => n.isPreferred).map((n) => `${n.language}:${n.name}`);
      expect(preferred.sort()).toEqual(["de:Porto Cheli", "en:Porto Cheli"]);
    });
  });

  it("honours an explicit isPreferred", async () => {
    await withRollback(async (tx) => {
      const id = await insertGeoObject(tx);
      await addNames(tx, id, [
        { name: "Porto Cheli", language: "en", origin: "osm" },
        { name: "Porto Heli", language: "en", origin: "wikidata", isPreferred: true },
      ]);
      const preferred = (await validNames(tx, id)).filter((n) => n.isPreferred).map((n) => n.name);
      expect(preferred).toEqual(["Porto Heli"]);
    });
  });

  it("collapses inner whitespace in the stored name so spacing variants are one row", async () => {
    await withRollback(async (tx) => {
      const id = await insertGeoObject(tx);
      expect(await addNames(tx, id, [{ name: "Πόρτο Χέλι", language: "el", origin: "osm" }])).toBe(2);
      expect(await addNames(tx, id, [{ name: "  Πόρτο \t Χέλι ", language: "el", origin: "osm" }])).toBe(0);
      expect((await validNames(tx, id)).map((n) => n.name).sort()).toEqual(["Porto Cheli", "Πόρτο Χέλι"]);
    });
  });

  it("a real name ends the valid fallback row of its language and becomes preferred", async () => {
    await withRollback(async (tx) => {
      const id = await insertGeoObject(tx);
      await addNames(tx, id, [{ name: "Spetses", language: "en", origin: "osm" }]);
      expect(await ensureFallbackNames(tx, [id])).toBe(1);
      expect(await addNames(tx, id, [{ name: "Spetsä", language: "de", origin: "wikidata" }])).toBe(1);

      const valid = (await validNames(tx, id)).filter((n) => n.language === "de");
      expect(valid.map((n) => [n.name, n.origin, n.isPreferred])).toEqual([["Spetsä", "wikidata", true]]);
      const ended = await tx
        .select({ validTo: geoNames.validTo })
        .from(geoNames)
        .where(and(eq(geoNames.geoObjectId, id), eq(geoNames.origin, "fallback")));
      expect(ended).toHaveLength(1);
      expect(ended[0]!.validTo).not.toBeNull();
      expect(await ensureFallbackNames(tx, [id])).toBe(0);
    });
  });

  it("a fallback row of another language is not ended", async () => {
    await withRollback(async (tx) => {
      const id = await insertGeoObject(tx);
      await addNames(tx, id, [{ name: "Spetses", language: "en", origin: "osm" }]);
      await ensureFallbackNames(tx, [id]);
      await addNames(tx, id, [{ name: "Σπέτσες", language: "el", origin: "osm" }]);
      expect((await validNames(tx, id)).some((n) => n.origin === "fallback")).toBe(true);
    });
  });

  it("a transliterated name is found by trigram similarity from its common Latin spellings", async () => {
    await withRollback(async (tx) => {
      const id = await insertGeoObject(tx);
      await addNames(tx, id, [{ name: "Πόρτο Χέλι", language: "el", origin: "osm" }]);
      const [row] = await tx
        .select({
          cheli: sql<number>`similarity(${geoNames.nameNormalized}, ${normalizeName("Porto Cheli")})`,
          heli: sql<number>`similarity(${geoNames.nameNormalized}, ${normalizeName("Porto Heli")})`,
        })
        .from(geoNames)
        .where(and(eq(geoNames.geoObjectId, id), eq(geoNames.origin, "transliteration")));
      expect(row!.cheli).toBeGreaterThanOrEqual(0.8);
      expect(row!.heli).toBeGreaterThanOrEqual(0.5);
    });
  });
});

describe("ensureFallbackNames", () => {
  it("copies en to de with origin fallback, but not where de exists", async () => {
    await withRollback(async (tx) => {
      const withoutDe = await insertGeoObject(tx);
      const withDe = await insertGeoObject(tx);
      const withoutEn = await insertGeoObject(tx);
      await addNames(tx, withoutDe, [
        { name: "Porto Heli", language: "en", origin: "wikidata" },
        { name: "Porto Cheli", language: "en", origin: "osm" },
      ]);
      await addNames(tx, withDe, [
        { name: "Hydra", language: "en", origin: "osm" },
        { name: "Hydra", language: "de", origin: "wikidata" },
      ]);
      await addNames(tx, withoutEn, [{ name: "Ύδρα", language: "el", origin: "osm" }]);

      expect(await ensureFallbackNames(tx, [withoutDe, withDe, withoutEn])).toBe(1);
      expect(await ensureFallbackNames(tx, [withoutDe, withDe, withoutEn])).toBe(0);

      expect((await validNames(tx, withoutDe)).filter((n) => n.language === "de")).toEqual([
        {
          name: "Porto Cheli",
          nameNormalized: "porto cheli",
          language: "de",
          script: "latin",
          origin: "fallback",
          isPreferred: true,
        },
      ]);
      expect((await validNames(tx, withDe)).filter((n) => n.language === "de").map((n) => n.origin)).toEqual([
        "wikidata",
      ]);
      expect((await validNames(tx, withoutEn)).filter((n) => n.language === "de")).toEqual([]);
    });
  });

  it("without ids covers every valid object", async () => {
    await withRollback(async (tx) => {
      const id = await insertGeoObject(tx);
      await addNames(tx, id, [{ name: "Spetses", language: "en", origin: "osm" }]);
      expect(await ensureFallbackNames(tx)).toBeGreaterThanOrEqual(1);
      expect((await validNames(tx, id)).filter((n) => n.origin === "fallback").map((n) => n.name)).toEqual([
        "Spetses",
      ]);
    });
  });
});
