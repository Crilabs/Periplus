import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { fixtureKey, fixtureTransport } from "@/lib/adapters/http-fixtures";
import { createOpenAiImageModel, ImageOutputInvalid, MULTIPART_BOUNDARY, OPENAI_IMAGE_EDITS_URL } from "@/lib/adapters/openai-image";
import { getConfig } from "@/lib/config";
import { BudgetExceeded, recordExternalCall } from "@/lib/domain/costs";
import { MockImageModel } from "@/lib/ai/mock-image";
import { withRollback } from "@/test/db";

vi.mock("@/lib/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/env")>();
  return { ...original, getEnv: () => ({ ...original.getEnv(), OPENAI_API_KEY: "test-openai-key" }) };
});

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: "#3a7ca5" } }).png().toBuffer();

const SUBJECT = { geoObjectId: "0199c2a0-0000-7000-8000-000000000001", slot: "title" };
const request = async () => ({ task: "generate-place-image" as const, image: new Uint8Array(await png(64, 48)), prompt: "Make it real.", subject: SUBJECT });

/** Answers `{ data: [{ b64_json }] }` with `png` and keeps the requests. */
function stub(body: unknown): Transport & { requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest) => {
    requests.push(req);
    return makeResponse(200, new TextEncoder().encode(JSON.stringify(body)), { headers: { "content-type": "application/json" } });
  };
  return Object.assign(transport, { requests });
}
const answer = (image: Buffer) => ({ data: [{ b64_json: image.toString("base64") }] });

describe("createOpenAiImageModel", () => {
  it("adapter posts multipart with fixed boundary and decodes b64_json", async () => {
    const output = await png(1536, 1024);
    const req = await request();
    // Record the request once with a stub, then replay a hand-built fixture (no paid call: ruling R5) of that exact request.
    const probe = stub(answer(output));
    await withRollback((tx) => createOpenAiImageModel(probe).edit(req, { db: tx }));
    const sent = probe.requests[0]!;
    const dir = mkdtempSync(join(tmpdir(), "openai-fixtures-"));
    mkdirSync(join(dir, "openai"));
    writeFileSync(
      join(dir, "openai", `${fixtureKey(sent)}.json`),
      JSON.stringify({ request: { method: "POST", url: OPENAI_IMAGE_EDITS_URL, body: null }, status: 200, bodyBase64: Buffer.from(JSON.stringify(answer(output))).toString("base64") }),
    );

    await withRollback(async (tx) => {
      const result = await createOpenAiImageModel(fixtureTransport(dir)).edit(req, { db: tx });
      expect(Buffer.from(result.image).equals(output)).toBe(true);
      expect(result).toMatchObject({ model: "gpt-image-2.5-sunburst", promptVersion: 1, costEur: 0.25 });
    });

    expect(sent).toMatchObject({ url: OPENAI_IMAGE_EDITS_URL, method: "POST", service: "openai", budget: "openai" });
    // the place and slot go into external_calls.meta: the cost per Landesteil sums by them
    expect(sent.meta).toEqual({ model: "gpt-image-2.5-sunburst", quality: "high", task: "generate-place-image", ...SUBJECT });
    expect(sent.headers).toMatchObject({
      Authorization: "Bearer test-openai-key",
      "Content-Type": `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
    });
    expect(sent.timeoutMs).toBeGreaterThanOrEqual(300_000);
    const body = Buffer.from(sent.body as Uint8Array).toString("latin1");
    for (const [name, value] of [["model", "gpt-image-2.5-sunburst"], ["prompt", "Make it real."], ["size", "1536x1024"], ["quality", "high"], ["n", "1"]]) {
      expect(body).toContain(`name="${name}"\r\n\r\n${value}\r\n`);
    }
    expect(body).toContain('name="image"; filename="render.png"\r\nContent-Type: image/png\r\n\r\n');
    expect(body.startsWith(`--${MULTIPART_BOUNDARY}\r\n`)).toBe(true);
    expect(body.endsWith(`\r\n--${MULTIPART_BOUNDARY}--\r\n`)).toBe(true);
    expect(Buffer.from(sent.body as Uint8Array).includes(Buffer.from(req.image))).toBe(true);
  });

  it("wrong output size throws ImageOutputInvalid", async () => {
    const req = await request();
    await withRollback(async (tx) => {
      const model = createOpenAiImageModel(stub(answer(await png(1024, 1024))));
      await expect(model.edit(req, { db: tx })).rejects.toBeInstanceOf(ImageOutputInvalid);
      await expect(createOpenAiImageModel(stub({ data: [{}] })).edit(req, { db: tx })).rejects.toBeInstanceOf(ImageOutputInvalid);
    });
  });

  it("budget exceeded stops before the request", async () => {
    const transport = stub(answer(await png(1536, 1024)));
    const req = await request();
    await withRollback(async (tx) => {
      await recordExternalCall(tx, { service: "openai", operation: "seed", units: 1, unit: "image", costEur: 10_000 });
      await expect(createOpenAiImageModel(transport).edit(req, { db: tx })).rejects.toBeInstanceOf(BudgetExceeded);
    });
    expect(transport.requests).toHaveLength(0);
  });
});

describe("MockImageModel", () => {
  it("answers, records the calls and throws an Error answer", async () => {
    const req = await request();
    const ok = new MockImageModel(() => req.image);
    expect(await ok.edit(req)).toMatchObject({ image: req.image, model: getConfig().models.imageTasks["generate-place-image"]!.model, costEur: 0 });
    expect(ok.calls).toEqual([req]);
    await expect(new MockImageModel(() => new Error("boom")).edit(req)).rejects.toThrow("boom");
  });
});
