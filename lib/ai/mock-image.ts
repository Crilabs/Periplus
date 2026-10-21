import type { ImageEditRequest, ImageEditResult, ImageModel } from "@/lib/adapters/openai-image";
import { getConfig } from "@/lib/config";

/**
 * Test double of the image model: answers with `respond(req)` (a thrown-in `Error` is thrown) and keeps the calls.
 * `available` (default true) is what `available()` answers: false stands for a worker without `OPENAI_API_KEY`.
 */
export class MockImageModel implements ImageModel {
  readonly calls: ImageEditRequest[] = [];

  constructor(
    private readonly respond: (req: ImageEditRequest) => Uint8Array | Error,
    private readonly options: { available?: boolean } = {},
  ) {}

  available(): boolean {
    return this.options.available ?? true;
  }

  async edit(req: ImageEditRequest): Promise<ImageEditResult> {
    this.calls.push(req);
    const answer = this.respond(req);
    if (answer instanceof Error) throw answer;
    const task = getConfig().models.imageTasks[req.task]!;
    return { image: answer, model: task.model, promptVersion: task.promptVersion, costEur: 0 };
  }
}
