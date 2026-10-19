import { z } from "zod";
import { textDe } from "./common";

/** One entry of `changes.json` (Teil B "Versionierung und Change-Feed"). */
export const changeEntrySchema = z.strictObject({
  objectType: z.enum(["spot", "highlight", "region"]),
  objectId: z.string().regex(/^(sp|hl|rg)_[0-9A-HJKMNP-TV-Z]{26}$/),
  event: z.enum(["created", "updated", "excluded", "merged", "removed"]),
  /** Changed contract fields (for `updated`). */
  fields: z.array(z.string().min(1)),
  severity: z.enum(["info", "notable", "safety"]),
  summary: textDe,
  /** The new version. */
  profileVersion: z.number().int().min(1),
});

export type ChangeEntry = z.infer<typeof changeEntrySchema>;
