"use server";

import { startSeedAction } from "../../runs/actions";

/** "Seed" button of the tile page: a seed run for this tile only. */
export async function seedTileAction(input: FormData | { tileId: string }): Promise<void> {
  const tileId = input instanceof FormData ? input.get("tileId") : input.tileId;
  await startSeedAction({ tileId: typeof tileId === "string" ? tileId : "" });
}
