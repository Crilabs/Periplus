import { describe, expect, it } from "vitest";
import { knownWebsites } from "@/lib/domain/places/websites";

describe("knownWebsites", () => {
  it("lists website, contact:website, then Wikidata, each with its origin", () => {
    expect(
      knownWebsites({
        tags: { "contact:website": "https://contact.example/", website: "https://marina.example/" },
        websiteWikidata: "https://wd.example/",
      }),
    ).toEqual([
      { url: "https://marina.example/", origin: "osm" },
      { url: "https://contact.example/", origin: "osm" },
      { url: "https://wd.example/", origin: "wikidata" },
    ]);
  });

  it("drops ignored and forbidden domains and non-http(s) schemes", () => {
    expect(
      knownWebsites({
        tags: { website: "https://www.facebook.com/marina", "contact:website": "ftp://marina.example/" },
        websiteWikidata: "https://www.booking.com/hotel",
      }),
    ).toEqual([]);
    expect(knownWebsites({ tags: { website: "https://www.google.de/maps" }, websiteWikidata: null })).toEqual([]);
    expect(knownWebsites({ tags: { website: "https://navily.com/x" }, websiteWikidata: null })).toEqual([]);
    expect(knownWebsites({ tags: { website: "not a url" }, websiteWikidata: "https://ok.example/" })).toEqual([
      { url: "https://ok.example/", origin: "wikidata" },
    ]);
  });

  it("returns nothing without any address", () => {
    expect(knownWebsites({ tags: {}, websiteWikidata: null })).toEqual([]);
  });
});
