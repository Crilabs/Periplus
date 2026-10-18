import { z } from "zod";
import type { ModelTask } from "../types";

export const echoTask: ModelTask<{ text: string }, { echo: string; language: string }> = {
  name: "system.echo",
  output: z.object({ echo: z.string(), language: z.string() }),
  variables: (input) => ({ text: input.text }),
};
