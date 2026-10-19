import { sql } from "drizzle-orm";
import { getConfig, getConsolidationConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { facts, reviewDecisions, reviewTasks } from "@/lib/db/schema";
import type { ProhibitionRemoval } from "@/lib/domain/consolidation/rules/prohibitions";
import type { UnionRemoval } from "@/lib/domain/consolidation/rules/union";
import { InvalidFactValue, UnknownAttribute, validateFactValue } from "@/lib/domain/facts/schema";
import { isRemovableEntry, profileEntryKey } from "@/lib/domain/profile-view";
import { DecisionNotAllowed } from "@/lib/domain/review-decisions";
import { latestProfile } from "@/lib/domain/timeline";

/*
 * „Eintrag entfernen“ on a safety list of the profile (hazards, restricted_zones; the text kinds of prohibitions): an
 * admin correction, written as a review fact on an immediately decided task (the pattern of `setAnchorPosition`).
 * The union lists take the removal decision `{ remove: <entry> }` (`UnionRemoval`, ruling M5-C-R3); `prohibitions`
 * takes `{ remove: { kind } }` (`ProhibitionRemoval`, ruling M5-FIN-R1 I-1: one kind, never a remaining list, so
 * removals compose without reading each other and texts are never superseded; computed restricted-area entries stay).
 * Each removal fact stands alone, so concurrent removals on one object need no serialization (final review M-5).
 * Never consolidates and never takes the profile lock (ruling M5-F-R4): the caller starts the follow-up run after the
 * commit.
 */

/** The profile has a newer version than the one the admin saw: nothing is written. */
export class ProfileChanged extends Error {
  constructor(geoObjectId: string) {
    super(`profile of ${geoObjectId} changed since it was shown`);
    this.name = "ProfileChanged";
  }
}

/**
 * Kind and subject type of the decided task a removal writes (consolidation reads only tasks with a `context.key`).
 * NOTE for readers of `review_tasks` (check scripts, M7 quality metrics, decision-history lists): count decided
 * `uncertain_change` tasks only with `subject_type = 'profile_attribute'`; this pseudo-task (`profile_entry`, no
 * `duration_ms`) is no uncertain-change decision.
 */
export const ENTRY_REMOVAL_TASK = { kind: "uncertain_change", subjectType: "profile_entry" } as const;

/**
 * Removes the entry `entryKey` (`profileEntryKey`) of `attribute` from the profile of the geo object, as shown in
 * version `version`. In one transaction: an immediately decided task (`ENTRY_REMOVAL_TASK`, subject
 * `<geoObjectId>:<attribute>`, context `{ attribute, entryKey, entry, version }`, no `key`), one `review_decisions` row
 * `{ action: "remove_entry", attribute, entry }` and the review fact (confidence `confidence.review`, observed on `now`'s
 * date, the active fact schema version; as `applyProfileDecision`). `ProfileChanged` when `version` is not the newest version;
 * `DecisionNotAllowed` when the attribute is no safety list, the entry is not in the profile or is a computed
 * prohibition, or the value fails the fact schema; nothing is written then.
 */
export async function removeProfileEntry(
  db: Db,
  input: { geoObjectId: string; attribute: string; entryKey: string; version: number; decidedBy: string; now?: Date },
): Promise<{ factId: string }> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const profile = await latestProfile(tx, input.geoObjectId);
    if (!profile || profile.version !== input.version) throw new ProfileChanged(input.geoObjectId);
    const cfg = getConsolidationConfig(profile.rulesVersion);
    const list = profile.attributes[input.attribute];
    if (!Array.isArray(list)) throw new DecisionNotAllowed(`${input.attribute} is no list in the profile of ${input.geoObjectId}`);
    const entry = list.find((e) => profileEntryKey(input.attribute, e, cfg) === input.entryKey);
    if (entry === undefined) throw new DecisionNotAllowed(`entry ${input.entryKey} is not in ${input.attribute}`);
    if (!isRemovableEntry(input.attribute, entry, cfg)) throw new DecisionNotAllowed(`entry ${input.entryKey} of ${input.attribute} cannot be removed`);

    const factSchemaVersion = getConfig().factSchema.version;
    let value: unknown;
    try {
      validateFactValue(input.attribute, [entry], factSchemaVersion);
      value =
        input.attribute === "prohibitions"
          ? ({ remove: { kind: String((entry as { kind: unknown }).kind) } } satisfies ProhibitionRemoval)
          : ({ remove: entry } satisfies UnionRemoval);
    } catch (e) {
      if (e instanceof UnknownAttribute || e instanceof InvalidFactValue) throw new DecisionNotAllowed(e.message);
      throw e;
    }

    const [task] = await tx
      .insert(reviewTasks)
      .values({
        ...ENTRY_REMOVAL_TASK,
        subjectId: `${input.geoObjectId}:${input.attribute}`,
        context: { attribute: input.attribute, entryKey: input.entryKey, entry, version: input.version },
        status: "decided",
      })
      .returning({ id: reviewTasks.id });
    const [decision] = await tx
      .insert(reviewDecisions)
      .values({ taskId: task!.id, decision: { action: "remove_entry", attribute: input.attribute, entry }, decidedBy: input.decidedBy, decidedAt: now })
      .returning({ id: reviewDecisions.id });
    const [fact] = await tx
      .insert(facts)
      .values({
        geoObjectId: input.geoObjectId,
        attribute: input.attribute,
        value,
        reviewDecisionId: decision!.id,
        observedAt: now.toISOString().slice(0, 10),
        confidence: getConsolidationConfig().confidence.review,
        factSchemaVersion,
        // the transaction's clock, later than the profile row of a consolidation that finished before
        createdAt: sql`clock_timestamp()`,
      })
      .returning({ id: facts.id });
    return { factId: fact!.id };
  });
}
