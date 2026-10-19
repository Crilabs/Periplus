"use server";

import { startGeometryAction, startSeedAction } from "../../runs/actions";
import { discoveryTileAction } from "../../sources/actions";

const tileIdOf = (input: FormData | { tileId: string }): string => {
  const tileId = input instanceof FormData ? input.get("tileId") : input.tileId;
  return typeof tileId === "string" ? tileId : "";
};

/** "Seed" button of the tile page: a seed run for this tile only. */
export async function seedTileAction(input: FormData | { tileId: string }): Promise<void> {
  await startSeedAction({ tileId: tileIdOf(input) });
}

/** "Geometrie" button of the tile page: a geometry run for this tile only. */
export async function geometryTileAction(input: FormData | { tileId: string }): Promise<void> {
  await startGeometryAction({ tileId: tileIdOf(input) });
}

/** "Quellenfindung" button of the tile page: a discovery run for this tile only. */
export async function discoveryForTileAction(input: FormData | { tileId: string }): Promise<void> {
  await discoveryTileAction({ tileId: tileIdOf(input) });
}
