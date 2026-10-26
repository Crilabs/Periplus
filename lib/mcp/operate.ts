import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { budgetStatus, type BudgetStatus } from "@/lib/domain/costs";
import { retryJobWithTask } from "@/lib/domain/job-retry";
import { tileExists } from "@/lib/domain/geo-view";
import { getRun } from "@/lib/domain/runs";
import type { McpCaller } from "@/lib/domain/mcp-tokens";
import { estimateCost, measureScope, placeIdsOnTile, recordScopeSize, type ScopeSize, type StartKind, type StartScope } from "@/lib/domain/mcp/estimate";
import { syncConflictTasks } from "@/lib/domain/research/gate-conflicts";
import { loadGateInput } from "@/lib/domain/research/gate-report";
import { getBoss } from "@/lib/jobs/boss";
import { pauseQueue, resumeQueue } from "@/lib/jobs/controls";
import { QUEUES } from "@/lib/jobs/queues";
import { createLogger } from "@/lib/logger";
import { startDatasetImportRun } from "@/lib/pipeline/datasets-run";
import { startDeliveryRun } from "@/lib/pipeline/delivery-run";
import { startGazetteerRun } from "@/lib/pipeline/gazetteer/stages";
import { startGeometryRun } from "@/lib/pipeline/geometry-run";
import { startImageRun } from "@/lib/pipeline/images-run";
import { startResearchRun } from "@/lib/pipeline/research-run";
import { endRunByAdmin } from "@/lib/pipeline/runs";
import { startSeedRun } from "@/lib/pipeline/seed";
import { afterBuildRunEnded, startSubdivisionBuild } from "@/lib/pipeline/subdivision-build";
import { startSubdivisionsBuildRun } from "@/lib/pipeline/subdivisions-run";
import { runTool, ToolError, type LogFields } from "./result";
import { toolSubdivision } from "./subdivision";

/*
 * The control tools (end a run, retry a job, pause or resume a queue, sync the gate's conflict tasks) call what the admin
 * pages call, as `mcp:<email>`.
 *
 * The start tools of the MCP server (plan 2026-10-26-periplus-mcp-steuern, design section 1): each calls the starter
 * the admin page's action calls, with `triggeredBy = "mcp:<email>"`. Two steps: without `confirm: true` a tool writes
 * nothing and answers scope, estimate and today's budgets; the starter's own checks (gate, candidates, a run already
 * active) answer only on the confirmed call.
 */

const WRITE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;
const CONFIRM_NOTE = "Mit confirm: true starten.";

const subdivisionArg = z.string().min(1).max(20).describe("Landesteil-Schlüssel, z. B. GR-I");
const tileIdArg = z.string().regex(/^q025:\d+:\d+$/).describe("Kachel-ID, z. B. q025:84:140");
const confirmArg = z.boolean().optional().describe("Ohne: nur Umfang, Schätzung und Budgetstand, nichts wird gestartet. true: starten.");

type Started = { id: string } | { alreadyRunning: string };
type Estimate = { eur: number | null; text: string; basisLauf: string | null; dienste: Array<{ dienst: string; eur: number }> };
/** `rueckstand` only for images: all spots without a current title image, of which one run makes `umfang.count`. */
type Preview = { gestartet: false; umfang: ScopeSize; rueckstand?: number; schaetzung: Estimate; budgets: BudgetStatus[]; hinweis: string };
type StartAnswer =
  | Preview
  | { gestartet: true; runId: string; pfad: string; umfang: ScopeSize; schaetzung: Estimate; hinweis?: string }
  | { gestartet: false; laeuftSchon: string; pfad: string };

const runPath = (id: string) => `/runs/${id}`;

/** The run id an answer names, for the log line. */
const runIdOf = (answer: StartAnswer): LogFields => ({
  runId: "runId" in answer ? answer.runId : "laeuftSchon" in answer ? answer.laeuftSchon : null,
});

/**
 * The two steps of every start tool: the size of `scope` and the estimate; without `confirm` that and the budgets,
 * with `confirm` the run `start` begins (its size stored next to its params for later estimates).
 */
async function startTool(kind: StartKind, scope: StartScope, confirm: boolean | undefined, start: () => Promise<Started>): Promise<StartAnswer> {
  const db = getDb();
  const { size: umfang, backlog } = await measureScope(db, kind, scope);
  const estimate = await estimateCost(db, kind, umfang);
  const schaetzung: Estimate = {
    eur: estimate.eur,
    text: estimate.text,
    basisLauf: estimate.basis?.runId ?? null,
    dienste: estimate.services.map((s) => ({ dienst: s.service, eur: s.eur })),
  };
  if (confirm !== true) {
    return { gestartet: false, umfang, ...(backlog === null ? {} : { rueckstand: backlog }), schaetzung, budgets: await budgetStatus(db), hinweis: CONFIRM_NOTE };
  }

  const started = await start();
  if ("alreadyRunning" in started) return { gestartet: false, laeuftSchon: started.alreadyRunning, pfad: runPath(started.alreadyRunning) };
  try {
    await recordScopeSize(db, started.id, umfang);
  } catch (e) {
    // The run stands; only a later estimate misses its size.
    createLogger("mcp").error({ kind, runId: started.id, err: e instanceof Error ? e.name : "unknown" }, "mcp scope size not recorded");
    return { gestartet: true, runId: started.id, pfad: runPath(started.id), umfang, schaetzung, hinweis: "Lauf gestartet; sein Umfang wurde nicht gespeichert (Server-Log)." };
  }
  return { gestartet: true, runId: started.id, pfad: runPath(started.id), umfang, schaetzung };
}

async function requireTile(tileId: string): Promise<void> {
  if (!(await tileExists(getDb(), tileId))) throw new ToolError(`Kachel ${tileId} unbekannt`);
}

/** Exactly one of the given scope fields is set; its name. */
function oneScope<K extends string>(args: Partial<Record<K, unknown>>, fields: readonly K[]): K {
  const set = fields.filter((f) => args[f] !== undefined);
  if (set.length !== 1) throw new ToolError(`Genau eines von ${fields.map((f) => `\`${f}\``).join(", ")} angeben.`);
  return set[0]!;
}

/** `{ subdivision }` or `{ tileId }` as the starters' scope, checked to exist. */
async function tileOrSubdivision(args: { subdivision?: string; tileId?: string }): Promise<{ subdivisionKey: string } | { tileId: string }> {
  if (oneScope(args, ["subdivision", "tileId"] as const) === "tileId") {
    await requireTile(args.tileId!);
    return { tileId: args.tileId! };
  }
  await toolSubdivision(getDb(), args.subdivision!);
  return { subdivisionKey: args.subdivision! };
}

export function registerOperateTools(server: McpServer, caller: McpCaller): void {
  const by = `mcp:${caller.email}`;
  const boss = () => getBoss();
  const write = (tool: string, body: () => Promise<StartAnswer>) => runTool(tool, caller, body, runIdOf);

  /** A start tool that takes one subdivision. */
  const subdivisionTool = (name: string, title: string, description: string, kind: StartKind, start: (key: string) => Promise<Started>) =>
    server.registerTool(
      name,
      { title, description, inputSchema: { subdivision: subdivisionArg, confirm: confirmArg }, annotations: WRITE },
      (args) =>
        write(name, async () => {
          await toolSubdivision(getDb(), args.subdivision);
          return startTool(kind, { subdivisionKey: args.subdivision }, args.confirm, () => start(args.subdivision));
        }),
    );

  server.registerTool(
    "subdivisions_rebuild",
    {
      title: "Landesteile neu bilden",
      description: "Startet den Systemlauf „Landesteile neu bilden“ (grobes Ortsverzeichnis, Landesteile); gebaute Landesteile bleiben. Ohne `confirm` nur Umfang und Schätzung.",
      inputSchema: { confirm: confirmArg },
      annotations: WRITE,
    },
    (args) => write("subdivisions_rebuild", async () => startTool("subdivisions", {}, args.confirm, async () => startSubdivisionsBuildRun(getDb(), await boss(), by))),
  );

  subdivisionTool(
    "subdivision_build",
    "Landesteil aufbauen",
    "Startet den Aufbau eines Landesteils (Gazetteer, Datensätze, Seed, Orts-Websites, Geometrie, Dinge an Land, Revier-Import); läuft schon einer, nennt die Antwort ihn. Ohne `confirm` nur Umfang (Kacheln), Schätzung für den Lauf als Ganzes und Budgetstand.",
    "build",
    async (key) => startSubdivisionBuild(getDb(), await boss(), key, by),
  );
  subdivisionTool(
    "gazetteer_start",
    "Gazetteer aufbauen",
    "Startet „Gazetteer aufbauen“ für einen Landesteil. Ohne `confirm` nur Umfang (Kacheln) und Schätzung.",
    "gazetteer",
    async (key) => startGazetteerRun(getDb(), await boss(), key, by),
  );
  subdivisionTool(
    "datasets_start",
    "Datensätze laden",
    "Startet „Datensätze laden“ (Bathymetrie, Meeresboden, Sperrgebiete …) für einen Landesteil. Ohne `confirm` nur Umfang (Kacheln), Schätzung und Budgetstand.",
    "datasets",
    async (key) => startDatasetImportRun(getDb(), await boss(), key, by),
  );
  subdivisionTool(
    "images_start",
    "Titelbilder erzeugen",
    "Startet einen Bilderlauf für die Titelbilder eines Landesteils. Ohne `confirm` nur Umfang (Bilder dieses Laufs, höchstens images.pipeline.maxGenerationsPerRun), `rueckstand` (alle Plätze ohne aktuelles Bild), Schätzung und Budgetstand.",
    "images",
    async (key) => startImageRun(getDb(), await boss(), { subdivisionKey: key }, by),
  );
  subdivisionTool(
    "delivery_start",
    "Paket bauen",
    "Startet „Paket bauen“ (Lieferung) für einen Landesteil. Ohne `confirm` nur Umfang, Schätzung und Budgetstand.",
    "delivery",
    async (key) => startDeliveryRun(getDb(), await boss(), key, by),
  );

  server.registerTool(
    "seed_start",
    {
      title: "Seed",
      description: "Startet einen Seed-Lauf für einen Landesteil oder eine Kachel (genau eines von `subdivision`, `tileId`). Ohne `confirm` nur Umfang (Kacheln) und Schätzung.",
      inputSchema: { subdivision: subdivisionArg.optional(), tileId: tileIdArg.optional(), confirm: confirmArg },
      annotations: WRITE,
    },
    (args) =>
      write("seed_start", async () => {
        const scope = await tileOrSubdivision(args);
        return startTool("seed", scope, args.confirm, async () => startSeedRun(getDb(), await boss(), scope, by));
      }),
  );

  server.registerTool(
    "geometry_start",
    {
      title: "Geometrie",
      description: "Startet „Geometrie“ für einen Landesteil oder eine Kachel (genau eines von `subdivision`, `tileId`). Ohne `confirm` nur Umfang (Kacheln) und Schätzung.",
      inputSchema: { subdivision: subdivisionArg.optional(), tileId: tileIdArg.optional(), confirm: confirmArg },
      annotations: WRITE,
    },
    (args) =>
      write("geometry_start", async () => {
        const scope = await tileOrSubdivision(args);
        return startTool("geometry", scope, args.confirm, async () => startGeometryRun(getDb(), await boss(), scope, by));
      }),
  );

  server.registerTool(
    "research_start",
    {
      title: "Recherche starten",
      description:
        "Startet die Recherche (Suche, Abruf, Bewertung, Auszug, Bestätigung, Stand) für die Kandidaten eines Landesteils, für Plätze oder für die Plätze einer Kachel (genau eines von `subdivision`, `placeIds`, `tileId`; eine Kachel wird ein Plätze-Lauf). Kostet Geld: ohne `confirm` nur Umfang (Kandidaten), Schätzung und Budgetstand.",
      inputSchema: {
        subdivision: subdivisionArg.optional(),
        placeIds: z.array(z.uuid()).min(1).max(500).optional().describe("Platz-IDs (1–500)"),
        tileId: tileIdArg.optional(),
        confirm: confirmArg,
      },
      annotations: WRITE,
    },
    (args) =>
      write("research_start", async () => {
        const field = oneScope(args, ["subdivision", "placeIds", "tileId"] as const);
        let scope: { subdivisionKey: string } | { placeIds: string[] };
        if (field === "subdivision") {
          await toolSubdivision(getDb(), args.subdivision!);
          scope = { subdivisionKey: args.subdivision! };
        } else if (field === "tileId") {
          await requireTile(args.tileId!);
          const placeIds = await placeIdsOnTile(getDb(), args.tileId!);
          if (placeIds.length === 0) throw new ToolError("Kachel hat keine Plätze");
          scope = { placeIds };
        } else {
          scope = { placeIds: args.placeIds! };
        }
        return startTool("research", scope, args.confirm, async () => startResearchRun(getDb(), await boss(), scope, by));
      }),
  );

  const queueArg = z.enum(QUEUES).describe("Name der Queue, z. B. seed.tile");

  server.registerTool(
    "run_end",
    {
      title: "Lauf beenden",
      description: "Beendet einen wartenden oder laufenden Lauf von Hand und bricht seine noch nicht begonnenen Jobs ab (wie „Lauf beenden“ auf der Laufseite). Ein beendeter Aufbau gibt den Platz in der Warteschlange frei.",
      inputSchema: { runId: z.uuid().describe("Lauf-ID") },
      annotations: WRITE,
    },
    (args) =>
      runTool(
        "run_end",
        caller,
        async () => {
          const db = getDb();
          if (!(await getRun(db, args.runId))) throw new ToolError(`Lauf ${args.runId} unbekannt`);
          const b = await boss();
          const { ended, cleanedUp } = await endRunByAdmin(db, b, args.runId, by);
          if (ended) await afterBuildRunEnded(db, b, args.runId);
          return { beendet: ended, aufgeraeumt: cleanedUp };
        },
        () => ({ runId: args.runId }),
      ),
  );

  server.registerTool(
    "job_retry",
    {
      title: "Job erneut versuchen",
      description: "Versucht einen fehlgeschlagenen Job erneut; eine offene Aufgabe „Fehlgeschlagener Job“ dazu wird mit „erneut versuchen“ entschieden.",
      inputSchema: { queue: queueArg, jobId: z.uuid().describe("Job-ID") },
      annotations: WRITE,
    },
    (args) =>
      runTool("job_retry", caller, async () => {
        await retryJobWithTask(getDb(), await boss(), { queue: args.queue, jobId: args.jobId, decidedBy: by });
        return { erneutVersucht: true };
      }),
  );

  server.registerTool(
    "queue_pause",
    {
      title: "Queue anhalten",
      description: "Hält eine Queue an, bis sie wieder freigegeben wird; laufende Jobs enden normal, neue beginnen nicht.",
      inputSchema: { queue: queueArg },
      annotations: WRITE,
    },
    (args) =>
      runTool("queue_pause", caller, async () => {
        await pauseQueue(getDb(), args.queue, null, "manual", by);
        return { queue: args.queue, angehalten: true };
      }),
  );

  server.registerTool(
    "queue_resume",
    {
      title: "Queue freigeben",
      description: "Hebt die Pause einer Queue auf (auch eine Budget-Pause).",
      inputSchema: { queue: queueArg },
      annotations: WRITE,
    },
    (args) =>
      runTool("queue_resume", caller, async () => {
        await resumeQueue(getDb(), args.queue, by);
        return { queue: args.queue, angehalten: false };
      }),
  );

  server.registerTool(
    "gate_sync_conflicts",
    {
      title: "Konfliktaufgaben abgleichen",
      description:
        "Gleicht die Aufgaben „Recherche-Konflikt“ eines Landesteils mit den Plätzen ab, die die Referenz nicht kennt: je Platz höchstens eine offene Aufgabe, keine neue für einen schon entschiedenen Platz, offene Aufgaben von Plätzen, die kein Konflikt mehr sind, werden verworfen. `placeIds` ist die vollständige Konfliktliste des Landesteils bei dieser Schwelle, kein Nachtrag: nie aufteilen, jede offene Aufgabe eines Platzes außerhalb der Liste wird verworfen. `threshold` ist die Bestätigungsschwelle der Messung (aus der Config), `placeIds` müssen Plätze des Landesteils sein.",
      inputSchema: {
        subdivision: subdivisionArg,
        threshold: z.number().int().describe("Bestätigungsschwelle der Messung, einer der Werte research.gate.thresholds"),
        placeIds: z.array(z.uuid()).max(5000).describe("Vollständige Konfliktliste: alle Plätze des Landesteils, die die Referenz bei dieser Schwelle nicht kennt (0–5000), in einem Aufruf"),
      },
      annotations: WRITE,
    },
    (args) =>
      runTool(
        "gate_sync_conflicts",
        caller,
        async () => {
          await toolSubdivision(getDb(), args.subdivision);
          const cfg = getConfig();
          if (!cfg.research.gate.thresholds.includes(args.threshold)) {
            throw new ToolError(`Schwelle ${args.threshold} unzulässig; erlaubt: ${cfg.research.gate.thresholds.join(", ")}`);
          }
          const scopePlaceIds = (await loadGateInput(getDb(), args.subdivision, cfg)).places.map((p) => p.placeId);
          const own = new Set(scopePlaceIds);
          const foreign = new Set(args.placeIds.filter((id) => !own.has(id))).size;
          if (foreign > 0) throw new ToolError(`${foreign} Platz-IDs gehören nicht zu ${args.subdivision}`);
          const { created, open } = await syncConflictTasks(getDb(), args.placeIds, args.threshold, scopePlaceIds);
          return { angelegt: created, offen: open };
        },
        (r) => ({ taskCount: r.angelegt }),
      ),
  );
}
