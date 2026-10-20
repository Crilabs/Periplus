import type { ImageEditRequest, ImageEditResult, ImageModel } from "@/lib/adapters/openai-image";
import { getConfig } from "@/lib/config";

/** Test double of the image model: answers with `respond(req)` (a thrown-in `Error` is thrown) and keeps the calls. */
export class MockImageModel implements ImageModel {
  readonly calls: ImageEditRequest[] = [];

  constructor(private readonly respond: (req: ImageEditRequest) => Uint8Array | Error) {}

  async edit(req: ImageEditRequest): Promise<ImageEditResult> {
    this.calls.push(req);
    const answer = this.respond(req);
    if (answer instanceof Error) throw answer;
    const task = getConfig().models.imageTasks[req.task]!;
    return { image: answer, model: task.model, promptVersion: task.promptVersion, costEur: 0 };
  }
}
