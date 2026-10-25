import type { Fact, LandingPoint, NearbyEntry } from "@/contract/v2";
import { nearbyCategory } from "@/contract/v2";
import type { BerthStateFact, BerthStateLanding, BerthStateNearby } from "@/lib/db/schema/research-state";
import { normalizeName } from "@/lib/domain/gazetteer/names";
import { round5 } from "./geo";
import type { NearbyObject } from "./types";

/*
 * Berth state → the free parts of a 4.0 spot (design 7.3): facts, landing points and things on land. Pure: no
 * database. A fact carries its statement and a date, never its quote or its source; a landside fact points at the
 * `nearby` entry of its object by name, else carries only the name (coordinates are never guessed, design 5.7).
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The public id of a fact: `fc_` and the Crockford base 32 of the `berth_facts` uuid of its representative (E2): 128
 * bits in 26 characters, the first one 0 to 7, so it is a ULID by shape. Deterministic and unique per row, no table.
 */
export function factPublicId(uuid: string): string {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`fact id ${uuid} is no uuid`);
  let n = BigInt(`0x${hex}`);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(n & 31n)]! + out;
    n >>= 5n;
  }
  return `fc_${out}`;
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A thing on land delivered in `nearby`, with the names its landside facts may use. */
export type DeliveredNearby = { entry: NearbyEntry; keys: Set<string> };

export type NearbyWarning = { code: "nearby_without_id"; geoObjectId: string };

/**
 * `nearby` of the spot: the state's entries whose object has a public id (E1) and a delivered category, with name,
 * names and position of the object, nearest first. An entry whose object has no public id (or is not loaded) is left
 * out with a warning; a category outside the contract's (a `landing` POI) is left out silently.
 */
export function mapNearby(
  nearby: BerthStateNearby[],
  objects: NearbyObject[],
): { delivered: DeliveredNearby[]; warnings: NearbyWarning[] } {
  const byObject = new Map(objects.map((o) => [o.geoObjectId, o]));
  const delivered: DeliveredNearby[] = [];
  const warnings: NearbyWarning[] = [];
  for (const n of nearby) {
    if (!nearbyCategory.safeParse(n.category).success) continue;
    const object = byObject.get(n.geoObjectId);
    if (!object || object.publicId === null || object.name.trim() === "") {
      warnings.push({ code: "nearby_without_id", geoObjectId: n.geoObjectId });
      continue;
    }
    const entry: NearbyEntry = {
      id: object.publicId,
      category: n.category as NearbyEntry["category"],
      name: object.name,
      names: object.names.length > 0 ? object.names : undefined,
      position: { lat: round5(object.position.lat), lon: round5(object.position.lon) },
      distanceM: Math.max(0, Math.round(n.distanceM)),
      access: n.access,
    } as NearbyEntry;
    if (entry.names === undefined) delete entry.names;
    delivered.push({ entry, keys: new Set([object.name, ...object.names.map((x) => x.name)].map(normalizeName).filter((k) => k !== "")) });
  }
  delivered.sort((a, b) => a.entry.distanceM - b.entry.distanceM || byId(a.entry.id, b.entry.id));
  return { delivered, warnings: warnings.sort((a, b) => byId(a.geoObjectId, b.geoObjectId)) };
}

export type FactWarning = { code: "fact_without_subject"; factId: string };

/**
 * The state's facts as contract facts, newest first. A landside fact is assigned to the `nearby` entry whose name
 * (normalized, any of the object's names) equals its `subjectName`: `subject.id` set; otherwise `id: null` with the
 * name (E3). A landside fact without a name is left out with a warning: the contract needs an id or a name.
 */
export function mapFacts(facts: BerthStateFact[], nearby: DeliveredNearby[]): { facts: Fact[]; warnings: FactWarning[] } {
  const out: Fact[] = [];
  const warnings: FactWarning[] = [];
  for (const f of facts) {
    let subject: Fact["subject"] = { kind: "spot" };
    if (f.subject === "landside") {
      const name = f.subjectName?.trim() ? f.subjectName.trim() : null;
      if (name === null) {
        warnings.push({ code: "fact_without_subject", factId: f.factId });
        continue;
      }
      const key = normalizeName(name);
      const match = key === "" ? undefined : nearby.find((n) => n.keys.has(key));
      subject = { kind: "landside", id: match?.entry.id ?? null, name: match ? null : name };
    }
    out.push({
      id: factPublicId(f.factId),
      subject,
      text: f.statement,
      observedAt: f.observedAt.slice(0, 10),
      tone: f.tone,
      safety: f.safety,
      mentions: f.mentions,
    } as Fact);
  }
  out.sort((a, b) => (a.observedAt === b.observedAt ? byId(a.id, b.id) : (a.observedAt ?? "") < (b.observedAt ?? "") ? 1 : -1));
  return { facts: out, warnings };
}

/** The landing points: a mapped point with its kind (5 decimals), or a description; a point without position or a text without description is left out. */
export function mapLandingPoints(landing: BerthStateLanding[]): LandingPoint[] {
  const out: LandingPoint[] = [];
  for (const l of landing) {
    if (l.kind === "text") {
      if (l.description !== null && l.description.trim() !== "") out.push({ kind: "text", description: l.description });
    } else if (l.lat !== null && l.lon !== null) {
      out.push({ kind: l.kind, position: { lat: round5(l.lat), lon: round5(l.lon) } });
    }
  }
  return out;
}
