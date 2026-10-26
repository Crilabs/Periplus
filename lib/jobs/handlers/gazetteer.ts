import { getGeonamesSource } from "@/lib/adapters/geonames";
import { getTransport } from "@/lib/adapters/http";
import { getArchive } from "@/lib/adapters/s3";
import { gazetteerScope } from "@/lib/domain/gazetteer/scope";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { GEONAMES_STAGE, importGeonames } from "@/lib/pipeline/gazetteer/geonames";
import { buildHierarchy, HIERARCHY_STAGE } from "@/lib/pipeline/gazetteer/hierarchy";
import { importLandThings, LAND_STAGE } from "@/lib/pipeline/gazetteer/land";
import { importOsm, OSM_STAGE } from "@/lib/pipeline/gazetteer/osm";
import { importWikidata, WIKIDATA_STAGE } from "@/lib/pipeline/gazetteer/wikidata";
import type { StageDefinition } from "@/lib/pipeline/runs";

/** `subdivisionKey` of run params or job data; throws when missing. */
function subdivisionKeyOf(params: Record<string, unknown>): string {
  if (typeof params.subdivisionKey !== "string" || params.subdivisionKey === "") throw new Error("subdivisionKey is required");
  return params.subdivisionKey;
}

/** `placeIds` of run params or job data: undefined when absent, else a list of strings (throws otherwise). */
function placeIdsOf(params: Record<string, unknown>): string[] | undefined {
  if (params.placeIds === undefined) return undefined;
  if (!Array.isArray(params.placeIds) || !params.placeIds.every((id) => typeof id === "string")) throw new Error("placeIds must be strings");
  return params.placeIds as string[];
}

/** A gazetteer stage on the `gazetteer.build` queue: one job per run for `run.params.subdivisionKey`. */
function gazetteerStage(name: string): StageDefinition {
  return {
    name,
    queue: "gazetteer.build",
    async plan(db, run) {
      const subdivisionKey = subdivisionKeyOf(run.params);
      await gazetteerScope(db, subdivisionKey); // fail planning for an unknown subdivision
      return [{ key: subdivisionKey, subdivisionKey }];
    },
  };
}

export const gazetteerOsmStage = gazetteerStage(OSM_STAGE);
export const gazetteerWikidataStage = gazetteerStage(WIKIDATA_STAGE);
export const gazetteerGeonamesStage = gazetteerStage(GEONAMES_STAGE);
export const gazetteerHierarchyStage = gazetteerStage(HIERARCHY_STAGE);

/** Stage `gazetteer.land`: one job for the subdivision, carrying the run's `placeIds` when it was started for single candidates. */
export const gazetteerLandStage: StageDefinition = {
  name: LAND_STAGE,
  queue: "gazetteer.build",
  async plan(db, run) {
    const subdivisionKey = subdivisionKeyOf(run.params);
    await gazetteerScope(db, subdivisionKey); // fail planning for an unknown subdivision
    const placeIds = placeIdsOf(run.params);
    return [{ key: subdivisionKey, subdivisionKey, ...(placeIds ? { placeIds } : {}) }];
  },
};

/** Runs the gazetteer stage named in `data.stage` for the subdivision `data.subdivisionKey`. */
export const gazetteerHandler: JobHandler<JobData> = async (data, ctx) => {
  const scope = await gazetteerScope(ctx.db, subdivisionKeyOf(data));
  if (!data.runId) throw new Error(`${data.stage ?? "gazetteer job"} without runId`);
  switch (data.stage) {
    case OSM_STAGE: {
      const result = await importOsm(
        ctx.db,
        { scope, runId: data.runId },
        { transport: getTransport(), archive: getArchive() },
      );
      ctx.log.info({ subdivisionKey: scope.key, ...result }, "osm imported");
      return;
    }
    case WIKIDATA_STAGE: {
      const result = await importWikidata(ctx.db, { scope, runId: data.runId }, { transport: getTransport() });
      ctx.log.info({ subdivisionKey: scope.key, ...result }, "wikidata imported");
      return;
    }
    case GEONAMES_STAGE: {
      const source = getGeonamesSource({ db: ctx.db, runId: data.runId, stage: GEONAMES_STAGE });
      const result = await importGeonames(ctx.db, { scope, runId: data.runId }, { source });
      ctx.log.info({ subdivisionKey: scope.key, ...result }, "geonames imported");
      return;
    }
    case LAND_STAGE: {
      const placeIds = placeIdsOf(data);
      const result = await importLandThings(
        ctx.db,
        { scope, runId: data.runId, ...(placeIds ? { placeIds } : {}) },
        { transport: getTransport(), archive: getArchive() },
      );
      ctx.log.info({ subdivisionKey: scope.key, ...result }, "land things imported");
      return;
    }
    case HIERARCHY_STAGE: {
      const result = await buildHierarchy(ctx.db, scope);
      ctx.log.info({ subdivisionKey: scope.key, ...result }, "hierarchy built");
      return;
    }
    default:
      throw new Error(`unknown gazetteer stage ${data.stage}`);
  }
};
