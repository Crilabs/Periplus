import { z } from "zod";
import type { AttributeDef, FactSchema } from "@/lib/domain/facts/schema-types";
import { factSchemaV2, textOnly } from "./v2";

/*
 * Fact schema v3 (specs 15 B and 17): v2 plus, on level `place`, `berthable` (can a charter crew on passage moor here)
 * and `place.kind_evidence` (the place kind the source states), and sharper descriptions of `services.fuel` and
 * `services.water` (a petrol station or a village fountain does not count). Every other definition is v2's, unchanged;
 * the other levels are v2's objects. A changed description is a new version because the prompt lists it and extraction
 * runs are tied to the schema version.
 */

const fuelWater: Record<string, string> = {
  "services.fuel":
    "Whether the place itself offers refuelling (diesel) for boats: a fuel dock or a tanker truck at the quay. A petrol station in town does not count.",
  "services.water":
    "Whether fresh water can be taken on at the berth or quay of the place (tap, hose, water connection). A fountain or tap in the village does not count.",
};

const place: AttributeDef[] = [
  ...factSchemaV2.levels.place.map((def): AttributeDef => (def.key in fuelWater ? { ...def, description: fuelWater[def.key] } : def)),
  textOnly(
    "berthable",
    z.boolean(),
    "latest_observation",
    "Whether a charter crew on passage can moor here for a short stay: anchor, take a visitor berth or moor stern-to at the quay, or pick up a free buoy. False if the buoys are private or only rented long-term, if the marina takes no visiting boats, or if the harbour is commercial only.",
  ),
  textOnly(
    "place.kind_evidence",
    z.enum(["anchorage", "port", "marina", "mooring_field"]),
    "latest_observation",
    "What kind of place this is: marina = leisure harbour where pleasure boats berth, including a town quay where yachts moor stern-to; anchorage = place to anchor; mooring_field = buoys a visiting boat can pick up; port = commercial or industrial harbour (ferries, cargo, fishing, shipyard) without berths for pleasure boats",
  ),
];

export const factSchemaV3: FactSchema = {
  version: "v3",
  levels: { ...factSchemaV2.levels, place },
};
