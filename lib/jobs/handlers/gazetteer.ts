import { getGeonamesSource } from "@/lib/adapters/geonames";
import { getTransport } from "@/lib/adapters/http";
import { getArchive } from "@/lib/adapters/s3";
import { areaByKey } from "@/lib/config";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { GEONAMES_STAGE, importGeonames } from "@/lib/pipeline/gazetteer/geonames";
import { importOsm, OSM_STAGE } from "@/lib/pipeline/gazetteer/osm";
import { importWikidata, WIKIDATA_STAGE } from "@/lib/pipeline/gazetteer/wikidata";
import type { StageDefinition } from "@/lib/pipeline/runs";
import { areaKeyOf } from "./tiles";

/** A gazetteer stage on the `gazetteer.build` queue: one job per run for `run.params.areaKey`. */
function gazetteerStage(name: string): StageDefinition {
  return {
    name,
    queue: "gazetteer.build",
    async plan(_db, run) {
      const areaKey = areaKeyOf(run.params);
      areaByKey(areaKey); // fail planning for an unknown area
      return [{ key: areaKey, areaKey }];
    },
  };
}

export const gazetteerOsmStage = gazetteerStage(OSM_STAGE);
export const gazetteerWikidataStage = gazetteerStage(WIKIDATA_STAGE);
export const gazetteerGeonamesStage = gazetteerStage(GEONAMES_STAGE);

/** Runs the gazetteer stage named in `data.stage` for `data.areaKey`. */
export const gazetteerHandler: JobHandler<JobData> = async (data, ctx) => {
  const area = areaByKey(areaKeyOf(data));
  if (!data.runId) throw new Error(`${data.stage ?? "gazetteer job"} without runId`);
  switch (data.stage) {
    case OSM_STAGE: {
      const result = await importOsm(
        ctx.db,
        { area, runId: data.runId },
        { transport: getTransport(), archive: getArchive() },
      );
      ctx.log.info({ areaKey: area.key, ...result }, "osm imported");
      return;
    }
    case WIKIDATA_STAGE: {
      const result = await importWikidata(ctx.db, { area, runId: data.runId }, { transport: getTransport() });
      ctx.log.info({ areaKey: area.key, ...result }, "wikidata imported");
      return;
    }
    case GEONAMES_STAGE: {
      const source = getGeonamesSource({ db: ctx.db, runId: data.runId, stage: GEONAMES_STAGE });
      const result = await importGeonames(ctx.db, { area, runId: data.runId }, { source });
      ctx.log.info({ areaKey: area.key, ...result }, "geonames imported");
      return;
    }
    default:
      throw new Error(`unknown gazetteer stage ${data.stage}`);
  }
};
