import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { HANDLERS } from "@/lib/jobs/registry";
import { QUEUES } from "@/lib/jobs/queues";
import { STAGES } from "@/lib/jobs/stages";

/* Worker start: no queue without a handler, no handler or stage on a queue the worker does not create (N6). */

describe("job registries", () => {
  it("every queue in QUEUES has a handler and every handler belongs to a queue in QUEUES", () => {
    expect([...Object.keys(HANDLERS)].sort()).toEqual([...QUEUES].sort());
    for (const name of QUEUES) expect(HANDLERS[name], name).toBeTypeOf("function");
  });

  it("config/queues.json has an entry for exactly the queues in QUEUES", () => {
    expect(Object.keys(loadConfig("config").queues).sort()).toEqual([...QUEUES].sort());
  });

  it("every stage runs on a queue in QUEUES, under its own name", () => {
    for (const [name, stage] of Object.entries(STAGES)) {
      expect(stage.name).toBe(name);
      expect(QUEUES as readonly string[], name).toContain(stage.queue);
    }
  });

  it("no removed stage of the old source-driven pipeline is registered", () => {
    const removed = ["mentions.", "discovery.", "extraction.", "consolidation.", "fetch.source", "fetch.url", "embed.chunks", "sources.wikivoyage", "compare.converters", "classify.document_version", "revisit.freeze", "places.website.freeze"];
    for (const name of [...QUEUES, ...Object.keys(STAGES)]) expect(removed.some((r) => name.startsWith(r)), name).toBe(false);
  });
});
