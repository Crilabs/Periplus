import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { categoryForTags, classifyOsm, osmNames } from "@/lib/domain/gazetteer/osm-classify";

const { categories } = loadConfig();

describe("classifyOsm", () => {
  it.each([
    ["marina", { leisure: "marina", name: "Marina Aegina" }, { type: "harbour" }],
    ["seamark harbour", { "seamark:type": "harbour", name: "Limani" }, { type: "harbour" }],
    ["harbour tag", { harbour: "yes", name: "Port" }, { type: "harbour" }],
    ["anchorage seamark", { "seamark:type": "anchorage", name: "Anchorage A" }, { type: "bay" }],
    ["island", { place: "island", name: "Αίγινα" }, { type: "island" }],
    ["islet", { place: "islet", "name:en": "Small Rock" }, { type: "islet" }],
    ["gulf", { place: "gulf", name: "Σαρωνικός Κόλπος" }, { type: "gulf" }],
    ["cape", { natural: "cape", name: "Akra" }, { type: "cape" }],
    ["strait", { natural: "strait", name: "Stenó" }, { type: "strait" }],
    ["bay", { natural: "bay", name: "Όρμος Κλήμα" }, { type: "bay" }],
    ["village", { place: "village", name: "Perdika" }, { type: "settlement" }],
    ["city", { place: "city", name: "Valletta" }, { type: "settlement" }],
    ["taverna", { amenity: "restaurant", name: "Taverna Nontas" }, { type: "poi", category: "food" }],
    ["ruins", { historic: "ruins", name: "Temple" }, { type: "poi", category: "culture" }],
  ])("%s", (_label, tags, expected) => {
    expect(classifyOsm(tags, categories)).toEqual(expected);
  });

  it("a sea and a peninsula are no gazetteer objects (B5, B6): seas come from Marine Regions, coast sections from config", () => {
    expect(classifyOsm({ place: "sea", name: "Aegean Sea" }, categories)).toBeNull();
    expect(classifyOsm({ place: "sea", name: "Aegean Sea" }, categories, "relation")).toBeNull();
    expect(classifyOsm({ natural: "peninsula", name: "Peloponnese" }, categories)).toBeNull();
    expect(classifyOsm({ natural: "peninsula", name: "Peloponnese" }, categories, "relation")).toBeNull();
  });

  it("an unnamed bay is null", () => {
    expect(classifyOsm({ natural: "bay" }, categories)).toBeNull();
  });

  it("a name the names cannot use (name:etymology, empty name) does not count as a name", () => {
    expect(classifyOsm({ natural: "bay", "name:etymology": "after a saint" }, categories)).toBeNull();
    expect(classifyOsm({ natural: "bay", name: "" }, categories)).toBeNull();
    expect(classifyOsm({ natural: "bay", "name:en": "" }, categories)).toBeNull();
  });

  it("a bay relation with only a Greek name containing Κόλπος is a gulf", () => {
    expect(classifyOsm({ natural: "bay", name: "Κόλπος Σουσακίου" }, categories, "relation")).toEqual({ type: "gulf" });
  });

  it("an unmatched named object is null", () => {
    expect(classifyOsm({ amenity: "bench", name: "Bench" }, categories)).toBeNull();
  });

  it("a bay relation named gulf is a gulf, a bay way with the same name stays a bay", () => {
    const tags = { natural: "bay", name: "Κόλπος Επιδαύρου", "name:en": "Gulf of Epidaurus" };
    expect(classifyOsm(tags, categories, "relation")).toEqual({ type: "gulf" });
    expect(classifyOsm(tags, categories, "way")).toEqual({ type: "bay" });
    expect(classifyOsm({ natural: "bay", name: "Ormos Klima" }, categories, "relation")).toEqual({ type: "bay" });
  });

  it("administrative boundary relations are country (level 2) or admin_region with their level", () => {
    const tags = { boundary: "administrative", name: "Hrvatska" };
    expect(classifyOsm({ ...tags, admin_level: "2" }, categories, "relation")).toEqual({ type: "country", adminLevel: 2 });
    expect(classifyOsm({ ...tags, admin_level: "4" }, categories, "relation")).toEqual({ type: "admin_region", adminLevel: 4 });
    expect(classifyOsm({ ...tags, admin_level: "4" }, categories, "way")).toBeNull();
    expect(classifyOsm({ boundary: "administrative", admin_level: "4" }, categories, "relation")).toBeNull();
  });

  it("place outranks a harbour tag", () => {
    expect(classifyOsm({ place: "island", harbour: "yes", name: "Agistri" }, categories)).toEqual({ type: "island" });
  });
});

describe("osmNames", () => {
  it("maps name, name:<lang> and alternate names", () => {
    const names = osmNames({
      name: "Αίγινα",
      "name:de": "Ägina",
      "name:en": "Aegina",
      "name:etymology": "ignored",
      alt_name: "Egina;Aigina",
      old_name: "Engia",
      int_name: "Aegina Island",
      place: "island",
    });
    expect(names).toEqual([
      { name: "Αίγινα", language: "el", origin: "osm" },
      { name: "Ägina", language: "de", origin: "osm" },
      { name: "Aegina", language: "en", origin: "osm" },
      { name: "Aegina Island", language: "und", origin: "osm", isPreferred: false },
      { name: "Egina", language: "und", origin: "osm", isPreferred: false },
      { name: "Aigina", language: "und", origin: "osm", isPreferred: false },
      { name: "Engia", language: "und", origin: "osm", isPreferred: false },
    ]);
  });

  it("a Latin name has language und", () => {
    expect(osmNames({ name: "Perdika" })).toEqual([{ name: "Perdika", language: "und", origin: "osm" }]);
  });
});

describe("categoryForTags (spec 15 A: highlights for trip planning only)", () => {
  it.each([
    ["fuel", { amenity: "fuel" }, null],
    ["pharmacy", { amenity: "pharmacy" }, null],
    ["atm", { amenity: "atm" }, null],
    ["drinking water", { amenity: "drinking_water" }, null],
    ["bakery", { shop: "bakery" }, "bakery"],
    ["bus stop", { highway: "bus_stop" }, "transport"],
    ["bus station", { amenity: "bus_station" }, "transport"],
    ["taxi", { amenity: "taxi" }, "transport"],
    ["ferry terminal", { amenity: "ferry_terminal" }, "transport"],
    ["pier", { man_made: "pier" }, "landing"],
    ["slipway", { leisure: "slipway" }, "landing"],
    ["butcher", { shop: "butcher" }, null],
    ["scuba diving shop", { shop: "scuba_diving" }, null],
    ["convenience", { shop: "convenience" }, "supply"],
    ["supermarket", { shop: "supermarket" }, "supply"],
    ["restaurant", { amenity: "restaurant" }, "food"],
    ["viewpoint", { tourism: "viewpoint" }, "active"],
    ["fuel and convenience", { amenity: "fuel", shop: "convenience" }, "supply"],
  ])("%s", (_label, tags, expected) => {
    expect(categoryForTags(tags, categories)).toBe(expected);
  });

  it("classifyOsm needs a name, categoryForTags does not", () => {
    expect(classifyOsm({ shop: "supermarket" }, categories)).toBeNull();
    expect(categoryForTags({ shop: "supermarket" }, categories)).toBe("supply");
    expect(classifyOsm({ shop: "butcher", name: "Metzger" }, categories)).toBeNull();
  });
});
