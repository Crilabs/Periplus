import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { budgetStatus, type BudgetStatus } from "@/lib/domain/costs";
import { tileExists } from "@/lib/domain/geo-view";
import type { McpCaller } from "@/lib/domain/mcp-tokens";
import { estimateCost, placeIdsOnTile, recordScopeSize, scopeSize, type ScopeSize, type StartKind, type StartScope } from "@/lib/domain/mcp/estimate";
import { subdivisionByKey } from "@/lib/domain/subdivisions/store";
import { getBoss } from "@/lib/jobs/boss";
import { createLogger } from "@/lib/logger";
import { startDatasetImportRun } from "@/lib/pipeline/datasets-run";
import { startDeliveryRun } from "@/lib/pipeline/delivery-run";
import { startGazetteerRun } from "@/lib/pipeline/gazetteer/stages";
import { startGeometryRun } from "@/lib/pipeline/geometry-run";
import { startImageRun } from "@/lib/pipeline/images-run";
import { startResearchRun } from "@/lib/pipeline/research-run";
import { startSeedRun } from "@/lib/pipeline/seed";
import { startSubdivisionBuild } from "@/lib/pipeline/subdivision-build";
import { startSubdivisionsBuildRun } from "@/lib/pipeline/subdivisions-run";
import { runTool, ToolError, type LogFields } from "./result";

/*
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
type Estimate = { eur: number | null; text: string; basisLauf: string | null };
type Preview = { gestartet: false; umfang: ScopeSize; schaetzung: Estimate; budgets: BudgetStatus[]; hinweis: string };
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
  const umfang = await scopeSize(db, kind, scope);
  const estimate = await estimateCost(db, kind, umfang);
  const schaetzung: Estimate = { eur: estimate.eur, text: estimate.text, basisLauf: estimate.basis?.runId ?? null };
  if (confirm !== true) return { gestartet: false, umfang, schaetzung, budgets: await budgetStatus(db), hinweis: CONFIRM_NOTE };

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

/** Fails with a German tool error for an unknown or excluded subdivision, before the size would throw a raw error. */
async function requireStartableSubdivision(key: string): Promise<void> {
  const sub = await subdivisionByKey(getDb(), key);
  if (!sub) throw new ToolError(`Landesteil ${key} unbekannt`);
  if (sub.status === "excluded") throw new ToolError(`Landesteil ${key} ist ausgeschlossen`);
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
  await requireStartableSubdivision(args.subdivision!);
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
          await requireStartableSubdivision(args.subdivision);
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
    "Startet den Aufbau eines Landesteils (Gazetteer, Datensätze, Seed, Orts-Websites, Geometrie); läuft schon einer, nennt die Antwort ihn. Ohne `confirm` nur Umfang (Kacheln), Schätzung für den Lauf als Ganzes und Budgetstand.",
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
    "Startet einen Bilderlauf für die Titelbilder eines Landesteils. Ohne `confirm` nur Umfang (Plätze ohne aktuelles Bild), Schätzung und Budgetstand.",
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
          await requireStartableSubdivision(args.subdivision!);
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
}
