import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { structuredOutputSchema } from "../../../lib/ai/anthropic";
import { normalizeName } from "../../../lib/domain/gazetteer/names";
import type { Area } from "./areas";
import type { CostLedger } from "./costs";
import type { GazObject } from "./gazetteer";
import type { Located } from "./locate";
import { searchCostEur } from "./search-claude";
import type { Hit } from "./search-dataforseo";
import { readJson, readJsonl } from "./store";

/*
 * Spec 5D step 4 (allowed by Christian, 28.10.): for a mention neither a coordinate nor a name resolved, the model
 * picks one of the area's gazetteer objects or none. Kept as its own method so its share and error rate stay visible.
 */

const MODEL = "claude-sonnet-5-5";
const MAX_CANDIDATES = 300;

const answer = z.object({ gazetteer_id: z.string().nullable() });

const SYSTEM = [
  "You match a berth mentioned on a web page to one object of a gazetteer. You get the mention (name, other spellings,",
  "the area the page names, a quoted position description) and a numbered list of gazetteer objects of that area with",
  "their names and types. Answer with the id of the one object that is this berth, or null when none fits or several",
  "could. Choose only by name, spelling variants and the stated position; do not invent a match.",
].join(" ");

function contains(a: string, b: string): boolean {
  const x = normalizeName(a);
  const y = normalizeName(b);
  return x !== "" && y !== "" && (` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `));
}

/** Objects on the island(s) the mention or its search areas name; mainland objects for a coast area. */
function candidatesFor(l: Located, areaNames: string[], gaz: GazObject[], areas: Area[]): GazObject[] {
  const wanted = [l.area, ...areaNames].filter((a): a is string => !!a);
  const islands = gaz.filter((g) => (g.type === "island" || g.type === "islet") && wanted.some((w) => g.names.some((n) => contains(n, w))));
  if (islands.length > 0) {
    const names = new Set(islands.map((i) => i.islandName ?? i.names[0]!));
    return gaz.filter((g) => g.islandName !== null && names.has(g.islandName));
  }
  const coast = areas.filter((a) => wanted.some((w) => contains(a.names.en, w) || (a.names.de && contains(a.names.de, w)) || (a.names.el && contains(a.names.el, w))));
  if (coast.length > 0) return gaz.filter((g) => g.islandName === null && g.type !== "island" && g.type !== "islet");
  return [];
}

export async function locateByModel(ledger: CostLedger, dir: string, located: Located[], gaz: GazObject[]): Promise<Located[]> {
  const client = new Anthropic();
  const schema = structuredOutputSchema(z.toJSONSchema(answer)) as Record<string, unknown>;
  const areas = (await readJson<Area[]>(dir, "areas.json")) ?? [];
  const areaByKey = new Map(areas.map((a) => [a.key, a]));
  const urlAreas = new Map<string, Set<string>>();
  for (const h of await readJsonl<Hit>(dir, "hits.jsonl")) {
    const a = areaByKey.get(h.area);
    if (!a) continue;
    if (!urlAreas.has(h.url)) urlAreas.set(h.url, new Set());
    urlAreas.get(h.url)!.add(a.names.en);
  }
  const byId = new Map(gaz.map((g) => [g.id, g]));
  const out: Located[] = [];
  let n = 0;
  for (const l of located) {
    if (l.method !== null || l.reason === "no_name") {
      out.push(l);
      continue;
    }
    const candidates = candidatesFor(l, [...(urlAreas.get(l.url) ?? [])], gaz, areas);
    if (candidates.length === 0 || candidates.length > MAX_CANDIDATES) {
      out.push({ ...l, reason: candidates.length === 0 ? `${l.reason}+no_area` : `${l.reason}+too_many_candidates` });
      continue;
    }
    ledger.assertRoom(0.01);
    const list = candidates.map((c) => `${c.id} | ${c.type}${c.category ? `/${c.category}` : ""} | ${c.names.join(" / ")}${c.islandName ? ` | ${c.islandName}` : ""}`).join("\n");
    const user = `Mention: ${l.name}${l.aliases.length ? ` (also: ${l.aliases.join(", ")})` : ""}\nArea named on the page: ${l.area ?? "-"}\nSearch area: ${[...(urlAreas.get(l.url) ?? [])].join(", ") || "-"}\nKind: ${l.kind}\nPosition: ${l.positionQuote ?? "-"}\nBerth quote: ${l.berthQuote}\n\nGazetteer objects (id | type | names | island):\n${list}`;
    const message = await client.messages.create({ model: MODEL, max_tokens: 400, system: SYSTEM, messages: [{ role: "user", content: user }], output_config: { effort: "low", format: { type: "json_schema", schema } } });
    const costEur = searchCostEur(message.usage);
    await ledger.add({ stage: "locate-model", service: "anthropic", units: 1, costEur });
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let id: string | null = null;
    try {
      id = answer.parse(JSON.parse(text)).gazetteer_id;
    } catch {
      id = null;
    }
    const g = id ? byId.get(id) : undefined;
    n++;
    if (g && candidates.includes(g)) out.push({ ...l, method: "model", lon: g.lon, lat: g.lat, reason: null, gazId: g.id });
    else out.push({ ...l, reason: `${l.reason}+model_none` });
    if (n % 25 === 0) process.stdout.write(`model locate ${n} calls, ${ledger.totalEur.toFixed(3)} EUR\n`);
  }
  return out;
}
