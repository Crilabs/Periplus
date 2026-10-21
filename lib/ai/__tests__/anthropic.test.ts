import { describe, expect, it } from "vitest";
import { buildParams } from "@/lib/ai/anthropic";
import { checkPlaceImageTask } from "@/lib/ai/tasks/check-place-image";

const taskConfig = { model: "claude-haiku-5-5", promptVersion: 1, effort: "low" as const, maxTokens: 512, cacheSystem: false };

describe("attachment mapping", () => {
  it("image attachment is sent as an image block", () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const params = buildParams(checkPlaceImageTask, { image: png }, taskConfig, "claude-haiku-5-5");
    const content = params.messages[0]!.content as unknown as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(png).toString("base64") },
    });
    expect(content[1]).toMatchObject({ type: "text" });
  });
});
